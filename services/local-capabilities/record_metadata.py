"""Optional received-source metadata; never an event clock or a new authority.

Only the trusted stdio ingress adapter may obtain a binding-specific token.
Ordinary ingest, legacy imports and derived statements remain unknown.
"""
import hashlib
import hmac
import json
import math
import uuid

from storage import ServiceError


COLUMNS = ('memory', 'character', 'scope', 'bound_principal', 'received_at_ms',
           'source_revision', 'event_hash', 'content_hash', 'source_kind', 'platform',
           'account_id', 'conversation_id', 'owner_at_receive', 'record_revision', 'record_content_hash')
KINDS = ('user_input', 'assistant_output', 'external_source')
RESERVED = {'source_metadata', 'received_at_ms', 'speaker', 'origin'}


def unknown(derived=False):
    return dict(received_at_ms=None, time_basis='unknown',
                source_speaker=dict(role='unknown', principal_id=None, owner_at_receive=None),
                origin=None, statement_origin='derived' if derived else 'unknown', verbatim=False)


def validate_row(value, memory, revisions=None):
    """Validate portable data without inventing any missing metadata."""
    if not isinstance(value, dict) or set(value) != set(COLUMNS):
        raise ValueError('metadata fields')
    if (value['memory'] != memory['id'] or value['character'] != memory['character']
            or value['scope'] != memory['scope'] or value['bound_principal'] != memory['principal']
            or memory['status'] == 'deleted' or value['event_hash'] != memory['event_hash']
            or memory['content_hash'] != value['content_hash']
            or memory['kind'] != 'episode' or json.loads(memory['derived']) != []
            or value['record_revision'] != memory['revision']
            or hashlib.sha256(memory['statement'].encode('utf-8')).hexdigest() != value['record_content_hash']):
        raise ValueError('metadata source identity')
    if (type(value['received_at_ms']) is not int or not 0 < value['received_at_ms'] < 2**53
            or type(value['source_revision']) is not int or value['source_revision'] != 1
            or value['source_revision'] > memory['revision']):
        raise ValueError('metadata clock or revision')
    if type(value['record_revision']) is not int:
        raise ValueError('metadata current revision')
    for field in ('event_hash', 'content_hash', 'record_content_hash'):
        if (not isinstance(value[field], str) or len(value[field]) != 64
                or any(c not in '0123456789abcdef' for c in value[field])):
            raise ValueError('metadata digest')
    for field in ('platform', 'account_id', 'conversation_id', 'bound_principal'):
        if not isinstance(value[field], str) or not value[field].strip() or len(value[field]) > 200:
            raise ValueError('metadata origin')
    platform, scope = value['platform'], value['scope']
    valid_scope = (platform == 'pet' and scope in ('pet:local', 'owner:local')
                   or platform == 'qq' and scope in ('owner:local',
                       f"qq:private:{value['account_id']}:{value['conversation_id']}",
                       f"qq:group:{value['account_id']}:{value['conversation_id']}")
                   or platform == 'bili' and scope == 'bili:public')
    if not valid_scope or value['source_kind'] not in KINDS:
        raise ValueError('metadata channel')
    if (value['source_kind'] == 'external_source') != (platform == 'bili'):
        raise ValueError('metadata external actor')
    if type(value['owner_at_receive']) is not int or value['owner_at_receive'] not in (0, 1):
        raise ValueError('metadata owner')
    if scope.startswith('qq:group:') and value['owner_at_receive']:
        raise ValueError('metadata group owner')
    if value['source_kind'] != 'user_input' and value['owner_at_receive']:
        raise ValueError('metadata non-user owner')
    if (platform == 'qq' and not scope.startswith('qq:group:')
            and value['bound_principal'] != value['conversation_id']):
        raise ValueError('metadata private actor')
    if revisions is not None:
        original = next((r for r in revisions if r['memory'] == value['memory'] and r['revision'] == 1), None)
        if not original or hashlib.sha256(original['statement'].encode('utf-8')).hexdigest() != value['content_hash']:
            raise ValueError('metadata original revision')


class RecordMetadata:
    def __init__(self, service):
        self.service, self.db = service, service.db
        self.tokens = {}
        # A pre-P1 reader can delete a source without knowing this optional table.
        # Never retain such orphan/deleted provenance on the next P1 open.
        self.db.execute('''DELETE FROM record_metadata WHERE NOT EXISTS
            (SELECT 1 FROM memories m WHERE m.id=record_metadata.memory
             AND m.character=record_metadata.character AND m.status!='deleted')''')

    def retire(self, character):
        self.tokens = {key: value for key, value in self.tokens.items()
                       if value['character'] != character}

    def open(self, session, params):
        # Private stdio operation: not a management/browser/model operation.
        if params or session['management']:
            raise ServiceError('PERMISSION_DENIED', '来源凭据仅供当前普通受众的可信入站适配器。',
                               '由可信宿主绑定实际入站渠道；管理页或模型不能声明来源身份。')
        current = self.tokens.get(session['token'])
        if current and current['epoch'] == session['epoch']:
            return dict(ingress_token=current['token'])
        live = {key: value for key, value in self.tokens.items() if key in self.service.bindings}
        if len(live) >= 128:
            raise ServiceError('SERVICE_UNAVAILABLE', '来源凭据数量达到上限。', '退役不再使用的角色绑定后重试。')
        value = dict(token=uuid.uuid4().hex, character=session['character'], epoch=session['epoch'])
        def publish():
            self.tokens = dict(live, **{session['token']: value})
        self.service.after_commit.append(publish)
        return dict(ingress_token=value['token'])

    def proof(self, session, params, migration=False):
        if migration:
            # Legacy input fields are data, not a host attestation.
            return None
        if RESERVED.intersection(params):
            raise ServiceError('INVALID_REQUEST', '时间、说话人与来源由服务端记录，不能由调用正文指定。',
                               '移除客户端时间与身份字段；没有真实入站证明时省略 ingress，来源将显示 unknown。')
        ingress = params.get('ingress')
        if ingress is None:
            return None
        if (not isinstance(ingress, dict) or set(ingress) != {'token', 'kind'}
                or not isinstance(ingress['token'], str) or len(ingress['token']) > 100
                or ingress['kind'] not in KINDS):
            raise ServiceError('INVALID_REQUEST', '可信入站凭据字段无效。', '仅提供原绑定的 token 与允许的 kind；不要传时间或账号。')
        current = self.tokens.get(session['token'])
        if (session['management'] or not current or current['character'] != session['character']
                or current['epoch'] != session['epoch']
                or not hmac.compare_digest(current['token'], ingress['token'])):
            raise ServiceError('PERMISSION_DENIED', '来源凭据不属于当前渠道绑定或已失效。', '重新绑定实际入站渠道，不重用旧来源凭据。')
        if params.get('derived_from'):
            raise ServiceError('PERMISSION_DENIED', '派生内容不能登记为原始入站原话。', '省略 ingress，保留 derived_from 与原来源修订证明。')
        platform, kind = session['platform'], ingress['kind']
        if platform not in ('pet', 'qq', 'bili') or (kind == 'external_source') != (platform == 'bili'):
            raise ServiceError('PERMISSION_DENIED', '原始来源类型与可信渠道不匹配。', '使用真实渠道的来源类型；公开视频不能声明主人原话。')
        return kind

    def capture(self, session, identifier, statement, event, kind):
        if kind is None:
            return
        milliseconds = self.service.clock() * 1000
        if not math.isfinite(milliseconds) or not 0 < round(milliseconds) < 2**53:
            raise ServiceError('SERVICE_UNAVAILABLE', '服务接收时钟无效。', '核对系统时钟后重试；不会补写事件时间。')
        self.db.execute('INSERT INTO record_metadata (' + ','.join(COLUMNS) + ') VALUES(' + ','.join('?' for _ in COLUMNS) + ')',
                        (identifier, session['character'], session['scope'], session['principal'], round(milliseconds), 1,
                         hashlib.sha256(event.encode('utf-8')).hexdigest(), hashlib.sha256(statement.encode('utf-8')).hexdigest(),
                         kind, session['platform'], session['account'], session['conversation'],
                         int(bool(session['owner'])) if kind == 'user_input' and not session['scope'].startswith('qq:group:') else 0,
                         1, hashlib.sha256(statement.encode('utf-8')).hexdigest()))

    def revise(self, previous, statement, revision):
        """Track a known current correction; never repair an untracked old write."""
        if self.validated(previous) is None:
            # Retire in the owning correction transaction: merely skipping the
            # update lets an old revision/body recur and match a stale frame (ABA).
            self.db.execute('DELETE FROM record_metadata WHERE memory=? AND character=?',
                            (previous['id'], previous['character']))
            return
        self.db.execute('''UPDATE record_metadata SET record_revision=?,record_content_hash=?
            WHERE memory=? AND character=? AND scope=? AND bound_principal=? AND event_hash=?
            AND record_revision=? AND record_content_hash=?''',
            (revision, hashlib.sha256(statement.encode('utf-8')).hexdigest(), previous['id'], previous['character'],
             previous['scope'], previous['principal'], previous['event_hash'], previous['revision'],
             hashlib.sha256(previous['statement'].encode('utf-8')).hexdigest()))

    def validated(self, row):
        """One source/frame gate for projection, export and known revisions."""
        stored = self.db.execute('SELECT * FROM record_metadata WHERE memory=? AND character=?',
                                 (row['id'], row['character'])).fetchone()
        if not stored:
            return None
        value = dict(stored)
        revisions = [dict(r) for r in self.db.execute('SELECT * FROM revisions WHERE memory=? AND revision=1', (row['id'],))]
        try:
            validate_row(value, row, revisions)
        except (ValueError, TypeError, KeyError):
            return None  # Old-reader rewrites/orphans never become new original speech.
        return value

    def project(self, row):
        derived = bool(json.loads(row['derived']))
        result = unknown(derived)
        if row['status'] != 'active':
            return result
        value = self.validated(row)
        if value is None:
            return result
        group = row['scope'].startswith('qq:group:')
        role = 'unknown' if group else {'user_input': 'user', 'assistant_output': 'assistant', 'external_source': 'external'}[value['source_kind']]
        verbatim = (not derived and row['kind'] == 'episode' and row['revision'] == value['source_revision']
                    and row['content_hash'] == value['content_hash']
                    and hashlib.sha256(row['statement'].encode('utf-8')).hexdigest() == value['content_hash'])
        return dict(received_at_ms=value['received_at_ms'], time_basis='service_received',
                    source_speaker=dict(role=role, principal_id=value['bound_principal'] if role == 'user' else None,
                                        owner_at_receive=bool(value['owner_at_receive']) if role == 'user' else None),
                    # Public material is not permission to disclose the reader's
                    # authenticated account identity to every public reader.
                    origin=dict(platform=value['platform'], account_id=value['account_id'] if value['platform'] != 'bili' else None,
                                conversation_id=value['conversation_id'] if value['platform'] != 'bili' else None),
                    statement_origin='derived' if derived else 'original' if verbatim else 'revised', verbatim=verbatim)

    def export_rows(self, character):
        """Owner export/snapshot domain, not an ordinary material-read bypass.

        Old binaries may leave orphaned/stale optional rows. Export only metadata
        that still binds the exact source identity and original revision.
        """
        records = []
        for stored in self.db.execute('SELECT * FROM record_metadata WHERE character=?', (character,)).fetchall():
            row = self.db.execute('SELECT * FROM memories WHERE id=? AND character=?', (stored['memory'], character)).fetchone()
            if not row:
                continue
            value = self.validated(row)
            if value is not None:
                records.append(value)
        return records

    def materials(self, session, params):
        from core import integer
        if session['management']:
            raise ServiceError('PERMISSION_DENIED', '目的素材只允许普通受众绑定读取。', '绑定实际桌宠或私聊受众，不使用管理身份扩大素材范围。')
        if set(params) - {'limit'}:
            raise ServiceError('INVALID_REQUEST', '素材读取仅接受有界 limit，不能指定其他受众。', '仅传 limit，并使用实际当前受众的普通绑定。')
        limit = integer(params.get('limit', 20), 1, 50)
        rows = self.service.visible_rows(dict(session, management=False))
        permitted = {row['id']: row for row in rows}
        visible = [row for row in rows if self.service.visible(row, permitted)]
        records = [dict(self.service.record(row), source_metadata=self.project(row)) for row in visible[:limit]]
        return dict(records=records, memory_epoch=self.service.epoch(session['character']), character_epoch=session['epoch'],
                    has_more=len(visible) > limit, unknown_time_count=sum(r['source_metadata']['received_at_ms'] is None for r in records))
