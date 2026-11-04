import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { LocalChannelBridge } from '../src/local-capabilities-bridge.js';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createChannelHandler } from '../plugins/surfcore/lib/local-capabilities/channel.js';
import { createToolHost } from '../plugins/surfcore/lib/local-capabilities/tool-host.js';
import { createAutonomousCompanion } from '../plugins/surfcore/lib/autonomous-companion.js';

// Real native handleIncoming -> HTTP channel -> SQLCipher; only model, public
// material and OneBot transport are deterministic fixtures. No production data.
const repo = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-activity-'));
let character = { id: 'native-0', epoch: 1 }, sequence = 0, eventId = 0, count = 0;
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const keyFile = path.join(temp, 'channel.key');
const channel = createChannelHandler({ capabilities: local, keyFile });
channel.deliverTool = async () => { throw new Error('ordinary chat must not request a tool delivery'); };
const server = http.createServer((req, res) => void channel(req, res));
const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`); };
const source = { bvid: 'BV1xx411c7mD', title: '公开主题', author: '作者', description: '公开简介', subtitle: '', basis: '只读标题和简介；未观看画面。', url: 'https://www.bilibili.com/video/BV1xx411c7mD' };
const reader = { feed: async () => [{ bvid: source.bvid }], read: async () => source };
let active;
async function fixture({ autoWrite = false } = {}) {
  local.toolHost = null;
  character = { id: `native-${++sequence}`, epoch: sequence + 1 };
  await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  await local.management('memory.settings', { auto_write: autoWrite });
  await local.management('attention.configure', { enabled: true, daily_limit: 4, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC', muted: false, focused: false });
  const state = { sends: [], delivery: 'sent', modelHook: null, modelCalls: 0 };
  const ctx = { get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) };
    if (name === 'llm') return { stream() { return (async function* () { const call = ++state.modelCalls; await state.modelHook?.(call); yield { type: 'text-delta', text: call === 1 ? '这个公开主题有个具体想法值得琢磨。' : '刚想到这个主题，想问问你的看法。' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } };
    throw new Error(`unexpected service ${name}`);
  } };
  const tools = createToolHost({ capabilities: local, ctx, pollMs: 60000 }); local.toolHost = tools; await tools.syncPolicy();
  class NativeAdapter extends LocalChannelBridge {
    constructor(options) { super({ ...options, currentCharacter: () => character, keyFile, config: () => ({ ...options.config(), dsh: { baseUrl: `http://127.0.0.1:${server.address().port}` } }), guarded: () => true, mode: () => 'local', fetchImpl: async (url, opts) => {
      if (!String(url).endsWith('/send_private_msg')) return fetch(url, opts);
      state.sends.push(JSON.parse(opts.body));
      if (state.delivery === 'unknown') throw new Error('isolated lost receipt');
      return new Response(JSON.stringify(state.delivery === 'failed' ? { status: 'failed', retcode: 16 } : { status: 'ok', retcode: 0, data: { message_id: 222 } }));
    } }); }
  }
  const h = await bridgeHarness({ config: { ownerQQ: '123', allow: { private: ['123'], groups: [] } }, globals: { LocalChannelBridge: NativeAdapter, localBackendGuarded: () => true, localBackendMode: () => 'local' } });
  h.setMode('chat'); h.setReady(true); h.setSelfIdentity('fixture', '999'); h.setSnowlumaHealth({ connected: true, accountOnline: true });
  h.bot.raw = async action => action === 'get_login_info' ? { user_id: 999 } : [{ user_id: 123 }];
  const consoleServer = h.startConsoleServer();
  if (!consoleServer.listening) await new Promise(resolve => consoleServer.once('listening', resolve));
  const callBridge = async (pathname, opts = {}) => {
    const response = await fetch(`http://127.0.0.1:${consoleServer.address().port}${pathname}`, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }, ...(opts.body ? { body: JSON.stringify(opts.body) } : {}) });
    return { ok: response.ok, data: await response.json() };
  };
  const ingress = (message = [{ type: 'text', data: { text: '这是一条原生私聊' } }], extra = {}, { finish = true } = {}) => {
    const work = h.handleIncoming('private', 123, { self_id: 999, user_id: 123, message_id: ++eventId, time: 1, message, ...extra }, h.cfg);
    return work.then(async () => { if (finish) await h.localChannels.endSession(h.state.sessions['private:123']); });
  };
  const ready = async () => (await callBridge('/api/companion/readiness')).data;
  let item = createAutonomousCompanion({ ctx, capabilities: local, channelHandler: channel, stateDir: path.join(temp, `coordinator-${sequence}`), callBridge, environment: () => ({ roleActive: true, platformEnabled: true, focused: false, paused: false }), reader, purposeConfig: () => ({ quietStart: '00:00', quietEnd: '00:00', idleThresholdMs: 30 * 60000, dailyMax: 4 }) });
  item.configure({ enabled: true });
  active = { ...state, state, h, ingress, ready, item, callBridge, async close() { active.item.dispose(); tools.dispose(); local.toolHost = null; consoleServer.closeAllConnections?.(); await new Promise(resolve => consoleServer.close(resolve)); await h.close(); active = null; } };
  return active;
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await check('real chat records local receipt and revision before first parse await, including empty body; no untrusted binding', async () => {
    const f = await fixture();
    try {
      assert.equal((await f.ready()).code, 'BINDING_INVALID');
      const before = Date.now(), work = f.ingress([]).catch(error => { assert.equal(error.code, 'INVALID_REQUEST'); });
      const activity = f.h.localChannels.ownerActivity;
      assert.ok(activity.receivedAt >= before); assert.equal(activity.revision, 1); assert.equal(activity.processing, 1);
      await work;
      const ready = await f.ready(); assert.equal(ready.ready, true); assert.equal(ready.activity.foreground, false); assert.ok(ready.ownerIdleMs < 30000);
      assert.equal(f.state.sends.length, 0);
    } finally { await f.close(); }
  });
  await check('real adapter deduplicates before await; wrong account, principal, deny and allow changes cannot alter activity', async () => {
    const f = await fixture();
    try {
      const id = ++eventId;
      await f.ingress(undefined, { message_id: id }); const original = (await f.ready()).activity;
      await f.ingress(undefined, { message_id: id }); assert.deepEqual((await f.ready()).activity, original);
      for (const extra of [{ self_id: 888 }, { user_id: 124 }]) await assert.rejects(f.ingress(undefined, extra), e => e.code === 'BINDING_INVALID' && !!e.hint);
      f.h.cfg.deny = { users: ['123'] }; await f.ingress(); f.h.cfg.deny = {};
      f.h.cfg.allow.private = []; await f.ingress(); f.h.cfg.allow.private = ['123'];
      assert.deepEqual((await f.ready()).activity, original); assert.equal(f.state.sends.length, 0);
      assert.ok(f.h.localChannels.ownerActivity.seen.size <= 10000);
    } finally { await f.close(); }
  });
  await check('normal native chat blocks autonomous work while foreground; ended chat may send immediately despite configured 30min idle', async () => {
    const f = await fixture();
    try {
      await f.ingress([{ type: 'text', data: { text: '这轮聊完了' } }], {}, { finish: false });
      assert.equal((await f.ready()).code, 'COMPANION_FOREGROUND');
      await assert.rejects(f.item.run(), e => e.code === 'COMPANION_FOREGROUND'); assert.equal(f.state.modelCalls, 0);
      await f.h.localChannels.endSession(f.h.state.sessions['private:123']);
      const ready = await f.ready(); assert.equal(ready.ready, true); assert.ok(ready.ownerIdleMs < 30000);
      await f.item.run(); assert.equal(f.state.sends.length, 1); assert.ok((await f.ready()).activity.lastSentAt > 0);
    } finally { await f.close(); }
  });
  for (const phase of ['parse', 'ingest', 'generation', 'issued', 'claim', 'last-rpc']) for (const body of ['empty', 'text']) await check(`real ${body} owner input in ${phase} window cancels original revision even with auto_write=false; transport=0`, async () => {
    const f = await fixture(); const originalIngest = local.ingest.bind(local), originalIssue = channel.issueIntent;
    let inbound, injected = false;
    const inject = async (wait = true) => { if (injected) return; injected = true; inbound = f.ingress(body === 'empty' ? [] : undefined).catch(error => { if (body !== 'empty') throw error; assert.equal(error.code, 'INVALID_REQUEST'); }); if (wait) await inbound; };
    try {
      await f.ingress();
      const originalRequest = f.h.localChannels.request.bind(f.h.localChannels);
      const phaseReader = phase === 'parse' ? { ...reader, read: async () => { await inject(false); return source; } } : reader;
      if (phase === 'ingest') local.ingest = async (...args) => { const result = await originalIngest(...args); if (args[1].endsWith(':material')) await inject(); return result; };
      if (phase === 'generation') f.state.modelHook = async n => { if (n === 2) await inject(); };
      if (phase === 'issued') channel.issueIntent = async (...args) => { const id = await originalIssue(...args); await inject(); return id; };
      if (phase === 'claim' || phase === 'last-rpc') f.h.localChannels.request = async (...args) => { const result = await originalRequest(...args); if ((phase === 'claim' && args[0] === 'intent.claim') || (phase === 'last-rpc' && args[0] === 'attention.check' && args[2]?.params?.reservation_id)) await inject(phase !== 'last-rpc'); return result; };
      // A separate service is needed only to inject at the real public reader boundary.
      if (phase === 'parse') { f.item.dispose(); f.item = createAutonomousCompanion({ ctx: { get: () => { throw Error('stale round must not call model'); } }, capabilities: local, channelHandler: channel, stateDir: path.join(temp, `parse-${sequence}`), callBridge: f.callBridge, reader: phaseReader, environment: () => ({ roleActive: true, platformEnabled: true, focused: false, paused: false }), purposeConfig: () => ({ quietStart: '00:00', quietEnd: '00:00' }) }); f.item.configure({ enabled: true }); }
      await assert.rejects(f.item.run(), e => ['COMPANION_ACTIVITY_CHANGED', 'COMPANION_FOREGROUND', 'BINDING_INVALID', 'STALE_CONTEXT', 'STALE_CHARACTER'].includes(e.code) && !!e.hint, phase);
      await inbound; assert.equal(injected, true); assert.equal(f.state.sends.length, 0); assert.equal((await f.ready()).activity.revision, 2);
      assert.equal(f.h.localChannels.ownerActivity.lastSentAt, 0);
    } finally { local.ingest = originalIngest; channel.issueIntent = originalIssue; await f.close(); }
  });
  await check('native failed ingestion still advances activity and cancels issued intention permanently', async () => {
    const f = await fixture(), originalIssue = channel.issueIntent;
    try {
      await f.ingress(); const request = f.h.localChannels.request.bind(f.h.localChannels);
      channel.issueIntent = async (...args) => { const id = await originalIssue(...args); f.h.localChannels.request = async (...rpc) => { if (rpc[0] === 'ingest') throw Object.assign(new Error('isolated DB failure'), { code: 'SERVICE_UNAVAILABLE', hint: 'fixture' }); return request(...rpc); }; await assert.rejects(f.ingress(), e => e.code === 'SERVICE_UNAVAILABLE'); f.h.localChannels.request = request; return id; };
      await assert.rejects(f.item.run(), e => e.code === 'COMPANION_ACTIVITY_CHANGED'); assert.equal(f.state.sends.length, 0); assert.equal((await f.ready()).activity.revision, 2);
    } finally { channel.issueIntent = originalIssue; await f.close(); }
  });
  for (const change of ['identity', 'foreground', 'allowlist']) await check(`last native RPC cannot mask a synchronous ${change} change before actual transport`, async () => {
    const f = await fixture();
    try {
      await f.ingress(); const request = f.h.localChannels.request.bind(f.h.localChannels);
      f.h.localChannels.request = async (...args) => {
        const result = await request(...args);
        if (args[0] === 'attention.check' && args[2]?.params?.reservation_id) {
          if (change === 'identity') f.h.setSelfIdentity('other', '888');
          if (change === 'foreground') f.h.v2TurnStartAt.set(f.h.state.sessions['private:123'], Date.now());
          if (change === 'allowlist') f.h.cfg.allow.private = [];
        }
        return result;
      };
      await assert.rejects(f.item.run(), e => ({ identity: 'BINDING_INVALID', foreground: 'COMPANION_FOREGROUND', allowlist: 'OWNER_NOT_ALLOWED' })[change] === e.code && !!e.hint);
      assert.equal(f.state.sends.length, 0);
    } finally { await f.close(); }
  });
  for (const outcome of ['sent', 'failed', 'unknown']) await check(`native ${outcome} receipt records lastSent only when confirmed and never replays unknown`, async () => {
    const f = await fixture();
    try {
      await f.ingress(); f.state.delivery = outcome;
      if (outcome === 'sent') await f.item.run(); else await assert.rejects(f.item.run());
      assert.equal(f.state.sends.length, 1); assert.equal(f.item.status().last.outcome, outcome);
      assert.equal((await f.ready()).activity.lastSentAt > 0, outcome === 'sent');
      await assert.rejects(f.item.run()); assert.equal(f.state.sends.length, 1);
      const stateFile = fs.readdirSync(path.join(temp, `coordinator-${sequence}`)).find(name => name.endsWith('.state.json'));
      const saved = JSON.parse(fs.readFileSync(path.join(temp, `coordinator-${sequence}`, stateFile), 'utf8'));
      assert.equal(saved.purpose.lastSentAt > 0, outcome === 'sent');
    } finally { await f.close(); }
  });
} finally {
  await active?.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await supervisor.stop();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`PASS ${count} native companion activity checks; real handleIncoming + loopback channel + isolated SQLCipher; zero real QQ sends.`);
