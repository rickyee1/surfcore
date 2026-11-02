"""Exclusive SQLCipher store. Never import sqlite3 or downgrade encryption."""
import ctypes
import os
import re
import uuid
from pathlib import Path


class ServiceError(Exception):
    def __init__(self, code, error, hint="请检查本地能力设置后重试。"):
        self.code, self.error, self.hint = code, error, hint
        super().__init__(error)


def dpapi(data, protect):
    if os.name != "nt":
        raise ServiceError("KEY_UNAVAILABLE", "当前平台没有 DPAPI。", "Windows 使用当前用户密钥；测试可显式设置 SURFCORE_LOCAL_KEY。")
    class Blob(ctypes.Structure):
        _fields_ = [("size", ctypes.c_ulong), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    api = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    if not api(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise ServiceError("KEY_UNAVAILABLE", "DPAPI 密钥保护失败。", "请用创建数据库的 Windows 用户运行，保留原密钥文件。")
    try:
        return ctypes.string_at(outgoing.data, outgoing.size)
    finally:
        ctypes.windll.kernel32.LocalFree(outgoing.data)


class Store:
    def __init__(self, directory):
        self.conn = None
        self.lock = None
        root = Path(directory).resolve()
        self.directory = root
        root.mkdir(parents=True, exist_ok=True)
        try:
            self.lock = (root / "service.lock").open("a+b")
            self.lock.seek(0)
            if self.lock.read(1) == b"":
                self.lock.write(b"0")
                self.lock.flush()
            self.lock.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.close()
            raise ServiceError("DATA_LOCKED", "数据目录被另一能力服务占用。", "停止旧能力服务后重试；不要删除数据库或密钥。")
        try:
            db = root / "memory.db"
            keyfile = root / "key.dpapi"
            configured = os.environ.get("SURFCORE_LOCAL_KEY")
            if configured is not None:
                if not re.fullmatch(r"[0-9a-fA-F]{64}", configured):
                    raise ServiceError("KEY_UNAVAILABLE", "配置的数据库密钥格式不正确。")
                key = bytes.fromhex(configured)
            elif keyfile.exists():
                key = dpapi(keyfile.read_bytes(), False)
            elif db.exists():
                raise ServiceError("KEY_UNAVAILABLE", "已有数据库的密钥文件缺失。", "恢复原 key.dpapi；不会新建空库或明文库。")
            else:
                key = os.urandom(32)
                protected = dpapi(key, True)
                with keyfile.open("xb") as output:
                    output.write(protected)
                    output.flush()
                    os.fsync(output.fileno())
            if len(key) != 32:
                raise ServiceError("KEY_UNAVAILABLE", "数据库密钥长度不正确。")
            header = b""
            if db.exists():
                with db.open("rb") as existing:
                    header = existing.read(16)
            if header == b"SQLite format 3\x00":
                raise ServiceError("KEY_UNAVAILABLE", "拒绝打开明文数据库。", "保留原文件，使用隔离迁移流程。")
            try:
                from sqlcipher3 import dbapi2
            except ImportError:
                raise ServiceError("SERVICE_UNAVAILABLE", "缺少 SQLCipher 驱动。", "在独立环境安装 requirements.txt；禁止明文回退。")
            self.conn = dbapi2.connect(str(db), isolation_level=None)
            self.conn.row_factory = dbapi2.Row
            self.conn.execute(f'PRAGMA key = "x\'{key.hex()}\'"')
            if not self.conn.execute("PRAGMA cipher_version").fetchone():
                raise ServiceError("SERVICE_UNAVAILABLE", "驱动未提供 SQLCipher。")
            self.conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            self.conn.execute("PRAGMA journal_mode=DELETE")
            self.conn.execute("PRAGMA secure_delete=ON")
            self.conn.executescript(SCHEMA)
            self._key = key
            # Independent append-only deletion authority is never replaced by restore.
            prior_lineage = self.conn.execute("SELECT value FROM store_metadata WHERE key='lineage'").fetchone()
            lineage = prior_lineage[0] if prior_lineage else uuid.uuid4().hex
            self.conn.execute('ATTACH DATABASE ? AS sovereignty KEY "x\'' + key.hex() + '\'"', (str(root / "sovereignty.db"),))
            self.conn.execute("PRAGMA sovereignty.journal_mode=DELETE")
            self.conn.executescript("""
                CREATE TABLE IF NOT EXISTS sovereignty.metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sovereignty.tombstones(character TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(character,kind,digest));
                CREATE TABLE IF NOT EXISTS sovereignty.backups(id TEXT PRIMARY KEY,character TEXT NOT NULL,sha256 TEXT NOT NULL,lineage TEXT NOT NULL);
            """)
            ledger_lineage = self.conn.execute("SELECT value FROM sovereignty.metadata WHERE key='lineage'").fetchone()
            if ledger_lineage and ledger_lineage[0] != lineage:
                raise ServiceError("KEY_UNAVAILABLE", "删除记录与活动库身份不匹配。", "保留两份文件，使用隔离恢复流程核对。")
            self.conn.execute("INSERT OR IGNORE INTO store_metadata VALUES('lineage',?)", (lineage,))
            self.conn.execute("INSERT OR IGNORE INTO sovereignty.metadata VALUES('lineage',?)", (lineage,))
            self.conn.execute("INSERT OR IGNORE INTO sovereignty.metadata VALUES('instance',?)", (uuid.uuid4().hex,))
            self.conn.execute("INSERT OR IGNORE INTO sovereignty.metadata VALUES('trusted',?)", ('0' if prior_lineage else '1',))
            self.conn.execute("INSERT OR IGNORE INTO sovereignty.tombstones SELECT * FROM main.tombstones")
            self.conn.execute("INSERT OR IGNORE INTO main.tombstones SELECT * FROM sovereignty.tombstones")
            if self.conn.execute("SELECT value FROM sovereignty.metadata WHERE key='trusted'").fetchone()[0] != '1':
                instance = self.conn.execute("SELECT value FROM sovereignty.metadata WHERE key='instance'").fetchone()[0]
                self.conn.execute("""INSERT OR REPLACE INTO recovery_state
                    SELECT c.id,1,'deletion_ledger_missing' FROM characters c WHERE NOT EXISTS (
                      SELECT 1 FROM recovery_reviews r JOIN recovery_current a ON a.character=r.character
                      AND a.restore_id=r.restore_id AND a.snapshot_digest=r.snapshot_digest
                      WHERE r.character=c.id AND r.ledger_instance=? AND a.ledger_instance=?)""",(instance,instance))
            # A crashed or closed sender may already have delivered. Never release it on restart.
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                recover_reservations(self.conn)
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
        except ServiceError:
            self.close()
            raise
        except Exception:
            self.close()
            raise ServiceError("KEY_UNAVAILABLE", "加密数据库无法打开。", "核对原密钥和数据库；不要覆盖或重建。")

    def close(self):
        if self.conn is not None:
            self.conn.close()
            self.conn = None
        if self.lock is not None:
            self.lock.close()
            self.lock = None


SCHEMA = """
CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY, memory_epoch INTEGER NOT NULL DEFAULT 0, auto_write INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_state(character TEXT PRIMARY KEY,paused INTEGER NOT NULL,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_current(character TEXT PRIMARY KEY,restore_id TEXT NOT NULL,snapshot_digest TEXT NOT NULL,ledger_instance TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_reviews(character TEXT PRIMARY KEY,restore_id TEXT NOT NULL,snapshot_digest TEXT NOT NULL,ledger_instance TEXT NOT NULL,approved_epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, character TEXT NOT NULL, scope TEXT NOT NULL, principal TEXT NOT NULL,
 statement TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, pinned INTEGER NOT NULL,
 event_hash TEXT NOT NULL, content_hash TEXT NOT NULL, sources TEXT NOT NULL, derived TEXT NOT NULL, kind TEXT NOT NULL,
 UNIQUE(character,scope,event_hash));
CREATE INDEX IF NOT EXISTS memory_audience ON memories(character,scope,status);
CREATE TABLE IF NOT EXISTS revisions(memory TEXT NOT NULL, revision INTEGER NOT NULL, statement TEXT NOT NULL, actor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fingerprints(memory TEXT NOT NULL, character TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL,
 UNIQUE(memory,kind,digest));
CREATE TABLE IF NOT EXISTS tombstones(character TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(character,kind,digest));
CREATE TABLE IF NOT EXISTS migrations(character TEXT NOT NULL, migration TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(character,migration));
CREATE TABLE IF NOT EXISTS attention(character TEXT PRIMARY KEY, config TEXT NOT NULL, unanswered INTEGER NOT NULL DEFAULT 0, intensity REAL NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS outreach(character TEXT NOT NULL, id TEXT NOT NULL, reservation TEXT NOT NULL, binding TEXT NOT NULL,
 epoch TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL, day TEXT NOT NULL, PRIMARY KEY(character,id));
"""


def recover_reservations(connection, character=None):
    """A lost sender counts as unanswered and consumes budget, including across restart."""
    clause = " AND character=?" if character is not None else ""
    args = (character,) if character is not None else ()
    rows = connection.execute("SELECT character FROM outreach WHERE status='reserved'" + clause, args).fetchall()
    for row in rows:
        connection.execute("UPDATE attention SET unanswered=unanswered+1,intensity=CASE WHEN unanswered+1>=3 THEN max(0.25,intensity*0.5) ELSE intensity END WHERE character=?", (row[0],))
    connection.execute("UPDATE outreach SET status='unknown' WHERE status='reserved'" + clause, args)
