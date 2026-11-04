import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createSemanticWriter } from '../plugins/surfcore/lib/local-capabilities/semantic-writer.js';
import { readModelCall } from '../plugins/surfcore/lib/local-capabilities/model-call-registry.js';
import { createModelPolicy } from './a01-model-policy.mjs';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(root, '.local/evidence/a01-controls-attempt1/writer-policy-'));
const supervisor = new CapabilitySupervisor({ python: path.join(root, '.venv/Scripts/python.exe'), entry: path.join(root, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let character = { id: 'synthetic-policy-pet', epoch: 1 }, writer, finish = 'stop', contextWindow = 1048576;
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const selected = { provider: 'synthetic', model: 'exact-model', reasoningEffort: 'off' }, calls = [], operations = [];
const raw = supervisor.raw.bind(supervisor); supervisor.raw = async (...args) => { operations.push(args[0]); return raw(...args); };
const llm = {
  stream() { throw Error('policy must use prepared stream'); },
  async prepareCall(config) { const prepared = { config: Object.freeze({ ...config }), context: Object.freeze({ contextWindow }), stream(options) {
    assert.equal(this, prepared); calls.push(options);
    return (async function* () {
      const input = JSON.parse(options.messages[0].content[0].text), episode = input.episodes[0];
      const value = { proposals: [{ operation: 'add', kind: 'preference', statement: '用户表示喜欢茶', evidence: [{ source_id: episode.id, quote: episode.text }] }] };
      yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: finish } };
    })();
  } }; return Object.freeze(prepared); },
};
const ctx = { get: key => key === 'llm' ? llm : { currentSelection: () => selected } };
try {
  for (const [i, channel] of ['p','qc'].entries()) {
    writer?.dispose(); local.semanticWriter = null; character = { id: `synthetic-policy-${channel}`, epoch: i + 1 };
    await local.setMode('local'); await local.setQqOwner({ account: '100000001', peer: '100000002' }); await local.shareOwner(true);
    const policy = createModelPolicy(selected, channel);
    writer = createSemanticWriter({ ctx, capabilities: local, modelPolicy: policy, debounceMs: 600000 }); local.semanticWriter = writer;
    const audience = channel === 'p' ? { kind: 'pet' } : { kind: 'qq-private', account: '100000001', peer: '100000002' };
    const original = await local.context(audience), source = await local.ingest(original, `synthetic-source-${channel}`, '我喜欢茶', { actor: 'user' });
    const result = await writer.flush(); assert.equal(result.assertions, 1); assert.equal(result.consumed, 1);
    const records = await local.call(audience, 'memory.query', {}), assertion = records.memories.find(record => record.kind === 'preference');
    assert.equal(assertion.statement, '用户表示喜欢茶'); assert.deepEqual(assertion.derived_from, [source.id]); assert.deepEqual(assertion.source_revisions, { [source.id]: 1 });
    const options = calls.at(-1), metadata = readModelCall(options); assert.equal(options.maxTokens, channel === 'p' ? 700 : 3200); assert.equal(metadata.platform, channel === 'p' ? 'pet' : 'qq'); assert.equal(metadata.policyHash, policy.hash);
    console.log(`ok policy ${channel} real isolated SQLCipher ingest -> prepared -> JSON proposals submit/commit preserves evidence under shared owner`);
    await local.ingest(await local.context(audience), `truncated-${channel}`, '我喜欢茶', { actor: 'user' }); finish = 'length'; operations.length = 0;
    await assert.rejects(writer.flush(), error => error.code === 'WRITER_MODEL_INCOMPLETE' && Boolean(error.hint)); assert.ok(!operations.includes('memory.proposals.submit')); assert.ok(!operations.includes('memory.proposals.commit')); finish = 'stop';
    contextWindow = 32; const before = calls.length;
    await assert.rejects(writer.flush(), error => error.code === 'WRITER_POLICY_MISMATCH' && Boolean(error.hint)); assert.equal(calls.length, before); contextWindow = 1048576;
    console.log(`ok policy ${channel} truncated finish and unknown context reject without consuming pending sources`);
  }
  console.log('PASS 4 Writer model-policy real wrapper/SQLCipher checks; synthetic LLM only, no remote API/platform/device.');
} finally { writer?.dispose(); local.semanticWriter = null; await supervisor.stop(); }
