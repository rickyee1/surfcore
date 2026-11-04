import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createBiliPublicReader, subtitleUrl } from '../lib/bili-public-reader.js';
import { createAutonomousCompanion, createCompanionHandler } from '../lib/autonomous-companion.js';
import { createChannelHandler } from '../lib/local-capabilities/channel.js';
import { CapabilitySupervisor } from '../lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../lib/local-capabilities/facade.js';
import { LocalChannelBridge } from '../../../src/local-capabilities-bridge.js';
import { bridgeHarness } from '../../../scripts/audit-bridge-harness.mjs';
const repo = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-companion-'));
let count = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++count} ${name}`); };
const rejects = (work, code) => assert.rejects(work, e => e.code === code && Boolean(e.hint));
const bv = 'BV1xx411c7mD';
const metadata = { bvid: bv, title: '公开研究主题', desc: '公开简介材料', owner: { name: '公开作者' }, cid: 321 };
const net = [];
const publicFetch = async (url, options) => {
  net.push({ url: String(url), options }); const u = new URL(url);
  let body;
  if (u.pathname.endsWith('/popular')) body = { code: 0, data: { list: [metadata] } };
  else if (u.pathname.endsWith('/view')) body = { code: 0, data: metadata };
  else if (u.pathname.endsWith('/nav')) body = { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/' + 'b'.repeat(32) + '.png' } } };
  else if (u.pathname.endsWith('/v2')) body = { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/fixture.json?auth_key=FAKE_SIGNED_URL' }] } } };
  else body = { body: [{ content: '官方字幕正文。' }] };
  return new Response(JSON.stringify(body));
};
await check('public feed/read uses pure selection, fixed GETs and bounded official subtitle sources only', async () => {
  const reader = createBiliPublicReader({ fetchImpl: publicFetch });
  assert.equal((await reader.feed())[0].bvid, bv);
  assert.deepEqual(await reader.feed({ exclude: [bv] }), []);
  const source = await reader.read(bv); assert.equal(source.subtitleStatus, 'available'); assert.match(source.basis, /官方字幕/);
  assert.ok(net.every(x => x.options.method === 'GET' && x.options.credentials === 'omit' && x.options.redirect === 'error' && !x.options.headers.cookie && !x.options.headers.authorization));
  assert.ok(net.every(x => ['api.bilibili.com', 'aisubtitle.hdslb.com'].includes(new URL(x.url).hostname)));
  for (const url of ['http://aisubtitle.hdslb.com/bfs/subtitle/a', 'https://evil.invalid/a', 'https://aisubtitle.hdslb.com.evil/bfs/subtitle/a', 'https://u:p@aisubtitle.hdslb.com/bfs/subtitle/a', 'https://aisubtitle.hdslb.com:444/bfs/subtitle/a', 'https://aisubtitle.hdslb.com/private/a']) assert.throws(() => subtitleUrl(url));
  const unsafe = createBiliPublicReader({ fetchImpl: async (url, opts) => String(url).includes('/v2?') ? new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ subtitle_url: 'https://evil.invalid/cookie' }] } } })) : publicFetch(url, opts) });
  assert.equal((await unsafe.read(bv)).subtitleStatus, 'unavailable');
  assert.ok(!net.some(x => x.url.includes('evil.invalid')));
  await rejects(createBiliPublicReader({ fetchImpl: async () => new Response('x'.repeat(600000)) }).feed(), 'BILI_PUBLIC_UNAVAILABLE');
  await rejects(createBiliPublicReader({ fetchImpl: () => new Promise(() => {}), timeoutMs: 10 }).feed(), 'BILI_PUBLIC_TIMEOUT');
});

let sequence = 0; let character = { id: 'companion-0', epoch: 1 };
const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(temp, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
const local = new LocalCapabilities({ supervisor, stateFile: path.join(temp, 'backend.json'), currentCharacter: () => character });
const keyFile = path.join(temp, 'channel.key');
const channel = createChannelHandler({ capabilities: local, keyFile });
const server = http.createServer((req, res) => void channel(req, res));
const services = [];
let adapter; let sends = []; let modelCalls = []; let modelHook = null; let finish = 'stop'; let delivery = 'sent'; let env; let config; let gateHook = null;
const source = { bvid: bv, title: metadata.title, author: metadata.owner.name, description: metadata.desc, subtitle: '官方字幕正文。', subtitleStatus: 'available', url: `https://www.bilibili.com/video/${bv}`, basis: '标题、简介与官方字幕；未观看画面。' };
const reader = { feed: async ({ exclude = [] } = {}) => exclude.includes(bv) ? [] : [{ bvid: bv }], read: async () => source };
const llm = {
  listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'fixture', settingsPath: [] }],
  async prepareCall(config) { return { config, async *stream(options) {
    modelCalls.push(options); if (modelHook) await modelHook(modelCalls.length);
    const isPublic = options.system.startsWith('只依据给定公开材料');
    const input = JSON.parse(options.messages[0].content[0].text);
    const decision = input.materials?.some(item => item.kind === 'video' || item.kind === 'owner')
      ? { decision: 'send', text: '刚逛到一个主题，想和你聊聊字幕里的这个想法。', pending: 'none' } : { decision: 'skip' };
    yield { type: 'text-delta', text: isPublic ? '从字幕看，这个想法值得琢磨。' : JSON.stringify(decision) };
    if (finish) yield { type: 'finish', reason: { kind: finish } };
  } }; },
};
const ctx = { get(name) {
  if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'fixture' }) };
  if (name === 'llm') return llm;
  if (name === 'launchEnvironment') return new Map();
  if (name === 'settings') return { describe: () => [{ ns: 'fixture', applies: 'live', revision: 1, value: { baseURL: 'https://fixture.invalid/v1' } }] };
} };
const stateDir = path.join(temp, 'coordinator');
const callBridge = async (pathname, options) => {
  if (pathname.endsWith('/readiness')) return { ok: true, data: { ok: true, ready: true, activity: adapter.activity(adapter.channels.get('private:123')), ownerIdleMs: 100000000 } };
  assert.equal(pathname, '/api/companion/deliver'); assert.deepEqual(Object.keys(options.body), ['intentId']);
  try {
    const result = await adapter.withIntent(options.body.intentId, { guard: async trusted => { assert.equal(trusted.peer, '123'); if (!env.platformEnabled || env.focused || !env.roleActive) throw Object.assign(new Error('paused'), { code: 'COMPANION_PAUSED' }); }, deliver: async () => {
      const record = adapter.origin.getStore();
      if (gateHook) await gateHook(record);
      const res = await adapter.sendFetch('private:123', 'http://onebot.invalid/send_private_msg', { method: 'POST' });
      return (await res.json()).data;
    } });
    return { ok: true, data: { ok: true, delivery: { messageId: result?.message_id } } };
  } catch (e) { return { ok: false, data: { ok: false, code: e.code, attempted: e.transportAttempted === true, error: e.message, hint: e.hint || '本轮不会重发。' } }; }
};
function service(extra = {}) {
  const item = createAutonomousCompanion({ ctx, capabilities: local, channelHandler: channel, stateDir, callBridge, environment: () => env, persona: () => ({ ...character, revision: 1, text: '现有角色语气' }), purposeConfig: () => ({ quietStart: '00:00', quietEnd: '00:00', idleThresholdMs: 0, dailyMax: 4 }), reader, ...extra }); services.push(item); return item;
}
async function reset() {
  for (const item of services.splice(0)) item.dispose();
  sequence++; character = { id: `companion-${sequence}`, epoch: sequence + 1 }; await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
  await local.management('attention.configure', { enabled: true, daily_limit: 4, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC', muted: false, focused: false });
  const owner = await local.context({ kind: 'qq-private', account: '999', peer: '123', principal: '123' }); await local.ingest(owner, 'owner-private', 'OWNER_PRIVATE_MARKER');
  sends = []; modelCalls = []; modelHook = null; finish = 'stop'; delivery = 'sent'; gateHook = null;
  env = { roleActive: true, platformEnabled: true, focused: false, paused: false };
  config = { ownerQQ: '123', dsh: { baseUrl: `http://127.0.0.1:${server.address().port}` } };
  adapter = new LocalChannelBridge({ config: () => config, guarded: () => true, mode: () => local.mode, keyFile, fetchImpl: async (url, options) => {
    if (new URL(url).hostname !== 'onebot.invalid') return fetch(url, options);
    sends.push({ url, options }); if (delivery === 'unknown') throw new Error('fixture network lost');
    return new Response(JSON.stringify(delivery === 'failed' ? { status: 'failed', retcode: 16 } : { status: 'ok', retcode: 0, data: { message_id: 'fixture-receipt' } }));
  } });
  adapter.channels.set('private:123', { kind: 'qq-private', account: '999', peer: '123', principal: '123' });
  adapter.beginIncoming('private:123', { self_id: 999, user_id: 123, message_id: 'initial' }).finish();
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  for(const input of ['', 'synthetic new input'])await check('bridge-only restart rejects old rev1 intent; new round sends: '+JSON.stringify(input),async()=>{
    await reset();await local.management('memory.settings',{auto_write:false});const item=service();await item.configure({enabled:true});const issue=channel.issueIntent;let oldActivity,newActivity,oldIntent;
    channel.issueIntent=async(...args)=>{
      const intent=await issue(...args);oldIntent=intent;const previous=adapter;oldActivity=previous.activity(previous.channels.get('private:123'));
      adapter=new LocalChannelBridge({config:()=>config,guarded:()=>true,mode:()=>local.mode,keyFile,fetchImpl:previous.fetchImpl,currentCharacter:previous.currentCharacter});
      const event={self_id:999,user_id:123,message_id:'AFTER_RESTART'},ticket=adapter.beginIncoming('private:123',event);
      try{if(input)await adapter.incoming('private:123',event,input);else await rejects(adapter.incoming('private:123',event,input),'INVALID_REQUEST')}finally{ticket.finish()}
      newActivity=adapter.activity(adapter.channels.get('private:123'));return intent;
    };
    try{await rejects(item.run(),'COMPANION_ACTIVITY_CHANGED');assert.equal(sends.length,0);assert.equal(oldActivity.revision,1);assert.equal(newActivity.revision,1);assert.notEqual(oldActivity.epoch,newActivity.epoch);assert.equal(newActivity.foreground,false);
      await rejects(adapter.withIntent(oldIntent,{guard:async()=>{},deliver:async()=>{throw Error('old body revived')}}),'COMPANION_INTENT_INVALID');
    }finally{channel.issueIntent=issue}
    item.dispose();
    // A fresh coordinator round uses new evidence and the new instance snapshot;
    // advance only the scheduler clock past the preserved 90 minute cooldown.
    const newBv='BV2xx411c7mD';const fresh=service({now:()=>Date.now()+91*60000,reader:{feed:async()=>[{bvid:newBv}],read:async()=>({...source,bvid:newBv,url:'https://www.bilibili.com/video/'+newBv})}});
    assert.equal((await fresh.run()).outcome,'sent');assert.equal(sends.length,1);
  });

  for(const phase of ['claim-response','final-validation','final-response'])await check('restart across '+phase+' retains host snapshot and retires old bridge origin',async()=>{
    await reset();await local.management('memory.settings',{auto_write:false});const item=service();await item.configure({enabled:true});const originalAdapter=adapter,request=adapter.request.bind(adapter);let switched=false,reserved=false,oldRecord;
    const restart=async()=>{
      switched=true;const previous=adapter,oldActivity=previous.activity(previous.channels.get('private:123'));oldRecord=previous.origin.getStore();
      adapter=new LocalChannelBridge({config:()=>config,guarded:()=>true,mode:()=>local.mode,keyFile,fetchImpl:previous.fetchImpl,currentCharacter:previous.currentCharacter});
      const event={self_id:999,user_id:123,message_id:'LATE_RESTART'},ticket=adapter.beginIncoming('private:123',event);
      try{await adapter.incoming('private:123',event,'later synthetic input')}finally{ticket.finish()}
      const fresh=adapter.activity(adapter.channels.get('private:123'));assert.equal(fresh.revision,oldActivity.revision);assert.notEqual(fresh.epoch,oldActivity.epoch);
      // A dead process cannot send. Its in-process equivalent explicitly retires
      // the old adapter after the final RPC has already returned.
      if(phase==='final-response')previous.invalidate();
    };
    originalAdapter.request=async(action,...args)=>{
      if(phase==='final-validation'&&reserved&&action==='validate'&&!switched)await restart();
      const result=await request(action,...args);
      if(action==='attention.reserve')reserved=true;
      if(!switched&&((phase==='claim-response'&&action==='intent.claim')||(phase==='final-response'&&action==='attention.check'&&args[1]?.params?.reservation_id)))await restart();
      return result;
    };
    await assert.rejects(item.run(),e=>['COMPANION_ACTIVITY_CHANGED','BINDING_INVALID'].includes(e.code)&&!!e.hint);assert.equal(switched,true);assert.equal(sends.length,0);
    if(phase==='final-response'){assert.ok(oldRecord);assert.throws(()=>originalAdapter.assertRecord(oldRecord));assert.equal(originalAdapter.sessions.size,0);}
  });
  await check('default disabled; preview reads public materials without models, persistence or sending', async () => {
    await reset(); const item = service(); assert.equal((await item.status()).config.enabled, false);
    await rejects(item.run(), 'COMPANION_DISABLED'); const result = await item.preview(); assert.equal(result.modelCalled, false); assert.equal(result.sends, false); assert.equal(sends.length, 0); assert.equal(modelCalls.length, 0);
  });
  await check('public research -> persisted sources -> purpose -> owner text -> real intent/attention/receipt chain', async () => {
    await reset(); const item = service(); await item.configure({ enabled: true });
    const result = await item.run(); assert.equal(result.outcome, 'sent'); assert.equal(result.delivery.messageId, 'fixture-receipt'); assert.equal(sends.length, 1);
    assert.equal(modelCalls.length, 2); assert.ok(!JSON.stringify(modelCalls[0]).includes('OWNER_PRIVATE_MARKER')); assert.doesNotMatch(JSON.stringify(modelCalls[1]), /OWNER_PRIVATE_MARKER/); assert.match(JSON.stringify(modelCalls[1]), /现有角色语气/);
    for (const call of modelCalls) { assert.equal(call.tools, undefined); assert.ok([1000, 1800].includes(call.maxTokens)); assert.equal(call.reasoningEffort, 'off'); assert.ok(!JSON.stringify(call).includes('FAKE_SECRET')); }
    assert.match(modelCalls[0].messages[0].content[0].text, /官方字幕/);
    const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public', principal: 'public' }); assert.match(pub.text, /从字幕看/); assert.doesNotMatch(pub.text, /OWNER_PRIVATE/);
    const records = fs.readdirSync(stateDir).filter(x => x.endsWith('.state.json')).map(x => fs.readFileSync(path.join(stateDir, x), 'utf8')).join(''); assert.doesNotMatch(records, /OWNER_PRIVATE_MARKER|刚逛到一个主题/);
    await local.management('attention.configure', { cooldown_seconds: 5400 });
    await rejects(item.run(), 'ATTENTION_BLOCKED'); assert.equal(sends.length, 1);
  });
  await check('max-tokens and missing finish never dispatch partial research', async () => {
    for (const kind of ['max-tokens', null, 'tool-calls']) {
      await reset(); const item = service(); await item.configure({ enabled: true }); finish = kind;
      await rejects(item.run(), 'FIXED_MODEL_INCOMPLETE'); assert.equal(sends.length, 0);
    }
  });
  await check('same-character cross-instance lock prevents parallel generation and duplicate sends', async () => {
    await reset(); const a = service(); const b = service(); await a.configure({ enabled: true });
    let release; const gate = new Promise(resolve => { release = resolve; }); modelHook = async n => { if (n === 1) await gate; };
    const first = a.run(); while (!modelCalls.length) await new Promise(resolve => setTimeout(resolve, 2));
    await rejects(b.run(), 'COMPANION_BUSY'); release(); await first; assert.equal(sends.length, 1);
  });
  await check('quiet/focus/global attention daily budget block before public research or model cost', async () => {
    for (const params of [{ focused: true }, { daily_limit: 0 }, { quiet_start: '00:00', quiet_end: '00:00' }]) {
      await reset(); const item = service(); await item.configure({ enabled: true }); await local.management('attention.configure', params);
      await rejects(item.run(), params.quiet_start ? 'COMPANION_PAUSED' : 'ATTENTION_BLOCKED'); assert.equal(modelCalls.length, 0); assert.equal(sends.length, 0);
    }
  });
  await check('correction/deletion during owner generation invalidates original dual contexts without refreshing them', async () => {
    for (const op of ['memory.correct', 'memory.delete']) {
      await reset(); const item = service(); await item.configure({ enabled: true });
      modelHook = async n => { if (n === 2) { const found = await local.management('memory.query', { query: 'OWNER_PRIVATE_MARKER' }); const row = found.memories[0]; await local.management(op, { id: row.id, expected_revision: row.revision, ...(op.endsWith('correct') ? { statement: 'UPDATED_OWNER' } : {}) }); } };
      await rejects(item.run(), 'STALE_CONTEXT'); assert.equal(sends.length, 0);
    }
  });
  await check('concurrent correction after an allowed write cannot be blessed by the later context refresh', async () => {
    await reset(); const item = service(); await item.configure({ enabled: true }); const ingest = local.ingest.bind(local);
    local.ingest = async (...args) => { const result = await ingest(...args); if (args[1].includes(':thought:')) { const query = await local.management('memory.query', { query: 'OWNER_PRIVATE_MARKER' }); const record = query.memories[0]; await local.management('memory.correct', { id: record.id, expected_revision: record.revision, statement: 'UPDATED_DURING_REFRESH' }); } return result; };
    try { await rejects(item.run(), 'STALE_CONTEXT'); assert.equal(modelCalls.length, 1); assert.equal(sends.length, 0); } finally { local.ingest = ingest; }
  });
  await check('auto-write disabled permits fresh bounded research without falsely claiming persistence', async () => {
    await reset(); const item = service(); await item.configure({ enabled: true }); await local.management('memory.settings', { auto_write: false });
    await item.run(); assert.equal((await item.status()).reader.materialStored, false); assert.equal((await item.status()).reader.thoughtStored, false); assert.equal(sends.length, 1);
    await local.management('memory.settings', { auto_write: true });
  });
  await check('thought carries authoritative material revision proofs; deleting or correcting material invalidates it', async () => {
    for (const operation of ['memory.delete', 'memory.correct']) {
      await reset(); const item = service(); await item.configure({ enabled: true }); await item.run();
      const rows = (await local.management('memory.query', {})).memories;
      const material = rows.find(row => row.statement.includes('公开简介材料')); const thought = rows.find(row => row.statement.includes('从字幕看'));
      assert.deepEqual(thought.derived_from, [material.id]); assert.deepEqual(thought.source_revisions, { [material.id]: material.revision });
      await local.management(operation, { id: material.id, expected_revision: material.revision, ...(operation.endsWith('correct') ? { statement: '仅当前已更正来源' } : {}) });
      const future = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); assert.doesNotMatch(future.text, /从字幕看/);
      const after = await local.management('memory.detail', { id: thought.id }); assert.notEqual(after.memory.status, 'active');
    }
  });
  await check('auto-write off never exempts deleted or suspended stable material events', async () => {
    for (const operation of ['memory.delete', 'memory.suspend']) {
      await reset(); const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' });
      const saved = await local.ingest(pub, `bili:public:${bv}:material`, '旧资料不能重新使用');
      await local.management(operation, { id: saved.id, expected_revision: 1 }); await local.management('memory.settings', { auto_write: false });
      const item = service(); await item.configure({ enabled: true }); await rejects(item.run(), 'COMPANION_SOURCE_UNAVAILABLE'); assert.equal(modelCalls.length, 0); assert.equal(sends.length, 0);
      await local.management('memory.settings', { auto_write: true });
    }
  });
  await check('cross-scope deleted stable event is still blocked with auto-write off, without widening source lookup', async () => {
    await reset(); const event = `bili:public:${bv}:material`; const owner = await local.context(adapter.channels.get('private:123'));
    const saved = await local.ingest(owner, event, 'PRIVATE_DELETED_SOURCE_COPY'); await local.management('memory.delete', { id: saved.id, expected_revision: 1 }); await local.management('memory.settings', { auto_write: false });
    const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const result = await local.supervisor.raw('context.sources', pub.binding, { source_event_ids: [event] });
    assert.deepEqual(result.sources, [{ source_event_id: event, status: 'missing' }]);
    const item = service(); await item.configure({ enabled: true }); await rejects(item.run(), 'DELETED_SOURCE'); assert.equal(modelCalls.length, 0); assert.equal(sends.length, 0);
    await local.management('memory.settings', { auto_write: true });
  });
  await check('missing from an invisible ancestor is not proof a material was never persisted', async () => {
    await reset(); let pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const parent = await local.ingest(pub, 'parent-source', 'ancestor');
    pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); await local.ingest(pub, `bili:public:${bv}:material`, 'dependent material', { derivedFrom: [{ id: parent.id, revision: 1 }] });
    await local.management('memory.suspend', { id: parent.id, expected_revision: 1 }); await local.management('memory.settings', { auto_write: false });
    pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const lookup = await local.supervisor.raw('context.sources', pub.binding, { source_event_ids: [`bili:public:${bv}:material`] }); assert.equal(lookup.sources[0].status, 'missing');
    const item = service(); await item.configure({ enabled: true }); await assert.rejects(item.run(), error => Boolean(error.code && error.hint)); assert.equal(modelCalls.length, 0); assert.equal(sends.length, 0);
    await local.management('memory.settings', { auto_write: true });
  });
  await check('finite source matrix: other-scope/quarantine requires persistence; enabled per-scope archival stays legal', async () => {
    for (const kind of ['other-scope', 'quarantine']) for (const enabled of [false, true]) {
      await reset(); const event = `bili:public:${bv}:material`;
      if (kind === 'other-scope') await local.ingest(await local.context(adapter.channels.get('private:123')), event, 'OTHER_SCOPE_PRIVATE_BODY');
      else await local.management('memory.migrate', { migration_id: 'quarantine-matrix', records: [{ source_event_id: event, text: 'QUARANTINED_OLD_BODY', source_refs: [`event:${event}`], status: 'active' }] });
      await local.management('memory.settings', { auto_write: enabled });
      const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const before = await local.supervisor.raw('context.sources', pub.binding, { source_event_ids: [event] });
      assert.deepEqual(before.sources, [{ source_event_id: event, status: 'missing' }]);
      const item = service(); await item.configure({ enabled: true });
      if (!enabled) { await rejects(item.run(), 'PERMISSION_DENIED'); assert.equal(modelCalls.length, 0); assert.equal(sends.length, 0); }
      else { await item.run(); assert.equal(sends.length, 1); assert.doesNotMatch(JSON.stringify(modelCalls[0]), /OTHER_SCOPE_PRIVATE_BODY|QUARANTINED_OLD_BODY/); const after = await local.supervisor.raw('context.sources', (await local.context({ kind: 'bili', account: 'public', peer: 'public' })).binding, { source_event_ids: [event] }); assert.equal(after.sources[0].status, 'active'); }
      await local.management('memory.settings', { auto_write: true });
    }
  });
  await check('same stable event deleted in another character does not widen or block this character', async () => {
    await reset(); const event = `bili:public:${bv}:material`; const saved = await local.ingest(await local.context({ kind: 'bili', account: 'public', peer: 'public' }), event, 'OTHER_CHARACTER_RETIRED_BODY'); await local.management('memory.delete', { id: saved.id, expected_revision: 1 });
    character = { id: `${character.id}-other-role`, epoch: character.epoch + 1 }; await local.setMode('local'); await local.setQqOwner({ account: '999', peer: '123' });
    await local.management('attention.configure', { enabled: true, daily_limit: 4, cooldown_seconds: 0, quiet_start: '', quiet_end: '', timezone: 'UTC', muted: false, focused: false }); await local.management('memory.settings', { auto_write: false });
    const item = service(); await item.configure({ enabled: true }); await item.run(); assert.equal(sends.length, 1); assert.doesNotMatch(JSON.stringify(modelCalls), /OTHER_CHARACTER_RETIRED_BODY/); assert.equal((await item.status()).reader.materialStored, false);
    await local.management('memory.settings', { auto_write: true });
  });
  await check('stored active material uses its corrected current body, without other unproven public context', async () => {
    await reset(); let pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' });
    const saved = await local.ingest(pub, `bili:public:${bv}:material`, 'OLD_RETIRED_MATERIAL');
    await local.management('memory.correct', { id: saved.id, expected_revision: 1, statement: 'CURRENT_CORRECTED_PUBLIC_BODY' });
    pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); await local.ingest(pub, 'unrelated-public', 'OTHER_PUBLIC_WITHOUT_PROVENANCE');
    await local.management('memory.settings', { auto_write: false }); const item = service(); await item.configure({ enabled: true }); await item.run();
    const research = JSON.stringify(modelCalls[0]); assert.match(research, /CURRENT_CORRECTED_PUBLIC_BODY/); assert.doesNotMatch(research, /OLD_RETIRED_MATERIAL|OTHER_PUBLIC_WITHOUT_PROVENANCE|公开简介材料|OWNER_PRIVATE_MARKER/);
    assert.equal(sends.length, 1); assert.equal((await item.status()).reader.materialStored, true); assert.equal((await item.status()).reader.thoughtStored, false);
    await local.management('memory.settings', { auto_write: true });
  });
  await check('temporary never-persisted material cannot leave an orphan thought if auto-write is enabled mid-research', async () => {
    await reset(); await local.management('memory.settings', { auto_write: false }); const item = service(); await item.configure({ enabled: true });
    modelHook = async n => { if (n === 1) await local.management('memory.settings', { auto_write: true }); };
    await rejects(item.run(), 'STALE_CONTEXT'); const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); assert.doesNotMatch(pub.text, /从字幕看|公开简介材料/); assert.equal(sends.length, 0);
  });
  await check('facade forwards source revision proofs and service rejects stale proof despite a fresh context', async () => {
    await reset(); let pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const saved = await local.ingest(pub, 'proof-material', 'source');
    pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' });
    await rejects(local.ingest(pub, 'bad-proof', 'old generated text', { derivedFrom: [{ id: saved.id, revision: 2 }] }), 'VERSION_CONFLICT'); assert.equal(sends.length, 0);
  });
  await check('stop, role close and backend switch during generation forbid late sending', async () => {
    for (const action of ['stop', 'role', 'backend']) {
      await reset(); const item = service(); await item.configure({ enabled: true });
      modelHook = async n => { if (n === 1) { if (action === 'stop') await item.stop(); else if (action === 'role') env.roleActive = false; else await local.setMode('paused'); } };
      await rejects(item.run(), action === 'role' ? 'COMPANION_PAUSED' : 'COMPANION_STOPPED'); assert.equal(sends.length, 0);
    }
  });
  await check('intent cannot forge target/text, be claimed twice, or switch current owner', async () => {
    await reset(); const publicContext = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const trusted = adapter.channels.get('private:123'); const ownerContext = await local.context(trusted);
    const id = await channel.issueIntent({ publicContext, ownerContext, channel: trusted, text: '真实服务器正文', outreachId: 'one-shot-fixture', active: () => true });
    const values = await Promise.allSettled([adapter.request('intent.claim', trusted, { intentId: id }), adapter.request('intent.claim', trusted, { intentId: id })]); assert.equal(values.filter(x => x.status === 'fulfilled').length, 1);
    await rejects(adapter.request('intent.claim', trusted, { intentId: 'f'.repeat(48), text: 'forged' }), 'COMPANION_INTENT_INVALID');
    const id2 = await channel.issueIntent({ publicContext, ownerContext, channel: trusted, text: '旧主人正文', outreachId: 'changed-owner', active: () => true }); await local.setQqOwner({ account: '999', peer: '124' });
    await assert.rejects(adapter.request('intent.claim', trusted, { intentId: id2 })); assert.equal(sends.length, 0);
  });
  await check('expired or stopped host intents never become fresh contexts for old text', async () => {
    await reset(); const trusted = adapter.channels.get('private:123'); const publicContext = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const ownerContext = await local.context(trusted);
    const id = await channel.issueIntent({ publicContext, ownerContext, channel: trusted, text: '限时正文', outreachId: 'expired', active: () => true });
    const clock = Date.now; try { Date.now = () => clock() + 121000; await rejects(adapter.request('intent.claim', trusted, { intentId: id }), 'COMPANION_STOPPED'); } finally { Date.now = clock; }
    let enabled = true; const stopped = await channel.issueIntent({ publicContext, ownerContext, channel: trusted, text: '已停正文', outreachId: 'stopped', active: () => enabled }); enabled = false;
    await rejects(adapter.request('intent.claim', trusted, { intentId: stopped }), 'COMPANION_STOPPED'); assert.equal(sends.length, 0);
  });
  await check('attention becomes focused after claim: actual transport blocked and finalized failed', async () => {
    await reset(); const item = service(); await item.configure({ enabled: true });
    gateHook = async () => { await local.management('attention.configure', { focused: true }); };
    await rejects(item.run(), 'ATTENTION_BLOCKED'); assert.equal(sends.length, 0); assert.equal((await item.status()).last.outcome, 'failed');
  });
  await check('focus change after reservation and stop after claim both block the actual effect', async () => {
    await reset(); const item = service(); await item.configure({ enabled: true });
    const original = adapter.request.bind(adapter);
    adapter.request = async (...args) => { const result = await original(...args); if (args[0] === 'attention.reserve' && result.reserved) await local.management('attention.configure', { focused: true }); return result; };
    await rejects(item.run(), 'ATTENTION_BLOCKED'); assert.equal(sends.length, 0); assert.equal((await item.status()).last.outcome, 'failed');
    await reset(); const stopped = service(); await stopped.configure({ enabled: true }); gateHook = async () => { await stopped.stop(); };
    await rejects(stopped.run(), 'COMPANION_STOPPED'); assert.equal(sends.length, 0); assert.equal((await stopped.status()).last.outcome, 'failed');
  });
  await check('mute changed during awaited identity guard is rechecked before any transport', async () => {
    await reset(); const original = adapter.withIntent.bind(adapter);
    adapter.withIntent = (id, { guard, deliver }) => original(id, { guard: async trusted => { await guard(trusted); await local.management('attention.configure', { muted: true }); }, deliver });
    const item = service(); await item.configure({ enabled: true }); await rejects(item.run(), 'ATTENTION_BLOCKED'); assert.equal(sends.length, 0); assert.equal((await item.status()).last.outcome, 'failed');
  });
  await check('purpose quiet tightening during owner generation invalidates the old round', async () => {
    await reset(); let purpose = { quietStart: '00:00', quietEnd: '00:00', idleThresholdMs: 0, dailyMax: 4 };
    const item = service({ purposeConfig: () => purpose }); await item.configure({ enabled: true }); modelHook = async n => { if (n === 2) await item.configure({ quietStart: '00:00', quietEnd: '00:00' }); };
    await rejects(item.run(), 'FIXED_MODEL_STALE'); assert.equal(sends.length, 0);
  });
  await check('crossing purpose quiet time during awaited identity guard blocks transport without a config edit', async () => {
    await reset(); let clock = Date.now(); const quietStart = new Date(clock + 60000).toISOString().slice(11, 16), quietEnd = new Date(clock + 3600000).toISOString().slice(11, 16); const original = adapter.withIntent.bind(adapter);
    adapter.withIntent = (id, { guard, deliver }) => original(id, { guard: async trusted => { await guard(trusted); clock += 2 * 60000; }, deliver });
    const item = service({ now: () => clock }); await item.configure({ enabled: true, quietStart, quietEnd });
    await rejects(item.run(), 'COMPANION_PAUSED'); assert.equal(sends.length, 0);
  });
  await check('owner activity revision or purpose policy changes while identity is awaited: no transport', async () => {
    for (const kind of ['owner-active', 'policy-change']) {
      await reset(); let idle = 100000000; let purpose = { quietStart: '00:00', quietEnd: '00:00', idleThresholdMs: 60000, dailyMax: 4 }; const original = adapter.withIntent.bind(adapter);
      adapter.withIntent = (id, { guard, deliver }) => original(id, { guard: async trusted => { await guard(trusted); if (kind === 'owner-active') adapter.beginIncoming('private:123', { self_id: 999, user_id: 123, message_id: 'new-active' }).finish(); else await item.configure({ muted: true }); }, deliver });
      const item = service({ purposeConfig: () => purpose }); await item.configure({ enabled: true });
      await rejects(item.run(), kind === 'owner-active' ? 'COMPANION_ACTIVITY_CHANGED' : 'COMPANION_STOPPED'); assert.equal(sends.length, 0);
    }
  });
  await check('intent expiry across policy, context and final IPC awaits blocks transport, including exact expiry', async () => {
    for (const phase of ['policy', 'context', 'response']) for (const expiredAt of [120000, 121000]) {
      await reset();
      const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' });
      const trusted = adapter.channels.get('private:123'); const owner = await local.context(trusted);
      const originalNow = Date.now, baseNow = originalNow();
      const originalValidate = local.validate.bind(local), originalRequest = adapter.request.bind(adapter);
      let offset = 0, armed = false, policyCalls = 0;
      Date.now = () => baseNow + offset;
      local.validate = async context => {
        const result = await originalValidate(context);
        if (phase === 'context' && armed && policyCalls === 2 && context.binding.session_binding === owner.binding.session_binding) offset = expiredAt;
        return result;
      };
      adapter.request = async (action, channel, payload) => {
        const result = await originalRequest(action, channel, payload);
        if (phase === 'response' && action === 'attention.check' && payload?.params?.reservation_id) offset = expiredAt;
        return result;
      };
      try {
        const id = await channel.issueIntent({ publicContext: pub, ownerContext: owner, channel: trusted, text: '临近到期的隔离测试消息', outreachId: 'expiry-test', active: async () => {
          if (armed && ++policyCalls === 2 && phase === 'policy') offset = expiredAt;
          return true;
        } });
        await rejects(adapter.withIntent(id, {
          guard: async () => { offset = 119000; armed = true; },
          deliver: async () => adapter.sendFetch('private:123', 'http://onebot.invalid/send_private_msg', { method: 'POST' }),
        }), 'COMPANION_STOPPED');
        assert.equal(sends.length, 0, phase);
        assert.equal(channel.intentStatus(id), 'failed', 'expiry must still allow finalization');
      } finally { Date.now = originalNow; local.validate = originalValidate; adapter.request = originalRequest; }
    }
  });
  await check('model timeout aborts generation and has no delayed sending', async () => {
    await reset(); const item = service({ modelTimeoutMs: 10 }); await item.configure({ enabled: true }); modelHook = async () => new Promise(() => {});
    await rejects(item.run(), 'FIXED_MODEL_TIMEOUT'); assert.equal(modelCalls[0].signal.aborted, true); assert.equal(sends.length, 0); assert.equal((await item.status()).running, false);
  });
  await check('explicit rejection versus unknown delivery finalize accurately; restart cannot replay source', async () => {
    for (const expected of ['failed', 'unknown']) {
      await reset(); const item = service(); await item.configure({ enabled: true }); delivery = expected;
      await rejects(item.run(), expected === 'failed' ? 'DELIVERY_REJECTED' : 'COMPANION_DELIVERY_UNKNOWN'); assert.equal(sends.length, 1); assert.equal((await item.status()).last.outcome, expected);
      item.dispose(); const next = service(); assert.equal((await next.run()).skipped, true); assert.equal(sends.length, 1);
    }
  });
  await check('real HTTP action contract rejects caller targets/text and exposes structured config/run/stop errors', async () => {
    await reset(); const item = service(); const handler = createCompanionHandler(item);
    const invoke = async (action, input = {}, method = 'POST') => {
      const req = Readable.from([Buffer.from(JSON.stringify(input))]); Object.assign(req, { method, url: `/dsh-surfcore/api/companion/${action}` });
      const res = { writeHead(code) { this.code = code; }, end(value) { this.data = JSON.parse(value); } }; await handler(req, res); return res;
    };
    const disabled = await invoke('run'); assert.equal(disabled.data.code, 'COMPANION_DISABLED'); assert.ok(disabled.data.error && disabled.data.hint);
    assert.equal((await invoke('run', { target: '124', text: 'no' })).data.code, 'INVALID_REQUEST');
    assert.equal((await invoke('config', { enabled: true, dailyMax: -1 })).data.code, 'INVALID_REQUEST');
    assert.equal((await invoke('status', {}, 'GET')).data.config.enabled, false);
    assert.equal((await invoke('stop')).data.stopped, true);
  });
  await check('actual bridge HTTP seam keeps console auth, agent/Origin rejection and server-fixed owner/body', async () => {
    await reset();
    class FixtureAdapter extends LocalChannelBridge {
      constructor(options) { super({ ...options, keyFile, config: () => ({ ...options.config(), dsh: config.dsh }), guarded: () => true, mode: () => 'local', fetchImpl: async (url, opts) => {
        if (String(url).endsWith('/send_private_msg')) { sends.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 222 } })); }
        return fetch(url, opts);
      } }); }
    }
    const h = await bridgeHarness({ config: { ownerQQ: '123', allow: { private: ['123'], groups: [] } }, globals: { LocalChannelBridge: FixtureAdapter, localBackendGuarded: () => true, localBackendMode: () => 'local' } });
    let consoleServer;
    try {
      h.setMode('chat'); h.setReady(true); h.setSelfIdentity('fixture', '999'); h.setSnowlumaHealth({ connected: true, accountOnline: true });
      const trusted = { kind: 'qq-private', account: '999', peer: '123', principal: '123' }; h.localChannels.channels.set('private:123', trusted);
      h.localChannels.beginIncoming('private:123', { self_id: 999, user_id: 123, message_id: 'initial' }).finish();
      h.bot.raw = async action => action === 'get_login_info' ? { user_id: 999 } : [{ user_id: 123 }];
      consoleServer = h.startConsoleServer(); if (!consoleServer.listening) await new Promise(resolve => consoleServer.once('listening', resolve));
      const url = `http://127.0.0.1:${consoleServer.address().port}/api/companion/deliver`;
      const post = async (data, headers = {}) => { const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers }, body: JSON.stringify(data) }); return { code: res.status, body: await res.json() }; };
      assert.equal((await post({ intentId: 'f'.repeat(48) }, { 'x-console-token': 'wrong' })).code, 401);
      assert.equal((await post({ intentId: 'f'.repeat(48) }, { 'x-agent-call': '1' })).code, 403);
      assert.equal((await post({ intentId: 'f'.repeat(48) }, { origin: `http://127.0.0.1:${consoleServer.address().port}` })).code, 403);
      assert.equal((await post({ intentId: 'f'.repeat(48), target: '124', text: 'FORGED' })).body.code, 'INVALID_REQUEST');
      const pub = await local.context({ kind: 'bili', account: 'public', peer: 'public' }); const owner = await local.context(trusted);
      const id = await channel.issueIntent({ publicContext: pub, ownerContext: owner, channel: trusted, text: '唯一宿主正文', outreachId: 'bridge-contract', active: () => true });
      const sent = await post({ intentId: id }); assert.equal(sent.body.ok, true, JSON.stringify(sent)); assert.equal(sent.body.delivery.messageId, 222);
      assert.equal(sends.length, 1); assert.equal(sends[0].user_id, 123); assert.equal(sends[0].message[0].data.text, '唯一宿主正文');
      assert.equal((await post({ intentId: id })).body.code, 'COMPANION_INTENT_INVALID'); assert.equal(sends.length, 1);
      h.cfg.allow.private = []; const readiness = await fetch(url.replace('/deliver', '/readiness'), { headers: { 'x-console-token': 'fixture-console-token' } }); assert.equal((await readiness.json()).code, 'OWNER_NOT_ALLOWED');
      assert.equal((await h.runPurpose({ force: true })).code, 'COMPANION_COORDINATOR_REQUIRED');
    } finally { consoleServer?.closeAllConnections?.(); if (consoleServer) await new Promise(resolve => consoleServer.close(resolve)); await h.close(); }
  });
} finally {
  for (const item of services) item.dispose();
  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await supervisor.stop();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`PASS ${count} autonomous companion checks; real isolated SQLCipher service, mock public HTTP/LLM/QQ, no platform messages.`);
