import { mergePurposeReplay } from './local-capabilities/role-package-format.js';
/** Governed purpose selection. No scheduler, disk, model or transport ownership. */
import crypto from 'node:crypto';
import { analyzePersona, deriveDrives, formGoalHypotheses, applyGoalFeedback, minePurposeSeeds,
  selectPurpose, goalToCandidate, normalizePurposeConfig, textSimilarity } from '../../../src/purpose-engine.js';
import { createLocalPurposeMaterials } from './local-purpose-materials.js';
import { CapabilityError } from './local-capabilities/supervisor.js';
import { checkPublicMaterial, validatePublicMaterial } from './local-purpose-public.js';

const VERSION = 'governed-purpose-v1';
const DAY = 86400000;
const fail = message => new CapabilityError('PURPOSE_STATE_INVALID', message, '丢弃旧轮并重新读取当前角色与治理素材；不要导入旧目的正文。');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const time = value => Number.isSafeInteger(value) && value > 0;
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function origin(value) {
  if (!value || !['qq', 'pet'].includes(value.platform) || !id(value.account_id) || !id(value.conversation_id)) return null;
  return { platform: value.platform, account_id: value.account_id, conversation_id: value.conversation_id };
}
const sameOrigin = (a, b) => a && b && ['platform', 'account_id', 'conversation_id'].every(key => a[key] === b[key]);
const personaKey = snapshot => digest(snapshot.persona);
const proofRefs = (snapshot, usedIds) => Object.entries(snapshot.proofs).filter(([key]) => usedIds.has(key)).map(([, proof]) => ({ id: proof.id, revision: proof.revision,
  receivedAt: time(proof.sourceMetadata.received_at_ms) ? proof.sourceMetadata.received_at_ms : null }));

// Whitelist the journal shape. In particular, never carry legacy goals, drives,
// pending text, selected text, observations or arbitrary transport response data.
function journal(value) {
  if (value?.version !== VERSION) return { version: VERSION, receipts: [], terminals: {}, transferTerminals: {} };
  const terminals = mergePurposeReplay({ terminals: value.terminals || {}, bodyHashes: [] }).terminals;
  const transferTerminals = mergePurposeReplay({ terminals: value.transferTerminals || {}, bodyHashes: [] }).terminals;
  mergePurposeReplay({ terminals, bodyHashes: [] }, { terminals: transferTerminals, bodyHashes: [] });
  const receipts = [];
  for (const row of (Array.isArray(value.receipts) ? value.receipts : []).slice(-60)) {
    const channel = origin(row.channel);
    if (!id(row.outreachId) || !['sent', 'failed', 'unknown'].includes(row.outcome) || !time(row.at) ||
        !id(row.candidateId) || !channel || !/^[a-f0-9]{64}$/.test(row.personaKey) ||
        !Array.isArray(row.usedProofs) || row.usedProofs.length > 20 || row.usedProofs.some(p => !id(p?.id) || !Number.isSafeInteger(p.revision) || p.revision < 1)) continue;
    receipts.push({ outreachId: row.outreachId, outcome: row.outcome, at: row.at, channel,
      deliveryId: id(row.deliveryId) ? row.deliveryId : null,
      conversationEpoch: id(row.conversationEpoch) ? row.conversationEpoch : null,
      sequence: Number.isSafeInteger(row.sequence) && row.sequence >= 0 ? row.sequence : null,
      terminalKey: /^[a-f0-9]{64}$/.test(row.terminalKey || '') ? row.terminalKey : null, candidateId: row.candidateId, goalId: id(row.goalId) ? row.goalId : '',
      personaKey: row.personaKey, usedProofs: row.usedProofs.map(({ id, revision, receivedAt }) => ({ id, revision, receivedAt: time(receivedAt) ? receivedAt : null })),
      completed: row.outcome === 'sent' && row.completed === true,
      pendingUntil: time(row.pendingUntil) && row.pendingUntil > row.at && row.pendingUntil <= row.at + 90 * DAY ? row.pendingUntil : null,
      feedback: (Array.isArray(row.feedback) ? row.feedback : []).filter(link => id(link?.eventId) &&
        (link.kind === 'reply' && id(link.replyTo) || link.kind === 'next-input' && id(link.conversationEpoch) &&
          Number.isSafeInteger(link.sequence))).slice(-4).map(link => link.kind === 'reply' ?
        { eventId: link.eventId, kind: 'reply', replyTo: link.replyTo } :
        { eventId: link.eventId, kind: 'next-input', conversationEpoch: link.conversationEpoch, sequence: link.sequence }) });
  }
  return { version: VERSION, receipts, terminals, transferTerminals };
}

// Irreversible suppression is keyed only to the selected evidence. Unrelated
// context affects reasoning validity, never whether an unknown/completed event
// can be replayed. Hashes survive bounded eviction without retaining source text.
function candidateIdentity(candidate, goals, snapshot, publicMaterial) {
  const goal = goals.find(item => item.id === candidate.goalId);
  const keys = goal ? goal.evidence.map(item => item.id) : [candidate.sourceId];
  const sources = keys.map(key => snapshot.proofs[key]).filter(Boolean)
    .map(proof => ({ id: proof.id, revision: proof.revision })).sort((a, b) => a.id.localeCompare(b.id));
  if (publicMaterial && keys.includes(publicMaterial.item.id)) {
    if (publicMaterial.sourceRefs.length) sources.push(publicMaterial.sourceRefs[0]);
    else sources.push({ publicEventId: publicMaterial.publicEventId, bodyHash: publicMaterial.bodyHash });
  }
  if (!sources.length && !goal?.evidence.some(item => item.source === 'persona')) return null;
  return { key: digest({ character: snapshot.persona.id, sources,
    persona: sources.length ? null : snapshot.persona.textHash, goal: sources.length ? null : candidate.id }), sources };
}

/** Host-only association. Call only at verified original ingress, never from UI/model JSON.
 * next-input requires the host's uninterrupted per-conversation sequence, including
 * ALL intervening turns, and a boot-scoped epoch. Otherwise require an explicit reply.
 * This association alone is insufficient: prepare also proves P1 original owner,
 * actual same origin, source revision and a receipt after which it was received.
 */
export function associatePurposeReply(state, { outreachId, eventId, kind, replyTo, conversationEpoch, sequence } = {}) {
  const next = journal(state);
  const receipt = next.receipts.find(row => row.outreachId === outreachId && row.outcome === 'sent');
  if (!receipt || !id(eventId)) return next;
  const explicit = kind === 'reply' && receipt.deliveryId && replyTo === receipt.deliveryId;
  const immediate = kind === 'next-input' && receipt.conversationEpoch && conversationEpoch === receipt.conversationEpoch &&
    Number.isSafeInteger(receipt.sequence) && sequence === receipt.sequence + 1;
  if (!explicit && !immediate) return next;
  if (!receipt.feedback.some(link => link.eventId === eventId)) receipt.feedback.push(explicit ?
    { eventId, kind: 'reply', replyTo } : { eventId, kind: 'next-input', conversationEpoch, sequence });
  receipt.feedback = receipt.feedback.slice(-4);
  return next;
}

function currentReceipt(row, snapshot, now) {
  return row.at <= now && (now - row.at <= 14 * DAY || row.pendingUntil > now) && row.personaKey === personaKey(snapshot) &&
    row.usedProofs.every(ref => snapshot.context.records.some(record => record.id === ref.id && record.revision === ref.revision &&
      (time(record.source_metadata?.received_at_ms) ? record.source_metadata.received_at_ms : null) === ref.receivedAt));
}
function feedbackItems(row, snapshot) {
  if (row.outcome !== 'sent') return [];
  return snapshot.engineItems.filter(item => {
    const proof = snapshot.proofs[item.id];
    if (item.kind !== 'owner' || !proof?.attribution.owner || !proof.attribution.verbatim ||
        !sameOrigin(row.channel, proof.sourceMetadata.origin) || item.at <= row.at || item.at - row.at > DAY) return false;
    return row.feedback.some(link => link.eventId === proof.source_event_id &&
      (link.kind === 'reply' && row.deliveryId && link.replyTo === row.deliveryId ||
       link.kind === 'next-input' && row.conversationEpoch && link.conversationEpoch === row.conversationEpoch &&
         Number.isSafeInteger(row.sequence) && link.sequence === row.sequence + 1));
  }).sort((a, b) => a.at - b.at);
}

function derivePlan(snapshot, saved, { config = {}, random = Math.random, lastOwnerActivityAt = null, publicMaterial = null, importedBodyHashes = [] } = {}) {
  const now = snapshot.now;
  const policy = { ...normalizePurposeConfig(config), idleThresholdMs: 0 };
  const state = journal(saved);
  if (Object.keys({ ...state.terminals, ...state.transferTerminals }).length === 10000) throw fail('目的终态账目已满，已暂停新联系。');
  const priorReceipts = state.receipts;
  state.receipts = state.receipts.filter(row => currentReceipt(row, snapshot, now));
  // A reference-only pending item retains its own TTL. Extend source retrieval
  // only to reconstruct currently valid pending proofs, never label them fresh.
  const continuing = state.receipts.filter(row => row.outcome === 'sent' && row.pendingUntil > now);
  const materials = snapshot.engineItems.filter(item => item.at >= now -
    (item.source === 'bili' ? policy.biliWindowDays * DAY : policy.materialWindowHours * 3600000) ||
    continuing.some(row => row.usedProofs.some(ref => ref.id === snapshot.proofs[item.id]?.id && ref.revision === snapshot.proofs[item.id]?.revision)));
  if (publicMaterial && !materials.some(item => publicMaterial.sourceRefs[0]?.id === snapshot.proofs[item.id]?.id)) materials.push(publicMaterial.item);
  const persona = analyzePersona(snapshot.persona.text);
  // Projection order/deletion/auto-write cannot prove the latest owner activity.
  // Only a trusted host activity timestamp protected by this run's guard can do
  // so. Otherwise neutral elapsed-zero disables the engine's default 24h guess.
  const lastOwnerReceiptAt = materials.filter(item => item.kind === 'owner').reduce((latest, item) => Math.max(latest, item.at), 0) || null;
  const activityKnown = time(lastOwnerActivityAt) && lastOwnerActivityAt <= now;
  const lastMasterAt = activityKnown ? lastOwnerActivityAt : now;
  const { drives } = deriveDrives({ materials, now, lastMasterAt, personaBias: persona.bias });
  const { goals, observations } = formGoalHypotheses({ materials, drives, now, lastMasterAt, persona, config: policy });
  const usedIds = new Set([...materials, ...snapshot.timelessBackground].map(item => item.id));
  // Never pass the entire owner transcript to applyGoalFeedback. Rebuild each
  // attributed contribution once from its actual sent receipt and proved reply.
  for (const row of state.receipts.filter(row => row.outcome === 'sent').sort((a, b) => a.at - b.at)) {
    const goal = goals.find(goal => goal.id === row.goalId);
    if (!goal) continue;
    if (row.completed) { goal.status = 'done'; continue; }
    for (const reply of feedbackItems(row, snapshot)) {
      usedIds.add(reply.id);
      goal.attempts = 1;
      goal.lastActionAt = row.at;
      applyGoalFeedback([goal], [reply], reply.at);
    }
  }
  const rejectedSources = new Set(goals.filter(goal => ['rejected', 'done'].includes(goal.status)).flatMap(goal => goal.evidence.map(item => item.id)));
  const seeds = minePurposeSeeds({ materials, drives, now, lastMasterAt, config: policy })
    .filter(seed => !rejectedSources.has(seed.sourceId));
  const available = [...goals.filter(goal => !['rejected', 'done', 'expired'].includes(goal.status)).map(goalToCandidate), ...seeds];
  // Upgrade pre-terminal reference journals only when current relevant evidence
  // matches the original used proofs. This does not recover any old prose.
  for (const row of priorReceipts.filter(row => row.outcome === 'unknown' || row.completed)) {
    const candidate = available.find(item => item.id === row.candidateId) ||
      goals.filter(goal => goal.id === row.goalId).map(goalToCandidate)[0];
    const identity = candidate && candidateIdentity(candidate, goals, snapshot, publicMaterial);
    if (identity && (identity.sources.length ? identity.sources.every(ref => row.usedProofs.some(old => old.id === ref.id && old.revision === ref.revision)) :
      row.personaKey === personaKey(snapshot))) state.terminals[identity.key] = row.outcome === 'unknown' ? 'unknown' : 'done';
  }
  const terminal = candidate => state.terminals[candidateIdentity(candidate, goals, snapshot, publicMaterial)?.key];
  for (const goal of goals) if (terminal(goalToCandidate(goal)) === 'done') goal.status = 'done';
  const pending = [];
  for (const row of state.receipts) {
    if (row.outcome !== 'sent' || !row.pendingUntil || row.pendingUntil <= now) continue;
    if (state.receipts.some(later => later !== row && later.candidateId === row.candidateId && later.at >= row.at && later.outcome !== 'failed')) {
      row.pendingUntil = null;
      continue;
    }
    const candidate = available.find(candidate => candidate.id === row.candidateId);
    if (candidate && !terminal(candidate) && !feedbackItems(row, snapshot).length) pending.push({ ...candidate, weight: 1.35 });
    else row.pendingUntil = null;
  }
  const pendingIds = new Set(pending.map(item => item.id));
  const history = state.receipts.filter(row => row.outcome !== 'failed' && !pendingIds.has(row.candidateId)).map(row => {
    const candidate = available.find(candidate => candidate.id === row.candidateId);
    return candidate ? { ...candidate, at: row.at } : { goalId: row.goalId, at: row.at };
  });
  // selectPurpose de-duplicates goals before adding pending. Put pending entries
  // in its pending lane only so continuation retains its actual priority/flag.
  const coveredByPending = candidate => pending.some(item => item.id === candidate.id || textSimilarity(item.text, candidate.text) >= 0.8);
  const choice = selectPurpose({ seeds: seeds.filter(seed => !terminal(seed) && !coveredByPending(seed)),
    goals: goals.filter(goal => !terminal(goalToCandidate(goal)) && !coveredByPending(goalToCandidate(goal))), pending, history, drives, now, lastMasterAt, config: policy, random });
  const usedProofs = proofRefs(snapshot, usedIds);
  for (const ref of publicMaterial?.sourceRefs || []) if (!usedProofs.some(proof => proof.id === ref.id)) {
    const record = snapshot.context.records.find(record => record.id === ref.id);
    usedProofs.push({ ...ref, receivedAt: time(record?.source_metadata?.received_at_ms) ? record.source_metadata.received_at_ms : null });
  }
  return freeze({ snapshot, materials, importedBodyHashes, publicMaterial, publicThought: publicMaterial?.thought || '',
    purpose: choice.purpose, candidates: choice.candidates, fromPending: choice.fromPending,
    goals, observations, drives, state, usedProofs, personaKey: personaKey(snapshot),
    coverage: { ...snapshot.coverage, temporal_count: materials.length, pending_reference_count: continuing.length },
    pendingTtlMs: policy.pendingTtlDays * DAY,
    reason: choice.purpose ? 'purpose-selected' : 'no-purpose', lastMasterTimeKnown: activityKnown, lastOwnerReceiptAt,
    lastOwnerActivityAt: activityKnown ? lastOwnerActivityAt : null });
}

/** prepare returns an ephemeral plan and sanitized reference-only state. The caller
 * persists only plan.state / recordOutcome's return value, never the plan itself. */
export function createGovernedPurposePlanner({ capabilities, getPersona, guard } = {}) {
  const materials = createLocalPurposeMaterials({ capabilities, getPersona, guard });
  const plans = new WeakMap();
  const settled = new WeakSet();
  const originalGuard = additional => () => { guard?.(); additional?.(); };
  function checkpoint(plan) {
    const captured = plans.get(plan);
    if (!captured) throw fail('目的选择不属于本协调器的原快照。');
    if (captured.signal?.aborted) throw new CapabilityError('REQUEST_CANCELLED', '本轮目的已取消。', '重新预览当前目的。');
    captured.guard();
    if (captured.publicMaterial) checkPublicMaterial(captured.publicMaterial);
    const { snapshot } = plan, character = capabilities.currentCharacter(), persona = getPersona();
    if (capabilities.mode !== 'local' || character.id !== snapshot.persona.id || character.epoch !== snapshot.persona.epoch ||
        capabilities.supervisor.generation !== snapshot.context.binding.generation)
      throw new CapabilityError('STALE_CHARACTER', '原角色或服务代次已变化。', '重新预览当前角色。');
    if (!persona || persona.then || persona.id !== snapshot.persona.id || persona.epoch !== snapshot.persona.epoch ||
        (persona.revision ?? null) !== snapshot.persona.revision || (persona.hash ?? null) !== snapshot.persona.hash ||
        typeof persona.text !== 'string' || crypto.createHash('sha256').update(persona.text).digest('hex') !== snapshot.persona.textHash)
      throw new CapabilityError('STALE_PERSONA', '原目的使用的人格已变化。', '重新预览当前人格。');
    return true;
  }
  return {
    checkpoint,
    dispatchState(plan) {
      checkpoint(plan);
      if (!plan.purpose || settled.has(plan)) throw fail('目的快照不能重复派发。');
      const identity = candidateIdentity(plan.purpose, plan.goals, plan.snapshot, plan.publicMaterial);
      if (!identity) throw fail('目的派发缺少原目标证据。');
      const state = journal(plan.state);
      state.terminals[identity.key] = 'unknown';
      return state;
    },
    async prepare({ state, random, channel, now = Date.now(), config = {}, signal, guard: additionalGuard, lastOwnerActivityAt = null, publicMaterial = null } = {}) {
      const captured = { signal, guard: originalGuard(additionalGuard), publicMaterial };
      if (publicMaterial) { await validatePublicMaterial(publicMaterial); captured.guard(); }
      const policy = normalizePurposeConfig(config);
      const pendingAge = journal(state).receipts.filter(row => row.outcome === 'sent' && row.pendingUntil > now && row.at <= now)
        .reduce((age, row) => Math.max(age, now - Math.min(row.at, ...row.usedProofs.map(ref => ref.receivedAt || row.at))), 0);
      const retrieval = { ...config, materialWindowHours: Math.max(policy.materialWindowHours, Math.ceil(pendingAge / 3600000) + 1),
        biliWindowDays: Math.max(policy.biliWindowDays, Math.ceil(pendingAge / DAY) + 1) };
      const snapshot = await materials.snapshot({ channel, now, config: retrieval, limit: 20, ...captured });
      if (publicMaterial) { await validatePublicMaterial(publicMaterial); captured.guard(); }
      const imported = await capabilities.purposeState(snapshot.context); captured.guard();
      if (signal?.aborted) throw new CapabilityError('REQUEST_CANCELLED', '原目的读取已取消。');
      const saved = journal(state), replay = mergePurposeReplay({ terminals: saved.terminals, bodyHashes: [] }, imported);
      saved.terminals = replay.terminals;
      const plan = derivePlan(snapshot, saved, { config, random, lastOwnerActivityAt, publicMaterial, importedBodyHashes: replay.bodyHashes });
      plans.set(plan, captured);
      checkpoint(plan);
      return plan;
    },
    async validate(plan, options) {
      if (!plans.has(plan)) throw fail('目的选择不属于本协调器的原快照。');
      const captured = plans.get(plan);
      await materials.validate(plan.snapshot, { signal: captured.signal, guard: () => {
        checkpoint(plan);
        if (options?.signal?.aborted) throw new CapabilityError('REQUEST_CANCELLED', '本轮目的已取消。', '重新预览当前目的。');
        options?.guard?.();
      } });
      if (captured.publicMaterial) { await validatePublicMaterial(captured.publicMaterial); checkpoint(plan); }
      checkpoint(plan);
      return true;
    },
    recordOutcome(plan, receipt, { pending = false, completed = false, consumed = false } = {}) {
      if (!plans.has(plan) || settled.has(plan) || !plan.purpose || !id(receipt?.outreachId) || !origin(receipt.channel) ||
          !['sent', 'failed', 'unknown'].includes(receipt.outcome) || !time(receipt.at) || receipt.at < plan.snapshot.now ||
          typeof pending !== 'boolean' || typeof completed !== 'boolean' || typeof consumed !== 'boolean' || pending && completed) throw fail('目的结果需要原选择和真实载体终态。');
      const state = journal(plan.state);
      const prior = state.receipts.find(row => row.outreachId === receipt.outreachId);
      if (prior) throw fail('已有目的终态不能覆盖或跨载体重放。');
      const binding = plan.snapshot.context.binding;
      if (!sameOrigin(receipt.channel, { platform: binding.platform, account_id: binding.account, conversation_id: binding.conversation }))
        throw fail('目的回执与原实际目的地不一致。');
      if (receipt.outcome !== 'failed') {
        for (const row of state.receipts) if (row.candidateId === plan.purpose.id) row.pendingUntil = null;
      }
      const identity = candidateIdentity(plan.purpose, plan.goals, plan.snapshot, plan.publicMaterial);
      if (!identity) throw fail('选中的目的缺少原目标证据。');
      state.receipts.push({ terminalKey: identity.key, outreachId: receipt.outreachId, outcome: receipt.outcome, at: receipt.at,
        channel: origin(receipt.channel), deliveryId: receipt.deliveryId, conversationEpoch: receipt.conversationEpoch, sequence: receipt.sequence,
        candidateId: plan.purpose.id, goalId: plan.purpose.goalId, personaKey: plan.personaKey, usedProofs: copy(plan.usedProofs),
        pendingUntil: pending && (!plan.publicMaterial || plan.publicMaterial.sourceRefs.length) && receipt.outcome === 'sent' ? receipt.at + plan.pendingTtlMs : null,
        completed: completed && receipt.outcome === 'sent', feedback: [] });
      if (receipt.outcome === 'unknown' || completed && receipt.outcome === 'sent' || consumed && !(pending && receipt.outcome === 'sent'))
        state.terminals[identity.key] = receipt.outcome === 'unknown' ? 'unknown' : completed && receipt.outcome === 'sent' ? 'done' : 'consumed';
      // Transfer consumption survives volatile receipt retirement. It does not
      // suppress a source machine's still-valid continuation.
      if (receipt.outcome !== 'failed' || consumed) {
        const outcome = receipt.outcome === 'unknown' ? 'unknown' : completed ? 'done' : 'consumed';
        state.transferTerminals = mergePurposeReplay({ terminals: state.transferTerminals, bodyHashes: [] },
          { terminals: { [identity.key]: outcome }, bodyHashes: [] }).terminals;
      }
      settled.add(plan);
      return journal(state);
    },
  };
}
