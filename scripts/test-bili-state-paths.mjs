/**
 * B站 工具链路径隔离：有角色时行为账本进角色包，凭证/表情包仍走账号目录。
 * 全部在临时 DSH_HOME 里跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-paths-'));
process.env.DSH_HOME = temp;
process.env.USERPROFILE = temp;
fs.mkdirSync(path.join(temp, 'surfcore', 'bili'), { recursive: true });

const store = await import('../src/character-persona.js');
const paths = await import(`../plugins/surfcore/tools/lib/state-paths.mjs?x=${Date.now()}`);

assert.equal(paths.biliStateDir(), path.join(temp, 'surfcore', 'bili'), '没有角色时回退账号目录');
assert.equal(paths.biliState('quota.json'), path.join(temp, 'surfcore', 'bili', 'quota.json'));
assert.equal(paths.accountBili('credentials.json'), path.join(temp, 'surfcore', 'bili', 'credentials.json'));

const character = store.createCharacter({ name: '角色甲', personaText: '# 卡' });
store.switchCharacter(character.character.id);
// state-paths 有 mtime 缓存；写指针后重新 import 一个新实例模拟新进程。
const paths2 = await import(`../plugins/surfcore/tools/lib/state-paths.mjs?x=${Date.now() + 1}`);
assert.equal(paths2.biliStateDir(), path.join(temp, 'surfcore', 'characters', character.character.id, 'bili'));
assert.equal(paths2.biliState('quota.json'), path.join(temp, 'surfcore', 'characters', character.character.id, 'bili', 'quota.json'));
assert.equal(paths2.accountBili('credentials.json'), path.join(temp, 'surfcore', 'bili', 'credentials.json'), '凭证不能进角色包');

// 真跑一条工具链命令：quota status 必须读角色自己的账本，而不是旧目录。
const today = new Date().toLocaleDateString('sv-SE');
fs.writeFileSync(paths2.biliState('quota.json'), JSON.stringify({
  date: today,
  log: [{ at: new Date().toISOString(), type: 'comment', target: 'BVtest', auto: true }],
}));
const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'plugins', 'surfcore', 'tools', 'bili.mjs'), 'quota', 'status'], {
  env: { ...process.env, DSH_HOME: temp, USERPROFILE: temp },
  encoding: 'utf8',
  timeout: 30_000,
});
assert.match(out, /共 1 条/, `工具没有读到角色账本：${out.slice(0, 300)}`);

// Separate Node processes avoid ESM/environment cache carrying paths across cases.
const fakeHome = path.join(temp, 'fake-user');
const isolatedHome = path.join(temp, 'isolated-profile');
const legacyConfig = path.join(fakeHome, '.dsh', 'surfcore', 'bili.config.json');
const isolatedConfig = path.join(isolatedHome, 'surfcore', 'bili.config.json');
const explicitConfig = path.join(temp, 'explicit-bili.json');
for (const [file, name] of [[legacyConfig, 'legacy-marker'], [isolatedConfig, 'isolated-marker'], [explicitConfig, 'explicit-marker']]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ persona: { name } }));
}
const configModule = pathToFileURL(path.join(import.meta.dirname, '..', 'plugins', 'surfcore', 'tools', 'lib', 'config.mjs')).href;
const inspectConfig = (env = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `const c=await import(${JSON.stringify(configModule)});const value=c.config();console.log(JSON.stringify({path:c.configPath,name:value.persona.name,hasUserFile:value.__hasUserFile}));`,
], { env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, DSH_HOME: '', SURFCORE_BILI_CONFIG: '', ...env }, encoding: 'utf8', timeout: 10000 }));
assert.deepEqual(inspectConfig({ DSH_HOME: isolatedHome, SURFCORE_BILI_CONFIG: explicitConfig }),
  { path: explicitConfig, name: 'explicit-marker', hasUserFile: true }, 'explicit override must beat DSH_HOME and legacy user profile');
assert.deepEqual(inspectConfig({ DSH_HOME: isolatedHome }),
  { path: isolatedConfig, name: 'isolated-marker', hasUserFile: true }, 'isolated home must never read default user configuration');
const emptyHome = path.join(temp, 'empty-profile');
assert.deepEqual(inspectConfig({ DSH_HOME: emptyHome }),
  { path: path.join(emptyHome, 'surfcore', 'bili.config.json'), name: '<角色名>', hasUserFile: false }, 'missing isolated config must use neutral defaults, never leak legacy user profile');
assert.deepEqual(inspectConfig(),
  { path: legacyConfig, name: 'legacy-marker', hasUserFile: true }, 'without environment overrides preserve original user-profile behavior');

try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
console.log('bili state paths tests OK');
