/** Version-bound, offline source patch. Never opens or rewrites an installed ASAR. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const MEDIA_IMAGE_PROTOCOL = 'surfcore-media-image-v1';
export const SDK_HASHES = Object.freeze({ llm: 'd18d8ae4c8d961e628708c1e4698e09716a0ebb80e55a672e0bde1029bec1155', deepseek: '21fedb71f8d9aafea73b35ee13bc73737a8271d7ffa261697d4208e8563196cb' });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const hook = `// surfcore-media-image-v1: prepared-only one-shot media text/frame; ordinary requests unchanged.
const surfcoreMediaUsed = new WeakSet();
const surfcoreMediaPrepared = new WeakSet();
function surfcoreMediaImage(options, signal) {
  const value = options[Symbol.for('surfcore.media.image.v1')];
  if (value === undefined) return null;
  const textOnly = value?.kind === 'text';
  const invalid = () => { throw new LlmError('Invalid ephemeral media permit', textOnly ? 'MEDIA_PERMIT_INVALID' : 'MEDIA_IMAGE_INVALID'); };
  if (!value || typeof value !== 'object' || surfcoreMediaUsed.has(value) || !surfcoreMediaPrepared.delete(options)) invalid();
  surfcoreMediaUsed.add(value);
  if (options.sessionId !== undefined || options.tools !== undefined || options.toolHistory !== undefined || options.messages.length !== 1 || options.messages[0].role !== 'user' || typeof value.guard !== 'function' || typeof value.syncGuard !== 'function') invalid();
  const blocks = options.messages[0].content;
  if (textOnly) {
    if (blocks.length !== 1 || blocks[0].type !== 'text' || typeof blocks[0].text !== 'string' || blocks[0].text.length > 90000 || value.data !== undefined || value.ref !== undefined) invalid();
    signal.throwIfAborted(); value.syncGuard();
    return { guard: async () => { signal.throwIfAborted(); await value.guard(); signal.throwIfAborted(); }, syncGuard: () => { signal.throwIfAborted(); value.syncGuard(); }, clear: () => {} };
  }
  if (blocks.length !== 2 || blocks[0].type !== 'text' || blocks[1].type !== 'image' || blocks[1].offloaded || blocks[1].attachment !== value.ref || !(value.data instanceof Uint8Array)) invalid();
  const data = value.data, ref = value.ref;
  if (data.length < 24 || data.length > 1500000 || ref.mediaType !== 'image/png' || ref.bytes !== data.length || Buffer.from(data.subarray(0,8)).toString('hex') !== '89504e470d0a1a0a') invalid();
  const width = Buffer.from(data).readUInt32BE(16), height = Buffer.from(data).readUInt32BE(20);
  if (width < 1 || height < 1 || width > 640 || height > 640 || ref.width !== width || ref.height !== height || createHash('sha256').update(data).digest('hex') !== value.hash || ref.attachmentId !== 'sha256:' + value.hash) invalid();
  signal.throwIfAborted(); value.syncGuard();
  return {
    readImageRequest: async (target, _projection, readSignal) => {
      if (target !== ref) invalid(); readSignal.throwIfAborted(); value.syncGuard();
      return { data, bytes:data.length, width, height, mediaType:'image/png' };
    },
    guard: async () => { signal.throwIfAborted(); await value.guard(); signal.throwIfAborted(); },
    syncGuard: () => { signal.throwIfAborted(); value.syncGuard(); },
    clear: () => { data.fill(0); value.data = null; }
  };
}
`;
function replaceOnce(source, before, after) { if (source.split(before).length !== 2) throw Error('SDK_PATCH_ANCHOR_MISMATCH'); return source.replace(before, after); }
export function patchMediaSdk({ llm, deepseek }) {
  if (hash(llm) !== SDK_HASHES.llm || hash(deepseek) !== SDK_HASHES.deepseek) throw Error('SDK_VERSION_MISMATCH: preserve the source; review this exact SDK before patching');
  let a = replaceOnce(llm, '\t\t\treturn Object.freeze({\n\t\t\t\tconfig: resolvedConfig,', "\t\t\treturn Object.freeze({\n\t\t\t\t...(adapterCall.mediaImageProtocol === 'surfcore-media-image-v1' ? { mediaImageProtocol: adapterCall.mediaImageProtocol } : {}),\n\t\t\t\tconfig: resolvedConfig,");
  let b = replaceOnce(deepseek, 'var DeepSeekAdapter = class extends LlmAdapter {', hook + '\nvar DeepSeekAdapter = class extends LlmAdapter {');
  b = replaceOnce(b, '\t\t\tmodel: modelInfo(connection, provider, model),', "\t\t\tmediaImageProtocol: 'surfcore-media-image-v1',\n\t\t\tmodel: modelInfo(connection, provider, model),");
  b = replaceOnce(b, '\t\t\tstream: (options) => this.generate(options, connection)', "\t\t\tstream: (options) => {\n\t\t\t\tif (options[Symbol.for('surfcore.media.image.v1')] !== undefined) surfcoreMediaPrepared.add(options);\n\t\t\t\treturn this.generate(options, connection);\n\t\t\t}");
  b = replaceOnce(b, '\t\tconst { messages, versions } = await prepareImages(options.messages, connection, options.model, this.dependencies.resolveAttachments?.(), this.imageAccess, signal);', "\t\tconst media = surfcoreMediaImage(options, signal);\n\t\ttry {\n\t\tconst access = media ? () => undefined : this.imageAccess;\n\t\tconst { messages, versions } = await prepareImages(options.messages, connection, options.model, media || this.dependencies.resolveAttachments?.(), access, signal);");
  b = replaceOnce(b, '\t\t\tlet inline = false;', '\t\t\tlet inline = Boolean(media);');
  b = replaceOnce(b, 'messages, versions, this.imageAccess, (reason) => {', 'messages, versions, access, (reason) => {');
  b = replaceOnce(b, '\t\t\t\tconst extensions = await prepareRequestExtensions(body, {', '\t\t\t\tconst extensions = media ? { payload: JSON.stringify(body), accept: async () => {} } : await prepareRequestExtensions(body, {');
  b = replaceOnce(b, '\t\t\t\tconst response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {', '\t\t\t\tif (media) { await media.guard(); media.syncGuard(); }\n\t\t\t\tconst response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {');
  // Errors on the media path are never offered to credential/extension diagnostic callbacks.
  b = replaceOnce(b, '\t\t\tif (auth.onRequestError !== void 0) {', '\t\t\tif (!media && auth.onRequestError !== void 0) {');
  b = replaceOnce(b, '\t\t\tthrow error;\n\t\t}\n\t}\n};\n//#endregion\n//#region lib/types/host.js', '\t\t\tthrow error;\n\t\t}\n\t\t} finally { media?.clear(); }\n\t}\n};\n//#endregion\n//#region lib/types/host.js');
  return { llm: a, deepseek: b };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const source = args[args.indexOf('--source-dir') + 1], output = args[args.indexOf('--output-dir') + 1];
  if (!args.includes('--source-dir') || !args.includes('--output-dir') || !source || !output || path.resolve(source) === path.resolve(output)) throw Error('Use --source-dir <offline original JS pair> --output-dir <new isolated directory>');
  if (fs.existsSync(output)) throw Error('OUTPUT_EXISTS: choose a fresh isolated output directory');
  const patched = patchMediaSdk({ llm: fs.readFileSync(path.join(source, 'llm-original.js'), 'utf8'), deepseek: fs.readFileSync(path.join(source, 'deepseek-original.js'), 'utf8') });
  fs.mkdirSync(output, { recursive: true });
  for (const [name, data] of Object.entries(patched)) fs.writeFileSync(path.join(output, `${name}-patched.js`), data, { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ original: SDK_HASHES, patched: Object.fromEntries(Object.entries(patched).map(([k, v]) => [k, hash(v)])) }, null, 2));
  console.log('Offline SDK pair patched; installed runtime unchanged.');
}
