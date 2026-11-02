import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { CapabilitySupervisor } from '../lib/local-capabilities/supervisor.js';
import { createToolHost } from '../lib/local-capabilities/tool-host.js';
import { createMediaHost } from '../lib/local-capabilities/media-host.js';
import { mountMediaClient } from '../lib/local-capabilities/media-client.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-media-host-'));
process.env.DSH_HOME = path.join(temp, 'home');
const fixtureRoot = path.join(temp, 'qq'); fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true }); fs.writeFileSync(path.join(fixtureRoot, 'src/bridge.js'), '// synthetic root identity'); fs.writeFileSync(path.join(fixtureRoot, 'config.json'), '{}'); process.env.SURFCORE_ROOT = fixtureRoot;
const { LocalCapabilities } = await import('../lib/local-capabilities/facade.js');
const { createPetChatService } = await import('../lib/pet-chat.js');
const { createPetApiService } = await import('../lib/pet-api.js');
const { createManagementHandler } = await import('../lib/local-capabilities/management.js');
const { isLoopbackReq, json, sameOrigin } = await import('../lib/http-guard.js');
const entry = path.join(temp, 'fixture.py');
fs.writeFileSync(entry, `import sys,importlib.util\nsys.path.insert(0,${JSON.stringify(path.join(repo, 'services/local-capabilities'))})\nimport tool_broker\ntool_broker.lockscreen_state=lambda:'unlocked'\nimport server\nspec=importlib.util.spec_from_file_location('media_fixture',${JSON.stringify(path.join(repo, 'scripts/test-local-capabilities-media.py'))})\nf=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)\nBase=server.CapabilityService\nclass Runtime(f.FixtureRuntime):\n def start(self,identifier,settings):\n  super().start(identifier,settings)\n  if settings['mode']=='catalog':self.jobs.pop(identifier,None)\nclass Fixture(Base):\n def __init__(self,*a,**k):\n  super().__init__(*a,**k);self.media.runtime.close();self.media.runtime=Runtime();self.media.window_guard=lambda target:None\n def poll(self):\n  if hasattr(self,'media'):\n   for identifier in list(self.media.runtime.jobs):self.media.runtime.events.emit(identifier,dict(type='heartbeat'))\n  return super().poll()\n def dispatch(self,op,request,params):\n  if op=='fixture.clear-media':\n   self.management(self.authorize(request));self.media.runtime.stop_all();self.media.runtime.commands.clear();self.media.state=dict(catalogs={},leases={},results={},deliveries={},events=[],sequence=0,generations={});return dict(cleared=True)\n  if op=='fixture.emit':\n   self.management(self.authorize(request));self.media.runtime.events.emit(params['lease_id'],params['event']);return dict(emitted=True)\n  if op=='fixture.commands':\n   self.management(self.authorize(request));return dict(commands=self.media.runtime.commands)\n  return super().dispatch(op,request,params)\nserver.CapabilityService=Fixture\nserver.main()\n`);
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry, dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'media-host-0', epoch: 0 }, media, tools, fixedHook, sendHook, budgetHook, time = Date.now(), revision = 1, finish = 'stop', modelCalls = [], imageCapable = false;
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'state.json'), currentCharacter: () => character });
let events = new Map();
const llm = {
  listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'fixture', settingsPath: [] }],
  async prepareCall(config) { if (fixedHook) await fixedHook(); return { config, inputModalities: imageCapable ? ['text', 'image'] : ['text'], mediaImageProtocol: 'surfcore-media-image-v1', async *stream(options) { modelCalls.push(options); if (modelHook) await modelHook(options); yield { type: 'text-delta', text: '这是依据本次转写或已确认窗口的完整回答。' }; yield { type: 'finish', reason: { kind: finish } }; } }; },
};
let modelHook = null, refCache = null;
const ctx = { get(name) { if (name === 'llm') return llm; if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'synthetic' }) }; if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision, value: { baseURL: 'http://127.0.0.1:9', get apiKey() { throw Error('secret read'); } } }] }; if (name === 'launchEnvironment') return new Map(); }, on(name, cb) { const set = events.get(name) || new Set(); set.add(cb); events.set(name, set); return () => set.delete(cb); } };
const page = 'synthetic-visible-page';
const call = (name, params = {}, p = page) => media.dispatch(`media.host.${name}`, params, { pageId: p });
const raw = async (op, params = {}) => supervisor.raw(op, await local.binding({ kind: 'management' }), params);
const reject = (p, code) => assert.rejects(p, e => e.code === code && Boolean(e.hint));
const tick = () => new Promise(r => setTimeout(r, 5));
let sent = [], nativeChat, nativeServer;
async function reset({ native = false, image = false, ack = true } = {}) {
  if (media) { await media.dispatch('media.host.stop', {}, { pageId: page }); media.dispose(); }
  tools?.dispose(); local.toolHost = null; events = new Map();
  character = { id: `media-host-${character.epoch + 1}`, epoch: character.epoch + 1 }; await local.setMode('local'); await local.management('tool.emergency.reset'); await raw('fixture.clear-media');
  refCache = null; revision = 1; finish = 'stop'; imageCapable = image; fixedHook = null; sendHook = null; budgetHook = null; modelHook = null; modelCalls = []; sent = []; time = Date.now();
  tools = createToolHost({ capabilities: local, ctx, onInvalidate: () => media?.invalidate('HOST_INVALIDATED'), pollMs: 60000 }); local.toolHost = tools; await tools.syncPolicy();
  const deliver = async envelope => { if (sendHook) { const receipt = await sendHook(envelope); if (receipt) return receipt; } await envelope.guard(); envelope.syncGuard(); assert.equal(envelope.memory_write, false); assert.equal(envelope.suppressTts, true); assert.equal(envelope.suppressHistory, true); sent.push(envelope.text); return { outcome: 'sent' }; };
  if (native) nativeChat = createPetChatService({ ctx, stateDir: path.join(temp, 'pet-state'), capabilities: local });
  media = createMediaHost({ capabilities: local, ctx, tokenBudget: { block: async () => budgetHook?.() }, deliver: native ? e => nativeChat.deliverEphemeral(e) : deliver, now: () => time, pollMs: 60000, persona: () => '合成角色，完整自然回答。' }); local.mediaHost = media;
  await call('status'); await call('configure', { enabled: true, output_provider: 'sapi' }); if (ack) media.ackLegacyAudio(media.audioPolicy().nonce); // Synthetic native audio owner has no actual device.
}
async function refs() { if (refCache) return refCache; const catalog = await call('catalog'); const data = await call('catalog-status', { catalog_id: catalog.catalog_id }); assert.equal(data.state, 'succeeded'); return refCache = { input_ref: data.devices.find(x => x.kind === 'input').ref, output_ref: data.devices.find(x => x.kind === 'output').ref, voice_ref: data.voices[0].ref, window_ref: data.windows[0].ref }; }
async function lease(mode = 'ptt') { const all = await refs(); const keys = { ptt: ['input_ref'], handsfree: ['input_ref', 'output_ref', 'voice_ref'], output: ['output_ref', 'voice_ref'], window: ['window_ref'] }[mode]; let value = await call('prepare', { mode, ...Object.fromEntries(keys.map(k => [k, all[k]])) }); assert.equal(value.subject_binding, undefined); value = await call('confirm', { lease_id: value.lease_id, expected_revision: value.revision, confirmation_digest: value.confirmation_digest }); value = await call('start', { lease_id: value.lease_id }); await media.poll(); return value; }
async function emit(lease, text = '合成的用户语音，不含真实数据。', frame = false) {
  const event = frame ? { type: 'frame', png: PNG.toString('base64'), sha256: crypto.createHash('sha256').update(PNG).digest('hex') } : { type: 'asr.final', generation_id: crypto.randomUUID(), text };
  if (lease.mode === 'handsfree') await raw('fixture.emit', { lease_id: lease.lease_id, event: { type: 'wake', generation_id: event.generation_id } }); await raw('fixture.emit', { lease_id: lease.lease_id, event }); await media.poll(); return call('preview', { lease_id: lease.lease_id });
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function send(lease) { const d = await call('prepare-send', { lease_id: lease.lease_id }); assert.equal(d.subject_binding, undefined); const result = await call('send', { request_id: d.request_id, expected_revision: d.revision, confirmation_digest: d.confirmation_digest }); assert.equal(result.pending, true); return d; }
async function done() { for (let i = 0; i < 150; i++) { if ((await call('status')).pending === 0) return; await tick(); } assert.fail('media job did not settle'); }
let count = 0; const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`); };
try {
  await check('PTT exact confirmation then release is preview only; explicit send one fixed no-tools reply', async () => {
    await reset(); await lease('output'); const l = await lease(); await call('release', { lease_id: l.lease_id }); const p = await emit(l); assert.ok(p.text); assert.equal(modelCalls.length, 0); assert.equal(sent.length, 0);
    await send(l); await done(); assert.equal(modelCalls.length, 1); assert.equal(sent.length, 1);
    const options = modelCalls[0]; assert.equal(options.tools, undefined); assert.equal(options.sessionId, undefined); assert.equal(options.toolHistory, undefined); assert.equal(options.messages.length, 1);
    assert.doesNotMatch(JSON.stringify(options), /memory_epoch|session_binding|apiKey/);
    assert.equal((await raw('fixture.commands')).commands.filter(([, x]) => x.type === 'speak').length, 1);
    assert.equal((await local.call({ kind: 'pet' }, 'memory.query', { limit: 20 })).memories.length, 0);
    await reject(call('prepare-send', { lease_id: l.lease_id }), 'MEDIA_RESULT_USED');
  });
  await check('browser cannot choose identity/context/model or call private raw operations', async () => {
    await reset(); const all = await refs(); await reject(call('prepare', { mode: 'ptt', input_ref: all.input_ref, subject_binding: 'fabricated' }), 'INVALID_REQUEST');
    await reject(media.dispatch('media.delivery.consume', {}, { pageId: page }), 'PERMISSION_DENIED');
    await reject(call('prepare', { mode: 'ptt', input_ref: all.input_ref }, 'other-page'), 'STALE_CHARACTER');
  });
  await check('media transcription without the prepared SDK permit fails before consume and never falls back to text', async () => {
    await reset(); const l = await lease(); await emit(l); const prepare = llm.prepareCall;
    llm.prepareCall = async (...args) => { const value = await prepare(...args); delete value.mediaImageProtocol; return value; };
    try { await reject(call('prepare-send', { lease_id: l.lease_id }), 'MEDIA_MODEL_UNSUPPORTED'); }
    finally { llm.prepareCall = prepare; }
    assert.equal(modelCalls.length, 0); assert.equal(sent.length, 0); assert.equal((await raw('media.status')).deliveries.length, 0);
  });
  await check('media reuses original pet-scope memory only, bounds projection and never writes media/history', async () => {
    await reset(); const pet = { kind: 'pet' }, group = { kind: 'qq-group', account: 'fixture', peer: 'other-group' };
    const add = async (channel, event, text) => { const context = await local.context(channel); return local.ingest(context, event, text, { actor: 'user' }); };
    await add(group, 'group-secret', 'OTHER_GROUP_PRIVATE_MUST_NOT_ENTER_MEDIA');
    for (let n = 0; n < 3; n++) await add(pet, `bounded-${n}`, `共同记忆${n}：${'合'.repeat(3000)}`);
    await add(pet, 'pet-pref', 'PET_ALLOWED_PREFERENCE：主人偏爱完整中文解释。');
    const before = (await local.call(pet, 'memory.query', { limit: 20 })).memories;
    await lease('output'); const l = await lease(); await emit(l, 'THIS_CURRENT_REQUEST_HAS_PRIORITY'); await send(l); await done();
    const user = modelCalls[0].messages[0].content[0].text; assert.ok(user.startsWith('本次用户转写：\nTHIS_CURRENT_REQUEST_HAS_PRIORITY')); assert.equal(user.includes('PET_ALLOWED_PREFERENCE'), true); assert.equal(user.includes('OTHER_GROUP_PRIVATE'), false); assert.ok(Array.from(user).length < 8500);
    const status = await call('status'); assert.deepEqual(status.memory_projection, { chars: 8000, truncated: true });
    assert.deepEqual((await local.call(pet, 'memory.query', { limit: 20 })).memories, before);
    assert.equal((await raw('media.status')).deliveries[0].memory_write, false); assert.equal(sent.length, 1);
  });
  await check('SAPI start requires current native pause ACK; replayed/wrong nonce grants no device', async () => {
    await reset({ ack: false }); const all = await refs(); let value = await call('prepare', { mode: 'output', output_ref: all.output_ref, voice_ref: all.voice_ref }); value = await call('confirm', { lease_id: value.lease_id, expected_revision: value.revision, confirmation_digest: value.confirmation_digest });
    await reject(call('start', { lease_id: value.lease_id }), 'MEDIA_LEGACY_OUTPUT_ACTIVE'); assert.throws(() => media.ackLegacyAudio('a'.repeat(48)), e => e.code === 'MEDIA_OUTPUT_ACK_STALE');
    media.ackLegacyAudio(media.audioPolicy().nonce); await call('start', { lease_id: value.lease_id }); assert.equal((await raw('media.status')).output_owner, value.lease_id);
  });
  await check('configure, native reload and reset invalidate old pause ACK instead of reviving playback', async () => {
    await reset(); const old = media.audioPolicy().nonce; await call('configure', { enabled: true, output_provider: 'sapi' }); assert.notEqual(media.audioPolicy().nonce, old); assert.throws(() => media.ackLegacyAudio(old), e => e.code === 'MEDIA_OUTPUT_ACK_STALE');
    const second = media.audioPolicy().nonce; media.ackLegacyAudio(second); media.nativeClient('new-native-fixture'); assert.throws(() => media.ackLegacyAudio(second), e => e.code === 'MEDIA_OUTPUT_ACK_STALE');
    const third = media.audioPolicy().nonce; media.ackLegacyAudio(third); tools.invalidate('EMERGENCY_RESET'); assert.throws(() => media.ackLegacyAudio(third), e => e.code === 'MEDIA_OUTPUT_ACK_STALE'); assert.equal((await call('status')).legacy_pause_confirmed, false);
  });
  await check('A page is never reblessed into B or a new epoch even after status', async () => {
    await reset(); const all = await refs(); character = { ...character, epoch: character.epoch + 1 }; await reject(call('status'), 'STALE_CHARACTER'); await reject(call('prepare', { mode: 'ptt', input_ref: all.input_ref }), 'STALE_CHARACTER'); assert.equal(modelCalls.length, 0);
  });
  await check('stop during fixed prepare cannot create a late lease', async () => {
    await reset(); const all = await refs(); fixedHook = async () => { await call('stop'); };
    await reject(call('prepare', { mode: 'ptt', input_ref: all.input_ref }), 'MEDIA_LEASE_STALE');
    assert.equal((await raw('media.status')).leases.length, 0);
  });
  await check('role change while actual pet binding awaits never prepares B hardware from A page', async () => {
    await reset(); const all = await refs(); const binding = local.binding.bind(local); local.binding = async channel => { const value = await binding(channel); if (channel.kind === 'pet') character = { ...character, epoch: character.epoch + 1 }; return value; };
    try { await reject(call('prepare', { mode: 'ptt', input_ref: all.input_ref }), 'STALE_CHARACTER'); } finally { local.binding = binding; }
    assert.equal(modelCalls.length, 0);
  });
  await check('visible heartbeat loss cancels preview and never resumes on new heartbeat', async () => {
    await reset(); const l = await lease(); await emit(l); time += 751; await reject(media.poll(), 'MEDIA_VISIBILITY_LOST'); await reject(call('heartbeat', { visible: true }), 'MEDIA_VISIBILITY_LOST'); assert.equal(modelCalls.length, 0);
  });
  await check('stop discards late ASR, preview and send capabilities without automatic reopening', async () => {
    await reset(); const l = await lease(); await call('stop'); await raw('fixture.emit', { lease_id: l.lease_id, event: { type: 'asr.final', generation_id: crypto.randomUUID(), text: 'LATE_SYNTHETIC_TRANSCRIPT' } }); await media.poll();
    await reject(call('preview', { lease_id: l.lease_id }), 'MEDIA_VISIBILITY_LOST'); assert.equal((await call('status')).leases[0].preview, null); assert.equal(modelCalls.length, 0); assert.equal(sent.length, 0);
  });
  await check('memory correction after preview confirmation blocks model and private send', async () => {
    await reset(); await lease('output'); const l = await lease(); await emit(l); const d = await call('prepare-send', { lease_id: l.lease_id }); await local.call({ kind: 'pet' }, 'memory.ingest', { source_event_id: 'synthetic-epoch-change', text: '合成修正', expected_memory_epoch: (await local.context({ kind: 'pet' })).memory_epoch });
    await reject(call('send', { request_id: d.request_id, expected_revision: d.revision, confirmation_digest: d.confirmation_digest }), 'VERSION_CONFLICT'); assert.equal(modelCalls.length, 0); assert.equal(sent.length, 0);
  });
  for (const variant of ['stop', 'new-input', 'role', 'model']) await check(`${variant} while budget awaits gives zero model/send/speech`, async () => {
    await reset(); await lease('output'); const l = await lease(); await emit(l); budgetHook = async () => { if (variant === 'stop') await call('stop'); if (variant === 'new-input') tools.input({ kind: 'pet' }, { eventId: crypto.randomUUID(), text: '新合成输入' }); if (variant === 'role') character = { ...character, epoch: character.epoch + 1 }; if (variant === 'model') { revision++; for (const cb of events.get('settings/document-updated') || []) cb(); } };
    await send(l); for (let i = 0; i < 20; i++) await tick(); assert.equal(modelCalls.length, 0); assert.equal(sent.length, 0); assert.equal((await raw('fixture.commands')).commands.filter(([, x]) => x.type === 'speak').length, 0);
  });
  await check('max-tokens finish is visible failure with no output playback or private effect', async () => {
    await reset(); await lease('output'); const l = await lease(); await emit(l); finish = 'max-tokens'; await send(l); await done(); assert.equal(sent.length, 0); const s = await call('status'); assert.equal(s.lastError.code, 'FIXED_MODEL_INCOMPLETE'); assert.ok(s.lastError.hint);
  });
  await check('unknown native receipt is finalized once and result cannot restart model or playback', async () => {
    await reset(); await lease('output'); const l = await lease(); await emit(l); sendHook = async e => { await e.guard(); return { outcome: 'unknown' }; }; await send(l); await done();
    assert.equal((await raw('media.status')).deliveries[0].state, 'unknown'); await reject(call('prepare-send', { lease_id: l.lease_id }), 'MEDIA_RESULT_USED'); assert.equal(modelCalls.length, 1); assert.equal(sent.length, 0);
  });
  await check('dispose during final model aborts pending text and speech, with no late delivery', async () => {
    await reset(); await lease('output'); const l = await lease(); await emit(l); let unblock; modelHook = () => new Promise(r => { unblock = r; }); await send(l); for (let n = 0; n < 40 && !unblock; n++) await tick(); assert.ok(unblock); media.dispose(); unblock(); for (let n = 0; n < 20; n++) await tick(); assert.equal(sent.length, 0); assert.equal((await raw('fixture.commands')).commands.filter(([, x]) => x.type === 'speak').length, 0);
  });
  await check('original delivery TTL expires despite fresh visible pulses and no model call', async () => {
    await reset(); const l = await lease('handsfree'); budgetHook = async () => { for (let n = 0; n < 241; n++) { time += 500; await call('heartbeat', { visible: true }); } };
    await emit(l); for (let n = 0; n < 40; n++) await tick(); assert.equal(modelCalls.length, 0); assert.equal(sent.length, 0); assert.equal((await raw('fixture.commands')).commands.filter(([, x]) => x.type === 'speak').length, 0);
  });
  await check('handsfree uses new context/delivery per utterance and barge-in cancels old model', async () => {
    await reset(); const l = await lease('handsfree'); let unblock; modelHook = () => new Promise(r => { unblock = r; }); await emit(l); for (let i = 0; i < 30 && !unblock; i++) await tick(); assert.equal(modelCalls.length, 1);
    await raw('fixture.emit', { lease_id: l.lease_id, event: { type: 'interrupted', generation_id: crypto.randomUUID() } }); await media.poll(); unblock(); modelHook = null;
    await emit(l, '第二个合成回合'); await done(); assert.equal(modelCalls.length, 2); assert.equal(sent.length, 1);
  });
  await check('window same PNG preview/hash and one no-history upload, unsupported does not fall back', async () => {
    await reset(); await reject(lease('window'), 'MEDIA_IMAGE_UNSUPPORTED'); assert.equal(modelCalls.length, 0);
    await reset({ image: true }); await lease('output'); const l = await lease('window'); const preview = await emit(l, '', true); assert.deepEqual(Buffer.from(preview.base64, 'base64'), PNG);
    let uploaded; modelHook = options => { const image = options[Symbol.for('surfcore.media.image.v1')]; uploaded = Buffer.from(image.data); assert.equal(options.messages[0].content[1].attachment, image.ref); return image.guard(); };
    await send(l); await done(); assert.deepEqual(uploaded, PNG); assert.equal(sent.length, 1); assert.equal(modelCalls[0][Symbol.for('surfcore.media.image.v1')].data, null);
  });
  await check('real management wrapper authenticates media page/session/Origin and refuses private media ops', async () => {
    await reset(); const mount = '/dsh-surfcore/local-capabilities'; const handler = createManagementHandler({ capabilities: local, base: mount }); const routes = new Map();
    const source = fs.readFileSync(path.join(repo, 'plugins/surfcore/lib/index.js'), 'utf8'); const start = source.indexOf('  function route(kind, pathname, handler) {'); const end = source.indexOf('\n  const local = localCapabilities();', start); assert.ok(start > 0 && end > start);
    const route = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { disposers: [], isLoopbackReq, json, sameOrigin, pluginLog() {}, ctx: { webServer: { register({ path, handler }) { routes.set(path, handler); } }, get: () => ({ requestRejection: req => req.headers['x-test-session'] === 'synthetic' ? false : 401 }) } });
    for (const suffix of ['', '/media', '/api']) route('exact', mount + suffix, handler);
    const server = http.createServer((req, res) => void routes.get(new URL(req.url, 'http://127.0.0.1').pathname)(req, res)); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(base + mount + '/media')).status, 401);
      const pageResponse = await fetch(base + mount + '/media', { headers: { 'x-test-session': 'synthetic' } }); const html = await pageResponse.text(); assert.match(pageResponse.headers.get('content-security-policy'), /img-src data:/); assert.match(html, /mountMediaClient/); assert.doesNotMatch(html, /__MEDIA_CLIENT__|__SESSION_TOKEN__/);
      const token = html.match(/const MEDIA_SESSION='([a-f0-9]+)'/)[1]; const headers = { origin: base, cookie: pageResponse.headers.get('set-cookie').split(';')[0], 'x-surfcore-session': token, 'x-test-session': 'synthetic', 'content-type': 'application/json' };
      const post = (op, params = {}, h = {}) => fetch(base + mount + '/api', { method: 'POST', headers: { ...headers, ...h }, body: JSON.stringify({ op, params }) });
      assert.equal((await post('media.host.status')).status, 200); assert.equal((await post('media.delivery.consume', {})).status, 403); assert.equal((await post('media.host.status', {}, { origin: 'https://attacker.invalid' })).status, 403);
      const regular = await fetch(base + mount, { headers: { 'x-test-session': 'synthetic' } }); const regularHtml = await regular.text(); const regularToken = regularHtml.match(/const token='([a-f0-9]+)'/)[1]; assert.equal((await post('media.host.status', {}, { cookie: regular.headers.get('set-cookie').split(';')[0], 'x-surfcore-session': regularToken })).status, 403);
      character = { ...character, epoch: character.epoch + 1 }; const stale = await post('media.host.configure', { enabled: true, output_provider: 'sapi' }).then(r => r.json()); assert.equal(stale.code, 'STALE_CHARACTER'); assert.ok(stale.hint);
    } finally { await new Promise(r => server.close(r)); }
  });
  await check('native pet actual HTTP emits media once with no history/audio and sent receipt', async () => {
    await reset({ native: true, ack: false }); const api = createPetApiService({ chat: nativeChat, stateDir: path.join(temp, 'pet-state'), currentDshUrl: () => 'http://127.0.0.1:9' });
    nativeServer = http.createServer((req, res) => void api.handle(req, res, new URL(req.url, 'http://127.0.0.1'))); await new Promise(r => nativeServer.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${nativeServer.address().port}/dsh-surfcore/pet-api`;
    const headers = { 'x-pet-token': nativeChat.token() }; const first = await (await fetch(`${base}/events?wait=0`, { headers })).json(); const nonce = first.config.voice.mediaSuppressionNonce; assert.equal((await fetch(`${base}/media/audio-suppressed`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) })).status, 200);
    await lease('output'); const l = await lease(); await emit(l); await send(l); for (let i = 0; i < 50 && !modelCalls.length; i++) await tick();
    const result = await (await fetch(`${base}/events?since=${first.cursor}&wait=1000`, { headers })).json(); assert.equal(result.events.length, 1); assert.equal(result.events[0].memory_write, false); assert.equal(result.events[0].suppressHistory, true); assert.equal(result.events[0].audio, undefined); await done();
    assert.equal(nativeChat.history().messages.length, 0); assert.equal((await fetch(`${base}/events?since=${first.cursor}&wait=0`, { headers }).then(r => r.json())).events.length, 0);
    assert.equal(nativeChat.publicConfig().voice.mediaSuppressed, true); assert.equal((await nativeChat.synthesize('合成不应调用旧语音')).code, 'MEDIA_SINGLE_OUTPUT');
    await new Promise(r => nativeServer.close(r)); nativeServer = null;
  });
  console.log(`PASS ${count} media host checks; real SQLCipher authority, synthetic devices/models/transports only.`);
} finally {
  if (nativeServer) await new Promise(r => nativeServer.close(r)); media?.dispose(); tools?.dispose(); await supervisor.stop();
  const resolved = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir()); if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('surfcore-media-host-')) throw Error('unsafe temp cleanup'); fs.rmSync(resolved, { recursive: true, force: true });
}
