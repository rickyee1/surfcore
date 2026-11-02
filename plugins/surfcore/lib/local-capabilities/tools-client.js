// Also embedded verbatim in tools-management.html by the authenticated host.
export const TOOLS_UI_OPS = Object.freeze([
  'status', 'tool.catalog', 'tool.subjects', 'tool.history', 'tool.status',
  'tool.emergency.status', 'tool.emergency.stop', 'tool.emergency.reset',
  'tool.roots.list', 'tool.roots.register', 'tool.roots.revoke',
  'tool.grants.list', 'tool.grants.create', 'tool.grants.revoke',
  'tool.result.read', 'tool.result.export.list', 'tool.result.export.status',
  'tool.result.export.confirm', 'tool.confirm', 'tool.cancel',
]);

export function mountToolsManagement({ document, root, base, token, fetch: fetcher = globalThis.fetch,
  pollMs = 5000, setInterval: every = globalThis.setInterval, clearInterval: clear = globalThis.clearInterval,
  now = Date.now } = {}) {
  if (!root || !document || !base || !token) throw new Error('Missing authenticated tools page configuration');
  const ui = {}, busy = new Set(), attempted = new Set();
  let disposed = false, loading = false, generation = 0, snapshot = null, review = null, exportReview = null, grantReview = null;
  let timer, exportOpen = 0, needsExplicitRefresh = false, lastEmergency = null;
  let localOpen = 0, viewedResult = null;
  const privateViews = new Set();
  function trackPrivate(view) {
    for (const old of privateViews) if (!root.contains(old)) privateViews.delete(old);
    if (root.contains(view)) privateViews.add(view);
  }
  const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const fingerprint = value => JSON.stringify(value);
  const failure = (code, error, hint) => ({ code, error, hint });
  function node(tag, value, parent, attrs = {}) {
    const el = document.createElement(tag);
    if (value !== undefined && value !== null) el.textContent = String(value);
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'id') ui[val] = el;
      if (key in el) el[key] = val; else el.setAttribute(key, val);
    }
    parent?.append(el); return el;
  }
  function section(title) { const s = node('section', null, root); node('h2', title, s); return s; }
  function field(parent, label, id, type = 'text', value = '') {
    const l = node('label', label, parent);
    return node(type === 'select' ? 'select' : 'input', null, l, { id, ...(type === 'select' ? {} : { type }), value });
  }
  function button(parent, label, id, action) {
    const el = node('button', label, parent, { type: 'button', id });
    el.onclick = () => act(id, el, action); return el;
  }
  function message(e) {
    ui.error.hidden = false;
    ui.error.textContent = `${e.code || 'REQUEST_FAILED'}：${e.error || '本机工具请求未完成。'}\n下一步：${e.hint || '刷新状态并人工核验；不要重放不明操作。'}`;
  }
  async function call(op, params = {}) {
    if (!TOOLS_UI_OPS.includes(op)) throw failure('PERMISSION_DENIED', '页面不允许此操作。', '使用已开放的本机管理按钮。');
    let response, data;
    try {
      response = await fetcher(base + '/api', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-surfcore-session': token }, body: JSON.stringify({ op, params }) });
      data = await response.json();
    } catch {
      throw failure('NETWORK_ERROR', '无法确认服务是否收到请求。', '检查本地服务，刷新状态并人工核验；不要重复确认或外发。');
    }
    if (!response.ok || data?.ok !== true) throw data?.code ? data : failure('PROTOCOL_ERROR', '服务返回无效响应。', '检查服务版本并刷新此页面。');
    return data.result;
  }
  async function act(key, el, action) {
    if (disposed || busy.has(key) || el.disabled) return;
    busy.add(key); el.disabled = true; ui.error.hidden = true;
    try { await action(); } catch (e) { message(e); }
    finally { busy.delete(key); if (!disposed) { el.disabled = false; controls(); } }
  }
  const safety = section('当前角色与工具状态');
  node('p', '只管理当前角色。身份由服务解析会话绑定，桌宠共享身份不等于 QQ 账号。', safety);
  node('p', '正在读取…', safety, { id: 'status', role: 'status' });
  node('p', '', safety, { id: 'faultStatus', role: 'status' });
  node('div', null, root, { id: 'error', role: 'alert', hidden: true });
  button(safety, '刷新 / 重试读取', 'refresh', () => refresh(true));
  button(safety, '总紧停：停止待执行与待发送', 'stop', async () => {
    invalidate('总紧停已发起；请核验状态。');
    await call('tool.emergency.stop'); ui.notice.textContent = '已请求紧停，旧任务不会自动重放。'; await refresh();
  });
  field(safety, '我已核对本机记录，确认解除紧停（不会重放旧任务）', 'resetCheck', 'checkbox');
  button(safety, '确认解除紧停', 'reset', async () => {
    if (!ui.resetCheck.checked) return;
    ui.resetCheck.checked = false; invalidate('解除紧停会使旧确认失效。');
    await call('tool.emergency.reset'); ui.notice.textContent = '已解除紧停；旧任务不会恢复，请重新发起需要的任务。'; await refresh();
  });
  ui.resetCheck.onchange = controls;
  node('p', '', safety, { id: 'notice', role: 'status' });
  const actions = section('待确认动作与历史（最近 50 条）');
  node('p', '核对实际参数、目标、来源和副作用后确认。确认只授予原请求；执行由原始渠道宿主继续。unknown 表示结果不明，请人工核验，不会自动重试。', actions);
  node('div', null, actions, { id: 'executions' });
  node('div', null, actions, { id: 'executionReview' });
  node('div', null, actions, { id: 'localResult' });
  const permissions = section('精确授权');
  node('p', '只从服务提供的主体与固定动作选择。目录登记不授予浏览或外发权限；外发须逐结果另行确认。', permissions);
  field(permissions, '来源主体（平台 / 账号 / 会话 / principal / 范围）', 'subject', 'select');
  field(permissions, '固定工具 / 动作 / 版本', 'tool', 'select');
  field(permissions, '已登记目录（路径工具必选）', 'grantRoot', 'select');
  const duration = field(permissions, '有效分钟（最多 43200）', 'minutes', 'number', '60'); duration.min = '1'; duration.max = '43200';
  const uses = field(permissions, '可用次数（1–100）', 'uses', 'number', '1'); uses.min = '1'; uses.max = '100';
  for (const id of ['subject', 'tool', 'grantRoot', 'minutes', 'uses']) {
    ui[id].oninput = ui[id].onchange = () => { grantReview = null; ui.grantSummary.textContent = '表单已改变，请重新核对授权摘要。'; ui.grantCheck.checked = false; controls(); };
  }
  button(permissions, '预览实际授权', 'previewGrant', previewGrant);
  node('pre', '', permissions, { id: 'grantSummary' });
  field(permissions, '我确认上述实际主体、工具、目录、期限和次数', 'grantCheck', 'checkbox');
  ui.grantCheck.onchange = controls;
  button(permissions, '保存这份精确授权', 'saveGrant', async () => {
    if (!grantValid() || !ui.grantCheck.checked) return;
    const params = grantReview.params; grantReview = null; ui.grantCheck.checked = false;
    await call('tool.grants.create', params); ui.grantSummary.textContent = '授权已保存。'; await refresh();
  });
  node('div', null, permissions, { id: 'grants' });
  const roots = section('本机目录登记');
  node('p', '手工输入本机绝对目录与标签。页面不会浏览目录或读取文件；服务只核验所登记目录。', roots);
  field(roots, '绝对目录', 'rootPath'); field(roots, '目录标签', 'rootLabel');
  button(roots, '登记此目录', 'registerRoot', async () => {
    const path = ui.rootPath.value.trim(), label = ui.rootLabel.value.trim();
    if (!/^[a-z]:[\\/]/i.test(path) || !label) throw failure('INVALID_REQUEST', '请输入本机盘符绝对目录与标签。', '例如 D:\\MyNotes；不要输入 UNC、设备路径或文件。');
    await call('tool.roots.register', { path, label }); ui.notice.textContent = '目录已登记，尚未授予工具权限。'; await refresh();
  });
  node('div', null, roots, { id: 'roots' });
  const exports = section('逐结果外发核对（最近 50 条）');
  node('p', '这里只核对宿主已准备的固定请求。正文仍在本机；确认后宿主才可按固定用途交付，页面不会发送。TTL 不会续期。consumed 表示已占用但交付尚未确认；unknown / unconfirmed 均不重放。memory_write=false，不授权保存记忆。', exports);
  node('div', null, exports, { id: 'exports' }); node('div', null, exports, { id: 'exportReview' });

  function subjectLabel(s) { return s ? `${s.platform} / ${s.account || '（无账号）'} / ${s.conversation || '（无会话）'} / ${s.principal} / ${s.audience_scope}` : '（无可用主体）'; }
  const needsRoot = tool => tool?.tool_id.startsWith('files.') || tool?.tool_id === 'local.open_directory';
  function options(el, items) {
    const old = el.value, list = fingerprint(items);
    if (el._options === list) return;
    el._options = list; el.replaceChildren();
    for (const [value, label] of [['', '请选择'], ...items]) node('option', label, el, { value });
    el.value = items.some(([value]) => value === old) ? old : '';
  }
  function grantForm() { return ['subject', 'tool', 'grantRoot', 'minutes', 'uses'].map(id => ui[id].value); }
  function grantValid() {
    if (loading || needsExplicitRefresh || !snapshot || lastEmergency?.persistence_fault || !grantReview || grantReview.form !== fingerprint(grantForm()) || grantReview.params.expires_at <= now()) return false;
    const p = grantReview.params;
    return snapshot.subjects.some(s => s.subject_binding === p.subject_binding) && snapshot.tools.some(t => t.tool_id === p.tool_id && t.action === p.action && t.descriptor_hash === p.descriptor_hash)
      && (!p.root_id || snapshot.roots.some(r => r.root_id === p.root_id && r.active));
  }
  function previewGrant() {
    const s = snapshot?.subjects.find(s => s.subject_binding === ui.subject.value), t = snapshot?.tools.find(t => t.tool_id === ui.tool.value);
    const r = snapshot?.roots.find(r => r.root_id === ui.grantRoot.value && r.active);
    const minutes = Number(ui.minutes.value), uses = Number(ui.uses.value);
    if (!s || !t || !Number.isInteger(minutes) || minutes < 1 || minutes > 43200 || !Number.isInteger(uses) || uses < 1 || uses > 100 || (needsRoot(t) && !r))
      throw failure('INVALID_REQUEST', '授权字段不完整或超出范围。', '选择服务提供的主体、动作、必要目录及有效期限/次数。');
    const params = { subject_binding: s.subject_binding, tool_id: t.tool_id, action: t.action, descriptor_hash: t.descriptor_hash, expires_at: now() + minutes * 60000, uses };
    if (needsRoot(t)) params.root_id = r.root_id;
    grantReview = { params, form: fingerprint(grantForm()) };
    ui.grantSummary.textContent = `当前角色：${snapshot.character}\n主体：${subjectLabel(s)}\n工具：${t.tool_id} / ${t.action} / ${t.version}\n目录：${needsRoot(t) ? `${r.label} · ${r.path} · ${r.root_id}` : '不涉及目录'}\n副作用：${t.side_effect ? '有' : '无'}；边界：${t.data_boundary}\n到期：${new Date(params.expires_at).toISOString()}\n实际 grant：\n${text(params)}`;
    ui.grantCheck.checked = false; controls();
  }
  function keyFor(kind, item) { return `${kind}:${item.execution_id || item.export_id}:${item.revision}`; }
  function controls() {
    const unavailable = loading || needsExplicitRefresh || !snapshot || lastEmergency?.persistence_fault || lastEmergency?.recovery_required === 'restart';
    ui.previewGrant.disabled = busy.has('previewGrant') || unavailable;
    ui.registerRoot.disabled = busy.has('registerRoot') || unavailable;
    ui.reset.disabled = busy.has('reset') || unavailable || !ui.resetCheck.checked || !snapshot?.emergency.closed;
    ui.saveGrant.disabled = busy.has('saveGrant') || !grantValid() || !ui.grantCheck.checked;
    if (ui.confirmExecution) ui.confirmExecution.disabled = unavailable || busy.has('confirmExecution') || !review || review.invalid || attempted.has(keyFor('execution', review.item)) || !ui.executionCheck.checked;
    if (ui.confirmExport) ui.confirmExport.disabled = unavailable || busy.has('confirmExport') || !exportReview || exportReview.invalid || exportReview.item.expires_at <= now() || attempted.has(keyFor('export', exportReview.item)) || !ui.exportCheck.checked;
  }
  function invalidate(reason) {
    generation++; grantReview = null;
    clearLocalResult(reason);
    for (const view of privateViews) view.textContent = '旧核对内容已清除，请重新读取当前角色结果。';
    privateViews.clear();
    ui.grantSummary.textContent = reason;
    if (review) { review.invalid = true; ui.executionWarning.textContent = reason; }
    if (exportReview) { exportReview.invalid = true; ui.exportWarning.textContent = reason; }
    controls();
  }
  function executionPrint(item) {
    const descriptor = snapshot.tools.find(t => t.tool_id === item.tool_id && t.descriptor_hash === item.descriptor_hash);
    return `当前角色：${item.character_id || snapshot.character} · 代次 ${item.character_epoch || '由服务绑定'}\n工具：${item.tool_id} / ${item.action}\n版本：${item.tool_version || descriptor?.version || '描述符已改变 / 不明'}\n描述符：${item.descriptor_hash}\n副作用：${descriptor ? (descriptor.side_effect ? '有' : '无') : '不明，请核验'}\n发起来源：${subjectLabel(item.subject)}\n状态：${item.state} · 修订 ${item.revision}\n执行 ID：${item.execution_id}\n实际参数：${text(item.arguments)}\n实际目标：${text(item.target_summary)}`;
  }
  function showExecution(item) {
    review = { item: structuredClone(item), signature: fingerprint(item), invalid: false };
    ui.executionReview.replaceChildren(); node('h3', '核对这一次原始请求', ui.executionReview);
    trackPrivate(node('pre', executionPrint(item), ui.executionReview));
    node('p', '', ui.executionReview, { id: 'executionWarning', role: 'status' });
    field(ui.executionReview, '我已核对这次请求的实际参数、来源与副作用', 'executionCheck', 'checkbox'); ui.executionCheck.onchange = controls;
    button(ui.executionReview, '确认这一次请求', 'confirmExecution', async () => {
      if (!review || review.invalid || !ui.executionCheck.checked) return;
      const item = review.item; attempted.add(keyFor('execution', item)); review.invalid = true;
      ui.executionCheck.checked = false; ui.executionWarning.textContent = '已提交确认；请读取状态核验，不自动重试。';
      const result = await call('tool.confirm', { execution_id: item.execution_id, expected_revision: item.revision, confirmation_digest: item.confirmation_digest });
      ui.executionWarning.textContent = `服务确认状态：${result.state}。请由原渠道宿主继续；页面不会执行。`; await refresh();
    }); controls();
  }
  async function readResult(item, container, current = () => true) {
    container.replaceChildren(); const ticket = generation;
    const result = await call('tool.result.read', { result_id: item.result_id });
    if (disposed || ticket !== generation || !current()) return null;
    if (result.local_only !== true || result.result_revision !== item.result_revision) throw failure('VERSION_CONFLICT', '本机结果版本不一致。', '刷新列表并重新核对结果。');
    node('p', '本机结果，尚未发送模型；本页面不保存或复制正文。', container);
    const body = node('pre', text(result.body), container); trackPrivate(body); return result;
  }
  function clearLocalResult(reason) {
    localOpen++; viewedResult = null; ui.localResult.replaceChildren();
    if (reason) node('p', reason, ui.localResult);
  }
  async function showLocalResult(item) {
    clearLocalResult(); const open = localOpen;
    viewedResult = { id: item.execution_id, signature: fingerprint(item) };
    node('h3', '本机结果', ui.localResult);
    button(ui.localResult, '收起结果', 'closeLocalResult', () => clearLocalResult());
    const container = node('div', null, ui.localResult);
    await readResult(item, container, () => localOpen === open && snapshot?.executions.some(row => row.execution_id === viewedResult?.id && fingerprint(row) === viewedResult.signature));
  }
  function exportSignature(item) { return fingerprint(item); }
  async function showExport(item) {
    const open = ++exportOpen;
    exportReview = null; ui.exportReview.replaceChildren();
    const container = node('div', null, ui.exportReview), ticket = generation;
    const fixed = structuredClone(item);
    node('h3', '核对具体正文与固定交付目标', ui.exportReview);
    const result = await readResult(fixed, container);
    if (!result || disposed || ticket !== generation || open !== exportOpen) return;
    // Never replace this reviewed descriptor from a later poll or form input.
    if (snapshot.exports.find(e => e.export_id === fixed.export_id && exportSignature(e) === exportSignature(fixed)) === undefined)
      throw failure('VERSION_CONFLICT', '外发请求已经改变。', '刷新列表，重新核对新的正文与固定目标。');
    const d = fixed.descriptor, purposes = d?.purposes;
    const validModel = d?.model && ['provider','model','config_revision'].every(key => typeof d.model[key] === 'string' && d.model[key].length > 0) && /^[a-f0-9]{64}$/.test(d.model.endpoint_identity);
    const validPrivate = !purposes?.includes('private_reply') || (['pet','qq'].includes(fixed.subject?.platform) && ['platform','account','conversation','principal','audience_scope'].every(key => d.private_destination?.[key] === fixed.subject[key]));
    const validDescriptor = d && d.memory_write === false && Array.isArray(purposes) && purposes.includes('model_input') && purposes.every(p => ['model_input', 'private_reply'].includes(p)) && validModel && validPrivate
      && Number.isInteger(fixed.prior_unconfirmed_count) && fixed.prior_unconfirmed_count >= 0 && Array.isArray(fixed.prior_unconfirmed_exports);
    trackPrivate(node('pre', `原始来源：${subjectLabel(fixed.subject)}\n固定目标与用途：\n${text(d)}\n结果：${fixed.result_id} / 修订 ${fixed.result_revision}\n到期：${new Date(fixed.expires_at).toISOString()}\n此前未确认交付总数：${fixed.prior_unconfirmed_count ?? '服务未提供；请核验'}（下列最多 20 条 ID）\n${text(fixed.prior_unconfirmed_exports || snapshot.exports.filter(e => e.export_id !== fixed.export_id && e.result_id === fixed.result_id && e.unconfirmed).map(e => e.export_id))}`, ui.exportReview));
    node('p', purposes?.includes('private_reply') ? '本次包含两跳：model_input 提交给固定模型，再允许 private_reply 返回上述原始私域会话。memory_write=false。' : '本次只允许 model_input 提交给上述固定模型，不授权私聊回复或保存记忆。memory_write=false。', ui.exportReview);
    exportReview = { item: fixed, signature: exportSignature(fixed), invalid: fixed.state !== 'prepared' || fixed.unconfirmed === true || fixed.delivery_confirmed === true || !validDescriptor };
    node('p', validDescriptor ? '核对后勾选；确认不代表已发送。' : '固定目标描述无效，已禁止确认。', ui.exportReview, { id: 'exportWarning', role: 'status' });
    field(ui.exportReview, '我已核对具体正文、固定模型、原始私域目标与此前不明交付，确认本次用途', 'exportCheck', 'checkbox'); ui.exportCheck.onchange = controls;
    button(ui.exportReview, '确认这一次固定外发用途', 'confirmExport', async () => {
      if (!exportReview || exportReview.invalid || !ui.exportCheck.checked || exportReview.item.expires_at <= now()) return;
      const item = exportReview.item; attempted.add(keyFor('export', item)); exportReview.invalid = true; ui.exportCheck.checked = false;
      ui.exportWarning.textContent = '已提交确认；状态不明时不重复提交。';
      const result = await call('tool.result.export.confirm', { export_id: item.export_id, expected_revision: item.revision, confirmation_digest: item.confirmation_digest });
      ui.exportWarning.textContent = `服务确认状态：${result.state}；尚不表示已发送。`; await refresh();
    }); controls();
  }
  function renderLists() {
    options(ui.subject, snapshot.subjects.map(s => [s.subject_binding, subjectLabel(s)]));
    options(ui.tool, snapshot.tools.map(t => [t.tool_id, `${t.tool_id} / ${t.action} / ${t.version} · ${t.data_boundary}`]));
    options(ui.grantRoot, snapshot.roots.filter(r => r.active).map(r => [r.root_id, `${r.label} · ${r.path} · ${r.root_id}`]));
    ui.executions.replaceChildren();
    for (const item of snapshot.executions) {
      const row = node('article', null, ui.executions, { className: 'row' });
      node('pre', executionPrint(item), row);
      if (item.error_code) node('p', `${item.error_code}：${item.error || '工具未完成'}\n下一步：${item.hint || '人工核验，不重放旧执行。'}`, row);
      if (!['awaiting_confirmation','authorized','running','succeeded','failed','cancelled','unknown'].includes(item.state) || item.state === 'unknown') node('p', '状态不明，未标为成功；请人工核验，不重放。', row);
      if (item.state === 'awaiting_confirmation') button(row, '核对这次请求', `review-${item.execution_id}`, () => showExecution(item));
      if (['awaiting_confirmation', 'authorized', 'running'].includes(item.state)) button(row, '取消任务', `cancel-${item.execution_id}`, async () => { await call('tool.cancel', { execution_id: item.execution_id }); await refresh(); });
      if (item.tool_id === 'time.now' && item.result) node('pre', text(item.result), row);
      else if (item.state === 'succeeded' && item.result_id) {
        button(row, '仅在本机查看结果', `result-${item.execution_id}`, () => showLocalResult(item));
      }
    }
    if (!snapshot.executions.length) node('p', '暂无执行记录。', ui.executions);
    for (const [id, items, label, op, idField] of [
      ['roots', snapshot.roots, '目录', 'tool.roots.revoke', 'root_id'], ['grants', snapshot.grants, '授权', 'tool.grants.revoke', 'grant_id'],
    ]) {
      ui[id].replaceChildren();
      for (const item of items) {
        const row = node('article', null, ui[id], { className: 'row' }); node('pre', `${label}：${item.active ? '有效' : '已撤销'}\n${text(item)}`, row);
        if (item.active) button(row, `撤销此${label}`, `revoke-${item[idField]}`, async () => {
          invalidate(`${label}撤销已发起，旧确认失效。`); await call(op, { [idField]: item[idField] }); ui.notice.textContent = `${label}已撤销。`; await refresh();
        });
      }
      if (!items.length) node('p', `暂无${label}。`, ui[id]);
    }
    ui.exports.replaceChildren();
    for (const item of snapshot.exports) {
      const row = node('article', null, ui.exports, { className: 'row' });
      const uncertain = item.unconfirmed || ['consumed','unknown'].includes(item.state) || !['prepared','confirmed','sent','failed','cancelled'].includes(item.state);
      node('pre', `外发 ${item.export_id} · ${item.state} · 修订 ${item.revision}\n${uncertain ? '交付不明 / 未确认，不重放。' : item.delivery_confirmed === true ? '服务回执确认已发送。' : '未确认已发送。'}\n固定目标：${text(item.descriptor)}\n原始来源：${subjectLabel(item.subject)}\n结果 ${item.result_id} / ${item.result_revision}`, row);
      if (item.state === 'prepared' && !uncertain && item.delivery_confirmed !== true) button(row, '查看正文与固定目标后核对', `reviewExport-${item.export_id}`, () => showExport(item));
    }
    if (!snapshot.exports.length) node('p', '没有宿主准备的外发请求。', ui.exports);
  }
  function roleKey(status) {
    const role = status?.character;
    if (typeof role?.id !== 'string' || !role.id || role.epoch === undefined || role.epoch === null)
      throw failure('PROTOCOL_ERROR', '服务未提供完整的角色与代次。', '检查宿主版本后，点击刷新重新读取。');
    return fingerprint([role.id, role.epoch]);
  }
  async function refresh(explicit = true) {
    if (disposed || loading || (!explicit && needsExplicitRefresh)) return;
    loading = true; controls();
    try {
      // A role-bound batch must be enclosed by two sequential identity reads.
      // Never publish parallel responses under an earlier role label.
      const status = await call('status'), role = roleKey(status);
      const emergency = await call('tool.emergency.status');
      if (disposed) return;
      lastEmergency = emergency;
      const restart = emergency.persistence_fault === true || emergency.recovery_required === 'restart';
      ui.faultStatus.textContent = restart ? '工具状态持久化故障：需修复存储并重启本地能力服务，核验 unknown 执行后再解除紧停；本进程重置无法解除。' : '';
      if (restart) {
        ui.resetCheck.checked = false;
        throw failure(emergency.code || emergency.error_code || 'TOOL_PERSISTENCE_FAULT', emergency.error || '工具及结果交付因持久化故障闭锁。', emergency.hint || '修复磁盘后重启本地能力服务，核验 unknown 执行，再由主人解除紧停；不要重放旧请求。');
      }
      const values = await Promise.all([
        call('tool.catalog'), call('tool.subjects'),
        call('tool.history', { limit: 50 }), call('tool.roots.list'), call('tool.grants.list'), call('tool.result.export.list', { limit: 50 }),
      ]);
      const after = await call('status');
      if (disposed) return;
      if (role !== roleKey(after)) throw failure('STALE_CHARACTER', '读取期间角色或代次已切换，整批工具数据已丢弃。', '点击“刷新 / 重试读取”重新读取完整当前角色数据，再核对授权或确认。');
      const [catalog, subjects, history, roots, grants, exports] = values;
      for (const list of [catalog.tools, subjects.subjects, history.executions, roots.roots, grants.grants, exports.exports])
        if (!Array.isArray(list)) throw failure('PROTOCOL_ERROR', '管理列表响应无效。', '检查服务版本后刷新页面。');
      const next = { character: status.character.id, characterSignature: role, emergency, tools: catalog.tools, subjects: subjects.subjects,
        executions: history.executions.slice(0, 50), roots: roots.roots, grants: grants.grants, exports: exports.exports.slice(0, 50) };
      if (snapshot && (snapshot.characterSignature !== next.characterSignature || snapshot.emergency.policy_generation !== emergency.policy_generation || emergency.closed || emergency.lockscreen_status !== 'unlocked')) invalidate('角色、策略或锁屏状态已变化；请重新核对当前请求。');
      snapshot = next; needsExplicitRefresh = false;
      if (viewedResult && !next.executions.some(row => row.execution_id === viewedResult.id && fingerprint(row) === viewedResult.signature)) clearLocalResult('结果版本或执行状态已变化，请重新读取当前结果。');
      if (review && !review.invalid && !next.executions.some(e => e.execution_id === review.item.execution_id && fingerprint(e) === review.signature)) { review.invalid = true; ui.executionWarning.textContent = '请求参数、版本或状态已变化；旧核对无效，请重新选择并核对。'; }
      if (exportReview && !exportReview.invalid && !next.exports.some(e => e.export_id === exportReview.item.export_id && exportSignature(e) === exportReview.signature)) { exportReview.invalid = true; ui.exportWarning.textContent = '外发目标、版本或状态已变化；旧核对无效。'; }
      ui.status.textContent = `当前角色：${next.character} · 工具：${emergency.closed ? '紧停闭锁' : '未紧停'} · Windows 锁屏：${emergency.lockscreen_status} · 策略代次 ${emergency.policy_generation} · 实机锁屏验证：${emergency.lockscreen_live_test || 'NOT_VERIFIED'}`;
      renderLists(); controls();
    } catch (e) {
      if (disposed) return;
      if (e.code === 'STALE_CHARACTER') needsExplicitRefresh = true;
      snapshot = null;
      invalidate('服务读取失败；整批数据已丢弃，旧核对已禁用。请点击刷新并人工核验。');
      for (const id of ['subject','tool','grantRoot']) options(ui[id], []);
      for (const id of ['executions','roots','grants','exports']) ui[id].textContent = '当前数据未核验，请刷新后查看。';
      ui.status.textContent = '工具状态读取失败；当前状态不明。'; message(e);
    }
    finally { loading = false; if (!disposed) controls(); }
  }
  const ready = refresh();
  if (pollMs > 0) timer = every(() => { controls(); void refresh(false); }, pollMs);
  controls();
  return { ready, refresh, dispose() { disposed = true; generation++; if (timer !== undefined) clear(timer); privateViews.clear(); root.replaceChildren(); } };
}
