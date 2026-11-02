"""Password-encrypted logical snapshots. No key, consent or runtime authorization export."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
from core import encode, integer, text
from storage import ServiceError, recover_reservations

COLUMNS = {
    'memories': ('id','character','scope','principal','statement','revision','status','pinned','event_hash','content_hash','sources','derived','kind'),
    'revisions': ('memory','revision','statement','actor'),
    'fingerprints': ('memory','character','kind','digest'),
    'tombstones': ('character','kind','digest'),
    'record_source_revisions': ('memory','source','revision'),
    'episode_consumption': ('character','scope','episode','revision','proposal'),
}
MAX_BYTES = 64 * 1024 * 1024
KDF = dict(name='scrypt', n=16384, r=8, p=1, length=32)


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def snapshot_connection(path, key):
    from sqlcipher3 import dbapi2
    connection = dbapi2.connect(str(path), isolation_level=None)
    connection.row_factory = dbapi2.Row
    try:
        connection.execute(f'PRAGMA key = "x\'{key.hex()}\'"')
        connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
        connection.execute('PRAGMA journal_mode=DELETE')
        connection.execute('PRAGMA secure_delete=ON')
        return connection
    except BaseException:
        connection.close()
        raise


class BackupManager:
    def __init__(self, service):
        self.service, self.store, self.db = service, service.store, service.db
        self.db.execute('''CREATE TABLE IF NOT EXISTS restore_stages(id TEXT PRIMARY KEY,character TEXT NOT NULL,
            base_epoch INTEGER NOT NULL,status TEXT NOT NULL,requires_review INTEGER NOT NULL,digest TEXT NOT NULL,header TEXT NOT NULL)''')

    def area(self, name):
        root = self.store.directory / name
        if root.exists() and (root.is_symlink() or getattr(root.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise ServiceError('PERMISSION_DENIED', '备份目录不允许链接或重解析点。')
        root.mkdir(exist_ok=True)
        if not root.resolve().is_relative_to(self.store.directory):
            raise ServiceError('PERMISSION_DENIED', '备份目录越界。')
        return root

    def owned(self, area, identifier, suffix):
        if not isinstance(identifier, str) or not re.fullmatch('[0-9a-f]{32}', identifier):
            raise ServiceError('INVALID_REQUEST', '只接受服务生成的备份或恢复 ID。')
        path = self.area(area) / (identifier + suffix)
        if path.exists() and (path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise ServiceError('PERMISSION_DENIED', '备份文件不允许链接。')
        return path

    @staticmethod
    def key(password, salt):
        password = text(password, 1024)
        if len(password) < 12:
            raise ServiceError('INVALID_REQUEST', '备份口令至少为 12 个字符。', '使用独立的长口令；不要使用数据库密钥。')
        return hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt), n=KDF['n'], r=KDF['r'], p=KDF['p'], dklen=32)

    def write(self, path, key, header, data):
        # A new file and an independent connection; never Connection.backup on live BEGIN.
        if path.exists():
            raise ServiceError('VERSION_CONFLICT', '备份或隔离文件已经存在。')
        connection = snapshot_connection(path, key)
        try:
            connection.executescript('CREATE TABLE snapshot_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE snapshot_rows(name TEXT PRIMARY KEY,payload TEXT NOT NULL);')
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('INSERT INTO snapshot_meta VALUES(?,?)', ('header', encode(header)))
            connection.execute('INSERT INTO snapshot_meta VALUES(?,?)', ('character', data['character_id']))
            for name, rows in data['records'].items():
                connection.execute('INSERT INTO snapshot_rows VALUES(?,?)', (name, encode(rows)))
            connection.execute('INSERT INTO snapshot_rows VALUES(?,?)', ('deletion_ledger', encode(data['deletion_ledger'])))
            connection.execute('COMMIT')
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ServiceError('BACKUP_CORRUPT', '快照完整性检查失败。')
        finally:
            connection.close()

    def read(self, path, key):
        if not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES * 2:
            raise ServiceError('BACKUP_CORRUPT', '加密快照缺失或大小无效。')
        try:
            connection = snapshot_connection(path, key)
        except Exception:
            raise ServiceError('BACKUP_AUTH_FAILED', '口令无法打开加密快照。', '核对备份口令；活动数据库没有改变。')
        try:
            objects = connection.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
            if {(row['type'], row['name']) for row in objects} != {('table','snapshot_meta'),('table','snapshot_rows')}:
                raise ValueError('schema')
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('integrity')
            meta = dict(connection.execute('SELECT key,value FROM snapshot_meta').fetchall())
            encoded = dict(connection.execute('SELECT name,payload FROM snapshot_rows').fetchall())
            if set(meta) != {'header','character'} or set(encoded) != set(COLUMNS) | {'deletion_ledger'}:
                raise ValueError('fields')
            if sum(len(value.encode('utf-8')) for value in encoded.values()) > MAX_BYTES:
                raise ValueError('size')
            header = json.loads(meta['header'])
            data = dict(character_id=meta['character'], records={name: json.loads(encoded[name]) for name in COLUMNS},
                        deletion_ledger=json.loads(encoded['deletion_ledger']))
            self.validate(data)
            if header.get('counts') != {name:len(rows) for name,rows in data['records'].items()}:
                raise ValueError('counts')
            return header, data
        except Exception:
            raise ServiceError('BACKUP_CORRUPT', '快照结构或来源关系校验失败。', '保留原备份，选择完整的有效快照；活动数据库没有改变。')
        finally:
            connection.close()

    @staticmethod
    def validate(data):
        character = text(data['character_id'], 200)
        records = data['records']
        if not isinstance(data['deletion_ledger'],list) or len(encode(data).encode('utf-8')) > MAX_BYTES:
            raise ValueError('payload')
        total = 0
        for name, columns in COLUMNS.items():
            rows = records[name]
            if not isinstance(rows, list):
                raise ValueError('rows')
            total += len(rows)
            if total > 100000:
                raise ValueError('count')
            for row in rows:
                if not isinstance(row, dict) or set(row) != set(columns):
                    raise ValueError('columns')
                if 'character' in row and row['character'] != character:
                    raise ValueError('character')
        memories = {row['id']: row for row in records['memories']}
        if len(memories) != len(records['memories']):
            raise ValueError('duplicate memory')
        for row in memories.values():
            text(row['id'], 200); text(row['scope'], 650); text(row['principal'], 200)
            integer(row['revision'], 1, 2**53 - 1)
            if not isinstance(row['statement'], str) or len(row['statement']) > 12000 or row['status'] not in ('active','suspended','invalidated','deleted') or type(row['pinned']) is not int or row['pinned'] not in (0,1):
                raise ValueError('memory')
            if row['kind'] not in ('episode','legacy_summary','identity','preference','interest','project','relationship','guideline','relationship_projection'):
                raise ValueError('kind')
            if row['status'] == 'deleted' and (row['statement'] or row['sources'] != '[]' or row['derived'] != '[]'):
                raise ValueError('deleted body')
            for field in ('event_hash','content_hash'):
                if not isinstance(row[field], str) or not re.fullmatch('[0-9a-f]{64}', row[field]):
                    raise ValueError('hash')
            sources, derived = json.loads(row['sources']), json.loads(row['derived'])
            if not isinstance(sources, list) or len(sources) > 50 or any(not isinstance(ref,str) or len(ref)>1000 for ref in sources):
                raise ValueError('refs')
            if not isinstance(derived, list) or len(derived) > 50 or any(source not in memories or source == row['id'] for source in derived):
                raise ValueError('derived')
        # Iterative dependency validation rejects cycles without Python recursion depth dependence.
        incoming, children = {}, {}
        for identifier,row in memories.items():
            dependencies = set(json.loads(row['derived']))
            incoming[identifier] = len(dependencies)
            for dependency in dependencies:
                children.setdefault(dependency,[]).append(identifier)
        ready = [identifier for identifier,count in incoming.items() if not count]
        visited = 0
        while ready:
            visited += 1
            for child in children.get(ready.pop(),()):
                incoming[child] -= 1
                if not incoming[child]:
                    ready.append(child)
        if visited != len(memories):
            raise ValueError('cycle')
        for row in records['revisions']:
            if row['memory'] not in memories or memories[row['memory']]['status'] == 'deleted' or not isinstance(row['statement'], str) or len(row['statement']) > 12000:
                raise ValueError('revision')
            integer(row['revision'],1,memories[row['memory']]['revision']); text(row['actor'],100)
        if any(not isinstance(row,dict) or set(row) != {'character','kind','digest'} for row in data['deletion_ledger']):
            raise ValueError('ledger fields')
        for row in records['fingerprints'] + records['tombstones'] + data['deletion_ledger']:
            if row.get('character') != character or row.get('kind') not in ('event','source','content') or not isinstance(row.get('digest'),str) or not re.fullmatch('[0-9a-f]{64}',row['digest']):
                raise ValueError('fingerprint')
            if 'memory' in row and row['memory'] not in memories:
                raise ValueError('fingerprint owner')
        fingerprints = {}
        for row in records['fingerprints']:
            fingerprints.setdefault(row['memory'],set()).add((row['kind'],row['digest']))
        for row in memories.values():
            required = {('event',row['event_hash']),('content',row['content_hash'])}
            if row['statement']:
                required.add(('content',hashlib.sha256(row['statement'].encode('utf-8')).hexdigest()))
            required.update(('source',hashlib.sha256(ref.encode('utf-8')).hexdigest()) for ref in json.loads(row['sources']))
            if not required <= fingerprints.get(row['id'],set()):
                raise ValueError('missing deletion fingerprints')
        for row in records['revisions']:
            if ('content',hashlib.sha256(row['statement'].encode('utf-8')).hexdigest()) not in fingerprints.get(row['memory'],set()):
                raise ValueError('missing revision fingerprint')
        for row in records['record_source_revisions']:
            if row['memory'] not in memories or row['source'] not in json.loads(memories[row['memory']]['derived']):
                raise ValueError('proof')
            integer(row['revision'],1,2**53-1)
        for row in records['episode_consumption']:
            if row['episode'] not in memories:
                raise ValueError('consumption')
            integer(row['revision'],1,2**53-1); text(row['scope'],650); text(row['proposal'],200)

    def collect(self, character):
        records = {}
        for name in COLUMNS:
            if name in ('revisions','record_source_revisions'):
                query = f'SELECT t.* FROM {name} t JOIN memories m ON t.memory=m.id WHERE m.character=?'
            else:
                query = f'SELECT * FROM {name} WHERE character=?'
            records[name] = [dict(row) for row in self.db.execute(query, (character,))]
        return dict(character_id=character, records=records,
                    deletion_ledger=[dict(row) for row in self.db.execute('SELECT * FROM sovereignty.tombstones WHERE character=?', (character,))])

    def ledger_instance(self):
        return self.db.execute("SELECT value FROM sovereignty.metadata WHERE key='instance'").fetchone()[0]

    def acknowledged(self, character):
        return bool(self.db.execute('''SELECT 1 FROM recovery_reviews r JOIN recovery_current a
            ON a.character=r.character AND a.restore_id=r.restore_id AND a.snapshot_digest=r.snapshot_digest
            WHERE r.character=? AND r.ledger_instance=? AND a.ledger_instance=?''',
            (character,self.ledger_instance(),self.ledger_instance())).fetchone())

    def trusted_lineage(self, lineage, character):
        meta = dict(self.db.execute('SELECT key,value FROM sovereignty.metadata').fetchall())
        return meta.get('lineage') == lineage and (meta.get('trusted') == '1' or self.acknowledged(character))

    def trusted_backup(self, header, character):
        registered = self.db.execute('SELECT sha256,lineage FROM sovereignty.backups WHERE id=? AND character=?',(header['backup_id'],character)).fetchone()
        file = self.owned('backups',header['backup_id'],'.db')
        return bool(not header.get('source_requires_review',False) and registered and self.trusted_lineage(header['lineage'],character)
                    and registered['lineage']==header['lineage'] and file.is_file() and registered['sha256']==file_digest(file))

    def review_digest(self, character, restore_id, snapshot_digest):
        return hashlib.sha256(encode(dict(character=character,restore_id=restore_id,snapshot_digest=snapshot_digest,
            memory_epoch=self.service.epoch(character),ledger_instance=self.ledger_instance())).encode('utf-8')).hexdigest()

    def review_proof(self, character, row, params):
        expected = self.review_digest(character,row['id'],row['digest'])
        if params.get('review_digest') != expected:
            raise ServiceError('VERSION_CONFLICT','恢复复审摘要与当前角色、快照、版本或删除记录实例不匹配。','刷新恢复状态，核对当前内容后重新明确确认。')

    def paused(self, character):
        row = self.db.execute('SELECT paused FROM recovery_state WHERE character=?',(character,)).fetchone()
        return bool(row and row[0])

    def recovery_status(self, character):
        current = self.db.execute('SELECT * FROM recovery_current WHERE character=?',(character,)).fetchone()
        paused = self.paused(character)
        restore_id = current['restore_id'] if current else None
        return dict(restore_id=restore_id,status=('committed_paused' if paused else 'committed') if current else ('paused' if paused else 'idle'),
                    requires_review=paused,memory_epoch=self.service.epoch(character),snapshot_digest=current['snapshot_digest'] if current else None,
                    ledger_instance=self.ledger_instance(),review_digest=self.review_digest(character,restore_id,current['snapshot_digest']) if current else None)

    def approve_current(self, character, row, expected):
        instance = self.ledger_instance()
        self.db.execute("UPDATE recovery_state SET paused=0,reason='' WHERE character=?",(character,))
        self.db.execute('UPDATE recovery_current SET ledger_instance=? WHERE character=?',(instance,character))
        self.db.execute('INSERT OR REPLACE INTO recovery_reviews VALUES(?,?,?,?,?)',(character,row['id'],row['digest'],instance,expected))
        self.db.execute("UPDATE restore_stages SET status='committed' WHERE id=?",(row['id'],))

    def open_backup(self, identifier, password):
        manifest_path = self.owned('backups', identifier, '.json')
        file = self.owned('backups', identifier, '.db')
        try:
            if not manifest_path.is_file() or manifest_path.stat().st_size > 64000:
                raise ValueError('manifest')
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            if manifest['format_version'] != 1 or manifest['backup_id'] != identifier or manifest['kdf'] != KDF or not re.fullmatch('[0-9a-f]{32}', manifest['salt']):
                raise ValueError('format')
            if not file.is_file() or file.stat().st_size != manifest['bytes'] or file_digest(file) != manifest['sha256']:
                raise ValueError('hash')
        except Exception:
            raise ServiceError('BACKUP_CORRUPT', '备份清单或文件哈希校验失败。', '使用未损坏的备份；活动数据库没有改变。')
        key = self.key(password, manifest['salt'])
        header, data = self.read(file, key)
        if dict(manifest, sha256=None, bytes=None) != dict(header, sha256=None, bytes=None):
            raise ServiceError('BACKUP_CORRUPT', '加密清单与外部清单不一致。')
        return header, data

    def dispatch(self, operation, session, params):
        self.service.management(session)
        character = session['character']
        if operation == 'backup.recovery.status':
            return self.recovery_status(character)
        if operation == 'backup.create':
            identifier, salt = uuid.uuid4().hex, os.urandom(16).hex()
            key = self.key(params.get('password'), salt)
            data = self.collect(character)
            self.validate(data)
            header = dict(format_version=1, backup_id=identifier, salt=salt, kdf=KDF,
                          lineage=self.db.execute("SELECT value FROM sovereignty.metadata WHERE key='lineage'").fetchone()[0],
                          created_at=self.service.clock(), counts={name:len(rows) for name,rows in data['records'].items()},
                          source_requires_review=self.paused(character))
            file = self.owned('backups', identifier, '.db')
            self.write(file, key, header, data)
            manifest = dict(header, sha256=file_digest(file), bytes=file.stat().st_size)
            manifest_path = self.owned('backups', identifier, '.json')
            with manifest_path.open('x', encoding='utf-8') as stream:
                stream.write(encode(manifest)); stream.flush(); os.fsync(stream.fileno())
            self.db.execute('INSERT INTO sovereignty.backups VALUES(?,?,?,?)',(identifier,character,manifest['sha256'],header['lineage']))
            return dict(backup_id=identifier, manifest=manifest, includes_keys=False, includes_authorizations=False)
        if operation in ('backup.inspect','backup.restore.stage'):
            header, data = self.open_backup(params.get('backup_id'), params.get('password'))
            if data['character_id'] != character:
                raise ServiceError('CHARACTER_MISMATCH', '备份属于另一个角色 ID。', '切换到备份中的角色 ID；不自动合并角色。')
            review = not self.trusted_backup(header,character)
            if operation == 'backup.inspect':
                offset = integer(params.get('offset',0),0,100000)
                limit = integer(params.get('limit',20),1,20)
                proofs = {}
                for proof in data['records']['record_source_revisions']:
                    proofs.setdefault(proof['memory'],{})[proof['source']] = proof['revision']
                preview = []
                for row in data['records']['memories'][offset:offset+limit]:
                    record = dict(self.service.record(row),source_revisions=proofs.get(row['id'],{}))
                    if len(encode(preview+[record]).encode('utf-8')) > 2 * 1024 * 1024:
                        break
                    preview.append(record)
                return dict(character_id=character, counts=header['counts'], requires_review=review,
                            preview=preview,next_offset=offset+len(preview),
                            index='rebuild_on_restore', includes_keys=False, includes_authorizations=False)
            identifier = uuid.uuid4().hex
            path = self.owned('restore-staging', identifier, '.db')
            self.write(path, self.store._key, header, data)
            base = self.service.epoch(character)
            self.db.execute('INSERT INTO restore_stages VALUES(?,?,?,?,?,?,?)',
                            (identifier,character,base,'staged',int(review),file_digest(path),encode(header)))
            return dict(restore_id=identifier, base_memory_epoch=base, requires_review=review, status='staged',snapshot_digest=file_digest(path),
                        ledger_instance=self.ledger_instance(),review_digest=self.review_digest(character,identifier,file_digest(path)))
        identifier = text(params.get('restore_id'), 200)
        row = self.db.execute('SELECT * FROM restore_stages WHERE id=? AND character=?', (identifier,character)).fetchone()
        if not row:
            raise ServiceError('NOT_FOUND','隔离恢复任务不存在。')
        if operation == 'backup.restore.cancel':
            if row['status'] not in ('staged','cancelled'):
                raise ServiceError('VERSION_CONFLICT','已经提交的恢复不能作为待处理任务取消。')
            self.db.execute("UPDATE restore_stages SET status='cancelled' WHERE id=?",(identifier,))
            return dict(restore_id=identifier,status='cancelled',active_unchanged=True)
        if operation != 'backup.restore.commit':
            raise ServiceError('INVALID_REQUEST','未知备份操作。')
        if type(params.get('review',False)) is not bool:
            raise ServiceError('INVALID_REQUEST','review 必须为明确布尔值。')
        expected = params.get('expected_memory_epoch')
        if type(expected) is not int or expected != self.service.epoch(character):
            raise ServiceError('VERSION_CONFLICT','恢复提交的记忆版本已改变。','重新核对活动库并创建新的隔离恢复任务。')
        if row['status'] in ('committed','committed_paused'):
            current=self.db.execute('SELECT * FROM recovery_current WHERE character=?',(character,)).fetchone()
            if not current or current['restore_id'] != identifier or current['snapshot_digest'] != row['digest']:
                raise ServiceError('VERSION_CONFLICT','这个恢复任务已经不是当前角色的活动恢复。','刷新恢复状态，不能用旧任务批准另一份恢复内容。')
            if not params.get('review',False):
                status='committed_paused' if self.paused(character) else 'committed'
                return dict(restore_id=identifier,status=status,requires_review=self.paused(character),duplicate=True,memory_epoch=self.service.epoch(character))
            self.review_proof(character,row,params)
            path=self.owned('restore-staging',identifier,'.db')
            if not path.is_file() or file_digest(path) != row['digest']:
                raise ServiceError('BACKUP_CORRUPT','待复审的快照摘要已经改变。')
            if not self.paused(character):
                return dict(restore_id=identifier,status='committed',duplicate=True,memory_epoch=self.service.epoch(character))
            self.approve_current(character,row,expected)
            epoch = self.service.bump(character)
            self.retire(character)
            return dict(restore_id=identifier,status='committed',reviewed=True,memory_epoch=epoch,character_invalidated=True)
        if row['status'] != 'staged' or row['base_epoch'] != expected:
            raise ServiceError('VERSION_CONFLICT','恢复任务已取消或隔离后活动库发生变化。')
        path = self.owned('restore-staging',identifier,'.db')
        if not path.is_file() or file_digest(path) != row['digest']:
            raise ServiceError('BACKUP_CORRUPT','隔离恢复文件被改变。')
        header,data = self.read(path,self.store._key)
        if encode(header) != row['header'] or data['character_id'] != character:
            raise ServiceError('BACKUP_CORRUPT','隔离恢复身份不一致。')
        # A stage's trust observation is stale after authority loss/replacement.
        review_required = not self.trusted_backup(header,character)
        if params.get('review',False):
            self.review_proof(character,row,params)
        # Preserve current tombstones independently of snapshot age and replacement order.
        self.db.execute('INSERT OR IGNORE INTO sovereignty.tombstones SELECT * FROM tombstones WHERE character=?',(character,))
        self.db.executemany('INSERT OR IGNORE INTO sovereignty.tombstones VALUES(?,?,?)',
                            [(value['character'],value['kind'],value['digest']) for value in data['deletion_ledger']])
        for table in ('record_source_revisions','revisions','memory_terms'):
            self.db.execute(f'DELETE FROM {table} WHERE memory IN (SELECT id FROM memories WHERE character=?)',(character,))
        for table in ('fingerprints','episode_consumption','memory_proposals','memories'):
            self.db.execute(f'DELETE FROM {table} WHERE character=?',(character,))
        for table,columns in COLUMNS.items():
            placeholders = ','.join('?' for _ in columns)
            for value in data['records'][table]:
                if table == 'memories' and self.db.execute('SELECT 1 FROM memories WHERE id=?',(value['id'],)).fetchone():
                    raise ServiceError('VERSION_CONFLICT','快照记录 ID 与其他角色冲突。')
                self.db.execute(f'INSERT OR IGNORE INTO {table} ({",".join(columns)}) VALUES({placeholders})',[value[name] for name in columns])
        self.db.execute('INSERT OR IGNORE INTO tombstones SELECT * FROM sovereignty.tombstones WHERE character=?',(character,))
        victims = self.db.execute('SELECT DISTINCT f.memory FROM fingerprints f JOIN tombstones t ON t.character=f.character AND t.kind=f.kind AND t.digest=f.digest WHERE f.character=?',(character,)).fetchall()
        for victim in victims:
            self.service.delete_tree(character,victim[0])
        self.service.governance.rebuild(character)
        needs_review = review_required and not params.get('review',False)
        self.db.execute('INSERT OR REPLACE INTO recovery_state VALUES(?,?,?)',(character,int(needs_review),'missing_latest_source_ledger' if needs_review else ''))
        status = 'committed_paused' if needs_review else 'committed'
        self.db.execute('UPDATE restore_stages SET status=? WHERE id=?',(status,identifier))
        self.db.execute('INSERT OR REPLACE INTO recovery_current VALUES(?,?,?,?)',(character,identifier,row['digest'],self.ledger_instance()))
        if params.get('review',False):
            self.approve_current(character,row,expected)
        epoch = self.service.bump(character)
        self.retire(character)
        return dict(restore_id=identifier,status=status,requires_review=needs_review,memory_epoch=epoch,character_invalidated=True,
                    index='deterministic_keywords_v1',keys_migrated=False,authorizations_migrated=False)

    def retire(self,character):
        recover_reservations(self.db,character)
        self.service.tools.retire(character)
        def after_commit():
            self.service.bindings = {key:value for key,value in self.service.bindings.items() if value['character'] != character}
            self.service.active.pop(character,None)
        self.service.after_commit.append(after_commit)
