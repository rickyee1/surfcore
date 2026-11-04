import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { createModelPolicy, requestControls, verifyPrepared, verifyCallEvidence } from './a01-model-policy.mjs';
import { observeLlm, nativeControlEvidence } from './a01-native-host.mjs';
import { stageHost } from './a01-dsh-factory.mjs';
import { parity } from './a01-contract.mjs';
import { createSemanticWriter } from '../plugins/surfcore/lib/local-capabilities/semantic-writer.js';
import { readModelCall, registerModelCall } from '../plugins/surfcore/lib/local-capabilities/model-call-registry.js';

let checks = 0;
const check = async (name, action) => { await action(); console.log(`ok ${++checks} ${name}`); };
const selected = { provider: 'synthetic', model: 'exact-model', reasoningEffort: 'off' };
const policy = channel => createModelPolicy(selected, channel);
const timeout = p => ({ policyHash: p.hash, adapterIdleTimeoutMs: 60000, totalDeadlineMs: null, adapterEvidence: 'native-config' });
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const rejects = (value, code) => assert.rejects(value, e => e.code === code && Boolean(e.hint));

function fixture({ modelPolicy = null, output = '{"proposals":[]}', finish = 'stop', hold = false, mismatch = null } = {}) {
  const binding = { key: 'role:1', character_epoch: 1, generation: 1, platform: modelPolicy?.platform ?? 'pet', audience_scope: 'owner:local' };
  const source = 'event-source', calls = [], operations = []; let pending = true, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const capabilities = { mode: 'local', currentCharacter: () => ({ id: 'role', epoch: 1 }), active: { character_epoch: 1, generation: 1 }, supervisor: { async raw(op, got, payload) {
    operations.push(op); assert.equal(got, binding);
    if (op === 'memory.episodes.pending') return { auto_write: true, memory_epoch: 1, episodes: pending ? [{ id: 'e1', revision: 1, statement: '我喜欢茶', source_refs: ['event:' + source, 'writer-origin:user:' + crypto.createHash('sha256').update(source).digest('hex')] }] : [] };
    if (op === 'memory.query') return { memory_epoch: 1, memories: [] };
    if (op === 'memory.proposals.commit') { pending = false; return { memory_epoch: 1, ids: [] }; }
    if (op === 'memory.proposals.submit') assert.deepEqual(payload.proposals, []);
    return { memory_epoch: 1 };
  } } };
  const llm = {
    resolveCallWithInfo(config, info) { return { config, context: info.context }; },
    async prepareCall(config) { const prepared = { config: { ...config, ...(mismatch === 'config' ? { maxTokens: 12 } : {}) }, context: { contextWindow: mismatch === 'context' ? 123 : 1048576 }, stream: options => llm.stream(options) }; return Object.freeze(prepared); },
    stream(options) { calls.push(options); enter(); return (async function* () { if (hold) await new Promise(() => {}); yield { type: 'text-delta', text: output }; yield { type: 'finish', reason: { kind: finish } }; })(); },
  };
  const ctx = { get: key => key === 'llm' ? llm : { currentSelection: () => selected } };
  const writer = createSemanticWriter({ ctx, capabilities, modelPolicy, debounceMs: 600000 });
  writer.notify(binding);
  return { writer, calls, binding, capabilities, operations, entered, llm };
}

await check('QQ/Pet policy is frozen, exact, independently hashed and rejects unknown channel', () => {
  assert.equal(policy('qc').controls.maxTokens, 3200); assert.equal(policy('p').controls.maxTokens, 700);
  assert.equal(policy('rv').hash, policy('rg').hash); assert.notEqual(policy('p').hash, policy('qc').hash);
  assert.ok(Object.isFrozen(policy('p').controls)); assert.throws(() => createModelPolicy(selected, 'bili'), e => e.code === 'MODEL_POLICY_INVALID' && Boolean(e.hint));
});
await check('factory writes symmetric title/native idle/selection/Pet controls before activation', () => {
  fs.mkdirSync(path.resolve('.local/evidence/a01-controls-attempt1'), { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.local/evidence/a01-controls-attempt1/stage-'));
  const seedDir = path.join(temp, 'seed'); fs.mkdirSync(seedDir); fs.writeFileSync(path.join(seedDir, 'selection.json'), JSON.stringify(selected)); fs.writeFileSync(path.join(seedDir, '.credentials.yaml'), 'SYNTHETIC_NOT_A_CREDENTIAL');
  const personaFile = path.join(temp, 'persona'); fs.writeFileSync(personaFile, '合成人格');
  for (const version of ['original', 'fork']) for (const channel of ['p', 'qc']) {
    const trialDir = path.join(temp, version + channel), repo = path.join(trialDir, 'repo'); fs.mkdirSync(path.join(repo, 'plugins/surfcore'), { recursive: true });
    const staged = stageHost({ trialDir, repo, version, scene: { setup: { channel } }, trialId: version + channel, seedDir, controlToken: 'f'.repeat(64), dshPort: 1, consolePort: 2, onebot: { wsUrl: 'ws://127.0.0.1:1', baseUrl: 'http://127.0.0.1:2' }, personaFile });
    const patch = JSON.parse(fs.readFileSync(path.join(staged.env.DSH_HOME, 'profiles/web/cordis.patch.yml')));
    assert.deepEqual(patch.find(r => r.id === 'session-title-llm'), { id: 'session-title-llm', disabled: true }); assert.ok(!patch.some(r => r.id === 'session-title'));
    assert.deepEqual(patch.find(r => r.id === 'llm-deepseek').config, { streamIdleTimeoutMs: 60000, reasoningEffort: 'off' });
    const c = JSON.parse(fs.readFileSync(path.join(staged.env.DSH_HOME, 'surfcore/config.json'))); assert.equal(c.pet.chat.temperature, 0.2); assert.equal(c.pet.chat.reasoningEffort, 'off');
    assert.equal(staged.modelPolicy.hash, policy(channel).hash);
  }
});
await check('Writer still parses and commits actual JSON for each trusted platform; registry uses original options', async () => {
  for (const channel of ['p', 'qc']) {
    const f = fixture({ modelPolicy: policy(channel) }); try {
      const result = await f.writer.flush(); assert.equal(result.consumed, 1); assert.ok(f.operations.includes('memory.proposals.commit'));
      const options = f.calls[0]; assert.equal(options.maxTokens, channel === 'p' ? 700 : 3200); assert.equal(options.temperature, 0.2);
      const provenance = readModelCall(options); assert.equal(provenance.platform, channel === 'p' ? 'pet' : 'qq'); assert.equal(provenance.producer, 'semantic-writer'); assert.equal(provenance.policyHash, policy(channel).hash); assert.ok(provenance.taskId); assert.ok(Object.isFrozen(provenance));
      assert.doesNotMatch(JSON.stringify(options), /policyHash|semantic-writer|taskId|owner:local/);
    } finally { f.writer.dispose(); }
  }
});
await check('Writer rejects resolved config/context mismatch and 700-token truncation without submit', async () => {
  for (const mismatch of ['config', 'context']) { const f = fixture({ modelPolicy: policy('p'), mismatch }); try { await rejects(f.writer.flush(), 'WRITER_POLICY_MISMATCH'); assert.equal(f.calls.length, 0); assert.ok(!f.operations.includes('memory.proposals.submit')); } finally { f.writer.dispose(); } }
  const f = fixture({ modelPolicy: policy('p'), output: '{"proposals":[', finish: 'length' }); try { await rejects(f.writer.flush(), 'WRITER_MODEL_INCOMPLETE'); assert.ok(!f.operations.includes('memory.proposals.submit')); } finally { f.writer.dispose(); }
});
await check('shared owner scope never chooses platform; unknown binding is visibly rejected', () => {
  const f = fixture({ modelPolicy: policy('p') }); try { f.writer.cancel(); for (const platform of ['qq','unknown']) { f.writer.notify({ ...f.binding, platform }); assert.equal(f.writer.status().queued, 0); assert.equal(f.writer.status().lastError.code, 'WRITER_POLICY_PLATFORM'); assert.ok(f.writer.status().lastError.error); assert.ok(f.writer.status().lastError.hint); } } finally { f.writer.dispose(); }
});
await check('default production timer actually fires at 45000ms with virtual time', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture({ hold: true });
  try { const pending = f.writer.flush().catch(e => e); await f.entered; await tick(); mock.timers.tick(44999); await tick(); assert.equal(f.calls[0].signal.aborted, false); mock.timers.tick(1); assert.equal((await pending).code, 'WRITER_MODEL_TIMEOUT'); assert.equal(f.calls[0].maxTokens, 3200); assert.ok(!f.operations.includes('memory.proposals.commit')); } finally { f.writer.dispose(); mock.timers.reset(); }
});
await check('explicit null total deadline survives 90000ms; foreground and policy changes still abort, preserve lease', async () => {
  for (const action of ['foreground', 'policy']) {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const f = fixture({ modelPolicy: policy('p'), hold: true });
    try { const pending = f.writer.flush().catch(e => e); await f.entered; await tick(); mock.timers.tick(90000); await tick(); assert.equal(f.calls[0].signal.aborted, false);
      let lease;
      if (action === 'policy') f.writer.setModelPolicy(null); else lease = f.writer.begin(f.binding);
      assert.equal(f.calls[0].signal.aborted, true); assert.ok(['WRITER_DEFERRED','WRITER_POLICY_CHANGED'].includes((await pending).code));
      if (action === 'policy') { lease = f.writer.begin(f.binding); f.writer.setModelPolicy(policy('p')); }
      assert.equal(f.writer.status().foreground, 1); f.writer.end(lease); assert.equal(f.writer.status().foreground, 0); assert.ok(!f.operations.includes('memory.proposals.commit'));
    } finally { f.writer.dispose(); mock.timers.reset(); }
  }
});
function observerLlm() {
  const llm = { resolveCallWithInfo: (config, info) => ({ config, context: info.context }),
    stream(options) { assert.equal(this, llm); llm.options = options; if (options.throwSync) throw options.throwSync; return (async function* () { try { llm.resolveCallWithInfo(options, { context: { contextWindow: 1048576 } }); if (options.throwAsync) throw options.throwAsync; yield { type: 'text-delta', text: '合成' }; } finally { llm.returned = true; } })(); },
    async prepareCall(config, signal, configure) { assert.equal(this, llm); llm.configure = configure; signal?.throwIfAborted(); const prepared = { config, context: { contextWindow: 1048576 } }; let used = false; prepared.stream = function(options) { assert.equal(this, prepared); if (used) throw Object.assign(Error('one-shot'), { code: 'INVALID_PREPARED_CALL' }); used = true; return llm.originalStream.call(llm, options); }; return Object.freeze(prepared); },
  }; llm.originalStream = llm.stream; return llm;
}
await check('observer keeps object, receiver, callback, original errors, iterator.return and synchronous one-shot', async () => {
  const llm = observerLlm(), observed = observeLlm(llm), callback = () => {}, config = requestControls(policy('p')), p = await llm.prepareCall(config, undefined, callback), options = { ...p.config, messages: [], system: 'NEVER_RECORD' };
  assert.equal(llm.configure, callback); assert.equal(p.config, config);
  for await (const chunk of p.stream(options)) { assert.ok(chunk); break; } assert.equal(llm.options, options); assert.equal(llm.returned, true);
  const first = structuredClone(observed.calls[0]);
  assert.throws(() => p.stream(options), e => e.code === 'INVALID_PREPARED_CALL'); assert.deepEqual(observed.calls[0], first); assert.equal(observed.calls.at(-1).failure.code, 'INVALID_PREPARED_CALL'); assert.equal(observed.calls.at(-1).dispatched, false);
  const sync = Object.assign(Error('sync'), { code: 'SYNC' }); assert.throws(() => llm.stream({ throwSync: sync }), e => e === sync); assert.equal(observed.calls.at(-1).failure.code, 'SYNC'); assert.ok(observed.calls.at(-1).endedAt);
  const asyncError = Error('original async'); await assert.rejects(async () => { for await (const chunk of llm.stream({ throwAsync: asyncError })) void chunk; }, e => e === asyncError);
  const abort = new AbortController(); abort.abort(); await assert.rejects(llm.prepareCall({}, abort.signal), { name: 'AbortError' }); assert.doesNotMatch(JSON.stringify(observed.calls), /NEVER_RECORD|throwAsync|throwSync/); observed.restore();
});
await check('concurrent Pet/Writer scopes prefer trusted registry even without usage; no timer inheritance misattribution', async () => {
  const llm = observerLlm(), p = policy('p'), observed = observeLlm(llm, { readModelCall, tags: () => ({ modelPolicy: p }), timeoutPolicy: timeout(p) });
  await Promise.all([observed.runPet(async () => { for await (const part of llm.stream({ ...requestControls(p), messages: [] })) void part; }), observed.runPet(async () => {
    const prepared = await llm.prepareCall(requestControls(p)); const options = registerModelCall({ ...prepared.config, messages: [] }, { producer: 'semantic-writer', taskId: 'trusted-job', platform: 'pet', policyHash: p.hash }); for await (const part of prepared.stream(options)) void part;
  })]);
  assert.deepEqual(observed.calls.map(c => c.producer).sort(), ['pet-chat','semantic-writer']); assert.ok(observed.calls.every(c => c.usage === null)); assert.equal(observed.calls.find(c => c.producer === 'semantic-writer').taskId, 'trusted-job'); observed.restore();
});
await check('agent identity and native step are locked before a synchronous no-output abort', () => {
  const llm = observerLlm(), abort = Object.assign(Error('native cancelled'), { code: 'ABORTED' }), options = { sessionId: 'early-session', throwSync: abort };
  const steps = new Map([['early-session', { sessionId: 'early-session', turn: 3, step: 2 }]]);
  const observed = observeLlm(llm, { isAgentLoopRequest: request => request === options, steps });
  try { assert.throws(() => llm.stream(options), error => error === abort); const call = observed.calls[0]; assert.equal(call.producer, 'agent-loop'); assert.equal(call.sessionId, 'early-session'); assert.equal(call.turn, 3); assert.equal(call.step, 2); assert.equal(call.usage, null); assert.equal(call.output, ''); assert.equal(call.failure.code, 'ABORTED'); assert.ok(call.endedAt); }
  finally { observed.restore(); }
});
await check('unknown route/context/timeout/source and title calls cannot pass preflight/parity', () => {
  const p = policy('p'), good = { modelPolicy: p, producer: 'pet-chat', producerSource: 'pet-chat-scope', preparedConfig: requestControls(p), preparedContext: { contextWindow: 1048576 }, finalStreamControls: requestControls(p), timeoutPolicy: timeout(p) };
  assert.deepEqual(verifyCallEvidence(good, p), []);
  for (const mutate of [c => { c.preparedConfig.provider = 'unknown'; }, c => { c.preparedConfig.model = 'unknown'; }, c => { c.preparedContext = {}; }, c => { c.timeoutPolicy.adapterEvidence = 'unknown'; }, c => { c.producer = 'unknown'; }, c => { c.producer = 'session-title'; }]) { const bad = structuredClone(good); mutate(bad); assert.ok(verifyCallEvidence(bad, p).length); assert.ok(parity([{ trialId: 'bad', channel: 'p', calls: [bad] }]).length); }
  const entries = ['session-title','agent-loop','llm-deepseek'].map(id => ({ options: { id }, fiber: { state: 2, config: { streamIdleTimeoutMs: { get: () => 60000 }, reasoningEffort: { get: () => 'off' } } } }));
  const ctx = { get: () => ({ entries: () => entries }) }; assert.equal(nativeControlEvidence(ctx, p).adapterEvidence, 'native-config'); entries.push({ options: { id: 'session-title-llm' }, fiber: { state: 2 } }); assert.throws(() => nativeControlEvidence(ctx, p), e => e.code === 'NATIVE_CONTROL_NOT_VERIFIED' && Boolean(e.hint));
});
console.log(`PASS ${checks} A01 control regression groups; synthetic only, no external API.`);
