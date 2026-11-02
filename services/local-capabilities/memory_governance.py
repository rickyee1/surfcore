"""Bounded untrusted writer proposals and rebuildable deterministic keyword projection."""
import json
import re
from core import digest, encode, integer, string_list, text
from storage import ServiceError

KINDS = {'identity', 'preference', 'interest', 'project', 'relationship', 'guideline', 'relationship_projection'}
SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_proposals(id TEXT NOT NULL,character TEXT NOT NULL,scope TEXT NOT NULL,principal TEXT NOT NULL,
 birth_epoch TEXT NOT NULL,base_epoch INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,
 PRIMARY KEY(character,id));
CREATE TABLE IF NOT EXISTS episode_consumption(character TEXT NOT NULL,scope TEXT NOT NULL,episode TEXT NOT NULL,revision INTEGER NOT NULL,proposal TEXT NOT NULL,
 PRIMARY KEY(character,scope,episode,revision));
CREATE TABLE IF NOT EXISTS record_source_revisions(memory TEXT NOT NULL,source TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(memory,source));
CREATE TABLE IF NOT EXISTS memory_terms(memory TEXT NOT NULL,term TEXT NOT NULL,PRIMARY KEY(memory,term));
CREATE INDEX IF NOT EXISTS terms_lookup ON memory_terms(term,memory);
"""


def terms(statement):
    result = set(re.findall(r'[a-z0-9_]+', statement.casefold()))
    for run in re.findall(r'[\u3400-\u9fff]+', statement):
        result.update(run[index:index + 2] for index in range(max(1, len(run) - 1)))
    return result


class MemoryGovernance:
    def __init__(self, service):
        self.service, self.db = service, service.db
        self.db.executescript(SCHEMA)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self.rebuild()
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def index(self, identifier):
        self.db.execute('DELETE FROM memory_terms WHERE memory=?', (identifier,))
        row = self.db.execute("SELECT statement,status FROM memories WHERE id=?", (identifier,)).fetchone()
        if row and row['status'] == 'active':
            self.db.executemany('INSERT OR IGNORE INTO memory_terms VALUES(?,?)', [(identifier, term) for term in terms(row['statement'])])

    def rebuild(self, character=None):
        query = 'SELECT id FROM memories' + (' WHERE character=?' if character else '')
        rows = self.db.execute(query, (character,) if character else ()).fetchall()
        for row in rows:
            self.index(row['id'])
        return dict(index='deterministic_keywords_v1', indexed=len(rows), semantic_vectors=False)

    def keyword_ids(self, session, query):
        wanted = sorted(terms(query))
        if not wanted or len(wanted) > 50:
            raise ServiceError('INVALID_REQUEST', '关键词查询必须包含 1–50 个词元。')
        audience = '' if session['management'] else " AND m.scope IN (?, 'bili:public') AND m.status='active'"
        args = [session['character']] + ([] if session['management'] else [session['scope']]) + wanted + [len(wanted)]
        # Filter the SQL audience before any term lookup result is returned.
        query_sql = ('SELECT m.id FROM memories m JOIN memory_terms t ON t.memory=m.id WHERE m.character=?' + audience +
                     ' AND t.term IN (' + ','.join('?' for _ in wanted) + ') GROUP BY m.id HAVING count(DISTINCT t.term)=?')
        return {row[0] for row in self.db.execute(query_sql, args)}

    def visible_sources(self, session, ids, revisions):
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or len(set(ids)) != len(ids):
            raise ServiceError('INVALID_REQUEST', '提案必须包含 1–20 个唯一经历来源。')
        ids = [text(identifier, 200) for identifier in ids]
        if not isinstance(revisions, dict) or set(revisions) != set(ids):
            raise ServiceError('INVALID_REQUEST', '每个来源必须绑定唯一的当前修订。')
        permitted = {row['id']: row for row in self.service.visible_rows(dict(session, management=False))}
        rows = []
        for identifier in ids:
            revision = integer(revisions[identifier], 1, 2**53 - 1)
            row = permitted.get(identifier)
            if not row or row['status'] != 'active' or not self.service.visible(row, permitted):
                raise ServiceError('PERMISSION_DENIED', '提案来源对当前受众不可用。')
            if row['kind'] not in ('episode', 'legacy_summary') or row['revision'] != revision:
                raise ServiceError('VERSION_CONFLICT', '经历来源已改变或来源类型无效。', '重新读取待处理经历及修订后生成提案。')
            rows.append(row)
        return rows

    def check_epoch(self, character, expected):
        if type(expected) is not int or expected != self.service.epoch(character):
            raise ServiceError('STALE_CONTEXT', '提案的记忆版本已过期。', '重新检索来源，不重放旧整理结果。')
        if not self.db.execute('SELECT auto_write FROM characters WHERE id=?', (character,)).fetchone()[0]:
            raise ServiceError('AUTO_WRITE_DISABLED', '已停用自动整理。', '由主人在记忆管理页开启。')

    def pending(self, session, params):
        limit = integer(params.get('limit', 20), 1, 100)
        permitted = {row['id']: row for row in self.service.visible_rows(dict(session, management=False))}
        result = []
        for row in permitted.values():
            if row['scope'] != session['scope'] or row['kind'] != 'episode' or not self.service.visible(row, permitted):
                continue
            consumed = self.db.execute('SELECT 1 FROM episode_consumption WHERE character=? AND scope=? AND episode=? AND revision=?',
                                       (session['character'], session['scope'], row['id'], row['revision'])).fetchone()
            if not consumed:
                record = self.service.record(row)
                if len(encode(result + [record]).encode('utf-8')) > 2 * 1024 * 1024:
                    break
                result.append(record)
            if len(result) == limit:
                break
        return dict(episodes=result, memory_epoch=self.service.epoch(session['character']), index='deterministic_keywords_v1')

    def dispatch(self, operation, session, params):
        if operation == 'memory.episodes.pending':
            return self.pending(session, params)
        if operation == 'memory.resume':
            return self.resume(session, params)
        if operation == 'memory.index.rebuild':
            self.service.management(session)
            return self.rebuild(session['character'])
        character = session['character']
        if operation == 'memory.proposals.list':
            # Proposal history may contain superseded candidate wording. It is an
            # explicit management view, never an alternate model recall surface.
            self.service.management(session)
            limit = integer(params.get('limit', 20), 1, 100)
            offset = integer(params.get('offset', 0), 0, 100000)
            rows = self.db.execute('SELECT * FROM memory_proposals WHERE character=? ORDER BY rowid DESC LIMIT ? OFFSET ?', (character, limit, offset)).fetchall()
            proposals = []
            for row in rows:
                item = dict(proposal_id=row['id'],status=row['status'],payload=json.loads(row['payload']) if row['payload'] else None,result=json.loads(row['result']))
                if len(encode(proposals + [item]).encode('utf-8')) > 2 * 1024 * 1024:
                    break
                proposals.append(item)
            return dict(proposals=proposals, next_offset=offset+len(proposals), memory_epoch=self.service.epoch(character))
        identifier = text(params.get('proposal_id'), 200)
        prior = self.db.execute('SELECT * FROM memory_proposals WHERE character=? AND id=?', (character, identifier)).fetchone()
        if prior and (prior['scope'] != session['scope'] or prior['principal'] != session['principal']):
            raise ServiceError('PERMISSION_DENIED', '提案不属于当前会话主体和受众。')
        if operation == 'memory.proposals.submit':
            canonical = {key: params.get(key) for key in ('source_ids', 'source_revisions', 'expected_memory_epoch', 'proposals')}
            hashed = digest(encode(canonical))
            if prior:
                if prior['status'] == 'deleted':
                    raise ServiceError('DELETED_SOURCE', '此提案来源已删除。')
                if prior['digest'] != hashed:
                    raise ServiceError('VERSION_CONFLICT', '同一提案 ID 的内容发生变化。')
                return dict(proposal_id=identifier, duplicate=True, status=prior['status'], result=json.loads(prior['result']))
            self.check_epoch(character, params.get('expected_memory_epoch'))
            sources = self.visible_sources(session, params.get('source_ids'), params.get('source_revisions'))
            items = params.get('proposals')
            if not isinstance(items, list) or not 1 <= len(items) <= 6:
                raise ServiceError('INVALID_REQUEST', '一个来源批次只允许 1–6 条提案。')
            for item in items:
                if not isinstance(item, dict) or item.get('operation') not in ('add', 'supersede', 'invalidate') or item.get('kind') not in KINDS:
                    raise ServiceError('INVALID_REQUEST', '提案操作或认知类型无效。')
                if item['operation'] != 'invalidate':
                    statement = text(item.get('statement'), 12000)
                    if self.db.execute("SELECT 1 FROM tombstones WHERE character=? AND kind='content' AND digest=?",(character,digest(statement))).fetchone():
                        raise ServiceError('DELETED_SOURCE', '提案正文已被用户删除。', '不能换提案 ID 重放删除内容。')
                if item['operation'] != 'add':
                    text(item.get('target_id'), 200)
                    integer(item.get('expected_revision'), 1, 2**53 - 1)
            for row in sources:
                if self.db.execute('SELECT 1 FROM episode_consumption WHERE character=? AND scope=? AND episode=? AND revision=?',
                                   (character, session['scope'], row['id'], row['revision'])).fetchone():
                    raise ServiceError('SOURCE_CONSUMED', '此经历修订已完成整理。', '等待新经历或新的用户修订。')
            self.db.execute('INSERT INTO memory_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
                            (identifier, character, session['scope'], session['principal'], session['epoch'], self.service.epoch(character), hashed, encode(canonical), 'pending', '{}'))
            return dict(proposal_id=identifier, duplicate=False, status='pending')
        if operation != 'memory.proposals.commit' or not prior:
            raise ServiceError('NOT_FOUND', '待提交提案不存在。')
        if prior['status'] == 'deleted':
            raise ServiceError('DELETED_SOURCE', '此提案的来源已删除。')
        if prior['status'] == 'committed':
            return dict(json.loads(prior['result']), duplicate=True)
        self.check_epoch(character, params.get('expected_memory_epoch'))
        if prior['birth_epoch'] != session['epoch'] or prior['base_epoch'] != self.service.epoch(character):
            raise ServiceError('STALE_CONTEXT', '提案生成后角色或记忆已改变。', '重新读取经历并提交新提案。')
        payload = json.loads(prior['payload'])
        sources = self.visible_sources(session, payload['source_ids'], payload['source_revisions'])
        identifiers = []
        for number, item in enumerate(payload['proposals']):
            if item['operation'] == 'add':
                refs = sorted({ref for row in sources for ref in json.loads(row['sources'])})
                if len(refs) > 50:
                    raise ServiceError('INVALID_REQUEST', '组合来源引用超过上限。')
                saved = self.service.ingest(session, dict(source_event_id=f'proposal:{identifier}:{number}', text=item['statement'],
                                            source_refs=refs, derived_from=payload['source_ids']))
                if saved['duplicate']:
                    raise ServiceError('VERSION_CONFLICT', '提案生成的记录事件 ID 已被其他来源使用。', '保留原记录，使用新的提案 ID 重新评估。')
                record_id = saved['id']
                self.db.execute('UPDATE memories SET kind=? WHERE id=?', (item['kind'], record_id))
                self.db.execute("UPDATE revisions SET actor='writer' WHERE memory=? AND revision=1",(record_id,))
            else:
                row = self.service.target(character, dict(id=item['target_id']))
                permitted = {value['id']: value for value in self.service.visible_rows(dict(session, management=False))}
                if (row['scope'] != session['scope'] or row['id'] not in permitted or row['kind'] not in KINDS
                        or row['status'] != 'active' or not self.service.visible(row, permitted)):
                    raise ServiceError('PERMISSION_DENIED', '自动整理目标不是当前可见的活动认知。')
                if row['pinned'] or row['revision'] != item['expected_revision']:
                    raise ServiceError('VERSION_CONFLICT', '自动整理不得覆盖用户固定或新修订的认知。')
                record_id = row['id']
                for descendant in self.service.affected_records(character, record_id) - {record_id}:
                    self.db.execute("UPDATE memories SET status='suspended',revision=revision+1 WHERE id=? AND status='active'", (descendant,))
                statement = row['statement'] if item['operation'] == 'invalidate' else item['statement']
                if self.db.execute("SELECT 1 FROM tombstones WHERE character=? AND kind='content' AND digest=?", (character, digest(statement))).fetchone():
                    raise ServiceError('DELETED_SOURCE', '提案内容已被用户删除。')
                status = 'invalidated' if item['operation'] == 'invalidate' else 'active'
                refs = sorted({ref for source in sources for ref in json.loads(source['sources'])})
                if len(refs) > 50:
                    raise ServiceError('INVALID_REQUEST', '组合来源引用超过上限。')
                self.db.execute('UPDATE memories SET statement=?,status=?,revision=revision+1,derived=?,sources=?,content_hash=? WHERE id=?',
                                (statement,status,encode(payload['source_ids']),encode(refs),digest(statement),record_id))
                for ref in refs:
                    self.service.fingerprint(record_id,character,'source',digest(ref))
                self.db.execute('INSERT INTO revisions VALUES(?,?,?,?)', (record_id, row['revision'] + 1, statement, 'writer'))
                self.service.fingerprint(record_id, character, 'content', digest(statement))
                self.service.bump(character)
            self.db.execute('DELETE FROM record_source_revisions WHERE memory=?', (record_id,))
            self.db.executemany('INSERT INTO record_source_revisions VALUES(?,?,?)', [(record_id, row['id'], row['revision']) for row in sources])
            self.index(record_id)
            identifiers.append(record_id)
        self.db.executemany('INSERT INTO episode_consumption VALUES(?,?,?,?,?)',
                            [(character, session['scope'], row['id'], row['revision'], identifier) for row in sources])
        result = dict(proposal_id=identifier, ids=identifiers, memory_epoch=self.service.epoch(character), duplicate=False)
        self.db.execute("UPDATE memory_proposals SET status='committed',result=? WHERE character=? AND id=?", (encode(result), character, identifier))
        return result

    def on_delete(self, character, doomed):
        for identifier in doomed:
            self.db.execute('DELETE FROM memory_terms WHERE memory=?', (identifier,))
            self.db.execute('DELETE FROM record_source_revisions WHERE memory=? OR source=?', (identifier, identifier))
            self.db.execute('DELETE FROM episode_consumption WHERE character=? AND episode=?', (character, identifier))
        deleted_content = {row[0] for row in self.db.execute("SELECT digest FROM tombstones WHERE character=? AND kind='content'",(character,))}
        for row in self.db.execute('SELECT id,payload,result FROM memory_proposals WHERE character=? AND payload!=?', (character, '')).fetchall():
            payload = json.loads(row['payload'])
            result = json.loads(row['result'])
            referenced = set(payload['source_ids']) | {item.get('target_id') for item in payload['proposals']} | set(result.get('ids', []))
            bodies = {digest(item['statement']) for item in payload['proposals'] if isinstance(item.get('statement'),str)}
            if referenced.intersection(doomed) or bodies.intersection(deleted_content):
                self.db.execute("UPDATE memory_proposals SET status='deleted',payload='',result='{}' WHERE character=? AND id=?", (character, row['id']))

    def resume(self, session, params):
        self.service.management(session)
        row = self.service.target(session['character'], params)
        if row['status'] == 'deleted':
            raise ServiceError('DELETED_SOURCE', '删除记录不能恢复为活动内容。')
        if row['revision'] != params.get('expected_revision'):
            raise ServiceError('VERSION_CONFLICT', '恢复使用前记录已改变。')
        if row['status'] not in ('suspended', 'invalidated'):
            raise ServiceError('INVALID_REQUEST', '仅停用或失效记录需要复审恢复。')
        permitted = {value['id']: value for value in self.service.visible_rows(dict(session, scope=row['scope'], management=False))}
        derived = json.loads(row['derived'])
        expected = params.get('expected_source_revisions', {})
        if set(expected) != set(derived):
            raise ServiceError('INVALID_REQUEST', '复审必须明确全部来源的当前修订。')
        for source in derived:
            if source not in permitted or not self.service.visible(permitted[source], permitted) or expected[source] != permitted[source]['revision']:
                raise ServiceError('STALE_CONTEXT', '复审来源不可用或版本已改变。')
        if self.db.execute('SELECT 1 FROM fingerprints f JOIN tombstones t ON t.character=f.character AND t.kind=f.kind AND t.digest=f.digest WHERE f.memory=?', (row['id'],)).fetchone():
            raise ServiceError('DELETED_SOURCE', '记录关联的来源已删除。')
        self.db.execute("UPDATE memories SET status='active',pinned=1,revision=revision+1 WHERE id=?", (row['id'],))
        self.db.execute('INSERT INTO revisions VALUES(?,?,?,?)', (row['id'], row['revision'] + 1, row['statement'], 'user_resume'))
        self.db.execute('DELETE FROM record_source_revisions WHERE memory=?', (row['id'],))
        self.db.executemany('INSERT INTO record_source_revisions VALUES(?,?,?)', [(row['id'], source, expected[source]) for source in derived])
        self.index(row['id'])
        return dict(memory=self.service.record(self.service.target(session['character'], params)), memory_epoch=self.service.bump(session['character']))
