import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CapabilitySupervisor, CapabilityError } from '../lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../lib/local-capabilities/facade.js';
import { createFixedModel, messagesEndpoint } from '../lib/local-capabilities/fixed-model.js';
import { createToolHost, createToolBridgeDelivery, explicitToolRequest, parseToolProposal } from '../lib/local-capabilities/tool-host.js';
import { createChannelHandler } from '../lib/local-capabilities/channel.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-tool-host-'));
console.log(`fixture root: ${temp}`);
process.env.DSH_HOME = path.join(temp, 'dsh');
const fixtureQqRoot = path.join(temp, 'qq'); fs.mkdirSync(path.join(fixtureQqRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(fixtureQqRoot, 'src/bridge.js'), '// root identity fixture only'); fs.writeFileSync(path.join(fixtureQqRoot, 'config.json'), '{}');
process.env.SURFCORE_ROOT = fixtureQqRoot;
const { createPetChatService } = await import('../lib/pet-chat.js');
const { createPetApiService } = await import('../lib/pet-api.js');
const { LocalChannelBridge } = await import('../../../src/local-capabilities-bridge.js');
const { bridgeHarness } = await import('../../../scripts/audit-bridge-harness.mjs');
// Disposable child only: synthetic OS-lock observation and fail-closed GUI launch blocker. No product bypass.
const entry = path.join(temp, 'synthetic-server.py');
fs.writeFileSync(entry, `import sys\nsys.path.insert(0,${JSON.stringify(path.join(repo, 'services/local-capabilities'))})\nimport tool_broker\ndef deny_gui_launch(*args, **kwargs):\n    raise RuntimeError('GUI process launch forbidden in tool-host fixture')\ntool_broker.subprocess.Popen=deny_gui_launch\ntool_broker.lockscreen_state=lambda:'unlocked'\nimport server\nserver.main()\n`);
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry, dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'tool-host-0', epoch: 0 }; let sequence = 0;
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const pet = { kind: 'pet', account: 'local', peer: 'local', principal: 'pet:local' };
const owner = { kind: 'qq-private', account: '999', peer: '123', principal: '123' };
const raw = supervisor.raw.bind(supervisor); let ops = []; let rawHook = null;
supervisor.raw = async (...args) => { ops.push(args[0]); if (rawHook) await rawHook(...args); return raw(...args); };
let selected, revision, baseURL, proposal, finish, prepareHook, streamHook, modelCalls, prepareCalls, dispatched, events, host, fixed, time;
let deliveries = []; let onDeliver = null;
const ctx = { get(name) {
  if (name === 'agentDefaultModel') return { currentSelection: () => selected };
  if (name === 'settings') return { describe(options) { assert.deepEqual(options, { redactSecrets: true }); return [{ ns: 'deepseek-fixture', applies: 'live', revision, value: { baseURL, get apiKey() { throw Error('SECRET MUST NEVER BE READ'); } } }]; } };
  if (name === 'launchEnvironment') return { get(key) { assert.equal(key, 'DEEPSEEK_BASE_URL'); return undefined; } };
  if (name === 'llm') return llm;
  return null;
}, on(name, listener) { const set = events.get(name) || new Set(); events.set(name, set); set.add(listener); return () => set.delete(listener); } };
const llm = {
  async *stream(options) { modelCalls.push(options); if (streamHook) await streamHook(options); yield { type: 'text-delta', text: '普通对话的完整回复。' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
  listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'deepseek-fixture', settingsPath: [] }],
  async prepareCall(config, signal) {
    prepareCalls.push(config); if (prepareHook) await prepareHook(signal);
    let used = false; const captured = { ...config };
    return { config: captured, stream(options) {
      assert.equal(used, false); used = true; assert.equal(options.provider, captured.provider); assert.equal(options.model, captured.model);
      return (async function* () {
        modelCalls.push(options); dispatched++; if (streamHook) await streamHook(options);
        const value = options.system.startsWith('只把用户') ? proposal : { reply: '已依据这次批准的本机结果完成回答。' };
        yield { type: 'text-delta', text: typeof value === 'string' ? value : options.system.startsWith('只把用户') ? JSON.stringify(value) : value.reply };
        if (finish) yield { type: 'finish', reason: { kind: finish } };
      })();
    } };
  },
};
function emit(name) { for (const listener of [...(events.get(name) || [])]) listener(); }
const tick = () => new Promise(resolve => setImmediate(resolve));
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && Boolean(error.hint));
const throws = (fn, code) => assert.throws(fn, error => error.code === code && Boolean(error.hint));
async function reset(extra = {}) {
  host?.dispose(); fixed?.dispose(); local.toolHost = null; rawHook = null;
  character = { id: `tool-host-${++sequence}`, epoch: sequence }; await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  await local.management('tool.emergency.reset');
  selected = { provider: 'deepseek-official', model: 'fixture-model', apiKey: 'SHOULD_NOT_APPEAR' }; revision = 1; baseURL = 'https://api.deepseek.com/anthropic';
  proposal = { tool_id: 'time.now', action: 'read', arguments: {} }; finish = 'stop'; prepareHook = null; streamHook = null; modelCalls = []; prepareCalls = []; dispatched = 0; events = new Map(); deliveries = []; onDeliver = null; ops = []; time = Date.now();
  fixed = createFixedModel({ ctx, timeoutMs: 2000 });
  host = createToolHost({ capabilities: local, ctx, pollMs: 60000, now: () => time, ...extra });
  await host.syncPolicy();
}
function incoming(text, channel = pet, id = crypto.randomUUID()) { return host.input(channel, { eventId: id, text }); }
async function deliver(envelope) { assert.equal(envelope.memory_write, false); assert.equal(envelope.suppressHistory, true); assert.equal(envelope.suppressTts, true); if (onDeliver) await onDeliver(envelope); await envelope.guard(); deliveries.push(envelope.text); return { outcome: 'sent' }; }
const run = (text, channel = pet) => host.handle(incoming(text, channel), { deliver });
async function waitState(state, id) {
  for (let n = 0; n < 200; n++) { await host.poll(); const record = host.status().jobs.find(item => !id || item.continuationId === id); if (record?.state === state) return record; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`bounded continuation did not reach ${state}: ${JSON.stringify(host.status())}`);
}
async function confirmExecution(id) { const execution = await local.management('tool.status', { execution_id: id }); return local.management('tool.confirm', { execution_id: id, expected_revision: execution.revision, confirmation_digest: execution.confirmation_digest }); }
async function exportRecord() { return (await local.management('tool.result.export.list', { limit: 20 })).exports[0]; }
async function confirmExport() { const record = await exportRecord(); return local.management('tool.result.export.confirm', { export_id: record.export_id, expected_revision: record.revision, confirmation_digest: record.confirmation_digest }); }
async function notes(text = '请创建便签，标题fixture，内容synthetic note') {
  proposal = { tool_id: 'notes.create', action: 'create', arguments: { title: 'fixture', text: 'synthetic note PRIVATE_RESULT' } };
  const result = await run(text); assert.equal(result.state, 'awaiting_confirmation'); await confirmExecution(result.executionId); await waitState('awaiting_export'); return result;
}
let count = 0; const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`); };
try {
  await check('fixed endpoint follows reviewed Messages normalization and rejects URL credentials/query', async () => {
    assert.equal(messagesEndpoint('https://example.test/anthropic/'), 'https://example.test/anthropic/v1/messages');
    assert.equal(messagesEndpoint('https://example.test/v1'), 'https://example.test/v1/messages');
    for (const url of ['https://user:secret@example.test/', 'https://example.test/?token=x', 'file:///tmp/x']) throws(() => messagesEndpoint(url), 'FIXED_MODEL_UNSUPPORTED');
  });
  await check('prepared model fixes provider/endpoint, no credential/history/tools and only dispatches once', async () => {
    await reset(); const pin = fixed.pin(); const prepared = await pin.prepare();
    assert.match(pin.target.endpoint_identity, /^[a-f0-9]{64}$/); assert.match(pin.target.config_revision, /^[a-f0-9]{64}$/);
    assert.equal(await prepared.text({ system: 'fixture', user: 'approved only' }), '已依据这次批准的本机结果完成回答。');
    await rejects(prepared.text({ system: 'fixture', user: 'again' }), 'FIXED_MODEL_ALREADY_USED');
    assert.equal(modelCalls.length, 1); assert.equal(modelCalls[0].tools, undefined); assert.equal(modelCalls[0].sessionId, undefined);
    assert.doesNotMatch(JSON.stringify([prepareCalls, modelCalls, pin.target]), /SHOULD_NOT_APPEAR|apiKey|history/);
  });
  await check('provider/endpoint/config and each invalidation event invalidate old fixed model', async () => {
    for (const mutation of ['provider', 'endpoint', 'revision', 'loader/volatile-update', 'settings/document-updated', 'llm/adapters-updated', 'credentials/reference-updated']) {
      await reset(); const pin = fixed.pin(); const prepared = await pin.prepare();
      if (mutation === 'provider') selected = { provider: 'other', model: 'other' }; else if (mutation === 'endpoint') baseURL = 'https://other.test/anthropic'; else if (mutation === 'revision') revision++; else emit(mutation);
      await assert.rejects(prepared.text({ system: 'fixture', user: 'must not dispatch' }), error => ['FIXED_MODEL_STALE', 'FIXED_MODEL_UNSUPPORTED'].includes(error.code)); assert.equal(modelCalls.length, 0);
    }
  });
  await check('fixed call refuses max-token/tool/error/no finish and aborted prepare without fallback', async () => {
    for (const ending of ['max-tokens', 'tool-calls', 'error', null]) { await reset(); finish = ending; const prepared = await fixed.pin().prepare(); await rejects(prepared.text({ system: 'fixture', user: 'x' }), 'FIXED_MODEL_INCOMPLETE'); assert.equal(prepareCalls.length, 1); }
    await reset(); let release; prepareHook = () => new Promise(resolve => { release = resolve; }); const control = new AbortController(); const pending = fixed.pin({ signal: control.signal }).prepare(); await tick(); control.abort(); await rejects(pending, 'FIXED_MODEL_STALE'); release(); assert.equal(modelCalls.length, 0);
    await reset(); fixed.dispose(); fixed = createFixedModel({ ctx, timeoutMs: 10 }); prepareHook = () => new Promise(resolve => { release = resolve; }); await rejects(fixed.pin().prepare(), 'FIXED_MODEL_TIMEOUT'); release(); prepareHook = null;
    streamHook = () => new Promise(resolve => { release = resolve; }); const timed = await fixed.pin().prepare(); await rejects(timed.text({ system: 'fixture', user: 'approved only' }), 'FIXED_MODEL_TIMEOUT'); release();
  });
  await check('ordinary or disabled chat never starts extra model, and model cannot choose permission/target', async () => {
    await reset(); assert.deepEqual(await run('你好，今天想聊什么'), { handled: false }); assert.equal(prepareCalls.length, 0);
    assert.deepEqual(explicitToolRequest('请记住我喜欢茶'), []);
    for (const text of ['不要创建便签', '请不要读取文件', '你会创建便签吗？', '我昨天创建便签了', '他说现在几点是个问题']) assert.deepEqual(explicitToolRequest(text), []);
    host.dispose(); host = createToolHost({ capabilities: local, ctx, enabled: () => false }); assert.deepEqual(await run('现在几点'), { handled: false }); assert.equal(prepareCalls.length, 0);
    const descriptors = (await local.call(pet, 'tool.catalog')).tools;
    throws(() => parseToolProposal(JSON.stringify({ ...proposal, subject_binding: 'forged' }), descriptors, ['time.now']), 'TOOL_PROPOSAL_INVALID');
    throws(() => parseToolProposal(JSON.stringify({ tool_id: 'files.read_text', action: 'read', arguments: { root_id: 'guessed-root', relative_path: 'a.txt' } }), descriptors, ['files.read_text'], '读取文件a.txt'), 'TOOL_PROPOSAL_INVALID');
  });
  await check('real SQLCipher public time proposal executes once and replies to original pet without memory write', async () => {
    await reset(); const result = await run('现在几点'); await waitState('sent', result.continuationId); assert.equal(deliveries.length, 1); assert.match(deliveries[0], /UTC/); assert.equal(modelCalls.length, 1);
    assert.equal(ops.filter(op => op === 'tool.execute').length, 1); assert.ok(!ops.includes('memory.ingest')); assert.ok(!ops.includes('tool.result.export.consume'));
    const ref = incoming('现在几点', pet, 'same-event'); const again = await host.handle(ref, { deliver }); await waitState('sent', again.continuationId); const repeat = await host.handle(ref, { deliver }); assert.equal(repeat.state, 'duplicate'); assert.equal(repeat.reply, undefined); assert.equal(modelCalls.length, 2); assert.equal(deliveries.length, 2);
  });
  await check('QQ group/stranger cannot borrow owner memory or model tool authority', async () => {
    await reset(); for (const channel of [{ kind: 'qq-group', account: '999', peer: '123', principal: '123' }, { ...owner, peer: '456', principal: '456' }]) await rejects(run('现在几点', channel), 'PERMISSION_DENIED'); assert.equal(modelCalls.length, 0);
    const result = await run('现在几点', owner); await waitState('sent', result.continuationId); assert.equal(deliveries.length, 1);
  });
  await check('broker terminal outcomes preserve unknown and actionable metadata without export, reply or replay', async () => {
    for (const route of ['tool.status', 'tool.execute']) for (const state of ['unknown', 'failed', 'cancelled']) {
      await reset();
      const directory = path.join(temp, `open-outcome-${sequence}`); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'sample.txt'), 'synthetic window target');
      const root = await local.management('tool.roots.register', { path: directory, label: 'synthetic outcome' });
      proposal = { tool_id: 'local.open_directory', action: 'open', arguments: { root_id: root.root_id, relative_path: '' } };
      const ref = incoming(`请打开目录 ${root.root_id}`);
      const method = supervisor.raw;
      let terminal = null; let executeOutcomes = 0;
      // Install before handle: even its detached first step cannot reach Explorer.
      supervisor.raw = async (...args) => {
        if (args[0] === 'tool.execute') {
          ops.push(args[0]);
          if (!terminal || route !== 'tool.execute') throw new CapabilityError('CONFIRMATION_REQUIRED', 'synthetic awaiting confirmation');
          executeOutcomes++; return terminal;
        }
        if (args[0] === 'tool.status' && terminal && route === 'tool.status') { ops.push(args[0]); return terminal; }
        return method(...args);
      };
      try {
        const result = await host.handle(ref, { deliver });
        assert.equal(result.state, 'awaiting_confirmation');
        await confirmExecution(result.executionId);
        const execution = await local.call(pet, 'tool.status', { execution_id: result.executionId });
        terminal = { ...execution, state, error_code: state === 'unknown' ? 'OUTCOME_UNKNOWN' : 'REQUEST_CANCELLED', error: state === 'unknown' ? '本机工具执行结果不明，操作可能已经生效。' : '本机工具未完成。', hint: state === 'unknown' ? '请人工核对目标窗口或实际结果；不要重放旧执行，以免重复操作。' : '核验当前目标和权限。', result_id: null };
        const job = await waitState(state === 'unknown' ? 'unknown' : 'failed', result.continuationId);
        assert.equal(job.code, terminal.error_code); assert.equal(job.error, terminal.error); assert.equal(job.hint, terminal.hint);
        assert.equal(host.status().pending, 0);
        const before = ops.length; await host.poll(); await host.poll();
        assert.equal(ops.length, before);
        assert.equal((await host.handle(ref, { deliver })).state, 'duplicate');
        assert.equal(modelCalls.length, 1); assert.equal(deliveries.length, 0);
        assert.ok(!ops.some(op => op.startsWith('tool.result.export') || op === 'tool.destinations.register'));
        assert.equal(executeOutcomes, route === 'tool.execute' ? 1 : 0);
      } finally { supervisor.raw = method; }
    }
  });
  await check('private notes waits for exact action and export approval; model sees only approved result, no recalled memory', async () => {
    await reset(); const context = await local.context(pet); await local.ingest(context, 'synthetic-user-context', 'PRIVATE_MEMORY_NEVER_MODEL', { actor: 'user' }); ops = [];
    const first = await notes(); assert.match(first.reply, /等待本机确认/); assert.equal(deliveries.length, 0); assert.equal(modelCalls.length, 1); assert.ok(!ops.includes('tool.result.read'));
    await confirmExport(); await host.poll(); assert.equal(host.status().jobs[0].state, 'sent'); assert.equal(deliveries.length, 1); assert.equal(modelCalls.length, 2);
    const final = modelCalls[1]; assert.match(final.messages[0].content[0].text, /PRIVATE_RESULT/); assert.doesNotMatch(JSON.stringify(modelCalls), /PRIVATE_MEMORY_NEVER_MODEL|SHOULD_NOT_APPEAR/);
    assert.equal(final.tools, undefined); assert.equal(final.history, undefined); assert.equal(ops.filter(op => op === 'tool.result.export.consume').length, 1);
    assert.ok(!ops.includes('memory.ingest')); assert.equal((await exportRecord()).state, 'sent'); await host.poll(); assert.equal(deliveries.length, 1);
  });
  await check('precise scoped grant is reused but never grants body export', async () => {
    await reset(); const binding = await local.binding(pet); const descriptor = (await local.call(pet, 'tool.catalog')).tools.find(item => item.tool_id === 'notes.create');
    await local.management('tool.grants.create', { subject_binding: binding.session_binding, tool_id: descriptor.tool_id, action: descriptor.action, descriptor_hash: descriptor.descriptor_hash, expires_at: Date.now() + 60000, uses: 2 });
    proposal = { tool_id: 'notes.create', action: 'create', arguments: { title: 'fixture', text: 'grant body' } };
    const result = await run('请创建便签'); await waitState('awaiting_export', result.continuationId); assert.equal(ops.filter(op => op === 'tool.confirm').length, 0); assert.equal(modelCalls.length, 1); assert.equal(deliveries.length, 0);
    await reset(); proposal = { tool_id: 'notes.create', action: 'create', arguments: { title: 'fixture', text: 'grant created during wait' } }; const waiting = await run('请创建便签'); assert.equal(waiting.state, 'awaiting_confirmation');
    const subject = await local.binding(pet); const tool = (await local.call(pet, 'tool.catalog')).tools.find(item => item.tool_id === 'notes.create'); await local.management('tool.grants.create', { subject_binding: subject.session_binding, tool_id: tool.tool_id, action: tool.action, descriptor_hash: tool.descriptor_hash, expires_at: Date.now() + 60000, uses: 1 });
    await waitState('awaiting_export', waiting.continuationId); assert.equal(ops.filter(op => op === 'tool.confirm').length, 0); assert.equal(deliveries.length, 0);
  });
  await check('new input with auto-write off, role switch and policy revocation invalidate pending approval', async () => {
    for (const change of ['new-input', 'role', 'revoke']) {
      await reset(); const result = await notes();
      if (change === 'new-input') { await local.management('memory.settings', { auto_write: false }); incoming('普通新消息'); }
      else if (change === 'role') character = { id: 'different-role', epoch: 1000 };
      else await local.management('tool.emergency.stop');
      await host.poll(); assert.equal(deliveries.length, 0); assert.equal(modelCalls.length, 1); assert.ok(!ops.includes('tool.result.export.consume')); assert.notEqual(host.status().jobs[0].state, 'awaiting_export');
    }
  });
  await check('exact export TTL and changed model reject before body consumption, never renew consent', async () => {
    for (const change of ['expiry', 'endpoint']) {
      await reset(); await notes(); await confirmExport();
      if (change === 'expiry') time = (await exportRecord()).expires_at + 1; else baseURL = 'https://new.test/anthropic';
      await host.poll(); assert.equal(deliveries.length, 0); assert.equal(modelCalls.length, 1); assert.ok(!ops.includes('tool.result.export.consume')); assert.equal(ops.filter(op => op === 'tool.result.export.prepare').length, 1);
    }
  });
  await check('lost consume response is unknown once, no new read/model/destination or replay', async () => {
    await reset(); await notes(); await confirmExport();
    const method = supervisor.raw; supervisor.raw = async (...args) => { const result = await method(...args); if (args[0] === 'tool.result.export.consume') throw new CapabilityError('SERVICE_UNAVAILABLE', 'synthetic lost response'); return result; };
    try { await host.poll(); await host.poll(); assert.equal(host.status().jobs[0].state, 'unknown'); assert.equal(modelCalls.length, 1); assert.equal(deliveries.length, 0); assert.equal(ops.filter(op => op === 'tool.result.export.consume').length, 1); assert.equal((await exportRecord()).state, 'unknown'); }
    finally { supervisor.raw = method; }
  });
  await check('emergency closes synchronous ordinary capture and delayed result before transport, reset never revives it', async () => {
    await reset(); const ordinary = host.capture(); let entered; const entering = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
    onDeliver = async () => { entered(); await gate; }; const pending = run('现在几点'); await entering;
    const stopped = host.emergency('stop'); throws(() => host.validateCapture(ordinary), 'HOST_SEND_BLOCKED'); await stopped; release(); await pending;
    assert.equal(deliveries.length, 0); await host.emergency('reset'); throws(() => host.validateCapture(ordinary), 'HOST_SEND_BLOCKED'); assert.equal(host.status().jobs.length, 1);
  });
  await check('emergency during private generation cancels model output and finalizes unknown without reply', async () => {
    await reset(); await notes(); await confirmExport(); let entered; const entering = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
    streamHook = async options => { if (!options.system.startsWith('只把用户')) { entered(); await gate; } };
    const pending = host.poll(); await entering; await host.emergency('stop'); release(); await pending;
    assert.equal(deliveries.length, 0); assert.equal((await exportRecord()).state, 'unknown'); assert.equal(ops.filter(op => op === 'tool.result.export.consume').length, 1);
  });
  await check('truncated proposal/private output is actionable and never sent; pending count is bounded', async () => {
    await reset(); finish = 'max-tokens'; const result = await run('现在几点'); assert.equal(result.code, 'FIXED_MODEL_INCOMPLETE'); assert.ok(result.hint); assert.equal(deliveries.length, 0); assert.ok(!ops.includes('tool.propose'));
    await reset(); await notes(); await confirmExport(); finish = 'max-tokens'; await host.poll(); assert.equal(host.status().jobs[0].code, 'FIXED_MODEL_INCOMPLETE'); assert.equal(deliveries.length, 0);
  });
  await check('attached native pet HTTP tool result uses one reply event, exact export receipt, no history/TTS', async () => {
    let chat;
    await reset({ onInvalidate: () => chat?.invalidateTransient() }); local.toolHost = host;
    chat = createPetChatService({ ctx, stateDir: path.join(temp, 'pet-native', character.id), capabilities: local });
    const api = createPetApiService({ chat, stateDir: path.join(temp, 'pet-native', character.id), currentDshUrl: () => 'http://127.0.0.1', purpose: {} });
    const server = http.createServer((req, res) => void api.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}/dsh-surfcore/pet-api`;
    const call = async (route, body) => { const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'x-pet-token': chat.token(), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return response.json(); };
    try {
      proposal = { tool_id: 'notes.create', action: 'create', arguments: { title: 'fixture', text: 'PRIVATE_NATIVE_TOOL_RESULT' } };
      const answer = await call('/chat', { text: '请创建便签，标题fixture，内容合成材料', modality: 'voice' }); assert.equal(answer.ok, true, JSON.stringify(answer)); assert.equal(answer.memory_write, false); assert.equal(answer.reply.memory_write, false); assert.equal(answer.voice, null);
      const job = host.status().jobs[0]; await confirmExecution(job.executionId); await waitState('awaiting_export'); await confirmExport();
      const delivery = host.poll(); let result;
      for (let n = 0; n < 100; n++) { result = await call('/events?since=0&wait=0'); if (result.events?.length) break; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.equal(result.events.length, 1); assert.equal(result.events[0].type, 'reply'); assert.equal(result.events[0].memory_write, false); assert.equal(result.events[0].audio, undefined); assert.match(result.events[0].text, /批准/);
      await delivery; await waitState('sent'); assert.equal((await exportRecord()).state, 'sent'); assert.equal((await call('/events?since=0&wait=0')).events.length, 0);
      assert.doesNotMatch(JSON.stringify(chat.history()), /PRIVATE_NATIVE_TOOL_RESULT|批准的本机结果/); assert.ok(!ops.some(op => op.includes('audio')));
      assert.equal(modelCalls.filter(options => options.system.startsWith('只回答本次')).length, 1);
    } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  });
  await check('attached native pet ordinary generation and queued reply cannot escape emergency/reset', async () => {
    let chat; await reset({ onInvalidate: () => chat?.invalidateTransient() }); local.toolHost = host;
    chat = createPetChatService({ ctx, stateDir: path.join(temp, 'pet-normal', character.id), capabilities: local });
    let release; let entered; const entering = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; }); streamHook = async () => { entered(); await gate; };
    const pending = chat.chat({ text: '普通回合正在生成' }); await entering; await local.management('tool.emergency.stop'); release(); const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.code, 'HOST_SEND_BLOCKED'); await local.management('tool.emergency.reset');
    streamHook = null; const normal = await chat.chat({ text: '新的普通回合' }); assert.equal(normal.ok, true, JSON.stringify(normal));
    await chat.validateDelivery(normal); await local.management('tool.emergency.stop'); throws(() => chat.validateDeliverySync(normal), 'HOST_SEND_BLOCKED'); await local.management('tool.emergency.reset'); await rejects(chat.validateDelivery(normal), 'HOST_SEND_BLOCKED');
  });
  await check('trusted QQ channel delivers only issued fixed result through real native sender, no DSH tool history', async () => {
    let h; await reset({ onInvalidate: () => h?.localChannels.invalidate() }); local.toolHost = host;
    const keyFile = path.join(temp, `native-channel-${sequence}.key`); const channel = createChannelHandler({ capabilities: local, keyFile });
    const server = http.createServer((req, res) => void channel(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    const platform = [];
    let stopOnPlatform = false; let friendHook = null;
    class Adapter extends LocalChannelBridge { constructor(options) { super({ ...options, config: () => ({ ...options.config(), dsh: { baseUrl: base } }), keyFile, guarded: () => true, mode: () => local.mode, fetchImpl: async (url, init) => { if (String(url).startsWith(base)) return fetch(url, init); platform.push(JSON.parse(init.body)); if (stopOnPlatform) { stopOnPlatform = false; await local.management('tool.emergency.stop'); } return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1000 + platform.length } })); } }); } }
    class Bot { async sendPrivateMessage() { assert.fail('local native sends must not await unguarded SDK reconnect'); } async sendGroupMessage() { assert.fail('group unexpected'); } async raw(action) { if (action === 'get_login_info') return { user_id: 999 }; if (action === 'get_friend_list') { if (friendHook) await friendHook(); return [{ user_id: 123 }]; } return {}; } async request() { return {}; } }
    h = await bridgeHarness({ config: { ownerQQ: '123', consoleToken: 'fixture-console-token', allow: { private: ['123'], groups: [] }, sendDelayMs: 0 }, globals: { LocalChannelBridge: Adapter, SnowLumaWebSocketClient: Bot, localBackendGuarded: () => true, localBackendMode: () => local.mode } });
    h.setMode('chat'); h.setSelfIdentity('fixture-bot', 999); h.setSnowlumaHealth({ accountOnline: true });
    const consoleServer = h.startConsoleServer(); if (!consoleServer.listening) await new Promise(resolve => consoleServer.once('listening', resolve)); const consoleUrl = `http://127.0.0.1:${consoleServer.address().port}`;
    channel.deliverTool = createToolBridgeDelivery({ channelHandler: channel, callBridge: async (route, options) => { const response = await fetch(consoleUrl + route + '?token=fixture-console-token', { method: options.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }); return { ok: response.ok, status: response.status, data: await response.json() }; } });
    try {
      await h.handleIncoming('private', 123, { self_id: 999, user_id: 123, message_id: 1, message: [{ type: 'text', data: { text: '现在几点' } }] }, h.cfg);
      await waitState('sent'); assert.equal(h.calls.prompts.length, 0); assert.equal(platform.filter(item => item.message?.some(part => part.data?.text?.includes('UTC'))).length, 1); assert.ok(platform.every(item => item.user_id === 123));
      proposal = { tool_id: 'notes.create', action: 'create', arguments: { title: 'fixture', text: 'QQ_APPROVED_PRIVATE_RESULT' } };
      await h.handleIncoming('private', 123, { self_id: 999, user_id: 123, message_id: 2, message: [{ type: 'text', data: { text: '请创建便签，标题fixture，内容合成资料' } }] }, h.cfg);
      const noteJob = host.status().jobs.at(-1); await confirmExecution(noteJob.executionId); await waitState('awaiting_export', noteJob.continuationId); await confirmExport(); await host.poll(); await waitState('sent', noteJob.continuationId);
      assert.equal(platform.filter(item => item.message?.some(part => part.data?.text?.includes('批准的本机结果'))).length, 1); assert.equal((await exportRecord()).state, 'sent'); assert.equal(h.calls.prompts.length, 0);
      await h.localChannels.incoming('private:123', { self_id: 999, user_id: 123, message_id: 3 }, '新的普通消息'); const nextPrompt = await h.localChannels.prepare('private:123', 'after-private-tool', ''); assert.doesNotMatch(nextPrompt, /QQ_APPROVED_PRIVATE_RESULT|批准的本机结果/);
      const forged = await fetch(consoleUrl + '/api/tools/deliver?token=fixture-console-token', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': 'fixture-model-agent' }, body: JSON.stringify({ deliveryId: 'f'.repeat(48) }) }); assert.equal(forged.status, 403);
      const browser = await fetch(consoleUrl + '/api/tools/invalidate?token=fixture-console-token', { method: 'POST', headers: { 'content-type': 'application/json', origin: consoleUrl }, body: '{}' }); assert.equal(browser.status, 403);
      const malformed = await fetch(consoleUrl + '/api/tools/deliver?token=fixture-console-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' }); const invalid = await malformed.json(); assert.equal(malformed.status, 400); assert.equal(invalid.code, 'INVALID_REQUEST'); assert.ok(invalid.hint);
      const current = platform.length; await local.management('tool.emergency.stop'); await local.management('tool.emergency.reset');
      assert.equal(platform.length, current); assert.ok(!JSON.stringify(h.calls.prompts).includes('UTC'));
      proposal = { tool_id: 'time.now', action: 'read', arguments: {} }; let entered; const entering = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; }); friendHook = async () => { entered(); await gate; };
      await h.handleIncoming('private', 123, { self_id: 999, user_id: 123, message_id: 4, message: [{ type: 'text', data: { text: '现在几点' } }] }, h.cfg); await entering;
      const beforeStop = platform.length; await local.management('tool.emergency.stop'); release(); friendHook = null; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(platform.length, beforeStop);
      await local.management('tool.emergency.reset'); await h.localChannels.incoming('private:123', { self_id: 999, user_id: 123, message_id: 5 }, '普通分条测试'); await h.localChannels.prepare('private:123', 'burst-before-stop', ''); h.localChannels.enterSession('burst-before-stop');
      const beforeBurst = platform.length; stopOnPlatform = true; await h.sendToQQ('private:123', '甲'.repeat(2400)); assert.equal(platform.length - beforeBurst, 1, 'second delayed segment must not escape stop');
    } finally { await new Promise(resolve => consoleServer.close(resolve)); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await h.close(); }
  });
  await check('registered source-only validation preserves both auto-off burst messages but not stop/role/deletion', async () => {
    for (const change of ['none', 'stop', 'role', 'delete']) {
      await reset(); local.toolHost = host;
      const memoryContext = await local.context(pet); const seed = await local.ingest(memoryContext, `delete-marker-${sequence}`, 'synthetic marker', { actor: 'user' });
      await local.management('memory.settings', { auto_write: false });
      const keyFile = path.join(temp, `source-channel-${sequence}.key`); const handler = createChannelHandler({ capabilities: local, keyFile });
      const server = http.createServer((req, res) => void handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const adapter = new LocalChannelBridge({ config: () => ({ dsh: { baseUrl: `http://127.0.0.1:${server.address().port}` } }), keyFile, guarded: () => true, mode: () => local.mode });
      try {
        const first = await adapter.incoming('private:123', { self_id: 999, user_id: 123, message_id: 1 }, '第一条：请解释账单');
        await adapter.incoming('private:123', { self_id: 999, user_id: 123, message_id: 2 }, '第二条：请用中文');
        await rejects(adapter.request('validate', owner, { context: first.context }), 'HOST_SEND_BLOCKED');
        assert.equal((await adapter.request('sources.validate', owner, { context: first.context })).valid, true);
        const general = await adapter.request('context', owner, {}); await rejects(adapter.request('sources.validate', owner, { context: general.context }), 'PERMISSION_DENIED');
        if (change === 'stop') { await local.management('tool.emergency.stop'); await local.management('tool.emergency.reset'); }
        else if (change === 'role') { character = { id: `source-role-${sequence}`, epoch: 999 }; await local.setMode('local'); }
        else if (change === 'delete') await local.management('memory.delete', { id: seed.id, expected_revision: 1 });
        if (change === 'none') { const prompt = await adapter.prepare('private:123', `burst-${sequence}`, ''); assert.match(prompt, /第一条：请解释账单/); assert.match(prompt, /第二条：请用中文/); }
        else await assert.rejects(adapter.request('sources.validate', owner, { context: first.context }), error => ['HOST_SEND_BLOCKED', 'STALE_CHARACTER', 'STALE_CONTEXT', 'BINDING_INVALID'].includes(error.code));
        assert.equal(modelCalls.length, 0);
      } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    }
  });
  await check('real synthetic file requires exact target approval then separate body export, original file path never enters model', async () => {
    await reset(); const directory = path.join(temp, 'files'); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'fixture.txt'), 'SYNTHETIC_FILE_BODY');
    const root = await local.management('tool.roots.register', { path: directory, label: 'synthetic files' });
    proposal = { tool_id: 'files.read_text', action: 'read', arguments: { root_id: root.root_id, relative_path: 'fixture.txt' } };
    const result = await run(`请读取文件fixture.txt，登记目录ID ${root.root_id}`); assert.equal(result.state, 'awaiting_confirmation'); assert.equal(modelCalls.length, 1); assert.doesNotMatch(JSON.stringify(modelCalls), /SYNTHETIC_FILE_BODY/);
    await confirmExecution(result.executionId); await waitState('awaiting_export'); assert.equal(deliveries.length, 0);
    await confirmExport(); await host.poll(); await waitState('sent'); assert.match(modelCalls[1].messages[0].content[0].text, /SYNTHETIC_FILE_BODY/); assert.ok(!JSON.stringify(modelCalls).includes(directory));
  });
  await check('model-only or changed fixed target cannot become private result reply', async () => {
    await reset(); await notes(); await confirmExport();
    const method = supervisor.raw; supervisor.raw = async (...args) => { const result = await method(...args); if (args[0] === 'tool.result.export.consume') result.descriptor.purposes = ['model_input']; return result; };
    try { await host.poll(); assert.equal(deliveries.length, 0); assert.equal(modelCalls.length, 1); assert.equal(host.status().jobs[0].code, 'TOOL_DESTINATION_INVALID'); }
    finally { supervisor.raw = method; }
    await reset(); await notes(); await confirmExport(); streamHook = async options => { if (options.system.startsWith('只回答本次')) { revision++; emit('settings/document-updated'); } }; await host.poll(); assert.equal(deliveries.length, 0); assert.equal((await exportRecord()).state, 'unknown');
  });
  await check('pending admission and original turn TTL are bounded; stop persistence failure stays closed', async () => {
    await reset({ maxPending: 1 }); proposal = { tool_id: 'notes.list', action: 'list', arguments: {} };
    const first = await run('列出便签', pet); assert.equal(first.state, 'awaiting_confirmation'); await rejects(run('列出便签', owner), 'TOOL_HOST_BUSY');
    time += 120001; await host.poll(); assert.equal(host.status().pending, 0); assert.equal(deliveries.length, 0);
    await reset(); const ordinary = host.capture(); const method = supervisor.raw; supervisor.raw = async (...args) => { if (args[0] === 'tool.emergency.stop') throw new CapabilityError('SERVICE_UNAVAILABLE', 'synthetic persistence failure'); return method(...args); };
    try { await rejects(host.emergency('stop'), 'SERVICE_UNAVAILABLE'); await rejects(host.syncPolicy(), 'HOST_SEND_BLOCKED'); throws(() => host.validateCapture(ordinary), 'HOST_SEND_BLOCKED'); }
    finally { supervisor.raw = method; }
  });
  await check('budget await and changed original input are revalidated before any tool source reaches model', async () => {
    for (const change of ['stop', 'input', 'role']) {
      let entered; const entering = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
      await reset({ tokenBudget: { async block() { entered(); await gate; return { blocked: false }; } } });
      const pending = run('现在几点'); await entering;
      if (change === 'stop') await host.emergency('stop'); else if (change === 'input') incoming('普通新消息'); else { character = { id: 'budget-new-role', epoch: 9999 }; }
      release(); const result = await pending; assert.equal(result.ok, false); assert.equal(modelCalls.length, 0); assert.equal(ops.filter(op => op === 'tool.propose').length, 0);
    }
  });
  await check('tool voice request never invokes TTS; cached ordinary audio is gated after read before HTTP bytes', async () => {
    let chat; await reset({ onInvalidate: () => chat?.invalidateTransient() }); local.toolHost = host;
    let ttsCalls = 0;
    const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt32LE(48000, 28); wav.write('data', 36); wav.writeUInt32LE(4, 40);
    const tts = http.createServer((req, res) => { ttsCalls++; req.resume(); res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); }); await new Promise(resolve => tts.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(fixtureQqRoot, 'config.json'), JSON.stringify({ socialV2: { voice: { tts: { enabled: true, route: 'local', endpoints: { local: `http://127.0.0.1:${tts.address().port}` } } } } }));
    chat = createPetChatService({ ctx, stateDir: path.join(temp, 'pet-audio', character.id), capabilities: local });
    const api = createPetApiService({ chat, stateDir: path.join(temp, 'pet-audio', character.id), currentDshUrl: () => 'http://127.0.0.1', purpose: {} });
    const server = http.createServer((req, res) => void api.handle(req, res, new URL(req.url, 'http://127.0.0.1'))); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      proposal = { tool_id: 'notes.list', action: 'list', arguments: {} }; const pending = await chat.chat({ text: '列出便签', modality: 'voice' }); assert.equal(pending.ok, true); assert.equal(pending.voice, null); assert.equal(ttsCalls, 0);
      const ordinary = await chat.chat({ text: '普通语音请求', modality: 'voice' }); assert.equal(ordinary.ok, true, JSON.stringify(ordinary)); assert.equal(ttsCalls, 1); assert.ok(ordinary.reply.audio?.key);
      const originalRead = chat.readAudio; chat.readAudio = key => { const audio = originalRead(key); assert.ok(audio); const originalGuard = audio.guard; audio.guard = async () => { await local.management('tool.emergency.stop'); await originalGuard(); }; return audio; };
      const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-surfcore/pet-api/audio/${ordinary.reply.audio.key}.wav`, { headers: { 'x-pet-token': chat.token() } }); assert.equal(response.status, 409); const data = await response.json(); assert.equal(data.code, 'HOST_SEND_BLOCKED'); assert.ok(data.hint);
    } finally { fs.writeFileSync(path.join(fixtureQqRoot, 'config.json'), '{}'); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); tts.closeAllConnections?.(); await new Promise(resolve => tts.close(resolve)); }
  });
  await check('oversized native tool input is rejected visibly rather than silently changing the requested action', async () => {
    await reset(); local.toolHost = host;
    const chat = createPetChatService({ ctx, stateDir: path.join(temp, 'pet-limits', character.id), capabilities: local });
    const response = await chat.chat({ text: '请创建便签，内容' + '甲'.repeat(17000) }); assert.equal(response.code, 'INVALID_REQUEST'); assert.ok(response.hint); assert.equal(modelCalls.length, 0);
    const adapter = new LocalChannelBridge({ config: () => { assert.fail('oversized input must stop before any host/network call'); }, guarded: () => true, mode: () => 'local' });
    await rejects(adapter.incoming('private:123', { self_id: 999, user_id: 123, message_id: 1 }, '现在几点' + '甲'.repeat(17000)), 'INVALID_REQUEST');
  });
  await check('durable host closed intent survives unconfirmed stop/restart; reset never opens before final commit', async () => {
    const stateFile = path.join(temp, 'host-closed-intent.json'); await reset({ stateFile });
    const method = supervisor.raw; supervisor.raw = async (...args) => { if (args[0] === 'tool.emergency.stop') throw new CapabilityError('SERVICE_UNAVAILABLE', 'synthetic stop not received'); return method(...args); };
    try { await rejects(host.emergency('stop'), 'SERVICE_UNAVAILABLE'); }
    finally { supervisor.raw = method; }
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).closed, true);
    host.dispose(); host = createToolHost({ capabilities: local, ctx, stateFile }); await rejects(host.syncPolicy(), 'HOST_SEND_BLOCKED');
    let entered; const entering = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; }); let hold = true;
    supervisor.raw = async (...args) => { const result = await method(...args); if (hold && args[0] === 'tool.emergency.status') { hold = false; entered(); await gate; } return result; };
    try { const resetPending = host.emergency('reset'); await entering; assert.equal(JSON.parse(fs.readFileSync(stateFile)).closed, true); throws(() => host.validateCapture(host.capture()), 'HOST_SEND_BLOCKED'); await host.emergency('stop'); release(); await rejects(resetPending, 'HOST_SEND_BLOCKED'); assert.equal(JSON.parse(fs.readFileSync(stateFile)).closed, true); }
    finally { supervisor.raw = method; }
    await host.emergency('reset'); assert.equal(JSON.parse(fs.readFileSync(stateFile)).closed, false); host.dispose(); assert.equal(JSON.parse(fs.readFileSync(stateFile)).closed, false);
    fs.writeFileSync(stateFile, '{"version":1,"closed":false,"unexpected":true}'); host = createToolHost({ capabilities: local, ctx, stateFile }); assert.equal(host.status().persistenceFault, true); await rejects(host.emergency('reset'), 'HOST_STOP_PERSISTENCE_FAILED'); assert.equal(host.status().recoveryRequired, 'restart');
    const blockedPath = path.join(temp, 'host-write-fault.json'); host.dispose(); host = createToolHost({ capabilities: local, ctx, stateFile: blockedPath }); await host.syncPolicy(); fs.mkdirSync(blockedPath);
    await rejects(host.emergency('stop'), 'HOST_STOP_PERSISTENCE_FAILED'); assert.equal((await local.management('tool.emergency.status')).closed, true); await rejects(host.emergency('reset'), 'HOST_STOP_PERSISTENCE_FAILED');
  });
  await check('explicit local-only intent completes without preparing any model/private body export', async () => {
    await reset(); proposal = { tool_id: 'notes.create', action: 'create', arguments: { title: 'fixture', text: 'LOCAL_ONLY_BODY' } };
    const request = await run('请创建便签，只在本机保存，不要复述'); await confirmExecution(request.executionId); await waitState('local_only', request.continuationId);
    assert.equal(modelCalls.length, 1); assert.equal(deliveries.length, 0); assert.ok(!ops.includes('tool.destinations.register')); assert.ok(!ops.includes('tool.result.export.prepare'));
  });
  await check('same trusted auto-off event after host recreation is quiet duplicate before any model call', async () => {
    await reset(); await local.management('memory.settings', { auto_write: false });
    const eventId = 'stable-replayed-qq-source'; const first = await host.handle(incoming('现在几点', owner, eventId), { deliver }); await waitState('sent', first.continuationId); assert.equal(modelCalls.length, 1); assert.equal(deliveries.length, 1);
    host.dispose(); host = createToolHost({ capabilities: local, ctx, pollMs: 60000 }); await host.syncPolicy();
    const repeated = await host.handle(incoming('现在几点', owner, eventId), { deliver }); assert.equal(repeated.state, 'duplicate'); assert.equal(repeated.reply, undefined); assert.equal(modelCalls.length, 1, 'replayed trusted source must not restart proposal model'); assert.equal(deliveries.length, 1);
  });
  await check('two host contenders for one unseen trusted source create at most one execution and private effect', async () => {
    await reset(); await local.management('memory.settings', { auto_write: false }); const other = createToolHost({ capabilities: local, ctx, pollMs: 60000 }); await other.syncPolicy();
    let entered = 0; let ready; const entering = new Promise(resolve => { ready = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; }); streamHook = async () => { if (++entered === 2) ready(); await gate; };
    try {
      const first = host.handle(incoming('现在几点', owner, 'contended-event'), { deliver }); const second = other.handle(other.input(owner, { eventId: 'contended-event', text: '现在几点' }), { deliver }); await entering; release(); const results = await Promise.all([first, second]); assert.equal(results.filter(result => result.state === 'duplicate').length, 1);
      for (let n = 0; n < 100 && !deliveries.length; n++) { await host.poll(); await other.poll(); await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.equal(deliveries.length, 1); assert.equal(ops.filter(op => op === 'tool.execute').length, 1); assert.equal(modelCalls.length, 2, 'both lookups preceded the first proposal; backend CAS still prevents a second effect');
    } finally { other.dispose(); }
  });
} finally {
  host?.dispose(); fixed?.dispose(); await supervisor.stop();
  const resolved = fs.realpathSync(temp); const temporaryRoot = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase()); assert.match(path.basename(resolved), /^surfcore-tool-host-/);
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(`PASS ${count} fixed tool host checks; synthetic SQLCipher/model/transport, no real accounts, file bodies or messages.`);
