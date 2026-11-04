// Run ONLY with installed Electron in ELECTRON_RUN_AS_NODE=1. All native
// modules are read from ASAR; no profile, credential or endpoint is imported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire, syncBuiltinESMExports } = require('node:module');
const workspace = path.resolve(__dirname, '..');
const evidence = path.join(workspace, '.local/evidence/a01-controls-attempt1');
const isolated = fs.mkdtempSync(path.join(evidence, 'native-isolated-'));
for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) delete process.env[key];
for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','DSH_HOME','TEMP','TMP']) { process.env[key] = path.join(isolated, key); fs.mkdirSync(process.env[key], { recursive: true }); }
process.env.SURFCORE_ROOT = process.env.SURFCORE_QQBOT_ROOT = path.join(isolated, 'repo');
fs.mkdirSync(process.env.SURFCORE_ROOT);
fs.writeFileSync(path.join(process.env.SURFCORE_ROOT, 'config.json'), JSON.stringify({ purpose: { enabled: false }, socialV2: { voice: { enabled: false } } }));
fs.mkdirSync(path.join(process.env.DSH_HOME, 'surfcore'));
fs.writeFileSync(path.join(process.env.DSH_HOME, 'surfcore/config.json'), JSON.stringify({ qqbotRoot: process.env.SURFCORE_ROOT, pet: { chat: { enabled: true, remember: false, temperature: 0.2, reasoningEffort: 'off' } } }));
let networkAttempts = 0, processAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw Error('NETWORK_FORBIDDEN'); };
for (const name of ['node:net','node:tls','node:http','node:https','node:dgram','node:http2']) {
  const module = require(name);
  for (const key of ['connect','createConnection','request','get','createSocket']) if (typeof module[key] === 'function') module[key] = denyNetwork;
}
require('node:net').Socket.prototype.connect = denyNetwork;
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[key] = () => { processAttempts++; throw Error('CHILD_PROCESS_FORBIDDEN'); };
global.fetch = denyNetwork;
// Reject every native file mutation outside this unique child directory.
for (const key of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','rmdirSync','openSync','copyFileSync']) {
  const original = fs[key]; fs[key] = function (...args) {
    if (key === 'openSync' && (args[1] === 'r' || args[1] === undefined)) return original.apply(this, args);
    const targets = key === 'copyFileSync' ? [args[1]] : key === 'renameSync' ? args.slice(0, 2) : [args[0]];
    for (const target of targets) { const rel = path.relative(isolated, path.resolve(target)); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('WRITE_OUTSIDE_ISOLATION'); }
    return original.apply(this, args);
  };
}
for (const key of ['writeFile','appendFile','mkdir','rename','unlink','rm','rmdir','copyFile','open']) {
  const original = fs.promises[key]; fs.promises[key] = async function (...args) {
    if (key === 'open' && (args[1] === 'r' || args[1] === undefined)) return original.apply(this, args);
    const targets = key === 'copyFile' ? [args[1]] : key === 'rename' ? args.slice(0, 2) : [args[0]];
    for (const target of targets) { const rel = path.relative(isolated, path.resolve(target)); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('WRITE_OUTSIDE_ISOLATION'); }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

const runtime = 'D:/DSH/resources/app.asar/dsh/cli.js';
const nativeRequire = createRequire(runtime);
const load = relative => import(pathToFileURL(path.join(workspace, relative)).href);
(async () => {
  const { Context } = nativeRequire('@deepseek-ai/cordis');
  const { Loader } = nativeRequire('@deepseek-ai/cordis-plugin-loader');
  const { composeEntries } = nativeRequire('@deepseek-ai/dsh-app-boot');
  const { LlmAdapter, createUserMessage, isAgentLoopRequest } = nativeRequire('@deepseek-ai/dsh-llm');
  const { installModelSelection } = nativeRequire('@deepseek-ai/dsh-agent');
  const { DeepSeekAdapter } = nativeRequire('@deepseek-ai/dsh-llm-deepseek');
  const { createModelPolicy, installAgentPolicy, requestControls, verifyPrepared, verifyCallEvidence } = await load('scripts/a01-model-policy.mjs');
  const { observeLlm, nativeControlEvidence } = await load('scripts/a01-native-host.mjs');
  const { readModelCall, registerModelCall } = await load('plugins/surfcore/lib/local-capabilities/model-call-registry.js');
  const yaml = nativeRequire('yaml');
  const parse = text => yaml.parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] });
  const basePatch = parse(fs.readFileSync('D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', 'utf8'));
  const webPatch = parse(fs.readFileSync('D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml', 'utf8'));
  const productPatch = parse(fs.readFileSync(path.join(workspace, 'plugins/surfcore/cordis.patch.yml'), 'utf8'));
  const profile = [{ id: 'session-title-llm', disabled: true }, { id: 'llm-deepseek', config: { streamIdleTimeoutMs: 60000, reasoningEffort: 'off' } }];
  const composed = composeEntries([basePatch, webPatch, productPatch, profile]);
  assert.equal(composed.find(row => row.id === 'session-title-llm').disabled, true);
  const wanted = new Set(['session','session-projection','system-prompt','tools','llm','llm-deepseek','agent','session-title','session-title-llm','agent-loop']);
  const rows = composed.filter(row => wanted.has(row.id));
  for (const name of ['dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-llm','dsh-agent','dsh-session-title','dsh-agent-loop']) assert.ok(rows.some(row => row.name === '@deepseek-ai/' + name), name);
  const ctx = new Context(); const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(runtime).href }); await loaderFiber.inertia;
  try {
    // Load the actual composed model/agent/title dependency closure. All unrelated
    // web, device, platform and provider plugins are intentionally outside smoke.
    for (const row of rows) await ctx.loader.create(row);
    await ctx.loader.await();
    assert.ok([...ctx.loader.entries()].every(row => row.disabled || row.fiber?.state === 2));
    assert.ok(ctx.agentLoop && ctx.sessionTitle);
    assert.ok(!ctx.loader.resolve('session-title-llm').fiber);
    const actual = [], errors = [], titleRequests = [];
    class Fake extends LlmAdapter {
      async resolveModel(provider, id) { if (id !== 'exact-model') throw Error('UNKNOWN_MODEL'); return { provider, id, name: 'Synthetic exact model', context: { contextWindow: 1048576 }, reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }; }
      async *stream(options) { actual.push(options); yield { type: 'text-delta', index: 0, text: '合成回复' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    }
    ctx.llm.registerAdapter(['synthetic'], new Fake());
    ctx.on('agent/error', payload => errors.push(payload.error));
    ctx.on('session/event', (_session, event) => { if (event.type === 'session/title-llm-request') titleRequests.push(event); });
    const selected = { provider: 'synthetic', model: 'exact-model', reasoningEffort: 'off' };
    let policy = createModelPolicy(selected, 'qc'); const steps = new Map(); let offPolicy, policyContext;
    const policyFiber = ctx.plugin({ name: 'a01-synthetic-policy-host', apply(child) { policyContext = child; offPolicy = installAgentPolicy(child, policy, steps); } });
    await policyFiber.inertia;
    const timeoutPolicy = { ...nativeControlEvidence({ get: () => ({ entries: () => [...ctx.loader.entries()] }) }, policy) };
    const nativeConnection = ctx.llm.registration('deepseek-official').adapter.dependencies.options();
    const localCatalogue = new DeepSeekAdapter({ options: () => nativeConnection });
    const resolvedCatalogue = await localCatalogue.prepareCall('deepseek-official', 'deepseek-flash');
    assert.equal(resolvedCatalogue.model.provider, 'deepseek-official'); assert.equal(resolvedCatalogue.model.id, 'deepseek-flash'); assert.equal(resolvedCatalogue.model.context.contextWindow, 1048576);
    console.log('ok installed native local catalogue resolves deepseek-official/deepseek-flash context=1048576; remote listing/version remains unverified');
    const observed = observeLlm(ctx.llm, { readModelCall, isAgentLoopRequest, steps, timeoutPolicy, tags: () => ({ modelPolicy: policy }) });
    const agent = await ctx.agentLoop.create('synthetic-main', { provider: 'synthetic', model: 'exact-model' });
    // This real native selector tries to override the route. The explicit policy
    // must finish outside it; otherwise the nonexistent provider prevents dispatch.
    installModelSelection(agent.ctx, { current: { provider: 'wrong-provider', model: 'wrong-model', reasoningEffort: 'max' } });
    agent.followup(createUserMessage({ source: { kind: 'human' }, content: [{ type: 'text', text: 'synthetic user' }] })); await agent.whenIdle();
    assert.deepEqual(errors, []); assert.equal(actual.length, 1); assert.equal(titleRequests.length, 0);
    assert.deepEqual(agent.session.requestHeader().config, requestControls(policy));
    assert.deepEqual(verifyCallEvidence(observed.calls[0], policy), []); assert.equal(observed.calls[0].producer, 'agent-loop'); assert.equal(observed.calls[0].sessionId, agent.id); assert.equal(observed.calls[0].usage, null);
    console.log('ok native base/web/product/profile compose + Loader: title generator disabled, title service and actual main step retained; native selection overridden outside waterfall');
    // Wrong-order middleware is an observable refusal, never pseudo-PASS.
    const wrong = policyContext.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: 1 }), { prepend: true });
    const preparedWrong = await agent.prepareRequest(2, 1, new AbortController().signal);
    assert.throws(() => verifyPrepared(policy, preparedWrong.preparedCall), e => e.code === 'MODEL_POLICY_MISMATCH'); wrong();
    console.log('ok native waterfall wrong-order counterexample rejected before stream');
    offPolicy(); policy = createModelPolicy(selected, 'p'); Object.assign(timeoutPolicy, { policyHash: policy.hash });
    // Actual Pet code keeps its own native .chat path and fixed 700 tokens.
    const petModule = await load('plugins/surfcore/lib/pet-chat.js');
    const petCtx = { get: name => name === 'agentDefaultModel' ? { currentSelection: () => selected } : ctx.get(name) };
    const pet = petModule.createPetChatService({ ctx: petCtx, stateDir: path.join(process.env.DSH_HOME, 'surfcore'), capabilities: { guarded: false, endTurn() {}, currentCharacter: () => ({ id: 'synthetic-role', epoch: 1 }) } });
    const reply = await observed.runPet(() => pet.chat({ text: 'synthetic pet question', modality: 'text' }));
    assert.equal(reply.ok, true, JSON.stringify(reply)); const petCall = observed.calls.at(-1);
    assert.equal(petCall.producer, 'pet-chat'); assert.equal(actual.at(-1).maxTokens, 700); assert.equal(actual.at(-1).temperature, 0.2); assert.equal(actual.at(-1).reasoningEffort, 'off'); assert.deepEqual(verifyCallEvidence(petCall, policy), []);
    console.log('ok actual createPetChatService.chat -> native direct stream -> resolved off/.2/700, no usage required for provenance');
    const originalRepo = path.resolve(workspace, '../../..', '.local/evaluations/a01/original-59ec3066');
    const originalPetModule = await import(pathToFileURL(path.join(originalRepo, 'plugins/surfcore/lib/pet-chat.js')).href);
    const originalPet = originalPetModule.createPetChatService({ ctx: petCtx, stateDir: path.join(isolated, 'original-pet') });
    const originalReply = await observed.runPet(() => originalPet.chat({ text: 'synthetic original pet question', modality: 'text' }));
    assert.equal(originalReply.ok, true, JSON.stringify(originalReply)); assert.equal(actual.at(-1).maxTokens, 700); assert.equal(actual.at(-1).temperature, 0.2); assert.equal(actual.at(-1).reasoningEffort, 'off'); assert.deepEqual(verifyCallEvidence(observed.calls.at(-1), policy), []);
    console.log('ok unchanged original 59ec3066 createPetChatService.chat -> same native 700/.2/off controls');
    const registryLink = path.join(isolated, 'registry-junction');
    fs.symlinkSync(path.join(workspace, 'plugins/surfcore/lib/local-capabilities'), registryLink, 'junction');
    const linkedRegistry = await import(pathToFileURL(path.join(registryLink, 'model-call-registry.js')).href);
    assert.equal(linkedRegistry.readModelCall, readModelCall);
    const prepared = await ctx.llm.prepareCall(requestControls(policy));
    const options = registerModelCall({ ...prepared.config, messages: [] }, { producer: 'semantic-writer', taskId: 'native-synthetic-writer', platform: 'pet', policyHash: policy.hash });
    for await (const chunk of observed.runPet(() => prepared.stream(options))) void chunk;
    assert.equal(observed.calls.at(-1).producer, 'semantic-writer'); assert.equal(observed.calls.at(-1).taskId, 'native-synthetic-writer'); assert.deepEqual(verifyCallEvidence(observed.calls.at(-1), policy), []);
    assert.throws(() => prepared.stream(options), e => e.code === 'INVALID_PREPARED_CALL');
    assert.equal(linkedRegistry.readModelCall(options).taskId, 'native-synthetic-writer');
    await assert.rejects(ctx.llm.prepareCall({ ...requestControls(policy), provider: 'unknown-provider' }), e => e.code === 'NO_ADAPTER');
    await assert.rejects(ctx.llm.prepareCall({ ...requestControls(policy), model: 'unknown-model' }));
    console.log('ok native prepared same options/one-shot, unknown provider/model rejection, Writer registry wins over Pet scope');
    observed.restore();
    // Exercise the actual installed DeepSeek idleWatchdog using a fake transport
    // that never invokes request/auth/network. Clock advances, no wall-clock wait.
    const { mock } = require('node:test'); mock.timers.enable({ apis: ['setTimeout','Date'] });
    try {
      let returned = false;
      class Stalled extends DeepSeekAdapter { request() { return { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true }; } }; } }
      const adapter = new Stalled({ options: () => ({ streamIdleTimeoutMs: 60000 }) });
      const pending = adapter.generate({ messages: [] }, { streamIdleTimeoutMs: 60000 }).next().catch(error => error);
      await Promise.resolve(); mock.timers.tick(59999); await Promise.resolve(); mock.timers.tick(1);
      const error = await pending; assert.equal(error.code, 'TIMEOUT'); assert.equal(returned, true);
    } finally { mock.timers.reset(); }
    console.log('ok actual native DeepSeek generate idle watchdog fires at 60000ms under virtual clock');
    assert.equal(networkAttempts, 0); assert.equal(processAttempts, 0);
    console.log('PASS native isolated controls; external network=0, child process=0, credentials=none, ASAR read-only. Native tool author/provider/usage=unknown.');
  } finally { await ctx.fiber.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
