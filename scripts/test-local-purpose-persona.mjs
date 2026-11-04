import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
const repo = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-purpose-persona-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const { CapabilitySupervisor } = await import('../plugins/surfcore/lib/local-capabilities/supervisor.js');
const { LocalCapabilities } = await import('../plugins/surfcore/lib/local-capabilities/facade.js');
const { createSemanticWriter } = await import('../plugins/surfcore/lib/local-capabilities/semantic-writer.js');
const { createChannelHandler } = await import('../plugins/surfcore/lib/local-capabilities/channel.js');
const { LocalChannelBridge } = await import('../src/local-capabilities-bridge.js');
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
const { buildPersonaIdentity } = await import('../src/persona-identity.js');
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'),
  dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
const role = { id: 'persona-role', epoch: 1 };
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => role });
let expectedPersona = '';
const writer = createSemanticWriter({ capabilities: local, debounceMs: 600000 }); local.semanticWriter = writer;
const keyFile = path.join(temp, 'channel.key'), channel = createChannelHandler({ capabilities: local, keyFile, getPersona: () => expectedPersona });
const server = http.createServer((req, res) => void channel(req, res));
const coreFile = path.join(temp, 'persona.md');
fs.writeFileSync(coreFile, '# SCENE_FIXTURE\nCORE_COMMON\n## Only one 〔一代〕\nCORE_V1\n## Only two 〔二代〕\nCORE_V2');
let daily = 'DAILY_CURRENT', privateScene = 'PRIVATE_SCENE', groupScene = 'GROUP_SCENE', identitySuffix = '';
let h, base, eventNo = 0, count = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++count} ${name}`); };
async function harness(mode) {
  await h?.localChannels.dispose(); await h?.close();
  const config = () => ({ ownerQQ: '123', dsh: { baseUrl: base } });
  class FixtureBridge extends LocalChannelBridge {
    constructor(options) { super({ ...options, config, keyFile, currentCharacter: () => role, guarded: () => true, mode: () => 'local',
      fetchImpl: (url, init) => {
        if (new URL(url).pathname === '/send_private_msg') return Promise.resolve(new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 'synthetic-native' } }), { status: 200 }));
        assert.ok(String(url).startsWith(base), 'no external transport'); return fetch(url, init); } }); }
  }
  h = await bridgeHarness({ config: { sendDelayMs: 0, biliBridge: { enabled: false } }, globals: {
    __auditMuxOnce: true, LocalChannelBridge: FixtureBridge, localBackendGuarded: () => true, localBackendMode: () => 'local',
    readCurrentCharacter: () => role, activePersonaFile: () => coreFile,
    readPersonaLayerText: (layer, scene) => layer === 'core' ? fs.readFileSync(coreFile, 'utf8') :
      layer === 'tone' ? 'TONE_CURRENT' : layer === 'daily' ? daily : scene === 'qq-private' ? privateScene : scene === 'qq-group' ? groupScene : '',
    buildPersonaIdentity: value => buildPersonaIdentity(value) + identitySuffix,
  } });
  h.setMode(mode);
}
async function inbound(key) {
  const event = { self_id: 999, user_id: 123, group_id: 456, message_id: ++eventNo };
  const ticket = h.localChannels.beginIncoming(key, event);
  try { await h.localChannels.incoming(key, event, 'CURRENT_ORIGINAL_INPUT'); } finally { ticket?.finish?.(); }
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  await check('actual local private wrapper includes current core/daily/private-scene/identity and v1 filtering', async () => {
    await harness('chat'); await inbound('private:123');
    await h.deliverPrompt('private:123', 'LEGACY_HISTORY_AND_DIARY_SECRET');
    const prompt = h.calls.prompts.at(-1).content[0].text;
    for (const marker of ['CORE_COMMON', 'CORE_V1', 'TONE_CURRENT', 'DAILY_CURRENT', 'PRIVATE_SCENE', 'SCENE_FIXTURE', '身份底座', 'CURRENT_ORIGINAL_INPUT']) assert.ok(prompt.includes(marker), marker);
    assert.doesNotMatch(prompt, /CORE_V2|GROUP_SCENE|LEGACY_HISTORY_AND_DIARY_SECRET/);
  });
  await check('actual group wrapper selects tone/group scene and reserved2 mode', async () => {
    await harness('reserved2'); await inbound('group:456'); await h.deliverPrompt('group:456', 'LEGACY_GROUP_DIARY');
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.match(prompt, /TONE_CURRENT/); assert.match(prompt, /GROUP_SCENE/); assert.match(prompt, /DAILY_CURRENT/); assert.match(prompt, /身份底座/);
    assert.doesNotMatch(prompt, /PRIVATE_SCENE|CORE_COMMON|LEGACY_GROUP_DIARY/);
  });
  await check('daily, scene and identity edits during real source RPC cancel original prepare before SDK prompt', async () => {
    for (const layer of ['daily', 'scene', 'identity']) {
      await harness('chat'); await inbound('private:123');
      const raw = supervisor.raw.bind(supervisor); let changed = false;
      supervisor.raw = async (...args) => {
        const result = await raw(...args);
        if (!changed && args[0] === 'context.validate') {
          changed = true;
          if (layer === 'daily') daily += '-CHANGED';
          if (layer === 'scene') privateScene += '-CHANGED';
          if (layer === 'identity') identitySuffix += '-CHANGED';
        }
        return result;
      };
      try {
        await assert.rejects(h.deliverPrompt('private:123', 'LEGACY_UNUSED'), error => error.code === 'STALE_PERSONA' && Boolean(error.hint));
        assert.equal(changed, true); assert.equal(h.calls.prompts.length, 0);
      } finally { supervisor.raw = raw; }
    }
  });
  await check('actual normal QQ turn/end wrapper sends then commits assistant closure before native cleanup', async () => {
    await harness('chat'); await inbound('private:123'); await h.deliverPrompt('private:123', 'unused');
    const prompt = h.calls.prompts.at(-1); expectedPersona = prompt.content[0].text.split('\n【工具会话 key】')[0];
    h.api.events.mux = async function* () {
      for (const event of [{ type: 'turn/start', data: { turn: 1 } },
        { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '原生普通QQ已确认承诺。' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
        yield { payload: { type: 'session/event', sessionId: prompt.sessionId, event } };
    };
    await h.pumpMux();
    const output = (await local.materials({ kind: 'qq-private', account: '999', peer: '123' })).records.find(row => row.statement === '原生普通QQ已确认承诺。');
    assert.ok(output, JSON.stringify(await h.localChannels.sessions.get(prompt.sessionId)?.outputCommit));
    assert.equal(output.source_metadata.statement_origin, 'confirmed_output'); assert.ok(output.derived_from.length);
    assert.equal(h.localChannels.cleanupStatus().ok, true); assert.equal(writer.status().foreground, 0);
  });
  console.log(`PASS ${count} actual local persona wrapper groups; fixture ${temp}`);
} finally { await h?.localChannels.dispose(); await h?.close(); await new Promise(resolve => server.close(resolve)); writer.dispose(); await supervisor.stop(); }
