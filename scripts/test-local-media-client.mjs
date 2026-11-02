import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountMediaClient } from '../plugins/surfcore/lib/local-capabilities/media-client.js';
const html = fs.readFileSync(new URL('../plugins/surfcore/lib/local-capabilities/media-management.html', import.meta.url), 'utf8');
assert.match(html, /type="module"/); assert.match(html, /id="transcript" readonly/); assert.doesNotMatch(html, /getUserMedia|getDisplayMedia|autoplay/);
const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, { id, value: '', checked: false, disabled: false, hidden: false, textContent: '', children: [], replaceChildren() { this.children = []; }, appendChild(v) { this.children.push(v); if (!this.value) this.value = v.value; }, removeAttribute(k) { delete this[k]; }, setPointerCapture() {} }]));
const listeners = new Map(); const timers = new Map();
const d = { visibilityState: 'visible', getElementById: id => nodes.get(id), createElement: tag => ({ tag }), addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) };
let lease = null, configured = false, mockFailure = null, delay = null;
const requests = [];
const id = 'a'.repeat(32), digest = 'b'.repeat(64);
const fetcher = async (url, options) => {
  assert.equal(url, '/isolated/api'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers['x-surfcore-session'], 'synthetic');
  const q = JSON.parse(options.body); requests.push(q); if (delay) await delay(q);
  if (mockFailure) return { ok: false, json: async () => ({ ok: false, code: 'MEDIA_AUDIO_UNAVAILABLE', error: '<b>合成设备失败</b>', hint: '刷新设备后重新选择。' }) };
  let result;
  const action = q.op.replace('media.host.', '');
  if (action === 'status') result = { enabled: configured, output_provider: 'sapi', leases: lease ? [lease] : [], current_model: { model: 'fixed' }, character: 'original:1', physical_test: 'NOT_VERIFIED' };
  else if (action === 'catalog') result = { catalog_id: id };
  else if (action === 'catalog-status') result = { state: 'succeeded', devices: [{ ref: 'input-ref', kind: 'input', name: '合成麦克风' }, { ref: 'output-ref', kind: 'output', name: '合成扬声器' }], voices: [{ ref: 'voice-ref', name: '合成声音' }], windows: [{ ref: 'window-ref', title: '<script>literal title</script>' }] };
  else if (action === 'configure') { configured = q.params.enabled; result = q.params; }
  else if (action === 'prepare') { assert.deepEqual(q.params, { mode: 'ptt', input_ref: 'input-ref' }); result = lease = { lease_id: id, mode: 'ptt', state: 'prepared', revision: 1, confirmation_digest: digest, expires_at: Date.now() + 30000, targets: { input: { name: 'ACTUAL PREPARED MIC' } }, purposes: ['local_transcript_preview'], model_selection: { model: 'fixed' } }; }
  else if (action === 'confirm') { assert.deepEqual(q.params, { lease_id: id, expected_revision: 1, confirmation_digest: digest }); result = lease = { ...lease, state: 'confirmed', revision: 2 }; }
  else if (action === 'start') result = lease = { ...lease, state: 'running' };
  else if (action === 'release') result = lease = { ...lease, state: 'preview', preview: { result_id: 'opaque', result_hash: digest } };
  else if (action === 'preview') result = { text: '<img src=x onerror=alert(1)> literal transcript', result_id: 'opaque', result_hash: digest };
  else if (action === 'prepare-send') { assert.deepEqual(q.params, { lease_id: id }); result = { request_id: id, revision: 1, confirmation_digest: digest, model_selection: { model: 'fixed' }, purposes: ['model_text_input'], expires_at: Date.now() + 30000 }; }
  else if (action === 'send') { assert.deepEqual(q.params, { request_id: id, expected_revision: 1, confirmation_digest: digest }); result = { pending: true }; }
  else if (action === 'stop' || action === 'revoke' || q.op === 'tool.emergency.stop') { lease = null; result = { stopped: true }; }
  else if (action === 'heartbeat') { assert.deepEqual(q.params, { visible: true }); result = { visible: true }; }
  else throw Error(`unexpected ${q.op}`);
  return { ok: true, json: async () => ({ ok: true, result }) };
};
const view = mountMediaClient({ document: d, fetch: fetcher, base: '/isolated', token: 'synthetic', setInterval: (f, ms) => { timers.set(ms, f); return ms; }, clearInterval: n => timers.delete(n) });
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
try {
  await tick(); assert.equal(nodes.get('start').disabled, true); assert.equal(nodes.get('send').disabled, true);
  nodes.get('enabled').checked = true; nodes.get('provider').value = 'sapi'; await nodes.get('configure').onclick();
  await nodes.get('catalog').onclick(); assert.equal(nodes.get('window').children[0].textContent, '<script>literal title</script>');
  nodes.get('mode').value = 'ptt'; await nodes.get('prepare').onclick(); assert.match(nodes.get('lease').textContent, /ACTUAL PREPARED MIC/); assert.equal(nodes.get('confirm').disabled, false); assert.equal(nodes.get('ptt').disabled, true);
  await nodes.get('confirm').onclick(); assert.equal(nodes.get('ptt').disabled, false); assert.equal(nodes.get('start').disabled, true);
  nodes.get('ptt').onpointerdown({ preventDefault() {}, pointerId: 1 }); nodes.get('ptt').onpointerup(); await tick(); await view.refresh(); assert.equal(nodes.get('prepareSend').disabled, false); assert.match(nodes.get('transcript').value, /literal transcript/);
  nodes.get('transcript').value = 'tampered text must not become request'; await nodes.get('prepareSend').onclick(); assert.equal(nodes.get('send').disabled, false); await nodes.get('send').onclick(); assert.equal(nodes.get('send').disabled, true); assert.equal(requests.filter(q => q.op === 'media.host.send').length, 1); assert.doesNotMatch(JSON.stringify(requests), /tampered text|subject_binding|context_ref|endpoint_identity/);
  await timers.get(250)(); await tick(); assert.ok(requests.some(q => q.op === 'media.host.heartbeat'));
  d.visibilityState = 'hidden'; listeners.get('visibilitychange')(); await tick(); const heartbeats = requests.filter(q => q.op === 'media.host.heartbeat').length; timers.get(250)(); await tick(); assert.equal(requests.filter(q => q.op === 'media.host.heartbeat').length, heartbeats); assert.equal(nodes.get('transcript').value, ''); assert.equal(nodes.get('send').disabled, true);
  d.visibilityState = 'visible'; mockFailure = true; await nodes.get('catalog').onclick(); assert.match(nodes.get('error').textContent, /MEDIA_AUDIO_UNAVAILABLE/); assert.match(nodes.get('error').textContent, /刷新设备/); assert.equal(nodes.get('catalog').disabled, false);
  mockFailure = false; let release; delay = q => q.op === 'media.host.prepare' ? new Promise(r => { release = r; }) : null;
  const pending = nodes.get('prepare').onclick(); await tick(); d.visibilityState = 'hidden'; listeners.get('visibilitychange')(); release(); await pending; assert.equal(nodes.get('transcript').value, ''); assert.equal(nodes.get('start').disabled, true); assert.match(nodes.get('error').textContent, /MEDIA_VISIBILITY_LOST/);
  console.log('PASS media DOM: actual HTML/client render, exact targets/digests, PTT quick-release, send once, no body injection, visible-only heartbeat, late result discard, actionable error and recoverable busy state.');
} finally { view.dispose(); }
