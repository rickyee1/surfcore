import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const moduleAt = p => import(pathToFileURL(path.resolve(p)).href);
const { CapabilitySupervisor } = await moduleAt('plugins/surfcore/lib/local-capabilities/supervisor.js');
const { LocalCapabilities } = await moduleAt('plugins/surfcore/lib/local-capabilities/facade.js');
const { createRolePackages } = await moduleAt('plugins/surfcore/lib/local-capabilities/role-package.js');
const { openPackage, sealPackage, validatePayload, LAYERS } = await moduleAt('plugins/surfcore/lib/local-capabilities/role-package-format.js');
const { browsePurposeMaterials } = await moduleAt('plugins/surfcore/lib/local-purpose-public.js');
const { createAutonomousCompanion } = await moduleAt('plugins/surfcore/lib/autonomous-companion.js');
const { createGovernedPurposePlanner } = await moduleAt('plugins/surfcore/lib/local-purpose-planner.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-purpose-portability-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const password = 'synthetic-independent-role-password';
const supervisors = [];
const files = { core: 'persona.md', daily: 'persona.daily.md', tone: 'persona.tone.md', pet: 'persona.scenes/pet.md', 'qq-private': 'persona.scenes/qq-private.md', 'qq-group': 'persona.scenes/qq-group.md', bili: 'persona.scenes/bili.md' };
function fixture(name) {
  const root = path.join(temp, name), charactersRoot = path.join(root, 'characters');
  const supervisor = new CapabilitySupervisor({ python: path.resolve('.venv/Scripts/python.exe'), entry: path.resolve('services/local-capabilities/server.py'), dataDir: path.join(root, 'library'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') }, timeoutMs: 30000 });
  supervisors.push(supervisor);
  const role = { id: 'synthetic', epoch: 1, name: 'Synthetic' };
  const local = new LocalCapabilities({ supervisor, stateFile: path.join(root, 'backend.json'), currentCharacter: () => ({ id: role.id, epoch: role.epoch }) });
  const packages = createRolePackages({ capabilities: local, charactersRoot });
  return { root, charactersRoot, supervisor, local, packages, role, call: (op, p) => packages.dispatch('role.package.' + op, p) };
}
const plannerFor = f => createGovernedPurposePlanner({ capabilities: f.local, getPersona: () => ({ ...f.role, revision: 1, text: '' }) });
let pendingMode = 'none', modelCalls = 0, deliveryCalls = 0, replyText = '我记得面试这件事，准备得怎么样了？';
function coordinator(f, outcome = 'sent') {
  const activity = { epoch: 'synthetic-native', revision: 1, sequence: 1, receivedAt: 0, lastSentAt: 0, foreground: false };
  const pet = { online: () => ({ online: true }), activity: () => ({ ...activity }), async deliverPurpose(envelope) {
    await envelope.guard(); envelope.syncGuard(); deliveryCalls++; return { outcome, activity: { epoch: activity.epoch, sequence: 2, at: Date.now() } };
  } };
  const llm = { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'fixture', settingsPath: [] }],
    async prepareCall(config) { return { config, async *stream() { modelCalls++; yield { type: 'text-delta', text: JSON.stringify({ decision: 'send', text: replyText, pending: pendingMode }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }; } };
  const ctx = { get(name) { if (name === 'llm') return llm; if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'fixture' }) }; if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision: 1, value: { baseURL: 'https://synthetic.invalid/v1' } }] }; if (name === 'launchEnvironment') return new Map(); } };
  return createAutonomousCompanion({ ctx, capabilities: f.local, stateDir: path.join(path.dirname(f.local.stateFile), 'companion'), pet,
    persona: () => ({ ...f.role, revision: 1, text: '' }), environment: () => ({ roleActive: true, platformEnabled: false, focused: false, paused: false }),
    reader: { feed: async () => { throw Error('public reader disabled'); } }, callBridge: async () => { throw Error('QQ disabled'); } });
}
async function configure(co) { await co.configure({ enabled: true, carrier: 'pet', readerEnabled: false, dailyMax: 100, cooldownMinutes: 0, quietStart: '', quietEnd: '' }); }
const indexText = fs.readFileSync('plugins/surfcore/lib/index.js', 'utf8');
const hostText = fs.readFileSync('plugins/surfcore/lib/local-capabilities/host.js', 'utf8');
assert.match(indexText, /stateDir: path.join\(LOCAL_ROOT, 'companion'\)/);
assert.match(hostText, /stateFile: LOCAL_STATE/);
assert.match(fs.readFileSync('src/local-capabilities-state.js', 'utf8'), /LOCAL_STATE = path.join\(LOCAL_ROOT, 'backend.json'\)/);
try {
  for (const outcome of ['unknown', 'sent', 'continue']) {
    pendingMode = outcome === 'continue' ? 'continue' : 'none';
    const source = fixture('source-' + outcome);
    fs.mkdirSync(path.join(source.charactersRoot, 'synthetic', 'persona.scenes'), { recursive: true });
    for (const layer of LAYERS) fs.writeFileSync(path.join(source.charactersRoot, 'synthetic', files[layer]), '');
    fs.writeFileSync(path.join(source.charactersRoot, 'synthetic', 'character.json'), JSON.stringify({ version: 1, id: 'synthetic', name: 'Synthetic', updatedAt: '2026-11-04' }));
    fs.writeFileSync(path.join(source.charactersRoot, 'current.json'), JSON.stringify(source.role));
    await source.local.setMode('local');
    const stored = await source.local.ingest(await source.local.context({ kind: 'pet' }), 'source-interview', '明天我有面试，有点紧张', { actor: 'user', original: true });
    await source.local.management('attention.configure', { enabled: true, daily_limit: 100, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC' });
    const planner = plannerFor(source), plan = await planner.prepare({ channel: { kind: 'pet' }, random: () => 0 });
    assert.ok(plan.purpose);
    const originalCalls = modelCalls, originalDeliveries = deliveryCalls;
    const co = coordinator(source, outcome === 'continue' ? 'sent' : outcome); await configure(co);
    if (outcome !== 'unknown') assert.equal((await co.run()).outcome, 'sent');
    else await assert.rejects(co.run(), error => error.code === 'COMPANION_DELIVERY_UNKNOWN');
    co.dispose(); assert.equal(modelCalls, originalCalls + 1); assert.equal(deliveryCalls, originalDeliveries + 1);
    const stateDir = path.join(source.root, 'companion');
    const filename = crypto.createHash('sha256').update('synthetic').digest('hex').slice(0, 24) + '.state.json';
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, filename), 'utf8')), state = saved.purpose, outreach = saved.last.outreachId;
    assert.equal(Object.keys(state.terminals).length, outcome === 'continue' ? 0 : 1); assert.equal(saved.bodyHashes.length, 1);
    const portableTerminals = outcome === 'continue' ? { [state.receipts[0].terminalKey]: 'consumed' } : state.terminals;
    let exported = await source.call('export.prepare', { password, assets: [] });
    exported = await source.call('export.commit', { package_id: exported.package_id, package_digest: exported.package_digest, expected_revision: exported.revision, confirmation_digest: exported.confirmation_digest });
    let bytes;
    source.packages.download(null, { writeHead() {}, end(value) { bytes = value; } }, { package_id: exported.package_id, package_digest: exported.package_digest });
    const payload = openPackage(bytes, password);
    assert.equal(payload.platformState.events.length, 1); assert.deepEqual(payload.platformState.purpose.terminals, portableTerminals); assert.deepEqual(payload.platformState.purpose.bodyHashes, saved.bodyHashes);
    const target = fixture('target-' + outcome);
    const uploaded = await target.packages.upload((async function* () { yield bytes; })());
    const inspected = await target.call('import.inspect', { package_id: uploaded.package_id, password, mode: 'new' });
    const staged = await target.call('import.stage', { inspection_id: inspected.inspection_id, password, package_digest: inspected.package_digest, expected_target_revision: inspected.target_revision });
    let result = await target.call('import.commit', { operation_id: staged.operation_id, expected_revision: staged.revision, confirmation_digest: staged.confirmation_digest });
    result = await target.call('import.status', { operation_id: result.operation_id });
    await target.call('review', { operation_id: result.operation_id, expected_revision: result.revision, review_digest: result.native_review.review_digest });
    await target.local.setMode('local');
    const before = await target.local.management('attention.status');
    assert.equal(before.config.enabled, false);
    assert.equal(before.today_count, 1);
    await target.local.management('attention.configure', { enabled: true, daily_limit: 100, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC' });
    const targetPlan = await plannerFor(target).prepare({ channel: { kind: 'pet' }, random: () => 0 });
    const binding = targetPlan.snapshot.context.binding;
    const old = await target.supervisor.raw('attention.check', binding, { outreach_id: outreach });
    const fresh = await target.supervisor.raw('attention.check', binding, { outreach_id: crypto.randomUUID() });
    console.log(JSON.stringify({ case: 'role-package-purpose-terminal', outcome, chargedCount: before.today_count, defaultOff: !before.config.enabled, sourceTerminalCount: Object.keys(state.terminals).length, targetTerminalCount: Object.keys(targetPlan.state.terminals).length, targetSourceIdPreserved: targetPlan.usedProofs.some(p => p.id === stored.id), sameCandidate: targetPlan.purpose?.id === plan.purpose.id, oldOutreachReason: old.reason, newOutreachAllowed: fresh.allowed }));
    assert.equal(old.reason, 'duplicate');
    assert.equal(fresh.allowed, true);
    assert.equal(targetPlan.purpose, null); assert.equal(Object.keys(targetPlan.state.terminals).length, 1); assert.deepEqual(targetPlan.importedBodyHashes, saved.bodyHashes);
    const callsBefore = modelCalls, sendsBefore = deliveryCalls;
    const restored = coordinator(target); await configure(restored);
    assert.equal((await restored.run()).reason, 'no-purpose'); assert.equal(modelCalls, callsBefore); assert.equal(deliveryCalls, sendsBefore);
    assert.ok((await target.local.purposeState(await target.local.context({ kind: 'pet' }))).bodyHashes.includes(saved.bodyHashes[0]));
    await assert.rejects(target.local.management('purpose.state'), error => error.code === 'PERMISSION_DENIED');
    const originalContext = await target.local.context({ kind: 'pet' });
    await assert.rejects(target.supervisor.raw('purpose.state', originalContext.binding, { memory_epoch: originalContext.memory_epoch, character_id: 'other' }), error => error.code === 'PERMISSION_DENIED');
    if (outcome === 'sent') {
      const legacy = structuredClone(payload); legacy.packageId = crypto.randomBytes(16).toString('hex'); delete legacy.platformState.purpose; validatePayload(legacy);
      const legacyBytes = sealPackage(legacy, password), up = await target.packages.upload((async function* () { yield legacyBytes; })());
      const view = await target.call('import.inspect', { package_id: up.package_id, password, mode: 'restore_same_id' });
      const stage = await target.call('import.stage', { inspection_id: view.inspection_id, password, package_digest: view.package_digest, expected_target_revision: view.target_revision });
      let imported = await target.call('import.commit', { operation_id: stage.operation_id, expected_revision: stage.revision, confirmation_digest: stage.confirmation_digest });
      imported = await target.call('import.status', { operation_id: imported.operation_id });
      await target.call('review', { operation_id: imported.operation_id, expected_revision: imported.revision, review_digest: imported.native_review.review_digest });
      await target.local.setMode('local');
      assert.deepEqual((await target.local.purposeState(await target.local.context({ kind: 'pet' }))).terminals, state.terminals);
      assert.equal((await target.local.management('attention.status')).config.enabled, false);
      await configure(restored);
    }
    await target.local.management('memory.correct', { id: stored.id, expected_revision: 1, statement: '我改为后天参加一个新的面试' });
    await assert.rejects(target.local.purposeState(originalContext), error => ['STALE_CONTEXT', 'STALE_CHARACTER'].includes(error.code));
    replyText = '新的面试计划，我想和你继续准备。' + outcome;
    await target.local.ingest(await target.local.context({ kind: 'pet' }), 'fresh-owner-source', '明天我有一场全新的面试，有点紧张', { actor: 'user', original: true });
    const freshPlan = await plannerFor(target).prepare({ channel: { kind: 'pet' }, random: () => 0 }); assert.ok(freshPlan.purpose);
    assert.equal((await restored.run()).outcome, 'sent'); assert.equal(deliveryCalls, sendsBefore + 1); restored.dispose();
    if (outcome === 'sent') {
      const filename = path.join(source.root, 'companion', crypto.createHash('sha256').update('synthetic').digest('hex').slice(0, 24) + '.state.json');
      const originalBytes = fs.readFileSync(filename), raw = source.supervisor.raw.bind(source.supervisor); let changed = false;
      source.supervisor.raw = async (...args) => {
        const result = await raw(...args);
        if (args[0] === 'portable.capture' && !changed) {
          changed = true; const value = JSON.parse(originalBytes); value.bodyHashes.push(crypto.createHash('sha256').update('concurrent-host-terminal').digest('hex')); fs.writeFileSync(filename, JSON.stringify(value));
        }
        return result;
      };
      try { await assert.rejects(source.call('export.prepare', { password, assets: [] }), error => error.code === 'VERSION_CONFLICT'); assert.equal(changed, true); }
      finally { source.supervisor.raw = raw; fs.writeFileSync(filename, originalBytes); }
      const oversized = structuredClone(payload); oversized.platformState.purpose.bodyHashes = Array(10001).fill('0'.repeat(64)); assert.throws(() => validatePayload(oversized));
      const forged = structuredClone(payload); forged.platformState.purpose.account = 'forbidden'; assert.throws(() => validatePayload(forged));
    }
    await target.supervisor.stop();
    await source.supervisor.stop();
  }
  {
    const f = fixture('public-source-revision'); await f.local.setMode('local');
    const bvid = 'BV1xx411c7mD';
    const source = { bvid, title: '学习新知识', description: '一个具体的公开知识点', author: '公开作者', subtitle: '', basis: '只读公开文字', url: 'https://www.bilibili.com/video/' + bvid };
    const reader = { feed: async () => [{ bvid }], read: async () => source };
    const browse = () => browsePurposeMaterials({ capabilities: f.local, reader, state: { seen: [] }, guard: () => {}, research: async () => '这个公开知识值得进一步讨论。' });
    const first = await browse(), planner = plannerFor(f);
    const plan = await planner.prepare({ channel: { kind: 'pet' }, publicMaterial: first.publicMaterial, random: () => 0 }); assert.ok(plan.purpose);
    const saved = planner.recordOutcome(plan, { outreachId: 'public-prior', outcome: 'sent', at: Date.now() + 1, channel: { platform: 'pet', account_id: 'local', conversation_id: 'local' } }, { consumed: true });
    const original = first.publicMaterial.sourceRefs[0];
    await f.local.management('memory.correct', { id: original.id, expected_revision: original.revision, statement: JSON.stringify({ title: '已经纠正的新知识', description: '本次修订改变了原主题' }) });
    const second = await browse(); assert.equal(second.publicMaterial.sourceRefs[0].id, original.id); assert.equal(second.publicMaterial.sourceRefs[0].revision, original.revision + 1);
    const changed = await planner.prepare({ channel: { kind: 'pet' }, state: saved, publicMaterial: second.publicMaterial, random: () => 0 }); assert.ok(changed.purpose); assert.doesNotMatch(changed.purpose.text, /一个具体的公开知识点/);
    await f.supervisor.stop(); console.log('PASS current governed public revision forms a new candidate without reviving original owner speech');
  }
  console.log('PASS actual coordinator sent/unknown persistence -> encrypted role package -> reviewed new library blocks old candidate/body while source revision creates a real new purpose; ' + temp);
} finally {
  for (const supervisor of supervisors) await supervisor.stop();
}
