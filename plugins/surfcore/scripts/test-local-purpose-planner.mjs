import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CapabilitySupervisor } from '../lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../lib/local-capabilities/facade.js';
import { createGovernedPurposePlanner, associatePurposeReply } from '../lib/local-purpose-planner.js';
import { createPurposeDecisionModel, parsePurposeDecision } from '../lib/local-purpose-model.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-purpose-planner-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'),
  entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'),
  env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'planner-0', epoch: 1 }, seq = 0, personaText = '', revision = 1, cancelled = false;
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const getPersona = () => ({ ...character, revision, text: personaText });
const guard = () => { if (cancelled) throw Object.assign(new Error('synthetic cancellation'), { code: 'REQUEST_CANCELLED', hint: 'restart' }); };
const planner = createGovernedPurposePlanner({ capabilities: local, getPersona, guard });
const pet = { kind: 'pet' }, qq = { kind: 'qq-private', account: '999', peer: '123', principal: '123' };
let count = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++count} ${name}`); };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && Boolean(error.hint));
async function reset() {
  character = { id: `planner-${++seq}`, epoch: seq + 1 }; personaText = ''; revision = 1; cancelled = false;
  await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
}
async function seed(text, { channel = pet, event = crypto.randomUUID(), actor = 'user', original = true } = {}) {
  return local.ingest(await local.context(channel), event, text, { actor, original });
}
const prepare = (options = {}) => planner.prepare({ channel: pet, now: Date.now(), random: () => 0, ...options });
const receiptFor = (plan, extra = {}) => ({ outreachId: crypto.randomUUID(), outcome: 'sent', at: plan.snapshot.now + 1,
  channel: { platform: 'pet', account_id: 'local', conversation_id: 'local' }, deliveryId: 'native-receipt-1',
  conversationEpoch: 'boot-one', sequence: 10, ...extra });

function modelFixture({ output = '{"decision":"send","text":"合成自然回复","pending":"none"}', finish = 'stop', mutate = () => {}, prepareMutation = async () => {} } = {}) {
  let modelName = 'fixture', configRevision = 1, baseURL = 'https://fixture.invalid/v1', provider = 'deepseek-official';
  let preparedCount = 0, streamCount = 0, captured;
  const llm = { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'fixture', settingsPath: [] }],
    async prepareCall(config) {
      preparedCount++;
      await prepareMutation();
      return { config, async *stream(input) {
        streamCount++; captured = input;
        yield { type: 'text-delta', text: output };
        mutate();
        if (finish !== null) yield { type: 'finish', reason: { kind: finish } };
      } };
    } };
  const ctx = { get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider, model: modelName }) };
    if (name === 'llm') return llm;
    if (name === 'launchEnvironment') return new Map();
    if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision: configRevision, value: { baseURL } }] };
  } };
  const adapter = createPurposeDecisionModel({ ctx, planner });
  return { adapter, stats: () => ({ preparedCount, streamCount, captured }), change(field) {
    if (field === 'provider') provider = 'other';
    if (field === 'model') modelName = 'other';
    if (field === 'config') configRevision++;
    if (field === 'endpoint') baseURL = 'https://changed.invalid';
  } };
}

try {
  await check('no Bili owner plan, persona-only and empty no-model skip', async () => {
    await reset();
    let plan = await prepare(); assert.equal(plan.purpose, null);
    const fixture = modelFixture();
    try { assert.equal((await fixture.adapter.decide(plan)).modelCalled, false); assert.equal(fixture.stats().preparedCount, 0); }
    finally { fixture.adapter.dispose(); }
    personaText = '喜欢玩游戏，学习新知识和研究插件。'; revision++;
    plan = await prepare(); assert.ok(plan.purpose); assert.ok(plan.goals.every(goal => goal.owner === 'self'));
    assert.equal(plan.lastMasterTimeKnown, false); assert.equal(plan.snapshot.lastMasterAt, null);
    assert.ok(plan.drives.connect < .5, 'unknown receipt time must not apply the engine default 24h loneliness boost');
    personaText = ''; revision++;
    await seed('明天我有面试，有点紧张');
    plan = await prepare(); assert.ok(plan.purpose); assert.ok(plan.goals.some(goal => goal.owner === 'owner'));
    assert.equal(plan.usedProofs.length, 1);
  });

  await check('all admitted proofs, deterministic rebuilding and unknown-time exclusion', async () => {
    await reset(); await seed('明天我有面试，有点紧张'); await seed('我喜欢玩游戏');
    await seed('明天要去秘密地方', { original: false });
    const now = Date.now(); const a = await prepare({ now }); const b = await prepare({ now });
    assert.equal(a.usedProofs.length, 2); assert.deepEqual(a.drives, b.drives); assert.deepEqual(a.goals, b.goals);
    assert.doesNotMatch(JSON.stringify(a.snapshot.engineItems), /秘密地方/);
    assert.ok(a.goals.every(goal => goal.evidence.every(e => e.id === 'persona' || a.snapshot.proofs[e.id])));
    assert.throws(() => { a.usedProofs.length = 0; }, TypeError);
    await rejects(planner.validate({ ...a }), 'PURPOSE_STATE_INVALID');
  });

  await check('reference pending resumes, TTL expires and legacy prose never imports', async () => {
    await reset(); await seed('明天我有面试，有点紧张');
    const initial = await prepare({ state: { pending: [{ text: '不能回填的旧秘密' }], drives: { play: 1 } } });
    assert.doesNotMatch(JSON.stringify(initial), /不能回填/);
    const receipt = receiptFor(initial);
    const state = planner.recordOutcome(initial, receipt, { pending: true });
    assert.doesNotMatch(JSON.stringify(state), /面试|紧张|text|statement|drives|observations/);
    const next = await prepare({ state, now: receipt.at + 1 });
    assert.equal(next.fromPending, true, JSON.stringify({ original: initial.purpose.id, candidates: next.candidates.map(c => ({ id: c.id, pending: c.fromPending })), receipts: next.state.receipts })); assert.equal(next.purpose.id, initial.purpose.id);
    const unrelated = await seed('不相关的过期游戏资料');
    const beyondMaterialWindow = await prepare({ state, now: receipt.at + 80 * 3600000 });
    assert.equal(beyondMaterialWindow.fromPending, true, 'pending keeps its proved source beyond the ordinary 72h material window');
    assert.equal(beyondMaterialWindow.materials[0].at, initial.materials[0].at, 'receipt time is never refreshed');
    assert.doesNotMatch(JSON.stringify(beyondMaterialWindow.materials), /不相关的过期/);
    assert.ok(!beyondMaterialWindow.usedProofs.some(proof => proof.id === unrelated.id));
    assert.equal(beyondMaterialWindow.lastMasterTimeKnown, false, 'old bounded material does not prove silence');
    const trustedActivity = await prepare({ state, now: receipt.at + 80 * 3600000, lastOwnerActivityAt: receipt.at });
    assert.equal(trustedActivity.lastMasterTimeKnown, true);
    assert.ok(trustedActivity.drives.connect > beyondMaterialWindow.drives.connect);
    const continuedState = planner.recordOutcome(beyondMaterialWindow, receiptFor(beyondMaterialWindow), { pending: true });
    const continuedAgain = await prepare({ state: continuedState, now: receipt.at + 81 * 3600000 });
    assert.equal(continuedAgain.fromPending, true);
    const expired = await prepare({ state, now: receipt.at + 15 * 86400000 });
    assert.equal(expired.fromPending, false); assert.equal(expired.state.receipts.length, 0);
    assert.throws(() => planner.recordOutcome(initial, receipt), /真实载体终态/);
    const another = await prepare();
    assert.throws(() => planner.recordOutcome(another, { ...receiptFor(another), channel: { platform: 'qq', account_id: '999', conversation_id: '123' } }), /原实际目的地/);
  });

  await check('correction and deletion remove old text, pending and numeric contributions', async () => {
    await reset(); const saved = await seed('我喜欢咖啡，想玩咖啡游戏');
    const initial = await prepare(); const receipt = receiptFor(initial);
    const state = planner.recordOutcome(initial, receipt, { pending: true });
    await local.management('memory.correct', { id: saved.id, expected_revision: 1, statement: '我现在喜欢茶' });
    await rejects(planner.validate(initial), 'STALE_CONTEXT');
    const corrected = await prepare({ state });
    assert.doesNotMatch(JSON.stringify(corrected), /咖啡/); assert.equal(corrected.state.receipts.length, 0);
    assert.equal(corrected.snapshot.timelessBackground[0].text, '我现在喜欢茶');
    await local.management('memory.delete', { id: saved.id, expected_revision: 2 });
    const removed = await prepare({ state }); assert.equal(removed.purpose, null); assert.equal(removed.usedProofs.length, 0);
    await reset(); const empty = await prepare(); assert.deepEqual(removed.drives, empty.drives);
  });

  await check('pending unknown consumes continuation; explicit completion closes matching goal', async () => {
    await reset(); await seed('明天我有面试，有点紧张');
    const plan = await prepare(); const sent = receiptFor(plan);
    const state = planner.recordOutcome(plan, sent, { pending: true });
    const pending = await prepare({ state, now: sent.at + 1 });
    assert.equal(pending.fromPending, true);
    const unknown = planner.recordOutcome(pending, receiptFor(pending, { outcome: 'unknown' }), { pending: true });
    assert.ok(unknown.receipts.every(row => row.pendingUntil === null));
    const afterUnknown = await prepare({ state: unknown, now: sent.at + 5 });
    assert.equal(afterUnknown.fromPending, false);
    assert.ok(!afterUnknown.candidates.some(candidate => candidate.id === pending.purpose.id));
    assert.equal(afterUnknown.purpose, null);
    const completing = await prepare({ state, now: sent.at + 1 });
    const done = planner.recordOutcome(completing, receiptFor(completing), { completed: true });
    const finished = await prepare({ state: done, now: sent.at + 5 });
    assert.equal(finished.goals.find(goal => goal.id === plan.purpose.goalId).status, 'done');
    assert.ok(!finished.candidates.some(candidate => candidate.id === plan.purpose.id));
    assert.ok(done.receipts.every(row => row.pendingUntil === null));
  });

  await check('shared QQ reads Pet original; unshared new source and other conversations stay isolated', async () => {
    await reset(); await local.shareOwner(true); await seed('明天我有面试');
    const shared = await prepare({ channel: qq }); assert.ok(shared.purpose);
    await local.shareOwner(false); await seed('我想玩独有桌宠秘密游戏');
    await seed('其他人的私聊秘密', { channel: { ...qq, peer: '777', principal: '777' } });
    const isolated = await prepare({ channel: qq }); assert.doesNotMatch(JSON.stringify(isolated), /独有桌宠|其他人的/);
    await rejects(planner.validate(shared), 'STALE_CHARACTER');
  });

  await check('auto-write false reads existing sources but planner never writes body or pending', async () => {
    await reset(); await seed('明天我有面试'); await local.management('memory.settings', { auto_write: false });
    const before = await local.management('memory.export');
    const plan = await prepare(); assert.ok(plan.purpose);
    const state = planner.recordOutcome(plan, receiptFor(plan), { pending: true });
    assert.doesNotMatch(JSON.stringify(state), /面试|text|statement/);
    assert.deepEqual(await local.management('memory.export'), before);
  });

  await check('only actual sent and proved same-conversation owner reply changes matching goal', async () => {
    await reset(); await seed('明天我有面试，有点紧张');
    const plan = await prepare(); assert.ok(plan.purpose.goalId);
    const receipt = receiptFor(plan, { at: plan.snapshot.now });
    const state = planner.recordOutcome(plan, receipt, { pending: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    const reply = await seed('不想聊这个，别再提了', { event: 'reply-negative' });
    const unlinked = await prepare({ state });
    const base = unlinked.goals.find(goal => goal.id === plan.purpose.goalId);
    assert.notEqual(base.status, 'rejected');
    const badSequence = associatePurposeReply(state, { outreachId: receipt.outreachId, eventId: 'reply-negative', kind: 'next-input', conversationEpoch: 'boot-one', sequence: 12 });
    assert.equal(badSequence.receipts[0].feedback.length, 0);
    const staleBoot = associatePurposeReply(state, { outreachId: receipt.outreachId, eventId: 'reply-negative', kind: 'next-input', conversationEpoch: 'new-boot', sequence: 11 });
    assert.equal(staleBoot.receipts[0].feedback.length, 0);
    const linked = associatePurposeReply(state, { outreachId: receipt.outreachId, eventId: 'reply-negative', kind: 'reply', replyTo: receipt.deliveryId });
    const rejected = await prepare({ state: linked });
    assert.equal(rejected.goals.find(goal => goal.id === plan.purpose.goalId).status, 'rejected');
    assert.equal(rejected.state.receipts[0].pendingUntil, null);
    assert.ok(!rejected.candidates.some(candidate => candidate.goalId === plan.purpose.goalId));
    const repeated = await prepare({ state: rejected.state, now: rejected.snapshot.now });
    assert.deepEqual(repeated.goals, rejected.goals);
    await local.management('memory.delete', { id: reply.id, expected_revision: 1 });
    const removed = await prepare({ state: linked });
    assert.notEqual(removed.goals.find(goal => goal.id === plan.purpose.goalId).status, 'rejected');
  });

  await check('unknown receipt, other-origin reply, derived reply and silence provide no feedback', async () => {
    await reset(); await local.shareOwner(true); await seed('明天我有面试');
    const plan = await prepare(); const receipt = receiptFor(plan, { at: plan.snapshot.now });
    const unknown = planner.recordOutcome(plan, { ...receipt, outcome: 'unknown' }, { pending: true });
    assert.equal(unknown.receipts[0].pendingUntil, null);
    assert.equal(associatePurposeReply(unknown, { outreachId: receipt.outreachId, eventId: 'x', kind: 'reply', replyTo: receipt.deliveryId }).receipts[0].feedback.length, 0);
    const sent = planner.recordOutcome(await prepare({ now: plan.snapshot.now }), receipt);
    await seed('好呀', { event: 'other-origin', channel: qq });
    await seed('好呀，我同意', { event: 'not-original', original: false });
    for (const eventId of ['other-origin', 'not-original', 'missing']) {
      const linked = associatePurposeReply(sent, { outreachId: receipt.outreachId, eventId, kind: 'reply', replyTo: receipt.deliveryId });
      const next = await prepare({ state: linked });
      const unchanged = await prepare({ state: sent, now: next.snapshot.now });
      assert.deepEqual(next.goals, unchanged.goals);
    }
  });

  await check('uninterrupted same-epoch original positive reply applies once; persona revision retires pending', async () => {
    await reset(); await seed('明天我有面试');
    const plan = await prepare(); const receipt = receiptFor(plan, { at: plan.snapshot.now });
    const state = planner.recordOutcome(plan, receipt, { pending: true });
    await new Promise(resolve => setTimeout(resolve, 5)); await seed('好呀，可以', { event: 'positive-reply' });
    const plain = await prepare({ state });
    const association = { outreachId: receipt.outreachId, eventId: 'positive-reply', kind: 'next-input', conversationEpoch: 'boot-one', sequence: 11 };
    const linked = associatePurposeReply(associatePurposeReply(state, association), association);
    assert.equal(linked.receipts[0].feedback.length, 1);
    const confirmed = await prepare({ state: linked, now: plain.snapshot.now });
    assert.ok(confirmed.goals.find(goal => goal.id === plan.purpose.goalId).confidence > plain.goals.find(goal => goal.id === plan.purpose.goalId).confidence);
    assert.equal(confirmed.goals.find(goal => goal.id === plan.purpose.goalId).status, 'confirmed');
    revision++;
    const changed = await prepare({ state: linked }); assert.equal(changed.state.receipts.length, 0); assert.equal(changed.fromPending, false);
  });

  await check('strict decision JSON, send, skip, malformed and truncated output', async () => {
    for (const value of ['{}', 'null', '[]', '```json\n{}\n```', '{"decision":"skip","text":"hidden"}',
      '{"decision":"send","text":"hi","pending":"none","recipient":"other"}', '{"decision":"send","text":" ","pending":"none"}',
      JSON.stringify({ decision: 'send', text: 'a'.repeat(801), pending: 'none' })])
      assert.throws(() => parsePurposeDecision(value), error => error.code === 'PURPOSE_DECISION_INVALID' && Boolean(error.hint));
    await reset(); personaText = '喜欢学习知识';
    for (const options of [{}, { output: '{"decision":"skip"}' }, { output: '{"decision":' }, { finish: 'max-tokens' }, { finish: null }]) {
      const fixture = modelFixture(options); const plan = await prepare();
      try {
        if (options.finish === null || options.finish === 'max-tokens') await rejects(fixture.adapter.decide(plan), 'FIXED_MODEL_INCOMPLETE');
        else if (options.output === '{"decision":') await rejects(fixture.adapter.decide(plan), 'PURPOSE_DECISION_INVALID');
        else {
          const result = await fixture.adapter.decide(plan); assert.equal(result.modelCalled, true);
          assert.equal(result.decision, options.output ? 'skip' : 'send');
          assert.equal(fixture.stats().streamCount, 1);
          assert.equal(fixture.stats().captured.messages.length, 1);
          assert.ok(!('tools' in fixture.stats().captured));
          assert.doesNotMatch(JSON.stringify(fixture.stats().captured), /session_binding|host_gate|character_epoch|ingress_token/);
          await rejects(fixture.adapter.decide(plan), 'PURPOSE_DECISION_USED');
          assert.equal(fixture.stats().streamCount, 1);
        }
      } finally { fixture.adapter.dispose(); }
    }
  });

  await check('fixed provider/model/config/endpoint and original persona after all model waits', async () => {
    await reset(); personaText = '喜欢学习知识';
    for (const field of ['provider', 'model', 'config', 'endpoint']) {
      const fixture = modelFixture(); const plan = await prepare();
      try {
        await assert.rejects(fixture.adapter.decide(plan, { beforeModel: async () => fixture.change(field) }), error => error.code.startsWith('FIXED_MODEL_') && Boolean(error.hint));
        assert.equal(fixture.stats().preparedCount, 0);
      } finally { fixture.adapter.dispose(); }
    }
    const changedPersona = modelFixture({ mutate: () => { personaText += '喜欢运动'; revision++; } });
    try { await rejects(changedPersona.adapter.decide(await prepare()), 'STALE_PERSONA'); }
    finally { changedPersona.adapter.dispose(); }
    const cancelledModel = modelFixture({ mutate: () => { cancelled = true; } });
    try { await rejects(cancelledModel.adapter.decide(await prepare(), { guard }), 'REQUEST_CANCELLED'); }
    finally { cancelledModel.adapter.dispose(); cancelled = false; }
  });

  await check('unselected source deletion and original activity cancellation invalidate whole plan', async () => {
    await reset(); await seed('明天我有面试'); const other = await seed('我喜欢喝茶');
    const plan = await prepare(); assert.equal(plan.usedProofs.length, 2);
    await local.management('memory.delete', { id: other.id, expected_revision: 1 });
    const fixture = modelFixture();
    try { await rejects(fixture.adapter.decide(plan), 'STALE_CONTEXT'); assert.equal(fixture.stats().preparedCount, 0); }
    finally { fixture.adapter.dispose(); }
    const current = await prepare(); cancelled = true;
    await rejects(planner.validate(current), 'REQUEST_CANCELLED');
  });

  await check('source/persona changes in preparation and cancellation at final source await block model dispatch', async () => {
    await reset(); const source = await seed('明天我有面试'); const plan = await prepare();
    const deleting = modelFixture({ prepareMutation: () => local.management('memory.delete', { id: source.id, expected_revision: 1 }) });
    try { await rejects(deleting.adapter.decide(plan), 'STALE_CONTEXT'); assert.equal(deleting.stats().streamCount, 0); }
    finally { deleting.adapter.dispose(); }
    await reset(); personaText = '喜欢玩游戏';
    const changing = modelFixture({ prepareMutation: async () => { revision++; } });
    try { await rejects(changing.adapter.decide(await prepare()), 'STALE_PERSONA'); assert.equal(changing.stats().streamCount, 0); }
    finally { changing.adapter.dispose(); }
    const current = await prepare();
    const raw = supervisor.raw.bind(supervisor);
    let validations = 0;
    supervisor.raw = async (...args) => {
      const result = await raw(...args);
      if (args[0] === 'context.validate' && ++validations === 2) cancelled = true;
      return result;
    };
    const fixture = modelFixture();
    try { await rejects(fixture.adapter.decide(current), 'REQUEST_CANCELLED'); assert.equal(fixture.stats().preparedCount, 0); }
    finally { supervisor.raw = raw; fixture.adapter.dispose(); cancelled = false; }
  });

  await check('prepare-time activity and signal cannot be replaced at later validation', async () => {
    await reset(); personaText = '喜欢读书';
    let runAlive = true;
    const runGuard = () => { if (!runAlive) throw Object.assign(new Error('retired run'), { code: 'REQUEST_CANCELLED', hint: 'fresh run' }); };
    const first = await prepare({ guard: runGuard }); runAlive = false;
    await rejects(planner.validate(first, { guard: () => {} }), 'REQUEST_CANCELLED');
    const control = new AbortController();
    const second = await prepare({ signal: control.signal }); control.abort();
    await rejects(planner.validate(second, { signal: new AbortController().signal, guard: () => {} }), 'REQUEST_CANCELLED');
  });
  await check('CP1 terminal survives unrelated retirement, reload, history rotation and bounded eviction', async () => {
    for (const outcome of ['unknown', 'done']) {
      await reset(); const target = await seed('明天我有面试，有点紧张'); const tea = await seed('我喜欢喝茶');
      const plan = await prepare(); const receipt = receiptFor(plan, { outcome: outcome === 'unknown' ? 'unknown' : 'sent' });
      const saved = planner.recordOutcome(plan, receipt, { completed: outcome === 'done' });
      await local.management('memory.delete', { id: tea.id, expected_revision: 1 });
      let state = JSON.parse(JSON.stringify(saved));
      let next = await prepare({ state, now: receipt.at + 10 });
      assert.ok(!next.candidates.some(candidate => candidate.id === plan.purpose.id));
      assert.equal(Object.keys(next.state.terminals).length, 1);
      assert.ok(next.usedProofs.some(proof => proof.id === target.id));
      state = JSON.parse(JSON.stringify(next.state));
      const extra = [];
      for (let i = 0; i < 21; i++) extra.push(await seed(`无关新素材编号${i}`, { original: false }));
      const evicted = await prepare({ state });
      assert.ok(!evicted.snapshot.context.records.some(record => record.id === target.id));
      assert.equal(Object.keys(evicted.state.terminals).length, 1);
      state = JSON.parse(JSON.stringify(evicted.state));
      for (const record of extra) await local.management('memory.delete', { id: record.id, expected_revision: 1 });
      next = await prepare({ state }); assert.ok(next.usedProofs.some(proof => proof.id === target.id));
      assert.ok(!next.candidates.some(candidate => candidate.id === plan.purpose.id));
      if (outcome === 'done') assert.equal(next.goals.find(goal => goal.id === plan.purpose.goalId).status, 'done');
      // Identity is source-version based, so genuinely new source evidence may
      // form a fresh goal even if the pure engine's semantic goal ID is reused.
      await seed('明天我有面试，有点紧张', { event: `new-interview-${outcome}` });
      const revised = await prepare({ state }); assert.ok(revised.purpose);
    }
  });

  await check('CP2 real final source RPC microtasks preserve original cancellation and target guard', async () => {
    for (const mode of ['signal', 'guard']) for (const depth of [3, 4, 5, 6]) {
      await reset(); await seed('明天我有面试');
      const control = new AbortController(); let live = true;
      const runGuard = () => { if (!live) throw Object.assign(new Error('retired run'), { code: 'REQUEST_CANCELLED', hint: 'new run' }); };
      const plan = await prepare({ signal: control.signal, guard: runGuard });
      const raw = supervisor.raw.bind(supervisor); let validations = 0;
      const later = (n, action) => n ? queueMicrotask(() => later(n - 1, action)) : action();
      supervisor.raw = async (...args) => {
        const result = await raw(...args);
        if (args[0] === 'context.validate' && ++validations === 8)
          later(depth, () => { if (mode === 'signal') control.abort(); else live = false; });
        return result;
      };
      const fixture = modelFixture();
      try {
        let result;
        try { result = await fixture.adapter.decide(plan, { signal: new AbortController().signal, guard: () => {} }); }
        catch (error) { assert.equal(error.code, 'REQUEST_CANCELLED'); assert.ok(error.hint); }
        assert.equal(control.signal.aborted || !live, true);
        if (result) assert.throws(() => result.validateTarget(), error => error.code === 'REQUEST_CANCELLED');
        assert.throws(() => planner.checkpoint(plan), error => error.code === 'REQUEST_CANCELLED');
        assert.equal(fixture.stats().streamCount, 1);
      } finally { supervisor.raw = raw; fixture.adapter.dispose(); }
    }
  });
  console.log(`PASS ${count} governed planner/model checks; isolated SQLCipher fixture ${temp}`);
} finally { await supervisor.stop(); }
