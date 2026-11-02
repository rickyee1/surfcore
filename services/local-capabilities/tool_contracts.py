"""Fixed T3 descriptors and bounded argument schemas; no dynamic tool registration."""
import hashlib
import json
from storage import ServiceError
from tool_paths import relative_parts


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def hashed(value):
    return hashlib.sha256(encode(value).encode('utf-8')).hexdigest()


def fail(code, message, hint='在本机工具管理页核对请求后重新发起。'):
    raise ServiceError(code, message, hint)


def bounded(value, maximum=200):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\x00' in value:
        fail('INVALID_REQUEST', '字段必须是有界非空字符串。')
    return value


def fields(params, required, optional=()):
    if not isinstance(params, dict) or not set(required) <= params.keys() or params.keys() - set(required) - set(optional):
        fail('INVALID_REQUEST', '字段不符合固定工具契约。')


SPECS = {
    'time.now': ('read', 'read', False, {}, {}),
    'files.list': ('list', 'read', False, {'root_id': 'string', 'relative_path': 'string'}, {}),
    'files.read_text': ('read', 'read', False, {'root_id': 'string', 'relative_path': 'string'}, {}),
    'notes.create': ('create', 'reversible_write', True, {'title': 'string', 'text': 'string'}, {}),
    'notes.list': ('list', 'read', False, {}, {'limit': 'integer'}),
    'notes.read': ('read', 'read', False, {'note_id': 'string'}, {}),
    'local.open_directory': ('open', 'local_action', True, {'root_id': 'string', 'relative_path': 'string'}, {}),
}


def descriptors():
    result = {}
    for tool_id, (action, risk, side_effect, required, optional) in SPECS.items():
        item = dict(tool_id=tool_id, version='1.0.0', source_id='surfcore.local.builtin', action=action,
                    risk=risk, side_effect=side_effect, cancellable=True, timeout_ms=5000,
                    output_limit_bytes=65536, max_directory_entries=200, max_relative_depth=12,
                    permission='exempt' if tool_id == 'time.now' else 'grant_or_exact_confirmation',
                    data_boundary='public' if tool_id == 'time.now' else 'local_only', schema=dict(type='object', additionalProperties=False,
                    required=list(required), properties={k: dict(type=v) for k, v in (required | optional).items()}))
        item['descriptor_hash'] = hashed(item)
        result[tool_id] = item
    return result


def validate(tool_id, action, arguments):
    if tool_id not in SPECS or action != SPECS[tool_id][0]:
        fail('TOOL_NOT_ALLOWED', '工具或动作未在首批固定白名单内。')
    required, optional = SPECS[tool_id][3:]
    fields(arguments, required, optional)
    for name, kind in (required | optional).items():
        if name not in arguments:
            continue
        value = arguments[name]
        if kind == 'integer':
            if type(value) is not int or not 1 <= value <= 100:
                fail('INVALID_REQUEST', '数量必须在 1 到 100 之间。')
        elif name == 'relative_path':
            relative_parts(value)
        else:
            bounded(value, 16000 if name == 'text' else 200)
    return json.loads(encode(arguments))


SCHEMA = """
CREATE TABLE IF NOT EXISTS tool_policy(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,closed INTEGER NOT NULL);
INSERT OR IGNORE INTO tool_policy VALUES(1,1,0);
CREATE TABLE IF NOT EXISTS tool_roots(id TEXT PRIMARY KEY,character TEXT NOT NULL,path TEXT NOT NULL,label TEXT NOT NULL,identity TEXT NOT NULL,active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tool_grants(id TEXT PRIMARY KEY,character TEXT NOT NULL,subject TEXT NOT NULL,tool TEXT NOT NULL,action TEXT NOT NULL,descriptor TEXT NOT NULL,root TEXT NOT NULL,expires REAL NOT NULL,remaining INTEGER NOT NULL,active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tool_executions(
 id TEXT PRIMARY KEY,character TEXT NOT NULL,epoch TEXT NOT NULL,subject TEXT NOT NULL,tool TEXT NOT NULL,action TEXT NOT NULL,
 idem TEXT NOT NULL,request_hash TEXT NOT NULL,arguments TEXT NOT NULL,arguments_hash TEXT NOT NULL,descriptor TEXT NOT NULL,
 target TEXT NOT NULL,confirmation_digest TEXT NOT NULL,policy_generation INTEGER NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,
 confirmed_until REAL,grant_id TEXT,started REAL,created REAL NOT NULL,result_id TEXT,error_code TEXT,
 UNIQUE(character,subject,tool,idem));
CREATE TABLE IF NOT EXISTS tool_results(id TEXT PRIMARY KEY,execution TEXT NOT NULL UNIQUE,character TEXT NOT NULL,epoch TEXT NOT NULL,policy_generation INTEGER NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tool_notes(id TEXT PRIMARY KEY,character TEXT NOT NULL,subject TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tool_destinations(id TEXT PRIMARY KEY,character TEXT NOT NULL,epoch TEXT NOT NULL,binding TEXT NOT NULL,subject TEXT NOT NULL,host_request TEXT NOT NULL,turn_id TEXT NOT NULL,descriptor TEXT NOT NULL,active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tool_exports(id TEXT PRIMARY KEY,execution TEXT NOT NULL,result TEXT NOT NULL,character TEXT NOT NULL,epoch TEXT NOT NULL,binding TEXT NOT NULL,subject TEXT NOT NULL,memory_epoch INTEGER NOT NULL,policy_generation INTEGER NOT NULL,destination_ref TEXT NOT NULL,body_hash TEXT NOT NULL,digest TEXT NOT NULL,expires REAL NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,host_request TEXT NOT NULL,turn_id TEXT NOT NULL);
"""
