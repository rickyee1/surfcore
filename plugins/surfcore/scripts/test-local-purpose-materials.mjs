import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { CapabilitySupervisor } from '../lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../lib/local-capabilities/facade.js';
import { createLocalPurposeMaterials } from '../lib/local-purpose-materials.js';
import { analyzePersona, deriveDrives, formGoalHypotheses, minePurposeSeeds, selectPurpose } from '../../../src/purpose-engine.js';

// Real disposable stdio/SQLCipher service. No profiles/accounts/models/devices.
const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-purpose-materials-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'),
  entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'),
  env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'materials-0', epoch: 1 }, seq = 0, personaRevision = 1, personaText = '喜欢学习和研究游戏。';
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const getPersona = () => ({ ...character, revision: personaRevision, text: personaText });
const adapter = createLocalPurposeMaterials({ capabilities: local, getPersona });
const pet = { kind: 'pet' }, qq = { kind: 'qq-private', account: '999', peer: '123', principal: '123' };
const publicChannel = { kind: 'bili', account: 'synthetic', peer: 'public', principal: 'reader' };
const group = { kind: 'qq-group', account: '999', peer: '456', principal: '123' };
const tokens = new Set(); let operations = [];
const raw = supervisor.raw.bind(supervisor);
supervisor.raw = async (...args) => { operations.push(args[0]); const result = await raw(...args); if (result.ingress_token) tokens.add(result.ingress_token); return result; };
let count = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++count} ${name}`); };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && Boolean(error.hint));
async function reset() {
  character = { id: `materials-${++seq}`, epoch: seq + 1 }; personaRevision = 1;
  await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  operations = [];
}
async function seed(text, { channel = pet, actor = 'user', original = true, event = crypto.randomUUID(), derivedFrom = [] } = {}) {
  return local.ingest(await local.context(channel), event, text, { actor, original, derivedFrom });
}
const snapshot = (options = {}) => adapter.snapshot({ channel: pet, now: Date.now(), ...options });
try {
  await check('bounded ordinary facade rejects selectors, management and invalid limits', async () => {
    await reset();
    for (const limit of [0, 51, 1.5, '20', NaN]) await rejects(local.materials(pet, { limit }), 'INVALID_REQUEST');
    await rejects(local.materials(pet, { limit: 2, audience_scope: 'owner:local' }), 'INVALID_REQUEST');
    await rejects(local.materials({ kind: 'management' }), 'PERMISSION_DENIED');
    await rejects(local.management('memory.materials'), 'PERMISSION_DENIED');
    await rejects(local.management('memory.ingress.open'), 'PERMISSION_DENIED');
    const empty = await snapshot(); assert.deepEqual(empty.engineItems, []); assert.equal(empty.lastMasterAt, null);
    assert.equal(await adapter.validate(empty), true);
  });
  await check('trusted host explicitly opts in; default actor labels remain unknown', async () => {
    await reset();
    const legacy = await seed('旧调用写着明天考试，并非可信原话', { original: false });
    const original = await seed('明天我有面试，有点紧张');
    const ctx = await local.materials(pet);
    assert.equal(ctx.records.find(row => row.id === legacy.id).source_metadata.time_basis, 'unknown');
    assert.equal(ctx.records.find(row => row.id === original.id).source_metadata.statement_origin, 'original');
    const result = await snapshot(); assert.equal(result.engineItems.length, 1); assert.equal(result.engineItems[0].kind, 'owner');
    assert.equal(result.coverage.unknown_time_excluded, 1); assert.equal(result.proofs[result.engineItems[0].id].id, original.id);
    assert.equal(result.materials.items, result.engineItems); assert.ok(Object.isFrozen(result.proofs));
    assert.throws(() => { result.persona.revision = 900; }, TypeError);
    for (const token of tokens) {
      assert.ok(!JSON.stringify([result, ctx, legacy, original, local.status(), await local.management('memory.export')]).includes(token));
      assert.ok(!fs.readFileSync(local.stateFile, 'utf8').includes(token));
    }
    assert.equal(operations.filter(op => op === 'memory.ingress.open').length, 1);
  });
  await check('conflicting original claims fail before credential opening or writing', async () => {
    await reset(); const source = await seed('真实原始输入'); const context = await local.context(pet);
    const before = operations.length;
    for (const options of [{ original: true }, { actor: 'user', original: 'true' },
      { actor: 'user', original: true, derivedFrom: [{ id: source.id, revision: 1 }] }])
      await rejects(local.ingest(context, 'bad', '不该写入', options), 'INVALID_REQUEST');
    await rejects(local.ingest(context, 'bad', '不该写入', { original: true, actor: 'external' }), 'PERMISSION_DENIED');
    const management = { binding: await local.binding({ kind: 'management' }), memory_epoch: context.memory_epoch };
    await rejects(local.ingest(management, 'bad', '管理不是原话', { original: true, actor: 'user' }), 'PERMISSION_DENIED');
    const pub = await local.context(publicChannel);
    await rejects(local.ingest(pub, 'bad', '外部不是用户', { original: true, actor: 'user' }), 'PERMISSION_DENIED');
    assert.equal(operations.slice(before).filter(op => op === 'memory.ingest' || op === 'memory.ingress.open').length, 0);
  });
  await check('Pet original plan reaches shared QQ and pure derive/form/mine/select without Bili', async () => {
    await reset(); await local.shareOwner(true); await seed('明天我有面试，有点紧张');
    const result = await snapshot({ channel: qq }); assert.equal(result.engineItems.length, 1);
    const persona = analyzePersona(result.persona.text);
    const derived = deriveDrives({ materials: result.engineItems, now: result.now, lastMasterAt: result.lastMasterAt, personaBias: persona.bias });
    const formed = formGoalHypotheses({ materials: result.engineItems, persona, now: result.now, drives: derived.drives, lastMasterAt: result.lastMasterAt });
    const seeds = minePurposeSeeds({ materials: result.engineItems, now: result.now, drives: derived.drives, lastMasterAt: result.lastMasterAt });
    const selected = selectPurpose({ seeds, goals: formed.goals, now: result.now, drives: derived.drives, lastMasterAt: result.lastMasterAt, random: () => 0 });
    assert.ok(selected.purpose); assert.ok(formed.goals.some(goal => goal.owner === 'owner'));
    assert.match(result.engineItems[0].id, /:r1$/); assert.match(seeds[0].sourceId, /:r1$/);
    assert.ok(formed.goals.some(goal => goal.evidence?.some(item => item.id === result.engineItems[0].id)));
    assert.equal(result.engineItems[0].source, 'local');
    for (const key of ['needAffinity', 'selfRef', 'topic', 'cues']) assert.ok(key in result.engineItems[0]);
    assert.equal(result.engineItems[0].meta.internalOnly, true);
    await local.shareOwner(false); await seed('关闭共享后的桌宠私有新计划');
    assert.doesNotMatch(JSON.stringify((await snapshot({ channel: qq })).engineItems), /关闭共享后的/);
    await rejects(adapter.validate(result), 'STALE_CHARACTER');
  });
  await check('other role/private peer/group cannot leak into destination material', async () => {
    await reset(); await local.shareOwner(true); await seed('主人合成计划');
    await seed('他人私聊秘密', { channel: { ...qq, peer: '777', principal: '777' } });
    await seed('另一群内容', { channel: group });
    const result = await snapshot({ channel: qq }); assert.equal(result.engineItems.length, 1);
    assert.doesNotMatch(JSON.stringify(result.context.records), /他人私聊秘密|另一群内容/);
    character = { id: `other-${seq}`, epoch: 99 }; await local.setMode('local');
    assert.equal((await snapshot({ channel: qq })).context.records.length, 0);
    await rejects(adapter.validate(result), 'STALE_CHARACTER');
  });
  await check('assistant is self; public external is media; group unknown never owner', async () => {
    await reset(); await seed('我下次会告诉你研究结果', { actor: 'assistant' });
    await seed('公开视频作者想玩游戏', { channel: publicChannel, actor: 'external' });
    await seed('明天我有考试', { channel: group });
    const self = await snapshot(); assert.ok(self.engineItems.some(item => item.kind === 'self'));
    const media = await snapshot({ channel: publicChannel }); assert.equal(media.engineItems[0].kind, 'video');
    assert.equal(media.proofs[media.engineItems[0].id].attribution.owner, false);
    const unknown = await snapshot({ channel: group }); assert.ok(unknown.engineItems.every(item => item.kind !== 'owner'));
    assert.ok(unknown.coverage.attribution_excluded > 0);
    assert.ok(self.engineItems.some(item => item.source === 'bili'), 'public proof stays authorized under original destination binding');
    for (const result of [self, media, unknown]) {
      const goals = formGoalHypotheses({ materials: result.engineItems, now: result.now, lastMasterAt: result.lastMasterAt }).goals;
      assert.ok(goals.every(goal => goal.owner !== 'owner'));
      assert.equal(await adapter.validate(result), true);
    }
  });
  await check('revised and derived knowledge never become original owner speech', async () => {
    await reset(); const source = await seed('我喜欢咖啡');
    const before = await snapshot();
    await local.management('memory.correct', { id: source.id, expected_revision: 1, statement: '我现在喜欢茶' });
    await rejects(adapter.validate(before), 'STALE_CONTEXT');
    const revised = await snapshot(); assert.equal(revised.engineItems.length, 0);
    assert.equal(revised.timelessBackground[0].statementOrigin, 'revised');
    assert.equal(revised.timelessBackground[0].at, null); assert.equal(revised.timelessBackground[0].verbatim, false);
    const child = await seed('派生：主人一直喜欢茶', { original: false, derivedFrom: [{ id: source.id, revision: 2 }] });
    await local.management('memory.correct', { id: child.id, expected_revision: 1, statement: '主人喜欢茶' });
    const result = await snapshot(); assert.equal(result.engineItems.length, 0);
    const item = result.timelessBackground.find(item => item.id.includes(child.id));
    assert.equal(item.statementOrigin, 'derived'); assert.equal(result.proofs[item.id].source_revisions[source.id], 2);
    assert.ok(formGoalHypotheses({ materials: result.engineItems, now: result.now }).goals.every(goal => goal.owner !== 'owner'));
  });
  await check('old unknown pinned knowledge stays timeless; known receipts expire at purpose window', async () => {
    await reset(); const unknown = await seed('明天我有大事', { original: false });
    await local.management('memory.correct', { id: unknown.id, expected_revision: 1, statement: '旧记录说明：喜欢读书' });
    const known = await seed('明天我有面试');
    const result = await snapshot({ now: Date.now() + 80 * 3600000 });
    assert.equal(result.engineItems.length, 0); assert.equal(result.timelessBackground.length, 1);
    assert.equal(result.lastMasterAt, null); assert.equal(result.coverage.expired_count, 1);
    assert.equal(result.coverage.unknown_time_excluded, 1);
    const context = await local.materials(pet); assert.ok(context.records.some(row => row.id === known.id));
  });
  await check('duplicates never refresh receipt or retrofit unknown metadata', async () => {
    await reset(); const source = await seed('同一事件原话', { event: 'same' });
    const before = (await local.materials(pet)).records[0].source_metadata;
    const duplicate = await seed('同一事件原话', { event: 'same' }); assert.equal(duplicate.duplicate, true);
    assert.deepEqual((await local.materials(pet)).records[0].source_metadata, before);
    await seed('旧事件原话', { event: 'old', original: false }); await seed('旧事件原话', { event: 'old' });
    const old = (await local.materials(pet)).records.find(row => row.id !== source.id);
    assert.equal(old.source_metadata.time_basis, 'unknown'); assert.equal(old.source_metadata.received_at_ms, null);
  });
  await check('auto_write=false writes neither body nor new metadata', async () => {
    await reset(); await seed('已有可信原话'); await local.management('memory.settings', { auto_write: false });
    const before = await local.management('memory.export');
    const result = await seed('不应持久化的新原话'); assert.equal(result.skipped, true);
    const after = await local.management('memory.export');
    assert.equal(after.memories.length, before.memories.length); assert.equal(after.record_metadata.length, before.record_metadata.length);
    assert.equal(after.memory_epoch, before.memory_epoch);
  });
  await check('correction/deletion/suspension cancel snapshots and recursively hide derived bodies', async () => {
    for (const op of ['memory.correct', 'memory.delete', 'memory.suspend']) {
      await reset(); const source = await seed('原计划：喝咖啡');
      const child = await seed('有来源的旧咖啡认知', { original: false, derivedFrom: [{ id: source.id, revision: 1 }] });
      const before = await snapshot();
      await local.management(op, { id: source.id, expected_revision: 1, ...(op.endsWith('correct') ? { statement: '已更正为茶' } : {}) });
      await rejects(adapter.validate(before), 'STALE_CONTEXT');
      const fresh = await snapshot(); assert.ok(!fresh.context.records.some(row => row.id === child.id));
      assert.doesNotMatch(JSON.stringify([fresh.engineItems, fresh.timelessBackground]), /咖啡/);
    }
  });
  await check('persona revision/text changes cancel old snapshot including an in-flight source await', async () => {
    await reset(); await seed('明天面试'); const before = await snapshot(); personaRevision++;
    await rejects(adapter.validate(before), 'STALE_PERSONA'); personaRevision--;
    personaText = '现在喜欢绘画。'; await rejects(adapter.validate(before), 'STALE_PERSONA');
    const current = await snapshot(); const method = supervisor.raw;
    supervisor.raw = async (...args) => { const value = await method(...args); if (args[0] === 'memory.materials') personaRevision++; return value; };
    try { await rejects(adapter.validate(current), 'STALE_PERSONA'); } finally { supervisor.raw = method; }
  });
  await check('Promise persona getters fail visibly; a final validate await still checks original persona', async () => {
    await reset();
    const asynchronous = createLocalPurposeMaterials({ capabilities: local, getPersona: async () => getPersona() });
    await rejects(asynchronous.snapshot({ channel: pet }), 'INVALID_REQUEST');
    await seed('明天我有面试'); const current = await snapshot(); const method = supervisor.raw;
    let validations = 0;
    supervisor.raw = async (...args) => { const value = await method(...args); if (args[0] === 'context.validate' && ++validations === 2) personaRevision++; return value; };
    try { await rejects(adapter.validate(current), 'STALE_PERSONA'); } finally { supervisor.raw = method; }
  });
  await check('proof recheck uses original binding/epoch and catches missing used record even if epoch response is unchanged', async () => {
    await reset(); await seed('有效的原计划'); const current = await snapshot(); const method = supervisor.raw;
    const before = operations.filter(op => op === 'session.bind').length;
    supervisor.raw = async (...args) => {
      const value = await method(...args);
      if (args[0] === 'memory.materials') {
        assert.equal(args[1].session_binding, current.context.binding.session_binding);
        assert.equal(args[2].limit, current.coverage.limit);
        return { ...value, records: [] };
      }
      return value;
    };
    try { await rejects(adapter.validate(current), 'STALE_CONTEXT'); } finally { supervisor.raw = method; }
    assert.equal(operations.filter(op => op === 'session.bind').length, before);
    assert.equal(current.context.memory_epoch, current.context.memory_epoch);
  });
  await check('facade drops late projection/ingress-open replies after original character or sharing binding retires', async () => {
    for (const change of ['role', 'sharing']) {
      await reset(); await seed('原始素材'); const method = supervisor.raw; let changed = false;
      supervisor.raw = async (...args) => {
        const value = await method(...args);
        if (args[0] === 'memory.materials' && !changed) {
          changed = true;
          if (change === 'role') { character = { id: `race-${seq}`, epoch: 800 }; await local.setMode('local'); }
          else { await local.shareOwner(true); await local.context(pet); }
        }
        return value;
      };
      try { await rejects(local.materials(pet), 'STALE_CHARACTER'); } finally { supervisor.raw = method; }
    }
    await reset(); const context = await local.context(pet); const method = supervisor.raw;
    supervisor.raw = async (...args) => { const value = await method(...args); if (args[0] === 'memory.ingress.open') { character = { id: `ingress-${seq}`, epoch: 900 }; await local.setMode('local'); } return value; };
    try { await rejects(local.ingest(context, 'late', '不可转给新角色', { actor: 'user', original: true }), 'STALE_CHARACTER'); }
    finally { supervisor.raw = method; }
    assert.equal(operations.filter(op => op === 'memory.ingest').length, 0);
  });
  await check('unknown/expired pinned relative-time statements cannot enter timeless background', async () => {
    for (const statement of ['明天我会考试，已经24小时没聊', '今晚我有面试', '明年我准备搬家',
      'Tomorrow I have an interview', 'I have an exam next week', 'I met them two days ago']) {
      await reset(); const source = await seed('未经证明的旧文本', { original: false });
      await local.management('memory.correct', { id: source.id, expected_revision: 1, statement });
      const current = await snapshot(); assert.equal(current.engineItems.length, 0);
      assert.equal(current.timelessBackground.length, 0, `unknown time: ${statement}`);
      assert.equal(current.coverage.temporal_background_excluded, 1); assert.equal(current.lastMasterAt, null);
      // A trusted receipt becoming old must not promote the same relative claim.
      await reset(); const known = await seed(statement);
      await local.management('memory.correct', { id: known.id, expected_revision: 1, statement });
      assert.equal((await local.materials(pet)).records[0].source_metadata.time_basis, 'service_received');
      const expired = await snapshot({ now: Date.now() + 80 * 3600000 });
      assert.equal(expired.engineItems.length, 0);
      assert.equal(expired.timelessBackground.length, 0, `expired receipt: ${statement}`);
      assert.equal(expired.coverage.temporal_background_excluded, 1); assert.equal(expired.lastMasterAt, null);
    }
  });
  await check('cancellation and caller generation are checked immediately after material await', async () => {
    await reset(); await seed('明天面试');
    for (const kind of ['signal', 'generation']) {
      const controller = new AbortController(); let generation = 1; const method = local.materials.bind(local);
      local.materials = async (...args) => { const value = await method(...args); if (kind === 'signal') controller.abort(); else generation++; return value; };
      const before = operations.filter(op => op === 'memory.materials').length;
      try { await rejects(snapshot({ signal: controller.signal, guard: () => { if (generation !== 1) throw Object.assign(new Error('cancelled original run'), { code: 'RUN_CHANGED', hint: 'start a new run' }); } }), kind === 'signal' ? 'REQUEST_CANCELLED' : 'RUN_CHANGED'); }
      finally { local.materials = method; }
      assert.equal(operations.filter(op => op === 'memory.materials').length, before + 1);
    }
  });
  await check('bounded projection retains service-validated recursive proof without separately reading hidden ancestors', async () => {
    await reset(); const source = await seed('真实计划');
    const child = await seed('派生记忆', { original: false, derivedFrom: [{ id: source.id, revision: 1 }] });
    await local.management('memory.correct', { id: child.id, expected_revision: 1, statement: '主人喜欢读书' });
    const small = await snapshot({ limit: 1 }); assert.equal(small.context.records.length, 1);
    assert.equal(small.coverage.has_more, true); assert.equal(small.coverage.proof_unavailable, 0);
    assert.equal(small.timelessBackground.length, 1);
    assert.equal(small.proofs[small.timelessBackground[0].id].source_revisions[source.id], 1);
    const complete = await snapshot({ limit: 50 }); assert.equal(complete.timelessBackground.length, 1);
  });
  await check('service restart invalidates old snapshot/token cache and fresh source opens fresh credential', async () => {
    await reset(); await seed('重启前的计划'); const before = await snapshot();
    const child = supervisor.child; const exited = once(child, 'exit'); child.kill(); await exited;
    await seed('重启后新的原话');
    await rejects(adapter.validate(before), 'STALE_CHARACTER');
    assert.equal((await snapshot()).engineItems.length, 2);
    assert.equal(operations.filter(op => op === 'memory.ingress.open').length, 2);
  });
  await check('ingest keeps original role state across every validation/open/result await, with cold and cached credentials', async () => {
    const cases = ['validate-1:role', 'open:role', 'validate-2:role', 'result:role',
      'validate-2:generation', 'validate-2:binding', 'result:generation', 'result:binding'];
    for (const cached of [false, true]) for (const scenario of cases) {
      if (cached && scenario === 'open:role') continue;
      await reset();
      if (cached) await seed('缓存凭据的独立输入');
      const context = await local.context(pet), oldId = character.id, oldState = local.store.characters[oldId];
      const oldWritten = oldState.written, generation = supervisor.generation, event = crypto.randomUUID();
      const [stage, change] = scenario.split(':');
      const method = supervisor.raw, oldWriter = local.semanticWriter;
      let validations = 0, dispatched = 0, changed = false, notified = 0;
      local.semanticWriter = { notify() { notified++; } };
      supervisor.raw = async (...args) => {
        if (args[0] === 'memory.ingest') dispatched++;
        const value = await method(...args);
        if (args[0] === 'context.validate') validations++;
        const boundary = stage === 'validate-1' ? args[0] === 'context.validate' && validations === 1 :
          stage === 'validate-2' ? args[0] === 'context.validate' && validations === 2 :
          stage === 'open' ? args[0] === 'memory.ingress.open' : args[0] === 'memory.ingest';
        if (boundary && !changed) {
          changed = true;
          if (change === 'role') character = { id: `late-${seq}`, epoch: 900 + seq };
          else if (change === 'generation') supervisor.generation++;
          else local.bindings.clear();
        }
        return value;
      };
      try {
        await rejects(local.ingest(context, event, '原角色本轮计划', { actor: 'user', original: true }), 'STALE_CHARACTER');
        assert.equal(changed, true, `${cached}:${scenario}`);
        assert.equal(dispatched, stage === 'result' ? 1 : 0);
        assert.equal(oldState.written, stage === 'result' || oldWritten);
        assert.equal(notified, 0, 'late result must not notify a current-role Writer');
        if (change === 'role') assert.equal(local.status().written, false, 'new role was never written');
        const rows = await method('memory.materials', context.binding, { limit: 50 });
        assert.equal(rows.records.some(row => row.source_refs.includes(`event:${event}`)), stage === 'result', 'already-dispatched old commit is retained, not reattributed');
      } finally { supervisor.raw = method; supervisor.generation = generation; local.semanticWriter = oldWriter; }
    }
    // The compatibility lane also must not mark a newly selected character.
    await reset(); const context = await local.context(pet), oldId = character.id, method = supervisor.raw;
    supervisor.raw = async (...args) => { const value = await method(...args); if (args[0] === 'context.validate') character = { id: `legacy-late-${seq}`, epoch: 1000 + seq }; return value; };
    try {
      await rejects(local.ingest(context, crypto.randomUUID(), '无可信时间的旧调用', { actor: 'user' }), 'STALE_CHARACTER');
      assert.equal(local.store.characters[oldId].written, false); assert.equal(local.status().written, false);
      assert.equal(operations.filter(op => op === 'memory.ingest').length, 0);
    } finally { supervisor.raw = method; }
  });
  await check('private bounded authority detaches nested records, coverage and binding while retaining the opaque host gate', async () => {
    await reset(); await seed('明天我有面试');
    const gate = Object.freeze({}), materials = local.materials.bind(local), method = supervisor.raw;
    let originalContext;
    const validateGate = candidate => assert.equal(candidate, gate, 'original opaque gate identity');
    local.toolHost = { syncPolicy: async () => {}, capture: () => gate, validateCapture: validateGate, checkCapture: async candidate => validateGate(candidate) };
    local.materials = async (...args) => originalContext = await materials(...args);
    try {
      const captured = await snapshot({ limit: 1 });
      originalContext.coverage.limit = 50;
      originalContext.binding.host_gate = Object.freeze({});
      originalContext.binding.generation = 5000;
      originalContext.records[0].statement = '外部修改了未冻结的结果';
      originalContext.records[0].source_metadata.statement_origin = 'unknown';
      const limits = [];
      supervisor.raw = async (...args) => {
        if (args[0] === 'memory.materials') { limits.push(args[2].limit); validateGate(args[1].host_gate); }
        return method(...args);
      };
      assert.equal(await adapter.validate(captured), true); assert.deepEqual(limits, [1]);
      assert.equal(captured.coverage.limit, 1); assert.equal(captured.context.binding.host_gate, gate);
      assert.doesNotMatch(JSON.stringify(captured.engineItems), /外部修改/);
      assert.equal(captured.context.records[0].source_metadata.statement_origin, 'original');
      await local.validate(captured.context);
    } finally { local.materials = materials; supervisor.raw = method; local.toolHost = undefined; }
    // A mutable structural gate is not the host's opaque capability contract.
    local.materials = async (...args) => { const value = await materials(...args); return { ...value, binding: { ...value.binding, host_gate: { generation: 1 } } }; };
    try { await rejects(snapshot(), 'PROTOCOL_MISMATCH'); } finally { local.materials = materials; }
  });
  await check('timeless background requires explicit stable grammar; unknown and expired plans cannot qualify by missing a blacklist word', async () => {
    const rejected = ['我正在准备考试', 'I have an interview in 2 days', '我在等面试结果', '考试准备中',
      'I am preparing for an exam', '我现在要去买茶', '我喜欢茶，但是我正在准备考试', 'I prefer tea before my interview', '无法判定的旧记录'];
    for (const statement of rejected) {
      for (const original of [false, true]) {
        await reset(); const source = await seed(statement, { original });
        if (original) {
          const fresh = await snapshot(); assert.equal(fresh.engineItems[0].kind, 'owner');
          assert.equal(fresh.engineItems[0].text, statement, 'fresh original plans retain the full engine lane');
          // Contract fixture: P1 has no independent pin operation today. Keep the
          // real original receipt/proof but project pinned=true on both reads to
          // exercise original+expired+pinned, without editing the encrypted DB.
          const method = supervisor.raw;
          supervisor.raw = async (...args) => { const value = await method(...args); return args[0] === 'memory.materials' ? { ...value, records: value.records.map(row => ({ ...row, pinned: true })) } : value; };
          try {
            const expired = await snapshot({ now: Date.now() + 80 * 3600000 });
            assert.equal(expired.engineItems.length, 0); assert.equal(expired.timelessBackground.length, 0, statement);
            assert.equal(expired.coverage.background_unproven_excluded, 1);
            assert.equal(expired.context.records[0].source_metadata.statement_origin, 'original');
          } finally { supervisor.raw = method; }
        } else {
          await local.management('memory.correct', { id: source.id, expected_revision: 1, statement });
          const current = await snapshot(); assert.equal(current.timelessBackground.length, 0, statement);
          assert.equal(current.coverage.background_unproven_excluded, 1); assert.equal(current.lastMasterAt, null);
        }
      }
    }
    for (const statement of ['我现在喜欢茶', '主人喜欢读书', 'I prefer tea', '我的母语是中文']) {
      await reset(); const source = await seed('旧的无时间知识', { original: false });
      await local.management('memory.correct', { id: source.id, expected_revision: 1, statement });
      const current = await snapshot(); assert.equal(current.timelessBackground[0].text, statement);
      assert.equal(current.timelessBackground[0].temporalFactsAllowed, false); assert.equal(current.engineItems.length, 0);
      assert.equal(current.coverage.background_unproven_excluded, 0); assert.equal(current.lastMasterAt, null);
    }
  });
  console.log(`PASS ${count} local purpose materials checks; disposable SQLCipher fixture ${temp}`);
} finally { await supervisor.stop(); }
