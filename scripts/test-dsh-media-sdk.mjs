import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { patchMediaSdk, SDK_HASHES } from './patch-dsh-media-sdk.mjs';

// Exact reviewed SDK source pair extracted read-only from local ASAR; no account config.
const root = path.resolve(process.argv[2] || '.local/evidence/t4-host-attempt1');
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
const server = http.createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; requests.push({ path: req.url, body: JSON.parse(body), headers: req.headers }); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'SYNTHETIC_RECEIPT_ONLY' } })); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, models: [{ id: 'synthetic-vision', inputModalities: ['text', 'image'] }] }, new Map());
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
const symbol = Symbol.for('surfcore.media.image.v1');
function input() {
  const data = Buffer.from(PNG), hash = crypto.createHash('sha256').update(data).digest('hex');
  const ref = { attachmentId: `sha256:${hash}`, mediaType: 'image/png', bytes: data.length, width: 1, height: 1 };
  const permit = { data, ref, hash, guard: async () => {}, syncGuard() {} };
  const options = { provider: 'deepseek-official', model: 'synthetic-vision', reasoningEffort: 'off', maxTokens: 1600, system: 'Synthetic media only.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the approved synthetic pixel.' }, { type: 'image', attachment: ref }] }], signal: new AbortController().signal, [symbol]: permit };
  return { options, permit, data };
}
async function attempt(value, errorCode) {
  const { provider, model, reasoningEffort, maxTokens } = value.options;
  const prepared = await preparedRuntime.prepareCall.call(runtime, { provider, model, reasoningEffort, maxTokens }, value.options.signal); assert.equal(prepared.mediaImageProtocol, 'surfcore-media-image-v1');
  await assert.rejects(async () => { for await (const _ of prepared.stream(value.options)) {} }, e => e.code === errorCode);
  assert.throws(() => prepared.stream(value.options), e => e.code === 'INVALID_PREPARED_CALL');
}
let count = 0; const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`); };
try {
  await check('exact SDK single PNG reaches loopback inline; no Files/disk/extension or diagnostic body', async () => {
    const v = input(); await attempt(v, 'INVALID_REQUEST'); assert.equal(requests.length, 1);
    const body = requests[0].body; assert.equal(requests[0].path, '/v1/messages');
    assert.deepEqual(Buffer.from(body.messages[0].content.find(x => x.type === 'image').source.data, 'base64'), PNG);
    assert.equal(body.messages[0].content.find(x => x.type === 'image').source.type, 'base64'); assert.equal(files, 0); assert.equal(attachmentReads, 0); assert.equal(extensionCalls, 0); assert.equal(diagnostics.length, 0); assert.equal(v.permit.data, null); assert.ok(v.data.every(x => x === 0));
    await attempt(v, 'MEDIA_IMAGE_INVALID'); assert.equal(requests.length, 1);
  });
  for (const variant of ['hash', 'dimensions', 'frame-ref', 'tools', 'session', 'two-images']) await check(`${variant} cannot upload`, async () => {
    const v = input(); if (variant === 'hash') v.permit.hash = 'a'.repeat(64); if (variant === 'dimensions') v.permit.ref.width = 2; if (variant === 'frame-ref') v.options.messages[0].content[1].attachment = { ...v.permit.ref }; if (variant === 'tools') v.options.tools = []; if (variant === 'session') v.options.sessionId = 'forbidden'; if (variant === 'two-images') v.options.messages[0].content.push(v.options.messages[0].content[1]);
    await attempt(v, 'MEDIA_IMAGE_INVALID'); assert.equal(requests.length, 1); v.data.fill(0);
  });
  await check('revocation during adapter auth awaits gives zero new HTTP and clears bytes', async () => {
    const v = input(); let active = true; v.permit.syncGuard = () => { if (!active) throw new LlmError('synthetic source revoked', 'MEDIA_DELIVERY_STALE'); }; authHook = async () => { active = false; };
    await attempt(v, 'MEDIA_DELIVERY_STALE'); assert.equal(requests.length, 1); assert.equal(v.permit.data, null); assert.ok(v.data.every(x => x === 0)); authHook = null;
  });
  await check('permission check awaiting before fetch cannot bless a stopped role/expired permit', async () => {
    const v = input(); let active = true; v.permit.guard = async () => { active = false; }; v.permit.syncGuard = () => { if (!active) throw new LlmError('synthetic old role/expiry', 'MEDIA_DELIVERY_STALE'); };
    await attempt(v, 'MEDIA_DELIVERY_STALE'); assert.equal(requests.length, 1);
  });
  await check('unprepared adapter stream cannot use the private image permit', async () => {
    const v = input(); await assert.rejects(async () => { for await (const _ of adapter.stream(v.options)) {} }, e => e.code === 'MEDIA_IMAGE_INVALID'); assert.equal(requests.length, 1); v.data.fill(0);
  });
  await check('ordinary attachment path retains attachment service, Files API and extensions', async () => {
    const v = input(); delete v.options[symbol]; await attempt(v, 'INVALID_REQUEST'); assert.equal(attachmentReads, 1); assert.equal(files, 1); assert.equal(extensionCalls, 1); assert.equal(requests.length, 2); assert.equal(requests[1].body.messages[0].content.find(x => x.type === 'image').source.type, 'file');
  });
  await check('unsupported actual selected catalog never sends an image', async () => {
    const v = input(); v.options.model = 'not-declared-vision'; await attempt(v, 'UNSUPPORTED_CONTENT'); assert.equal(requests.length, 2); assert.equal(v.permit.data, null);
  });
  function textInput() {
    const value = input(); value.data.fill(0);
    value.permit = { kind: 'text', guard: async () => {}, syncGuard() {} };
    value.options[symbol] = value.permit; value.options.messages[0].content = [{ type: 'text', text: 'Approved synthetic transcript only.' }]; return value;
  }
  await check('text media uses same prepared-only permit, bypasses extensions/diagnostics/files and cannot replay', async () => {
    const before = { requests: requests.length, files, attachmentReads, extensionCalls, diagnostics: diagnostics.length }; const value = textInput();
    await attempt(value, 'INVALID_REQUEST'); assert.equal(requests.length, before.requests + 1); assert.equal(requests.at(-1).body.messages[0].content[0].text, 'Approved synthetic transcript only.');
    assert.deepEqual({ files, attachmentReads, extensionCalls, diagnostics: diagnostics.length }, { files: before.files, attachmentReads: before.attachmentReads, extensionCalls: before.extensionCalls, diagnostics: before.diagnostics });
    await attempt(value, 'MEDIA_PERMIT_INVALID'); assert.equal(requests.length, before.requests + 1);
  });
  await check('text final sync guard after the async SDK guard denies an expired permit before fetch', async () => {
    const before = requests.length, value = textInput(); let active = true;
    value.permit.guard = async () => { active = false; }; value.permit.syncGuard = () => { if (!active) throw new LlmError('synthetic final expiry', 'MEDIA_DELIVERY_STALE'); };
    await attempt(value, 'MEDIA_DELIVERY_STALE'); assert.equal(requests.length, before);
  });
  await check('text media cannot use plain adapter stream, tools or history', async () => {
    const before = requests.length;
    for (const type of ['plain', 'tools', 'toolHistory', 'sessionId']) {
      const value = textInput(); if (type !== 'plain') value.options[type] = type === 'sessionId' ? 'forbidden' : [];
      if (type === 'plain') await assert.rejects(async () => { for await (const _ of adapter.stream(value.options)) {} }, e => e.code === 'MEDIA_PERMIT_INVALID'); else await attempt(value, 'MEDIA_PERMIT_INVALID');
    }
    assert.equal(requests.length, before);
  });
  fs.writeFileSync(path.join(root, 'sdk-loopback-proof.json'), JSON.stringify({ original: SDK_HASHES, requests: requests.map(r => ({ path: r.path, model: r.body.model, input_type: r.body.messages[0].content.some(x => x.type === 'image') ? 'image' : 'text', image_type: r.body.messages[0].content.find(x => x.type === 'image')?.source.type, bytes: r.body.messages[0].content.some(x => x.type === 'image') ? PNG.length : undefined })), count, no_real_model: true, no_device: true }, null, 2));
  console.log(`PASS ${count} exact SDK media checks; loopback recorder only.`);
} finally { await new Promise(r => server.close(r)); }
