import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { BASELINE, IDS, fixture, schedule, blindPack, assess, parity, modelControls, inside, save } from './a01-contract.mjs';
import { observeLlm } from './a01-native-host.mjs';
import { createRecorder } from './a01-onebot-recorder.mjs';
import { isolatedEnvironment, stageHost, startNativeHost, delay, ownedHostReady, ownedBridgeReady } from './a01-dsh-factory.mjs';
import { makePlan, validatePlan, latencies, archiveTrial, shouldStartBridge } from './a01-native-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(root, '.local/evidence/a01/self-check-' + crypto.randomUUID()); fs.mkdirSync(temp, { recursive: true });
let count = 0;
async function check(name, action) { await action(); console.log(`ok ${++count} ${name}`); }
const scenes = fixture(path.join(root, 'scripts/fixtures/a01-scenarios.json'));
await check('frozen fixture creates exactly120 interleaved distinct trials with all8 reserved2 scenes', () => {
  const trials = schedule(scenes, 'fixed'); assert.equal(trials.length, 120); assert.equal(trials.filter(t => ['rv','rg'].includes(t.channel)).length, 32);
  assert.equal(new Set(trials.map(t => `${t.sceneId}:${t.version}:${t.repeat}`)).size, 120); assert.deepEqual(schedule(scenes, 'fixed'), trials); assert.notDeepEqual(schedule(scenes, 'another'), trials);
});
await check('actual original git ref and native entry points are frozen without rewriting production source', () => {
  const plan = makePlan({ originalRepo: path.join(root, '.local/evaluations/a01/original-59ec3066'), forkRepo: root, forkRef: '875b405c20dd58f2107972b1d876f11924a1d562', seed: 'self-check' });
  assert.equal(plan.repos.original.ref, BASELINE); assert.equal(validatePlan(plan), true);
  const runner = fs.readFileSync(new URL('./a01-native-runner.mjs', import.meta.url), 'utf8'), host = fs.readFileSync(new URL('./a01-native-host.mjs', import.meta.url), 'utf8');
  assert.match(runner, /src\/bridge\.js/); assert.match(host, /native\.createPetChatService/); assert.match(host, /pet\.chat\(/); assert.doesNotMatch(runner, /\.stream\(|\.prepareCall\(|system:/);
});
await check('environment allowlist removes inherited provider/platform secrets and redirects all homes', () => {
  const prior = process.env.A01_TEST_SECRET; process.env.A01_TEST_SECRET = 'must-not-inherit';
  try { const trial = path.join(temp, 'env'); fs.mkdirSync(trial); const env = isolatedEnvironment(trial, path.join(trial, 'repo')); assert.equal(env.A01_TEST_SECRET, undefined); assert.equal(env.DEEPSEEK_API_KEY, undefined); for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','DSH_HOME']) assert.equal(inside(trial, env[key]), path.resolve(env[key])); } finally { if (prior === undefined) delete process.env.A01_TEST_SECRET; else process.env.A01_TEST_SECRET = prior; }
});
function fakeLlm() {
  const object = {
    resolveCallWithInfo(config, info) { return { config: { ...config, maxTokens: config.maxTokens || 700, reasoningEffort: config.reasoningEffort || 'off' }, modelInfo: info }; },
    async *generate(options) { this.seen = options; this.resolveCallWithInfo(options, { id: options.model, name: 'exact model metadata', context: { contextWindow: 64000 } }); yield { type: 'text-delta', text: '合成输出' }; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }; yield { type: 'finish', reason: { kind: 'stop' } }; },
    stream(options) { return this.generate(options); },
    async prepareCall(config, signal, configure) { signal?.throwIfAborted(); this.configureSeen = configure; const resolved = this.resolveCallWithInfo(config, { id: config.model, name: 'native resolved', context: { contextWindow: 64000 } }); let used = false; return Object.freeze({ config: Object.freeze(resolved.config), context: Object.freeze({ contextWindow: 64000 }), stream: options => { if (used) throw Object.assign(Error('one-shot'), { code: 'INVALID_PREPARED_CALL' }); used = true; this.preparedOptions = options; return this.generate(options); } }); },
  }; return object;
}
await check('observer transparently forwards original stream options and every chunk, observes actual resolved controls', async () => {
  const llm = fakeLlm(), original = llm.stream, observed = observeLlm(llm), options = { provider: 'synthetic', model: 'native', system: 'PROMPT_MUST_NOT_BE_RECORDED', messages: [], privateKey: 'SECRET_MUST_NOT_BE_RECORDED' };
  const chunks = []; for await (const c of llm.stream(options)) chunks.push(c);
  assert.equal(llm.seen, options); assert.deepEqual(chunks.map(c => c.type), ['text-delta','usage','finish']); assert.equal(observed.calls[0].effective.maxTokens, 700); assert.equal(observed.calls[0].effective.contextWindow, 64000);
  assert.equal(observed.calls[0].output, '合成输出'); assert.equal(observed.calls[0].finish.kind, 'stop'); assert.doesNotMatch(JSON.stringify(observed.calls), /PROMPT_MUST|SECRET_MUST/); observed.restore(); assert.equal(llm.stream, original);
});
await check('prepared frozen handle retains config identity, configure callback, cancellation and native one-shot rejection', async () => {
  const llm = fakeLlm(), observed = observeLlm(llm), controller = new AbortController(), configure = () => {};
  const prepared = await llm.prepareCall({ provider: 'synthetic', model: 'native' }, controller.signal, configure), opts = { ...prepared.config, system: 'synthetic', messages: [] };
  assert.equal(Object.isFrozen(prepared), true); assert.equal(Object.isFrozen(prepared.config), true); assert.equal(llm.configureSeen, configure);
  for await (const c of prepared.stream(opts)) assert.ok(c); assert.equal(llm.preparedOptions, opts); assert.equal(observed.calls.length, 1); assert.throws(() => prepared.stream(opts), /one-shot/);
  controller.abort(); await assert.rejects(llm.prepareCall({ provider: 'synthetic', model: 'native' }, controller.signal), { name: 'AbortError' }); observed.restore();
});
await check('unsupported observer fails closed rather than claiming native effective telemetry', () => { assert.throws(() => observeLlm({ stream() {} }), e => e.code === 'LLM_OBSERVER_NOT_SUPPORTED'); });
await check('real SnowLuma SDK talks to isolated recorder over WS and HTTP; bubbles remain separate and targets bounded', async () => {
  const recorder = await createRecorder(), client = new SnowLumaWebSocketClient({ url: recorder.wsUrl, reconnect: false, requestTimeoutMs: 3000 });
  try {
    await client.connect(); assert.equal((await client.getLoginInfo()).user_id, Number(IDS.bot));
    let received; client.onPrivateMessage(event => { received = event; }); const input = recorder.inject('合成入站');
    for (let i = 0; i < 20 && !received; i++) await delay(10); assert.equal(received.raw_message, '合成入站'); assert.equal(received.message_id, input.message_id);
    await client.sendPrivateMessage(Number(IDS.owner), '气泡一');
    const response = await fetch(recorder.baseUrl + '/send_private_msg', { method: 'POST', body: JSON.stringify({ user_id: IDS.owner, message: [{ type: 'text', data: { text: '气泡二' } }] }) }); assert.equal((await response.json()).status, 'ok');
    assert.deepEqual(recorder.bubbles.map(b => b.text), ['气泡一','气泡二']);
    await assert.rejects(client.sendPrivateMessage(999, '拒绝目标')); assert.equal(recorder.bubbles.length, 2);
  } finally { client.close(); await recorder.close(); }
});
await check('latency retains every bubble and labels temporal-only second-input attribution honestly', () => {
  const data = latencies([{ at: 100, turn: 0, phase: 'scored', message_id: 1 }, { at: 1100, turn: 1, phase: 'scored', message_id: 2 }], [{ at: 1500, phase: 'scored', text: 'old' }, { at: 1700, phase: 'scored', text: 'new', segments: [{ type: 'reply', data: { id: 2 } }] }]);
  assert.equal(data[1].firstMs, 600); assert.equal(data[1].attribution, 'reply_message_id'); assert.equal(data[0].attribution, 'temporal_only_inspect_bubbles');
});
await check('blind pack keeps all60 pairs/120 runs including NOT_RUN, failed, timed-out and undelivered output', () => {
  const plan = { scenes }, results = [{ sceneId: scenes[0].id, repeat: 1, version: 'fork', state: 'timed_out_or_hung', bubbles: [{ text: '气泡一' }, { text: '气泡二' }], undeliveredOutputs: [{ callId: 'c1', text: '未交付' }], inputs: [], calls: [] }];
  const pack = blindPack(plan, results, 'blind'); assert.equal(pack.publicPack.pairs.length, 60); const p = pack.publicPack.pairs[0], side = pack.privateMapping[0].left === 'fork' ? 'left' : 'right';
  assert.equal(p[side].bubbles.length, 2); assert.equal(p[side].state, 'timed_out_or_hung'); assert.equal(p[side].undeliveredOutputs[0].text, '未交付'); assert.doesNotMatch(JSON.stringify(pack.publicPack), /"version"|"fork"|"original"/); assert.equal(assess(pack.publicPack, pack.privateMapping).status, 'NOT_VERIFIED');
});
function completeEvidence() {
  const plan = makePlan({ originalRepo: path.join(root, '.local/evaluations/a01/original-59ec3066'), forkRepo: root, forkRef: '875b405c20dd58f2107972b1d876f11924a1d562', seed: 'assessment-test' });
  const results = plan.trials.map(t => ({ ...t, state: 'completed', inputs: [], bubbles: [], undeliveredOutputs: [], calls: [{ phase: 'scored', dispatched: true, startedAt: 1, endedAt: 2, finish: { kind: 'stop' }, effective: { provider: 'synthetic', model: 'synthetic', contextWindow: 64000 } }], toolEvents: [{ type: 'tool/call', nativeCallId: 'native-1', phase: 'scored' }, { type: 'tool/result', nativeCallId: 'native-1' }] }));
  const { publicPack: pack, privateMapping: mapping } = blindPack(plan, results, plan.seed + ':blind');
  for (const p of pack.pairs) for (const side of ['left','right']) for (const d of ['naturalness','completeness','lowInterruption']) p.scores[side][d] = 3;
  return { plan, results, pack, mapping };
}
await check('full bound120 raw trials/60pairs pass; fork hard failure overrides scores', () => {
  const e = completeEvidence(); assert.equal(assess(e.pack, e.mapping, e.results, e.plan).status, 'PASS');
  const side = e.mapping[0].left === 'fork' ? 'left' : 'right'; e.pack.pairs[0].hardFailures[side].push('leak');
  assert.equal(assess(e.pack, e.mapping, e.results, e.plan).status, 'FAIL');
});
await check('assessment pseudo-PASS matrix rejects removed scenes, missing/duplicate/raw/mapping/pack corruption and ghost calls', () => {
  const mutations = [
    e => { e.pack.pairs = e.pack.pairs.slice(0,48); e.results = []; },
    e => { e.results = []; }, e => { e.results.pop(); }, e => { e.results[0] = structuredClone(e.results[1]); },
    e => { e.results[0].channel = 'invented'; }, e => { [e.mapping[0].left,e.mapping[0].right] = [e.mapping[0].right,e.mapping[0].left]; },
    e => { e.pack.pairs[0].left.bubbles.push({ text: 'invented delivery' }); }, e => { e.pack.pairs[0].id = e.pack.pairs[1].id; },
    e => { e.pack.pairs[0].user_turns[0] = 'changed'; }, e => { e.plan.trials.pop(); },
    e => { e.results.forEach(r => r.calls.forEach(c => { c.dispatched = false; c.finish = null; })); },
    e => { e.results.forEach(r => r.calls.forEach(c => { c.finish = null; })); },
    e => { e.results.forEach(r => r.calls.forEach(c => { c.endedAt = null; })); },
  ];
  for (const mutate of mutations) { const e = JSON.parse(JSON.stringify(completeEvidence())); mutate(e); assert.equal(assess(e.pack, e.mapping, e.results, e.plan).status, 'NOT_VERIFIED'); }
  for (const defect of ['undispatched','no-finish']) {
    const e = completeEvidence();
    e.results.forEach(r => r.calls.forEach(c => { if (defect === 'undispatched') c.dispatched = false; else c.finish = null; }));
    const rebuilt = blindPack(e.plan,e.results,e.plan.seed+':blind').publicPack;
    for (let i=0;i<rebuilt.pairs.length;i++) rebuilt.pairs[i].scores = e.pack.pairs[i].scores;
    const report = assess(rebuilt,e.mapping,e.results,e.plan);
    assert.equal(report.status,'NOT_VERIFIED'); assert.ok(report.blockers.some(b=>b.code==='DISPATCH_FINISH_NOT_VERIFIED'));
  }
  assert.equal(assess(completeEvidence().pack, completeEvidence().mapping).status, 'NOT_VERIFIED');
});
await check('actual assess CLI cannot accept an empty raw-results file', () => {
  const e = completeEvidence(), dir = path.join(temp, 'cli-assessment'); fs.mkdirSync(dir);
  for (const [name,value] of Object.entries({ plan: e.plan, pack: e.pack, mapping: e.mapping, results: [] })) save(path.join(dir,name+'.json'),value);
  execFileSync(process.execPath, [path.join(root,'scripts/a01-native-runner.mjs'),'assess','--plan',path.join(dir,'plan.json'),'--pack',path.join(dir,'pack.json'),'--mapping',path.join(dir,'mapping.json'),'--results',path.join(dir,'results.json'),'--out',path.join(dir,'report.json')], { stdio: 'pipe' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'report.json'),'utf8')).status, 'NOT_VERIFIED');
});
await check('parity checks actual within-channel controls and counts unknown native tool rounds', () => {
  const controls = modelControls({ provider: 'p', model: 'm', maxTokens: 700, temperature: 1 }, { context: { contextWindow: 64000 } });
  const a = { trialId: 'a', sceneId: 's', repeat: 1, version: 'original', channel: 'rv', state: 'completed', calls: [{ effective: controls }], toolEvents: [] }, b = { ...a, trialId: 'b', version: 'fork', calls: [{ effective: { ...controls, maxTokens: 800 } }] };
  const issues = parity([a,b]); assert.ok(issues.some(e => e.code === 'CHANNEL_MODEL_CONTROLS_DIFFER')); assert.ok(issues.some(e => e.code === 'NATIVE_TOOL_ROUND_NOT_VERIFIED'));
});
const seedDir = path.join(temp, 'synthetic-model-seed'); fs.mkdirSync(seedDir); save(path.join(seedDir, 'selection.json'), { provider: 'synthetic', model: 'synthetic', reasoningEffort: 'off' }); fs.writeFileSync(path.join(seedDir, '.credentials.yaml'), 'INVALID_YAML_IS_OPAQUE_COPY_ONLY');
function hostArgs(label) { const trialDir = path.join(temp, label), repo = path.join(trialDir, 'repo'); fs.mkdirSync(path.join(repo, 'plugins/surfcore'), { recursive: true }); fs.mkdirSync(path.join(repo, 'src')); return { trialDir, repo, seedDir, scene: scenes[1], version: 'original', trialId: label, controlToken: crypto.randomBytes(32).toString('hex'), onebot: { wsUrl: 'ws://127.0.0.1:1', baseUrl: 'http://127.0.0.1:1' }, personaFile: path.join(root, 'scripts/fixtures/a01-native/persona.md') }; }
await check('factory stages only selected seed, real native MCP paths and isolated profile; no credential parsing', () => {
  const args = hostArgs('stage'), staged = stageHost({ ...args, dshPort: 12340, consolePort: 12341 });
  assert.equal(fs.readFileSync(path.join(staged.env.DSH_HOME, '.credentials.yaml'), 'utf8'), 'INVALID_YAML_IS_OPAQUE_COPY_ONLY');
  const patch = JSON.parse(fs.readFileSync(path.join(staged.env.DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8'));
  assert.deepEqual(patch.find(row => row.id === 'agent-default-model')?.config, staged.selection);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staged.env.DSH_HOME, 'profiles/web/package.json'), 'utf8')).dsh.profile.bundles, ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','surfcore']);
  assert.equal(patch[0].insert.filter(e => e.name === '@deepseek-ai/dsh-mcp-client').length, 3); assert.equal(staged.config.biliBridge.enabled, false); assert.equal(staged.config.purpose.enabled, false); assert.equal(staged.config.socialV2.voice.enabled, false);
});
await check('actual original/fork maybeAutoStartBridge decisions keep pet zero and QQ exactly one runner owner; updates disabled', async () => {
  for (const [version,sourceRepo] of [['original',path.join(root,'.local/evaluations/a01/original-59ec3066')],['fork',root]]) {
    const source = fs.readFileSync(path.join(sourceRepo,'plugins/surfcore/lib/index.js'),'utf8');
    const start = source.indexOf('  const maybeAutoStartBridge = async () => {'), end = source.indexOf('\n  const disposers',start);
    assert.ok(start > 0 && end > start);
    for (const channel of ['p','qc']) {
      const args = hostArgs(version+'-'+channel), staged = stageHost({ ...args, scene: { ...scenes[1], setup: { channel } }, dshPort: 12342, consolePort: 12343 });
      let starts = 0;
      const context = { process: { env: staged.env }, platformStartEnabled: () => true, bridgeStatus: async () => ({ running: false }), bridgeStaleReason: () => '', startBridge: async () => { starts++; return {}; }, restartBridge: async () => { starts++; return {}; }, currentDshUrl: () => '', pluginLog: () => {} };
      await vm.runInNewContext('(async()=>{let bridgeRepairBusy=false;'+source.slice(start,end)+'; await maybeAutoStartBridge();})()',context);
      assert.equal(starts,0); assert.equal(starts + Number(shouldStartBridge(channel)),channel === 'p' ? 0 : 1);
      const unified = JSON.parse(fs.readFileSync(path.join(staged.env.DSH_HOME,'surfcore/config.json'),'utf8'));
      const blockStart = source.indexOf('    const updCfg = readUnified().config?.updates ?? {};',source.indexOf('// 组件更新检查'));
      const blockEnd = source.indexOf('\n  } catch',blockStart); assert.ok(blockStart > 0 && blockEnd > blockStart);
      let enabled; vm.runInNewContext(source.slice(blockStart,blockEnd), { readUnified: () => ({ config: unified }), updates: { startAutoCheck: config => { enabled = config.enabled; } } }); assert.equal(enabled,false);
    }
  }
});
await check('ready rejects dead/mismatched DSH or bridge child/status/lock identity', () => {
  const child = { pid: 123, exitCode: null, signalCode: null }, expected = { trialId: 't', repo: temp, home: path.join(temp,'home') };
  const ready = { ...expected, pid: 123, observer: true }; assert.equal(ownedHostReady(child,ready,expected),true);
  assert.equal(ownedHostReady({ ...child,exitCode: 0 },ready,expected),false); assert.equal(ownedHostReady(child,{ ...ready,pid: 999 },expected),false);
  const status = { dshReady: true,mode: 'chat',root: temp,dshBaseUrl: 'http://127.0.0.1:1234' }, bridgeExpected = { repo: temp,baseUrl: status.dshBaseUrl,mode: 'chat',lockPid:123 };
  assert.equal(ownedBridgeReady(child,status,bridgeExpected),true);
  for (const wrong of [{...bridgeExpected,lockPid:999},{...bridgeExpected,repo:path.join(temp,'other')},{...bridgeExpected,baseUrl:'http://127.0.0.1:9999'}]) assert.equal(ownedBridgeReady(child,status,wrong),false);
  assert.equal(ownedBridgeReady({...child,exitCode:0},status,bridgeExpected),false);
});
await check('factory actual child lifecycle/ready attestation and owned stop work with a no-model fake CLI', async () => {
  const args = hostArgs('lifecycle'), host = await startNativeHost({ ...args, executable: process.execPath, cliEntry: path.join(root, 'scripts/fixtures/a01-native/fake-cli.mjs'), startupTimeoutMs: 5000 });
  assert.equal(host.attestation.runtimeNode, 'SELF_CHECK_FAKE_NOT_DSH'); await host.stop(); assert.notEqual(host.child.exitCode ?? host.child.signalCode, null);
  assert.equal(host.bridgeEnv.DSH_LAUNCH_TOKEN, undefined);
});
await check('archive deploys actual original tracked native code plus common dependencies without writing source worktree', async () => {
  const repo = path.join(root, '.local/evaluations/a01/original-59ec3066'), target = path.join(temp, 'actual-original-archive');
  await archiveTrial({ path: repo, ref: BASELINE }, target, path.join(root, 'node_modules'));
  assert.equal(fs.readFileSync(path.join(target, 'src/bridge.js'), 'utf8'), fs.readFileSync(path.join(repo, 'src/bridge.js'), 'utf8'));
  assert.ok(fs.lstatSync(path.join(target, 'node_modules')).isSymbolicLink()); assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
});
console.log(`PASS ${count} deterministic A01 harness checks; NO real DSH/model/QQ/Bili run. Synthetic artifacts: ${temp}`);

