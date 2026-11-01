import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LocalChannelBridge } from '../src/local-capabilities-bridge.js';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createChannelHandler } from '../plugins/surfcore/lib/local-capabilities/channel.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, '.local/channel-tests', crypto.randomUUID());
fs.mkdirSync(evidence, { recursive: true });
const keyFile = path.join(evidence, 'channel.key');
let character = { id: 'channel-a', epoch: 1 };
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(evidence, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
const local = new LocalCapabilities({ supervisor, stateFile: path.join(evidence, 'backend.json'), currentCharacter: () => character });
const handler = createChannelHandler({ capabilities: local, keyFile });
const server = http.createServer((req, res) => void handler(req, res));
let count = 0;
const results = [];
async function check(name, run) { await run(); results.push(name); console.log(`ok ${++count} ${name}`); }
const incoming = (peer, id, text) => ({ key: `private:${peer}`, event: { self_id: 999, user_id: Number(peer), message_id: id }, text });
let h;
try {
  await local.setMode('local');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = () => ({ dsh: { baseUrl: base } });
  const adapter = new LocalChannelBridge({ config, keyFile, guarded: () => true, mode: () => 'local' });
  const event = incoming('123', 1, '私聊专属：我喜欢紫色');
  await adapter.incoming(event.key, event.event, event.text);
  await adapter.incoming(event.key, event.event, event.text);
  await check('trusted source is ingested once and prompt contains scoped current source', async () => {
    assert.equal(adapter.events.get(event.key).length, 1);
    const prompt = await adapter.prepare(event.key, 's1', 'token1');
    assert.match(prompt, /我喜欢紫色/);
    assert.doesNotMatch(prompt, /legacy-secret/);
  });
  await check('actual private send validates original generation', async () => {
    adapter.enterSession('s1'); let sends = 0;
    await adapter.send(event.key, async () => { sends++; });
    assert.equal(sends, 1);
    await assert.rejects(adapter.send('private:124', async () => { sends++; }), e => e.code === 'BINDING_INVALID' && !!e.hint);
    assert.equal(sends, 1);
  });
  await check('group projection excludes private and pet memory', async () => {
    const pet = await local.context({ kind: 'pet' }); await local.ingest(pet, 'pet-source', '桌宠私密：橘色');
    await adapter.incoming('group:456', { self_id: 999, user_id: 700, message_id: 2 }, '群聊：今天天气');
    const prompt = await adapter.prepare('group:456', 'group1', 'group-token');
    assert.match(prompt, /今天天气/); assert.doesNotMatch(prompt, /紫色|橘色/);
  });
  await check('correction invalidates model output and queued delivery', async () => {
    const memories = await local.management('memory.query');
    const privateRecord = memories.memories.find(m => m.statement.includes('紫色'));
    assert.ok(privateRecord);
    await local.management('memory.correct', { id: privateRecord.id, statement: '现在喜欢绿色', expected_revision: privateRecord.revision });
    adapter.enterSession('s1'); let sends = 0;
    await assert.rejects(adapter.send(event.key, async () => sends++), e => e.code === 'STALE_CONTEXT' && !!e.hint);
    assert.equal(sends, 0);
  });
  await check('sequential ingress retains the original request and language supplement', async () => {
    const a = new LocalChannelBridge({ config, keyFile, guarded: () => true, mode: () => 'local' });
    await a.incoming(event.key, { ...event.event, message_id: 101 }, 'Please answer first question: explain my invoice.');
    await a.incoming(event.key, { ...event.event, message_id: 102 }, 'And use Chinese.');
    const prompt = await a.prepare(event.key, 'burst', 'burst-token');
    assert.match(prompt, /Please answer first question: explain my invoice\./);
    assert.match(prompt, /And use Chinese\./);
  });
  await check('other group ingestion does not erase pending current messages', async () => {
    const a = new LocalChannelBridge({ config, keyFile, guarded: () => true, mode: () => 'local' });
    await a.incoming(event.key, { ...event.event, message_id: 103 }, '这条私聊请求必须保留');
    await a.incoming('group:456', { self_id: 999, user_id: 700, message_id: 104 }, '无关群的新消息');
    const prompt = await a.prepare(event.key, 'cross-group-burst', 'cross-token');
    assert.match(prompt, /这条私聊请求必须保留/);
    assert.doesNotMatch(prompt, /无关群的新消息/);
  });
  await check('queued corrected source uses current revision instead of cached raw input', async () => {
    const a = new LocalChannelBridge({ config, keyFile, guarded: () => true, mode: () => 'local' });
    await a.incoming(event.key, { ...event.event, message_id: 105 }, '排队旧版本：请推荐咖啡');
    const records = await local.management('memory.query');
    const item = records.memories.find(m => m.statement.includes('排队旧版本'));
    await local.management('memory.correct', { id: item.id, statement: '排队新版本：请推荐茶', expected_revision: item.revision });
    const prompt = await a.prepare(event.key, 'corrected-queue', 'corrected-token');
    assert.match(prompt, /排队新版本：请推荐茶/);
    assert.doesNotMatch(prompt, /排队旧版本|请推荐咖啡/);
  });
  await check('automatic writing disabled retains only verified one-turn input', async () => {
    await local.management('memory.settings', { auto_write: false });
    const a = new LocalChannelBridge({ config, keyFile, guarded: () => true, mode: () => 'local' });
    await a.incoming(event.key, { ...event.event, message_id: 106 }, '停写期间的当前请求');
    assert.equal(a.events.get(event.key)[0].neverPersisted, true);
    const prompt = await a.prepare(event.key, 'never-persisted', 'never-persisted-token');
    assert.match(prompt, /停写期间的当前请求/);
    assert.equal((await local.management('memory.query')).memories.some(m => m.statement.includes('停写期间')), false);
    await local.management('memory.settings', { auto_write: true });
  });
  await check('deletion removes pending private event copies from next prompt', async () => {
    await adapter.incoming(event.key, { ...event.event, message_id: 3 }, '待删除专属内容');
    const records = await local.management('memory.query'); const record = records.memories.find(m => m.statement.includes('待删除'));
    await local.management('memory.delete', { id: record.id, expected_revision: record.revision });
    const prompt = await adapter.prepare(event.key, 's2', 'token2');
    assert.doesNotMatch(prompt, /待删除专属内容/);
  });
  await check('Bili binding sees public projection only', async () => {
    const context = await local.context({ kind: 'bili', account: '999', peer: 'public', principal: 'public' });
    assert.doesNotMatch(context.text, /紫色|绿色|橘色|今天天气/);
  });
  await local.management('attention.configure', { enabled: true, daily_limit: 10, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC', muted: false, focused: false });
  await check('proactive unknown delivery is counted and cannot replay on QQ or pet', async () => {
    await adapter.prepare(event.key, 'proactive1', 'proactive-token'); adapter.enterSession('proactive1');
    let sends = 0;
    await assert.rejects(adapter.send(event.key, async () => { sends++; throw new Error('fixture timeout'); }));
    const record = adapter.sessions.get('proactive1');
    const pet = await local.context({ kind: 'pet' });
    assert.equal((await supervisor.raw('attention.reserve', pet.binding, { outreach_id: record.outreachId })).reserved, false);
    await assert.rejects(adapter.send(event.key, async () => sends++), e => !!e.code && !!e.hint);
    assert.equal(sends, 1);
  });
  await check('send recheck blocks a mute change after reservation', async () => {
    await adapter.prepare(event.key, 'quiet-race', 'quiet-token'); adapter.enterSession('quiet-race');
    adapter.sessions.get('quiet-race').outreachId = 'fixture-quiet-race';
    const original = adapter.request.bind(adapter);
    adapter.request = async (action, ...args) => {
      const result = await original(action, ...args);
      if (action === 'attention.reserve' && result.reserved) await local.management('attention.configure', { muted: true });
      return result;
    };
    let sends = 0;
    await assert.rejects(adapter.send(event.key, async () => sends++), e => e.code === 'ATTENTION_BLOCKED');
    assert.equal(sends, 0);
    adapter.request = original;
    await local.management('attention.configure', { muted: false });
  });
  await check('new generation revokes old queued SDK origin', async () => {
    await adapter.prepare(event.key, 'new-generation', 'new-generation-token');
    adapter.enterSession('s2');
    await assert.rejects(adapter.send(event.key, async () => {}), e => e.code === 'BINDING_INVALID');
  });
  await check('character switch invalidates original tool token', async () => {
    character = { id: 'channel-b', epoch: 2 }; await local.setMode('local');
    adapter.enterToken('new-generation-token');
    await assert.rejects(adapter.send(event.key, async () => {}), e => ['STALE_CHARACTER', 'BINDING_INVALID'].includes(e.code));
  });
  await check('real bridge prompts omit old memory and use fresh DSH sessions', async () => {
    class FixtureBridge extends LocalChannelBridge {
      constructor(options) { super({ ...options, config, keyFile, guarded: () => true, mode: () => 'local' }); }
    }
    h = await bridgeHarness({ config: { sendDelayMs: 0 }, globals: { LocalChannelBridge: FixtureBridge, localBackendGuarded: () => true, localBackendMode: () => 'local', safeFetchBuffer: async () => ({ buffer: Buffer.from('fixture-image') }) } });
    h.setMode('chat');
    await h.localChannels.incoming(event.key, { ...event.event, message_id: 10 }, '本轮有效问候');
    await h.deliverPrompt(event.key, 'legacy-secret 从旧完整归档来的内容');
    assert.match(h.calls.prompts[0].content[0].text, /本轮有效问候/);
    assert.doesNotMatch(h.calls.prompts[0].content[0].text, /legacy-secret/);
    const old = h.state.sessions[event.key];
    await h.localChannels.incoming(event.key, { ...event.event, message_id: 11 }, '第二轮问候');
    await h.deliverPrompt(event.key, 'legacy-secret');
    assert.notEqual(h.state.sessions[event.key], old);
    assert.ok(h.calls.archived.includes(old));
    h.localChannels.enterSession(h.state.sessions[event.key]);
    await h.sendToQQ(event.key, '通过实际 SDK 出站封装');
    assert.equal(h.calls.sent.length, 1);
    h.setMode('closed-agent');
    await assert.rejects(h.ensureSession(event.key), e => e.code === 'UNSCOPED_TOOLS_DISABLED' && !!e.hint);
  });
  await check('queued sticker transport blocks missing or stale origins and quiet time before HTTP', async () => {
    h.setMode('chat');
    let outgoing = 0; let guardCalls = 0;
    const originalFetch = h.localChannels.fetchImpl;
    h.localChannels.fetchImpl = async (url, options) => {
      if (/\/send_(private|group)_msg$/.test(String(url))) {
        outgoing++;
        return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }), { status: 200 });
      }
      return originalFetch(url, options);
    };
    const guardedSend = h.localChannels.sendFetch.bind(h.localChannels);
    h.localChannels.sendFetch = (...args) => { guardCalls++; return guardedSend(...args); };
    h.localChannels.enterSession('missing-sticker-origin');
    await assert.rejects(h.sendStickerV2(event.key, 'fixture-sticker'), e => e.code === 'BINDING_INVALID' && !!e.hint);
    assert.equal(outgoing, 0); assert.equal(guardCalls, 1);
    await h.localChannels.prepare(event.key, 'stale-sticker', 'stale-sticker-token');
    h.localChannels.enterSession('stale-sticker');
    const memories = await local.management('memory.query');
    const item = memories.memories.find(m => m.statement.includes('第二轮问候'));
    await local.management('memory.correct', { id: item.id, statement: '已纠正的第二轮问候', expected_revision: item.revision });
    await assert.rejects(h.sendStickerV2(event.key, 'fixture-sticker'), e => e.code === 'STALE_CONTEXT');
    assert.equal(outgoing, 0);
    const now = new Date();
    const hhmm = d => d.toISOString().slice(11, 16);
    await local.management('attention.configure', { enabled: true, daily_limit: 10, cooldown_seconds: 0, quiet_start: hhmm(now), quiet_end: hhmm(new Date(+now + 3600000)), timezone: 'UTC', muted: false, focused: false });
    await h.localChannels.prepare(event.key, 'quiet-sticker', 'quiet-sticker-token');
    h.localChannels.enterSession('quiet-sticker');
    await assert.rejects(h.sendStickerV2(event.key, 'fixture-sticker'), e => e.code === 'ATTENTION_BLOCKED' && !!e.hint);
    assert.equal(outgoing, 0);
    await local.management('attention.configure', { quiet_start: '', quiet_end: '' });
    const sent = await h.sendStickerV2(event.key, 'fixture-sticker');
    assert.equal(outgoing, 1); assert.equal(sent.messageId, 1); assert.equal(guardCalls, 4);
  });
  await check('switch to a legacy character still blocks old local output', async () => {
    let guarded = true;
    const a = new LocalChannelBridge({ config, keyFile, guarded: () => guarded, mode: () => guarded ? 'local' : 'legacy' });
    await a.incoming(event.key, { ...event.event, message_id: 19 }, '切换前问候');
    await a.prepare(event.key, 'before-switch', 'before-switch-token'); a.enterSession('before-switch');
    guarded = false;
    await assert.rejects(a.send(event.key, async () => {}), e => e.code === 'STALE_CHARACTER');
  });
  await check('service failure blocks actual sends without legacy fallback', async () => {
    const a = new LocalChannelBridge({ config, keyFile, guarded: () => true, mode: () => 'local' });
    await a.incoming(event.key, { ...event.event, message_id: 20 }, '断连前问候');
    await a.prepare(event.key, 'failure', 'failure-token'); a.enterSession('failure');
    await supervisor.stop(); let sent = false;
    await assert.rejects(a.send(event.key, async () => { sent = true; }), e => e.code === 'SERVICE_UNAVAILABLE' && !!e.hint);
    assert.equal(sent, false);
  });
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ passed: count, checks: results, realPlatforms: 'NOT_VERIFIED' }, null, 2));
  console.log(`PASS ${count} channel checks; evidence ${evidence}`);
} finally { await h?.close(); await new Promise(resolve => server.close(resolve)); await supervisor.stop(); }
