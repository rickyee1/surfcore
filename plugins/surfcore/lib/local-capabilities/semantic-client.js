// Embedded verbatim by the existing authenticated management handler.
export function mountSemanticManagement({ document, root, base, token, fetch: fetcher = globalThis.fetch,
  pollMs = 700, setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
  const ui = {}; let generation = 0, job = null, page = null, role = null, pending = false, disposed = false, timer = null, editing = null;
  function node(tag, text, parent = root, attrs = {}) {
    const el = document.createElement(tag); if (text != null) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el[key] = value;
    parent.append(el); if (attrs.id) ui[attrs.id] = el; return el;
  }
  const fault = (code, error, hint = '重新核对当前角色和检索范围，再刷新本页。') => ({ code, error, hint });
  async function api(op, params = {}, keepalive = false, expectedRole = role) {
    let response, data;
    const expected = op === 'status' || !expectedRole ? null : JSON.parse(expectedRole);
    try { response = await fetcher(base + '/api', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
      headers: { 'content-type': 'application/json', 'x-surfcore-session': token }, body: JSON.stringify({ op, params,
        ...(expected ? { expectedCharacter: { id: expected[1], epoch: expected[2] } } : {}) }) }); data = await response.json(); }
    catch { throw fault('NETWORK_ERROR', '本地语义管理请求失败。', '检查本地能力服务后刷新；本次操作不会自动重试。'); }
    if (!response.ok || !data.ok) throw data?.code ? data : fault('SERVICE_UNAVAILABLE', '本地服务没有返回有效结果。');
    return data.result;
  }
  const identity = state => JSON.stringify([state.mode, state.character?.id, state.character?.epoch]);
  async function verify(expected = role) {
    const state = await api('status');
    if (state.mode !== 'local' || (expected && identity(state) !== expected)) throw fault('STALE_CHARACTER', '角色或后端已经变化，旧检索已清除。');
    return identity(state);
  }
  function controls() {
    ui.semanticQuery.disabled = pending || !role; ui.semanticRebuild.disabled = pending || !role;
    ui.semanticNext.disabled = pending || !page?.coverage?.has_more;
    ui.semanticCancel.disabled = !pending && !job;
    ui.semanticSave.disabled = pending || !role; ui.semanticCommit.disabled = !editing || !ui.semanticConfirm.checked;
  }
  function clearView() { page = null; editing = null; ui.semanticResults.replaceChildren(); ui.semanticDetail.replaceChildren(); ui.semanticCoverage.textContent = ''; ui.semanticEditor.hidden = true; ui.semanticConfirm.checked = false; controls(); }
  function invalidate() {
    generation++; clear(timer); timer = null; const id = job; job = null; pending = false; clearView();
    if (id) void api('memory.semantic.job.cancel', { job_id: id }, true).catch(() => {});
  }
  function report(error) { ui.semanticError.hidden = false; ui.semanticError.textContent = (error.code || 'SERVICE_UNAVAILABLE') + '：' + (error.error || '本地语义操作失败。') + '\n下一步：' + (error.hint || '刷新本页检查服务。'); }
  function run(fn) { return async () => { ui.semanticError.hidden = true; try { await fn(); } catch (error) { invalidate(); report(error); } }; }
  function current(captured) { return !disposed && captured === generation; }
  async function guarded(captured, fn) { try { return await fn(); } catch (error) { if (current(captured)) throw error; } }
  const statusBox = node('section'), errorBox = node('div', '', root, { id: 'semanticError', hidden: true }); errorBox.setAttribute('role', 'alert');
  node('h2', '模型与状态', statusBox); node('p', '尚未读取状态。', statusBox, { id: 'semanticStatus' });
  const label = node('label', '在聊天中启用本地语义检索', statusBox); node('input', null, label, { id: 'semanticEnabled', type: 'checkbox' });
  node('button', '保存开关', statusBox, { id: 'semanticSave', disabled: true }); node('button', '刷新状态', statusBox, { id: 'semanticRefresh' });
  node('p', '首次使用可先重建索引。聊天最多等待八秒、检索前四批（每批六十四条），按用户确认优先与最近记录排序；不足全库时会保留覆盖说明。页面可逐批查询全部记录。关闭后继续使用最近记忆，不调用语义模型。', statusBox);
  const searchBox = node('section'); node('h2', '查找与重建', searchBox);
  const scopeLabel = node('label', '检索范围', searchBox); const scope = node('select', null, scopeLabel, { id: 'semanticAudience', value: 'session' });
  node('option', '当前主人共享受众', scope, { value: 'session' }); node('option', '当前角色全部可管理记录', scope, { value: 'character' });
  node('input', null, searchBox, { id: 'semanticText', type: 'text', placeholder: '例如：我出门通常喜欢怎么走？', maxLength: 1000 });
  node('button', '按意思查找', searchBox, { id: 'semanticQuery', disabled: true }); node('button', '重建第一批索引', searchBox, { id: 'semanticRebuild', disabled: true });
  node('button', '下一批', searchBox, { id: 'semanticNext', disabled: true }); node('button', '取消任务 / 清除结果', searchBox, { id: 'semanticCancel', disabled: true });
  node('p', '', searchBox, { id: 'semanticCoverage' }); node('div', '', searchBox, { id: 'semanticResults' }); node('div', '', searchBox, { id: 'semanticDetail' });
  const editor = node('div', null, searchBox, { id: 'semanticEditor', hidden: true }); node('p', '', editor, { id: 'semanticEditSummary' });
  node('textarea', null, editor, { id: 'semanticStatement' }); const confirm = node('label', '我确认对当前这条记忆执行以上操作', editor); node('input', null, confirm, { id: 'semanticConfirm', type: 'checkbox' });
  node('button', '确认修改', editor, { id: 'semanticCommit', disabled: true }); node('button', '取消修改', editor, { id: 'semanticEditCancel' });

  async function refresh() {
    invalidate(); role = null; controls(); const captured = generation;
    return guarded(captured, async () => { const nextRole = await verify(null);
    const state = await api('memory.semantic.status', { audience: ui.semanticAudience.value }, false, nextRole);
    await verify(nextRole); if (!current(captured)) return;
    role = nextRole; ui.semanticEnabled.checked = state.enabled;
    const states = { unloaded: '尚未加载', loading: '正在加载', working: '正在计算', ready: '模型就绪', unavailable: '模型不可用' };
    ui.semanticStatus.textContent = '上次读取状态：' + state.model + ' · 本地 CPU · ' + state.dimension + ' 维\n已索引 ' + state.indexed_count + '/' + state.eligible_count + ' 条 · ' + (state.enabled ? '已启用' : '已关闭') + ' · ' + (states[state.model_state] || state.model_state);
    controls(); if (state.last_error) report(state.last_error);
    });
  }
  async function detail(record) {
    const captured = generation; return guarded(captured, async () => { await verify(); const data = await api('memory.detail', { id: record.id }); await verify();
    if (!current(captured)) return;
    if (data.memory?.revision !== record.revision || data.memory?.status !== 'active') throw fault('VERSION_CONFLICT', '这条记忆已变更，请重新查询。');
    ui.semanticDetail.replaceChildren(); node('h3', '来源与修订', ui.semanticDetail); node('p', data.memory.statement, ui.semanticDetail);
    const audiences = { 'owner:local': '主人共享私域', 'pet:local': '桌宠私下对话', 'bili:public': '公开 B站资料' };
    node('p', '使用范围：' + (audiences[data.memory.audience_scope] || '原始限定会话') + ' · 修订 ' + data.memory.revision, ui.semanticDetail);
    node('p', '来源记录 ' + (data.sources || []).length + ' 项。自动整理不能扩大原有来源的使用范围。', ui.semanticDetail);
    for (const revision of data.revisions || []) node('p', '修订 ' + revision.revision + '：' + (revision.statement || '内容已删除'), ui.semanticDetail);
    const details = node('details', null, ui.semanticDetail); node('summary', '查看完整来源记录', details); node('pre', JSON.stringify(data, null, 2), details);
    });
  }
  function edit(record, action) {
    editing = { id: record.id, expected_revision: record.revision, action };
    ui.semanticEditor.hidden = false; ui.semanticStatement.hidden = action !== 'correct'; ui.semanticStatement.value = record.statement;
    ui.semanticEditSummary.textContent = ({ correct: '纠正', suspend: '停止用于回答', delete: '删除本机托管正文和派生内容，保留防重放标记' })[action] + '\n' + record.statement + '\n修订 ' + record.revision;
    ui.semanticConfirm.checked = false; controls();
  }
  function render(result) {
    clearView(); page = result;
    const c = result.coverage, end = Math.min(c.eligible_count, c.offset + c.page_size);
    ui.semanticCoverage.textContent = `当前批次 ${Math.min(c.offset + 1, c.eligible_count)}–${end} / 共 ${c.eligible_count} 条；` +
      (c.complete ? '覆盖全部当前范围。' : '结果只属于本批，不是全库排名。') + (result.kind === 'rebuild' ? ` 已重建 ${result.indexed} 条。` : ' 分数仅用于相似度排序，不代表事实可信度。');
    for (const record of result.memories || []) {
      const row = node('div', null, ui.semanticResults, { className: 'row' });
      node('p', record.statement + ' · 修订 ' + record.revision + (record.pinned ? ' · 已由你确认' : '') + (Number.isFinite(record.semantic_score) ? ' · 相似度 ' + record.semantic_score.toFixed(3) : ''), row);
      for (const [text, action] of [['来源与修订', 'detail'], ['纠正', 'correct'], ['停止使用', 'suspend'], ['删除', 'delete']]) {
        const button = node('button', text, row, { id: 'semantic-' + action + '-' + record.id });
        button.onclick = run(async () => { if (action === 'detail') await detail(record); else { const captured = generation; await guarded(captured, async () => { await verify(); if (current(captured)) edit(record, action); }); } });
      }
    }
    controls();
  }
  async function observe(captured, expectedRole) {
    if (!current(captured) || !job) return;
    return guarded(captured, async () => {
    await verify(expectedRole); const result = await api('memory.semantic.job.status', { job_id: job }); await verify(expectedRole);
    if (!current(captured)) return;
    if (['failed', 'cancelled', 'stale'].includes(result.state)) throw result;
    if (result.state === 'succeeded') { pending = false; if (!page || page.job_id !== result.job_id || page.revision !== result.revision) render(result); }
    // Keep a visible result tied to the original epoch: correction/deletion/restore
    // elsewhere invalidates it on the next check without launching a new query.
    if (pollMs > 0) timer = later(() => run(() => observe(captured, expectedRole))(), pollMs);
    });
  }
  async function start(kind, next = false) {
    if (pending || !role) return;
    const previous = page;
    if (next && !previous?.coverage?.has_more) return;
    const expectedRole = role; let captured = generation; pending = true; controls();
    const params = { audience: ui.semanticAudience.value, ...(kind === 'query' ? { query: ui.semanticText.value, limit: 20 } : {}) };
    if (next) Object.assign(params, { offset: previous.coverage.next_offset, expected_memory_epoch: previous.memory_epoch });
    let result;
    try {
      await verify(expectedRole); if (!current(captured)) return;
      invalidate(); captured = generation; pending = true; controls();
      result = await api('memory.semantic.' + kind + '.start', params);
      if (!current(captured)) { void api('memory.semantic.job.cancel', { job_id: result.job_id }, true).catch(() => {}); return; }
      job = result.job_id; await verify(expectedRole); if (!current(captured)) return;
      ui.semanticCoverage.textContent = '正在本机处理当前批次，可以取消。';
      if (['failed', 'cancelled', 'stale'].includes(result.state)) throw result;
      if (result.state === 'succeeded') { pending = false; render(result); }
      if (pollMs > 0) timer = later(() => run(() => observe(captured, expectedRole))(), pollMs);
    } catch (error) { if (current(captured)) throw error; }
  }
  ui.semanticRefresh.onclick = run(refresh);
  ui.semanticSave.onclick = run(async () => { const enabled = ui.semanticEnabled.checked, expected = role; invalidate(); const captured = generation; await guarded(captured, async () => { await verify(expected); if (!current(captured)) return; await api('memory.semantic.configure', { enabled }); if (current(captured)) await refresh(); }); });
  ui.semanticQuery.onclick = run(() => start('query')); ui.semanticRebuild.onclick = run(() => start('rebuild'));
  ui.semanticNext.onclick = run(() => start(page?.kind || 'query', true));
  ui.semanticCancel.onclick = () => { invalidate(); ui.semanticCoverage.textContent = '已取消任务并清除本页结果。'; };
  ui.semanticText.oninput = () => { invalidate(); ui.semanticCoverage.textContent = '查询已修改，请重新查找。'; };
  ui.semanticAudience.onchange = run(refresh); ui.semanticConfirm.onchange = controls;
  ui.semanticEditCancel.onclick = () => { editing = null; ui.semanticEditor.hidden = true; controls(); };
  ui.semanticCommit.onclick = run(async () => {
    if (!editing || !ui.semanticConfirm.checked) return;
    const { action, ...params } = editing; if (action === 'correct') params.statement = ui.semanticStatement.value;
    const expected = role; invalidate(); const captured = generation;
    await guarded(captured, async () => { await verify(expected); if (!current(captured)) return; await api('memory.' + action, params); if (!current(captured)) return; await refresh();
      ui.semanticCoverage.textContent = '修改已保存，旧检索结果已清除。请重新查询。'; });
  });
  const hide = () => { invalidate(); ui.semanticCoverage.textContent = '页面隐藏，任务与结果已清除。'; };
  document.defaultView?.addEventListener('pagehide', hide);
  const visibility = () => { if (document.hidden) hide(); }; document.addEventListener?.('visibilitychange', visibility);
  const ready = run(refresh)();
  return { ready, refresh: run(refresh), observe: () => run(() => observe(generation, role))(), start: (kind = 'query', next = false) => run(() => start(kind, next))(),
    dispose() { disposed = true; invalidate(); document.defaultView?.removeEventListener('pagehide', hide); document.removeEventListener?.('visibilitychange', visibility); } };
}
