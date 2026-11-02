import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountToolsManagement, TOOLS_UI_OPS } from '../plugins/surfcore/lib/local-capabilities/tools-client.js';

// The production mount function creates all elements. This deliberately small DOM
// rejects HTML injection and exercises actual onclick/onchange handlers, not a
// second implementation of the UI's state machine.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null; this._text = '';
    this.id = ''; this.value = ''; this.type = ''; this.disabled = false; this.checked = false; this.hidden = false;
    this.className = ''; this.onclick = null; this.onchange = null; this.oninput = null;
  }
  set innerHTML(_) { throw Error('Unsafe innerHTML'); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  setAttribute(key, value) { this[key] = value; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
}
function all(root) { return [root, ...root.children.flatMap(all)]; }
const clone = structuredClone;
const NOW = 1900000000000;
const SUBJECT = { subject_binding: 'opaque-qq-binding', principal: 'owner:local', platform: 'qq', account: 'account-A', conversation: 'private-peer-A', audience_scope: 'owner:local' };
const TOOL = { tool_id: 'files.read_text', action: 'read', version: '1.0.0', descriptor_hash: 'fixed-tool-hash', side_effect: false, data_boundary: 'local_only' };
const EXECUTION = { execution_id: 'exec-1', revision: 1, state: 'awaiting_confirmation', tool_id: TOOL.tool_id, action: TOOL.action,
  descriptor_hash: TOOL.descriptor_hash, confirmation_digest: 'fixed-execution-digest', arguments: { root_id: 'root-1', relative_path: 'test.txt' },
  target_summary: { root_id: 'root-1', relative_path: 'test.txt', identity: 'fixed-object' }, subject: SUBJECT, character_id: 'synthetic-role', character_epoch: 'epoch-1', tool_version: '1.0.0' };
const EXPORT = { export_id: 'export-1', revision: 1, state: 'prepared', confirmation_digest: 'fixed-export-digest', result_id: 'result-1', result_revision: 1,
  expires_at: NOW + 60000, subject: SUBJECT, destination_ref: 'fixed-destination', prior_unconfirmed_exports: ['older-unknown'], prior_unconfirmed_count: 21,
  descriptor: { model: { provider: 'fixed-provider', model: 'fixed-model', config_revision: 'fixed-config', endpoint_identity: 'a'.repeat(64) },
    purposes: ['model_input'], private_destination: null, memory_write: false }, unconfirmed: false, delivery_confirmed: false };

const SHAPES = {
  status: [], 'tool.catalog': [], 'tool.subjects': [], 'tool.emergency.status': [], 'tool.emergency.stop': [], 'tool.emergency.reset': [],
  'tool.history': ['limit'], 'tool.roots.list': [], 'tool.grants.list': [], 'tool.result.export.list': ['limit'],
  'tool.confirm': ['execution_id', 'expected_revision', 'confirmation_digest'], 'tool.cancel': ['execution_id'],
  'tool.result.read': ['result_id'], 'tool.result.export.confirm': ['export_id', 'expected_revision', 'confirmation_digest'],
  'tool.roots.register': ['path', 'label'], 'tool.roots.revoke': ['root_id'], 'tool.grants.revoke': ['grant_id'],
};
async function fixture(overrides = {}) {
  const root = new Element('main'), document = { createElement: tag => new Element(tag) };
  const state = { character: { id: 'synthetic-role', epoch: 1 }, emergency: { closed: false, policy_generation: 1, lockscreen_status: 'unlocked', lockscreen_live_test: 'NOT_VERIFIED' },
    tools: [clone(TOOL)], subjects: [clone(SUBJECT)], executions: [clone(EXECUTION)],
    roots: [{ root_id: 'root-1', path: 'D:\\Synthetic', label: '测试根', active: true }], grants: [], exports: [clone(EXPORT)],
    body: '<img src=x onerror="steal()">private body & <script>alert(1)</script>', ...clone(overrides) };
  let currentTime = NOW, interceptor = null;
  const requests = [];
  const fetcher = async (url, init) => {
    assert.equal(url, '/synthetic-management/api'); assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.headers, { 'content-type': 'application/json', 'x-surfcore-session': 'synthetic-session' });
    const request = JSON.parse(init.body); requests.push(clone(request));
    assert.ok(TOOLS_UI_OPS.includes(request.op));
    if (request.op === 'tool.grants.create') {
      assert.deepEqual(Object.keys(request.params).sort(), ['subject_binding','tool_id','action','descriptor_hash','expires_at','uses', ...(request.params.root_id ? ['root_id'] : [])].sort());
    } else { assert.ok(SHAPES[request.op], `unhandled op ${request.op}`); assert.deepEqual(Object.keys(request.params).sort(), [...SHAPES[request.op]].sort()); }
    const intercepted = await interceptor?.(request); if (intercepted) return intercepted;
    let result;
    switch (request.op) {
      case 'status': result = { character: state.character }; break;
      case 'tool.emergency.status': result = state.emergency; break;
      case 'tool.catalog': result = { tools: state.tools }; break;
      case 'tool.subjects': result = { subjects: state.subjects }; break;
      case 'tool.history': assert.equal(request.params.limit, 50); result = { executions: state.executions }; break;
      case 'tool.roots.list': result = { roots: state.roots }; break;
      case 'tool.grants.list': result = { grants: state.grants }; break;
      case 'tool.result.export.list': assert.equal(request.params.limit, 50); result = { exports: state.exports }; break;
      case 'tool.confirm': result = { state: 'authorized' }; state.executions[0].state = 'authorized'; state.executions[0].revision++; break;
      case 'tool.cancel': result = { state: 'cancelled' }; state.executions[0].state = 'cancelled'; break;
      case 'tool.result.read': result = { body: state.body, local_only: true, result_revision: 1 }; break;
      case 'tool.result.export.confirm': result = { state: 'confirmed' }; state.exports.find(e => e.export_id === request.params.export_id).state = 'confirmed'; break;
      case 'tool.emergency.stop': state.emergency.closed = true; state.emergency.policy_generation++; result = clone(state.emergency); break;
      case 'tool.emergency.reset': state.emergency.closed = false; state.emergency.policy_generation++; result = clone(state.emergency); break;
      case 'tool.roots.register': result = { root_id: 'registered-root' }; break;
      case 'tool.roots.revoke': state.roots.find(r => r.root_id === request.params.root_id).active = false; result = { revoked: true }; break;
      case 'tool.grants.create': result = { grant_id: 'grant-1' }; state.grants.push({ ...request.params, grant_id: 'grant-1', active: true, remaining: request.params.uses }); break;
      case 'tool.grants.revoke': state.grants.find(g => g.grant_id === request.params.grant_id).active = false; result = { revoked: true }; break;
      default: assert.fail(`unexpected operation ${request.op}`);
    }
    return { ok: true, json: async () => ({ ok: true, result: clone(result) }) };
  };
  const app = mountToolsManagement({ document, root, base: '/synthetic-management', token: 'synthetic-session', fetch: fetcher, pollMs: 0, now: () => currentTime });
  await app.ready;
  const el = id => { const found = all(root).find(e => e.id === id); assert.ok(found, `element ${id}`); return found; };
  const click = id => el(id).onclick();
  const change = (id, value) => { const e = el(id); if (typeof value === 'boolean') e.checked = value; else e.value = String(value); return (e.onchange || e.oninput)?.(); };
  return { state, requests, app, root, el, click, change, intercept(fn) { interceptor = fn; }, time(value) { currentTime = value; }, calls(op) { return requests.filter(r => r.op === op); } };
}
let count = 0;
async function check(name, fn) { await fn(); console.log(`ok ${++count} ${name}`); }
const denied = () => ({ ok: false, json: async () => ({ ok: false, code: 'PERMISSION_DENIED', error: '主体不可访问', hint: '核对当前本机管理会话后刷新。' }) });

await check('actual mount renders tool/lock/role status and complete source identity', async () => {
  const f = await fixture(); assert.match(f.el('status').textContent, /synthetic-role.*unlocked/);
  assert.match(f.el('subject').textContent, /qq \/ account-A \/ private-peer-A \/ owner:local \/ owner:local/);
  assert.match(f.el('executions').textContent, /test.txt/); assert.match(f.el('executions').textContent, /1.0.0/);
  assert.equal(f.calls('tool.result.read').length, 0); f.app.dispose();
});
await check('execution confirmation requires explicit review checkbox and exact frozen fields', async () => {
  const f = await fixture(); await f.click('review-exec-1'); assert.equal(f.el('confirmExecution').disabled, true);
  await f.click('confirmExecution'); assert.equal(f.calls('tool.confirm').length, 0);
  f.change('executionCheck', true); await f.click('confirmExecution');
  assert.deepEqual(f.calls('tool.confirm')[0].params, { execution_id: 'exec-1', expected_revision: 1, confirmation_digest: 'fixed-execution-digest' });
  assert.equal(f.requests.some(r => r.op === 'tool.execute'), false); f.app.dispose();
});
await check('double click has one in-flight confirmation; response loss never retries same review', async () => {
  const f = await fixture(); let reject;
  f.intercept(r => r.op === 'tool.confirm' ? new Promise((_, fail) => { reject = fail; }) : null);
  await f.click('review-exec-1'); f.change('executionCheck', true);
  const pending = f.click('confirmExecution'); await f.click('confirmExecution'); assert.equal(f.calls('tool.confirm').length, 1);
  reject(Error('synthetic network lost private body')); await pending;
  assert.match(f.el('error').textContent, /NETWORK_ERROR.*\n下一步：.+/); assert.doesNotMatch(f.el('error').textContent, /private body/);
  await f.click('review-exec-1'); f.change('executionCheck', true); await f.click('confirmExecution'); assert.equal(f.calls('tool.confirm').length, 1); f.app.dispose();
});
await check('polling revision/argument changes invalidate reviewed execution rather than refresh its consent', async () => {
  const f = await fixture(); await f.click('review-exec-1'); f.change('executionCheck', true);
  f.state.executions[0].revision = 2; f.state.executions[0].arguments.relative_path = 'changed.txt'; await f.app.refresh();
  assert.match(f.el('executionWarning').textContent, /旧核对无效/); assert.match(f.el('executionReview').textContent, /test.txt/);
  assert.equal(f.el('confirmExecution').disabled, true); await f.click('confirmExecution'); assert.equal(f.calls('tool.confirm').length, 0); f.app.dispose();
});
await check('server stale revision keeps code/error/hint visible and does not silently reconfirm', async () => {
  const f = await fixture(); f.intercept(r => r.op === 'tool.confirm' ? { ok: false, json: async () => ({ ok: false, code: 'VERSION_CONFLICT', error: '旧修订不可确认', hint: '刷新并重新核对新请求。' }) } : null);
  await f.click('review-exec-1'); f.change('executionCheck', true); await f.click('confirmExecution');
  assert.match(f.el('error').textContent, /VERSION_CONFLICT：旧修订不可确认\n下一步：刷新并重新核对新请求/); await f.app.refresh();
  assert.equal(f.el('error').hidden, false); assert.equal(f.calls('tool.confirm').length, 1); f.app.dispose();
});
await check('unknown and new unrecognized execution states are visibly uncertain without confirm/replay', async () => {
  for (const state of ['unknown', 'future-state']) {
    const f = await fixture({ executions: [{ ...EXECUTION, state }] }); assert.match(f.el('executions').textContent, /状态不明，未标为成功/);
    assert.equal(all(f.root).some(e => e.id === 'review-exec-1'), false); assert.equal(f.calls('tool.confirm').length, 0); f.app.dispose();
  }
});
await check('cancellation uses only execution id and refreshes visible terminal state', async () => {
  const f = await fixture(); await f.click('cancel-exec-1'); assert.deepEqual(f.calls('tool.cancel')[0].params, { execution_id: 'exec-1' });
  assert.match(f.el('executions').textContent, /cancelled/); f.app.dispose();
});
await check('network disconnect and permission denied show safe structured actionable failures', async () => {
  const f = await fixture(); f.intercept(() => { throw Error('private body must not leak'); }); await f.app.refresh();
  assert.match(f.el('error').textContent, /NETWORK_ERROR：.+\n下一步：.+/); assert.match(f.el('status').textContent, /状态不明/);
  assert.doesNotMatch(f.root.textContent, /private body must not leak/);
  f.intercept(r => r.op === 'tool.history' ? denied() : null); await f.app.refresh(); assert.match(f.el('error').textContent, /PERMISSION_DENIED：主体不可访问\n下一步：核对当前本机管理会话后刷新/); f.app.dispose();
});
await check('emergency stop is immediate; reset needs explicit checkbox and never executes old work', async () => {
  const f = await fixture(); await f.click('stop'); assert.match(f.el('status').textContent, /紧停闭锁/);
  await f.click('reset'); assert.equal(f.calls('tool.emergency.reset').length, 0); f.change('resetCheck', true); await f.click('reset');
  assert.equal(f.calls('tool.emergency.reset').length, 1); assert.equal(f.el('resetCheck').checked, false);
  assert.match(f.el('notice').textContent, /旧任务不会恢复/); assert.equal(f.calls('tool.confirm').length, 0); f.app.dispose();
});
function fillGrant(f) { f.change('subject', SUBJECT.subject_binding); f.change('tool', TOOL.tool_id); f.change('grantRoot', 'root-1'); f.change('minutes', '30'); f.change('uses', '2'); }
await check('polling leaves dirty authorization and root form input intact', async () => {
  const f = await fixture(); fillGrant(f); f.change('rootPath', 'D:\\Unsaved'); f.change('rootLabel', '未保存'); await f.app.refresh();
  assert.equal(f.el('minutes').value, '30'); assert.equal(f.el('subject').value, SUBJECT.subject_binding); assert.equal(f.el('rootPath').value, 'D:\\Unsaved');
  assert.equal(f.el('rootLabel').value, '未保存'); f.app.dispose();
});
await check('grant preview shows concrete source, root, version, expiry and exact grant before create/revoke', async () => {
  const f = await fixture(); fillGrant(f); await f.click('previewGrant'); assert.match(f.el('grantSummary').textContent, /private-peer-A/);
  assert.match(f.el('grantSummary').textContent, /D:\\Synthetic/); assert.match(f.el('grantSummary').textContent, /1.0.0/);
  assert.equal(f.el('saveGrant').disabled, true); f.change('grantCheck', true); await f.click('saveGrant');
  assert.deepEqual(f.calls('tool.grants.create')[0].params, { subject_binding: SUBJECT.subject_binding, tool_id: TOOL.tool_id, action: 'read', descriptor_hash: TOOL.descriptor_hash, root_id: 'root-1', expires_at: NOW + 30 * 60000, uses: 2 });
  await f.click('revoke-grant-1'); assert.match(f.el('grants').textContent, /已撤销/); f.app.dispose();
});
await check('grant draft edits or descriptor disappearance invalidate explicit consent', async () => {
  const f = await fixture(); fillGrant(f); await f.click('previewGrant'); f.change('grantCheck', true); f.change('uses', '3');
  await f.click('saveGrant'); assert.equal(f.calls('tool.grants.create').length, 0);
  await f.click('previewGrant'); f.change('grantCheck', true); f.state.tools[0].descriptor_hash = 'new-hash'; await f.app.refresh();
  assert.equal(f.el('saveGrant').disabled, true); f.app.dispose();
});
await check('root registration is hand input only, rejects relative path and visibly revokes', async () => {
  const f = await fixture(); f.change('rootPath', '..\\bad'); f.change('rootLabel', 'x'); await f.click('registerRoot');
  assert.equal(f.calls('tool.roots.register').length, 0); assert.match(f.el('error').textContent, /INVALID_REQUEST.*\n下一步：.+/);
  f.change('rootPath', 'D:\\OnlyHumanEntered'); await f.click('registerRoot'); assert.deepEqual(f.calls('tool.roots.register')[0].params, { path: 'D:\\OnlyHumanEntered', label: 'x' });
  await f.click('revoke-root-1'); assert.match(f.el('roots').textContent, /已撤销/); assert.equal(f.calls('tool.result.read').length, 0); f.app.dispose();
});
await check('private body is fetched only on local-view click and rendered literally via textContent', async () => {
  const f = await fixture({ executions: [{ ...EXECUTION, state: 'succeeded', result_id: 'result-1', result_revision: 1 }] });
  assert.equal(f.calls('tool.result.read').length, 0); await f.click('result-exec-1');
  assert.equal(f.calls('tool.result.read').length, 1); assert.match(f.root.textContent, /<img src=x onerror="steal\(\)">/);
  assert.equal(all(f.root).some(e => ['img','script'].includes(e.tagName)), false); assert.match(f.root.textContent, /尚未发送模型/); f.app.dispose();
});
await check('an explicitly opened local result survives unchanged polling without another body read', async () => {
  const f = await fixture({ executions: [{ ...EXECUTION, state: 'succeeded', result_id: 'result-1', result_revision: 1 }] });
  await f.click('result-exec-1'); assert.match(f.el('localResult').textContent, /private body/);
  await f.app.refresh(false); await f.app.refresh();
  assert.match(f.el('localResult').textContent, /private body/); assert.equal(f.calls('tool.result.read').length, 1);
  await f.click('closeLocalResult'); assert.equal(f.el('localResult').textContent, ''); f.app.dispose();
});
await check('opened local results clear on result revision or authority changes', async () => {
  for (const change of ['result', 'role', 'policy']) {
    const f = await fixture({ executions: [{ ...EXECUTION, state: 'succeeded', result_id: 'result-1', result_revision: 1 }] });
    await f.click('result-exec-1');
    if (change === 'result') f.state.executions[0].result_revision = 2;
    if (change === 'role') f.state.character.epoch++;
    if (change === 'policy') f.state.emergency.policy_generation++;
    await f.app.refresh(); assert.doesNotMatch(f.el('localResult').textContent, /private body/);
    assert.equal(f.calls('tool.result.read').length, 1); f.app.dispose();
  }
});
await check('closing a local result before its response prevents late body resurrection', async () => {
  const f = await fixture({ executions: [{ ...EXECUTION, state: 'succeeded', result_id: 'result-1', result_revision: 1 }] });
  let release;
  f.intercept(r => r.op === 'tool.result.read' ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, result: { local_only: true, result_revision: 1, body: 'late private body' } }) }); }) : null);
  const pending = f.click('result-exec-1');
  for (let step = 0; step < 20 && !release; step++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release); await f.click('closeLocalResult'); release(); await pending;
  assert.equal(f.el('localResult').textContent, ''); assert.doesNotMatch(f.root.textContent, /late private body/); f.app.dispose();
});
await check('public time output is visible without private result-read', async () => {
  const f = await fixture({ executions: [{ ...EXECUTION, tool_id: 'time.now', state: 'succeeded', result: { utc: '2030-01-01T00:00:00Z', unix_ms: 1 } }] });
  assert.match(f.el('executions').textContent, /2030-01-01/); assert.equal(f.calls('tool.result.read').length, 0); f.app.dispose();
});
await check('export review shows concrete body/fixed target/prior total and needs checkbox', async () => {
  const f = await fixture(); await f.click('reviewExport-export-1'); assert.match(f.el('exportReview').textContent, /private body/);
  assert.match(f.el('exportReview').textContent, /fixed-provider/); assert.match(f.el('exportReview').textContent, /此前未确认交付总数：21/);
  assert.match(f.el('exportReview').textContent, /只允许 model_input.*不授权私聊回复或保存记忆/);
  assert.equal(f.el('confirmExport').disabled, true); await f.click('confirmExport'); assert.equal(f.calls('tool.result.export.confirm').length, 0);
  f.change('exportCheck', true); await f.click('confirmExport'); assert.deepEqual(f.calls('tool.result.export.confirm')[0].params, { export_id: 'export-1', expected_revision: 1, confirmation_digest: 'fixed-export-digest' }); f.app.dispose();
});
await check('combined consent states model-input plus original private-reply without memory write', async () => {
  const e = clone(EXPORT); e.descriptor.purposes.push('private_reply'); e.descriptor.private_destination = clone(SUBJECT);
  const f = await fixture({ exports: [e] }); await f.click('reviewExport-export-1'); assert.match(f.el('exportReview').textContent, /两跳：model_input.*private_reply/);
  assert.match(f.el('exportReview').textContent, /private-peer-A/); assert.match(f.el('exportReview').textContent, /memory_write=false/); f.app.dispose();
});
await check('polling target mutation invalidates old export review and cannot replace fixed target', async () => {
  const f = await fixture(); await f.click('reviewExport-export-1'); f.change('exportCheck', true);
  f.state.exports[0].descriptor.model.provider = 'other-provider'; await f.app.refresh();
  assert.match(f.el('exportWarning').textContent, /旧核对无效/); assert.equal(f.el('confirmExport').disabled, true);
  assert.doesNotMatch(f.el('exportReview').textContent, /other-provider/); await f.click('confirmExport'); assert.equal(f.calls('tool.result.export.confirm').length, 0);
  assert.equal(all(f.el('exportReview')).some(e => e.tagName === 'input' && e.type !== 'checkbox'), false); f.app.dispose();
});
await check('consumed, unknown, unconfirmed and future export states never expose confirm or replay', async () => {
  for (const state of ['consumed','unknown','future-state']) {
    const f = await fixture({ exports: [{ ...EXPORT, state, unconfirmed: state !== 'future-state' }] });
    assert.equal(all(f.root).some(e => e.id === 'reviewExport-export-1'), false);
    assert.match(f.el('exports').textContent, /交付不明 \/ 未确认，不重放/);
    assert.equal(f.calls('tool.result.export.confirm').length, 0); assert.equal(f.calls('tool.result.read').length, 0); f.app.dispose();
  }
});
await check('expired export, invalid destination descriptor and stale result revision fail closed', async () => {
  const f = await fixture(); await f.click('reviewExport-export-1'); f.change('exportCheck', true); f.time(NOW + 60001); await f.click('confirmExport'); assert.equal(f.calls('tool.result.export.confirm').length, 0); f.app.dispose();
  const g = await fixture({ exports: [{ ...EXPORT, descriptor: { ...EXPORT.descriptor, memory_write: true } }] }); await g.click('reviewExport-export-1'); g.change('exportCheck', true); assert.equal(g.el('confirmExport').disabled, true); g.app.dispose();
  const h = await fixture(); h.intercept(r => r.op === 'tool.result.read' ? { ok: true, json: async () => ({ ok: true, result: { local_only: true, body: 'wrong revision', result_revision: 2 } }) } : null);
  await h.click('reviewExport-export-1'); assert.match(h.el('error').textContent, /VERSION_CONFLICT.*\n下一步：.+/); assert.equal(all(h.root).some(e => e.id === 'confirmExport'), false); h.app.dispose();
});
await check('export confirmation loss remains uncertain, double click and rerender never resend', async () => {
  const f = await fixture(); let reject; f.intercept(r => r.op === 'tool.result.export.confirm' ? new Promise((_, fail) => { reject = fail; }) : null);
  await f.click('reviewExport-export-1'); f.change('exportCheck', true); const pending = f.click('confirmExport'); await f.click('confirmExport');
  reject(Error('lost')); await pending; await f.click('reviewExport-export-1'); f.change('exportCheck', true); await f.click('confirmExport');
  assert.equal(f.calls('tool.result.export.confirm').length, 1); assert.match(f.el('error').textContent, /NETWORK_ERROR/); f.app.dispose();
});
await check('overlapping export body reads cannot join an older body to a newer fixed target', async () => {
  const second = { ...clone(EXPORT), export_id: 'export-2', result_id: 'result-2', confirmation_digest: 'second-digest' };
  second.descriptor.model.model = 'second-fixed-model';
  const f = await fixture({ exports: [clone(EXPORT), second] }); let release;
  f.intercept(r => r.op === 'tool.result.read' && r.params.result_id === 'result-1' ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, result: { body: 'OLD PRIVATE BODY', result_revision: 1, local_only: true } }) }); }) : null);
  const firstRead = f.click('reviewExport-export-1'); await f.click('reviewExport-export-2'); release(); await firstRead;
  assert.match(f.el('exportReview').textContent, /second-fixed-model/); assert.doesNotMatch(f.el('exportReview').textContent, /OLD PRIVATE BODY/);
  f.change('exportCheck', true); await f.click('confirmExport'); assert.equal(f.calls('tool.result.export.confirm')[0].params.export_id, 'export-2'); f.app.dispose();
});
await check('missing unconfirmed-history metadata, mismatched private target and unconfirmed-prepared fail closed', async () => {
  const missing = clone(EXPORT); delete missing.prior_unconfirmed_count;
  const wrongPrivate = clone(EXPORT); wrongPrivate.descriptor.purposes.push('private_reply'); wrongPrivate.descriptor.private_destination = { ...SUBJECT, conversation: 'different-peer' };
  for (const item of [missing, wrongPrivate]) {
    const f = await fixture({ exports: [item] }); await f.click('reviewExport-export-1'); f.change('exportCheck', true);
    assert.equal(f.el('confirmExport').disabled, true); assert.match(f.el('exportWarning').textContent, /已禁止确认/); f.app.dispose();
  }
  const f = await fixture({ exports: [{ ...EXPORT, unconfirmed: true }] });
  assert.equal(all(f.root).some(e => e.id === 'reviewExport-export-1'), false); assert.match(f.el('exports').textContent, /交付不明/); f.app.dispose();
});
await check('policy/role change invalidates already reviewed grants/actions/exports', async () => {
  const f = await fixture(); fillGrant(f); await f.click('previewGrant'); f.change('grantCheck', true);
  await f.click('review-exec-1'); f.change('executionCheck', true); await f.click('reviewExport-export-1'); f.change('exportCheck', true);
  f.state.character.id = 'different-role'; f.state.emergency.policy_generation++; await f.app.refresh();
  for (const id of ['saveGrant','confirmExecution','confirmExport']) assert.equal(f.el(id).disabled, true);
  assert.doesNotMatch(f.el('exportReview').textContent, /private body/); assert.doesNotMatch(f.el('executionReview').textContent, /test.txt/); f.app.dispose();
});
await check('same role epoch change also clears sensitive reviewed body and disables consent', async () => {
  const f = await fixture(); await f.click('reviewExport-export-1'); f.change('exportCheck', true);
  f.state.character.epoch = 2; await f.app.refresh(); assert.equal(f.el('confirmExport').disabled, true);
  assert.doesNotMatch(f.el('exportReview').textContent, /private body/); f.app.dispose();
});
await check('production source has no storage/third-party/body logging/host-only capability calls', async () => {
  const source = fs.readFileSync(new URL('../plugins/surfcore/lib/local-capabilities/tools-client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|innerHTML|window\.open|URLSearchParams|location\./);
  for (const op of ['tool.destinations.register','tool.result.export.prepare','tool.result.export.consume','tool.result.export.validate','tool.result.export.finalize','tool.execute','tool.propose']) assert.equal(TOOLS_UI_OPS.includes(op), false);
  const html = fs.readFileSync(new URL('../plugins/surfcore/lib/local-capabilities/tools-management.html', import.meta.url), 'utf8');
  assert.match(html, /__TOOLS_CLIENT__/); assert.match(html, /__SESSION_TOKEN__/); assert.match(html, /mountToolsManagement/); assert.doesNotMatch(html, /https?:\/\//);
});
for (const sameRole of [false, true]) await check(`mid-refresh ${sameRole ? 'same-role epoch' : 'role'} switch discards the whole batch before any grant/confirmation`, async () => {
  const f = await fixture(); fillGrant(f); await f.click('previewGrant'); f.change('grantCheck', true);
  await f.click('review-exec-1'); f.change('executionCheck', true); await f.click('reviewExport-export-1'); f.change('exportCheck', true);
  f.change('rootPath', 'D:\\Unsaved'); f.change('rootLabel', '保留草稿');
  let changed = false;
  f.intercept(r => {
    if (r.op === 'status' && !changed) {
      const previous = clone(f.state.character); changed = true;
      f.state.character = { id: sameRole ? previous.id : 'role-B', epoch: 2 };
      f.state.subjects = [{ ...SUBJECT, subject_binding: 'binding-B', conversation: 'peer-B' }];
      f.state.roots = [{ root_id: 'root-B', path: 'D:/RoleBOnly', label: 'Role B root', active: true }];
      f.state.executions = []; f.state.exports = [];
      return { ok: true, json: async () => ({ ok: true, result: { character: previous } }) };
    }
    return null;
  });
  await f.app.refresh();
  assert.match(f.el('error').textContent, /STALE_CHARACTER.*\n下一步：.+/);
  assert.doesNotMatch(f.el('subject').textContent, /peer-B/); assert.doesNotMatch(f.el('roots').textContent, /Role B root/);
  assert.doesNotMatch(f.el('exportReview').textContent, /private body/);
  for (const id of ['saveGrant','confirmExecution','confirmExport','previewGrant','registerRoot']) assert.equal(f.el(id).disabled, true);
  f.change('subject', 'binding-B'); f.change('tool', TOOL.tool_id); f.change('grantRoot', 'root-B');
  await f.click('previewGrant'); f.change('grantCheck', true); await f.click('saveGrant'); await f.click('confirmExecution'); await f.click('confirmExport');
  assert.equal(f.calls('tool.grants.create').length, 0); assert.equal(f.calls('tool.confirm').length, 0); assert.equal(f.calls('tool.result.export.confirm').length, 0);
  assert.equal(f.el('rootPath').value, 'D:\\Unsaved'); assert.equal(f.el('rootLabel').value, '保留草稿'); assert.equal(f.el('minutes').value, '30');
  const callsBeforePoll = f.requests.length; await f.app.refresh(false); assert.equal(f.requests.length, callsBeforePoll);
  assert.equal(f.el('saveGrant').disabled, true);
  await f.click('refresh'); f.change('subject', 'binding-B'); f.change('tool', TOOL.tool_id); f.change('grantRoot', 'root-B');
  await f.click('previewGrant'); assert.match(f.el('grantSummary').textContent, new RegExp(`当前角色：${f.state.character.id}`));
  f.change('grantCheck', true); await f.click('saveGrant'); assert.equal(f.calls('tool.grants.create').length, 1); assert.equal(f.calls('tool.grants.create')[0].params.subject_binding, 'binding-B'); f.app.dispose();
});
await check('verification in flight disables all consent until the final role/epoch read completes', async () => {
  const f = await fixture(); fillGrant(f); await f.click('previewGrant'); f.change('grantCheck', true);
  await f.click('review-exec-1'); f.change('executionCheck', true); await f.click('reviewExport-export-1'); f.change('exportCheck', true);
  let statusReads = 0, release;
  f.intercept(r => r.op === 'status' && ++statusReads === 2 ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, result: { character: clone(f.state.character) } }) }); }) : null);
  const pending = f.app.refresh();
  for (let step = 0; step < 20 && !release; step++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release, 'refresh reached its final identity read');
  for (const id of ['saveGrant','confirmExecution','confirmExport','previewGrant','registerRoot']) assert.equal(f.el(id).disabled, true);
  await f.click('saveGrant'); await f.click('confirmExecution'); await f.click('confirmExport');
  assert.equal(f.calls('tool.grants.create').length, 0); assert.equal(f.calls('tool.confirm').length, 0); assert.equal(f.calls('tool.result.export.confirm').length, 0);
  release(); await pending; assert.equal(f.el('saveGrant').disabled, false); f.app.dispose();
});
await check('persistence fault exposes restart requirement and server code/hint; in-process reset is disabled', async () => {
  const f = await fixture(); f.state.emergency = { ...f.state.emergency, closed: true, persistence_fault: true, recovery_required: 'restart', error_code: 'TOOL_PERSISTENCE_FAULT', error: '合成存储闭锁', hint: '修复磁盘并重启能力服务，人工核验后再重置。' };
  await f.app.refresh(); assert.match(f.el('faultStatus').textContent, /需修复存储并重启.*本进程重置无法解除/);
  assert.match(f.el('error').textContent, /TOOL_PERSISTENCE_FAULT：合成存储闭锁\n下一步：修复磁盘并重启能力服务/);
  f.change('resetCheck', true); await f.click('reset'); assert.equal(f.calls('tool.emergency.reset').length, 0); assert.equal(f.el('reset').disabled, true);
  assert.equal(f.el('saveGrant').disabled, true); assert.equal(f.el('registerRoot').disabled, true);
  f.state.emergency = { ...f.state.emergency, persistence_fault: false, recovery_required: null }; await f.click('refresh');
  assert.equal(f.el('faultStatus').textContent, ''); f.change('resetCheck', true); await f.click('reset'); assert.equal(f.calls('tool.emergency.reset').length, 1); f.app.dispose();
});
await check('missing role epoch fails closed instead of publishing an unverifiable batch', async () => {
  const f = await fixture(); delete f.state.character.epoch; await f.app.refresh();
  assert.match(f.el('error').textContent, /PROTOCOL_ERROR：.+\n下一步：.+/); assert.equal(f.el('previewGrant').disabled, true); assert.equal(f.el('registerRoot').disabled, true); f.app.dispose();
});
console.log(`PASS ${count} local tools management DOM/fetch behavior checks; no backend, device, real roots or external sender used.`);
