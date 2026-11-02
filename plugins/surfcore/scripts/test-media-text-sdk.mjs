import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { patchMediaSdk } from '../../../scripts/patch-dsh-media-sdk.mjs';
let sdkBase = 'http://127.0.0.1:9';
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
  async prepareCall(config) { if (fixedHook) await fixedHook(); return { config, inputModalities: imageCapable ? ['text', 'image'] : ['text'], ...(imageCapable ? { mediaImageProtocol: 'surfcore-media-image-v1' } : {}), async *stream(options) { modelCalls.push(options); if (modelHook) await modelHook(options); yield { type: 'text-delta', text: '这是依据本次转写或已确认窗口的完整回答。' }; yield { type: 'finish', reason: { kind: finish } }; } }; },
};
let modelHook = null, refCache = null;
const ctx = { get(name) { if (name === 'llm') return llm; if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'synthetic' }) }; if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision, value: { baseURL: sdkBase, get apiKey() { throw Error('secret read'); } } }] }; if (name === 'launchEnvironment') return new Map(); }, on(name, cb) { const set = events.get(name) || new Set(); set.add(cb); events.set(name, set); return () => set.delete(cb); } };
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

async function setupSdk(onAuth){
// Exact reviewed SDK source pair extracted read-only from local ASAR; no account config.
const root = path.join(repo,'.local/evidence/t4-host-attempt1');
const originals = { llm: fs.readFileSync(path.join(root, 'llm-original.js'), 'utf8'), deepseek: fs.readFileSync(path.join(root, 'deepseek-original.js'), 'utf8') };
const patched = patchMediaSdk(originals);
assert.throws(() => patchMediaSdk({ ...originals, deepseek: originals.deepseek + '\n' }), /SDK_VERSION_MISMATCH/);
// Evaluate the complete exact adapter implementation, replacing its imported host
// dependencies with deterministic fixtures. Serialization/request/control logic is real.
const chain = new Proxy(function() { return chain; }, { get: () => chain, apply: () => chain });
class LlmError extends Error { constructor(message, code, failure) { super(message); this.code = code; this.failure = failure; } }
let requests = [], files = 0, attachmentReads = 0, extensionCalls = 0, authHook = null, diagnostics = [];
const forbiddenDisk = () => { throw Error('media must never use disk attachments'); };
const sandbox = {
  z: chain, isVolatile: () => false, assertNever: v => { throw Error(`unexpected ${v}`); }, deepEqualJson: isDeepStrictEqual,
  APP_IDENTITY: 'synthetic', IMAGE_OFFLOAD_REQUIRED_CODE: 'IMAGE_OFFLOAD', LlmAdapter: class {}, LlmError,
  ProviderRequestId: v => v, ReasoningEffortId: v => v, ToolCallId: v => v, RetryPolicySchema: chain,
  attributionHeaders: () => ({}), contentHasImage: blocks => blocks.some(x => x.type === 'image'), errorChain: () => 'fixture',
  isContextWindowExceededError: () => false, isQuotaExceededError: () => false, offloadedImageText: () => 'omitted',
  projectOffloadedImages: h => h, requestImageHandleText: () => 'Current explicitly approved frame.', requiredImageOffload: () => 0,
  resolveImageAttachmentAccess: forbiddenDisk, resolveRetryPolicy: () => undefined, textOnlyImageText: () => 'no image',
  MAX_TIMER_DELAY_MS: 2147483647, timeoutOf: () => undefined,
  idleWatchdog: signal => ({ signal, pulse() {}, next: iterator => iterator.next(), [Symbol.dispose]() {} }),
  deadline: signal => ({ signal, [Symbol.dispose]() {} }),
  ImageVariantId: v => v, longEdgeDimensions: (w, h) => ({ width: w, height: h }), requestImageDimensions: ref => ({ width: ref.width, height: ref.height }),
  createHash: crypto.createHash, mkdir: forbiddenDisk, readFile: forbiddenDisk, dirname: path.dirname, join: path.join,
  withFileLock: forbiddenDisk, writeFileAtomic: forbiddenDisk, resolveDshHome: forbiddenDisk,
  EventSourceParserStream: class {}, getOrCreateAnonymousUserId: () => 'synthetic', semver: {},
  Buffer, Uint8Array, AbortController, AbortSignal, URL, fetch, setTimeout, clearTimeout, TextDecoderStream,
};
const code = patched.deepseek.replace(/^import .*;\n/gm, '').replace(/^export \{[^\n]+\};\s*$/m, 'globalThis.adapterApi = { DeepSeekAdapter, resolveAdapterOptions };');
vm.runInNewContext(code, sandbox, { filename: 'isolated-exact-deepseek-patched.js' });
const { DeepSeekAdapter, resolveAdapterOptions } = sandbox.adapterApi;
const prepareStart = patched.llm.indexOf('async prepareCall(config, signal, configure) {');
const prepareEnd = patched.llm.indexOf('\n\t\tregistration(provider)', prepareStart);
const equalityStart = patched.llm.indexOf('function callConfigEquals(a, b) {');
const equalityEnd = patched.llm.indexOf('\n}', equalityStart) + 2;
assert.ok(prepareStart > 0 && prepareEnd > prepareStart && equalityStart > 0);
const preparedRuntime = vm.runInNewContext(`${patched.llm.slice(equalityStart, equalityEnd)};({${patched.llm.slice(prepareStart, prepareEnd).trim()}})`, { structuredClone, deepFreeze: Object.freeze, LlmError });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
authHook = onAuth;
const server = http.createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; requests.push({ path: req.url, body: JSON.parse(body), headers: req.headers }); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'SYNTHETIC_RECEIPT_ONLY' } })); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
sdkBase = `http://127.0.0.1:${server.address().port}`;
const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, models: [{ id: 'synthetic', inputModalities: ['text', 'image'] }] }, new Map());
const deps = {
  options: () => connection, resolveAuth: async () => { if (authHook) await authHook(); return { headers: {}, onRequestError: e => { diagnostics.push(e); return e; } }; }, resolveUserId: () => 'synthetic',
  resolveFiles: () => ({ ensureUploaded: async () => { files++; return { record: { fileId: 'fixture-file' } }; } }),
  resolveAttachments: () => ({ readImageRequest: async ref => { attachmentReads++; return { data: PNG, bytes: PNG.length, width: 1, height: 1, mediaType: 'image/png', id: 'fixture' }; } }),
  resolveImageAccess: () => undefined, prepareExtensions: async () => { extensionCalls++; return { fields: {}, accept: async () => {} }; },
  onReplayDegrade: e => diagnostics.push(e), onExtensionsOmitted: e => diagnostics.push(e), onExtensionsUnaccepted: e => diagnostics.push(e),
};
const adapter = new DeepSeekAdapter(deps);
const runtime = { registration: () => ({ adapter }), normalizeModelInfo: (_registration, _model, info) => info,
  resolveCallWithInfo: config => ({ config }), streamWithRegistration: (options, prepared) => prepared.dispatch(options) };

return {requests,counts:()=>({files,attachmentReads,extensionCalls,diagnostics:diagnostics.length}),prepareCall:config=>preparedRuntime.prepareCall.call(runtime,config,new AbortController().signal),close:()=>new Promise(r=>server.close(r))};
}


// Adapted from critical's real-authority/all-adapter counterexample.
let sdk,variant; const failures=[];
try{
 sdk=await setupSdk(async()=>{
  if(variant==='auth-visibility')time+=751;
  else if(variant==='auth-epoch') {const c=await local.context({kind:'pet'});await local.ingest(c,'synthetic-during-auth','Synthetic source revision',{actor:'user'});}
 });
 llm.prepareCall=async config=>{const prepared=await sdk.prepareCall(config);return {...prepared,stream(options){const permit=options[Symbol.for('surfcore.media.image.v1')];assert.equal(permit.kind,'text');const guard=permit.guard;permit.guard=async()=>{await guard();if(variant==='after-guard-visibility')time+=751;if(variant==='after-guard-role')character={...character,epoch:character.epoch+1};};return prepared.stream(options);}};};
 for(variant of ['valid','auth-visibility','auth-epoch','after-guard-visibility','after-guard-role']){
  await reset();await call('configure',{enabled:true,output_provider:'external'});
  const l=await lease();await emit(l,'SYNTHETIC_PTT_BODY_LATE');const before=sdk.requests.length;await send(l);if(variant==='after-guard-role'){for(let n=0;n<30;n++)await tick();}else await done();
  console.log(JSON.stringify({case:`actual SDK text permit ${variant}`,requests:sdk.requests.length-before,containsTranscript:sdk.requests.slice(before).some(value=>JSON.stringify(value).includes('SYNTHETIC_PTT_BODY_LATE')),lastError:variant==='after-guard-role'?'STALE_CHARACTER':(await call('status')).lastError?.code}));
  failures.push(sdk.requests.length-before);
 }
 assert.deepEqual(failures,[1,0,0,0,0],'only live approved text may reach SDK HTTP'); assert.deepEqual(sdk.counts(),{files:0,attachmentReads:0,extensionCalls:0,diagnostics:0}); console.log('PASS 5 real-authority/all-adapter text media cases; no extension/diagnostic/private-history path.');
}finally{media?.dispose();tools?.dispose();await supervisor.stop();await sdk?.close();const resolved=fs.realpathSync(temp);if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('surfcore-media-host-'))throw Error('unsafe cleanup');fs.rmSync(resolved,{recursive:true,force:true});}
