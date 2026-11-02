/** Real installed SDK message values -> real native bridge -> loopback HTTP only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { MessageChain, text, image } from '@snowluma/sdk';
const repo = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-sdk-chain-'));
process.env.DSH_HOME = path.join(temp, 'home');
const fixtureRoot = path.join(temp, 'qq'); fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true }); fs.writeFileSync(path.join(fixtureRoot, 'src/bridge.js'), '// synthetic root identity'); fs.writeFileSync(path.join(fixtureRoot, 'config.json'), '{}'); process.env.SURFCORE_ROOT = fixtureRoot;
const { CapabilitySupervisor } = await import('../plugins/surfcore/lib/local-capabilities/supervisor.js');
const { LocalCapabilities } = await import('../plugins/surfcore/lib/local-capabilities/facade.js');
const { createChannelHandler } = await import('../plugins/surfcore/lib/local-capabilities/channel.js');
const { LocalChannelBridge } = await import('../src/local-capabilities-bridge.js');
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'sdk-message-chain', epoch: 1 }, h, platform, host;
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'state.json'), currentCharacter: () => character });
const keyFile = path.join(temp, 'channel.key'); const channel = createChannelHandler({ capabilities: local, keyFile });
let outgoing = [], beforeWire = null, eventId = 0;
async function server(handler) { const instance = http.createServer(handler); await new Promise(r => instance.listen(0, '127.0.0.1', r)); return instance; }
const base = instance => `http://127.0.0.1:${instance.address().port}`;
const bodyOf = async req => { let data = ''; for await (const chunk of req) data += chunk; return JSON.parse(data || '{}'); };
const reply = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data })); };
async function origin() {
  const key = 'private:123'; await h.localChannels.incoming(key, { self_id: 999, user_id: 123, message_id: ++eventId }, '合成的本轮请求');
  const session = `sdk-session-${eventId}`; await h.localChannels.prepare(key, session); h.state.sessions[key] = session; return session;
}
let count = 0; const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`); };
try {
  await local.setMode('local'); host = await server((req, res) => void channel(req, res));
  platform = await server((req, res) => void (async () => { const data = await bodyOf(req); if (!['/send_private_msg', '/send_group_msg'].includes(req.url)) { res.writeHead(404); res.end(); return; } outgoing.push({ route: req.url, ...data }); reply(res, { message_id: outgoing.length }); })());
  class Adapter extends LocalChannelBridge { constructor(options) { super({ ...options, config: () => ({ ...options.config(), dsh: { baseUrl: base(host) } }), keyFile, guarded: () => true, mode: () => 'local', fetchImpl: async (url, options) => { if (String(url).startsWith(base(platform)) && beforeWire) await beforeWire(); return fetch(url, options); } }); } }
  h = await bridgeHarness({ config: { ownerQQ: '123', allow: { private: ['123'], groups: ['456'] }, snowluma: { httpUrl: base(platform) }, sendDelayMs: 0 }, globals: { MessageChain, text, LocalChannelBridge: Adapter, localBackendGuarded: () => true, localBackendMode: () => 'local' } }); h.setMode('chat');
  await check('real SDK text factory is a MessageChain and native chat reply reaches controlled HTTP', async () => {
    const actual = text('synthetic-sdk'); assert.equal(actual instanceof MessageChain, true); assert.equal(Array.isArray(actual), false); assert.equal(actual.type, undefined);
    h.localChannels.enterSession(await origin()); await h.sendToQQ('private:123', '真实SDK结构的合成回复'); const nativeDeliveries = outgoing.length;
    if (!nativeDeliveries) { try { await h.bot.sendPrivateMessage(123, actual); } catch (e) { console.log(JSON.stringify({ sdk: actual.constructor.name, type: typeof actual.type, failure: e.code })); } }
    assert.equal(nativeDeliveries, 1); assert.equal(outgoing[0].user_id, 123); assert.deepEqual(outgoing[0].message, [{ type: 'text', data: { text: '真实SDK结构的合成回复' } }]); assert.equal(h.calls.sent.length, 0);
  });
  await check('plain string, raw text/image segments and official mixed MessageChain retain segments', async () => {
    h.localChannels.enterSession(await origin()); await h.bot.sendPrivateMessage(123, 'plain'); await h.bot.sendPrivateMessage(123, [{ type: 'text', data: { text: 'raw' } }, { type: 'image', data: { file: 'https://public.invalid/synthetic.png' } }]);
    const chain = text('caption').image('https://public.invalid/synthetic.png'); await h.bot.sendPrivateMessage(123, chain);
    await h.bot.sendPrivateMessage(123, { type: 'image', data: { file: 'https://public.invalid/synthetic.png' } });
    assert.deepEqual(outgoing.at(-2).message, chain.toSegments()); assert.equal(outgoing.at(-1).message[0].type, 'image'); assert.equal(outgoing.at(-4).message[0].data.text, 'plain');
  });
  await check('arbitrary objects and custom toSegments methods are not invoked or sent', async () => {
    const before = outgoing.length; let calls = 0;
    for (const value of [{}, { toSegments() { calls++; return text('bypass').toSegments(); } }, { get toSegments() { calls++; throw Error('custom getter must not run'); } }]) assert.throws(() => h.bot.sendPrivateMessage(123, value), e => e.code === 'INVALID_REQUEST' && Boolean(e.hint));
    class Custom extends MessageChain { toSegments() { calls++; return text('subclass-bypass').toSegments(); } }
    assert.throws(() => h.bot.sendPrivateMessage(123, new Custom()), e => e.code === 'INVALID_REQUEST');
    assert.equal(calls, 0); assert.equal(outgoing.length, before);
  });
  await check('real chain conversion ignores overridden instance methods, using official prototype only', async () => {
    h.localChannels.enterSession(await origin()); const chain = text('trusted SDK items'); let calls = 0; Object.defineProperty(chain, 'toSegments', { get() { calls++; throw Error('untrusted override'); } });
    await h.bot.sendPrivateMessage(123, chain); assert.equal(calls, 0); assert.equal(outgoing.at(-1).message[0].data.text, 'trusted SDK items');
    const forged = Object.create(MessageChain.prototype); Object.defineProperty(forged, 'items', { get() { calls++; throw Error('untrusted items getter'); } });
    assert.throws(() => h.bot.sendPrivateMessage(123, forged), e => e.code === 'INVALID_REQUEST'); assert.equal(calls, 0);
  });
  await check('recipient, missing context and original epoch revocation still block SDK chains before HTTP', async () => {
    h.localChannels.enterSession(await origin()); const before = outgoing.length; await assert.rejects(h.bot.sendPrivateMessage(124, text('wrong recipient')), e => e.code === 'BINDING_INVALID');
    h.localChannels.invalidate(); await assert.rejects(h.bot.sendPrivateMessage(123, text('missing origin')), e => ['BINDING_INVALID', 'HOST_SEND_BLOCKED'].includes(e.code));
    h.localChannels.enterSession(await origin()); const context = await local.context({ kind: 'pet' }); await local.ingest(context, 'epoch-change', '合成的并发记忆更新');
    await assert.rejects(h.bot.sendPrivateMessage(123, text('old epoch')), e => e.code === 'STALE_CONTEXT'); assert.equal(outgoing.length, before);
  });
  await check('queued native reply keeps existing whitelist/session guard after SDK conversion', async () => {
    h.localChannels.enterSession(await origin()); const before = outgoing.length; const send = h.sendToQQ('private:123', '不允许迟到外发'); h.cfg.allow.private = []; delete h.state.sessions['private:123']; await send;
    assert.equal(outgoing.length, before); assert.equal(h.calls.sent.length, 0);
  });
  console.log(`PASS ${count} native real SDK MessageChain checks; loopback platform recorder, real isolated SQLCipher, no platform or model requests.`);
} finally {
  if (h) { const root = fs.realpathSync(h.temp); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('qq-audit-bridge-')); await h.close(); } if (platform) await new Promise(r => platform.close(r)); if (host) await new Promise(r => host.close(r)); await supervisor.stop();
  const resolved = fs.realpathSync(temp); if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('surfcore-sdk-chain-')) throw Error('unsafe test cleanup'); fs.rmSync(resolved, { recursive: true, force: true });
}
