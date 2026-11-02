import { CapabilityError } from './supervisor.js';

export const SEMANTIC_UI_OPS = Object.freeze(['memory.semantic.configure', 'memory.semantic.status',
  'memory.semantic.query.start', 'memory.semantic.rebuild.start', 'memory.semantic.job.status', 'memory.semantic.job.cancel']);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'stale']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = () => new CapabilityError('SEMANTIC_CONTEXT_TIMEOUT', '本轮语义检索未在八秒内完成，已取消。',
  '在本地语义检索页先重建索引，或关闭语义检索后重新提问；不会自动重试或更换模型。');
function bounded(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, timeout()), Math.max(0, ms));
    const abort = () => done(reject, new CapabilityError('REQUEST_CANCELLED', '本轮语义检索已取消。'));
    function done(fn, value) { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
  });
}

/** Integrates the accepted page API without renewing any authority or epoch. */
export async function refineSemanticContext(capabilities, context, query, { signal, now = Date.now, wait = sleep,
  budgetMs = 8000, maxPages = 4 } = {}) {
  const text = String(query || '').trim();
  if (!text) return { ...context, retrieval: { mode: 'recent', reason: 'empty_query' } };
  const deadline = now() + budgetMs;
  let activeJob = null, finished = false;
  const check = () => {
    if (signal?.aborted) throw new CapabilityError('REQUEST_CANCELLED', '本轮语义检索已取消。', '重新发起当前角色的对话。');
    if (now() >= deadline) throw timeout();
  };
  async function validate() { check(); await bounded(capabilities.validate(context), deadline - now(), signal); check(); }
  async function rpc(op, params) {
    check();
    const value = await bounded(capabilities.supervisor.raw(op, context.binding, params), deadline - now(), signal);
    check(); return value;
  }
  try {
    await validate();
    const status = await rpc('memory.semantic.status', {});
    if (!status.enabled) { await validate(); return { ...context, retrieval: { mode: 'recent', reason: 'semantic_disabled' } }; }
    const queryText = Array.from(text).slice(0, 1000).join('');
    const candidates = new Map();
    let offset = 0, covered = 0, eligible = 0, complete = false;
    for (let page = 0; page < maxPages; page++) {
      await validate();
      // Retain the job ID even when cancellation/deadline happens during start.
      const starting = capabilities.supervisor.raw('memory.semantic.query.start', context.binding,
        { query: queryText, limit: 20, offset, expected_memory_epoch: context.memory_epoch }).then(value => {
        if (finished) { void capabilities.supervisor.raw('memory.semantic.job.cancel', context.binding, { job_id: value.job_id }).catch(() => {}); }
        else activeJob = value.job_id;
        return value;
      });
      const started = await bounded(starting, deadline - now(), signal);
      activeJob = started.job_id;
      check(); let result = started;
      while (!terminal.has(result.state)) {
        await wait(Math.min(100, Math.max(1, deadline - now())));
        await validate();
        result = await rpc('memory.semantic.job.status', { job_id: activeJob });
      }
      if (result.state !== 'succeeded') throw new CapabilityError(result.code || 'SEMANTIC_CONTEXT_FAILED',
        result.error || '本轮语义检索未完成。', result.hint || '检查语义索引状态，重新提问；不会改用其他模型。');
      if (result.memory_epoch !== context.memory_epoch || result.character_epoch !== context.binding.character_epoch)
        throw new CapabilityError('STALE_CONTEXT', '检索期间角色或记忆已变化。', '重新提问，使用当前记忆。');
      await validate();
      const coverage = result.coverage;
      if (!coverage || coverage.offset !== offset || coverage.page_size !== 64 || !Number.isSafeInteger(coverage.eligible_count) || coverage.eligible_count < 0 ||
        (page && coverage.eligible_count !== eligible) || (coverage.has_more && coverage.next_offset !== offset + 64))
        throw new CapabilityError('PROTOCOL_MISMATCH', '语义检索覆盖范围无法核对。', '检查本地服务与插件版本后重试。');
      eligible = coverage.eligible_count; covered = Math.min(eligible, offset + 64);
      for (const record of result.memories || []) {
        if (typeof record.id !== 'string' || typeof record.statement !== 'string' || !Number.isFinite(record.semantic_score))
          throw new CapabilityError('PROTOCOL_MISMATCH', '语义命中格式无效。');
        candidates.set(record.id, record);
      }
      activeJob = null;
      if (!coverage.has_more) { complete = true; break; }
      offset = coverage.next_offset;
    }
    await validate();
    const recent = context.records || [];
    const sorted = [...candidates.values()].sort((a, b) => b.semantic_score - a.semantic_score);
    const chosen = new Map();
    for (const record of [...recent.filter(m => m.pinned), ...sorted.slice(0, 12), ...recent]) {
      if (chosen.size === 20) break;
      if (!chosen.has(record.id)) chosen.set(record.id, record);
    }
    const range = complete ? `语义检索覆盖当前受众全部 ${eligible} 条有效记忆。` :
      `语义检索覆盖当前受众按确认优先、最近排序的 ${covered}/${eligible} 条有效记忆；未命中不代表其余记忆中没有相关经历。`;
    const queryNotice = queryText !== text ? '检索使用提问的前一千字；回答仍应处理当前完整提问。' : '';
    return { ...context, records: [...chosen.values()], text: [range, queryNotice, ...[...chosen.values()].map(m => m.statement)].filter(Boolean).join('\n'),
      retrieval: { mode: 'semantic', complete, covered_count: covered, eligible_count: eligible, query_truncated: queryText !== text } };
  } finally {
    finished = true;
    if (activeJob) {
      // Cancelling the original binding never grants a replacement job or reveals its body.
      try { await bounded(capabilities.supervisor.raw('memory.semantic.job.cancel', context.binding, { job_id: activeJob }), 1000); } catch {}
    }
  }
}
