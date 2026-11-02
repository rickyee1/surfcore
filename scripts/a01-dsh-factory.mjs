import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { IDS, inside, json, save, sha, loopback, fault } from './a01-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function unusedPort() { const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
export function isolatedEnvironment(trialDir, repo, extra = {}) {
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','ComSpec','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const user = inside(trialDir, path.join(trialDir, 'user'));
  Object.assign(env, { USERPROFILE: user, HOME: user, APPDATA: path.join(user, 'AppData/Roaming'), LOCALAPPDATA: path.join(user, 'AppData/Local'), TEMP: path.join(user, 'Temp'), TMP: path.join(user, 'Temp'),
    DSH_HOME: path.join(trialDir, 'dsh-home'), SURFCORE_ROOT: repo, SURFCORE_QQBOT_ROOT: repo, ...extra, SURFCORE_SKIP_AUTOSTART: '1' });
  for (const key of ['USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','DSH_HOME']) { inside(trialDir, env[key]); fs.mkdirSync(env[key], { recursive: true }); }
  return env;
}
export function stageHost({ trialDir, repo, scene, trialId, version, seedDir, controlToken, dshPort, consolePort, onebot, personaFile, python }) {
  inside(trialDir, repo);
  const seedPath = path.resolve(seedDir), selection = json(path.join(seedPath, 'selection.json'));
  if (Object.keys(selection).some(k => !['provider','model','reasoningEffort'].includes(k)) || !selection.provider || !selection.model) throw fault('MODEL_SEED_INVALID', 'Supply only the explicitly selected model fields.');
  const env = isolatedEnvironment(trialDir, repo, { A01_CONTROL_TOKEN: controlToken, A01_TRIAL_CONFIG: path.join(trialDir, 'trial-host.json'), ...(python ? { SURFCORE_LOCAL_PYTHON: python } : {}) });
  const credentialSource = path.join(seedPath, '.credentials.yaml');
  if (!fs.lstatSync(credentialSource).isFile() || fs.lstatSync(credentialSource).isSymbolicLink()) throw fault('MODEL_SEED_INVALID');
  // Copy only root's minimal selected-model seed. Never parse, hash, return or log it.
  fs.copyFileSync(credentialSource, path.join(env.DSH_HOME, '.credentials.yaml'), fs.constants.COPYFILE_EXCL);
  const profile = path.join(env.DSH_HOME, 'profiles/web'); fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  const plugin = path.join(repo, 'plugins/surfcore');
  fs.symlinkSync(plugin, path.join(profile, 'node_modules/surfcore'), process.platform === 'win32' ? 'junction' : 'dir');
  save(path.join(profile, 'package.json'), { name: 'a01-isolated-profile', private: true, dependencies: { surfcore: `link:${plugin.replaceAll('\\','/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','surfcore'] } } });
  const mcp = [['mcp-snowluma','snowluma','mcp-snowluma-safe.js'],['mcp-snowluma-host','snowluma-host','mcp-host-server.js'],['mcp-web-search-safe','web-search-safe','mcp-web-search-safe.js']].map(([id, serverName, script]) => ({ id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport: 'stdio', command: process.execPath, args: [path.join(repo, 'src', script)], toolCallTimeoutMs: 725000 } }));
  // Configure before Loader activation. Awaiting configEditor from a plugin's
  // apply() waits on the same Loader transaction and prevents routes becoming ready.
  save(path.join(profile, 'cordis.patch.yml'), [{ insert: [...mcp, { id: 'a01-native-host', name: pathToFileURL(path.join(here, 'a01-native-host.mjs')).href, config: {} }] }, { id: 'agent-default-model', config: selection }]); // JSON is valid YAML.
  const config = { dsh: { baseUrl: `http://127.0.0.1:${dshPort}`, ...selection }, snowluma: { wsUrl: onebot.wsUrl, httpUrl: onebot.baseUrl, followDiscoveredEndpoint: false, autoDiscover: false },
    ownerQQ: IDS.owner, admin: { qq: IDS.owner, name: '小禾' }, allow: { private: [IDS.owner, IDS.other], groups: [IDS.group_a, IDS.group_b] }, allowAllWhenEmpty: false,
    consolePort, consoleToken: controlToken, sessionCwd: path.join(trialDir, 'session-work'), persona: { file: path.join(repo, 'roles/a01-persona.md') },
    agentPreset: 'qq-chat', ackMessage: '', slang: { enabled: false }, purpose: { enabled: false }, greetings: { enabled: false }, chat: { proactive: { enabled: false } },
    biliBridge: { enabled: false, memory: { enabled: false }, dynamics: { enabled: false }, share: { enabled: false } }, socialV2: { voice: { enabled: false }, proactive: { enabled: false } } };
  save(path.join(repo, 'config.json'), config);
  fs.mkdirSync(path.join(repo, 'state'), { recursive: true }); save(path.join(repo, 'state/mode.json'), { mode: ['qc','p'].includes(scene.setup.channel) ? 'chat' : 'reserved2' });
  fs.mkdirSync(path.join(repo, 'roles'), { recursive: true }); fs.copyFileSync(personaFile, path.join(repo, 'roles/a01-persona.md'), fs.constants.COPYFILE_EXCL);
  save(path.join(env.DSH_HOME, 'surfcore/config.json'), { version: 1, qqbotRoot: repo, bridge: { autoStart: false }, updates: { enabled: false, checkOnStart: false }, platforms: { start: { qq: true, bili: false } }, pet: { chat: { enabled: true, remember: true } }, memoryCard: { enabled: true }, purpose: { enabled: false } });
  save(env.A01_TRIAL_CONFIG, { trialDir, repo, scene, trialId, version, selection, personaFile });
  return { env, selection, baseUrl: `http://127.0.0.1:${dshPort}`, config };
}
export async function stopOwned(child, label) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32') {
    // Only this still-owned child tree. No process-name or port based killing.
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  const complete = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
  if (!complete) throw fault('CLEANUP_FAILED', `${label} did not exit; stop the batch and inspect its recorded PID.`);
}
export function ownedHostReady(child, ready, expected) {
  return Boolean(child.pid && child.exitCode === null && child.signalCode === null && ready?.pid === child.pid && ready.observer && ready.trialId === expected.trialId && path.resolve(ready.repo) === path.resolve(expected.repo) && path.resolve(ready.home) === path.resolve(expected.home));
}
export function ownedBridgeReady(child, status, expected) {
  return Boolean(child.pid && child.exitCode === null && child.signalCode === null && expected.lockPid === child.pid && status?.dshReady && status.mode === expected.mode && status.root && path.resolve(status.root) === path.resolve(expected.repo) && status.dshBaseUrl?.replace(/\/$/, '') === expected.baseUrl);
}
export async function startNativeHost(args) {
  const { executable, cliEntry, trialDir } = args;
  if (!path.isAbsolute(executable) || !path.isAbsolute(cliEntry)) throw fault('DSH_RUNTIME_REQUIRED', 'Pass the installed Desktop executable and exact bundled cli.js entry.');
  const dshPort = await unusedPort(), consolePort = await unusedPort(), staged = stageHost({ ...args, dshPort, consolePort });
  const child = spawn(executable, ['--expose-internals', cliEntry, '--profile','web','--host','127.0.0.1','--port',String(dshPort),'--no-open'], { cwd: args.repo, env: { ...staged.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
  save(path.join(trialDir, 'dsh-process.json'), { pid: child.pid || null, executable, cliEntry, home: staged.env.DSH_HOME });
  let spawnedError = false;
  child.on('error', () => { spawnedError = true; });
  // Drain startup output without parsing or retaining login URLs/tokens.
  // Native bridge authentication reads its own isolated DSH_HOME as usual.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const request = async (op, params = {}, timeoutMs = 10000) => {
    const response = await fetch(loopback(staged.baseUrl) + '/a01-native/' + op, { method: 'POST', headers: { 'content-type': 'application/json', 'x-a01-control': args.controlToken }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json(); if (!response.ok || !data.ok) throw fault(data.code || 'HOST_REQUEST_FAILED', data.hint); return data.result;
  };
  try {
    const deadline = Date.now() + (args.startupTimeoutMs || 60000); let ready;
    while (Date.now() < deadline && child.exitCode === null && !spawnedError) {
      try { ready = await request('ready', {}, 1000); break; } catch { await delay(250); }
    }
    if (spawnedError || !ownedHostReady(child, ready, { ...args, home: staged.env.DSH_HOME })) throw fault('DSH_START_NOT_VERIFIED', 'Check profile/plugin loading and held child identity in this isolated trial; do not start the 120-run batch.');
    if (ready.selection.provider !== staged.selection.provider || ready.selection.model !== staged.selection.model) throw fault('MODEL_SELECTION_CHANGED');
    const asarEnd = cliEntry.toLowerCase().indexOf('.asar');
    const runtimeSource = asarEnd >= 0 ? cliEntry.slice(0, asarEnd + 5) : cliEntry;
    const stat = fs.statSync(runtimeSource);
    const attestation = { executableSha256: sha(fs.readFileSync(executable)), cliEntry, runtimeSource: { path: runtimeSource, size: stat.size, mtimeMs: stat.mtimeMs }, runtimeNode: ready.node, runnerNode: process.version, selection: staged.selection, isolation: true, observer: true };
    save(path.join(trialDir, 'host-attestation.json'), attestation);
    return { ...staged, consolePort, request, attestation, child, bridgeEnv: { ...staged.env, DSH_WEB_URL: staged.baseUrl }, async stop() { await stopOwned(child, 'DSH'); } };
  } catch (e) { await stopOwned(child, 'DSH startup'); throw e; }
}
