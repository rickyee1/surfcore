import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixedModel } from '../lib/local-capabilities/fixed-model.js';

// Complete installed Cordis and LlmRuntime, with empty contexts/adapters. Only
// catalog/config/prepare results are inert fixtures; no model or account is used.
if (!process.argv.includes('--child')) {
  const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
  const electron = option('--electron', 'D:/DSH/DeepSeek Harness.exe');
  const asar = option('--asar', 'D:/DSH/resources/app.asar');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-fixed-cordis-'));
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', HOME: temp, USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp, DSH_HOME: temp, SURFCORE_TEST_ASAR: asar });
  const child = spawnSync(electron, [fileURLToPath(import.meta.url), '--child'], { env, cwd: temp, encoding: 'utf8', timeout: 30000, windowsHide: true });
  process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
  assert.equal(child.error, undefined); assert.equal(child.status, 0);
} else {
  globalThis.fetch = () => { throw Error('TEST_NETWORK_FORBIDDEN'); };
  const modulePath = name => path.join(process.env.SURFCORE_TEST_ASAR, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js');
  const { Context } = await import(pathToFileURL(modulePath('cordis')));
  const { LlmRuntime } = await import(pathToFileURL(modulePath('dsh-llm')));
  console.log(JSON.stringify({ node: process.versions.node, source_sha256: Object.fromEntries(['cordis', 'dsh-llm'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(modulePath(name))).digest('hex')])) }));
  const original = Symbol.for('cordis.original');
  const stale = error => error.code === 'FIXED_MODEL_STALE' && Boolean(error.error || error.message) && Boolean(error.hint);
  const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };
  const events = ['loader/volatile-update', 'settings/document-updated', 'llm/adapters-updated', 'credentials/reference-updated'];
  let count = 0;
  async function check(name, body) { await body(); console.log(`ok ${++count} ${name}`); }
  async function fixture() {
    const ctx = new Context(); let runtime, serviceCtx, hook; let streams = 0, preparations = 0, facadeCalls = 0;
    ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official', model: 'synthetic' }) });
    ctx.reflect.provide('settings', { describe: () => [{ ns: 'synthetic', applies: 'live', revision: 1, value: { get apiKey() { throw Error('SECRET_FORBIDDEN'); } } }] });
    ctx.reflect.provide('launchEnvironment', new Map());
    const fiber = ctx.plugin(c => {
      serviceCtx = c; runtime = new LlmRuntime(c);
      runtime.listConfigurableProviders = () => [{ provider: 'deepseek-official', settingsNs: 'synthetic', settingsPath: [] }];
      runtime.prepareCall = async function(config, signal) {
        preparations++;
        // Calling the unwrapped service would lose the consumer's Cordis context.
        assert.notEqual(this, runtime); assert.equal(this[original], runtime);
        assert.equal(Object.getPrototypeOf(this.ctx), ctx); facadeCalls++;
        if (hook) await hook(signal);
        return { config, async *stream() { streams++; yield { type: 'text-delta', text: '完整回复' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
      };
    });
    await fiber.await();
    assert.equal(runtime.adapters.size, 0);
    const fixed = createFixedModel({ ctx }); let restoreOff;
    return { ctx, runtime, fixed, setHook(value) { hook = value; },
      counts: () => ({ streams, preparations, facadeCalls }),
      replace(value) { serviceCtx.reflect.set('llm', value); },
      async revokeRestore() {
        await fiber.dispose(); assert.equal(ctx.get('llm'), undefined);
        restoreOff = ctx.reflect.provide('llm', runtime);
        assert.equal(ctx.get('llm')[original], runtime);
      },
      async dispose() { fixed.dispose(); await fiber.dispose(); if (restoreOff) await restoreOff(); },
    };
  }
  await check('fresh actual Cordis facades retain stable underlying service and four-field target', async () => {
    const f = await fixture();
    try {
      const a = f.ctx.get('llm'), b = f.ctx.get('llm');
      assert.notEqual(a, b); assert.equal(a[original], b[original]); assert.equal(a[original], f.runtime);
      const pin = f.fixed.pin(); assert.deepEqual(Object.keys(pin.target).sort(), ['config_revision', 'endpoint_identity', 'model', 'provider']);
      for (let i = 0; i < 3; i++) assert.equal(pin.validate(), pin.target);
      const prepared = await pin.prepare(); assert.equal(await prepared.text({ system: 'fixture', user: 'fixture' }), '完整回复');
      assert.deepEqual(f.counts(), { streams: 1, preparations: 1, facadeCalls: 1 });
    } finally { await f.dispose(); }
  });
  await check('different underlying LlmRuntime with identical config rejects without notification', async () => {
    const f = await fixture(), other = await fixture();
    try { const pin = f.fixed.pin(); f.replace(other.runtime); assert.throws(pin.validate, stale); assert.deepEqual(f.counts(), { streams: 0, preparations: 0, facadeCalls: 0 }); }
    finally { await f.dispose(); await other.dispose(); }
  });
  await check('real service removal and restoration of same object invalidate old pin', async () => {
    const f = await fixture();
    try { const pin = f.fixed.pin(); await f.revokeRestore(); assert.throws(pin.validate, stale); f.fixed.pin().validate(); }
    finally { await f.dispose(); }
  });
  await check('real service removal/restoration during prepare aborts original pending call', async () => {
    const f = await fixture(); const entered = deferred(), resume = deferred(); let signal;
    try {
      f.setHook(async value => { signal = value; entered.resolve(); await resume.promise; });
      const pending = f.fixed.pin().prepare(); const rejected = assert.rejects(pending, stale);
      await entered.promise; await f.revokeRestore(); assert.equal(signal.aborted, true);
      resume.resolve(); await rejected; assert.equal(f.counts().streams, 0);
    } finally { resume.resolve(); await f.dispose(); }
  });
  await check('unrelated real service notifications leave llm pin valid', async () => {
    const f = await fixture();
    try { const pin = f.fixed.pin(); const off = f.ctx.reflect.provide('unrelated', {}); pin.validate(); await off(); pin.validate(); }
    finally { await f.dispose(); }
  });
  for (const event of events) await check(`existing invalidation event ${event}`, async () => {
    const f = await fixture();
    try { const pin = f.fixed.pin(); f.ctx.emit(event); assert.throws(pin.validate, stale); }
    finally { await f.dispose(); }
  });
  await check('dispose removes llm lifecycle listener and permanently revokes pin', async () => {
    const f = await fixture();
    try { const pin = f.fixed.pin(); f.fixed.dispose(); const generation = f.fixed.generation; await f.revokeRestore(); assert.equal(f.fixed.generation, generation); assert.throws(pin.validate, stale); }
    finally { await f.dispose(); }
  });
  console.log(`fixed-model actual Cordis: ${count} PASS; network/model dispatch=0`);
}
