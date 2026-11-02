/* Visible page is the only source of liveness; no browser capture or model API. */
export function mountMediaClient({ document: d, fetch: request, base, token, setInterval: every = setInterval, clearInterval: cancel = clearInterval } = {}) {
  const el = id => d.getElementById(id); let lease = null, delivery = null, busy = false, alive = false, destroyed = false, catalogId = null, releasing = false, down = false, pageGeneration = 0;
  const showError = e => { el('error').textContent = `${e.code || 'MEDIA_REQUEST_FAILED'}：${e.error || e.message || '设备请求失败。'}\n${e.hint || '保持页面可见，核对设备状态后重新准备。'}`; };
  async function api(action, params = {}) {
    const ticket = pageGeneration;
    let response, data; try { response = await request(`${base}/api`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true, headers: { 'content-type': 'application/json', 'x-surfcore-session': token }, body: JSON.stringify({ op: action.startsWith('tool.') ? action : `media.host.${action}`, params }) }); data = await response.json(); } catch { throw { code: 'MEDIA_CONNECTION_FAILED', error: '设备控制请求未能确认。', hint: '检查 DSH 是否运行，刷新后重新准备；不重放旧发送。' }; }
    if (!['stop', 'tool.emergency.stop'].includes(action) && (destroyed || ticket !== pageGeneration || d.visibilityState !== 'visible')) { void api('stop').catch(() => {}); throw { code: 'MEDIA_VISIBILITY_LOST', error: '页面已停止或隐藏，迟到结果已丢弃。', hint: '重新准备设备，旧结果不会恢复。' }; }
    if (!response.ok || data.ok === false) throw data; return data.result;
  }
  function buttons() {
    for (const name of ['configure', 'catalog', 'prepare', 'refresh']) el(name).disabled = busy;
    el('confirm').disabled = busy || lease?.state !== 'prepared';
    el('start').disabled = busy || !(lease?.state === 'confirmed' || lease?.mode === 'window' && lease.state === 'preview' && lease.frames_remaining > 0) || lease?.mode === 'ptt';
    el('ptt').disabled = busy || lease?.mode !== 'ptt' || lease?.state !== 'confirmed';
    el('revoke').disabled = busy || !lease;
    el('prepareSend').disabled = busy || !lease?.preview?.result_id || lease.mode === 'handsfree' || Boolean(delivery);
    el('send').disabled = busy || !delivery;
  }
  async function act(fn) { if (busy) return; busy = true; el('error').textContent = ''; buttons(); try { await fn(); } catch (e) { showError(e); } finally { busy = false; buttons(); } }
  function clear() { pageGeneration++; lease = null; delivery = null; alive = false; el('transcript').value = ''; el('frame').hidden = true; el('frame').removeAttribute('src'); el('lease').textContent = '已停止；重新准备不会恢复旧许可。'; el('delivery').textContent = '旧交付已取消。'; buttons(); }
  function renderLease(value) { lease = value; el('lease').textContent = JSON.stringify({ mode: value.mode, state: value.state, targets: value.targets, purposes: value.purposes, model_selection: value.model_selection, model_destination: value.model_destination, expires_at: value.expires_at, prepared_until: value.prepared_until, worker_state: value.worker_state }, null, 2); el('level').value = value.voice_level || 0; buttons(); }
  async function refresh() {
    const value = await api('status');
    el('enabled').checked = value.enabled; el('provider').value = value.output_provider;
    el('model').textContent = `当前角色：${value.character}\n当前模型：${value.current_model?.provider || '未选择'} / ${value.current_model?.model || '未选择'}\n窗口画面问答：准备窗口用途时会核对实际读图能力；未准备不代表模型不支持。`;
    el('status').textContent = `设备功能：${value.enabled ? '已允许，启动设备仍需确认' : '已关闭'}\n待处理回复：${value.pending || 0}\n桌宠原声音：${value.legacy_playback_suppressed ? (value.legacy_pause_confirmed ? '已确认停止' : '等待停止确认，本地声音暂不可启动') : '沿用已有设置'}\n设备故障：${value.fault || '无'}\n当前页面许可：${value.leases?.length || 0} 项`;
    if (value.lastError) showError(value.lastError);
    if (lease) {
      const current = value.leases.find(item => item.lease_id === lease.lease_id);
      if (!current || ['cancelled', 'revoked', 'failed', 'stopped'].includes(current.state)) clear();
      else { renderLease(current); if (current.preview) { const p = await api('preview', { lease_id: lease.lease_id }); el('transcript').value = p.text || ''; if (p.base64) { el('frame').src = `data:image/png;base64,${p.base64}`; el('frame').hidden = false; } } }
    }
  }
  function select(name, options, label) { const target = el(name); target.replaceChildren(); for (const v of options) { const option = d.createElement('option'); option.value = v.ref; option.textContent = label(v); target.appendChild(option); } }
  el('catalog').onclick = () => act(async () => { const result = await api('catalog'); catalogId = result.catalog_id; const end = Date.now() + 30000; while (Date.now() < end) { const value = await api('catalog-status', { catalog_id: catalogId }); if (value.state === 'succeeded') { select('input', value.devices.filter(x => x.kind === 'input'), x => x.name); select('output', value.devices.filter(x => x.kind === 'output'), x => x.name); select('voice', value.voices, x => x.name); select('window', value.windows, x => x.title); return; } if (value.code || value.state === 'failed') throw value; await new Promise(r => setTimeout(r, 250)); } throw { code: 'MEDIA_CATALOG_TIMEOUT', error: '设备枚举超时。', hint: '检查本机权限后重新刷新。' }; });
  el('configure').onclick = () => act(async () => { await api('configure', { enabled: el('enabled').checked, output_provider: el('provider').value }); clear(); await refresh(); });
  el('prepare').onclick = () => act(async () => { const mode = el('mode').value; const params = { mode }; if (['ptt', 'handsfree'].includes(mode)) params.input_ref = el('input').value; if (['handsfree', 'output'].includes(mode)) { params.output_ref = el('output').value; params.voice_ref = el('voice').value; } if (mode === 'window') { params.window_ref = el('window').value; params.frame_limit = Number(el('frames').value); params.duration_seconds = 60; } delivery = null; const value = await api('prepare', params); alive = true; renderLease(value); });
  el('confirm').onclick = () => act(async () => renderLease(await api('confirm', { lease_id: lease.lease_id, expected_revision: lease.revision, confirmation_digest: lease.confirmation_digest })));
  el('start').onclick = () => act(async () => { delivery = null; el('transcript').value = ''; el('frame').hidden = true; renderLease(await api('start', { lease_id: lease.lease_id })); });
  async function release() { if (!down && !releasing) return; down = false; releasing = true; if (busy) return; await act(async () => { renderLease(await api('release', { lease_id: lease.lease_id })); releasing = false; }); }
  el('ptt').onpointerdown = event => { if (busy || !lease || lease.state !== 'confirmed') return; event.preventDefault(); down = true; el('ptt').setPointerCapture?.(event.pointerId); void act(async () => { renderLease(await api('start', { lease_id: lease.lease_id })); }).finally(() => { if (!down || releasing) void release(); }); };
  el('ptt').onpointerup = () => void release(); el('ptt').onpointercancel = () => void api('stop').then(clear).catch(showError);
  el('prepareSend').onclick = () => act(async () => { delivery = await api('prepare-send', { lease_id: lease.lease_id, ...(lease.mode === 'window' ? { question: el('question').value } : {}) }); el('delivery').textContent = JSON.stringify({ model: delivery.model_selection, model_destination: delivery.model_destination, purposes: delivery.purposes, expires_at: delivery.expires_at, memory_write: false, history_write: false }, null, 2); });
  el('send').onclick = () => act(async () => { const original = delivery; delivery = null; buttons(); await api('send', { request_id: original.request_id, expected_revision: original.revision, confirmation_digest: original.confirmation_digest }); el('delivery').textContent = '已占用一次交付；等待原桌宠显示，未知状态不重发。'; });
  el('revoke').onclick = () => act(async () => { const original = lease; clear(); await api('revoke', { lease_id: original.lease_id }); });
  el('stop').onclick = () => { clear(); void api('stop').catch(showError); };
  el('emergency').onclick = () => { clear(); void api('tool.emergency.stop').catch(showError); };
  el('refresh').onclick = () => act(refresh);
  const hidden = () => { if (d.visibilityState !== 'visible') { clear(); void api('stop').catch(showError); } };
  d.addEventListener('visibilitychange', hidden);
  const up = () => { if (down) void release(); }; d.addEventListener('pointerup', up);
  const leave = () => { clear(); void api('stop').catch(() => {}); }; d.defaultView?.addEventListener('pagehide', leave);
  const beat = every(() => { if (!destroyed && alive && d.visibilityState === 'visible') void api('heartbeat', { visible: true }).catch(e => { clear(); showError(e); }); }, 250);
  const monitor = every(() => { if (!destroyed && alive && !busy && d.visibilityState === 'visible') void refresh().catch(showError); }, 1000);
  void refresh().catch(showError); buttons();
  return { refresh, dispose() { destroyed = true; cancel(beat); cancel(monitor); d.removeEventListener('visibilitychange', hidden); d.removeEventListener('pointerup', up); d.defaultView?.removeEventListener('pagehide', leave); clear(); void api('stop').catch(() => {}); } };
}
if (typeof document !== 'undefined' && typeof MEDIA_BASE !== 'undefined') mountMediaClient({ document, fetch, base: MEDIA_BASE, token: MEDIA_SESSION });
