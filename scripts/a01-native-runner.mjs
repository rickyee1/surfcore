import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASELINE, FIXTURE_HASH, IDS, fixture, ref, schedule, save, json, sha, inside, blindPack, parity, assess, fault } from './a01-contract.mjs';
import { createRecorder } from './a01-onebot-recorder.mjs';
import { startNativeHost, stopOwned, delay, ownedBridgeReady } from './a01-dsh-factory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const shouldStartBridge = channel => channel !== 'p';
export function makePlan({ originalRepo, forkRepo, forkRef, seed = crypto.randomBytes(16).toString('hex') }) {
  const scenes = fixture(path.join(root, 'scripts/fixtures/a01-scenarios.json'));
  const original = ref(originalRepo, BASELINE), fork = ref(forkRepo, forkRef);
  if (original !== BASELINE || fork === original) throw fault('REFS_NOT_DISTINCT');
  return { schema: 1, status: 'FROZEN_NOT_RUN', fixtureHash: FIXTURE_HASH, seed, expectedRuns: 120,
    personaSha256: sha(fs.readFileSync(path.join(root, 'scripts/fixtures/a01-native/persona.md'))),
    repos: { original: { path: path.resolve(originalRepo), ref: original }, fork: { path: path.resolve(forkRepo), ref: fork } },
    harness: Object.fromEntries(fs.readdirSync(path.join(root, 'scripts')).filter(n => /^a01-.*\.mjs$/.test(n)).map(n => [n, sha(fs.readFileSync(path.join(root, 'scripts', n)))])),
    scenes, trials: schedule(scenes, seed) };
}
export function validatePlan(plan) {
  const scenes = fixture(path.join(root, 'scripts/fixtures/a01-scenarios.json'));
  if (plan.schema !== 1 || plan.expectedRuns !== 120 || Object.keys(plan.repos || {}).sort().join(',') !== 'fork,original' || plan.fixtureHash !== FIXTURE_HASH || JSON.stringify(plan.scenes) !== JSON.stringify(scenes) || JSON.stringify(plan.trials) !== JSON.stringify(schedule(scenes, plan.seed))) throw fault('PLAN_CHANGED');
  if (plan.personaSha256 !== sha(fs.readFileSync(path.join(root, 'scripts/fixtures/a01-native/persona.md')))) throw fault('PERSONA_CHANGED');
  for (const [version, source] of Object.entries(plan.repos)) if (ref(source.path, source.ref) !== source.ref || version === 'original' && source.ref !== BASELINE) throw fault('REF_CHANGED');
  for (const [name, hash] of Object.entries(plan.harness)) if (sha(fs.readFileSync(path.join(root, 'scripts', name))) !== hash) throw fault('HARNESS_CHANGED');
  return true;
}
export function dependencyFingerprint(directory) {
  const selected = ['@snowluma/sdk','@modelcontextprotocol/sdk','@deepseek-ai/dsh-host-apiproxy','js-yaml','zod'];
  return Object.fromEntries(selected.map(name => { const bytes = fs.readFileSync(path.join(directory, name, 'package.json')); return [name, { version: JSON.parse(bytes).version, sha256: sha(bytes) }]; }));
}
export async function archiveTrial(source, destination, dependencies) {
  fs.mkdirSync(destination, { recursive: false });
  if (process.platform === 'win32') {
    // Windows bsdtar loses UTF-8 Chinese paths under some host locales.
    // Expand-Archive decodes Git's UTF-8 ZIP names without changing file bytes.
    const archive = destination + '.zip';
    execFileSync('git', ['archive','--format=zip',`--output=${archive}`,source.ref], { cwd: source.path, windowsHide: true, stdio: 'pipe', timeout: 60000 });
    execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:A01_ARCHIVE_INPUT -DestinationPath $env:A01_ARCHIVE_DEST -ErrorAction Stop'], { env: { ...process.env, A01_ARCHIVE_INPUT: archive, A01_ARCHIVE_DEST: destination }, windowsHide: true, stdio: 'pipe', timeout: 60000 });
  } else {
    const git = spawn('git', ['archive','--format=tar',source.ref], { cwd: source.path, stdio: ['ignore','pipe','pipe'] });
    const tar = spawn('tar', ['-xf','-','-C',destination], { stdio: ['pipe','ignore','pipe'] });
    const complete = child => new Promise((resolve, reject) => { child.stderr.on('data', () => {}); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(fault('ARCHIVE_FAILED'))); });
    const completion = Promise.all([complete(git), complete(tar)]); git.stdout.pipe(tar.stdin); tar.stdin.on('error', () => {}); await completion;
  }
  fs.symlinkSync(path.resolve(dependencies), path.join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}
export function latencies(inputs, bubbles) {
  return inputs.filter(i => i.phase === 'scored').map(i => {
    const exact = bubbles.filter(b => b.segments?.some(s => s.type === 'reply' && String(s.data.id) === String(i.message_id)));
    const pet = bubbles.filter(b => b.kind === 'pet' && b.phase === 'scored' && b.inputWindow === i.turn);
    const candidates = pet.length ? pet : exact.length ? exact : bubbles.filter(b => b.phase === 'scored' && b.at >= i.at);
    return { turn: i.turn, inputAt: i.at, firstMs: candidates.length ? candidates[0].at - i.at : null, lastMs: candidates.length ? candidates.at(-1).at - i.at : null,
      attribution: exact.length ? 'reply_message_id' : i.message_id === undefined ? 'native_pet_response' : 'temporal_only_inspect_bubbles' };
  });
}
export async function runTrial(plan, trial, options) {
  const scene = plan.scenes.find(s => s.id === trial.sceneId), trialDir = inside(options.out, path.join(options.out, trial.trialId));
  fs.mkdirSync(trialDir); const repo = path.join(trialDir, 'repo'), controlToken = crypto.randomBytes(32).toString('hex');
  const result = { ...trial, state: 'running', inputs: [], bubbles: [], calls: [], toolEvents: [], turnEvents: [], undeliveredOutputs: [], startedAt: Date.now(), phase: 'setup' };
  let recorder, host, bridge, phase = 'setup', inputWindow = 0, cleanupError;
  async function observed() { const value = await host.request('observe'); result.calls = value.calls; result.toolEvents = value.toolEvents; result.turnEvents = value.turnEvents; return value; }
  async function quietUntil(deadline, requireDelivery, startBubble) {
    while (Date.now() < deadline) {
      const view = await observed();
      const last = new Map(); for (const e of view.turnEvents) last.set(`${e.sessionId}:${e.turn}`, e.type);
      const active = [...last.values()].includes('turn/start') || view.calls.some(c => c.dispatched && !c.endedAt);
      const lastChange = Math.max(...view.calls.map(c => c.endedAt || c.startedAt), ...result.bubbles.map(b => b.at), result.inputs.at(-1)?.at || 0);
      if (!active && (!requireDelivery || result.bubbles.length > startBubble) && view.calls.length && Date.now() - lastChange >= 1200) return;
      await delay(150);
    }
    throw fault('TIMED_OUT_OR_HUNG', 'Preserve all partial outputs and the outstanding native turn; do not replay this scenario.');
  }
  try {
    if (JSON.stringify(dependencyFingerprint(options.dependencies)) !== JSON.stringify(options.dependencyEvidence)) throw fault('DEPENDENCIES_CHANGED');
    await archiveTrial(plan.repos[trial.version], repo, options.dependencies);
    recorder = await createRecorder(); recorder.events.on('bubble', bubble => result.bubbles.push({ ...bubble, phase, inputWindow }));
    host = await startNativeHost({ ...options, ...trial, trialDir, repo, scene, controlToken, onebot: recorder, personaFile: path.join(root, 'scripts/fixtures/a01-native/persona.md') });
    result.attestation = { ...host.attestation, dependencies: options.dependencyEvidence };
    if (options.referenceRuntime && JSON.stringify(result.attestation) !== JSON.stringify(options.referenceRuntime)) throw fault('RUNTIME_CHANGED', 'Use the same installed DSH/Node/dependencies and selection for both versions.');
    result.seed = await host.request('seed');
    if (shouldStartBridge(trial.channel)) {
      bridge = spawn(process.execPath, [path.join(repo, 'src/bridge.js')], { cwd: repo, env: host.bridgeEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
      bridge.stdout.on('data', () => {}); bridge.stderr.on('data', () => {});
      bridge.on('error', () => { result.bridgeSpawnFailed = true; });
      save(path.join(trialDir, 'bridge-process.json'), { pid: bridge.pid || null, executable: process.execPath, entry: path.join(repo, 'src/bridge.js'), home: host.bridgeEnv.DSH_HOME });
      let ready = false; const deadline = Date.now() + 45000;
      while (Date.now() < deadline && bridge.exitCode === null && !result.bridgeSpawnFailed) {
        try { const status = await (await fetch(`http://127.0.0.1:${host.consolePort}/api/status`, { headers: { 'x-console-token': controlToken }, signal: AbortSignal.timeout(1000) })).json(); const lockPid = Number(fs.readFileSync(path.join(repo, 'state/bridge.lock'), 'utf8').trim()); if (recorder.connected() && ownedBridgeReady(bridge, status, { lockPid, repo, baseUrl: host.baseUrl, mode: trial.channel === 'qc' ? 'chat' : 'reserved2' })) { ready = true; break; } } catch {}
        await delay(250);
      }
      if (!ready) throw fault('NATIVE_BRIDGE_NOT_READY', 'Inspect the isolated bridge and preset registration; do not spend the full batch retrying setup.');
    }
    const invoke = async (text, index, timing = false) => {
      inputWindow = index;
      await host.request('mark', { phase, inputWindow: index });
      if (trial.channel === 'p') {
        const at = Date.now(), input = { text, at, turn: index, phase }; result.inputs.push(input);
        const answer = await host.request('pet', { text }, options.sceneTimeoutMs);
        if (!answer.ok) throw fault(answer.code || 'NATIVE_PET_FAILED', answer.hint || answer.error);
        // This response actually crossed the isolated pet HTTP transport.
        result.bubbles.push({ text: answer.reply.text, at: Date.now(), kind: 'pet', phase, inputWindow, delivery: 'native-chat-http-response' });
      } else {
        const input = recorder.inject(text, { group: trial.channel === 'rg', sender: scene.setup.sender === 'non_owner' || (trial.sceneId === 'A01-29' && index === 1) ? IDS.other : IDS.owner, groupId: IDS.group_a, phase, turn: index }); result.inputs.push(input);
        if (!timing) await quietUntil(Date.now() + options.sceneTimeoutMs, trial.sceneId !== 'A01-27', result.bubbles.length);
      }
    };
    phase = 'history';
    for (const [i, text] of (scene.setup.history || []).entries()) await invoke(text, i);
    phase = 'scored'; result.phase = 'scored';
    const special = Boolean(scene.setup.second_turn_timing);
    if (special) {
      const before = result.bubbles.length; await invoke(scene.user_turns[0], 0, true);
      const deadline = Date.now() + options.sceneTimeoutMs;
      while (result.bubbles.length === before && Date.now() < deadline) { await observed(); await delay(50); }
      if (result.bubbles.length === before) throw fault('FIRST_DELIVERY_MISSING');
      if (trial.sceneId === 'A01-28') await delay(Math.max(0, result.bubbles[before].at + 1000 - Date.now()));
      await invoke(scene.user_turns[1], 1, true); await quietUntil(Date.now() + options.sceneTimeoutMs, true, result.bubbles.length);
    } else for (const [i, text] of scene.user_turns.entries()) await invoke(text, i);
    const observeMs = (scene.setup.observe_after_last_input_seconds || 0) * 1000;
    if (observeMs) { const until = result.inputs.at(-1).at + observeMs; while (Date.now() < until) { await observed(); await delay(Math.min(200, until - Date.now())); } }
    await observed(); result.state = result.bubbles.some(b => b.phase === 'scored') || trial.sceneId === 'A01-27' ? 'completed' : 'undelivered';
  } catch (e) { result.state = /TIME|HUNG/.test(e.code || '') ? 'timed_out_or_hung' : 'failed'; result.failure = { code: e.code || 'HARNESS_FAILED', stage: phase, hint: e.hint || 'Keep this run; inspect isolated setup before a new evaluation batch.' }; try { if (host) await observed(); } catch { result.observationFailure = 'NOT_VERIFIED'; } }
  finally {
    for (const [label, stop] of [['bridge', () => stopOwned(bridge, 'bridge')], ['DSH', () => host?.stop()], ['recorder', () => recorder?.close()]]) {
      try { await stop(); } catch { cleanupError = true; result.cleanupFailure = label; }
    }
    if (cleanupError) result.state = 'cleanup_failed';
    result.endedAt = Date.now(); result.latency = latencies(result.inputs, result.bubbles);
    const delivered = result.bubbles.map(b => b.text).join('\n');
    result.undeliveredOutputs = result.calls.filter(c => c.output && !delivered.includes(c.output)).map(c => ({ callId: c.callId, text: c.output, classification: 'not_exactly_matched_to_delivered_bubble; inspect_native_splitting', finish: c.finish }));
    save(path.join(trialDir, 'result.json'), result);
  }
  return result;
}
export async function runPlan(plan, options) {
  validatePlan(plan); if (fs.existsSync(options.out)) throw fault('BATCH_ALREADY_EXISTS', 'Use a new batch directory; no silent replacement or best-of selection.'); fs.mkdirSync(options.out, { recursive: true });
  options.dependencyEvidence = dependencyFingerprint(options.dependencies);
  save(path.join(options.out, 'plan.private.json'), plan);
  const results = plan.trials.map(t => ({ ...t, state: 'NOT_RUN', inputs: [], bubbles: [], calls: [], toolEvents: [], undeliveredOutputs: [] }));
  const selected = options.smokeOriginal ? ['A01-02','A01-01'].map(sceneId => plan.trials.find(t => t.version === 'original' && t.sceneId === sceneId && t.repeat === 1)) : plan.trials;
  for (const trial of selected) {
    const result = await runTrial(plan, trial, options); results[plan.trials.indexOf(trial)] = result;
    if (!options.referenceRuntime && result.attestation) options.referenceRuntime = result.attestation;
    if (result.state === 'cleanup_failed' || result.failure?.stage === 'setup') break;
  }
  save(path.join(options.out, 'results.private.json'), results);
  const pack = blindPack(plan, results, plan.seed + ':blind'); save(path.join(options.out, 'blind-pack.json'), pack.publicPack); save(path.join(options.out, 'blind-mapping.private.json'), pack.privateMapping);
  const summary = { status: 'UNSCORED_NOT_ACCEPTED', expectedRuns: 120, attempted: results.filter(r => r.state !== 'NOT_RUN').length, states: Object.fromEntries([...new Set(results.map(r => r.state))].map(s => [s, results.filter(r => r.state === s).length])), blockers: parity(results) };
  save(path.join(options.out, 'summary.json'), summary); return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2), args = Object.fromEntries(rest.reduce((a, x, i) => x.startsWith('--') ? [...a, [x.slice(2), rest[i + 1]?.startsWith('--') || !rest[i + 1] ? true : rest[i + 1]]] : a, []));
    if (command === 'plan') { const plan = makePlan({ originalRepo: args.original, forkRepo: args.fork, forkRef: args['fork-ref'], seed: args.seed }); save(args.out, plan); console.log('A01 FROZEN_NOT_RUN: 120 scene runs; no DSH/model/platform started.'); }
    else if (command === 'preflight') { validatePlan(json(args.plan)); console.log('A01 deterministic ref/fixture/harness preflight PASS; native runtime remains NOT_VERIFIED.'); }
    else if (command === 'assess') { const plan = json(args.plan); validatePlan(plan); const report = assess(json(args.pack), json(args.mapping), json(args.results), plan); save(args.out, report); console.log(JSON.stringify({ status: report.status, nonInferior: report.nonInferior, denominator: 30 })); }
    else if (command === 'run' && args.execute === true) { const summary = await runPlan(json(args.plan), { out: path.resolve(args.out), dependencies: args.dependencies, seedDir: args['model-seed'], executable: args['dsh-executable'], cliEntry: args['cli-entry'], python: args.python, sceneTimeoutMs: Number(args['scene-timeout-ms'] || 180000), smokeOriginal: args['smoke-original'] === true }); console.log(JSON.stringify(summary)); }
    else throw fault('USAGE', 'plan --original REPO --fork REPO --fork-ref COMMIT --out PLAN; preflight --plan PLAN; run --execute --plan PLAN --out NEWDIR --dependencies NODE_MODULES --model-seed DIR --dsh-executable EXE --cli-entry FILE [--python EXE] [--smoke-original]');
  } catch (e) { console.error(JSON.stringify({ ok: false, code: e.code || 'HARNESS_FAILED', hint: e.hint || 'Check the isolated harness inputs; no automatic retry.' })); process.exitCode = 1; }
}
