/** Optional public-only material supply. The owner projection never enters here. */
import { CapabilityError } from './local-capabilities/supervisor.js';
import crypto from 'node:crypto';
import { collectMaterials } from '../../../src/purpose-engine.js';

const ephemeral = new WeakMap();
const unavailable = () => new CapabilityError('COMPANION_SOURCE_UNAVAILABLE', '本轮临时公开来源已失效。', '丢弃旧想法，读取新的独立公开来源；不会恢复被删除的内容。');
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function transientPublic({ capabilities, context, source, event, signal, guard, records = [], thought = '', observedAt = Date.now() }) {
  const material = records[0];
  const body = material?.text ?? JSON.stringify({ bvid: source.bvid, title: source.title, author: source.author,
    description: source.description, subtitle: source.subtitle, basis: source.basis, url: source.url });
  let saved; try { saved = JSON.parse(body); } catch {}
  const title = material ? typeof saved?.title === 'string' ? saved.title : '已治理的公开材料' : source.title;
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const character = { ...capabilities.currentCharacter() };
  const original = Object.freeze({ memory_epoch: context.memory_epoch, binding: Object.freeze({ ...context.binding }) });
  const enriched = collectMaterials({ now: observedAt, biliEntries: [{ id: source.bvid, bvid: source.bvid, at: observedAt,
    type: 'video', title, text: body, score: 12 }] }).items[0];
  const item = freeze({ ...enriched, id: `host-public:${bodyHash}`, at: observedAt,
    meta: { ...enriched.meta, timeBasis: 'host_observed_public', observedAt, videoEventTime: null } });
  const value = Object.freeze({ item, context: original, publicEventId: event, bodyHash, observedAt, thought,
    sourceRefs: freeze(records.map(record => ({ id: record.id, revision: record.revision }))),
    basis: material ? '仅当前治理版本公开文字，本次读取时间不是视频事件时间。' : source.basis, url: source.url, bvid: source.bvid });
  ephemeral.set(value, { capabilities, context: original, character, event, signal, guard, expiresAt: observedAt + 120000,
    sources: records.length ? records.map(record => ({ ...record })) : [{ source_event_id: event, status: 'missing' }] });
  return value;
}
export function checkPublicMaterial(value) {
  const record = ephemeral.get(value);
  if (!record) throw unavailable();
  record.guard();
  const character = record.capabilities.currentCharacter();
  if (record.signal?.aborted || Date.now() >= record.expiresAt || record.capabilities.mode !== 'local' ||
      character.id !== record.character.id || character.epoch !== record.character.epoch ||
      record.context.binding.generation !== record.capabilities.supervisor.generation) throw unavailable();
  return true;
}
export async function validatePublicMaterial(value) {
  checkPublicMaterial(value);
  const record = ephemeral.get(value);
  await record.capabilities.validate(record.context); checkPublicMaterial(value);
  const result = await record.capabilities.supervisor.raw('context.sources', record.context.binding, { source_event_ids: record.sources.map(source => source.source_event_id) });
  checkPublicMaterial(value);
  if (result.memory_epoch !== record.context.memory_epoch || result.sources?.length !== record.sources.length || record.sources.some(source => {
      const current = result.sources.find(item => item.source_event_id === source.source_event_id);
      return !current || current.status !== source.status || source.status === 'active' &&
        (current.id !== source.id || current.revision !== source.revision || current.text !== source.text);
    })) throw unavailable();
  await record.capabilities.validate(record.context); checkPublicMaterial(value);
  return true;
}

export async function browsePurposeMaterials({ capabilities, reader, state, signal, guard, research }) {
  const checked = async operation => { guard(); const result = await operation(); guard(); return result; };
  const channel = { kind: 'bili', account: 'public', peer: 'public', principal: 'public' };
  const candidates = await checked(() => reader.feed({ exclude: state.seen || [], signal }));
  const candidate = candidates.find(item => !(state.seen || []).includes(item.bvid));
  if (!candidate) return { outcome: 'no-new-material' };
  const source = await checked(() => reader.read(candidate.bvid, { signal }));
  if (source.bvid !== candidate.bvid || !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(source.bvid)) throw unavailable();
  state.seen = [...new Set([...(state.seen || []), source.bvid])].slice(-200);
  let context = await checked(() => capabilities.context(channel));
  const lookup = async event => {
    const result = await checked(() => capabilities.supervisor.raw('context.sources', context.binding, { source_event_ids: [event] }));
    if (result.memory_epoch !== context.memory_epoch) throw new CapabilityError('STALE_CONTEXT', '公开来源版本已变化。');
    const record = result.sources?.[0];
    if (!record || !['missing', 'active'].includes(record.status)) throw new CapabilityError('COMPANION_SOURCE_UNAVAILABLE', '公开来源已删除、停用或不可核验。', '保留治理结果，等候其他来源。');
    return record;
  };
  const event = `bili:public:${source.bvid}:material`;
  let material = await lookup(event);
  if (material.status === 'missing') {
    const saved = await checked(() => capabilities.ingest(context, event,
      JSON.stringify({ title: source.title, author: source.author, description: source.description, subtitle: source.subtitle, basis: source.basis }),
      { actor: 'external', original: true }));
    context = await checked(() => capabilities.context(channel));
    if (context.memory_epoch !== saved.memory_epoch) throw new CapabilityError('STALE_CONTEXT', '公开材料入库期间记忆已变化。');
    if (saved.stored === false && saved.skipped === true) {
      if ((await lookup(event)).status !== 'missing') throw unavailable();
      const publicMaterial = transientPublic({ capabilities, context, source, event, signal, guard });
      await validatePublicMaterial(publicMaterial); guard();
      const thought = await checked(() => research({ material: publicMaterial.item.text, basis: source.basis }, () => validatePublicMaterial(publicMaterial)));
      await validatePublicMaterial(publicMaterial); guard();
      const completed = transientPublic({ capabilities, context, source, event, signal, guard, thought, observedAt: publicMaterial.observedAt });
      await validatePublicMaterial(completed); guard();
      return { outcome: 'read-only', bvid: source.bvid, materialStored: false, thoughtStored: false, publicMaterial: completed, thought };
    }
    material = await lookup(event);
  }
  if (material.status !== 'active' || !material.id || !Number.isSafeInteger(material.revision)) throw new CapabilityError('STALE_CONTEXT', '公开材料缺少原记录版本。');
  const thoughtEvent = `${event}:thought:${material.id}:${material.revision}`;
  const existing = await lookup(thoughtEvent);
  if (existing.status === 'active') {
    const publicMaterial = transientPublic({ capabilities, context, source, event, signal, guard, records: [material, existing], thought: existing.text });
    await validatePublicMaterial(publicMaterial); guard();
    return { outcome: 'material-ready', bvid: source.bvid, materialStored: true, thoughtStored: true, publicMaterial, thought: existing.text };
  }
  const thought = await checked(() => research({ material: material.text }, async () => {
    await checked(() => capabilities.validate(context));
  }));
  await checked(() => capabilities.validate(context));
  const saved = await checked(() => capabilities.ingest(context, thoughtEvent, thought,
    { actor: 'assistant', derivedFrom: [{ id: material.id, revision: material.revision }] }));
  context = await checked(() => capabilities.context(channel));
  if (context.memory_epoch !== saved.memory_epoch) throw new CapabilityError('STALE_CONTEXT', '公开想法入库后代次已变化。');
  const thoughtRecord = await lookup(thoughtEvent);
  const records = [material, ...(thoughtRecord.status === 'active' ? [thoughtRecord] : [])];
  const currentThought = thoughtRecord.status === 'active' ? thoughtRecord.text : thought;
  const publicMaterial = transientPublic({ capabilities, context, source, event, signal, guard, records, thought: currentThought });
  await validatePublicMaterial(publicMaterial); guard();
  return { outcome: 'material-ready', bvid: source.bvid, materialStored: true, thoughtStored: saved.stored !== false, publicMaterial, thought: currentThought };
}
