import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';

const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-purpose-entry-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const { CapabilitySupervisor, CapabilityError } = await import('../lib/local-capabilities/supervisor.js');
const { LocalCapabilities } = await import('../lib/local-capabilities/facade.js');
const { createPetChatService } = await import('../lib/pet-chat.js');
const { createPetApiService } = await import('../lib/pet-api.js');
const { createAutonomousCompanion, createCompanionHandler } = await import('../lib/autonomous-companion.js');
const { createGovernedPurposePlanner } = await import('../lib/local-purpose-planner.js');
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'),
  dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let role = { id: 'entry-0', epoch: 1 }, seq = 0, persona = '', co, pet, native, handler, drop = false;
let calls = [], bridgeCalls = [], modelHook = async () => {}, response = 'send', readerCalls = 0, continuation = 'none';
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => role });
const llm = {
  listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'fixture', settingsPath: [] }],
  async prepareCall(config) { return { config, async *stream(input) {
    calls.push(input); await modelHook(input);
    yield { type: 'text-delta', text: response === 'skip' ? '{"decision":"skip"}' : JSON.stringify({ decision: 'send', text: '合成主人联系正文', pending: continuation }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }; },
  async *stream() { yield { type: 'text-delta', text: '普通桌宠聊天仍可用。' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
};
const ctx = { get(name) {
  if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'fixture' }) };
  if (name === 'llm') return llm;
  if (name === 'launchEnvironment') return new Map();
  if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision: 1, value: { baseURL: 'https://fixture.invalid/v1' } }] };
} };
const intents = new Map();
const channelHandler = { async issueIntent(value) { const id = crypto.randomBytes(24).toString('hex'); await value.active(); value.syncGuard(); intents.set(id, { value, state: 'issued' }); return id; }, intentStatus: id => intents.get(id)?.state };
const callBridge = async (route, options) => {
  bridgeCalls.push(route);
  if (route.endsWith('/readiness')) return { ok: true, data: { ok: true, ready: true, activity: { epoch: 'qq-boot', account: '999', peer: '123', revision: 1, sequence: 1, receivedAt: Date.now(), foreground: false } } };
  const intent = intents.get(options.body.intentId); await intent.value.active(); intent.value.syncGuard(); intent.state = 'sent';
  return { ok: true, data: { ok: true, delivery: { messageId: 'qq-receipt', activity: { epoch: 'qq-boot', sequence: 2, at: Date.now() } } } };
};
const stateDir = path.join(temp, 'coordinator');
function make(extra = {}) {
  co = createAutonomousCompanion({ ctx, capabilities: local, channelHandler, stateDir, callBridge, pet,
    environment: () => ({ roleActive: true, platformEnabled: false, focused: false, paused: false }),
    persona: () => ({ ...role, text: persona, revision: 1 }),
    reader: { feed: async () => { readerCalls++; return []; } }, ...extra });
  local.onAttentionChange = () => co.cancelPending(); pet.setPurposeObserver(input => co.noteInput(input));
  handler = createCompanionHandler(co);
  return co;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/dsh-surfcore/api/')) { void handler(req, res); return; }
  if (drop && url.pathname.endsWith('/events')) {
    const end = res.end.bind(res);
    res.end = (body, ...args) => { if (JSON.parse(body).events?.length) { res.destroy(); return res; } return end(body, ...args); };
  }
  void native.handle(req, res, url);
});
let base;
async function reset() {
  co?.dispose(); await pet?.invalidateTransient(); seq++; role = { id: `entry-${seq}`, epoch: seq };
  await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  await local.management('attention.configure', { enabled: false, daily_limit: 4, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC', muted: false, focused: false });
  calls = []; bridgeCalls = []; readerCalls = 0; modelHook = async () => {}; response = 'send'; continuation = 'none'; persona = ''; drop = false;
  pet = createPetChatService({ ctx, capabilities: local, stateDir: path.join(temp, `pet-${seq}`) });
  native = createPetApiService({ chat: pet, stateDir: path.join(temp, `pet-${seq}`), currentDshUrl: () => base, petService: { status: () => ({}) } });
  pet.notePresence('fixture-native'); make();
}
async function enable(patch = {}) { await co.configure({ enabled: true, carrier: 'pet', readerEnabled: false, ...patch }); }
async function poll() {
  const result = await fetch(`${base}/dsh-surfcore/pet-api/events?since=0&waitMs=0&clientId=fixture-native`, { headers: { 'x-pet-token': pet.token() } });
  return { status: result.status, body: await result.json() };
}
async function pump(work) {
  let done = false, result, failure; const events = [];
  const settled = work.then(value => { done = true; result = value; }, error => { done = true; failure = error; });
  for (let i = 0; !done && i < 150; i++) {
    try { const response = await poll(); events.push(...(response.body.events || [])); } catch (error) { if (!drop) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!done) { co.cancelPending(); await settled; throw Error('native event fixture did not finish'); }
  await settled;
  return { result, failure, events };
}
let count = 0;
const check = async (name, operation) => { await operation(); console.log(`ok ${++count} ${name}`); };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  await check('off migration and empty no-purpose means zero owner model and zero native/QQ output', async () => {
    await reset(); assert.equal((await co.status()).config.enabled, false);
    await assert.rejects(co.run(), error => error.code === 'COMPANION_DISABLED');
    await enable(); const result = await co.run(); assert.equal(result.skipped, true); assert.equal(result.reason, 'no-purpose');
    assert.equal(calls.length, 0); assert.equal(bridgeCalls.length, 0); assert.equal(readerCalls, 0);
  });
  await check('Pet private plan without Bili or QQ platform uses actual native HTTP receipt', async () => {
    await reset(); await local.ingest(await local.context({ kind: 'pet' }), 'pet-plan', '明天我有面试，有点紧张', { actor: 'user', original: true });
    await enable(); const value = await pump(co.run());
    assert.ifError(value.failure); assert.equal(value.result.outcome, 'sent'); assert.equal(value.result.carrier, 'pet');
    assert.equal(value.events.length, 1); assert.equal(value.events[0].memory_write, false); assert.equal(value.events[0].suppressHistory, true);
    assert.equal(calls.length, 1); assert.equal(bridgeCalls.length, 0); assert.equal(readerCalls, 0);
    assert.match(calls[0].messages[0].content[0].text, /面试/);
    assert.equal((await co.status()).attention.today_count, 1);
    const records = await local.management('memory.query'); assert.equal(records.memories.length, 1, 'purpose delivery never writes legacy history or duplicate body');
  });
  await check('reader offline continues private purpose and surfaces reader error', async () => {
    await reset(); await local.ingest(await local.context({ kind: 'pet' }), 'offline-plan', '明天我有考试', { actor: 'user', original: true });
    co.dispose(); make({ reader: { feed: async () => { throw new CapabilityError('BILI_PUBLIC_UNAVAILABLE', '合成公开读取故障', '稍后读取公开材料。'); } } });
    await enable({ readerEnabled: true }); const value = await pump(co.run()); assert.ifError(value.failure); assert.equal(value.result.outcome, 'sent');
    const status = await co.status(); assert.equal(status.reader.code, 'BILI_PUBLIC_UNAVAILABLE'); assert.ok(status.reader.hint); assert.equal(calls.length, 1);
  });
  await check('persona-only skip is normal and allocates no ledger reservation', async () => {
    await reset(); persona = '喜欢玩游戏和学习新知识'; response = 'skip'; await enable();
    const result = await co.run(); assert.equal(result.reason, 'model-skip'); assert.equal(calls.length, 1);
    assert.equal((await co.status()).attention.today_count, 0); assert.equal((await poll()).body.events.length, 0);
  });
  await check('last native attention await config change cancels original output', async () => {
    for (const patch of [{ muted: true }, { quiet_start: '00:00', quiet_end: '00:00' }, { daily_limit: 0 }]) {
      await reset(); persona = '喜欢研究游戏'; await enable();
      const raw = supervisor.raw.bind(supervisor); let checks = 0;
      supervisor.raw = async (...args) => { const result = await raw(...args);
        if (args[0] === 'attention.check' && args[2]?.reservation_id && ++checks === 2) await local.management('attention.configure', patch);
        return result;
      };
      try { const value = await pump(co.run()); assert.ok(value.failure?.code); assert.ok(value.failure.hint); assert.equal(value.events.length, 0); assert.equal(bridgeCalls.length, 0); }
      finally { supervisor.raw = raw; }
    }
  });
  await check('native unknown never falls back and restart cannot replay its persona candidate', async () => {
    await reset(); persona = '喜欢学习'; await enable({ petFallbackToQQ: true }); drop = true;
    const first = await pump(co.run()); assert.equal(first.failure?.code, 'COMPANION_DELIVERY_UNKNOWN'); assert.equal(bridgeCalls.length, 0);
    assert.equal((await co.status()).last.outcome, 'unknown');
    co.dispose(); make(); drop = false; const next = await co.run(); assert.equal(next.skipped, true); assert.equal(bridgeCalls.length, 0);
    assert.equal(calls.length, 1);
  });
  await check('stop cancels only proactive and ordinary Pet chat still ingests trusted original input', async () => {
    await reset(); persona = '喜欢读书'; await enable();
    let release; const gate = new Promise(resolve => { release = resolve; }); modelHook = async () => gate;
    const pending = co.run().catch(error => error);
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    await co.stop(); release(); assert.ok((await pending).code); modelHook = async () => {};
    const reply = await pet.chat({ text: '停止主动后，我仍想普通聊天。' }); assert.equal(reply.ok, true);
    const records = await local.materials({ kind: 'pet' }); assert.ok(records.records.some(record => record.source_metadata.verbatim && record.source_metadata.source_speaker.role === 'user'));
    assert.equal((await co.status()).config.enabled, false);
  });
  await check('Pet offline fallback is pre-transport and recaptures actual QQ scope', async () => {
    await reset(); persona = '喜欢学习知识'; pet.online = () => ({ online: false });
    co.dispose(); make({ environment: () => ({ roleActive: true, platformEnabled: true, focused: false, paused: false }) });
    await enable({ petFallbackToQQ: true }); const result = await co.run(); assert.equal(result.carrier, 'qq'); assert.equal(result.outcome, 'sent');
    assert.ok(bridgeCalls.includes('/api/companion/deliver'));
    const intent = [...intents.values()].at(-1); assert.equal(intent.value.ownerContext.binding.platform, 'qq');
    assert.equal(intent.value.ownerContext.binding.conversation, '123');
  });
  await check('voice unavailable is visible, and unified purpose/companion routes return the same config', async () => {
    await reset(); persona = '喜欢学习'; await enable({ petModality: 'voice' });
    await assert.rejects(co.run(), error => error.code === 'PURPOSE_VOICE_UNAVAILABLE' && Boolean(error.hint)); assert.equal(calls.length, 0);
    const a = await (await fetch(`${base}/dsh-surfcore/api/purpose/status`)).json();
    const b = await (await fetch(`${base}/dsh-surfcore/api/companion/status`)).json(); assert.deepEqual(a.config, b.config);
    assert.equal(a.attention.config.daily_limit, a.config.dailyMax);
  });
  await check('reader and purpose deadlines are independent under one idempotent timer', async () => {
    await reset(); persona = '喜欢学习'; response = 'skip'; let clock = Date.now();
    co.dispose(); make({ now: () => clock }); await enable({ readerEnabled: true, intervalMinutes: 90, purposeIntervalMinutes: 120 });
    await co.tick(); assert.equal(readerCalls, 1); assert.equal(calls.length, 1);
    clock += 91 * 60000; await co.tick(); assert.equal(readerCalls, 2); assert.equal(calls.length, 1);
    clock += 30 * 60000; await co.tick(); assert.equal(readerCalls, 2); assert.equal(calls.length, 2);
    const set = globalThis.setInterval, clear = globalThis.clearInterval; let started = 0, stopped = 0;
    globalThis.setInterval = () => { started++; return { unref() {} }; }; globalThis.clearInterval = () => { stopped++; };
    try { co.start(); co.start(); co.dispose(); assert.equal(started, 1); assert.equal(stopped, 1); }
    finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
  });
  await check('a lease returned after cancellation is still released exactly once', async () => {
    await reset(); persona = '喜欢学习'; await enable();
    const begin = local.beginTurn, end = local.endTurn; let entered = false, release, ended = 0;
    const ticket = Object.freeze({ syntheticLease: true });
    local.beginTurn = async () => { entered = true; return new Promise(resolve => { release = () => resolve(ticket); }); };
    local.endTurn = value => { assert.equal(value, ticket); ended++; };
    try {
      const work = co.run().catch(error => error);
      while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
      co.cancelPending(); release(); assert.equal((await work).code, 'COMPANION_STOPPED'); assert.equal(ended, 1); assert.equal(calls.length, 0);
    } finally { local.beginTurn = begin; local.endTurn = end; }
  });
  await check('attention status and empty legacy read do not cancel an active purpose', async () => {
    await reset(); persona = '喜欢学习'; await enable();
    let release; const gate = new Promise(resolve => { release = resolve; }); modelHook = async () => gate;
    const work = co.run(); while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    await local.management('attention.status'); await local.management('attention.configure', {});
    release(); const completed = await pump(work); assert.ifError(completed.failure); assert.equal(completed.result.outcome, 'sent');
  });
  await check('actual Pet sent receipt plus next original reply reaches only its matching feedback goal', async () => {
    for (const autoWrite of [true, false]) {
      await reset(); persona = '喜欢学习'; continuation = 'continue'; await local.management('memory.settings', { auto_write: autoWrite }); await enable();
      const sent = await pump(co.run()); assert.ifError(sent.failure);
      const response = await pet.chat({ text: '好呀，可以' }); assert.equal(response.ok, true);
      await pet.validateDelivery(response); pet.validateDeliverySync(response); await pet.finishDelivery(response, 'sent');
      const filename = crypto.createHash('sha256').update(role.id).digest('hex').slice(0, 24) + '.state.json';
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, filename), 'utf8')).purpose;
      const receipt = state.receipts.find(row => row.outcome === 'sent'); assert.equal(receipt.feedback.length, 1);
      const planner = createGovernedPurposePlanner({ capabilities: local, getPersona: () => ({ ...role, revision: 1, text: persona }) });
      const plan = await planner.prepare({ channel: { kind: 'pet' }, state, now: Date.now() });
      assert.equal(plan.goals.find(goal => goal.id === receipt.goalId).status === 'confirmed', autoWrite);
      assert.doesNotMatch(JSON.stringify(state), /好呀|合成主人联系正文/);
    }
  });
  console.log(`PASS ${count} real SQLCipher/coordinator/native Pet HTTP checks; fixture ${temp}`);
} finally { co?.dispose(); await pet?.invalidateTransient(); await supervisor.stop(); await new Promise(resolve => server.close(resolve)); }
