import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const BASELINE = '59ec3066f7d42a0452fae01f170c9a8484d5dbe5';
export const FIXTURE_HASH = 'a37c4a112fd8c0f9451c43765a9b9b8f8445f43df5c5683af2b099e35f24d1f5';
export const IDS = Object.freeze({ bot: '100000001', owner: '100000002', other: '100000003', group_a: '200000001', group_b: '200000002' });
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function save(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
export function fault(code, hint) { return Object.assign(new Error(code), { code, hint }); }
export function inside(root, candidate) {
  const resolved = path.resolve(candidate), relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fault('PATH_OUTSIDE_TRIAL', 'Use a new child directory of the evaluation root.');
  return resolved;
}
export function loopback(value, protocols = ['http:']) {
  const u = new URL(value);
  if (!protocols.includes(u.protocol) || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash) throw fault('NON_ISOLATED_ENDPOINT', 'Use an explicit IPv4 loopback endpoint.');
  return u.href.replace(/\/$/, '');
}
export function fixture(file) {
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== FIXTURE_HASH) throw fault('FIXTURE_CHANGED', 'Restore the independently frozen A01 fixture.');
  const scenes = JSON.parse(bytes);
  if (scenes.length !== 30 || scenes.filter(s => ['rv','rg'].includes(s.setup.channel)).length !== 8) throw fault('FIXTURE_INVALID', 'Keep all 30 scenarios, including 8 reserved2 scenarios.');
  return scenes;
}
export function ref(repo, wanted) {
  const value = execFileSync('git', ['rev-parse', '--verify', `${wanted}^{commit}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw fault('REF_INVALID', 'Choose a full frozen commit.');
  return value;
}
export function shuffle(items, seed) {
  const out = [...items]; let counter = 0;
  for (let i = out.length - 1; i > 0; i--) {
    const n = Number.parseInt(sha(`${seed}:${counter++}`).slice(0, 12), 16), j = n % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export function schedule(scenes, seed) {
  return shuffle(scenes.flatMap(scene => [1,2].flatMap(repeat => ['original','fork'].map(version => ({ sceneId: scene.id, channel: scene.setup.channel, repeat, version })))), seed)
    .map((trial, i) => ({ ...trial, trialId: `trial-${String(i + 1).padStart(3, '0')}` }));
}
export function modelControls(config = {}, info = {}) {
  const out = {};
  for (const key of ['provider','model','temperature','maxTokens','reasoningEffort','seed','stop','timeoutMs']) if (config[key] !== undefined) out[key] = structuredClone(config[key]);
  out.contextWindow = info.context?.contextWindow ?? null;
  out.modelMetadata = { id: info.id ?? null, name: info.name ?? null, version: info.version ?? null };
  return out;
}
export function parity(results) {
  const problems = [];
  if (!Array.isArray(results) || results.length !== 120) problems.push({ code: 'INCOMPLETE_120_RESULTS' });
  for (const result of results) {
    if (result.state !== 'completed') problems.push({ trialId: result.trialId, code: result.state });
    const scoredCalls = r => (r.calls || []).filter(c => c.phase === undefined || c.phase === 'scored');
    if (!scoredCalls(result).length || scoredCalls(result).some(c => !c.effective || !c.effective.contextWindow)) problems.push({ trialId: result.trialId, code: 'EFFECTIVE_MODEL_NOT_VERIFIED' });
    if (scoredCalls(result).some(c => c.dispatched !== true || !Number.isFinite(c.startedAt) || !Number.isFinite(c.endedAt) || c.endedAt < c.startedAt || !['stop','tool-calls','length','error','aborted'].includes(c.finish?.kind))) problems.push({ trialId: result.trialId, code: 'DISPATCH_FINISH_NOT_VERIFIED' });
    const toolRound = result.toolEvents?.some(call => call.type === 'tool/call' && call.nativeCallId && (call.phase === undefined || call.phase === 'scored') && result.toolEvents.some(receipt => receipt.type === 'tool/result' && receipt.nativeCallId === call.nativeCallId));
    if (['rv','rg'].includes(result.channel) && !toolRound) problems.push({ trialId: result.trialId, code: 'NATIVE_TOOL_ROUND_NOT_VERIFIED' });
    const peer = results.find(p => p.sceneId === result.sceneId && p.repeat === result.repeat && p.version !== result.version);
    const configurations = r => [...new Set(scoredCalls(r).map(c => JSON.stringify(c.effective)))].sort();
    if (peer && JSON.stringify(configurations(result)) !== JSON.stringify(configurations(peer))) problems.push({ trialId: result.trialId, code: 'CHANNEL_MODEL_CONTROLS_DIFFER' });
  }
  return problems;
}
export function blindPack(plan, results, seed) {
  const pairs = [], mapping = [];
  for (const scene of plan.scenes) for (const repeat of [1,2]) {
    const candidates = ['original','fork'].map(version => results.find(r => r.sceneId === scene.id && r.repeat === repeat && r.version === version));
    const order = shuffle([0,1], `${seed}:${scene.id}:${repeat}`), id = `${scene.id}-r${repeat}`;
    const side = index => {
      const r = candidates[index];
      return r ? { state: r.state, inputs: r.inputs, bubbles: r.bubbles, latency: r.latency, calls: r.calls?.map(c => ({ phase: c.phase, inputWindow: c.inputWindow, usage: c.usage, finish: c.finish, startedAt: c.startedAt, endedAt: c.endedAt })), undeliveredOutputs: r.undeliveredOutputs, failure: r.failure ? { code: r.failure.code } : null } : { state: 'NOT_RUN', bubbles: [], undeliveredOutputs: [] };
    };
    pairs.push({ id, category: scene.category, setup: scene.setup, user_turns: scene.user_turns, required: scene.required, forbidden: scene.forbidden,
      left: side(order[0]), right: side(order[1]), scores: { left: { naturalness: null, completeness: null, lowInterruption: null }, right: { naturalness: null, completeness: null, lowInterruption: null } }, hardFailures: { left: [], right: [] } });
    mapping.push({ id, left: order[0] === 0 ? 'original' : 'fork', right: order[1] === 0 ? 'original' : 'fork' });
  }
  return { publicPack: { schema: 1, status: 'UNSCORED_NOT_ACCEPTED', expectedScenarioRuns: 120, pairs }, privateMapping: mapping };
}
// Scores and hard-failure annotations are the only editable fields. The frozen
// plan, exact 120 raw identities and deterministic mapping bind every other byte.
function canonical(value) {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
export function assess(pack, mapping, results, plan) {
  try {
    const fixed = fixture(new URL('./fixtures/a01-scenarios.json', import.meta.url));
    if (!plan || plan.schema !== 1 || plan.expectedRuns !== 120 || plan.fixtureHash !== FIXTURE_HASH || canonical(plan.scenes) !== canonical(fixed) || canonical(plan.trials) !== canonical(schedule(fixed, plan.seed)) || plan.repos?.original?.ref !== BASELINE || !/^[a-f0-9]{40}$/.test(plan.repos?.fork?.ref || '')) throw Error('PLAN_NOT_BOUND');
    if (!Array.isArray(results) || results.length !== 120 || new Set(results.map(r => r.trialId)).size !== 120) throw Error('INCOMPLETE_120_RESULTS');
    for (const expected of plan.trials) {
      const r = results.find(item => item.trialId === expected.trialId);
      if (!r || Object.keys(expected).some(key => r[key] !== expected[key])) throw Error('RAW_TRIAL_IDENTITY_MISMATCH');
    }
    const rebuilt = blindPack(plan, results, plan.seed + ':blind');
    if (canonical(mapping) !== canonical(rebuilt.privateMapping)) throw Error('MAPPING_MISMATCH');
    const immutable = value => ({ ...value, pairs: value.pairs.map(({ scores, hardFailures, ...rest }) => rest) });
    if (!Array.isArray(pack?.pairs) || pack.pairs.length !== 60 || new Set(pack.pairs.map(p => p.id)).size !== 60 || canonical(immutable(pack)) !== canonical(immutable(rebuilt.publicPack))) throw Error('PACK_RAW_MISMATCH');
    for (const pair of pack.pairs) {
      if (Object.keys(pair.scores || {}).sort().join(',') !== 'left,right' || Object.keys(pair.hardFailures || {}).sort().join(',') !== 'left,right') throw Error('RATING_SCHEMA_INVALID');
      for (const side of ['left','right']) if (Object.keys(pair.scores[side] || {}).sort().join(',') !== 'completeness,lowInterruption,naturalness' || !Array.isArray(pair.hardFailures[side]) || pair.hardFailures[side].some(x => typeof x !== 'string' || !x.trim())) throw Error('RATING_SCHEMA_INVALID');
    }
  } catch (e) { return { status: 'NOT_VERIFIED', nonInferior: 0, denominator: 30, blockers: [{ code: e.message || 'EVIDENCE_INVALID' }] }; }
  let nonInferior = 0; const blockers = [], dimensions = ['naturalness','completeness','lowInterruption'];
  blockers.push(...parity(results));
  for (const sceneId of [...new Set(pack.pairs.map(p => p.id.replace(/-r[12]$/, '')))]) {
    const pairs = pack.pairs.filter(p => p.id.startsWith(sceneId + '-r'));
    const totals = { original: Object.fromEntries(dimensions.map(d => [d, 0])), fork: Object.fromEntries(dimensions.map(d => [d, 0])) }; let scored = true;
    for (const p of pairs) for (const side of ['left','right']) {
      const version = mapping.find(m => m.id === p.id)?.[side];
      if (!version || p[side].state !== 'completed') blockers.push({ id: p.id, side, code: 'RUN_NOT_COMPLETE' });
      if (version === 'fork' && p.hardFailures[side]?.length) blockers.push({ id: p.id, side, code: 'FORK_HARD_FAILURE', findings: p.hardFailures[side] });
      for (const d of dimensions) {
        const score = p.scores[side][d];
        if (!Number.isInteger(score) || score < 0 || score > 4) { scored = false; blockers.push({ id: p.id, side, code: 'UNSCORED' }); }
        else if (version) totals[version][d] += score;
      }
    }
    if (scored && pairs.length === 2 && dimensions.every(d => totals.fork[d] >= totals.original[d])) nonInferior++;
  }
  return { status: blockers.some(b => b.code === 'FORK_HARD_FAILURE') ? 'FAIL' : blockers.length ? 'NOT_VERIFIED' : nonInferior >= 24 ? 'PASS' : 'FAIL', nonInferior, denominator: 30, blockers };
}
