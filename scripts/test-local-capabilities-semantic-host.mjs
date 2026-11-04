import assert from 'node:assert/strict';
import { refineSemanticContext } from '../plugins/surfcore/lib/local-capabilities/semantic-context.js';
import { CapabilityError } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { mountSemanticManagement } from '../plugins/surfcore/lib/local-capabilities/semantic-client.js';

let count = 0;
async function check(name, fn) { await fn(); console.log(`ok ${++count} ${name}`); }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function hostFixture({ eligible = 2, enabled = true } = {}) {
  let time = 0; const calls = [], hooks = {}, state = { epoch: 7, role: 'role-A', enabled };
  const context = { binding: { character_id: 'role-A', character_epoch: 'character-1', session_binding: 'opaque-pet' }, memory_epoch: 7,
    records: [{ id: 'pinned', statement: '用户纠正：不喝咖啡', pinned: true }, { id: 'recent', statement: '最近说过的话' }], text: '最近上下文' };
  const result = offset => ({ job_id: `job-${offset}`, state: 'succeeded', revision: 1, character_epoch: 'character-1', memory_epoch: 7, kind: 'query',
    coverage: { eligible_count: eligible, offset, page_size: 64, has_more: offset + 64 < eligible, next_offset: offset + 64 < eligible ? offset + 64 : null, complete: offset === 0 && eligible <= 64 },
    memories: eligible ? [{ id: `semantic-${offset}`, statement: `相关经历${offset}`, semantic_score: .9 - offset / 10000 }] : [] });
  const capabilities = { async validate(value) { assert.strictEqual(value, context); if (state.epoch !== value.memory_epoch || state.role !== value.binding.character_id) throw new CapabilityError('STALE_CONTEXT', '原记忆已变更。'); await hooks.validate?.(); },
    supervisor: { async raw(op, binding, params) { assert.strictEqual(binding, context.binding); calls.push({ op, params }); const value = await hooks[op]?.(params); if (value !== undefined) return value;
      if (op === 'memory.semantic.status') return { enabled: state.enabled, model_state: 'ready' };
      if (op === 'memory.semantic.query.start') return result(params.offset);
      if (op === 'memory.semantic.job.status') return result(Number(params.job_id.slice(4)));
      if (op === 'memory.semantic.job.cancel') return { state: 'cancelled' }; throw Error(op); } } };
  return { capabilities, context, calls, hooks, state, result, options: { now: () => time, wait: async ms => { time += ms; } }, advance: ms => { time += ms; }, run: (query = '出门习惯', extra = {}) => refineSemanticContext(capabilities, context, query, { now: () => time, wait: async ms => { time += ms; }, ...extra }) };
}
await check('empty and disabled contexts cause zero embedding requests', async () => {
  const f = hostFixture({ enabled: false }); assert.equal((await f.run('')).retrieval.reason, 'empty_query'); assert.equal(f.calls.length, 0);
  assert.equal((await f.run()).retrieval.reason, 'semantic_disabled'); assert.equal(f.calls.filter(c => c.op.endsWith('query.start')).length, 0);
});
await check('semantic supplements recent context, keeps pinned correction first and same authority', async () => {
  const f = hostFixture(), r = await f.run(); assert.strictEqual(r.binding, f.context.binding); assert.equal(r.memory_epoch, 7);
  assert.deepEqual(r.records.map(m => m.id), ['pinned', 'semantic-0', 'recent']); assert.match(r.text, /覆盖当前受众全部 2/); assert.equal(r.retrieval.complete, true);
  assert.equal(f.calls.some(c => c.params.audience === 'character'), false);
});
await check('all pages retain first epoch and finite chat coverage never claims full-library ranking', async () => {
  const f = hostFixture({ eligible: 350 }), r = await f.run(); assert.deepEqual(f.calls.filter(c => c.op.endsWith('query.start')).map(c => [c.params.offset, c.params.expected_memory_epoch]), [[0,7],[64,7],[128,7],[192,7]]);
  assert.equal(r.retrieval.complete, false); assert.equal(r.retrieval.covered_count, 256); assert.match(r.text, /256\/350.*未命中不代表/); assert.ok(r.records.length <= 20);
});
await check('long query is explicitly bounded in Unicode code points', async () => {
  const f = hostFixture(), r = await f.run('星'.repeat(1400)); assert.equal(f.calls.find(c => c.op.endsWith('query.start')).params.query.length, 1000); assert.equal(r.retrieval.query_truncated, true); assert.match(r.text, /检索使用提问的前一千字/);
});
await check('zero eligible records completes without invented memory hits', async () => { const f = hostFixture({ eligible: 0 }); assert.equal((await f.run()).retrieval.eligible_count, 0); });
await check('memory edit while a query starts rejects all late hits and cancels original job', async () => {
  const f = hostFixture(); f.hooks['memory.semantic.query.start'] = () => { f.state.epoch++; return f.result(0); };
  await assert.rejects(f.run(), e => e.code === 'STALE_CONTEXT'); assert.deepEqual(f.calls.at(-1), { op: 'memory.semantic.job.cancel', params: { job_id: 'job-0' } });
});
await check('role switch while query waits does not rebind into another role', async () => {
  const f = hostFixture(); f.hooks['memory.semantic.query.start'] = () => ({ ...f.result(0), state: 'running' }); f.hooks.validate = () => { if (f.calls.some(c => c.op.endsWith('query.start'))) f.state.role = 'role-B'; };
  await assert.rejects(f.run(), e => e.code === 'STALE_CONTEXT'); assert.equal(f.calls.at(-1).op, 'memory.semantic.job.cancel');
});
await check('timeout cancels ongoing page and never uses recent context as a fake semantic success', async () => {
  const f = hostFixture(); f.hooks['memory.semantic.query.start'] = () => ({ ...f.result(0), state: 'running' }); f.hooks['memory.semantic.job.status'] = () => ({ ...f.result(0), state: 'running' });
  await assert.rejects(f.run('query', { budgetMs: 200 }), e => e.code === 'SEMANTIC_CONTEXT_TIMEOUT' && e.hint.length > 0); assert.equal(f.calls.at(-1).op, 'memory.semantic.job.cancel');
});
await check('cold model may finish after eight seconds within one original 120 second budget', async () => {
  const f = hostFixture(); const progress = [];
  f.hooks['memory.semantic.status'] = () => ({ enabled: true, model_state: 'unloaded' });
  f.hooks['memory.semantic.query.start'] = () => ({ ...f.result(0), state: 'running' });
  f.hooks['memory.semantic.job.status'] = () => { f.advance(37000); return f.result(0); };
  const result = await f.run('query', { onProgress: value => progress.push(value) });
  assert.equal(result.retrieval.mode, 'semantic'); assert.equal(result.memory_epoch, 7);
  assert.equal(progress[0].state, 'loading'); assert.equal(progress[0].budget_ms, 120000);
  assert.equal(f.calls.filter(c => c.op.endsWith('query.start')).length, 1);
});
await check('cold timeout uses original deadline across status and all pages, never extends again', async () => {
  const f = hostFixture({ eligible: 80 });
  f.hooks['memory.semantic.status'] = () => { f.advance(6000); return { enabled: true, model_state: 'loading' }; };
  f.hooks['memory.semantic.query.start'] = ({ offset }) => ({ ...f.result(offset), state: 'running' });
  f.hooks['memory.semantic.job.status'] = ({ job_id }) => { f.advance(job_id === 'job-0' ? 110000 : 5000); return f.result(Number(job_id.slice(4))); };
  await assert.rejects(f.run(), e => e.code === 'SEMANTIC_CONTEXT_TIMEOUT');
  assert.equal(f.calls.filter(c => c.op.endsWith('query.start')).length, 2);
  assert.equal(f.calls.at(-1).op, 'memory.semantic.job.cancel');
});
await check('ready model retains eight seconds and cold failure never retries or refreshes authority', async () => {
  const ready = hostFixture();
  ready.hooks['memory.semantic.query.start'] = () => { ready.advance(8001); return ready.result(0); };
  await assert.rejects(ready.run(), e => e.code === 'SEMANTIC_CONTEXT_TIMEOUT');
  for (const state of ['loading', 'unavailable']) {
    const f = hostFixture();
    f.hooks['memory.semantic.status'] = () => ({ enabled: true, model_state: state });
    f.hooks['memory.semantic.query.start'] = () => ({ ...f.result(0), state: 'failed', code: 'SEMANTIC_WORKER_FAILED', error: '不可用。', hint: '检查本机模型。' });
    await assert.rejects(f.run(), e => e.code === 'SEMANTIC_WORKER_FAILED');
    assert.equal(f.calls.filter(c => c.op.endsWith('query.start')).length, 1);
    assert.equal(f.context.memory_epoch, 7);
  }
});
await check('abort during start returns promptly and a late job ID is cancelled once', async () => {
  const f = hostFixture(), gate = deferred(), started = deferred(), controller = new AbortController();
  f.hooks['memory.semantic.query.start'] = () => { started.resolve(); return gate.promise; };
  const running = f.run('query', { signal: controller.signal }); await started.promise; controller.abort();
  await assert.rejects(running, e => e.code === 'REQUEST_CANCELLED'); gate.resolve(f.result(0)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.filter(c => c.op.endsWith('job.cancel')).length, 1);
});
await check('busy, wrong coverage and mixed epochs stay structured failures', async () => {
  for (const mode of ['busy','coverage','epoch']) { const f = hostFixture(); f.hooks['memory.semantic.query.start'] = () => {
    if (mode === 'busy') throw new CapabilityError('SEMANTIC_BUSY', '工作槽占用。', '等待或取消。');
    const r = f.result(0); if (mode === 'coverage') r.coverage.offset = 64; else r.memory_epoch = 8; return r;
  }; await assert.rejects(f.run(), e => !!e.code && !!e.hint); }
});


await check('original ready deadline includes queue, first status and validation, even when cold', async () => {
 for(const stage of ['queue','status','validate']){
  const f=hostFixture();
  if(stage==='queue')f.advance(8000);
  if(stage==='status')f.hooks['memory.semantic.status']=()=>{f.advance(8000);return{enabled:true,model_state:'unloaded'}};
  if(stage==='validate')f.hooks.validate=()=>f.advance(8000);
  await assert.rejects(f.run('query',{requestStartedAt:0,readyDeadlineAt:8000,deadlineAt:120000}),e=>e.code==='SEMANTIC_CONTEXT_TIMEOUT'&&!!e.hint);
  assert.equal(f.calls.filter(c=>c.op.endsWith('query.start')).length,0);
 }
});
await check('both absolute deadlines only tighten and ready cannot inherit the cold limit', async () => {
 for(const cold of [false,true]){
  const f=hostFixture();let progressed=0;
  f.advance(3000);f.hooks['memory.semantic.status']=()=>({enabled:true,model_state:cold?'unloaded':'ready'});
  f.hooks['memory.semantic.query.start']=()=>{f.advance(cold?2001:501);return f.result(0)};
  await assert.rejects(f.run('query',{requestStartedAt:0,readyDeadlineAt:3500,deadlineAt:5000,onProgress:()=>progressed++}),e=>e.code==='SEMANTIC_CONTEXT_TIMEOUT');
  assert.equal(progressed,cold?1:0);assert.equal(f.calls.filter(c=>c.op.endsWith('query.start')).length,1);
 }
});
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; }
  set textContent(value) { this._text = String(value); this.children = []; } get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set innerHTML(_) { throw Error('Unsafe HTML'); }
  append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute(key, value) { this[key] = value; }
}
function all(el) { return [el, ...el.children.flatMap(all)]; }
async function uiFixture() {
  const root = new Element('main'), document = { createElement: tag => new Element(tag) }, calls = [], hooks = {};
  const state = { role: { mode: 'local', character: { id: 'synthetic-role', epoch: 1 } }, enabled: false, jobState: 'succeeded', jobRevision: 1, more: false, version: 4 };
  const job = (offset = 0) => ({ job_id: 'job-1', state: state.jobState, revision: state.jobRevision, memory_epoch: state.version, kind: 'query',
    coverage: { offset, page_size: 64, eligible_count: state.more ? 80 : 1, has_more: state.more && offset === 0, next_offset: state.more && offset === 0 ? 64 : null, complete: !state.more },
    memories: [{ id: 'memory-1', statement: '<script>synthetic private content</script>', revision: 2, status: 'active', semantic_score: .8 }] });
  const fetcher = async (url, init) => {
    assert.equal(url, '/local/api'); assert.equal(init.headers['x-surfcore-session'], 'synthetic-token'); assert.equal(init.credentials, 'same-origin');
    const req = JSON.parse(init.body); calls.push(req); let value = await hooks[req.op]?.(req.params);
    if (value === undefined) {
      if (req.op === 'status') value = structuredClone(state.role);
      else if (req.op === 'memory.semantic.status') value = { enabled: state.enabled, model: 'BGE', dimension: 512, model_state: 'ready', indexed_count: 1, eligible_count: 1 };
      else if (req.op.endsWith('.start')) value = job(req.params.offset || 0);
      else if (req.op.endsWith('.job.status')) value = job();
      else if (req.op.endsWith('.job.cancel')) value = { state: 'cancelled' };
      else if (req.op.endsWith('.configure')) { state.enabled = req.params.enabled; value = { enabled: state.enabled }; }
      else if (req.op === 'memory.detail') value = { memory: job().memories[0], sources: ['synthetic-source'] };
      else if (['memory.correct','memory.delete','memory.suspend'].includes(req.op)) value = { saved: true };
      else throw Error(req.op);
    }
    return { ok: true, json: async () => ({ ok: true, result: value }) };
  };
  const app = mountSemanticManagement({ document, root, base: '/local', token: 'synthetic-token', fetch: fetcher, pollMs: 0 }); await app.ready;
  const el = id => { const value = all(root).find(e => e.id === id); assert.ok(value, id); return value; };
  return { app, root, el, state, calls, hooks, job, click: id => el(id).onclick(), change: (id, value) => { const e = el(id); if (typeof value === 'boolean') e.checked = value; else e.value = value; return (e.oninput || e.onchange)?.(); } };
}
await check('semantic page loads fixed model status without launching inference', async () => { const f = await uiFixture(); assert.match(f.el('semanticStatus').textContent, /BGE.*512/); assert.equal(f.calls.some(c => c.op.endsWith('.start')), false); f.app.dispose(); });
await check('result uses text nodes and unchanged polling preserves an open correction draft', async () => {
  const f = await uiFixture(); await f.app.start(); assert.match(f.el('semanticResults').textContent, /<script>/);
  await f.click('semantic-correct-memory-1'); f.change('semanticStatement','edited draft'); await f.app.observe(); assert.equal(f.el('semanticStatement').value, 'edited draft'); assert.equal(f.el('semanticEditor').hidden, false); f.app.dispose();
});
await check('pagination explicitly carries the first epoch and page-only coverage', async () => {
  const f = await uiFixture(); f.state.more = true; await f.app.start(); assert.match(f.el('semanticCoverage').textContent, /不是全库排名/); await f.click('semanticNext');
  assert.deepEqual(f.calls.filter(c => c.op.endsWith('.query.start')).at(-1).params, { audience: 'session', query: '', limit: 20, offset: 64, expected_memory_epoch: 4 }); f.app.dispose();
});
await check('query edits cancel original job and late start cannot repopulate results', async () => {
  const f = await uiFixture(), gate = deferred(), started = deferred(); f.hooks['memory.semantic.query.start'] = () => { started.resolve(); return gate.promise; };
  const running = f.app.start(); await started.promise; f.change('semanticText','new query'); gate.resolve(f.job()); await running; await new Promise(r => setImmediate(r));
  assert.equal(f.el('semanticResults').textContent, ''); assert.equal(f.calls.filter(c => c.op.endsWith('.job.cancel')).length, 1); f.app.dispose();
});
await check('role change at final status clears body and disables pagination', async () => {
  const f = await uiFixture(); f.hooks['memory.semantic.query.start'] = () => { f.state.role.character = { id: 'other-role', epoch: 2 }; return f.job(); };
  await f.app.start(); assert.match(f.el('semanticError').textContent, /STALE_CHARACTER.*\n下一步：/); assert.equal(f.el('semanticResults').textContent, ''); assert.equal(f.el('semanticNext').disabled, true); f.app.dispose();
});
await check('deleted-source epoch invalidation removes results and draft on next status check', async () => {
  const f = await uiFixture(); await f.app.start(); await f.click('semantic-correct-memory-1'); f.state.jobState = 'stale'; await f.app.observe();
  assert.equal(f.el('semanticResults').textContent, ''); assert.equal(f.el('semanticEditor').hidden, true); assert.equal(f.el('semanticError').hidden, false); f.app.dispose();
});
await check('memory mutation requires explicit checkbox, uses reviewed revision and clears original query', async () => {
  const f = await uiFixture(); await f.app.start(); await f.click('semantic-delete-memory-1'); await f.click('semanticCommit'); assert.equal(f.calls.some(c => c.op === 'memory.delete'), false);
  f.change('semanticConfirm', true); await f.click('semanticCommit'); assert.deepEqual(f.calls.find(c => c.op === 'memory.delete').params, { id: 'memory-1', expected_revision: 2 }); assert.equal(f.el('semanticResults').textContent, ''); f.app.dispose();
});
await check('late old poll failure cannot erase a newer refreshed view', async () => {
  const f = await uiFixture(); await f.app.start(); const gate = deferred(), started = deferred(); f.hooks['memory.semantic.job.status'] = () => { started.resolve(); return gate.promise; };
  const old = f.app.observe(); await started.promise; await f.app.refresh(); f.hooks['memory.semantic.job.status'] = undefined; await f.app.start();
  gate.reject(Error('old transport failure')); await old; assert.match(f.el('semanticResults').textContent, /synthetic private content/); assert.equal(f.el('semanticError').hidden, true); f.app.dispose();
});
console.log(`PASS ${count} semantic host/UI checks; no remote model or device capture.`);
