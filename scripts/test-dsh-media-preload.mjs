import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerHooks, createRequire, syncBuiltinESMExports } from 'node:module';
import { installMediaPreload, automaticPreload, SDK_HASHES } from './dsh-media-preload.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const script = fileURLToPath(import.meta.url);
const preload = new URL('./dsh-media-preload.mjs', import.meta.url).href;
const modules = { llm: 'dsh-llm', deepseek: 'dsh-llm-deepseek' };
const childMode = process.argv[2] === '--child' ? process.argv[3] : null;
if (childMode) {
  const asar = process.env.SURFCORE_DSH_MEDIA_ASAR;
  const urls = Object.fromEntries(Object.entries(modules).map(([key, name]) => [key,
    pathToFileURL(path.join(asar, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href]));
  globalThis.fetch = () => { throw Error('TEST_NETWORK_FORBIDDEN'); };
  if (['drift', 'format', 'missing-source'].includes(childMode)) {
    const drift = registerHooks({ load(url, ctx, next) {
      const result = next(url, ctx);
      if (url !== urls.llm) return result;
      return childMode === 'format' ? { ...result, format: 'commonjs' }
        : childMode === 'missing-source' ? { ...result, source: null }
        : { ...result, source: Buffer.from(result.source).toString('utf8') + '\n' };
    } });
    const installed = installMediaPreload({ asarPath: asar });
    const expected = childMode === 'format' ? /DSH_MEDIA_LOADER_FORMAT_MISMATCH:llm/
      // Node validates the preceding hook's null source before returning to this hook.
      : childMode === 'missing-source' ? error => error.code === 'ERR_INVALID_RETURN_PROPERTY_VALUE' : /DSH_MEDIA_LOAD_HASH_MISMATCH:llm/;
    await assert.rejects(import(urls.llm), expected);
    assert.deepEqual(installed.status().loaded, []); installed.deregister(); drift.deregister();
    console.log(JSON.stringify({ mode: childMode, rejected: true }));
  } else if (childMode.startsWith('wronghash-')) {
    const key = childMode.slice('wronghash-'.length);
    assert.throws(() => installMediaPreload({ asarPath: process.env.SURFCORE_TEST_BAD_ASAR }), new RegExp(`DSH_MEDIA_SDK_HASH_MISMATCH:${key}`));
    const adapter = await import(urls.deepseek);
    const connection = adapter.resolveAdapterOptions({ models: [{ id: 'synthetic', inputModalities: ['text', 'image'] }] }, new Map());
    const call = await new adapter.DeepSeekAdapter({ options: () => connection, resolveFiles: () => ({}) }).prepareCall('synthetic', 'synthetic');
    assert.equal(call.mediaImageProtocol, undefined);
    console.log(JSON.stringify({ mode: childMode, rejected: true, fallbackUntouched: true }));
  } else if (childMode === 'unsupported') {
    const api = createRequire(import.meta.url)('node:module'), original = api.registerHooks;
    try {
      api.registerHooks = undefined; syncBuiltinESMExports();
      assert.throws(() => installMediaPreload({ asarPath: asar }), /DSH_MEDIA_REGISTER_HOOKS_UNAVAILABLE/);
    } finally { api.registerHooks = original; syncBuiltinESMExports(); }
    console.log(JSON.stringify({ mode: childMode, rejected: true }));
  } else {
    const hooked = childMode === 'hook';
    assert.equal(Boolean(automaticPreload), hooked);
    const llm = await import(urls.llm), deepseek = await import(urls.deepseek);
    const connection = deepseek.resolveAdapterOptions({ models: [{ id: 'synthetic', inputModalities: ['text', 'image'] }] }, new Map());
    const adapter = new deepseek.DeepSeekAdapter({ options: () => connection, resolveFiles: () => ({}) });
    // Real complete SDK classes/methods. Only inert provider dependencies are synthetic;
    // neither a credential resolver nor stream/network callback is ever invoked.
    const runtime = Object.create(llm.LlmRuntime.prototype);
    runtime.adapters = new Map([['synthetic', { adapter, provider: { id: 'synthetic' } }]]);
    const call = await runtime.prepareCall({ provider: 'synthetic', model: 'synthetic' });
    assert.equal(call.mediaImageProtocol, hooked ? 'surfcore-media-image-v1' : undefined);
    const ordinaryUrl = pathToFileURL(path.join(process.env.DSH_HOME, 'ordinary.mjs')).href;
    assert.deepEqual((await import(ordinaryUrl)).default, { ordinary: true, value: 42 });
    // A query URL is deliberately not an exact target, even though Node loads the same file.
    const queried = await import(urls.deepseek + '?ordinary-exact-url-check');
    const ordinary = await new queried.DeepSeekAdapter({ options: () => connection, resolveFiles: () => ({}) }).prepareCall('synthetic', 'synthetic');
    assert.equal(ordinary.mediaImageProtocol, undefined);
    const ordinaryLlm = await import(urls.llm + '?ordinary-exact-url-check');
    const ordinaryRuntime = Object.create(ordinaryLlm.LlmRuntime.prototype);
    ordinaryRuntime.adapters = runtime.adapters;
    assert.equal((await ordinaryRuntime.prepareCall({ provider: 'synthetic', model: 'synthetic' })).mediaImageProtocol, undefined);
    let status;
    if (hooked) {
      status = automaticPreload.status(); assert.deepEqual(status.loaded, ['deepseek', 'llm']);
      assert.throws(() => installMediaPreload({ asarPath: asar }), /ALREADY_INSTALLED/);
      assert.ok(Object.isFrozen(status) && Object.isFrozen(status.targets) && Object.isFrozen(status.loaded));
      automaticPreload.deregister(); automaticPreload.deregister(); assert.equal(automaticPreload.status().active, false);
      const unhooked = await import(urls.deepseek + '?after-deregister');
      assert.equal((await new unhooked.DeepSeekAdapter({ options: () => connection, resolveFiles: () => ({}) }).prepareCall('synthetic', 'synthetic')).mediaImageProtocol, undefined);
    }
    console.log(JSON.stringify({ mode: childMode, node: process.versions.node, marker: call.mediaImageProtocol ?? null, loaded: status?.loaded ?? [], ordinaryUnchanged: true, sdkDisk: Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, sha(fs.readFileSync(new URL(url)))])) }));
  }
} else {
  const electronIndex = process.argv.indexOf('--electron'), asarIndex = process.argv.indexOf('--asar');
  const electron = electronIndex < 0 ? 'D:/DSH/DeepSeek Harness.exe' : process.argv[electronIndex + 1];
  const asar = asarIndex < 0 ? 'D:/DSH/resources/app.asar' : process.argv[asarIndex + 1];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-media-preload-'));
  const log = [];
  const asarBefore = sha(fs.readFileSync(asar));
  const patchBefore = sha(fs.readFileSync(new URL('./patch-dsh-media-sdk.mjs', import.meta.url)));
  let count = 0;
  const check = (name, fn) => { fn(); console.log(`ok ${++count} ${name}`); };
  function run(mode, flags = []) {
    // Explicit allowlist: no inherited account/provider credentials or global NODE_OPTIONS.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', HOME: temp, USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp, DSH_HOME: temp, SURFCORE_DSH_MEDIA_ASAR: asar, SURFCORE_TEST_BAD_ASAR: path.join(temp, 'bad.asar') });
    const child = spawnSync(electron, ['--expose-internals', ...flags, script, '--child', mode], { env, cwd: temp, encoding: 'utf8', timeout: 30000, windowsHide: true });
    log.push({ mode, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, error: child.error?.code });
    assert.equal(child.error, undefined, JSON.stringify(log.at(-1))); assert.equal(child.status, 0, JSON.stringify(log.at(-1)));
    return JSON.parse(child.stdout.trim());
  }
  try {
    fs.writeFileSync(path.join(temp, 'ordinary.mjs'), 'export default { ordinary: true, value: 42 };\n');
    check('library import has no automatic side effect; explicit absolute ASAR required', () => {
      assert.equal(automaticPreload, null);
      for (const asarPath of [undefined, '', 'relative.asar', path.join(temp, 'not-an-archive')]) assert.throws(() => installMediaPreload({ asarPath }), /EXPLICIT_ASAR_REQUIRED/);
    });
    check('full actual Electron SDK imports without hooks preserve ordinary protocol', () => { const result = run('plain'); assert.equal(result.marker, null); assert.deepEqual(result.sdkDisk, SDK_HASHES); });
    check('actual --import preload exposes native prepared protocol; exact URLs only; deregister is idempotent', () => { const result = run('hook', ['--import', preload]); assert.equal(result.marker, 'surfcore-media-image-v1'); assert.deepEqual(result.sdkDisk, SDK_HASHES); });
    check('--import=file URL form installs the same bounded overlay', () => { assert.equal(run('hook', [`--import=${preload}`]).marker, 'surfcore-media-image-v1'); });
    // A fresh isolated directory shaped as an ASAR tests changed sources without touching installation.
    const originalsRoot = new URL('../.local/evidence/t4-host-attempt1/', import.meta.url);
    for (const [key, name] of Object.entries(modules)) {
      const source = fs.readFileSync(new URL(`${key}-original.js`, originalsRoot)); assert.equal(sha(source), SDK_HASHES[key]);
      const target = path.join(temp, 'bad.asar/dsh/node_modules/@deepseek-ai', name, 'lib/index.js');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
    }
    for (const [key, name] of Object.entries(modules)) check(`changed initial ${key} rejects before registering any hook`, () => {
      const target = path.join(temp, 'bad.asar/dsh/node_modules/@deepseek-ai', name, 'lib/index.js');
      const original = fs.readFileSync(target); fs.appendFileSync(target, '\n');
      assert.equal(run(`wronghash-${key}`).fallbackUntouched, true); fs.writeFileSync(target, original);
    });
    check('actual nextLoad bytes changed after initial read reject explicitly', () => { assert.equal(run('drift').rejected, true); });
    check('unexpected loader format rejects instead of bypassing loader semantics', () => { assert.equal(run('format').rejected, true); });
    check('unavailable nextLoad bytes reject instead of trusting initial read', () => { assert.equal(run('missing-source').rejected, true); });
    check('unavailable registerHooks API rejects explicitly', () => { assert.equal(run('unsupported').rejected, true); });
    check('missing explicit environment fails --import before application entry', () => {
      const result = spawnSync(electron, ['--expose-internals', '--import', preload, '--input-type=module', '-e', 'throw Error("APPLICATION_MUST_NOT_RUN")'], { env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, HOME: temp, USERPROFILE: temp, DSH_HOME: temp }, encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: temp });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /DSH_MEDIA_EXPLICIT_ASAR_REQUIRED/); assert.doesNotMatch(result.stderr, /Error: APPLICATION_MUST_NOT_RUN/);
    });
    check('installed ASAR and channel patch are unchanged byte for byte', () => {
      assert.equal(sha(fs.readFileSync(asar)), asarBefore); assert.equal(sha(fs.readFileSync(new URL('./patch-dsh-media-sdk.mjs', import.meta.url))), patchBefore);
    });
    const proof = { checks: count, asar: { path: asar, before: asarBefore, after: sha(fs.readFileSync(asar)) }, original: SDK_HASHES, children: log,
      isolation: { environment: 'allowlisted OS paths plus fresh empty profile; no credential seed', provider: 'inert dependencies; no credential resolver; prepare only', network: 'fetch replaced with throwing guard; no stream dispatched' } };
    const proofIndex = process.argv.indexOf('--proof');
    if (proofIndex >= 0) fs.writeFileSync(process.argv[proofIndex + 1], JSON.stringify(proof, null, 2), { flag: 'wx' });
    console.log(`PASS ${count} deployment preload checks`);
  } finally {
    assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('surfcore-media-preload-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
