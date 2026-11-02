"""Audience-first SQLCipher derived vectors; one explicit, cancellable background job.

No model/library import on the authority thread. Cache never overrides memory truth.
"""
import hashlib
import json
import math
import struct
import threading
import time
import uuid
from storage import ServiceError
from tool_broker import CompletionQueue
from tool_contracts import bounded, encode, fields, hashed
from semantic_model import DIMENSION, ERRORS, FINGERPRINT, MANIFEST, ModelFailure
from semantic_runtime import SemanticRuntime, normalized

PAGE = 64
MAX_ALLOWED = 4096
TERMINAL = ('succeeded','failed','cancelled','stale')
SCHEMA = """
CREATE TABLE IF NOT EXISTS semantic_policy(character TEXT PRIMARY KEY,enabled INTEGER NOT NULL,generation INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS semantic_vectors(memory TEXT PRIMARY KEY,character TEXT NOT NULL,model TEXT NOT NULL,revision INTEGER NOT NULL,body_hash TEXT NOT NULL,source_hash TEXT NOT NULL,vector BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS semantic_sources(memory TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(memory,source));
CREATE INDEX IF NOT EXISTS semantic_source_lookup ON semantic_sources(source,memory);
CREATE TABLE IF NOT EXISTS semantic_jobs(id TEXT PRIMARY KEY,character TEXT NOT NULL,epoch TEXT NOT NULL,binding TEXT NOT NULL,subject TEXT NOT NULL,audience TEXT NOT NULL,memory_epoch INTEGER NOT NULL,generation INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created REAL NOT NULL,code TEXT,result TEXT NOT NULL,coverage TEXT NOT NULL,query_hash TEXT NOT NULL);
"""


def error(code):
    message,hint = ERRORS.get(code,('本地语义任务已失效或取消。','重新核对当前角色、来源、授权和记忆版本，再发起新任务。'))
    return dict(code=code,error=message,hint=hint)


def fail(code, message, hint='在本机记忆管理页核对语义开关、模型与当前记忆版本。'):
    raise ServiceError(code,message,hint)


class SemanticIndex:
    def __init__(self, service):
        self.service,self.db = service,service.db
        self.runtime = SemanticRuntime()
        self.jobs,self.completed = {},CompletionQueue(maxsize=1)
        self.closed,self.fault = False,False
        self.model_state,self.last_error = 'unloaded',None
        self.db.executescript(SCHEMA)
        self.db.execute("UPDATE semantic_jobs SET state='cancelled',revision=revision+1,code='SEMANTIC_RESTARTED',result='{}' WHERE state IN ('queued','running')")

    def policy(self, character):
        return self.db.execute('SELECT * FROM semantic_policy WHERE character=?',(character,)).fetchone() or dict(enabled=0,generation=1)

    def audience(self, session, params):
        audience = params.get('audience','session')
        if audience not in ('session','character'):
            fail('INVALID_REQUEST','语义受众只能是 session 或 character。')
        if audience=='character':
            self.service.management(session)
        return audience

    def allowed(self, session, audience):
        # SQL scope filtering precedes text matching, proof checks and worker inputs.
        where = "character=? AND status='active' AND scope!='quarantine'"
        args = [session['character']]
        if audience=='session':
            where += " AND scope IN (?, 'bili:public')"
            args.append(session['scope'])
        rows = self.db.execute('SELECT * FROM memories WHERE '+where+' ORDER BY pinned DESC,rowid DESC LIMIT ?',args+[MAX_ALLOWED+1]).fetchall()
        if len(rows)>MAX_ALLOWED:
            fail('SEMANTIC_DATASET_LIMIT','当前受众的活动记录超过 4096 条。','缩小到具体会话受众或先在管理页整理记录；本次没有返回不完整命中。')
        permitted = {row['id']:row for row in rows}
        proofs,memo = {},{}
        def visible(identifier, trail=()):
            if identifier in memo:
                return memo[identifier]
            if identifier not in permitted or identifier in trail:
                return False
            if len(trail)>=64:
                fail('SEMANTIC_PROVENANCE_LIMIT','来源链超过 64 层。','先在管理页核验来源链；不会静默跳过后宣称全库命中。')
            row = permitted[identifier]
            bound = self.db.execute('SELECT source,revision FROM record_source_revisions WHERE memory=? ORDER BY source',(identifier,)).fetchall()
            proofs[identifier] = {value['source']:value['revision'] for value in bound}
            valid = not any(source not in permitted or permitted[source]['revision']!=revision for source,revision in proofs[identifier].items())
            valid = valid and all(visible(source,trail+(identifier,)) for source in json.loads(row['derived']))
            memo[identifier] = valid
            return valid
        eligible = [row for row in rows if visible(row['id'])]
        return eligible,permitted,proofs

    def snapshot(self, identifier, permitted, proofs):
        captured = {}
        def visit(current):
            if current in captured:
                return
            if current not in permitted or len(captured)>=256:
                fail('SEMANTIC_PROVENANCE_LIMIT','单条记录来源超过安全上限。')
            row = permitted[current]
            bound = proofs.get(current)
            if bound is None:
                bound = {item['source']:item['revision'] for item in self.db.execute('SELECT source,revision FROM record_source_revisions WHERE memory=? ORDER BY source',(current,))}
            derived = json.loads(row['derived'])
            captured[current] = dict(revision=row['revision'],body_hash=hashlib.sha256(row['statement'].encode('utf-8')).hexdigest(),
                                     scope=row['scope'],derived=derived,source_revisions=bound)
            for source in set(derived)|set(bound):
                visit(source)
        visit(identifier)
        return captured

    def cached(self, row, snapshot):
        cache = self.db.execute('SELECT * FROM semantic_vectors WHERE memory=? AND character=? AND model=?',
                                (row['id'],row['character'],FINGERPRINT)).fetchone()
        if not cache or cache['revision']!=row['revision'] or cache['body_hash']!=snapshot[row['id']]['body_hash'] or cache['source_hash']!=hashed(snapshot):
            return None
        try:
            return normalized(list(struct.unpack('<512f',cache['vector'])))
        except (ValueError,struct.error,ModelFailure):
            raise ServiceError(**error('SEMANTIC_INVALID_VECTOR')) from None

    def invalidate_source(self, identifier):
        # Full recursive dependency closure was recorded with each cache entry.
        victims = {row[0] for row in self.db.execute('SELECT memory FROM semantic_sources WHERE source=?',(identifier,))}|{identifier}
        self.db.executemany('DELETE FROM semantic_vectors WHERE memory=?',[(value,) for value in victims])
        self.db.executemany('DELETE FROM semantic_sources WHERE memory=?',[(value,) for value in victims])

    def clear_character(self, character):
        self.db.execute('DELETE FROM semantic_sources WHERE memory IN (SELECT memory FROM semantic_vectors WHERE character=?)',(character,))
        self.db.execute('DELETE FROM semantic_vectors WHERE character=?',(character,))

    def retire(self, character=None, state='stale', code='STALE_CONTEXT'):
        where,args = (' WHERE character=?',(character,)) if character else ('',())
        self.db.execute("UPDATE semantic_jobs SET state=?,revision=revision+1,code=?,result='{}'"+where+(' AND ' if where else ' WHERE ')+"state IN ('queued','running')",(state,code)+args)
        self.db.execute("UPDATE semantic_jobs SET result='{}'"+where,args)
        for identifier,job in self.jobs.items():
            if character is None or job['character']==character:
                self.service.after_commit.append(lambda job=job:self.cancel_worker(job))

    def cancel_worker(self, job):
        job['cancel'].set()
        self.runtime.cancel()

    def fail_closed(self):
        self.fault = True
        for job in self.jobs.values():
            self.cancel_worker(job)

    def require_work(self, session):
        if self.fault:
            fail('SEMANTIC_STORAGE_FAULT','语义状态持久化失败，已停止推理。','修复存储后重启本地能力服务；旧任务不会重放。')
        if not self.policy(session['character'])['enabled']:
            fail('SEMANTIC_DISABLED','本地语义检索尚未启用。','在本机记忆管理页启用本地语义检索。')
        # Memory scopes keep their existing visibility. Reuse only lifecycle closure,
        # never the Broker's local-tool subject permission (groups/public have no tools).
        self.service.tools.require_healthy()
        if self.service.tools.policy()['closed']:
            fail('TOOL_STOPPED','本机能力处于紧停闭锁。','由本机主人核验在途结果后手动解除紧停。')
        if self.service.tools.lock_state!='unlocked':
            fail('SESSION_LOCKED','Windows 会话尚未确认解锁。','解锁当前本机会话并核对能力状态。')
        paused = self.db.execute('SELECT paused FROM recovery_state WHERE character=?',(session['character'],)).fetchone()
        if paused and paused[0]:
            fail('RECOVERY_REVIEW_REQUIRED','恢复内容尚未复审，不能建立语义索引。')

    def dispatch(self, op, session, params):
        suffix = op[len('memory.semantic.'):]
        if suffix=='configure':
            self.service.management(session)
            fields(params,('enabled',))
            if type(params['enabled']) is not bool:
                fail('INVALID_REQUEST','enabled 必须是布尔值。')
            policy = self.policy(session['character'])
            if bool(policy['enabled'])!=params['enabled']:
                self.db.execute('INSERT OR REPLACE INTO semantic_policy VALUES(?,?,?)',(session['character'],int(params['enabled']),policy['generation']+1))
                self.retire(session['character'],'cancelled','SEMANTIC_CONFIGURATION_CHANGED')
            return dict(enabled=params['enabled'],model_fingerprint=FINGERPRINT)
        if suffix=='status':
            fields(params,(),('audience',))
            audience = self.audience(session,params)
            rows,permitted,proofs = self.allowed(session,audience)
            count = sum(self.cached(row,self.snapshot(row['id'],permitted,proofs)) is not None for row in rows)
            active = self.db.execute("SELECT id FROM semantic_jobs WHERE binding=? AND state IN ('queued','running')",(session['token'],)).fetchone()
            return dict(enabled=bool(self.policy(session['character'])['enabled']),storage_fault=self.fault,index_state='ready' if count==len(rows) else 'partial' if count else 'empty',
                        eligible_count=len(rows),indexed_count=count,model=MANIFEST['model'],model_revision=MANIFEST['revision'],model_fingerprint=FINGERPRINT,
                        dimension=DIMENSION,model_state=self.model_state,active_job=active[0] if active else None,last_error=error(self.last_error) if self.last_error else None)
        if suffix in ('query.start','rebuild.start'):
            return self.start(session,params,'query' if suffix=='query.start' else 'rebuild')
        if suffix in ('job.status','job.cancel'):
            fields(params,('job_id',))
            row = self.job(session,params['job_id'])
            if suffix=='job.cancel' and row['state'] not in TERMINAL:
                self.db.execute("UPDATE semantic_jobs SET state='cancelled',revision=revision+1,code='REQUEST_CANCELLED',result='{}' WHERE id=?",(row['id'],))
                if row['id'] in self.jobs:
                    self.service.after_commit.append(lambda:self.cancel_worker(self.jobs[row['id']]))
            return self.summary(session,self.job(session,row['id']))
        fail('INVALID_REQUEST','未知本地语义操作。')

    def job(self, session, identifier):
        row = self.db.execute('SELECT * FROM semantic_jobs WHERE id=? AND character=? AND binding=?',
                              (bounded(identifier),session['character'],session['token'])).fetchone()
        if not row:
            fail('PERMISSION_DENIED','语义任务不可访问。')
        return row

    def start(self, session, params, kind):
        fields(params,('query',) if kind=='query' else (),('limit','audience','offset','expected_memory_epoch') if kind=='query' else ('audience','offset','expected_memory_epoch'))
        if kind=='rebuild':
            self.service.management(session)
        audience = self.audience(session,params)
        query = params.get('query','')
        if not isinstance(query,str) or len(query)>1000:
            fail('INVALID_REQUEST','语义查询最多 1000 字。')
        limit,offset = params.get('limit',20),params.get('offset',0)
        if type(limit) is not int or not 1<=limit<=20 or type(offset) is not int or not 0<=offset<=100000:
            fail('INVALID_REQUEST','语义查询数量或页偏移无效。')
        epoch = self.service.epoch(session['character'])
        if ('expected_memory_epoch' in params or offset) and (type(params.get('expected_memory_epoch')) is not int or params['expected_memory_epoch']!=epoch):
            fail('STALE_CONTEXT','分页或查询的记忆代次已改变。','使用首个任务的 memory_epoch；有变化时从第一页重新查询。')
        embedding = kind=='rebuild' or bool(query.strip())
        if embedding:
            self.require_work(session)
            if self.jobs:
                fail('SEMANTIC_BUSY','已有一个本地语义任务占用工作槽。','等待任务结束或取消后重试；不会建立无界队列。')
        rows,permitted,proofs = self.allowed(session,audience)
        selected = rows[offset:offset+PAGE]
        coverage = dict(eligible_count=len(rows),offset=offset,page_size=PAGE,has_more=offset+PAGE<len(rows),
                        next_offset=offset+PAGE if offset+PAGE<len(rows) else None,complete=offset==0 and len(rows)<=PAGE)
        plan,items = [],[]
        for row in selected:
            snapshot = self.snapshot(row['id'],permitted,proofs)
            cached = self.cached(row,snapshot) if embedding and kind!='rebuild' else None
            entry = dict(id=row['id'],revision=row['revision'],snapshot=snapshot,vector=cached,start=len(items),count=0)
            if embedding and cached is None:
                chunks = [row['statement'][index:index+3500] for index in range(0,len(row['statement']),3500)]
                entry['count'] = len(chunks)
                items.extend(dict(text=chunk,query=False) for chunk in chunks)
            plan.append(entry)
        if embedding and kind=='query' and selected:
            items.append(dict(text=query,query=True))
        identifier = uuid.uuid4().hex
        result = dict(ids=[dict(id=row['id'],score=None) for row in selected[:limit]],search_mode='recent') if not embedding else dict(ids=[],indexed=0)
        state = 'queued' if items else 'succeeded'
        self.db.execute('INSERT INTO semantic_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (identifier,session['character'],session['epoch'],session['token'],self.service.tools.subject(session),audience,epoch,
             self.policy(session['character'])['generation'],kind,state,1,self.service.clock(),None,encode(result),encode(coverage),hashed(query)))
        # Bounded metadata/history; only one live job, and at most 64 terminal records globally.
        self.db.execute("DELETE FROM semantic_jobs WHERE id IN (SELECT id FROM semantic_jobs WHERE state IN ('succeeded','failed','cancelled','stale') ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 64)")
        if items:
            job = dict(id=identifier,character=session['character'],plan=plan,items=items,limit=limit,kind=kind,
                       cancel=threading.Event(),deadline=time.monotonic()+120)
            self.service.after_commit.append(lambda:self.launch(job))
        return self.summary(session,self.job(session,identifier))

    def launch(self, job):
        self.jobs[job['id']] = job
        self.model_state = 'loading' if self.model_state!='ready' else 'working'
        def run():
            try:
                outcome = dict(vectors=self.runtime.encode(job['items'],job['cancel']))
            except ModelFailure as failure:
                outcome = dict(code=failure.code if failure.code in ERRORS else 'SEMANTIC_WORKER_FAILED')
            except BaseException:
                outcome = dict(code='SEMANTIC_WORKER_FAILED')
            self.completed.put((job['id'],outcome))
        try:
            threading.Thread(target=run,daemon=True,name='semantic-pipe-io').start()
        except BaseException:
            self.completed.put((job['id'],dict(code='SEMANTIC_WORKER_FAILED')))

    def invalid(self, row):
        if (self.service.active.get(row['character'])!=row['epoch'] or row['binding'] not in self.service.bindings or
            row['memory_epoch']!=self.service.epoch(row['character'])):
            return 'stale','STALE_CONTEXT'
        if self.fault:
            return 'failed','SEMANTIC_STORAGE_FAULT'
        policy = self.policy(row['character'])
        if not policy['enabled'] or policy['generation']!=row['generation']:
            return 'cancelled','SEMANTIC_CONFIGURATION_CHANGED'
        if self.service.tools.persistence_fault or self.service.tools.policy()['closed']:
            return 'cancelled','TOOL_STOPPED'
        if self.service.tools.lock_state!='unlocked':
            return 'cancelled','SESSION_LOCKED'
        return None

    def finish(self, row, job, outcome):
        if 'code' in outcome:
            self.db.execute("UPDATE semantic_jobs SET state='failed',revision=revision+1,code=?,result='{}' WHERE id=?",(outcome['code'],row['id']))
            return
        vectors = outcome.get('vectors')
        if not isinstance(vectors,list) or len(vectors)!=len(job['items']):
            raise ModelFailure('SEMANTIC_INVALID_VECTOR')
        vectors = [normalized(vector) for vector in vectors]
        session = self.service.bindings[row['binding']]
        eligible,permitted,proofs = self.allowed(session,row['audience'])
        visible = {item['id'] for item in eligible}
        scored = []
        for entry in job['plan']:
            current = permitted.get(entry['id'])
            if not current or entry['id'] not in visible or self.snapshot(entry['id'],permitted,proofs)!=entry['snapshot']:
                self.db.execute("UPDATE semantic_jobs SET state='stale',revision=revision+1,code='STALE_CONTEXT',result='{}' WHERE id=?",(row['id'],))
                return
        for entry in job['plan']:
            vector = entry['vector']
            if entry['count']:
                chunks = vectors[entry['start']:entry['start']+entry['count']]
                vector = [sum(chunk[index] for chunk in chunks)/len(chunks) for index in range(DIMENSION)]
                length = math.sqrt(sum(value*value for value in vector))
                if not length>0:
                    raise ModelFailure('SEMANTIC_INVALID_VECTOR')
                vector = normalized([value/length for value in vector])
                own = entry['snapshot'][entry['id']]
                self.db.execute('INSERT OR REPLACE INTO semantic_vectors VALUES(?,?,?,?,?,?,?)',(entry['id'],row['character'],FINGERPRINT,entry['revision'],own['body_hash'],hashed(entry['snapshot']),struct.pack('<512f',*vector)))
                self.db.execute('DELETE FROM semantic_sources WHERE memory=?',(entry['id'],))
                self.db.executemany('INSERT INTO semantic_sources VALUES(?,?)',[(entry['id'],source) for source in entry['snapshot']])
            if row['kind']=='query':
                scored.append(dict(id=entry['id'],score=sum(a*b for a,b in zip(vector,vectors[-1]))))
        scored.sort(key=lambda item:-item['score'])
        result = dict(ids=scored[:job['limit']],indexed=len(job['plan']),search_mode='semantic')
        self.db.execute("UPDATE semantic_jobs SET state='succeeded',revision=revision+1,result=? WHERE id=?",(encode(result),row['id']))

    def poll(self):
        if self.closed or (not self.jobs and self.completed.empty()):
            return
        batch = self.completed.snapshot()
        callbacks = []
        previous = self.service.after_commit
        self.service.after_commit = callbacks
        try:
            self.db.execute('BEGIN IMMEDIATE')
            for identifier,job in self.jobs.items():
                row = self.db.execute('SELECT * FROM semantic_jobs WHERE id=?',(identifier,)).fetchone()
                if not row or row['state'] in TERMINAL:
                    continue
                invalid = self.invalid(row)
                if invalid or time.monotonic()>=job['deadline']:
                    state,code = invalid or ('failed','SEMANTIC_TIMEOUT')
                    self.db.execute("UPDATE semantic_jobs SET state=?,revision=revision+1,code=?,result='{}' WHERE id=?",(state,code,identifier))
                    callbacks.append(lambda job=job:self.cancel_worker(job))
                elif row['state']=='queued':
                    self.db.execute("UPDATE semantic_jobs SET state='running',revision=revision+1 WHERE id=?",(identifier,))
            for identifier,outcome in batch:
                row = self.db.execute('SELECT * FROM semantic_jobs WHERE id=?',(identifier,)).fetchone()
                if row and row['state'] not in TERMINAL:
                    self.db.execute('SAVEPOINT semantic_finish')
                    try:
                        self.finish(row,self.jobs[identifier],outcome)
                    except ModelFailure as failure:
                        self.db.execute('ROLLBACK TO semantic_finish')
                        self.db.execute('RELEASE semantic_finish')
                        self.db.execute("UPDATE semantic_jobs SET state='failed',revision=revision+1,code=?,result='{}' WHERE id=?",(failure.code,identifier))
                    else:
                        self.db.execute('RELEASE semantic_finish')
            self.db.execute('COMMIT')
        except BaseException:
            self.fail_closed()
            self.service.tools.latch_fault()
            try:
                if self.db.in_transaction:
                    self.db.execute('ROLLBACK')
            except BaseException:
                pass
            raise ServiceError('SERVICE_UNAVAILABLE','语义索引状态无法持久化，已闭锁。','修复存储并重启本地能力服务；不会重放旧推理。') from None
        finally:
            self.service.after_commit = previous
        self.completed.acknowledge(batch)
        for identifier,outcome in batch:
            self.jobs.pop(identifier,None)
            self.model_state = 'unavailable' if 'code' in outcome else 'ready'
            self.last_error = outcome.get('code')
        for callback in callbacks:
            callback()

    def summary(self, session, row):
        result = dict(job_id=row['id'],state=row['state'],revision=row['revision'],memory_epoch=row['memory_epoch'],character_epoch=row['epoch'],
                      model_fingerprint=FINGERPRINT,coverage=json.loads(row['coverage']),kind=row['kind'])
        if row['memory_epoch']!=self.service.epoch(session['character']) or row['epoch']!=session['epoch']:
            result.update(state='stale',**error('STALE_CONTEXT'))
            return result
        if self.fault or row['generation']!=self.policy(session['character'])['generation']:
            result.update(state='failed' if self.fault else 'cancelled',**error('SEMANTIC_STORAGE_FAULT' if self.fault else 'SEMANTIC_CONFIGURATION_CHANGED'))
            return result
        if row['code']:
            result.update(error(row['code']))
        if row['state']=='succeeded':
            data = json.loads(row['result'])
            rows,permitted,proofs = self.allowed(session,row['audience'])
            visible = {value['id'] for value in rows}
            if any(item['id'] not in visible for item in data.get('ids',[])):
                result.update(state='stale',**error('STALE_CONTEXT'))
                return result
            if row['kind']=='query':
                result['memories'] = [dict(self.service.record(permitted[item['id']]),**({'semantic_score':item['score']} if item['score'] is not None else {})) for item in data.get('ids',[])]
            result.update(indexed=data.get('indexed',0),search_mode=data.get('search_mode','semantic'))
        return result

    def close(self):
        self.closed = True
        for job in self.jobs.values():
            self.cancel_worker(job)
        self.runtime.close()
        try:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            self.db.execute('BEGIN IMMEDIATE')
            self.service.after_commit = []
            self.retire(state='cancelled',code='PARENT_EXITED')
            self.db.execute('COMMIT')
        except BaseException:
            try:
                if self.db.in_transaction:
                    self.db.execute('ROLLBACK')
            except BaseException:
                pass
