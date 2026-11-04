"""Private host-coordinator role restore and non-authority attention portability.

All dispatches run in CapabilityService.handle's single SQLCipher transaction.
This API is deliberately absent from the browser management operation whitelist.
"""
import hashlib
import json
import math
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from storage import ServiceError

SCHEMA = '''
CREATE TABLE IF NOT EXISTS purpose_replay(character TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,outcome TEXT NOT NULL,
 PRIMARY KEY(character,kind,digest));
CREATE TABLE IF NOT EXISTS portable_revision(character TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS portable_events(character TEXT NOT NULL,event_key TEXT NOT NULL,dedupe TEXT NOT NULL,
 created_ms INTEGER NOT NULL,outcome TEXT NOT NULL,charged INTEGER NOT NULL,PRIMARY KEY(character,event_key));
CREATE TABLE IF NOT EXISTS package_operations(id TEXT PRIMARY KEY,target TEXT NOT NULL,package_digest TEXT NOT NULL,
 mode TEXT NOT NULL,base_epoch INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,restore_id TEXT NOT NULL,
 persona_digest TEXT NOT NULL,summary TEXT NOT NULL,committed_epoch INTEGER,published INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS package_single_begun ON package_operations(target)
 WHERE status IN ('blocked','committed_paused','published_paused');
CREATE TABLE IF NOT EXISTS package_latches(target TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS package_receipts(target TEXT NOT NULL,package_digest TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
 memory_epoch INTEGER NOT NULL,persona_digest TEXT NOT NULL,PRIMARY KEY(target,package_digest));
'''


def hashed(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def dedupe(character, identifier):
    return hashed('surfcore-outreach-dedupe-v1\0' + character + '\0' + identifier)


def identity(value, digest=False):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}' if digest else '[a-z0-9][a-z0-9_-]{0,39}', value):
        raise ServiceError('INVALID_REQUEST', '角色包标识格式无效。')
    return value


def operation_id(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{32}', value):
        raise ServiceError('INVALID_REQUEST', '角色包操作 ID 无效。')
    return value


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ServiceError('INVALID_REQUEST', '角色包字段集合不匹配。')


def merge_event(first, second):
    if first['dedupeDigest'] != second['dedupeDigest'] or first['createdUtcMs'] != second['createdUtcMs']:
        raise ServiceError('PORTABLE_EVENT_CONFLICT', '主动事件时间冲突。', '保留原包与目标账目；不能忽略冲突后重发。')
    charged = first['charged'] or second['charged']
    outcome = 'unknown' if 'unknown' in (first['outcome'], second['outcome']) else ('sent' if charged else 'failed')
    return dict(first, charged=charged, outcome=outcome)


def validate_purpose(value):
    exact(value, 'terminals bodyHashes')
    if not isinstance(value['terminals'], dict) or len(value['terminals']) > 10000 or not isinstance(value['bodyHashes'], list) or len(value['bodyHashes']) > 10000:
        raise ServiceError('INVALID_REQUEST', '目的防重放摘要超过上限。')
    for key, outcome in value['terminals'].items():
        identity(key, True)
        if outcome not in ('unknown', 'done', 'consumed'):
            raise ServiceError('INVALID_REQUEST', '目的终态无效。')
    for key in value['bodyHashes']:
        identity(key, True)
    if len(set(value['bodyHashes'])) != len(value['bodyHashes']):
        raise ServiceError('INVALID_REQUEST', '目的正文摘要重复。')
    return value


def validate_summary(value, now_ms):
    if isinstance(value, dict) and 'purpose' in value:
        validate_purpose(value['purpose'])
        exact({key: item for key, item in value.items() if key != 'purpose'}, 'schema sourceTimezone capturedAt attentionRevision unanswered intensity events')
    else:
        exact(value, 'schema sourceTimezone capturedAt attentionRevision unanswered intensity events')
    if value['schema'] != 1 or value['sourceTimezone'] not in ('UTC', 'Asia/Shanghai'):
        raise ServiceError('INVALID_REQUEST', '主动摘要版本或时区不支持。')
    for field in ('capturedAt', 'attentionRevision', 'unanswered'):
        if type(value[field]) is not int or not 0 <= value[field] < 2**53:
            raise ServiceError('INVALID_REQUEST', '主动摘要数值无效。')
    if value['capturedAt'] > now_ms + 300000 or type(value['intensity']) not in (int, float) or not math.isfinite(value['intensity']) or not .25 <= value['intensity'] <= 1:
        raise ServiceError('INVALID_REQUEST', '主动摘要时间或强度无效。')
    if not isinstance(value['events'], list) or len(value['events']) > 50000:
        raise ServiceError('INVALID_REQUEST', '主动摘要事件过多。')
    keys, events = set(), {}
    for event in value['events']:
        exact(event, 'eventKey dedupeDigest createdUtcMs outcome charged')
        identity(event['eventKey'], True); identity(event['dedupeDigest'], True)
        if event['eventKey'] in keys or type(event['createdUtcMs']) is not int or not 0 <= event['createdUtcMs'] <= value['capturedAt'] + 300000:
            raise ServiceError('INVALID_REQUEST', '主动摘要事件重复或时间无效。')
        if event['outcome'] not in ('sent', 'unknown', 'failed') or type(event['charged']) is not bool or event['charged'] != (event['outcome'] != 'failed'):
            raise ServiceError('INVALID_REQUEST', '主动摘要终态无效。')
        keys.add(event['eventKey'])
        old = events.get(event['dedupeDigest'])
        events[event['dedupeDigest']] = merge_event(old, event) if old else event
    return value


class PortableState:
    def __init__(self, service):
        self.service, self.db = service, service.db
        self.token = uuid.uuid4().hex + uuid.uuid4().hex
        self.db.executescript(SCHEMA)
        for table in ('attention', 'outreach', 'purpose_replay'):
            for action in ('INSERT', 'UPDATE', 'DELETE'):
                row = 'OLD' if action == 'DELETE' else 'NEW'
                self.db.execute(f'''CREATE TRIGGER IF NOT EXISTS portable_{table}_{action.lower()}
                    AFTER {action} ON {table} BEGIN
                    INSERT INTO portable_revision VALUES({row}.character,1)
                    ON CONFLICT(character) DO UPDATE SET revision=revision+1; END''')

    def blocked(self, character):
        return self.db.execute('SELECT operation_id FROM package_latches WHERE target=?', (character,)).fetchone()

    def gate(self, character):
        if self.blocked(character):
            raise ServiceError('ROLE_PACKAGE_PAUSED', '角色包恢复尚未核对完成。', '仅本机角色包状态、检查、恢复和复审可用；停止普通生成与发送。')

    def revision(self, character):
        row = self.db.execute('SELECT revision FROM portable_revision WHERE character=?', (character,)).fetchone()
        return row[0] if row else 0

    def purpose(self, character):
        terminals, bodies = {}, []
        for row in self.db.execute('SELECT * FROM purpose_replay WHERE character=? ORDER BY digest', (character,)):
            if row['kind'] == 'terminal':
                terminals[row['digest']] = row['outcome']
            else:
                bodies.append(row['digest'])
        return validate_purpose(dict(terminals=terminals, bodyHashes=bodies))

    def native_events(self, character):
        lineage = self.db.execute("SELECT value FROM sovereignty.metadata WHERE key='lineage'").fetchone()[0]
        return [dict(eventKey=hashed('surfcore-outreach-event-v1\0' + lineage + '\0' + character + '\0' + row['id']),
                     dedupeDigest=dedupe(character, row['id']), createdUtcMs=round(row['created'] * 1000),
                     outcome='unknown' if row['status'] in ('reserved', 'running') else row['status'],
                     charged=row['status'] != 'failed')
                for row in self.db.execute('SELECT * FROM outreach WHERE character=?', (character,))]

    def events(self, character):
        values = self.native_events(character)
        for row in self.db.execute('SELECT * FROM portable_events WHERE character=?', (character,)):
            values.append(dict(eventKey=row['event_key'], dedupeDigest=row['dedupe'], createdUtcMs=row['created_ms'], outcome=row['outcome'], charged=bool(row['charged'])))
        union = {}
        for event in values:
            old = union.get(event['dedupeDigest'])
            union[event['dedupeDigest']] = merge_event(old, event) if old else event
        return union

    def summary(self, character):
        from core import DEFAULT_ATTENTION
        row = self.db.execute('SELECT * FROM attention WHERE character=?', (character,)).fetchone()
        config = json.loads(row['config']) if row else DEFAULT_ATTENTION
        # Keep distinct provenance event keys, while budget union uses dedupeDigest.
        values = {event['eventKey']: event for event in self.native_events(character)}
        for event in self.db.execute('SELECT * FROM portable_events WHERE character=?', (character,)):
            values[event['event_key']] = dict(eventKey=event['event_key'], dedupeDigest=event['dedupe'], createdUtcMs=event['created_ms'], outcome=event['outcome'], charged=bool(event['charged']))
        union = self.events(character)
        values = {key: dict(event, outcome=union[event['dedupeDigest']]['outcome'], charged=union[event['dedupeDigest']]['charged']) for key, event in values.items()}
        result = dict(schema=1, sourceTimezone=config['timezone'], capturedAt=round(self.service.clock() * 1000),
                      attentionRevision=self.revision(character), unanswered=row['unanswered'] if row else 0,
                      intensity=row['intensity'] if row else 1, events=sorted(values.values(), key=lambda event: event['eventKey']))
        result['purpose'] = self.purpose(character)
        return validate_summary(result, result['capturedAt'])

    def attention_reason(self, session, identifier, config, state, owned):
        character = session['character']
        values = self.events(character)
        key = dedupe(character, identifier)
        if key in values and not owned:
            return 'duplicate'
        values = [event for identifier, event in values.items() if identifier != key and event['charged']]
        offset = 8 if config['timezone'] == 'Asia/Shanghai' else 0
        zone = timezone(timedelta(hours=offset))
        today = datetime.fromtimestamp(self.service.clock(), zone).date()
        if sum(datetime.fromtimestamp(event['createdUtcMs'] / 1000, zone).date() == today for event in values) >= max(0, int(config['daily_limit'] * state['intensity'])):
            return 'daily_budget'
        if values and self.service.clock() - max(event['createdUtcMs'] / 1000 for event in values) < config['cooldown_seconds'] / state['intensity']:
            return 'cooldown'
        return ''

    def merge(self, character, summary):
        from core import DEFAULT_ATTENTION, encode
        validate_summary(summary, round(self.service.clock() * 1000))
        values = self.events(character)
        by_key = {event['eventKey']: event for event in self.native_events(character)}
        for row in self.db.execute('SELECT * FROM portable_events WHERE character=?', (character,)):
            by_key[row['event_key']] = dict(dedupeDigest=row['dedupe'], createdUtcMs=row['created_ms'])
        for event in summary['events']:
            old = by_key.get(event['eventKey'])
            if old and (old['dedupeDigest'] != event['dedupeDigest'] or old['createdUtcMs'] != event['createdUtcMs']):
                raise ServiceError('PORTABLE_EVENT_CONFLICT', '事件账目标识与已有去重或时间冲突。')
        for event in summary['events']:
            old = values.get(event['dedupeDigest'])
            merged = merge_event(old, event) if old else event
            values[event['dedupeDigest']] = merged
            # Upgrade all existing provenance for the same event. A later failed
            # source can neither erase unknown nor reduce a prior charge.
            self.db.execute('UPDATE portable_events SET outcome=?,charged=? WHERE character=? AND dedupe=?',
                            (merged['outcome'], int(merged['charged']), character, event['dedupeDigest']))
            self.db.execute('INSERT INTO portable_events VALUES(?,?,?,?,?,?) ON CONFLICT(character,event_key) DO UPDATE SET outcome=excluded.outcome,charged=excluded.charged',
                            (character, event['eventKey'], event['dedupeDigest'], event['createdUtcMs'], merged['outcome'], int(merged['charged'])))
        replay = summary.get('purpose', dict(terminals={}, bodyHashes=[]))
        existing = self.purpose(character)
        terminals = dict(existing['terminals'])
        for key, outcome in replay['terminals'].items():
            previous = terminals.get(key)
            terminals[key] = 'unknown' if 'unknown' in (previous, outcome) else 'done' if 'done' in (previous, outcome) else 'consumed'
        bodies = sorted(set(existing['bodyHashes']) | set(replay['bodyHashes']))
        validate_purpose(dict(terminals=terminals, bodyHashes=bodies))
        for key, outcome in terminals.items():
            self.db.execute("INSERT INTO purpose_replay VALUES(?,'terminal',?,?) ON CONFLICT(character,kind,digest) DO UPDATE SET outcome=excluded.outcome", (character, key, outcome))
        self.db.executemany("INSERT OR IGNORE INTO purpose_replay VALUES(?,'body',?,'consumed')", [(character, key) for key in bodies])
        self.db.execute('INSERT OR IGNORE INTO attention(character,config) VALUES(?,?)', (character, encode(DEFAULT_ATTENTION)))
        row = self.db.execute('SELECT * FROM attention WHERE character=?', (character,)).fetchone()
        config = json.loads(row['config']); config['enabled'] = False
        self.db.execute('UPDATE attention SET config=?,unanswered=max(unanswered,?),intensity=min(intensity,?) WHERE character=?',
                        (encode(config), summary['unanswered'], summary['intensity'], character))

    def row(self, identifier):
        row = self.db.execute('SELECT * FROM package_operations WHERE id=?', (operation_id(identifier),)).fetchone()
        if not row:
            raise ServiceError('NOT_FOUND', '角色包操作不存在。')
        return row

    def status(self, row):
        receipt = self.db.execute('SELECT * FROM package_receipts WHERE target=? AND package_digest=?', (row['target'], row['package_digest'])).fetchone()
        return dict(operation_id=row['id'], target_id=row['target'], package_digest=row['package_digest'], revision=row['revision'],
                    status=row['status'], blocked=bool(self.blocked(row['target'])), published=bool(row['published']),
                    memory_epoch=self.service.epoch(row['target']) if self.db.execute('SELECT 1 FROM characters WHERE id=?', (row['target'],)).fetchone() else 0,
                    receipt=dict(receipt) if receipt else None,
                    native_review=self.service.backups.recovery_status(row['target']) if receipt else None)

    def owner(self, row, expected):
        if type(expected) is not int or row['revision'] != expected:
            raise ServiceError('VERSION_CONFLICT', '角色包操作版本已改变。')
        latch = self.blocked(row['target'])
        if not latch or latch[0] != row['id']:
            raise ServiceError('VERSION_CONFLICT', '角色包暂停归属已改变。')

    def dispatch(self, op, request, params):
        from core import encode, DEFAULT_ATTENTION
        if request.get('portable_coordinator') != self.token:
            raise ServiceError('PERMISSION_DENIED', '仅允许宿主角色包协调器内部调用。')
        backups = self.service.backups
        if op == 'portable.diagnostics':
            from schema_compat import VERSION
            journal = self.service.store.directory / 'schema-upgrade.json'
            upgrade = json.loads(journal.read_text(encoding='utf-8')) if journal.is_file() else None
            return dict(reader_schema=VERSION, database_schema=self.db.execute('PRAGMA user_version').fetchone()[0],
                        min_reader_schema=self.db.execute("SELECT value FROM store_metadata WHERE key='min_reader_schema'").fetchone()[0],
                        key_protection=upgrade['protection'] if upgrade else 'development_raw_key', key_backup=upgrade['key_backup'] if upgrade else None,
                        upgrade_phase=upgrade['phase'] if upgrade else 'complete', owned_pid=os.getpid(), sqlcipher_available=True,
                        package_pauses=self.db.execute('SELECT count(*) FROM package_latches').fetchone()[0])
        if op == 'portable.receipt':
            receipt = self.db.execute('SELECT operation_id FROM package_receipts WHERE target=? AND package_digest=?',
                                      (identity(params.get('target_character_id')), identity(params.get('package_digest'), True))).fetchone()
            return dict(found=bool(receipt), **(self.status(self.row(receipt[0])) if receipt else {}))
        if op in ('portable.capture', 'portable.fence'):
            character = identity(params.get('character_id'))
            self.gate(character)
            result = dict(memory_epoch=self.service.epoch(character), attention_revision=self.revision(character))
            if op == 'portable.capture':
                summary = self.summary(character)
                summary_id = uuid.uuid4().hex
                path = backups.owned('portable-inputs', summary_id, '.json')
                with path.open('x', encoding='utf-8') as stream:
                    from schema_compat import private
                    private(path)
                    stream.write(encode(summary)); stream.flush(); os.fsync(stream.fileno())
                result.update(snapshot=backups.dispatch('backup.create', dict(character=character, management=True), dict(password=params.get('password'))), attention_id=summary_id)
            return result
        if op in ('portable.inspect', 'portable.stage'):
            target = identity(params.get('target_character_id'))
            header, data = backups.open_backup(params.get('backup_id'), params.get('password'))
            if data['character_id'] != target:
                raise ServiceError('CHARACTER_ID_CONFLICT', '角色包与快照身份不一致。')
            if op == 'portable.stage':
                receipt = self.db.execute('SELECT operation_id FROM package_receipts WHERE target=? AND package_digest=?',
                                          (target, identity(params.get('package_digest'), True))).fetchone()
                if receipt:
                    return dict(self.status(self.row(receipt[0])), duplicate=True)
            exists = self.db.execute('SELECT 1 FROM characters WHERE id=?', (target,)).fetchone()
            if params.get('mode') not in ('new', 'restore_same_id') or bool(exists) != (params['mode'] == 'restore_same_id'):
                raise ServiceError('CHARACTER_ID_CONFLICT', '目标存在状态与明确导入方式不一致。')
            if sum(header['counts'].values()) > 50000:
                raise ServiceError('INVALID_REQUEST', '角色包逻辑记录超过限制。')
            if op == 'portable.inspect':
                return dict(character_id=target, counts=header['counts'], scopes=sorted({row['scope'] for row in data['records']['memories']}), requires_review=True,
                            memory_epoch=self.service.epoch(target) if exists else 0, ledger_instance=backups.ledger_instance())
            identifier = operation_id(params.get('operation_id'))
            digest = identity(params.get('package_digest'), True)
            summary_path = backups.owned('portable-inputs', params.get('attention_id'), '.json')
            if not summary_path.is_file() or summary_path.stat().st_nlink != 1 or summary_path.stat().st_size > 16 * 1024 * 1024:
                raise ServiceError('INVALID_REQUEST', '主动摘要暂存文件无效。')
            summary = validate_summary(json.loads(summary_path.read_text(encoding='utf-8')), round(self.service.clock() * 1000))
            base = self.service.epoch(target) if exists else 0
            if params.get('expected_memory_epoch') != base:
                raise ServiceError('VERSION_CONFLICT', '隔离前目标记忆版本已改变。')
            persona = identity(params.get('persona_digest'), True)
            from backup import file_digest
            restore = uuid.uuid4().hex
            file = backups.owned('restore-staging', restore, '.db')
            backups.write(file, self.service.store._key, header, data)
            self.db.execute('INSERT INTO restore_stages VALUES(?,?,?,?,?,?,?)', (restore, target, base, 'staged', 1, file_digest(file), encode(header)))
            self.db.execute('INSERT INTO package_operations VALUES(?,?,?,?,?,?,?,?,?,?,NULL,0)',
                            (identifier, target, digest, params['mode'], base, 1, 'staged', restore, persona, encode(summary)))
            return self.status(self.row(identifier))
        row = self.row(params.get('operation_id'))
        if op == 'portable.status':
            return self.status(row)
        if op == 'portable.cancel' and row['status'] in ('staged', 'cancelled'):
            if params.get('expected_revision') != row['revision']:
                raise ServiceError('VERSION_CONFLICT', '取消版本已改变。')
            self.db.execute("UPDATE package_operations SET status='cancelled',revision=revision+1 WHERE id=?", (row['id'],))
            return self.status(self.row(row['id']))
        if op == 'portable.begin':
            if row['status'] != 'staged' or params.get('expected_revision') != row['revision']:
                raise ServiceError('VERSION_CONFLICT', '该操作不能再次开始。')
            if self.blocked(row['target']):
                raise ServiceError('ROLE_PACKAGE_PAUSED', '另一个角色包操作已经持有目标暂停。')
            exists = self.db.execute('SELECT 1 FROM characters WHERE id=?', (row['target'],)).fetchone()
            if bool(exists) != (row['mode'] == 'restore_same_id') or (exists and self.service.epoch(row['target']) != row['base_epoch']):
                raise ServiceError('VERSION_CONFLICT', '目标身份或记忆已改变。')
            expires=params.get('approval_expires_at')
            if type(expires) is not int or not 0<expires<10**16 or expires<=self.service.clock()*1000:
                raise ServiceError('VERSION_CONFLICT','角色包原始确认期限已过或缺失。','目标保持暂停；重新检查本次操作并明确确认，不续用旧审批。')
            self.db.execute('INSERT OR IGNORE INTO characters(id) VALUES(?)', (row['target'],))
            self.db.execute('INSERT INTO package_latches VALUES(?,?)', (row['target'], row['id']))
            self.db.execute("UPDATE package_operations SET status='blocked',revision=revision+1 WHERE id=?", (row['id'],))
            self.db.execute('INSERT OR IGNORE INTO attention(character,config) VALUES(?,?)', (row['target'], encode(DEFAULT_ATTENTION)))
            config = json.loads(self.db.execute('SELECT config FROM attention WHERE character=?', (row['target'],)).fetchone()[0]); config['enabled'] = False
            self.db.execute('UPDATE attention SET config=? WHERE character=?', (encode(config), row['target']))
            self.service.invalidate(row['target'])
            self.service.tools.policy_changed()
            self.service.active.pop(row['target'], None)
            epoch = self.service.bump(row['target'])
            self.db.execute('UPDATE restore_stages SET base_epoch=? WHERE id=?', (epoch, row['restore_id']))
            return self.status(self.row(row['id']))
        self.owner(row, params.get('expected_revision'))
        if op == 'portable.cancel':
            return dict(self.status(row), cancellation_requested=True, hint='已开始的恢复保持暂停；不能回滚正式新写入。')
        if op == 'portable.commit':
            receipt = self.db.execute('SELECT 1 FROM package_receipts WHERE target=? AND package_digest=?', (row['target'], row['package_digest'])).fetchone()
            if receipt:
                return dict(self.status(row), duplicate=True)
            if row['status'] != 'blocked':
                raise ServiceError('VERSION_CONFLICT', '角色包没有持有提交暂停。')
            expected = self.db.execute('SELECT base_epoch FROM restore_stages WHERE id=?', (row['restore_id'],)).fetchone()[0]
            if self.service.epoch(row['target']) != expected:
                raise ServiceError('VERSION_CONFLICT', '暂停后已有合法新写入；禁止用旧快照覆盖。')
            backups.dispatch('backup.restore.commit', dict(character=row['target'], management=True), dict(restore_id=row['restore_id'], expected_memory_epoch=expected))
            self.merge(row['target'], json.loads(row['summary']))
            self.db.execute("INSERT OR REPLACE INTO recovery_state VALUES(?,1,'role_package_review')", (row['target'],))
            epoch = self.service.epoch(row['target'])
            self.db.execute('INSERT INTO package_receipts VALUES(?,?,?,?,?)', (row['target'], row['package_digest'], row['id'], epoch, row['persona_digest']))
            self.db.execute("UPDATE package_operations SET status='committed_paused',revision=revision+1,committed_epoch=? WHERE id=?", (epoch, row['id']))
        elif op == 'portable.publish':
            if row['status'] not in ('committed_paused', 'published_paused') or params.get('persona_digest') != row['persona_digest']:
                raise ServiceError('VERSION_CONFLICT', '发布与数据库回执不一致。')
            self.db.execute("UPDATE package_operations SET status='published_paused',published=1,revision=revision+1 WHERE id=?", (row['id'],))
        elif op == 'portable.review':
            if row['status'] != 'published_paused' or self.service.epoch(row['target']) != row['committed_epoch'] or params.get('persona_digest') != row['persona_digest']:
                raise ServiceError('VERSION_CONFLICT', '复审前文件或正式记忆已改变。', '保留暂停，重新检查当前文件与数据库，禁止重放导入。')
            backups.dispatch('backup.restore.commit', dict(character=row['target'], management=True),
                             dict(restore_id=row['restore_id'], expected_memory_epoch=row['committed_epoch'], review=True, review_digest=params.get('review_digest')))
            self.db.execute("UPDATE package_operations SET status='complete',revision=revision+1 WHERE id=?", (row['id'],))
            self.db.execute('DELETE FROM package_latches WHERE target=? AND operation_id=?', (row['target'], row['id']))
        else:
            raise ServiceError('INVALID_REQUEST', '未知私有角色包操作。')
        return self.status(self.row(row['id']))
