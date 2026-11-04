import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CapabilitySupervisor, CapabilityError } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createManagementHandler } from '../plugins/surfcore/lib/local-capabilities/management.js';
import { isLoopbackReq, json, sameOrigin } from '../plugins/surfcore/lib/http-guard.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, '.local/integration-tests', 'management-' + crypto.randomUUID());
const secret = 'synthetic-backup-passphrase';
const magic = Buffer.from('SURFCORE-MEMORY1\n');
const resources = [];
// Execute the actual host route wrapper, without starting the rest of DSH.
const hostSource = fs.readFileSync(path.join(repo, 'plugins/surfcore/lib/index.js'), 'utf8');
const routeStart = hostSource.indexOf('  function route(kind, pathname, handler) {');
const routeEnd = hostSource.indexOf('\n  const local = localCapabilities();', routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart);
const routeSource = hostSource.slice(routeStart, routeEnd);
let count = 0;
async function check(name, action) { await action(); console.log(`ok ${++count} ${name}`); }
async function fixture(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(directory, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
  const local = new LocalCapabilities({ supervisor, stateFile: path.join(directory, 'backend.json'), currentCharacter: () => ({ id: 'synthetic-role', epoch: 1 }) });
  const mount = '/dsh-surfcore/local-capabilities';
  const handler = createManagementHandler({ capabilities: local, base: mount });
  const routes = new Map();
  const route = vm.runInNewContext(`(${routeSource.trim()})`, {
    disposers: [], isLoopbackReq, json, sameOrigin, pluginLog: () => {},
    ctx: { webServer: { register({ path, handler }) { routes.set(path, handler); return () => {}; } },
      get: () => ({ requestRejection: req => req.headers['x-test-dsh-session'] === 'synthetic-host-session' ? false : 401 }) },
  });
  for (const suffix of ['', '/tools', '/semantic', '/api', '/backup/import', '/backup/download']) route('exact', mount + suffix, handler);
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
    if (handler) void handler(req, res); else { res.statusCode = 404; res.end(); }
  });
  resources.push({ supervisor, server });
  await local.setMode('local');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + mount, { headers: { 'x-test-dsh-session': 'synthetic-host-session' } });
  const html = await page.text();
  const token = html.match(/const token='([a-f0-9]+)'/)[1];
  const headers = { origin: base, cookie: page.headers.get('set-cookie').split(';')[0], 'x-surfcore-session': token, 'x-test-dsh-session': 'synthetic-host-session' };
  const post = (suffix, body, type = 'application/json', override = {}) => fetch(base + mount + suffix, { method: 'POST', headers: { ...headers, 'content-type': type, ...override }, body: type === 'application/json' ? JSON.stringify(body) : body });
  const call = async (op, params = {}) => (await post('/api', { op, params })).json();
  return { local, supervisor, directory, base, html, headers, post, call };
}

try {
  const a = await fixture('source'), b = await fixture('target');
  await check('attention page reads the authoritative status without defaults or cancellation', async () => {
    let cancellations = 0; a.local.onAttentionChange = () => { cancellations++; };
    const params = { enabled: false, daily_limit: 4, cooldown_seconds: 5400, quiet_start: '23:30', quiet_end: '08:30' };
    const saved = await a.call('attention.configure', params); assert.equal(saved.ok, true); assert.equal(cancellations, 1);
    const status = await a.call('attention.status'); assert.equal(status.ok, true);
    for (const [key, value] of Object.entries(params)) assert.equal(status.result.config[key], value);
    assert.equal(cancellations, 1);
    assert.equal((await a.call('attention.configure', {})).ok, true); assert.equal(cancellations, 1);
    assert.match(a.html, /call\('attention.status'\)/); assert.doesNotMatch(a.html, /call\('attention.configure'\)/);
    assert.match(a.html, /<fieldset id="attentioncontrols" disabled>/);
    assert.doesNotMatch(a.html.match(/<input id="daily"[^>]+>/)[0], /value=/);
    assert.doesNotMatch(a.html.match(/<input id="cooldown"[^>]+>/)[0], /value=/);
    assert.match(a.html, /\$\('attentioncontrols'\)\.disabled=false/);
  });
  await check('semantic page and management operations retain real host authentication and scoped binding', async () => {
    const url = a.base + '/dsh-surfcore/local-capabilities/semantic';
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { 'x-test-dsh-session': 'synthetic-host-session' } });
    assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /mountSemanticManagement/); assert.doesNotMatch(html, /__SEMANTIC_CLIENT__|__API_BASE__|__SESSION_TOKEN__/);
    assert.match(a.html, /\/semantic/);
    const token = html.match(/token:'([a-f0-9]+)'/)[1];
    const override = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-surfcore-session': token };
    const request = async (op, params = {}) => (await a.post('/api', { op, params }, 'application/json', override)).json();
    assert.equal((await request('memory.semantic.status')).result.enabled, false);
    assert.equal((await request('memory.semantic.configure', { enabled: true })).ok, true);
    const empty = await request('memory.semantic.query.start', { query: '', audience: 'session' });
    assert.equal(empty.result.state, 'succeeded'); assert.equal(empty.result.search_mode, 'recent');
    assert.equal((await request('memory.semantic.job.status', { job_id: empty.result.job_id })).ok, true);
    assert.equal((await a.post('/api', { op: 'memory.semantic.configure', params: { enabled: false } }, 'application/json', { ...override, origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await request('memory.semantic.configure', { enabled: false })).ok, true);
    const ctx = await a.local.context({ kind: 'pet' }, 'disabled semantic query');
    assert.equal(ctx.retrieval.reason, 'semantic_disabled');
  });
  await check('tools page uses the host session and an independent management session', async () => {
    const url = a.base + '/dsh-surfcore/local-capabilities/tools';
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { 'x-test-dsh-session': 'synthetic-host-session' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /mountToolsManagement/);
    assert.match(html, /本机工具与权限/);
    assert.doesNotMatch(html, /__TOOLS_CLIENT__|__API_BASE__|__SESSION_TOKEN__/);
    const token = html.match(/token:'([a-f0-9]+)'/)[1];
    assert.notEqual(token, a.headers['x-surfcore-session']);
    const reply = await a.post('/api', { op: 'tool.catalog' }, 'application/json', {
      cookie: response.headers.get('set-cookie').split(';')[0], 'x-surfcore-session': token,
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).ok, true);
  });
  await check('browser cannot invoke trusted tool preparation execution or export delivery', async () => {
    for (const op of ['tool.propose', 'tool.execute', 'tool.destinations.register', 'tool.destinations.revoke',
      'tool.result.export.prepare', 'tool.result.export.consume', 'tool.result.export.validate', 'tool.result.export.finalize']) {
      const result = await a.call(op, {});
      assert.equal(result.ok, false, op);
      assert.equal(result.code, 'PERMISSION_DENIED', op);
      assert.ok(result.error && result.hint, op);
    }
  });
  await check('writer UI reports unavailable configuration and keeps actions on the host queue', async () => {
    const missing = await a.call('writer.status');
    assert.equal(missing.code, 'SERVICE_UNAVAILABLE'); assert.ok(missing.error && missing.hint);
    const calls = [];
    a.local.semanticWriter = { status: () => ({ configured: true, queued: 1, foreground: 1 }),
      flush: async scope => { calls.push(scope); throw new CapabilityError('WRITER_FOREGROUND_BUSY', '普通聊天进行中。', '等待聊天完成。'); } };
    try {
      assert.equal((await a.call('writer.status')).result.queued, 1);
      assert.equal((await a.call('writer.run', { text: 'not-an-episode' })).code, 'INVALID_REQUEST');
      assert.equal((await a.call('writer.run', { scopeId: '../foreign' })).code, 'INVALID_REQUEST');
      assert.equal((await a.post('/api', { op: 'writer.run' }, 'application/json', { 'x-surfcore-session': 'wrong' })).status, 403);
      assert.equal(calls.length, 0);
      const busy = await a.call('writer.run');
      assert.equal(busy.code, 'WRITER_FOREGROUND_BUSY'); assert.ok(busy.error && busy.hint);
      assert.deepEqual(calls, [null]);
    } finally { a.local.semanticWriter = null; }
  });
  const c = await a.local.context({ kind: 'pet' });
  await a.local.ingest(c, 'synthetic-episode', '只供隔离管理测试的蓝色风筝');
  const created = await a.call('backup.create', { password: secret });
  assert.equal(created.ok, true);
  const id = created.result.backup_id;
  let bundle;
  await check('download authenticates management session and exact origin', async () => {
    for (const headers of [{ 'x-surfcore-session': 'wrong' }, { origin: 'https://foreign.invalid' }]) {
      const denied = await a.post('/backup/download', { backup_id: id, password: secret }, 'application/json', headers);
      assert.equal(denied.status, 403);
      const failure = await denied.json();
      assert.ok(failure.error);
      if (headers['x-surfcore-session']) assert.equal(failure.code, 'PERMISSION_DENIED');
    }
  });
  await check('wrong password does not yield a download', async () => {
    const denied = await a.post('/backup/download', { backup_id: id, password: 'wrong-synthetic-password' });
    assert.equal((await denied.json()).code, 'BACKUP_AUTH_FAILED');
  });
  await check('download contains only envelope and password encrypted snapshot', async () => {
    const response = await a.post('/backup/download', { backup_id: id, password: secret });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /\.scmemory/);
    bundle = Buffer.from(await response.arrayBuffer());
    assert.ok(bundle.subarray(0, magic.length).equals(magic));
    assert.equal(bundle.includes(Buffer.from('只供隔离管理测试的蓝色风筝')), false);
    assert.equal(bundle.includes(Buffer.from(secret)), false);
  });
  await check('import requires authenticated octet stream, never a public upload', async () => {
    const denied = await b.post('/backup/import', bundle, 'application/octet-stream', { 'x-surfcore-session': 'wrong' });
    assert.equal(denied.status, 403);
    assert.equal((await (await b.post('/backup/import', {}, 'application/json')).json()).code, 'INVALID_REQUEST');
  });
  await check('real DSH route wrapper preserves host authentication and JSON-only sibling routes', async () => {
    for (const [override, status] of [[{ 'x-test-dsh-session': 'wrong' }, 401], [{ origin: 'https://foreign.invalid' }, 403], [{ cookie: '' }, 403]]) {
      assert.equal((await b.post('/backup/import', bundle, 'application/octet-stream', override)).status, status);
    }
    for (const suffix of ['/api', '/backup/download']) {
      assert.equal((await b.post(suffix, bundle, 'application/octet-stream')).status, 415);
    }
  });
  await check('corrupt import and traversal manifest publish no files', async () => {
    const corrupt = Buffer.from(bundle); corrupt[corrupt.length - 1] ^= 1;
    assert.equal((await (await b.post('/backup/import', corrupt, 'application/octet-stream')).json()).code, 'BACKUP_CORRUPT');
    const start = magic.length + 4;
    const size = bundle.readUInt32BE(magic.length), manifest = JSON.parse(bundle.subarray(start, start + size));
    manifest.backup_id = '../outside';
    const data = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const traversal = Buffer.concat([magic, length, data, bundle.subarray(start + size)]);
    assert.equal((await (await b.post('/backup/import', traversal, 'application/octet-stream')).json()).code, 'BACKUP_CORRUPT');
    assert.deepEqual(fs.readdirSync(path.join(b.supervisor.dataDir, 'backups')), []);
  });
  await check('valid import leaves active data unchanged and duplicate cannot overwrite', async () => {
    const first = await (await b.post('/backup/import', bundle, 'application/octet-stream')).json();
    assert.equal(first.ok, true); assert.equal(first.result.inspected, false); assert.equal(first.result.active_unchanged, true);
    assert.equal((await b.local.context({ kind: 'pet' })).text, '');
    const again = await (await b.post('/backup/import', bundle, 'application/octet-stream')).json();
    assert.equal(again.result.duplicate, true);
    assert.equal((await b.call('backup.inspect', { backup_id: id, password: secret })).result.requires_review, true);
  });
  await check('hard linked files are refused by the download transport', async () => {
    const source = path.join(a.supervisor.dataDir, 'backups', id + '.db');
    const link = path.join(a.directory, 'synthetic-hard-link.db');
    fs.linkSync(source, link);
    try { assert.equal((await (await a.post('/backup/download', { backup_id: id, password: secret })).json()).code, 'PERMISSION_DENIED'); }
    finally { fs.unlinkSync(link); }
  });
  await check('restore through management retires bindings and exposes current review', async () => {
    const before = await b.local.context({ kind: 'pet' });
    const staged = await b.call('backup.restore.stage', { backup_id: id, password: secret });
    assert.equal(staged.ok, true);
    const committed = await b.call('backup.restore.commit', { restore_id: staged.result.restore_id, expected_memory_epoch: staged.result.base_memory_epoch, review: false });
    assert.equal(committed.ok, true); assert.equal(committed.result.requires_review, true);
    assert.equal(b.local.active, null); assert.equal(b.local.bindings.size, 0); assert.equal(b.local.state.written, true);
    await assert.rejects(b.local.validate(before));
    const state = await b.call('backup.recovery.status');
    assert.equal(state.ok, true); assert.equal(state.result.restore_id, staged.result.restore_id); assert.ok(state.result.review_digest);
    const reviewed = await b.call('backup.restore.commit', { restore_id: state.result.restore_id, expected_memory_epoch: state.result.memory_epoch, review: true, review_digest: state.result.review_digest });
    assert.equal(reviewed.ok, true);
    assert.match((await b.local.context({ kind: 'pet' })).text, /蓝色风筝/);
  });
  await check('proposal submit remains outside the browser management allowlist', async () => {
    assert.equal((await a.call('memory.proposals.submit', {})).code, 'PERMISSION_DENIED');
  });
  await check('unknown restore clears cached identities without silent replay', async () => {
    await a.local.context({ kind: 'pet' });
    const raw = a.supervisor.raw.bind(a.supervisor);
    a.supervisor.raw = async (op, ...args) => { if (op === 'backup.restore.commit') throw new Error('synthetic lost response'); return raw(op, ...args); };
    try { await assert.rejects(a.local.management('backup.restore.commit', {})); }
    finally { a.supervisor.raw = raw; }
    assert.equal(a.local.active, null); assert.equal(a.local.bindings.size, 0); assert.equal(a.local.state.written, true);
  });
  await check('management UI provides explicit restore and review with no password persistence', () => {
    assert.match(a.html, /确认恢复记忆/); assert.match(a.html, /确认本次复审/); assert.match(a.html, /review_digest:request\.review_digest/);
    assert.match(a.html, /type="password"/); assert.doesNotMatch(a.html, /localStorage|sessionStorage/);
  });
  console.log(`PASS ${count} management and encrypted transfer checks; synthetic stores: ${root}`);
} finally {
  for (const { server, supervisor } of resources) { server.closeAllConnections?.(); server.close(); await supervisor.stop(); }
}
