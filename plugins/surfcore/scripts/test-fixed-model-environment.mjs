import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFixedModel, messagesEndpoint } from '../lib/local-capabilities/fixed-model.js';

// Reviewed installed SDK: launchEnvironmentOf64–67, DeepSeek resolver441.
// Model stub records the resolved adapter target, not the host's claimed digest.
const saved = process.env.DEEPSEEK_BASE_URL;
let calls = 0;
try {
  for (const test of [
    { name: 'empty snapshot masks ambient', snapshot: new Map(), ambient: 'https://ambient.invalid' },
    { name: 'missing variable masks ambient', snapshot: new Map([['OTHER', { value: 'ignored' }]]), ambient: 'https://ambient.invalid' },
    { name: 'undefined value masks ambient', snapshot: new Map([['DEEPSEEK_BASE_URL', { value: undefined }]]), ambient: 'https://ambient.invalid' },
    { name: 'snapshot value wins', snapshot: new Map([['DEEPSEEK_BASE_URL', { value: 'https://snapshot.invalid/v1' }]]), ambient: 'https://ambient.invalid' },
    { name: 'absent snapshot uses ambient', ambient: 'https://ambient.invalid/anthropic' },
    { name: 'absent both uses default' },
    { name: 'explicit config wins', snapshot: new Map(), ambient: 'https://ambient.invalid', configured: 'https://config.invalid/v1' },
    { name: 'literal undefined is invalid', snapshot: new Map([['DEEPSEEK_BASE_URL', { value: 'undefined' }]]), ambient: 'https://ambient.invalid', invalid: true },
    { name: 'empty string is invalid', snapshot: new Map([['DEEPSEEK_BASE_URL', { value: '' }]]), ambient: 'https://ambient.invalid', invalid: true },
  ]) {
    if (test.ambient === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = test.ambient;
    let captured;
    const llm = {
      listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'fixture', settingsPath: [] }],
      async prepareCall(config) {
        const environment = test.snapshot ?? new Map(Object.entries(process.env).map(([k, value]) => [k, { value }]));
        captured = messagesEndpoint(test.configured ?? environment.get('DEEPSEEK_BASE_URL')?.value ?? 'https://api.deepseek.com/anthropic');
        return { config, async *stream() { calls++; yield { type: 'text-delta', text: '完整回答' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
      },
    };
    const ctx = { get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'fixture' }) };
      if (name === 'llm') return llm;
      if (name === 'launchEnvironment') return test.snapshot;
      if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision: 1, value: { baseURL: test.configured, get apiKey() { throw Error('must not read secret'); } } }] };
    } };
    const fixed = createFixedModel({ ctx });
    try {
      if (test.invalid) assert.throws(() => fixed.pin(), e => e.code === 'FIXED_MODEL_UNSUPPORTED' && Boolean(e.hint));
      else {
        const pin = fixed.pin(); const prepared = await pin.prepare();
        assert.equal(pin.target.endpoint_identity, crypto.createHash('sha256').update(captured).digest('hex'), test.name);
        assert.equal(await prepared.text({ system: 'fixture', user: 'fixture' }), '完整回答');
      }
    } finally { fixed.dispose(); }
    console.log(`ok ${test.name}`);
  }
  assert.equal(calls, 7);
} finally { if (saved === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = saved; }
