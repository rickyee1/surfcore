import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBiliDrafts, parseBiliVideo, draftErrorResult } from '../lib/bili-drafts.js';
const bvid = 'BV1xx411c7mD';
const payload = { code: 0, data: { bvid, title: '公开视频标题', owner: { name: '公开作者', mid: 'private-account-marker' }, desc: '公开简介 https://example.invalid/not-for-model', cookie: 'FAKE_COOKIE_PRIVATE', privateMemory: 'FAKE_QQ_PRIVATE' } };
const http = []; const modelCalls = []; const accessed = [];
const fetchImpl = async (url, options) => { http.push({ url, options }); return new Response(JSON.stringify(payload)); };
const llm = { stream(options) { modelCalls.push(options); return (async function* () { yield { type: 'text-delta', text: '根据简介，这个主题挺值得聊聊。' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } };
const ctx = { get(name) { accessed.push(name); if (name === 'llm') return llm; if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model', apiKey: 'FAKE_PROVIDER_SECRET' }) }; throw new Error('private/context service must not be read'); } };
let count = 0;
async function check(name, run) { await run(); console.log(`ok ${++count} ${name}`); }
const rejects = (work, code) => assert.rejects(work, error => error.code === code && Boolean(error.hint));
await check('strict full BV and canonical official link parsing', () => {
  assert.equal(parseBiliVideo(bvid), bvid);
  assert.equal(parseBiliVideo(`https://www.bilibili.com/video/${bvid}/?SESSDATA=INPUT_SECRET#ignored`), bvid);
  assert.equal(parseBiliVideo(`bilibili.com/video/${bvid}`), bvid);
  for (const input of ['BV1xx411c7mDx', 'https://b23.tv/short', `https://www.bilibili.com.evil/video/${bvid}`, `https://user:secret@www.bilibili.com/video/${bvid}`, `https://www.bilibili.com:3000/video/${bvid}`, `http://www.bilibili.com/video/${bvid}`, `https://www.bilibili.com/video/${bvid}/other`, 'x'.repeat(513), `BV1xx411c7mD\n`]) assert.throws(() => parseBiliVideo(input), error => error.code === 'BILI_VIDEO_INPUT_INVALID' && !!error.hint);
});
const service = createBiliDrafts({ ctx, fetchImpl });
await check('read uses one fixed official GET without credentials or redirects', async () => {
  const source = await service.read(`https://www.bilibili.com/video/${bvid}?cookie=INPUT_SECRET`);
  assert.deepEqual(Object.keys(source).sort(), ['author', 'bvid', 'description', 'title', 'url']);
  assert.equal(source.url, `https://www.bilibili.com/video/${bvid}`);
  const call = http[0]; assert.equal(new URL(call.url).origin, 'https://api.bilibili.com'); assert.equal(new URL(call.url).pathname, '/x/web-interface/view');
  assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.cookie, undefined); assert.equal(call.options.headers.authorization, undefined); assert.equal(call.options.body, undefined);
});
await check('generation rereads trusted metadata and never sends caller source, URLs, credentials or private context to model', async () => {
  const result = await service.generate({ bvid, source: { title: 'CLIENT_PRIVATE_SOURCE', cookie: 'CLIENT_SECRET' } });
  assert.equal(http.length, 2); assert.equal(result.source.title, payload.data.title); assert.match(result.basis, /仅依据.*标题.*简介/); assert.ok(result.draft);
  const call = modelCalls[0]; assert.equal(call.provider, 'fixture-provider'); assert.equal(call.model, 'fixture-model');
  assert.equal(call.maxTokens, 1600); assert.equal(call.reasoningEffort, 'off');
  assert.equal(call.tools, undefined); assert.equal(call.toolChoice, undefined);
  const encoded = JSON.stringify(call);
  for (const forbidden of ['CLIENT_PRIVATE_SOURCE', 'CLIENT_SECRET', 'FAKE_COOKIE_PRIVATE', 'FAKE_QQ_PRIVATE', 'FAKE_PROVIDER_SECRET', 'private-account-marker', 'INPUT_SECRET', 'bilibili.com', 'example.invalid']) assert.ok(!encoded.includes(forbidden), forbidden);
  assert.deepEqual([...new Set(accessed)].sort(), ['agentDefaultModel', 'llm']);
});
await check('input is rejected before HTTP and generated output/material are bounded', async () => {
  await rejects(service.generate({ bvid: 'https://evil.invalid/' }), 'BILI_VIDEO_INPUT_INVALID'); assert.equal(http.length, 2);
  const large = createBiliDrafts({ ctx: { get(name) { return name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : { stream: () => (async function* () { yield { type: 'text-delta', text: '字'.repeat(10000) }; })() }; } }, fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { ...payload.data, title: '题'.repeat(500), owner: { name: '作'.repeat(200) }, desc: '文'.repeat(9000) } })) });
  await rejects(large.generate({ bvid }), 'BILI_DRAFT_TOO_LONG'); const result = { source: await large.read(bvid) }; assert.equal(result.source.title.length, 200); assert.equal(result.source.author.length, 100); assert.equal(result.source.description.length, 4000);
});
await check('source HTTP, oversized/malformed response, identity mismatch and timeout failures are actionable', async () => {
  for (const response of [new Response('', { status: 302 }), new Response('{bad'), new Response('x'.repeat(256 * 1024 + 1)), new Response(JSON.stringify({ code: 0, data: { ...payload.data, bvid: 'BV1yy411c7mD' } }))]) await rejects(createBiliDrafts({ ctx, fetchImpl: async () => response }).read(bvid), 'BILI_SOURCE_UNAVAILABLE');
  await rejects(createBiliDrafts({ ctx, fetchImpl: async () => new Promise(() => {}), readTimeoutMs: 10 }).read(bvid), 'BILI_SOURCE_TIMEOUT');
});
await check('model auth/error/empty/timeout failures never expose provider details', async () => {
  const modelCtx = stream => ({ get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : { stream } });
  const read = async () => new Response(JSON.stringify(payload));
  const auth = createBiliDrafts({ ctx: modelCtx(() => { throw Object.assign(new Error('FAKE_SECRET_PROVIDER_ERROR'), { status: 401 }); }), fetchImpl: read });
  await rejects(auth.generate({ bvid }), 'MODEL_AUTH_REQUIRED');
  const brokenStream = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'FAKE_SECRET_PROVIDER_ERROR' } } }; };
  const broken = createBiliDrafts({ ctx: modelCtx(() => brokenStream()), fetchImpl: read });
  try { await broken.generate({ bvid }); assert.fail(); } catch (error) { assert.equal(error.code, 'MODEL_UNAVAILABLE'); assert.ok(error.hint); assert.doesNotMatch(JSON.stringify(draftErrorResult(error)), /FAKE_SECRET_PROVIDER_ERROR/); }
  await rejects(createBiliDrafts({ ctx: modelCtx(() => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })()), fetchImpl: read }).generate({ bvid }), 'BILI_DRAFT_EMPTY');
  await rejects(createBiliDrafts({ ctx: modelCtx(() => (async function* () { await new Promise(() => {}); })()), fetchImpl: read, modelTimeoutMs: 10 }).generate({ bvid }), 'BILI_DRAFT_TIMEOUT');
});
await check('budget truncation, missing finish and non-text completion never become successful partial drafts', async () => {
  const partial = '「再宏大的战略布局」——简介里这句话已经把「执序」';
  for (const [kind, code] of [['max-tokens', 'BILI_DRAFT_TRUNCATED'], ['tool-calls', 'BILI_DRAFT_INCOMPLETE'], ['completed', 'BILI_DRAFT_INCOMPLETE'], [null, 'BILI_DRAFT_INCOMPLETE'], ['aborted', 'MODEL_UNAVAILABLE']]) {
    const fixture = createBiliDrafts({ ctx: { get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : { stream: () => (async function* () { yield { type: 'text-delta', text: partial }; if (kind) yield { type: 'finish', reason: { kind } }; })() } }, fetchImpl });
    try { await fixture.generate({ bvid }); assert.fail('partial draft must not be returned'); }
    catch (error) { const result = draftErrorResult(error); assert.equal(result.code, code); assert.ok(result.error && result.hint); assert.equal(result.draft, undefined); }
  }
});
await check('concurrent generation is bounded', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const limited = createBiliDrafts({ ctx: { get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : { stream: () => (async function* () { await gate; yield { type: 'text-delta', text: '草稿' }; yield { type: 'finish', reason: { kind: 'stop' } }; })() } }, fetchImpl });
  const first = limited.generate({ bvid }); await new Promise(resolve => setImmediate(resolve));
  await rejects(limited.generate({ bvid }), 'BILI_DRAFT_BUSY'); release(); await first;
});

// Exercise the real plugin route registration, including its existing auth/Origin fence.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-drafts-'));
const state = path.join(temp, 'dsh', 'surfcore'); fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(path.join(temp, 'qq', 'src'), { recursive: true });
fs.writeFileSync(path.join(temp, 'qq', 'src', 'bridge.js'), '// fixture'); fs.writeFileSync(path.join(temp, 'qq', 'config.json'), '{}');
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ platforms: { start: { qq: false, bili: false } }, bridge: { autoStart: false } }));
Object.assign(process.env, { DSH_HOME: path.join(temp, 'dsh'), USERPROFILE: path.join(temp, 'dsh'), SURFCORE_ROOT: path.join(temp, 'qq'), SURFCORE_SKIP_AUTOSTART: '1', SURFCORE_DISABLE_CHARACTER_MIGRATION: '1', SURFCORE_DISABLE_MEMORY_TIMER: '1' });
const oldFetch = globalThis.fetch; globalThis.fetch = fetchImpl;
try {
  const routes = [];
  const { apply } = await import('../lib/index.js');
  apply({ webServer: { register(route) { routes.push(route); return () => {}; } }, get(name) { if (name === 'connection') return { requestRejection: req => req.headers['x-fixture-auth'] === 'yes' ? false : 401 }; return ['llm', 'agentDefaultModel'].includes(name) ? ctx.get(name) : null; }, effect() { return () => {}; } });
  async function invoke(action, data, headers = {}) {
    const route = routes.find(r => r.path === `/dsh-surfcore/api/bili/drafts/${action}`); assert.ok(route);
    const req = new EventEmitter(); Object.assign(req, { method: 'POST', url: route.path, headers: { host: '127.0.0.1:3211', origin: 'http://127.0.0.1:3211', 'content-type': 'application/json', 'x-fixture-auth': 'yes', ...headers }, resume() {} });
    const res = { statusCode: 200, headers: {}, body: '', writeHead(status, values) { this.statusCode = status; this.headers = values; }, end(value = '') { this.body += value; } };
    setImmediate(() => { req.emit('data', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))); req.emit('end'); });
    await route.handler(req, res); return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
  }
  await check('real routes keep DSH authentication and same-Origin checks', async () => {
    const before = http.length;
    assert.equal((await invoke('read', { input: bvid }, { 'x-fixture-auth': 'no' })).status, 401);
    assert.equal((await invoke('read', { input: bvid }, { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await invoke('read', { input: bvid }, { host: 'evil.invalid' })).status, 403);
    assert.equal(http.length, before);
    assert.equal((await invoke('read', { input: bvid })).data.source.bvid, bvid);
    assert.equal((await invoke('generate', { bvid, source: { title: 'FORGED' } })).data.source.title, payload.data.title);
  });
  await check('route input failures carry code/error/hint and no publication API is added', async () => {
    for (const input of ['bad json', { input: 'x'.repeat(513) }, 'x'.repeat(8193)]) {
      const result = await invoke('read', input); assert.equal(result.data.ok, false); assert.ok(result.data.code && result.data.error && result.data.hint);
    }
    assert.equal(routes.filter(r => r.path.includes('/bili/drafts/')).length, 2);
    const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    const card = client.slice(client.indexOf('function BiliDraftCard()'), client.indexOf('function BiliTab('));
    assert.match(card, /role: "alert"/); assert.match(card, /复制草稿/); assert.doesNotMatch(card, /pending-approve|reply-draft|--go|发布按钮|notify/);
    assert.ok(http.every(call => call.options.method === 'GET' && new URL(call.url).origin === 'https://api.bilibili.com'));
  });
} finally { globalThis.fetch = oldFetch; fs.rmSync(temp, { recursive: true, force: true }); }
console.log(`PASS ${count} Bili draft checks; all HTTP and models mocked; no real platform requests.`);
