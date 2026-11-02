/** Deployment-local, version-bound in-memory SDK overlay. Installed ASAR stays read-only. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as moduleApi from 'node:module';
import { pathToFileURL } from 'node:url';
import { patchMediaSdk, SDK_HASHES, MEDIA_IMAGE_PROTOCOL } from './patch-dsh-media-sdk.mjs';

export { SDK_HASHES };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const files = Object.freeze({ llm: 'dsh-llm', deepseek: 'dsh-llm-deepseek' });
let active = false;
function fail(code) { throw new Error(code); }
function sourceBytes(source) {
  if (typeof source === 'string') return Buffer.from(source, 'utf8');
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  fail('DSH_MEDIA_LOADER_SOURCE_UNAVAILABLE');
}

/** Call before importing either SDK. Only an explicit absolute .asar path is accepted. */
export function installMediaPreload({ asarPath } = {}) {
  if (typeof moduleApi.registerHooks !== 'function') fail('DSH_MEDIA_REGISTER_HOOKS_UNAVAILABLE');
  if (active) fail('DSH_MEDIA_PRELOAD_ALREADY_INSTALLED');
  if (typeof asarPath !== 'string' || !path.isAbsolute(asarPath) || !/\.asar$/i.test(asarPath)) fail('DSH_MEDIA_EXPLICIT_ASAR_REQUIRED');
  const asar = path.normalize(asarPath);
  const targets = Object.fromEntries(Object.entries(files).map(([key, name]) => [key,
    pathToFileURL(path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href]));
  // Validate both originals before registering anything. Buffer hashes retain every byte.
  const originals = {};
  for (const [key, url] of Object.entries(targets)) {
    const bytes = fs.readFileSync(new URL(url));
    if (sha(bytes) !== SDK_HASHES[key]) fail(`DSH_MEDIA_SDK_HASH_MISMATCH:${key}`);
    originals[key] = bytes.toString('utf8');
  }
  const patched = patchMediaSdk(originals);
  const patchedHashes = Object.fromEntries(Object.entries(patched).map(([key, source]) => [key, sha(source)]));
  const keys = new Map(Object.entries(targets).map(([key, url]) => [url, key]));
  const loaded = new Set();
  const registration = moduleApi.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const key = keys.get(url);
      if (!key) return result;
      if (result.format !== 'module') fail(`DSH_MEDIA_LOADER_FORMAT_MISMATCH:${key}`);
      if (sha(sourceBytes(result.source)) !== SDK_HASHES[key]) fail(`DSH_MEDIA_LOAD_HASH_MISMATCH:${key}`);
      loaded.add(key);
      return { ...result, source: patched[key] };
    }
  });
  active = true;
  let disposed = false;
  return Object.freeze({
    status: () => Object.freeze({
      active: !disposed, protocol: MEDIA_IMAGE_PROTOCOL,
      targets: Object.freeze({ ...targets }), original: SDK_HASHES,
      patched: Object.freeze({ ...patchedHashes }), loaded: Object.freeze([...loaded].sort())
    }),
    deregister() {
      if (!disposed) { registration.deregister(); disposed = true; active = false; }
    }
  });
}

// Importing this module as a library has no side effect. --import requires explicit env.
const isSelf = value => {
  try { return (value.startsWith('file:') ? new URL(value).href : pathToFileURL(path.resolve(value)).href) === import.meta.url; }
  catch { return false; }
};
const preload = process.execArgv.some((arg, i, args) =>
  arg === '--import' ? Boolean(args[i + 1] && isSelf(args[i + 1])) : arg.startsWith('--import=') && isSelf(arg.slice(9)));
export const automaticPreload = preload ? installMediaPreload({ asarPath: process.env.SURFCORE_DSH_MEDIA_ASAR }) : null;
