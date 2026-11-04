import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-confirmed-output-'));
process.env.DSH_HOME = path.join(temp, 'dsh');
const { CapabilitySupervisor } = await import('../plugins/surfcore/lib/local-capabilities/supervisor.js');
const { LocalCapabilities } = await import('../plugins/surfcore/lib/local-capabilities/facade.js');
const { createChannelHandler } = await import('../plugins/surfcore/lib/local-capabilities/channel.js');
const { createSemanticWriter } = await import('../plugins/surfcore/lib/local-capabilities/semantic-writer.js');
const { createPetChatService } = await import('../plugins/surfcore/lib/pet-chat.js');
const { createPetApiService } = await import('../plugins/surfcore/lib/pet-api.js');
const { LocalChannelBridge } = await import('../src/local-capabilities-bridge.js');
const supervisor = new CapabilitySupervisor({ python: path.join(root, '.venv/Scripts/python.exe'), entry: path.join(root, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'db'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
let role = { id: 'output-0', epoch: 1 }, persona = '合成人格', seq = 0, writer, bridge, pet, native, channel, base, reply = '我答应明天继续准备面试。';
let modelCalls = 0, commits = 0;
const llm = { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'synthetic', settingsPath: [] }],
  async prepareCall(config) { return { config, async *stream() { modelCalls++; yield { type: 'text-delta', text: '{"proposals":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }; },
  async *stream(options) { const writerCall = String(options.system).includes('记忆整理器'); if (writerCall) modelCalls++; yield { type: 'text-delta', text: writerCall ? '{"proposals":[]}' : reply }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
const ctx = { get(name) { if (name === 'llm') return llm; if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'synthetic' }) }; if (name === 'settings') return { describe: () => [{ ns: 'synthetic', applies: 'live', revision: 1, value: { baseURL: 'https://synthetic.invalid/v1' } }] }; if (name === 'launchEnvironment') return new Map(); } };
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'state.json'), currentCharacter: () => role });
const realRaw = supervisor.raw.bind(supervisor);
supervisor.raw = async (...args) => { if (args[0] === 'memory.assistant-output') commits++; return realRaw(...args); };
const keyFile = path.join(temp, 'channel.key');
const server = http.createServer((req, res) => { if (req.url === '/onebot') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 'native-confirmed' } })); return; } if (req.url.startsWith('/dsh-surfcore/pet-api')) void native.handle(req, res, new URL(req.url, base)); else void channel(req, res); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async test => { for (let i = 0; i < 300; i++) { if (await test()) return; await sleep(10); } throw Error('fixture deadline'); };
let checks = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++checks} ${name}`); };
async function reset({ automatic = false } = {}) {
  pet?.invalidateTransient(); await bridge?.dispose(); channel?.dispose(); writer?.dispose();
  role = { id: `output-${++seq}`, epoch: seq }; persona = '合成人格'; commits = 0; modelCalls = 0;
  await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  writer = createSemanticWriter({ ctx, capabilities: local, debounceMs: automatic ? 0 : 600000 }); local.semanticWriter = writer;
  channel = createChannelHandler({ capabilities: local, keyFile, getPersona: () => persona });
  bridge = new LocalChannelBridge({ config: () => ({ ownerQQ: '123', dsh: { baseUrl: base } }), currentCharacter: () => role, guarded: () => true, mode: () => 'local', keyFile, continuity: () => true });
  pet = createPetChatService({ ctx, capabilities: local, stateDir: path.join(temp, 'pet-' + seq) });
  native = createPetApiService({ chat: pet, stateDir: path.join(temp, 'pet-' + seq), currentDshUrl: () => base, petService: { status: () => ({}) } });
}
async function inbound(text = '明天面试要准备旧项目') {
  const event = { self_id: 999, user_id: 123, message_id: crypto.randomUUID() };
  const ticket = bridge.beginIncoming('private:123', event);
  try { await bridge.incoming('private:123', event, text); } finally { ticket?.finish?.(); }
}
async function prepare() { await inbound(); const id = crypto.randomUUID(); const original = persona; await bridge.prepare('private:123', id, '', original, { personaCheck: () => { if (persona !== original) throw Object.assign(Error('persona changed'), { code: 'STALE_PERSONA' }); } }); return id; }
async function send(id, text, result = 'sent') { return bridge.origin.run(bridge.sessions.get(id), () => bridge.send('private:123', async () => { if (result !== 'sent') throw Object.assign(Error(result), { code: 'DELIVERY_UNKNOWN' }); return { message_id: crypto.randomUUID() }; }, text)); }
async function outputs(channelValue = { kind: 'qq-private', account: '999', peer: '123' }) { return (await local.materials(channelValue)).records.filter(row => row.source_metadata.source_speaker.role === 'assistant'); }
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  await check('QQ confirmed ordered multi-bubble closes once under original lease with input and retrieval dependencies', async () => {
    await reset();
    const source = await local.ingest(await local.context({ kind: 'qq-private', account: '999', peer: '123' }), 'retrieval', '检索来源的具体旧事实', { actor: 'user', original: true });
    const id = await prepare(); await send(id, '第一条，记得旧事实。'); await send(id, '第二条，答应明天继续。');
    assert.equal((await outputs()).length, 0); assert.ok(writer.status().foreground > 0);
    const first = await bridge.completeOutput(id); assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(await bridge.completeOutput(id), first); assert.equal(commits, 1);
    const rows = await outputs(); assert.equal(rows.length, 1); assert.equal(rows[0].statement, '第一条，记得旧事实。\n\n第二条，答应明天继续。'); assert.ok(rows[0].derived_from.includes(source.id)); assert.equal(rows[0].derived_from.length, 2);
    assert.equal((await bridge.endSession(id)).ok, true);
    await local.management('memory.correct', { id: source.id, expected_revision: 1, statement: '纠正后的新事实' }); assert.equal((await outputs()).length, 0);
  });
  await check('partial unknown, failed, non-text and tool-localOnly outputs never store a normal utterance', async () => {
    for (const failure of ['unknown', 'missing-text', 'tool']) {
      await reset(); const id = await prepare(); await send(id, '已确认的第一气泡');
      if (failure === 'unknown') await assert.rejects(send(id, '不确定气泡', 'unknown'));
      if (failure === 'missing-text') await send(id, undefined);
      if (failure === 'tool') bridge.sessions.get(id).toolDelivery = true;
      assert.equal((await bridge.completeOutput(id)).skipped, true); assert.equal(commits, 0); assert.equal((await outputs()).length, 0);
      bridge.sessions.get(id).toolDelivery = false; await bridge.endSession(id);
    }
  });
  await check('new input, persona edit and original source correction cancel confirmed QQ memory without platform replay', async () => {
    for (const reason of ['input', 'persona', 'source']) {
      await reset(); const id = await prepare(); await send(id, '旧轮已送');
      if (reason === 'input') await inbound('后来的新输入');
      if (reason === 'persona') persona += '已修改';
      if (reason === 'source') { const row = (await local.context({ kind: 'qq-private', account: '999', peer: '123' })).records[0]; await local.management('memory.correct', { id: row.id, expected_revision: row.revision, statement: '已纠正输入' }); }
      const result = await bridge.completeOutput(id); if (reason === 'input') assert.deepEqual(result, { ok: true, skipped: true }); else { assert.equal(result.ok, false, reason + JSON.stringify(result)); assert.ok(result.code && result.hint); } assert.equal((await outputs()).length, 0); await bridge.endSession(id);
    }
  });
  await check('QQ facade final context-validation await retains original cancellation and role', async () => {
    for (const reason of ['input', 'role']) {
      await reset(); const id = await prepare(); await send(id, '最后等待已送内容');
      const original = supervisor.raw; let changed = false;
      supervisor.raw = async (...args) => { const value = await original(...args); if (!changed && args[0] === 'context.validate') { changed = true; if (reason === 'role') role = { ...role, epoch: role.epoch + 1 }; else { bridge.beginIncoming('private:123', { self_id: 999, user_id: 123, message_id: crypto.randomUUID() }); await sleep(30); } } return value; };
      try { const result = await bridge.completeOutput(id); assert.equal(result.ok, false); assert.ok(result.code && result.hint); assert.equal(commits, 0); } finally { supervisor.raw = original; await bridge.endSession(id); }
    }
  });
  await check('auto-write off skips entire QQ assistant body while normal confirmed delivery remains usable', async () => {
    await reset(); await local.management('memory.settings', { auto_write: false }); const id = await prepare(); await send(id, '关闭自动记忆仍正常发送');
    const result = await bridge.completeOutput(id); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.skipped, true); assert.equal(commits, 0); await bridge.endSession(id);
  });
  await check('real automatic Writer waits behind original QQ lease, commits only after output commit and cleanup', async () => {
    await reset({ automatic: true }); const holding = await local.beginTurn({ kind: 'qq-private', account: '999', peer: '123' });
    const id = await prepare(); local.endTurn(holding); await send(id, 'Writer屏障前的确认输出');
    const original = local.ingestConfirmedOutput.bind(local); let release, entered; const ready = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    local.ingestConfirmedOutput = async (...args) => { entered(); await gate; return original(...args); };
    const closing = bridge.completeOutput(id); await ready;
    const scope = writer.status().scopes[0].scopeId; await sleep(30); await assert.rejects(writer.flush(scope), error => error.code === 'WRITER_FOREGROUND_BUSY'); assert.equal(modelCalls, 0);
    release(); assert.equal((await closing).ok, true); local.ingestConfirmedOutput = original;
    assert.equal((await bridge.endSession(id)).ok, true); await waitFor(() => modelCalls === 1 && !writer.status().running).catch(error => { error.message += JSON.stringify(writer.status()); throw error; }); assert.equal(writer.status().lastError, null); assert.equal((await outputs()).length, 1);
  });
  await check('sent memory result and failed cleanup are independent, retry never writes or sends twice', async () => {
    await reset(); const id = await prepare(); await send(id, '已送且已保存的独立收尾');
    const memory = await bridge.completeOutput(id); assert.equal(memory.ok, true);
    const request = bridge.request.bind(bridge); let fail = true;
    bridge.request = async (...args) => { if (args[0] === 'turn.end' && fail) throw Object.assign(Error('synthetic cleanup failed'), { code: 'SERVICE_UNAVAILABLE' }); return request(...args); };
    const cleanup = await bridge.endSession(id); assert.equal(cleanup.ok, false); assert.ok(cleanup.code && cleanup.hint);
    assert.deepEqual(await bridge.completeOutput(id), memory); assert.equal(commits, 1); assert.equal((await outputs()).length, 1);
    fail = false; assert.equal((await bridge.endSession(id, { retry: true })).ok, true); assert.equal(commits, 1);
  });
  await check('confirmed QQ native OneBot HTTP bubbles are captured from exact successful payload', async () => {
    await reset(); const id = await prepare();
    const originalFetch = bridge.fetchImpl;
    bridge.fetchImpl = async (url, init) => { if (String(url).endsWith('/onebot')) return fetch(url, init); return originalFetch(url, init); };
    await bridge.origin.run(bridge.sessions.get(id), () => bridge.sendFetch('private:123', base + '/onebot', { method: 'POST', body: JSON.stringify({ message: [{ type: 'text', data: { text: '原生QQ回执正文' } }] }) }));
    assert.equal((await bridge.completeOutput(id)).ok, true); assert.equal((await outputs())[0].statement, '原生QQ回执正文'); await bridge.endSession(id);
  });
  await check('Pet native HTTP actual sent receipt commits once before release and retains assistant attribution', async () => {
    await reset(); const response = await fetch(base + '/dsh-surfcore/pet-api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': pet.token() }, body: JSON.stringify({ text: '明天要面试' }) });
    const value = await response.json(); assert.equal(value.ok, true, JSON.stringify(value));
    await waitFor(() => pet.status().chat.outputMemory); assert.equal(pet.status().chat.outputMemory.ok, true); assert.equal(commits, 1); assert.equal(writer.status().foreground, 0);
    const rows = await outputs({ kind: 'pet' }); assert.equal(rows.length, 1); assert.equal(rows[0].statement, reply); assert.equal(rows[0].source_metadata.statement_origin, 'confirmed_output');
    const source = rows[0].derived_from[0]; await local.management('memory.delete', { id: source, expected_revision: 1 }); assert.equal((await outputs({ kind: 'pet' })).length, 0);
  });
  await check('Pet failed/unknown, duplicate receipt, cancellation and disabled persistence do not invent output records', async () => {
    for (const mode of ['failed', 'unknown', 'cancel', 'off', 'duplicate']) {
      await reset(); if (mode === 'off') await local.management('memory.settings', { auto_write: false });
      const value = await pet.chat({ text: '合成普通输入' }); assert.equal(value.ok, true); assert.ok(writer.status().foreground > 0);
      if (mode === 'cancel') pet.invalidateTransient();
      await pet.finishDelivery(value, ['failed', 'unknown'].includes(mode) ? mode : 'sent');
      await pet.finishDelivery(value, 'sent');
      await waitFor(() => writer.status().foreground === 0);
      assert.equal((await outputs({ kind: 'pet' })).length, mode === 'duplicate' ? 1 : 0); assert.equal(commits, mode === 'duplicate' ? 1 : 0);
    }
  });
  await check('Pet remains foreground through the actual confirmation commit await', async () => {
    await reset(); const value = await pet.chat({ text: '等待确认收尾的普通输入' }); assert.equal(pet.activity().foreground, true);
    const original = local.ingestConfirmedOutput.bind(local); let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
    local.ingestConfirmedOutput = async (...args) => { entered(); await gate; return original(...args); };
    const finishing = pet.finishDelivery(value, 'sent'); await ready; assert.equal(pet.activity().foreground, true); assert.ok(writer.status().foreground > 0);
    release(); await finishing; local.ingestConfirmedOutput = original;
    assert.equal(pet.activity().foreground, false); assert.equal(writer.status().foreground, 0); assert.equal(commits, 1);
  });
  await check('Pet cleanup failure retains foreground and lease, retry clears only cleanup without duplicate commit', async () => {
    await reset(); const value = await pet.chat({ text: '原租约清理反例' });
    const end = local.endTurn.bind(local); let fail = true;
    local.endTurn = lease => { if (lease && fail) throw Object.assign(Error('synthetic cleanup failed'), { code: 'TURN_CLEANUP_FAILED', hint: '重试原清理' }); return end(lease); };
    try {
      await pet.finishDelivery(value, 'sent');
      assert.equal(pet.status().chat.outputMemory.ok, true); assert.equal(pet.status().chat.outputMemory.cleanup.ok, false); assert.equal(pet.activity().foreground, true); assert.ok(writer.status().foreground > 0); assert.equal(commits, 1);
      fail = false; await pet.invalidateTransient();
      assert.equal(pet.status().chat.outputMemory.cleanup.ok, true); assert.equal(pet.activity().foreground, false); assert.equal(writer.status().foreground, 0); assert.equal(commits, 1); assert.equal(pet.status().lastError, '');
    } finally { local.endTurn = end; }
  });
  await check('Pet stop at final commit await resolves all ignored native receipts, no unhandled rejection or write', async () => {
    await reset(); const value = await pet.chat({ text: '最后等待取消' });
    const original = local.ingestConfirmedOutput.bind(local); let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
    const unhandled = []; const observer = reason => unhandled.push(reason); process.on('unhandledRejection', observer);
    local.ingestConfirmedOutput = async (...args) => { entered(); await gate; return original(...args); };
    try {
      pet.finishDelivery(value, 'sent'); await ready;
      const stopping = pet.invalidateTransient(); assert.equal(pet.activity().foreground, true); release(); await stopping; await sleep(20);
      assert.deepEqual(unhandled, []); assert.equal(commits, 0); assert.equal(pet.activity().foreground, false); assert.equal(writer.status().foreground, 0); assert.equal(pet.status().chat.outputMemory.ok, false);
    } finally { local.ingestConfirmedOutput = original; process.off('unhandledRejection', observer); }
  });
  await check('Pet final original validation await rejects role/input/source changes and exposes independent memory failure', async () => {
    for (const mode of ['role', 'input', 'source']) {
      await reset(); const value = await pet.chat({ text: '原轮输入等待收尾' });
      const original = supervisor.raw; let changed = false;
      supervisor.raw = async (...args) => {
        const result = await original(...args);
        if (!changed && args[0] === 'context.validate') {
          changed = true;
          if (mode === 'role') role = { ...role, epoch: role.epoch + 1 };
          if (mode === 'input') await pet.chat({ text: '后来的真实普通入站' });
          if (mode === 'source') { const rows = (await realRaw('memory.query', args[1], {})).memories; await local.management('memory.correct', { id: rows[0].id, expected_revision: rows[0].revision, statement: '纠正原来源' }); }
        }
        return result;
      };
      try { await pet.finishDelivery(value, 'sent'); assert.equal(pet.status().chat.outputMemory.ok, false); assert.ok(pet.status().chat.outputMemory.code && pet.status().chat.outputMemory.hint); assert.equal(commits, 0); }
      finally { supervisor.raw = original; }
    }
  });
  console.log(`PASS ${checks} confirmed assistant-output groups; real SQLCipher/QQ-host/Pet-HTTP/Writer; ${temp}`);
} finally { pet?.invalidateTransient(); await bridge?.dispose(); channel?.dispose(); writer?.dispose(); await new Promise(resolve => server.close(resolve)); await supervisor.stop(); }
