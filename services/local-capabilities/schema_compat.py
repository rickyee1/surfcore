"""Forward-only reader gate. This module must run after decryption, before init writes.

The DPAPI envelope retains the SQLCipher key; it is deliberately not a rekey.
Historical readers reject the unwrapped envelope's non-32-byte length.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import uuid
from storage import ServiceError

VERSION = 1
MAGIC = b'SURFCORE-KEY-ENVELOPE1\x00'


def private(path):
    path = Path(path)
    if os.name == 'nt':
        # SID rather than localized account spelling; no configuration/secret output.
        sid = subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], text=True).strip().split(',')[-1].strip('"')
        rights = '(OI)(CI)(F)' if path.is_dir() else '(F)'
        result = subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', f'*{sid}:{rights}', f'*S-1-5-18:{rights}'], capture_output=True)
        if result.returncode:
            raise ServiceError('KEY_UNAVAILABLE', '不能限制升级文件的访问权限。', '保留原文件，修复当前用户文件权限。')
    else:
        path.chmod(0o700 if path.is_dir() else 0o600)


def regular(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ServiceError('KEY_UNAVAILABLE', '升级文件不能为链接或重解析点。')


def atomic(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('xb') as output:
        private(temporary)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    if path.exists():
        regular(path)
    os.replace(temporary, path)


def unwrap(raw):
    if len(raw) == 32:
        return raw, 0
    if len(raw) != len(MAGIC) + 4 + 32 or not raw.startswith(MAGIC):
        raise ServiceError('KEY_UNAVAILABLE', '数据库密钥封装无效。', '保留密钥与迁移记录，禁止重建空库。')
    minimum = int.from_bytes(raw[len(MAGIC):len(MAGIC) + 4], 'big')
    if minimum != VERSION:
        raise ServiceError('SCHEMA_TOO_NEW', '密钥封装需要更新的读取器。', '使用兼容版本；不能恢复旧 keyfile 绕过升级。')
    return raw[-32:], minimum


def prepare(connection, directory, keyfile, key, configured, protect, fault=lambda _: None):
    """Caller already owns service.lock and has proved the active DB decrypts."""
    version = connection.execute('PRAGMA user_version').fetchone()[0]
    if version not in (0, VERSION):
        raise ServiceError('SCHEMA_TOO_NEW', '数据库版本超出当前读取器支持范围。', '暂停并使用兼容版本；不会写入初始化或恢复旧库。')
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'store_metadata' in tables:
        row = connection.execute("SELECT value FROM store_metadata WHERE key='min_reader_schema'").fetchone()
        if row and row[0] != str(VERSION):
            raise ServiceError('SCHEMA_TOO_NEW', '数据库最小读取器版本不兼容。')
    directory, keyfile = Path(directory), Path(keyfile)
    journal = directory / 'schema-upgrade.json'
    backup = directory / 'key.pre-envelope.dpapi'
    state = dict(schema=VERSION, min_reader_schema=VERSION, phase='envelope_ready', key_backup=str(backup) if not configured else None,
                 protection='development_raw_key' if configured else 'windows_dpapi_envelope')
    if configured:
        return state
    regular(keyfile)
    raw, minimum = unwrap(protect(keyfile.read_bytes(), False))
    if raw != key:
        raise ServiceError('KEY_UNAVAILABLE', '升级期间密钥身份不一致。')
    if minimum == 0:
        if version == VERSION:
            raise ServiceError('KEY_UNAVAILABLE', '新结构与历史密钥封装不一致。', '保留证据；禁止静默重封或恢复旧库。')
        if backup.exists():
            regular(backup)
            if protect(backup.read_bytes(), False) != key:
                raise ServiceError('KEY_UNAVAILABLE', '历史密钥备份与活动库不一致。')
        else:
            with backup.open('xb') as output:
                private(backup)
                output.write(keyfile.read_bytes()); output.flush(); os.fsync(output.fileno())
        atomic(journal, json.dumps(dict(state, phase='prepared')).encode())
        fault('before_envelope')
        atomic(keyfile, protect(MAGIC + VERSION.to_bytes(4, 'big') + key, True))
        fault('after_envelope')
        atomic(journal, json.dumps(state).encode())
    elif journal.exists():
        regular(journal)
        try:
            previous = json.loads(journal.read_text())
            if previous.get('schema') != VERSION:
                raise ValueError('schema')
        except Exception:
            raise ServiceError('KEY_UNAVAILABLE', '升级记录损坏。', '保留封装密钥和数据库，暂停人工核对。') from None
    return state


def finish(connection, directory, state):
    connection.execute('BEGIN IMMEDIATE')
    try:
        connection.execute("INSERT OR REPLACE INTO store_metadata VALUES('min_reader_schema',?)", (str(VERSION),))
        connection.execute(f'PRAGMA user_version={VERSION}')
        connection.execute('COMMIT')
    except BaseException:
        connection.execute('ROLLBACK')
        raise
    if state['protection'] != 'development_raw_key':
        atomic(Path(directory) / 'schema-upgrade.json', json.dumps(dict(state, phase='complete')).encode())
