// Fixed browser surface. No portable.*, arbitrary paths or background retries.
export function mountRolePackages({ document, fetch, base, token, URL = globalThis.URL }) {
  const get = name => document.getElementById(name);
  let pending = false, approval = null, inspection = null, operation = null, exported = null;
  const output = value => { get('package-output').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  const headers = { 'content-type': 'application/json', 'x-surfcore-session': token };
  async function api(op, params = {}) {
    const response = await fetch(`${base}/api`, { method: 'POST', headers, body: JSON.stringify({ op: `role.package.${op}`, params }) });
    const value = await response.json(); if (!value.ok) throw Object.assign(new Error(value.error || '角色包操作失败。'), { code: value.code, hint: value.hint }); return value.result;
  }
  function render() {
    for (const button of document.querySelectorAll('[data-package-action]')) button.disabled = pending;
    get('package-confirm').disabled = pending || !approval || !get('package-consent').checked;
    get('package-stage').disabled = pending || !inspection || inspection.duplicate;
    get('package-download').disabled = pending || !exported?.approved;
    get('package-status').disabled = pending || !operation;
    get('package-recover').disabled = pending || !operation;
    get('package-review').disabled = pending || !operation?.native_review?.review_digest || !get('package-consent').checked;
    get('package-cancel').disabled = pending || !operation;
  }
  function invalidate() { approval = null; get('package-consent').checked = false; render(); }
  async function run(action) {
    if (pending) return; pending = true; render();
    try { await action(); }
    catch (error) { approval = null; output({ code: error.code || 'RESULT_UNCONFIRMED', error: error.message, hint: error.hint || '结果未确认，只查询操作状态；不要重新提交。', operation_id: operation?.operation_id }); }
    finally { pending = false; get('package-password').value = ''; render(); }
  }
  function adopt(result) {
    operation = result; get('package-operation').value = result.operation_id || '';
    output(result); invalidate();
  }
  get('package-consent').addEventListener('change', render);
  for (const name of ['package-password', 'package-mode', 'package-file', 'package-assets']) get(name).addEventListener('input', invalidate);
  get('package-export').addEventListener('click', () => run(async () => {
    invalidate(); const assets = JSON.parse(get('package-assets').value || '[]');
    exported = await api('export.prepare', { password: get('package-password').value, assets });
    approval = { kind: 'export', value: exported }; output(exported);
  }));
  get('package-upload').addEventListener('click', () => run(async () => {
    invalidate(); inspection = null; const selected = get('package-file').files?.[0]; if (!selected) throw new Error('请选择 .scrole 文件。');
    const response = await fetch(`${base}/role-package/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-surfcore-session': token }, body: selected });
    const value = await response.json(); if (!value.ok) throw Object.assign(new Error(value.error), value);
    get('package-id').value = value.result.package_id; output(value.result);
  }));
  get('package-inspect').addEventListener('click', () => run(async () => {
    invalidate(); inspection = await api('import.inspect', { package_id: get('package-id').value, password: get('package-password').value, mode: get('package-mode').value });
    if (inspection.duplicate) adopt(inspection); else output(inspection);
  }));
  get('package-stage').addEventListener('click', () => run(async () => {
    invalidate(); const value = await api('import.stage', { inspection_id: inspection.inspection_id, password: get('package-password').value, package_digest: inspection.package_digest, expected_target_revision: inspection.target_revision });
    operation = value; get('package-operation').value = value.operation_id; output(value);
    if (!value.duplicate) approval = { kind: 'import', value };
  }));
  get('package-confirm').addEventListener('click', () => run(async () => {
    if (!approval || !get('package-consent').checked) throw new Error('请先核对摘要并明确勾选。');
    const selected = approval; invalidate(); const row = selected.value;
    const result = await api(selected.kind === 'export' ? 'export.commit' : selected.kind === 'recovery' ? 'recovery.commit' : 'import.commit', {
      ...(selected.kind === 'export' ? { package_id: row.package_id } : { operation_id: row.operation_id }),
      ...(selected.kind !== 'import' ? { package_digest: row.package_digest } : {}), expected_revision: row.revision, confirmation_digest: row.confirmation_digest,
    });
    if (selected.kind === 'export') { exported = result; output(result); } else adopt(result);
  }));
  get('package-status').addEventListener('click', () => run(async () => adopt(await api('import.status', { operation_id: get('package-operation').value }))));
  get('package-operation').addEventListener('input', () => { operation = /^[a-f0-9]{32}$/.test(get('package-operation').value) ? { operation_id: get('package-operation').value } : null; invalidate(); });
  get('package-recover').addEventListener('click', () => run(async () => {
    invalidate(); const result = await api('recovery.inspect', { operation_id: get('package-operation').value }); operation = result; output(result);
    if (!['complete', 'cancelled'].includes(result.status)) approval = { kind: 'recovery', value: result };
  }));
  get('package-review').addEventListener('click', () => run(async () => {
    if (!get('package-consent').checked || !operation?.native_review?.review_digest) throw new Error('先查询当前状态并核对删除记录复审摘要。');
    const result = await api('review', { operation_id: operation.operation_id, expected_revision: operation.revision, review_digest: operation.native_review.review_digest }); adopt(result);
  }));
  get('package-cancel').addEventListener('click', () => run(async () => { const row = operation; invalidate(); adopt(await api('import.cancel', { operation_id: row.operation_id, expected_revision: row.revision })); }));
  get('package-download').addEventListener('click', () => run(async () => {
    const response = await fetch(`${base}/role-package/download`, { method: 'POST', headers, body: JSON.stringify({ package_id: exported.package_id, package_digest: exported.package_digest }) });
    if (!response.ok) { const value = await response.json(); throw Object.assign(new Error(value.error), value); }
    const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${exported.package_id}.scrole`; anchor.click(); URL.revokeObjectURL(url);
  }));
  get('package-diagnostics').addEventListener('click', () => run(async () => output(await api('diagnostics'))));
  render(); return { state: () => ({ pending, approval, inspection, operation, exported }) };
}
