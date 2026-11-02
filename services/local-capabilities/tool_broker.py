"""SQLCipher authority and two bounded background adapters; workers never use the DB.

Concepts adapted from Luyao's broker/permissions/journal; implementation is independent.
All mutators run in the caller's transaction. External work starts ONLY after commit.
"""
from datetime import datetime, timezone
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid
from storage import ServiceError
from tool_contracts import SCHEMA, bounded, descriptors, encode, fail, fields, hashed, validate
from tool_paths import absolute_root, lockscreen_state, open_one, pinned_path, windows_directory

TERMINAL = ('succeeded', 'failed', 'cancelled', 'unknown')


class CompletionQueue(queue.Queue):
    """Single authority consumer: inspect without ACK until the DB commit succeeds."""
    def snapshot(self):
        with self.mutex:
            return tuple(self.queue)

    def acknowledge(self, batch):
        for expected in batch:
            if self.get_nowait() is not expected:
                raise RuntimeError('completion acknowledgement order changed')
            self.task_done()


class ToolBroker:
    def __init__(self, service, *, lock_detector=None, adapter=None):
        self.service, self.db = service, service.db
        self.descriptors = descriptors()
        self.lock_detector, self.adapter = lock_detector or lockscreen_state, adapter or self.external_adapter
        self.jobs, self.completed = {}, CompletionQueue(maxsize=2)
        self.lock_state, self.next_lock_check, self.closed = 'not_verified', 0, False
        self.persistence_fault, self.fault_persisted = False, False
        self.db.executescript(SCHEMA)
        from tool_exports import ToolExports
        self.exports = ToolExports(self)
        self.db.execute('UPDATE tool_destinations SET active=0')
        # No startup replay, even if the former response was lost or a worker died.
        self.db.execute("UPDATE tool_executions SET state=CASE WHEN state='running' THEN 'unknown' ELSE 'cancelled' END,revision=revision+1,error_code='SERVICE_RESTARTED' WHERE state NOT IN ('succeeded','failed','cancelled','unknown')")
        self.db.execute("UPDATE tool_exports SET state='cancelled',revision=revision+1 WHERE state IN ('prepared','confirmed')")

    def now(self):
        return self.service.clock() * 1000

    def policy(self):
        return self.db.execute('SELECT * FROM tool_policy WHERE id=1').fetchone()

    @staticmethod
    def subject(session):
        return encode(dict(principal=session['principal'], platform=session['platform'], account=session['account'],
                           conversation=session['conversation'], audience_scope=session['scope']))

    @staticmethod
    def allowed_subject(session):
        # is_owner and shared owner memory are deliberately absent from this check.
        if session['platform'] not in ('local', 'pet', 'qq') or session['scope'].startswith('qq:group:'):
            fail('PERMISSION_DENIED', '群聊和公开渠道不能使用本机工具。', '由本机主人在私域管理页选择主体并单独授权。')

    def ready(self, session):
        self.require_healthy()
        self.allowed_subject(session)
        if self.policy()['closed']:
            fail('TOOL_STOPPED', '本机工具处于紧停闭锁。', '核验执行记录后，由本机主人手动解除紧停。')
        if self.lock_state != 'unlocked':
            fail('SESSION_LOCKED' if self.lock_state == 'locked' else 'LOCK_NOT_VERIFIED', 'Windows 会话未确认解锁。', '解锁当前 Windows 会话并核对本机工具状态。')
        paused = self.db.execute('SELECT paused FROM recovery_state WHERE character=?', (session['character'],)).fetchone()
        if paused and paused[0]:
            fail('RECOVERY_REVIEW_REQUIRED', '恢复内容尚未完成复审。', '先在本机记忆管理页完成当前角色恢复复审。')

    def require_healthy(self):
        if self.persistence_fault:
            fail('TOOL_PERSISTENCE_FAULT', '工具状态持久化失败，工具及结果交付已闭锁。',
                 '修复磁盘后重启本地能力服务，核验 unknown 执行，再由主人解除紧停；不要重放旧请求。')

    def latch_fault(self):
        # Independent of SQLite, including when even ROLLBACK fails. Never reset in-process.
        self.persistence_fault = True
        for job in self.jobs.values():
            job['cancel'].set()

    def execution(self, session, execution_id):
        row = self.db.execute('SELECT * FROM tool_executions WHERE id=? AND character=?',
                              (bounded(execution_id), session['character'])).fetchone()
        if not row or (not session['management'] and row['subject'] != self.subject(session)):
            fail('PERMISSION_DENIED', '执行记录不可访问。')
        return row

    def summary(self, row, session, include_result=True):
        item = dict(execution_id=row['id'], revision=row['revision'], state=row['state'], tool_id=row['tool'],
                    character_id=row['character'], character_epoch=row['epoch'], policy_generation=row['policy_generation'],
                    tool_version=self.descriptors[row['tool']]['version'] if row['tool'] in self.descriptors and self.descriptors[row['tool']]['descriptor_hash']==row['descriptor'] else None,
                    action=row['action'], arguments_hash=row['arguments_hash'], descriptor_hash=row['descriptor'],
                    target_summary=json_load(row['target']), confirmation_digest=row['confirmation_digest'],
                    result_id=row['result_id'], result_revision=1 if row['result_id'] else None,
                    local_only=row['tool'] != 'time.now', error_code=row['error_code'])
        if row['error_code']:
            item.update(error='本机工具未完成。', hint='核验当前目标和权限；unknown 状态请先人工核验，不重放旧执行。')
        if session['management']:
            item.update(arguments=json_load(row['arguments']), subject=json_load(row['subject']))
        if include_result and row['result_id'] and row['tool'] == 'time.now':
            result = self.db.execute('SELECT body FROM tool_results WHERE id=?', (row['result_id'],)).fetchone()
            if result and self.fresh_result(row):
                item['result'] = json_load(result[0])
        return item

    def root(self, session, root_id):
        row = self.db.execute('SELECT * FROM tool_roots WHERE id=? AND character=? AND active=1',
                              (bounded(root_id), session['character'])).fetchone()
        if not row:
            fail('ROOT_REVOKED', '登记目录不存在或已撤销。', '由本机主人重新登记并核验目录。')
        return row

    def target(self, session, tool_id, args):
        if 'root_id' in args:
            root = self.root(session, args['root_id'])
            with pinned_path(root['path'], args['relative_path'], tool_id != 'files.read_text', expected_root=root['identity']) as node:
                return dict(root_id=root['id'], relative_path=args['relative_path'], identity=node.identity)
        if tool_id == 'notes.read':
            if not self.db.execute('SELECT id FROM tool_notes WHERE id=? AND character=? AND subject=?',
                                    (args['note_id'], session['character'], self.subject(session))).fetchone():
                fail('NOTE_NOT_FOUND', '便签不存在或不属于当前主体。')
        return dict(workspace='subject_notes') if tool_id.startswith('notes.') else dict(clock='UTC')

    def find_grant(self, row):
        target = json_load(row['target'])
        return self.db.execute('SELECT * FROM tool_grants WHERE character=? AND subject=? AND tool=? AND action=? AND descriptor=? AND root=? AND active=1 AND remaining>0 AND expires>? ORDER BY expires,id LIMIT 1',
                               (row['character'], row['subject'], row['tool'], row['action'], row['descriptor'], target.get('root_id', ''), self.now())).fetchone()

    def current_descriptor(self, row):
        descriptor = self.descriptors.get(row['tool'])
        if not descriptor or descriptor['descriptor_hash'] != row['descriptor'] or hashed({k:v for k,v in descriptor.items() if k != 'descriptor_hash'}) != row['descriptor']:
            fail('DESCRIPTOR_CHANGED', '工具描述符已改变，旧确认已失效。', '重新发起请求并核对新的工具版本与权限。')
        if hashed(json_load(row['arguments'])) != row['arguments_hash']:
            fail('ARGUMENTS_CHANGED', '已存工具参数校验失败。', '保留数据库并核验服务状态；不要执行此请求。')
        return descriptor

    def dispatch(self, op, session, params):
        self.allowed_subject(session)
        if self.persistence_fault and op not in ('tool.catalog','tool.history','tool.status','tool.cancel',
                'tool.emergency.status','tool.emergency.stop','tool.result.export.status','tool.result.export.list',
                'tool.result.export.finalize'):
            self.require_healthy()
        if op == 'tool.catalog':
            fields(params, ())
            return dict(tools=list(self.descriptors.values()), export_policy='exact_result_confirmation_only', lockscreen_status=self.lock_state)
        if op == 'tool.subjects':
            self.service.management(session)
            fields(params, ())
            return dict(subjects=[dict(subject_binding=s['token'], **json_load(self.subject(s))) for s in self.service.bindings.values()
                                  if s['character'] == session['character'] and s['platform'] in ('local','pet','qq') and not s['scope'].startswith('qq:group:')], local_only=True)
        if op.startswith('tool.emergency.'):
            return self.emergency(op.rsplit('.', 1)[-1], session, params)
        if op.startswith('tool.roots.'):
            return self.roots(op.rsplit('.', 1)[-1], session, params)
        if op.startswith('tool.grants.'):
            return self.grants(op.rsplit('.', 1)[-1], session, params)
        if op.startswith('tool.destinations.'):
            return self.exports.destinations(op.rsplit('.', 1)[-1], session, params)
        if op.startswith('tool.result.export.'):
            return self.export(op.rsplit('.', 1)[-1], session, params)
        if op == 'tool.result.read':
            self.service.management(session)
            fields(params, ('result_id',))
            result, row = self.result(session, params['result_id'])
            return dict(result_id=result['id'], result_revision=1, local_only=True, body=json_load(result['body']))
        if op == 'tool.propose':
            return self.propose(session, params)
        if op == 'tool.history':
            fields(params, (), ('limit','idempotency_key'))
            limit = params.get('limit', 50)
            if type(limit) is not int or not 1 <= limit <= 100:
                fail('INVALID_REQUEST', '记录数量必须在 1 到 100 之间。')
            if 'idempotency_key' in params:
                key = bounded(params['idempotency_key'])
                # Host pre-model replay check. Management cannot widen this subject,
                # and even public time bodies must not be read through the metadata seam.
                rows = self.db.execute('SELECT id,character,epoch,tool,action,arguments_hash,descriptor,target,confirmation_digest,policy_generation,state,revision,result_id,error_code FROM tool_executions WHERE character=? AND subject=? AND idem=? ORDER BY created DESC,rowid DESC LIMIT ?',
                                       (session['character'],self.subject(session),key,limit)).fetchall()
                view = dict(session,management=False)
                return dict(executions=[self.summary(row,view,include_result=False) for row in rows],local_only=True)
            rows = self.db.execute('SELECT * FROM tool_executions WHERE character=?' + ('' if session['management'] else ' AND subject=?') + ' ORDER BY created DESC,rowid DESC LIMIT ?',
                                   (session['character'], limit) if session['management'] else (session['character'], self.subject(session), limit)).fetchall()
            return dict(executions=[self.summary(row, session) for row in rows], local_only=True)
        fields(params, ('execution_id',) if op != 'tool.confirm' else ('execution_id','expected_revision','confirmation_digest'))
        row = self.execution(session, params['execution_id'])
        if op == 'tool.status':
            return self.summary(row, session)
        if op == 'tool.cancel':
            self.terminate(row, 'REQUEST_CANCELLED')
        elif op == 'tool.confirm':
            self.confirm(session, row, params)
        elif op == 'tool.execute':
            self.execute(session, row)
        else:
            fail('INVALID_REQUEST', '未知工具操作。')
        return self.summary(self.execution(session, row['id']), session)

    def propose(self, session, params):
        fields(params, ('tool_id','action','arguments','idempotency_key'))
        self.ready(session)
        tool_id, action = bounded(params['tool_id']), bounded(params['action'])
        args = validate(tool_id, action, params['arguments'])
        key = bounded(params['idempotency_key'])
        descriptor = self.descriptors[tool_id]
        request_hash = hashed(dict(action=action, arguments=args, descriptor_hash=descriptor['descriptor_hash']))
        old = self.db.execute('SELECT * FROM tool_executions WHERE character=? AND subject=? AND tool=? AND idem=?',
                              (session['character'], self.subject(session), tool_id, key)).fetchone()
        if old:
            if old['request_hash'] != request_hash:
                fail('IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同参数或工具版本。', '保留旧执行记录；不同请求必须使用新幂等键。')
            return dict(self.summary(old, session), duplicate=True)
        target = self.target(session, tool_id, args)
        identifier, arguments_hash = uuid.uuid4().hex, hashed(args)
        generation = self.policy()['generation']
        confirmation = hashed(dict(execution_id=identifier, revision=1, arguments_hash=arguments_hash,
                                   descriptor_hash=descriptor['descriptor_hash'], target=target, generation=generation,
                                   character_epoch=session['epoch'], subject=self.subject(session)))
        self.db.execute('INSERT INTO tool_executions(id,character,epoch,subject,tool,action,idem,request_hash,arguments,arguments_hash,descriptor,target,confirmation_digest,policy_generation,state,revision,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (identifier, session['character'], session['epoch'], self.subject(session), tool_id, action, key, request_hash,
                         encode(args), arguments_hash, descriptor['descriptor_hash'], encode(target), confirmation, generation, 'awaiting_confirmation', 1, self.now()))
        row = self.execution(session, identifier)
        if tool_id == 'time.now' or self.find_grant(row):
            self.db.execute("UPDATE tool_executions SET state='authorized' WHERE id=?", (identifier,))
        return dict(self.summary(self.execution(session, identifier), session), duplicate=False)

    def confirm(self, session, row, params):
        self.service.management(session)
        self.ready(session)
        self.current_descriptor(row)
        if row['epoch'] != session['epoch'] or row['policy_generation'] != self.policy()['generation']:
            fail('STALE_EXECUTION', '请求代次已失效。')
        if type(params['expected_revision']) is not int or row['revision'] != params['expected_revision'] or row['confirmation_digest'] != params['confirmation_digest']:
            fail('VERSION_CONFLICT', '确认版本或摘要不匹配。', '刷新本机执行详情后重新核对。')
        if row['state'] not in ('awaiting_confirmation','authorized') or row['confirmed_until'] is not None:
            fail('INVALID_STATE', '当前执行状态不接受确认。')
        # Re-open the exact target before accepting the review, not just before execution.
        requester = dict(session, **json_to_session(row['subject']))
        if self.target(requester, row['tool'], json_load(row['arguments'])) != json_load(row['target']):
            fail('TARGET_CHANGED', '确认前目标对象已被替换。')
        self.db.execute("UPDATE tool_executions SET state='authorized',revision=revision+1,confirmed_until=? WHERE id=?", (self.now()+60000, row['id']))

    def execute(self, session, row):
        self.ready(session)
        if row['subject'] != self.subject(session):
            fail('PERMISSION_DENIED', '只有原始主体可执行此请求。')
        if row['state'] in TERMINAL or row['state'] == 'running':
            return  # Durable replay returns metadata; never invokes an adapter again.
        descriptor = self.current_descriptor(row)
        if row['epoch'] != session['epoch'] or row['policy_generation'] != self.policy()['generation']:
            fail('STALE_EXECUTION', '执行代次或策略已改变。')
        args, target = json_load(row['arguments']), json_load(row['target'])
        if self.target(session, row['tool'], args) != target:
            fail('TARGET_CHANGED', '确认后目标对象已被替换。')
        grant = None
        if row['tool'] != 'time.now' and not (row['confirmed_until'] and row['confirmed_until'] > self.now()):
            grant = self.find_grant(row)
            if not grant:
                fail('CONFIRMATION_REQUIRED', '请求缺少有效的精确确认或许可。', '请本机主人核对该请求，或登记有期限与次数的专用许可。')
        external = row['tool'].startswith('files.') or row['tool'] == 'local.open_directory'
        if external and len(self.jobs) >= 2:
            fail('TOOL_BUSY', '有界工具执行槽已占满。', '等待在途操作结束；未完成或 unknown 记录先人工核验。')
        if grant:
            changed = self.db.execute('UPDATE tool_grants SET remaining=remaining-1 WHERE id=? AND remaining>0 AND active=1 AND expires>?', (grant['id'],self.now())).rowcount
            if changed != 1:
                fail('GRANT_EXHAUSTED', '许可次数已用尽。')
        self.db.execute("UPDATE tool_executions SET state='running',revision=revision+1,grant_id=?,started=? WHERE id=?", (grant['id'] if grant else None,self.now(),row['id']))
        if external:
            root = dict(self.root(session, target['root_id']))
            job = dict(execution_id=row['id'], revision=row['revision']+1, tool=row['tool'], arguments=args, target=target, root=root,
                       timeout_ms=descriptor['timeout_ms'])
            self.service.after_commit.append(lambda: self.launch(job))
        else:
            body = self.internal(session, row['tool'], args)
            self.finish(row['id'], row['revision']+1, body=body)

    def internal(self, session, tool_id, args):
        if tool_id == 'time.now':
            return dict(unix_ms=int(self.now()), utc=datetime.fromtimestamp(self.now()/1000, timezone.utc).isoformat())
        if tool_id == 'notes.create':
            note_id = uuid.uuid4().hex
            self.db.execute('INSERT INTO tool_notes VALUES(?,?,?,?,?,?)', (note_id,session['character'],self.subject(session),args['title'],args['text'],self.now()))
            return dict(note_id=note_id,title=args['title'],text=args['text'])
        if tool_id == 'notes.list':
            return dict(notes=[dict(row) for row in self.db.execute('SELECT id AS note_id,title FROM tool_notes WHERE character=? AND subject=? ORDER BY created DESC,rowid DESC LIMIT ?',
                             (session['character'],self.subject(session),args.get('limit',50)))])
        row = self.db.execute('SELECT id AS note_id,title,body AS text FROM tool_notes WHERE id=? AND character=? AND subject=?',
                              (args['note_id'],session['character'],self.subject(session))).fetchone()
        if not row:
            fail('NOTE_NOT_FOUND', '便签不存在或不属于当前主体。')
        return dict(row)

    def launch(self, job):
        cancel = threading.Event()
        self.jobs[job['execution_id']] = dict(cancel=cancel, deadline=time.monotonic()+job['timeout_ms']/1000, revision=job['revision'])
        def run():
            try:
                body = self.adapter(job, cancel)
                # Bound serialized results before they cross back to the authority.
                if len(encode(body).encode('utf-8')) > 65536:
                    raise ServiceError('OUTPUT_LIMIT', '工具结果超过大小限制。')
                outcome = dict(body=body)
            except ServiceError as error:
                outcome = dict(error=error.code)
            except BaseException:
                outcome = dict(error='OUTCOME_UNKNOWN' if job['tool'] == 'local.open_directory' else 'TOOL_FAILED')
            self.completed.put((job['execution_id'], job['revision'], time.monotonic(), outcome))
        try:
            threading.Thread(target=run, name='local-tool', daemon=True).start()
        except Exception:
            self.completed.put((job['execution_id'],job['revision'],time.monotonic(),dict(error='TOOL_FAILED')))

    @staticmethod
    def external_adapter(job, cancel):
        root, target, tool = job['root'], job['target'], job['tool']
        with pinned_path(root['path'], target['relative_path'], tool != 'files.read_text', expected_root=root['identity'], expected_target=target['identity']) as node:
            if cancel.is_set():
                raise ServiceError('REQUEST_CANCELLED', '执行已取消。')
            if tool == 'files.read_text':
                return dict(text=node.read())
            if tool == 'files.list':
                entries = []
                with os.scandir(node.path) as items:
                    for scanned, item in enumerate(items, 1):
                        if cancel.is_set():
                            raise ServiceError('REQUEST_CANCELLED', '执行已取消。')
                        if scanned > 200:
                            raise ServiceError('OUTPUT_LIMIT', '目录超过 200 个条目。')
                        info = item.stat(follow_symlinks=False)
                        if getattr(info, 'st_file_attributes', 0) & 0x400:
                            continue
                        directory = item.is_dir(follow_symlinks=False)
                        try:
                            # Windows DirEntry's cached stat may report st_nlink=0;
                            # only the kernel handle's actual NumberOfLinks is authoritative.
                            with open_one(item.path, directory):
                                entries.append(dict(name=item.name, directory=directory))
                        except ServiceError as error:
                            if error.code != 'PATH_DENIED':
                                raise
                return dict(entries=sorted(entries, key=lambda entry:entry['name'].casefold()))
            # Explicit executable, fixed argument layout, no shell or user-supplied switches.
            executable = str(Path(windows_directory()) / 'explorer.exe')
            process = subprocess.Popen([executable, node.path], shell=False, cwd=str(Path(executable).parent),
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                if process.wait(timeout=3) != 0:
                    raise ServiceError('OUTCOME_UNKNOWN', '目录窗口交付状态无法确认。')
            except subprocess.TimeoutExpired:
                # GUI handoff cannot be rolled back and must not be reported as a proved failure.
                raise ServiceError('OUTCOME_UNKNOWN', '无法核验目录窗口的打开结果。') from None
            return dict(open_requested=True)

    def finish(self, identifier, revision, *, body=None, error=None):
        row = self.db.execute('SELECT * FROM tool_executions WHERE id=?', (identifier,)).fetchone()
        if not row or row['state'] != 'running' or row['revision'] != revision:
            return  # Late worker data is discarded; terminal outcomes cannot be resurrected.
        result_id = None
        state = 'unknown' if error == 'OUTCOME_UNKNOWN' else 'failed' if error else 'succeeded'
        if not error:
            if len(encode(body).encode('utf-8')) > 65536:
                fail('OUTPUT_LIMIT', '工具结果超过 64 KiB 限制。', '缩小本次查询数量或文件内容后重新发起。')
            result_id = uuid.uuid4().hex
            self.db.execute('INSERT INTO tool_results VALUES(?,?,?,?,?,?)', (result_id,identifier,row['character'],row['epoch'],row['policy_generation'],encode(body)))
        self.db.execute('UPDATE tool_executions SET state=?,revision=revision+1,result_id=?,error_code=? WHERE id=? AND state=? AND revision=?',
                        (state,result_id,error,identifier,'running',revision))

    def terminate(self, row, code):
        if row['state'] in TERMINAL:
            return
        state = 'unknown' if row['state'] == 'running' else 'cancelled'
        self.db.execute('UPDATE tool_executions SET state=?,revision=revision+1,error_code=? WHERE id=?', (state,code,row['id']))
        job = self.jobs.get(row['id'])
        if job:
            self.service.after_commit.append(job['cancel'].set)

    def retire(self, character=None, code='LIFECYCLE_RETIRED'):
        rows = self.db.execute("SELECT * FROM tool_executions WHERE state NOT IN ('succeeded','failed','cancelled','unknown')" + (' AND character=?' if character else ''), (character,) if character else ()).fetchall()
        for row in rows:
            self.terminate(row, code)
        self.db.execute("UPDATE tool_exports SET state='cancelled',revision=revision+1 WHERE state IN ('prepared','confirmed')" + (' AND character=?' if character else ''), (character,) if character else ())
        self.db.execute('UPDATE tool_destinations SET active=0' + (' WHERE character=?' if character else ''), (character,) if character else ())

    def poll(self):
        if self.closed:
            return
        callbacks = []
        batch = ()
        # Transaction-local observations must not become authority before COMMIT.
        next_state, next_check = self.lock_state, self.next_lock_check
        recovering_fault = self.persistence_fault and not self.fault_persisted
        previous_callbacks = self.service.after_commit
        self.service.after_commit = callbacks
        try:
            if self.persistence_fault and self.db.in_transaction:
                self.db.execute('ROLLBACK')  # Retry only cleanup after a failed rollback.
            self.db.execute('BEGIN IMMEDIATE')
            # Main thread only, independent of stdin traffic. No worker touches SQLite.
            if recovering_fault:
                self.db.execute('UPDATE tool_policy SET closed=1,generation=generation+1 WHERE id=1')
                self.retire(code='TOOL_PERSISTENCE_FAULT')
            if not self.persistence_fault and time.monotonic() >= self.next_lock_check:
                next_check = time.monotonic()+0.5
                try:
                    state = self.lock_detector()
                except Exception:
                    state = 'not_verified'
                if state not in ('locked','unlocked','not_verified'):
                    state = 'not_verified'
                if state != self.lock_state:
                    next_state = state
                    if state != 'unlocked':
                        self.db.execute('UPDATE tool_policy SET generation=generation+1 WHERE id=1')
                        self.retire(code='SESSION_LOCKED')
            batch = self.completed.snapshot()
            for identifier, revision, finished_at, outcome in batch:
                job = self.jobs.get(identifier)
                if self.persistence_fault:
                    continue  # Never publish a failed poll's worker body during recovery.
                if job and finished_at >= job['deadline']:
                    self.terminate(self.db.execute('SELECT * FROM tool_executions WHERE id=?',(identifier,)).fetchone(), 'TOOL_TIMEOUT')
                else:
                    self.finish(identifier, revision, **outcome)
            for identifier, job in list(self.jobs.items()):
                if time.monotonic() >= job['deadline']:
                    row = self.db.execute('SELECT * FROM tool_executions WHERE id=?', (identifier,)).fetchone()
                    self.terminate(row, 'TOOL_TIMEOUT')
            self.db.execute('COMMIT')
        except BaseException:
            self.latch_fault()  # Must happen before potentially failing rollback/cleanup.
            try:
                if self.db.in_transaction:
                    self.db.execute('ROLLBACK')
            except BaseException:
                pass
            raise ServiceError('SERVICE_UNAVAILABLE', '本机工具状态无法持久化，已立即闭锁。',
                               '暂停工具与结果交付；修复磁盘后重启本地能力服务并核验 unknown 执行。') from None
        finally:
            self.service.after_commit = previous_callbacks
        try:
            self.lock_state, self.next_lock_check = next_state, next_check
            if recovering_fault:
                self.fault_persisted = True
            self.completed.acknowledge(batch)
            for identifier, _, _, _ in batch:
                self.jobs.pop(identifier, None)
            for callback in callbacks:
                callback()
        except BaseException:
            self.latch_fault()
            raise ServiceError('SERVICE_UNAVAILABLE', '本机工具状态发布失败，已立即闭锁。',
                               '重启本地能力服务并核验 unknown 执行；不要重放旧请求。') from None

    def close(self):
        if self.closed:
            return
        self.closed = True
        for job in self.jobs.values():
            job['cancel'].set()
        try:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            self.db.execute('BEGIN IMMEDIATE')
            self.service.after_commit = []
            self.retire(code='PARENT_EXITED')
            self.db.execute('COMMIT')
        except BaseException:
            try:
                if self.db.in_transaction:
                    self.db.execute('ROLLBACK')
            except BaseException:
                pass
        # Daemon workers cannot delay parent EOF; restart never replays their identities.

    def emergency(self, action, session, params):
        self.service.management(session)
        fields(params, ())
        if action in ('stop','reset'):
            self.db.execute('UPDATE tool_policy SET closed=?,generation=generation+1 WHERE id=1', (int(action == 'stop'),))
            self.retire(code='EMERGENCY_STOP' if action == 'stop' else 'POLICY_RESET')
        elif action != 'status':
            fail('INVALID_REQUEST', '未知紧停操作。')
        policy = self.policy()
        return dict(closed=bool(policy['closed']) or self.persistence_fault, persistence_fault=self.persistence_fault,
                    recovery_required='restart' if self.persistence_fault else None,
                    policy_generation=policy['generation'], lockscreen_status=self.lock_state,
                    lockscreen_live_test='NOT_VERIFIED',local_only=True)

    def roots(self, action, session, params):
        self.service.management(session)
        if action == 'register':
            fields(params, ('path','label'))
            path, label = absolute_root(params['path']), bounded(params['label'],100)
            store = os.path.normcase(str(self.service.store.directory))
            candidate = os.path.normcase(path)
            if candidate == store or candidate.startswith(store+'\\') or store.startswith(candidate+'\\'):
                fail('PATH_DENIED', '能力服务数据目录不能登记为文件工具根。')
            with pinned_path(path) as node:
                identifier = uuid.uuid4().hex
                self.db.execute('INSERT INTO tool_roots VALUES(?,?,?,?,?,1)', (identifier,session['character'],path,label,node.identity))
            return dict(root_id=identifier,label=label,local_only=True)
        if action == 'revoke':
            fields(params, ('root_id',))
            root = self.root(session, params['root_id'])
            self.db.execute('UPDATE tool_roots SET active=0 WHERE id=?',(root['id'],))
            self.db.execute('UPDATE tool_grants SET active=0 WHERE root=?',(root['id'],))
            self.policy_changed()
            return dict(revoked=True,local_only=True)
        if action != 'list':
            fail('INVALID_REQUEST', '未知目录管理操作。')
        fields(params, ())
        return dict(roots=[dict(root_id=r['id'],path=r['path'],label=r['label'],active=bool(r['active'])) for r in self.db.execute('SELECT * FROM tool_roots WHERE character=?',(session['character'],))],local_only=True)

    def grants(self, action, session, params):
        self.service.management(session)
        if action == 'create':
            fields(params, ('subject_binding','tool_id','action','descriptor_hash','expires_at','uses'), ('root_id',))
            subject = self.service.bindings.get(bounded(params['subject_binding']))
            if not subject or subject['character'] != session['character'] or subject['epoch'] != session['epoch']:
                fail('BINDING_INVALID', '许可主体绑定已失效。')
            self.allowed_subject(subject)
            descriptor = self.descriptors.get(params['tool_id'])
            if not descriptor or descriptor['action'] != params['action'] or descriptor['descriptor_hash'] != params['descriptor_hash']:
                fail('DESCRIPTOR_CHANGED', '许可的工具描述符或动作不匹配。')
            expires, uses = params['expires_at'],params['uses']
            if type(expires) not in (int,float) or not self.now() < expires <= self.now()+30*86400000 or type(uses) is not int or not 1 <= uses <= 100:
                fail('INVALID_REQUEST', '许可期限最多 30 天，次数必须在 1 到 100 之间。')
            needs_root = params['tool_id'].startswith('files.') or params['tool_id'] == 'local.open_directory'
            root = self.root(session,params.get('root_id'))['id'] if needs_root else ''
            if not needs_root and 'root_id' in params:
                fail('INVALID_REQUEST', '此工具不接受目录根。')
            identifier = uuid.uuid4().hex
            self.db.execute('INSERT INTO tool_grants VALUES(?,?,?,?,?,?,?,?,?,1)', (identifier,session['character'],self.subject(subject),params['tool_id'],params['action'],params['descriptor_hash'],root,expires,uses))
            return dict(grant_id=identifier,remaining=uses,local_only=True)
        if action == 'revoke':
            fields(params, ('grant_id',))
            if not self.db.execute('UPDATE tool_grants SET active=0 WHERE id=? AND character=?', (bounded(params['grant_id']),session['character'])).rowcount:
                fail('PERMISSION_DENIED', '许可不可访问。')
            self.policy_changed()
            return dict(revoked=True,local_only=True)
        if action != 'list':
            fail('INVALID_REQUEST', '未知许可管理操作。')
        fields(params, ())
        return dict(grants=[dict(grant_id=r['id'],subject=json_load(r['subject']),tool_id=r['tool'],action=r['action'],descriptor_hash=r['descriptor'],root_id=r['root'],expires_at=r['expires'],remaining=r['remaining'],active=bool(r['active'])) for r in self.db.execute('SELECT * FROM tool_grants WHERE character=?',(session['character'],))],local_only=True)

    def policy_changed(self):
        self.db.execute('UPDATE tool_policy SET generation=generation+1 WHERE id=1')
        self.retire(code='POLICY_CHANGED')

    def fresh_result(self, row):
        return not self.persistence_fault and row['state'] == 'succeeded' and row['epoch'] == self.service.active.get(row['character']) and row['policy_generation'] == self.policy()['generation']

    def result(self, session, result_id):
        self.require_healthy()
        result = self.db.execute('SELECT * FROM tool_results WHERE id=? AND character=?',(bounded(result_id),session['character'])).fetchone()
        if not result:
            fail('PERMISSION_DENIED', '结果不可访问。')
        row = self.execution(session,result['execution'])
        if not self.fresh_result(row):
            fail('STALE_RESULT', '结果所属执行代次已失效。', '重新发起当前请求；不要导出旧结果。')
        return result,row

    def export(self, action, session, params):
        return self.exports.dispatch(action, session, params)


def json_load(value):
    import json
    return json.loads(value)


def json_to_session(value):
    subject = json_load(value)
    return dict(principal=subject['principal'],platform=subject['platform'],account=subject['account'],conversation=subject['conversation'],scope=subject['audience_scope'])
