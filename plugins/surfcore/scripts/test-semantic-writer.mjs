import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { CapabilitySupervisor } from '../lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../lib/local-capabilities/facade.js';
import { createSemanticWriter, createWriterHandler, episodeActor } from '../lib/local-capabilities/semantic-writer.js';
import { createChannelHandler } from '../lib/local-capabilities/channel.js';
const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-semantic-writer-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const { createPetChatService } = await import('../lib/pet-chat.js');
const { LocalChannelBridge, channelError } = await import('../../../src/local-capabilities-bridge.js');
const { bridgeHarness } = await import('../../../scripts/audit-bridge-harness.mjs');
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'writer-0', epoch: 1 }; let seq = 0;
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const pet = { kind: 'pet', account: 'local', peer: 'local', principal: 'pet:local' };
const calls = []; let operations = []; let output = null; let finish = 'stop'; let hook = null; let writer;
const raw = supervisor.raw.bind(supervisor); supervisor.raw = async (...args) => { operations.push(args[0]); return raw(...args); };
function normal(options) { const input = JSON.parse(options.messages[0].content[0].text); const episode = input.episodes[0]; return { proposals: [{ operation: 'add', kind: 'preference', statement: '用户表示：' + episode.text.slice(0, 400), evidence: [{ source_id: episode.id, quote: episode.text.slice(0, 200) }] }] }; }
const ctx = { get(name) {
  if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture-current-provider', model: 'fixture-current-model', apiKey: 'DO_NOT_INCLUDE_PROVIDER_SECRET' }) };
  if (name === 'llm') return { stream(options) { return (async function* () {
    if (!options.system.startsWith('你是有来源的记忆整理器')) { yield { type: 'text-delta', text: '普通聊天已经正常完成。' }; yield { type: 'finish', reason: { kind: 'stop' } }; return; }
    calls.push(options); if (hook) await hook(options);
    const value = typeof output === 'function' ? output(options) : output ?? normal(options);
    yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) };
    if (finish) yield { type: 'finish', reason: { kind: finish } };
  })(); } };
  return null;
} };
let count = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++count} ${name}`); };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && Boolean(error.hint));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function reset(extra = {}) {
  writer?.dispose(); local.semanticWriter = null; character = { id: `writer-${++seq}`, epoch: seq };
  await local.setMode('local'); calls.length = 0; operations = []; output = null; finish = 'stop'; hook = null;
  writer = createSemanticWriter({ ctx, capabilities: local, debounceMs: 60000, modelTimeoutMs: 2000, ...extra }); local.semanticWriter = writer;
}
async function seed(text = '我喜欢喝茶', channel = pet, actor = 'user') { const context = await local.context(channel); return local.ingest(context, `source:${crypto.randomUUID()}`, text, { actor }); }
const writes = () => operations.filter(op => op === 'memory.proposals.submit' || op === 'memory.proposals.commit');
try {
  await check('real pending -> selected no-tools model -> atomic assertions with original source revision', async () => {
    await reset(); const source = await seed(); const result = await writer.flush(); assert.equal(result.assertions, 1); assert.equal(calls.length, 1);
    const context = await local.context(pet); assert.match(context.text, /用户表示：我喜欢喝茶/);
    const records = await local.call(pet, 'memory.query', { query: '' }); const assertion = records.memories.find(item => item.kind === 'preference');
    assert.deepEqual(assertion.derived_from, [source.id]); assert.deepEqual(assertion.source_revisions, { [source.id]: 1 });
    assert.equal((await local.call(pet, 'memory.episodes.pending', { limit: 8 })).episodes.length, 0);
    assert.equal(calls[0].provider, 'fixture-current-provider'); assert.equal(calls[0].model, 'fixture-current-model'); assert.equal(calls[0].tools, undefined); assert.equal(calls[0].reasoningEffort, 'off');
    assert.doesNotMatch(JSON.stringify(calls[0]), /DO_NOT_INCLUDE_PROVIDER_SECRET|session_binding|audience_scope/);
    writer.notify(await local.binding(pet)); await writer.flush(); assert.equal(calls.length, 1);
  });
  await check('normal empty proposals consume episodes once without inventing assertions', async () => {
    await reset(); await seed('嗯'); output = { proposals: [] }; const before = (await local.context(pet)).memory_epoch;
    const result = await writer.flush(); assert.equal(result.assertions, 0); assert.equal(result.consumed, 1); assert.equal((await local.context(pet)).memory_epoch, before);
    writer.notify(await local.binding(pet)); await writer.flush(); assert.equal(calls.length, 1);
  });
  await check('assistant/external/unknown origins are consumed without model cost or shared-experience claims', async () => {
    await reset(); for (const actor of ['assistant', 'external', 'unknown']) await seed('我们一起赢了游戏（不是用户实际经历）', pet, actor);
    const result = await writer.flush(); assert.equal(result.modelCalled, false); assert.equal(result.consumed, 3); assert.equal(calls.length, 0);
    const records = await local.call(pet, 'memory.query', {}); assert.ok(records.memories.every(item => item.kind === 'episode'));
    assert.equal(episodeActor({ source_refs: ['event:x', 'writer-origin:user:' + 'f'.repeat(64)] }), 'unknown');
  });
  await check('auto-write off and empty store never call a writer model', async () => {
    await reset(); await seed(); await local.management('memory.settings', { auto_write: false }); await writer.flush(); assert.equal(calls.length, 0);
    await local.management('memory.settings', { auto_write: true });
    await reset(); writer.notify(await local.binding(pet)); await writer.flush(); assert.equal(calls.length, 0);
  });
  await check('malformed/truncated/tool finish and unknown authority/source/duplicates have no proposal writes or automatic retry', async () => {
    const invalid = ['```json\n{"proposals":[]}\n```', opts => ({ ...normal(opts), scope: 'owner:local' }), opts => { const value = normal(opts); value.proposals[0].evidence[0].source_id = 'unknown'; return value; }, opts => { const value = normal(opts); value.proposals.push(value.proposals[0]); return value; }, opts => { const value = normal(opts); value.proposals[0].pin = true; return value; }];
    for (const value of invalid) { await reset({ debounceMs: 5 }); const lease = await local.beginTurn(pet); await seed(); output = value; local.endTurn(lease); await rejects(writer.flush(), value === invalid[0] ? 'WRITER_JSON_INVALID' : value === invalid[2] ? 'WRITER_EVIDENCE_INVALID' : 'WRITER_OUTPUT_INVALID'); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(calls.length, 1); assert.equal(writes().length, 0); }
    for (const kind of ['max-tokens', 'tool-calls', null]) { await reset(); await seed(); finish = kind; await rejects(writer.flush(), 'WRITER_MODEL_INCOMPLETE'); assert.equal(writes().length, 0); }
  });
  await check('identity, guidelines and relationship projection require grounded explicit user statements', async () => {
    for (const kind of ['identity', 'guideline', 'relationship_projection']) {
      await reset(); await seed('今天心情烦，不想讲话'); output = opts => { const value = normal(opts); value.proposals[0].kind = kind; value.proposals[0].statement = kind === 'relationship_projection' ? '用户表示关系恶化' : '用户表示一个没有明确依据的长期规则'; return value; };
      await rejects(writer.flush(), 'WRITER_EVIDENCE_INVALID'); assert.equal(writes().length, 0);
    }
    await reset(); await seed('昨天我们一起讨论了那部电影'); output = opts => { const value = normal(opts); value.proposals[0].kind = 'relationship_projection'; value.proposals[0].statement = '用户提到昨天与角色讨论过一部电影'; return value; }; await writer.flush(); assert.equal(calls.length, 1);
  });
  await check('source correction/deletion during rewriting drops old model output without refreshing epoch', async () => {
    for (const operation of ['memory.correct', 'memory.delete']) {
      await reset(); const source = await seed(); hook = async () => local.management(operation, { id: source.id, expected_revision: 1, ...(operation.endsWith('correct') ? { statement: '用户已更正' } : {}) });
      await rejects(writer.flush(), 'STALE_CONTEXT'); assert.equal(writes().length, 0);
    }
  });
  await check('source deletion after submit clears proposal body and prevents commit', async () => {
    await reset(); const source = await seed(); const method = supervisor.raw.bind(supervisor);
    supervisor.raw = async (...args) => { const result = await method(...args); if (args[0] === 'memory.proposals.submit') await local.management('memory.delete', { id: source.id, expected_revision: 1 }); return result; };
    try { await rejects(writer.flush(), 'DELETED_SOURCE'); const listed = await local.management('memory.proposals.list', {}); assert.equal(listed.proposals[0].status, 'deleted'); assert.equal(listed.proposals[0].payload, null); assert.equal((await local.context(pet)).text, ''); }
    finally { supervisor.raw = method; }
  });
  await check('foreground starting between submit and commit prevents the commit without waiting on the model', async () => {
    await reset(); await seed(); let lease; const method = supervisor.raw.bind(supervisor);
    supervisor.raw = async (...args) => { const result = await method(...args); if (args[0] === 'memory.proposals.submit') lease = await local.beginTurn(pet); return result; };
    try { await rejects(writer.flush(), 'WRITER_DEFERRED'); assert.equal(operations.filter(op => op === 'memory.proposals.commit').length, 0); assert.equal(writer.status().foreground, 1); }
    finally { supervisor.raw = method; local.endTurn(lease); }
  });
  await check('model cannot target unseen or user-pinned assertions; a new user pin during generation also wins', async () => {
    await reset(); await seed('我以前喜欢茶'); await writer.flush(); let target = (await local.call(pet, 'memory.query', {})).memories.find(item => item.kind === 'preference');
    await local.management('memory.correct', { id: target.id, expected_revision: 1, statement: '用户固定：喜欢茶' }); await seed('现在喜欢咖啡'); operations = [];
    output = opts => { const value = normal(opts); Object.assign(value.proposals[0], { operation: 'supersede', target_id: target.id, expected_revision: 2 }); return value; };
    await rejects(writer.flush(), 'WRITER_TARGET_INVALID'); assert.equal(writes().length, 0);
    output = opts => { const value = normal(opts); Object.assign(value.proposals[0], { operation: 'supersede', target_id: 'unknown-target', expected_revision: 1 }); return value; };
    await rejects(writer.flush(), 'WRITER_TARGET_INVALID');
    await reset(); await seed(); await writer.flush(); target = (await local.call(pet, 'memory.query', {})).memories.find(item => item.kind === 'preference'); await seed('现在不喜欢茶'); operations = [];
    hook = async () => local.management('memory.correct', { id: target.id, expected_revision: 1, statement: '新固定' }); output = opts => { const value = normal(opts); Object.assign(value.proposals[0], { operation: 'supersede', target_id: target.id, expected_revision: 1 }); return value; };
    await rejects(writer.flush(), 'STALE_CONTEXT'); assert.equal(writes().length, 0);
  });
  await check('different exact audience queues never merge sources or assertions', async () => {
    await reset(); await seed('PET_PRIVATE_MARKER 我喜欢茶'); const group = { kind: 'qq-group', account: '999', peer: '456', principal: '700' }; await seed('GROUP_PRIVATE_MARKER 我喜欢游戏', group);
    await writer.flush(); await writer.flush(); assert.equal(calls.length, 2);
    for (const options of calls) { const input = options.messages[0].content[0].text; assert.ok(!(input.includes('PET_PRIVATE_MARKER') && input.includes('GROUP_PRIVATE_MARKER'))); }
    const context = await local.context(group); assert.doesNotMatch(context.text, /PET_PRIVATE_MARKER/);
  });
  await check('each model batch has at most eight episodes and remaining episodes stay queued for a fresh pass', async () => {
    await reset(); for (let i = 0; i < 12; i++) await seed(`我喜欢喝茶，第${i}条经历`);
    const first = await writer.flush(); assert.equal(first.consumed, 8); assert.equal(JSON.parse(calls[0].messages[0].content[0].text).episodes.length, 8); assert.equal(writer.status().queued, 1);
    const second = await writer.flush(); assert.equal(second.consumed, 4); assert.equal(calls.length, 2); assert.equal(writer.status().queued, 0);
    await reset(); await seed(); output = opts => { const value = normal(opts); value.proposals = Array.from({ length: 7 }, (_, i) => ({ ...value.proposals[0], statement: `重复上限${i}` })); return value; }; await rejects(writer.flush(), 'WRITER_OUTPUT_INVALID'); assert.equal(writes().length, 0);
  });
  await check('valid same-scope unpinned supersede and invalidate preserve original source proofs', async () => {
    await reset(); await seed('我喜欢茶'); await writer.flush(); let target = (await local.call(pet, 'memory.query', {})).memories.find(item => item.kind === 'preference');
    const replacement = await seed('我现在喜欢咖啡'); output = opts => { const value = normal(opts); Object.assign(value.proposals[0], { operation: 'supersede', target_id: target.id, expected_revision: target.revision }); return value; };
    await writer.flush(); target = (await local.management('memory.detail', { id: target.id })).memory; assert.equal(target.revision, 2); assert.deepEqual(target.source_revisions, { [replacement.id]: 1 });
    await seed('我现在不喜欢咖啡'); output = opts => { const value = normal(opts); Object.assign(value.proposals[0], { operation: 'invalidate', target_id: target.id, expected_revision: target.revision }); delete value.proposals[0].statement; return value; };
    await writer.flush(); assert.equal((await local.management('memory.detail', { id: target.id })).memory.status, 'invalidated');
  });
  await check('budget await cannot expose sources after auto-write off, foreground begin or role change', async () => {
    for (const change of ['auto-write', 'foreground', 'role']) {
      let entered; const entering = new Promise(resolve => { entered = resolve; });
      let release; const budget = new Promise(resolve => { release = resolve; });
      await reset({ tokenBudget: { async block() { entered(); await budget; return { blocked: false }; } } });
      await seed(); const pending = writer.flush().catch(error => error); await entering;
      let lease;
      if (change === 'auto-write') await local.management('memory.settings', { auto_write: false });
      else if (change === 'foreground') lease = await local.beginTurn(pet);
      else character = { id: `budget-role-${seq}`, epoch: seq + 100 };
      release(); const result = await pending;
      local.endTurn(lease);
      assert.equal(calls.length, 0, `${change}: source body must not reach llm.stream`);
      assert.equal(writes().length, 0, `${change}: no submit or commit`);
      assert.equal(result.code, change === 'auto-write' ? 'STALE_CONTEXT' : 'WRITER_DEFERRED');
      assert.ok(result.hint);
    }
  });
  await check('foreground lease blocks commit; a new actual pet chat aborts rewriting and completes normally', async () => {
    await reset(); await seed(); const lease = await local.beginTurn(pet); await rejects(writer.flush(), 'WRITER_FOREGROUND_BUSY'); assert.equal(calls.length, 0); local.endTurn(lease);
    let release; const gate = new Promise(resolve => { release = resolve; }); hook = async () => gate;
    const pending = writer.flush().catch(error => error); while (!calls.length) await tick();
    const chat = createPetChatService({ ctx, stateDir: path.join(temp, 'pet', character.id), capabilities: local });
    const started = Date.now(); const result = await chat.chat({ text: '普通用户这轮正在说话', modality: 'text' }); assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.reply.text, /普通聊天已经正常完成/); assert.ok(Date.now() - started < 2000);
    assert.equal((await pending).code, 'WRITER_DEFERRED'); release(); await tick(); assert.equal(writes().length, 0); assert.equal(writer.status().foreground, 0);
  });
  await check('actual QQ prepare/source handles hold until real mux send/finally, then permit Writer; prepare errors release', async () => {
    await reset(); await local.setQqOwner({ account: '999', peer: '123' });
    const keyFile = path.join(temp, `channel-${seq}.key`); const channel = createChannelHandler({ capabilities: local, keyFile }); const server = http.createServer((req, res) => void channel(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}`;
    class FixtureAdapter extends LocalChannelBridge { constructor(options) { super({ ...options, config: () => ({ ...options.config(), dsh: { baseUrl } }), keyFile, guarded: () => true, mode: () => local.mode }); } }
    const h = await bridgeHarness({ config: { sendDelayMs: 0, ownerQQ: '123', allow: { private: ['123'], groups: [] } }, globals: { LocalChannelBridge: FixtureAdapter, localBackendGuarded: () => true, localBackendMode: () => 'local', __auditMuxOnce: true } });
    try {
      h.setMode('chat'); const key = 'private:123'; await seed('我喜欢旧茶', { kind: 'qq-private', account: '999', peer: '123', principal: '123' }); let release; const gate = new Promise(resolve => { release = resolve; }); hook = async () => gate;
      const background = writer.flush().catch(error => error); while (!calls.length) await tick();
      await h.localChannels.incoming(key, { self_id: 999, user_id: 123, message_id: 1 }, '我喜欢喝茶'); assert.equal((await background).code, 'WRITER_DEFERRED'); release(); await tick(); hook = null; calls.length = 0; await h.deliverPrompt(key, 'legacy prompt unused');
      assert.equal(writer.status().foreground, 1); await rejects(writer.flush(), 'WRITER_FOREGROUND_BUSY');
      const sessionId = h.state.sessions[key]; h.api.events.mux = async function* () { for (const event of [{ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '实际QQ普通回复' }] } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]) yield { payload: { type: 'session/event', sessionId, event } }; };
      await h.pumpMux(); assert.equal(h.calls.sent.length, 1); assert.equal(writer.status().foreground, 0); await writer.flush(); assert.equal(calls.length, 1);
      await h.localChannels.incoming(key, { self_id: 999, user_id: 123, message_id: 2 }, '第二条用户原话'); const request = h.localChannels.request.bind(h.localChannels);
      h.localChannels.request = async (...args) => { if (args[0] === 'sources') throw channelError('STALE_CONTEXT', 'fixture source changed'); return request(...args); };
      await rejects(h.localChannels.prepare(key, 'failed-prepare', ''), 'STALE_CONTEXT'); assert.equal(writer.status().foreground, 0);
    } finally { await h.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  });
  await check('role/backend/cancel while model is in flight aborts old work and releases queue', async () => {
    for (const mode of ['role', 'backend', 'cancel']) {
      await reset(); await seed(); let release; const gate = new Promise(resolve => { release = resolve; }); hook = async () => gate; const pending = writer.flush().catch(error => error); while (!calls.length) await tick();
      if (mode === 'role') { character = { id: `changed-${seq}`, epoch: seq + 100 }; await local.setMode('local'); } else if (mode === 'backend') await local.setMode('paused'); else writer.cancel();
      assert.equal((await pending).code, 'WRITER_DEFERRED'); release(); await tick(); assert.equal(writes().length, 0); assert.equal(writer.status().queued, 0);
    }
  });
  await check('new episodes trigger one bounded automatic pass, never an empty-store model loop', async () => {
    await reset({ debounceMs: 5 }); await seed(); for (let n = 0; n < 100 && !writer.status().lastRun; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls.length, 1); assert.equal(writer.status().queued, 0); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls.length, 1);
  });
  await check('model timeout stops work; unknown foreground deadline holds writer until real end, without provider retry', async () => {
    await reset({ modelTimeoutMs: 10 }); await seed(); let release; const gate = new Promise(resolve => { release = resolve; }); hook = async () => gate;
    await rejects(writer.flush(), 'WRITER_MODEL_TIMEOUT'); release(); await tick(); assert.equal(calls.length, 1); assert.equal(writes().length, 0); assert.equal(writer.status().running, false);
    await reset({ leaseTtlMs: 10 }); await seed(); const lease = await local.beginTurn(pet); const context = await local.context(pet); assert.equal(writer.status().foreground, 1); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(writer.status().foregroundUnknown, 1); await rejects(writer.flush(), 'WRITER_FOREGROUND_BUSY'); assert.equal(calls.length, 0); await local.validate(context); local.endTurn(lease); assert.equal(writer.status().foreground, 0);
  });
  await check('source model boundaries and original transport identity survive shared owner memory', async () => {
    await reset(); await local.shareOwner(true); await local.setQqOwner({ account: '999', peer: '123' });
    const qq = await local.binding({ kind: 'qq-private', account: '999', peer: '123', principal: '123' }); const desktop = await local.binding(pet);
    assert.equal(qq.audience_scope, 'owner:local'); assert.equal(desktop.audience_scope, 'owner:local'); assert.equal(qq.platform, 'qq'); assert.equal(qq.account, '999'); assert.equal(qq.conversation, '123'); assert.equal(desktop.platform, 'pet');
    const value = writer.status(); assert.equal(value.modelSource.model, 'fixture-current-model'); assert.match(value.dataBoundary, /无工具/);
  });
  await check('management authority cannot become an alternate writer recall scope; origin tags are event-specific', async () => {
    await reset(); writer.notify(await local.binding({ kind: 'management' })); assert.equal(writer.status().queued, 0);
    const a = await seed('第一条独立用户经历'); const b = await seed('第二条独立用户经历'); await local.management('memory.delete', { id: a.id, expected_revision: 1 });
    const second = (await local.management('memory.detail', { id: b.id })).memory; assert.equal(second.status, 'active'); assert.equal(episodeActor(second), 'user');
  });
  await check('bounded queue overflow is visible without failing new source ingestion or ordinary chat', async () => {
    await reset({ maxScopes: 1 }); await seed(); const group = { kind: 'qq-group', account: '999', peer: '456', principal: '700' }; const saved = await seed('群成员喜欢游戏', group);
    assert.ok(saved.id); assert.equal(writer.status().queued, 1); assert.equal(writer.status().lastError.code, 'WRITER_QUEUE_FULL'); assert.ok(writer.status().lastError.hint);
    await writer.flush(); await seed('群成员补充说喜欢电影', group); await writer.flush(); assert.equal((await local.call(group, 'memory.episodes.pending', { limit: 8 })).episodes.length, 0);
  });
  await check('manual HTTP accepts existing scope selector only; output errors expose code/error/hint', async () => {
    await reset(); const handler = createWriterHandler(writer);
    const invoke = async (suffix, body = {}, method = 'POST') => { const req = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req, { url: `/dsh-surfcore/api/local-capabilities/writer/${suffix}`, method }); const res = { writeHead(status) { this.status = status; }, end(value) { this.value = JSON.parse(value); } }; await handler(req, res); return res; };
    assert.equal((await invoke('status', {}, 'GET')).value.ok, true);
    const invalid = await invoke('run', { proposals: [{ kind: 'identity', statement: 'forged' }], audience_scope: 'owner:local' }); assert.equal(invalid.value.code, 'INVALID_REQUEST'); assert.ok(invalid.value.error && invalid.value.hint); assert.equal(calls.length, 0);
  });
} finally { writer?.dispose(); await supervisor.stop(); fs.rmSync(temp, { recursive: true, force: true }); }
console.log(`PASS ${count} semantic Writer checks; real isolated SQLCipher, structured model mocks, no real platform/model requests.`);
