import crypto from 'node:crypto';
import { collectMaterials } from '../../../src/purpose-engine.js';
import { CapabilityError } from './local-capabilities/supervisor.js';

const HOUR = 3600000;
// Diagnostic counter only; absence of these words NEVER admits background.
const TIME_CLAIM = /刚刚|刚才|最近|近期|即将|马上|待会|一会儿?|今[天早晚年月]|明[天早晚年月]|昨天|昨晚|前天|后天|[上下这本]个?(?:周|星期|礼拜|月|年)|周末|(?:\d+|[一二两三四五六七八九十百]+)\s*(?:分钟|小时|天|周|个月|年)(?:前|后|没|不)|\d{4}[-年/]\d{1,2}|\d+\s*(?:h|hours)\b|\b(?:today|tonight|tomorrow|yesterday|recently|soon|(?:this|last|next)\s+(?:morning|afternoon|evening|night|week|weekend|month|year)|(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+(?:ago|later|from now))\b/i;
const snapshots = new WeakMap();
const sourceKey = record => `local:${record.id}:r${record.revision}`;
const fail = (code, message) => new CapabilityError(code, message, '丢弃本轮素材，在当前角色与记忆版本重新开始；不会自动刷新旧答案。');
const copy = value => JSON.parse(JSON.stringify(value));
// Deliberately small, whole-statement positive grammar. Unknown pinned prose is
// not evidence of timelessness. Do not accept arbitrary trailing clauses, plans
// or open-ended objects; unsupported stable knowledge is safely left out too.
const ZH_PREFERENCE = '(?:喝茶|喝咖啡|茶|咖啡|读书|阅读|学习|编程|绘画|画画|音乐|游戏|运动|旅行|猫|狗)';
const STABLE_PREFERENCE_ZH = new RegExp(`^(?:(?:我|主人|用户)(?:现在|一直)?|旧记录说明[：:]\\s*)?(?:喜欢|不喜欢|偏好|讨厌)${ZH_PREFERENCE}(?:(?:、|和)${ZH_PREFERENCE}){0,2}[。.!！]?$`);
const EN_PREFERENCE = '(?:tea|coffee|reading|learning|programming|drawing|music|games|sports|travel|cats|dogs)';
const STABLE_PREFERENCE_EN = new RegExp(`^(?:I|The owner|The user) (?:currently )?(?:like|prefer|dislike) ${EN_PREFERENCE}(?: and ${EN_PREFERENCE}){0,2}[.!]?$`, 'i');
const STABLE_LANGUAGE = /^(?:我的|主人的|用户的)(?:母语|惯用语言)是(?:中文|汉语|普通话|英语|日语)[。.!！]?$/;
const timelessKnowledge = statement => [STABLE_PREFERENCE_ZH, STABLE_PREFERENCE_EN, STABLE_LANGUAGE].some(pattern => pattern.test(statement.trim()));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function captureContext(context) {
  const { host_gate, ...binding } = context.binding;
  const captured = copy({ ...context, binding });
  if (host_gate !== undefined) {
    // Tool host uses a WeakMap keyed by this frozen empty capability. Cloning it
    // destroys authority; retaining any mutable structural gate is also unsafe.
    if (!host_gate || typeof host_gate !== 'object' || !Object.isFrozen(host_gate) || Reflect.ownKeys(host_gate).length)
      throw fail('PROTOCOL_MISMATCH', '目的素材需要不可变的原宿主权限句柄。');
    captured.binding.host_gate = host_gate;
  }
  return freeze(captured);
}

function personaFrame(value) {
  if (!value || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      typeof value.text !== 'string' || value.revision === undefined && !value.hash ||
      value.revision !== undefined && !(typeof value.revision === 'string' && value.revision.length > 0 ||
        Number.isSafeInteger(value.revision) && value.revision >= 0) ||
      value.hash !== undefined && (typeof value.hash !== 'string' || !value.hash))
    throw fail('INVALID_REQUEST', '目的素材需要当前角色及明确修订的人格快照。');
  return { id: value.id, epoch: value.epoch, revision: value.revision ?? null, hash: value.hash ?? null,
    text: value.text, textHash: crypto.createHash('sha256').update(value.text).digest('hex') };
}
const samePersona = (a, b) => ['id', 'epoch', 'revision', 'hash', 'textHash'].every(key => a[key] === b[key]);

function checkFrame(capabilities, state, { signal, guard } = {}) {
  if (signal?.aborted) throw fail('REQUEST_CANCELLED', '本轮目的素材已取消。');
  // The caller checks its original run/config/activity generation synchronously.
  // Never acquire a replacement generation after an await.
  guard?.();
  const current = capabilities.currentCharacter();
  if (current.id !== state.character.id || current.epoch !== state.character.epoch || capabilities.mode !== 'local' ||
      state.context && (state.context.binding.generation !== capabilities.supervisor.generation ||
        state.context.binding.key !== `${current.id}:${current.epoch}`))
    throw fail('STALE_CHARACTER', '目的素材的原角色、服务或后端代次已变化。');
  if (state.persona && state.getPersona) {
    const latest = state.getPersona();
    if (latest?.then) throw fail('INVALID_REQUEST', 'getPersona 必须同步返回当前权威人格快照，以便每次等待后立即复核。');
    if (!samePersona(personaFrame(latest), state.persona)) throw fail('STALE_PERSONA', '人格已改变，原目的素材已取消。');
  }
}
async function checked(capabilities, state, options, operation) {
  checkFrame(capabilities, state, options);
  const value = await operation();
  checkFrame(capabilities, state, options);
  return value;
}
function eventId(record) {
  const refs = (record.source_refs || []).filter(ref => typeof ref === 'string' && ref.startsWith('event:'));
  return refs.length === 1 && refs[0].length > 6 ? refs[0].slice(6) : null;
}
function attribution(record) {
  const metadata = record.source_metadata || {};
  const role = metadata.source_speaker?.role || 'unknown';
  const statementOrigin = metadata.statement_origin || 'unknown';
  const original = metadata.verbatim === true && (statementOrigin === 'original' && !(record.derived_from || []).length ||
    statementOrigin === 'confirmed_output' && role === 'assistant' && (record.derived_from || []).length > 0);
  const owner = original && role === 'user' && metadata.source_speaker.owner_at_receive === true &&
    !record.audience_scope?.startsWith('qq:group:');
  return { role, statementOrigin, verbatim: original, owner,
    kind: owner ? 'owner' : original && role === 'assistant' ? 'self' :
      original && role === 'user' ? 'member' : original && role === 'external' ? 'video' : 'unknown' };
}

/**
 * No disk/history, models, readers or writes. context is the ORIGINAL authority
 * handle, not a model prompt. Only materials/background carry proved model text.
 * The service proves recursive active source closure before projection. Later
 * validation reprojects under this SAME binding/epoch/limit, including public
 * rows; it never selects a new channel or uses management/event-scope lookups.
 */
export async function capturePurposeSnapshot({ capabilities, channel, persona, getPersona, now = Date.now(), config = {},
  limit = 20, signal, guard } = {}) {
  if (!capabilities || typeof getPersona !== 'function' || !Number.isSafeInteger(now) || now <= 0)
    throw fail('INVALID_REQUEST', '目的素材需要能力服务、当前人格读取器和有效当前时间。');
  const state = { character: { ...capabilities.currentCharacter() }, context: null, getPersona, limit };
  const options = { signal, guard };
  const frame = personaFrame(persona ?? await checked(capabilities, state, options, getPersona));
  if (frame.id !== state.character.id || frame.epoch !== state.character.epoch)
    throw fail('STALE_CHARACTER', '提供的人格不属于本轮原角色。');
  state.persona = frame;
  state.context = captureContext(await checked(capabilities, state, options, () => capabilities.materials(channel, { limit })));
  const context = state.context;
  if (context.coverage.limit !== state.limit) throw fail('PROTOCOL_MISMATCH', '素材投影与原始数量上限不一致。');
  await checked(capabilities, state, options, () => capabilities.validate(context));
  const records = context.records;
  const engineItems = [], timelessBackground = [], proofs = {}, used = [];
  const coverage = { ...context.coverage, temporal_count: 0, background_count: 0, expired_count: 0,
    unknown_time_excluded: 0, attribution_excluded: 0, proof_unavailable: 0, temporal_background_excluded: 0,
    background_unproven_excluded: 0, bounded: true, notice: '仅覆盖当前目的地受众及本次有界投影；未出现不代表没有相关经历。' };
  for (const record of records) {
    if (record.status !== 'active' || !Number.isSafeInteger(record.revision) || record.revision < 1)
      throw fail('PROTOCOL_MISMATCH', '治理素材包含无法核验的记录版本。');
    const metadata = record.source_metadata || {}, identity = attribution(record);
    const at = metadata.time_basis === 'service_received' && Number.isSafeInteger(metadata.received_at_ms) && metadata.received_at_ms > 0
      ? metadata.received_at_ms : null;
    const id = sourceKey(record);
    const proof = { id: record.id, revision: record.revision, source_event_id: eventId(record),
      audience_scope: record.audience_scope, derived_from: record.derived_from || [],
      source_revisions: record.source_revisions || {}, recursiveClosure: 'service-validated',
      sourceMetadata: copy(metadata), attribution: identity };
    let admitted = false;
    if (at === null) coverage.unknown_time_excluded++;
    const windowMs = identity.kind === 'video' ? Math.max(1, Number(config.biliWindowDays) || 7) * 24 * HOUR :
      Math.max(1, Number(config.materialWindowHours) || 72) * HOUR;
    const temporal = at !== null && at <= now && at >= now - windowMs && identity.verbatim && identity.kind !== 'unknown';
    if (temporal) {
      // Per-record enrichment via the pure memory lane. Its sentinel timestamp
      // is the real receipt, and its shape is discarded before governed mapping;
      // this does not invent a QQ conversation, self experience or source clock.
      const enriched = collectMaterials({ now, config, memoryRecords: [{ id, text: record.statement,
        lastSeenAt: at, importance: 100, pinned: true }], roleName: config.roleName || '' }).items[0];
      if (enriched) {
        engineItems.push({ ...enriched, id, source: metadata.origin?.platform === 'bili' ? 'bili' : 'local',
          kind: identity.kind, at, who: identity.owner ? '主人' : identity.kind === 'self' ? '你' : identity.role === 'external' ? '外部来源' : '其他发言者',
          meta: { governed: true, internalOnly: true, proofKey: id, statementOrigin: identity.statementOrigin,
            // Pure engine private/owner classification, NOT a QQ conversation.
            key: record.audience_scope.startsWith('qq:group:') ? `group:governed:${record.audience_scope}` : `private:governed:${record.audience_scope}`,
            speakerRole: identity.role, ownerAtReceive: metadata.source_speaker?.owner_at_receive ?? null,
            verbatim: identity.verbatim, timeBasis: 'service_received' } });
        admitted = true;
      }
    } else if (at !== null && (at > now || at < now - windowMs)) coverage.expired_count++;
    if (!identity.verbatim || identity.kind === 'unknown') coverage.attribution_excluded++;
    // Only explicit supported stable knowledge is admitted, not everything that
    // escapes a temporal-word blacklist. Pinned is not proof of timelessness.
    if (!temporal && record.pinned === true && TIME_CLAIM.test(record.statement)) coverage.temporal_background_excluded++;
    if (!temporal && record.pinned === true && !timelessKnowledge(record.statement)) coverage.background_unproven_excluded++;
    if (!temporal && record.pinned === true && timelessKnowledge(record.statement)) {
      timelessBackground.push({ id, text: record.statement, at: null, kind: 'knowledge',
        statementOrigin: identity.statementOrigin, speakerRole: identity.role, verbatim: false,
        temporalFactsAllowed: false, proofKey: id });
      admitted = true;
    }
    if (admitted) {
      proofs[id] = proof;
      used.push(copy(record));
    }
  }
  coverage.temporal_count = engineItems.length; coverage.background_count = timelessBackground.length;
  const stats = { qq: 0, bili: engineItems.filter(item => item.source === 'bili').length,
    memory: engineItems.filter(item => item.source === 'local').length, thought: 0 };
  const snapshot = { context: captureContext(context), persona: frame, now, engineItems, materials: { items: engineItems, stats }, proofs, timelessBackground, coverage,
    lastMasterAt: engineItems.filter(item => item.kind === 'owner').reduce((latest, item) => Math.max(latest, item.at), 0) || null };
  // Internal authority copies prevent caller edits to the public sidecar/persona
  // from refreshing a snapshot. No source body is persisted or logged.
  state.used = freeze(copy(used)); state.getPersona = getPersona;
  state.persona = copy(frame);
  snapshots.set(snapshot, { capabilities, state });
  await validatePurposeSnapshot(snapshot, { capabilities, signal, guard });
  checkFrame(capabilities, state, options);
  return freeze(snapshot);
}

export async function validatePurposeSnapshot(snapshot, { capabilities, signal, guard } = {}) {
  const captured = snapshots.get(snapshot);
  if (!captured || capabilities && captured.capabilities !== capabilities) throw fail('INVALID_REQUEST', '目的素材不是本适配器创建的原快照。');
  capabilities = captured.capabilities;
  const { state } = captured, options = { signal, guard };
  const persona = personaFrame(await checked(capabilities, state, options, state.getPersona));
  if (!samePersona(persona, state.persona)) throw fail('STALE_PERSONA', '人格已改变，旧目的素材已取消。');
  await checked(capabilities, state, options, () => capabilities.validate(state.context));
  const result = await checked(capabilities, state, options, () => capabilities.supervisor.raw('memory.materials', state.context.binding,
    { limit: state.limit }));
  if (result.memory_epoch !== state.context.memory_epoch || result.character_epoch !== state.context.binding.character_epoch ||
      state.used.some(proof => !result.records?.some(record => record.id === proof.id && record.revision === proof.revision &&
        record.status === 'active' && JSON.stringify(record) === JSON.stringify(proof))))
    throw fail('STALE_CONTEXT', '实际使用的原来源已删除、停用或修订。');
  // Persona can change during any source await. Read it once more at the end.
  const finalPersona = personaFrame(await checked(capabilities, state, options, state.getPersona));
  if (!samePersona(finalPersona, state.persona)) throw fail('STALE_PERSONA', '来源核验期间人格已改变。');
  await checked(capabilities, state, options, () => capabilities.validate(state.context));
  return true;
}

export function createLocalPurposeMaterials({ capabilities, getPersona, guard } = {}) {
  return { snapshot: options => capturePurposeSnapshot({ capabilities, getPersona, guard, ...options }),
    validate: (snapshot, options) => validatePurposeSnapshot(snapshot, { capabilities, guard, ...options }) };
}
