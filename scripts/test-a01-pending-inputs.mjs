// Actual bridge + native SQLCipher/HTTP. DSH/model and QQ transport are isolated recorders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LocalChannelBridge } from '../src/local-capabilities-bridge.js';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createChannelHandler } from '../plugins/surfcore/lib/local-capabilities/channel.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(run,{autoWrite=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-r2-')), keyFile=path.join(root,'channel.key');
  const supervisor=new CapabilitySupervisor({python:path.join(repo,'.venv/Scripts/python.exe'),entry:path.join(repo,'services/local-capabilities/server.py'),dataDir:path.join(root,'data'),env:{SURFCORE_LOCAL_KEY:crypto.randomBytes(32).toString('hex'),PYTHONUTF8:'1'}});
  let character={id:'synthetic-continuity',epoch:1};
  const local=new LocalCapabilities({supervisor,stateFile:path.join(root,'backend.json'),currentCharacter:()=>character});
  const channelHandler=createChannelHandler({capabilities:local,keyFile});
  const server=http.createServer((req,res)=>void channelHandler(req,res));let h,consoleServer;
  try {
    await local.setMode('local');if(!autoWrite)await local.management('memory.settings',{auto_write:false});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    const outgoing=[];
    class FixtureBridge extends LocalChannelBridge {
      constructor(options) { super({...options,currentCharacter:()=>character,config:()=>({...options.config(),dsh:{baseUrl:base}}),keyFile,guarded:()=>true,mode:()=>local.mode,fetchImpl:async(url,options)=>{
        if(String(url).startsWith(base))return fetch(url,options);
        outgoing.push(JSON.parse(options.body));return new Response(JSON.stringify({status:'ok',retcode:0,data:{message_id:outgoing.length}}));
      }}); }
      // These synthetic messages contain no fixed-tool request. Do not instantiate a model executor.
      async handleTools(){return {handled:false};}
    }
    h=await bridgeHarness({config:{sendDelayMs:0,fishGuard:{enabled:false},socialV2:{wake:{preSleepWaitEnabled:true,preSleepWaitMs:300000},send:{burstIntervalMinMs:100,burstIntervalMaxMs:100,maxGapMs:100},wait:{minMs:100,maxMs:600000,minQuietAfterNewMs:100},proactive:{enabled:false},sticker:{enabled:false}}},globals:{LocalChannelBridge:FixtureBridge,localBackendGuarded:()=>true,localBackendMode:()=>local.mode,__auditMuxOnce:true}});
    h.setSelfIdentity('fixture', '999');
    h.setMode('reserved2');consoleServer=h.startConsoleServer();if(!consoleServer.listening)await new Promise(resolve=>consoleServer.once('listening',resolve));
    const request=(route,body,token)=>new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:consoleServer.address().port,path:`/api/socialV2/${route}`,method:'POST',headers:{'x-console-token':'fixture-console-token','x-agent-token':token,'content-type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('fixture request timeout')));req.end(JSON.stringify(body));
    });
    let next=1;
    const incoming=async(text,peer=123,kind='private')=>{const event={self_id:999,user_id:kind==='private'?peer:700,group_id:kind==='group'?peer:undefined,message_id:next++,message:[{type:'text',data:{text}}],sender:{nickname:'synthetic-peer'}};await h.handleIncoming(kind,peer,event,h.cfg);return event;};
    const wake=async(key='private:123')=>{const state=h.getSocialV2State(key);if(state.pendingWakeTimer){clearTimeout(state.pendingWakeTimer);state.pendingWakeTimer=null;}await h.sendWakePromptV2(key,'private');return h.state.sessions[key];};
    await run({h,local,supervisor,outgoing,incoming,wake,request,character:next=>{character=next;}});
  } finally {
    if(consoleServer)await new Promise(resolve=>consoleServer.close(resolve));await h?.close();await new Promise(resolve=>server.close(resolve));await supervisor.stop();
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('surfcore-r2-'));fs.rmSync(root,{recursive:true,force:true});
  }
}

for (const failure of ['wrong-key', 'wrong-token']) test(`A01 ${failure} survives normal reminder rebuild as a passive native request`, () => fixture(async ({ h, incoming, wake, request, outgoing }) => {
  await incoming('SYNTHETIC_UNANSWERED_QUESTION');
  const first = await wake(), old = h.localChannels.sessions.get(first), state = h.getSocialV2State('private:123');
  const prompt = h.calls.prompts.at(-1).content[0].text;
  const token = failure === 'wrong-token' ? state.agentToken.slice(0, -1) + (state.agentToken.endsWith('0') ? '1' : '0') : state.agentToken;
  const failed = await request('send-message', { key: failure === 'wrong-key' ? 'qq-private:123' : 'private:123', messages: 'MUST_NOT_SEND' }, token);
  assert.equal(failed.ok, false); assert.equal(outgoing.length, 0); assert.ok(!old.transportAttempted);
  // Native wake/mark-read acknowledgement does not constitute delivery.
  h.localChannels.origin.run(old, () => h.localChannels.acknowledgeOrigin());
  assert.equal(old.inputs.length, 1);
  const second = await h.ensureSession('private:123');
  await h.api.sessions.prompt({ sessionId: second, content: [] });
  const current = h.localChannels.sessions.get(second);
  assert.notEqual(first, second); assert.equal(current.proactive, false);
  assert.match(prompt, /【工具会话 key】private:123/);
  assert.match(prompt, /【受众类型】qq-private/);
  assert.deepEqual(current.inputs.map(input => input.id), old.inputs.map(input => input.id));
  const result = await request('send-message', { key: 'private:123', messages: 'SYNTHETIC_PASSIVE_ANSWER' }, state.agentToken);
  assert.equal(result.ok, true); assert.equal(outgoing.length, 1); assert.deepEqual(current.inputs, []);
}));

test('A01 group prompt separates canonical tool key from audience kind', () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_GROUP_REQUEST', 456, 'group'); await wake('group:456');
  const prompt = h.calls.prompts.at(-1).content[0].text;
  assert.match(prompt, /【工具会话 key】group:456/); assert.match(prompt, /【受众类型】qq-group/);
}));

test('A01 normal ensureSession rebuild retains unanswered input without a new ingress', () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_PENDING_WITHOUT_ACK'); const first = await wake();
  const second = await h.ensureSession('private:123'); await h.api.sessions.prompt({ sessionId: second, content: [] });
  assert.notEqual(first, second); assert.equal(h.localChannels.sessions.get(second).proactive, false);
  assert.deepEqual(h.localChannels.sessions.get(second).inputs.map(input => input.text), ['SYNTHETIC_PENDING_WITHOUT_ACK']);
}));

async function rebuild(h, key = 'private:123') {
  const id = await h.ensureSession(key);
  await h.api.sessions.prompt({ sessionId: id, content: [] });
  return h.localChannels.sessions.get(id);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const operation of ['correct', 'delete']) test(`A01 rebuild re-reads native ${operation} instead of cached input`, () => fixture(async ({ h, local, incoming, wake }) => {
  await incoming('SYNTHETIC_ORIGINAL_SOURCE'); await wake();
  const source = (await local.management('memory.query')).memories.find(item => item.statement === 'SYNTHETIC_ORIGINAL_SOURCE');
  await local.management(`memory.${operation}`, { id: source.id, expected_revision: source.revision, ...(operation === 'correct' ? { statement: 'SYNTHETIC_CORRECTED_SOURCE' } : {}) });
  if (operation === 'delete') await assert.rejects(rebuild(h), error => error.code === 'SOURCE_UNAVAILABLE' && !!error.error && !!error.hint);
  else assert.deepEqual((await rebuild(h)).inputs.map(input => input.text), ['SYNTHETIC_CORRECTED_SOURCE']);
}));

for (const autoWrite of [true, false]) test(`A01 auto_write=${autoWrite} normal reminders retain one verified event across repeated rebuilds`, () => fixture(async ({ h, incoming, wake, local }) => {
  await incoming('SYNTHETIC_ONE_SOURCE'); await wake();
  for (let i = 0; i < 3; i++) {
    const record = await rebuild(h); assert.equal(record.proactive, false); assert.equal(record.inputs.length, 1);
    assert.equal(record.inputs[0].neverPersisted, !autoWrite);
  }
  if (!autoWrite) assert.equal((await local.management('memory.query')).memories.some(item => item.statement === 'SYNTHETIC_ONE_SOURCE'), false);
}, { autoWrite }));

test('A01 neverPersisted input with changed native source context cannot use cached text', () => fixture(async ({ h, local, incoming, wake }) => {
  await incoming('SYNTHETIC_NEVER_PERSISTED'); await wake();
  await local.management('memory.settings', { auto_write: true });
  const context = await local.context({ kind: 'qq-private', account: '999', peer: '123', principal: '123' });
  await local.ingest(context, 'synthetic-change', 'SYNTHETIC_DIFFERENT_SOURCE', { actor: 'user' });
  await assert.rejects(rebuild(h), error => error.code === 'SOURCE_UNAVAILABLE' && !!error.hint);
}, { autoWrite: false }));

for (const outcome of ['sent', 'partial', 'unknown', 'rejected']) test(`A01 ${outcome} transport is never replayed by a reminder`, () => fixture(async ({ h, incoming, wake, request, outgoing }) => {
  await incoming('SYNTHETIC_DELIVERY_SOURCE'); const first = await wake(), old = h.localChannels.sessions.get(first);
  await h.localChannels.origin.run(old, async () => {
    if (outcome === 'sent' || outcome === 'partial') await h.localChannels.send('private:123', async () => { outgoing.push({ synthetic: 'confirmed' }); });
    if (outcome !== 'sent') await assert.rejects(h.localChannels.send('private:123', async () => { outgoing.push({ synthetic: 'attempted' }); throw Object.assign(Error('synthetic failed receipt'), outcome === 'rejected' ? { deliveryOutcome: 'failed' } : {}); }));
  });
  assert.equal(old.transportAttempted, true);
  if (outcome === 'sent') assert.deepEqual(old.inputs, []);
  const current = await rebuild(h); assert.equal(current.proactive, true); assert.deepEqual(current.inputs, []);
  const before = outgoing.length;
  const reply = await request('send-message', { key: 'private:123', messages: 'MUST_NOT_REPLAY' }, h.getSocialV2State('private:123').agentToken);
  assert.equal(reply.ok, false); assert.equal(outgoing.length, before);
}));

for (const flag of ['intent', 'toolDelivery', 'uncertain']) test(`A01 ${flag} records cannot become passive pending inputs`, () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_INELIGIBLE_SOURCE'); const first = await wake();
  const old = h.localChannels.sessions.get(first); old[flag] = true;
  const current = await rebuild(h); assert.equal(current.proactive, true); assert.deepEqual(current.inputs, []);
}));

for (const autoWrite of [true, false]) test(`A01 explicit stop cancels old input and preserves new ingress with auto_write=${autoWrite}`, () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_CANCELLED_REQUEST'); const first = await wake();
  await h.api.stopSessionWork(first);
  const stopped = await rebuild(h); assert.equal(stopped.proactive, true); assert.deepEqual(stopped.inputs, []);
  await incoming('SYNTHETIC_NEW_REQUEST'); const id = await wake();
  const current = h.localChannels.sessions.get(id); assert.deepEqual(current.inputs.map(input => input.text), ['SYNTHETIC_NEW_REQUEST']);
}, { autoWrite }));

test('A01 role change and permission retirement discard pending ownership', () => fixture(async ({ h, incoming, wake, character }) => {
  await incoming('SYNTHETIC_OLD_ROLE'); const first = await wake();
  character({ id: 'synthetic-other-role', epoch: 2 });
  h.retireSession('private:123', { reason: 'TURN_REBUILD' });
  assert.equal(h.localChannels.events.has('private:123'), false); assert.equal(h.localChannels.sessions.has(first), false);
  await assert.rejects(rebuild(h), error => ['STALE_CHARACTER', 'ROLE_PACKAGE_STALE'].includes(error.code));
}));

test('A01 audience/account replacement cannot receive another pending source', () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_PRIVATE_ONLY'); await wake();
  await incoming('SYNTHETIC_GROUP_ONLY', 456, 'group'); await wake('group:456');
  const group = await rebuild(h, 'group:456'); assert.deepEqual(group.inputs.map(input => input.text), ['SYNTHETIC_GROUP_ONLY']);
  const privateRecord = await rebuild(h); assert.deepEqual(privateRecord.inputs.map(input => input.text), ['SYNTHETIC_PRIVATE_ONLY']);
  await h.localChannels.incoming('private:123', { self_id: 1000, user_id: 123, message_id: 700 }, 'SYNTHETIC_NEW_ACCOUNT');
  const next = await rebuild(h); assert.deepEqual(next.inputs.map(input => input.text), ['SYNTHETIC_NEW_ACCOUNT']);
}));

test('A01 new ingress and reminders deduplicate original source IDs', () => fixture(async ({ h, incoming, wake }) => {
  const event = await incoming('SYNTHETIC_REQUEST_A'); await wake(); await rebuild(h);
  await incoming('SYNTHETIC_SUPPLEMENT_B'); await wake();
  const duplicate = await h.localChannels.incoming('private:123', event, 'SYNTHETIC_REQUEST_A'); assert.equal(duplicate.duplicate, true);
  const next = await rebuild(h);
  assert.deepEqual(next.inputs.map(input => input.text), ['SYNTHETIC_REQUEST_A', 'SYNTHETIC_SUPPLEMENT_B']);
  assert.equal(new Set(next.inputs.map(input => input.id)).size, 2);
}));

for (const autoWrite of [true, false]) for (const action of ['rebuild', 'stop', 'new-ingress']) test(`A01 preparation ${action} auto_write=${autoWrite} cannot lose or revive another generation`, () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_PREPARING_A'); await wake();
  const a = h.localChannels, request = a.request.bind(a), entered = deferred(), gate = deferred(); let held = false;
  a.request = async (operation, ...args) => {
    const value = await request(operation, ...args);
    if (operation === 'sources' && !held) { held = true; entered.resolve(); await gate.promise; }
    return value;
  };
  const first = await h.ensureSession('private:123');
  const work = h.api.sessions.prompt({ sessionId: first, content: [] });
  const cancelled = assert.rejects(work, error => ['REQUEST_CANCELLED', 'STALE_CHARACTER', 'TURN_SUPERSEDED'].includes(error.code));
  await entered.promise;
  if (action === 'stop') await h.api.stopSessionWork(first);
  if (action === 'new-ingress') await incoming('SYNTHETIC_NEW_B');
  const next = await rebuild(h); gate.resolve(); await cancelled;
  assert.deepEqual(next.inputs.map(input => input.text), action === 'stop' ? [] : action === 'new-ingress' ? ['SYNTHETIC_PREPARING_A', 'SYNTHETIC_NEW_B'] : ['SYNTHETIC_PREPARING_A']);
  assert.equal(a.sessions.get(next.sessionId), next); assert.equal(a.preparations.size, 0);
}, { autoWrite }));

test('A01 permission retirement discards unsent ownership', () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_REVOKED_AUDIENCE'); await wake(); h.cfg.allow.private = [];
  h.retireSession('private:123'); assert.equal(h.localChannels.events.has('private:123'), false);
  await assert.rejects(h.ensureSession('private:123'));
}));

test('A01 explicit late stop of retired generation cannot discard successor inputs', () => fixture(async ({ h, incoming, wake }) => {
  await incoming('SYNTHETIC_ORIGINAL_A'); const first = await wake();
  await incoming('SYNTHETIC_CURRENT_B'); const second = await wake();
  await h.api.stopSessionWork(first);
  const current = h.localChannels.sessions.get(second);
  assert.deepEqual(current.inputs.map(input => input.text), ['SYNTHETIC_ORIGINAL_A', 'SYNTHETIC_CURRENT_B']);
}));

for (const phase of ['preparing', 'prepared']) test(`A01 caller abort while ${phase} cancels inputs across a reminder`, () => fixture(async ({ h, incoming }) => {
  await incoming('SYNTHETIC_CALLER_CANCELLED');
  const id = await h.ensureSession('private:123'), controller = new AbortController(), entered = deferred(), gate = deferred();
  const a = h.localChannels, request = a.request.bind(a);
  if (phase === 'preparing') a.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'sources') { entered.resolve(); await gate.promise; }
    return result;
  };
  const work = h.api.sessions.prompt({ sessionId: id, content: [], signal: controller.signal });
  if (phase === 'preparing') {
    const rejected = assert.rejects(work, error => error.code === 'REQUEST_CANCELLED');
    await entered.promise; controller.abort(); gate.resolve(); await rejected;
  } else { await work; controller.abort(); }
  a.request = request;
  assert.deepEqual((await rebuild(h)).inputs, []);
}));

test('A01 actual mark-read and wake-config preserve unanswered input', () => fixture(async ({ h, incoming, wake, request }) => {
  await incoming('给我几个名字'); const id = await wake(), state = h.getSocialV2State('private:123');
  const wakeResult = await request('wake-config', { key: 'private:123', config: { mode: 'active' } }, state.agentToken);
  assert.equal(wakeResult.ok, true);
  assert.equal((await request('mark-read', { key: 'private:123', throughSeq: 0 }, state.agentToken)).ok, true);
  assert.equal(h.localChannels.sessions.get(id).inputs.length, 1);
  assert.deepEqual((await rebuild(h)).inputs.map(input => input.text), ['给我几个名字']);
}));

test('A01 native close rejects an unanswered name request after local prompt preparation', () => fixture(async ({ h, incoming, wake, request }) => {
  await incoming('给我几个名字'); const id = await wake(), state = h.getSocialV2State('private:123');
  const closed = await request('close', { key: 'private:123', reason: 'explicit_end' }, state.agentToken);
  assert.equal(closed.ok, false); assert.equal(closed.code, 'open-question'); assert.ok(closed.error && closed.hint);
  assert.equal(h.localChannels.sessions.get(id).inputs.length, 1);
  assert.deepEqual((await rebuild(h)).inputs.map(input => input.text), ['给我几个名字']);
}));

test('A01 real goodnight native close settles displayed input and keeps the next request', () => fixture(async ({ h, incoming, wake, request, outgoing }) => {
  await incoming('晚安，不聊了'); const id = await wake(), state = h.getSocialV2State('private:123');
  const closed = await request('close', { key: 'private:123', reason: 'explicit_end' }, state.agentToken);
  assert.equal(closed.ok, true); assert.ok(closed.closedAt); assert.equal(closed.blocked, undefined);
  assert.deepEqual(h.localChannels.sessions.get(id).inputs, []); assert.equal(outgoing.length, 0);
  await incoming('给我几个名字'); await wake();
  assert.deepEqual((await rebuild(h)).inputs.map(input => input.text), ['给我几个名字']);
}));

test('A01 native ALREADY_CLOSED response cannot acknowledge a fresh source record', () => fixture(async ({ h, incoming, wake, request }) => {
  await incoming('晚安，不聊了'); await wake(); const state = h.getSocialV2State('private:123');
  assert.equal((await request('close', { key: 'private:123' }, state.agentToken)).ok, true);
  // Preserve a legitimate old native closure while a trusted source arrives.
  // A stale/no-op close must not settle the new displayed source.
  await h.localChannels.incoming('private:123', { self_id: 999, user_id: 123, message_id: 900 }, '给我几个名字');
  const current = await rebuild(h);
  const closed = await request('close', { key: 'private:123' }, state.agentToken);
  assert.equal(closed.ok, true); assert.equal(closed.blocked, true); assert.equal(closed.code, 'ALREADY_CLOSED'); assert.ok(closed.closedAt);
  assert.deepEqual(current.inputs.map(input => input.text), ['给我几个名字']);
}));

test('A01 failed send blocks native close without acknowledging the pending input', () => fixture(async ({ h, incoming, wake, request }) => {
  await incoming('给我几个名字'); const id = await wake(), state = h.getSocialV2State('private:123');
  const fetcher = h.localChannels.fetchImpl;
  h.localChannels.fetchImpl = async (url, options) => {
    if (String(url).endsWith('/send_private_msg')) throw Error('synthetic platform unavailable');
    return fetcher(url, options);
  };
  const failed = await request('send-message', { key: 'private:123', messages: 'synthetic reply' }, state.agentToken);
  assert.equal(failed.ok, false);
  assert.equal(h.localChannels.sessions.get(id).transportAttempted, true, JSON.stringify(failed));
  const closed = await request('close', { key: 'private:123' }, state.agentToken);
  assert.equal(closed.ok, false); assert.equal(closed.code, 'CLOSE_AFTER_SEND_FAILED'); assert.ok(closed.error && closed.hint);
  assert.equal(h.localChannels.sessions.get(id).inputs.length, 1);
}));

test('A01 unauthenticated or stale close cannot settle current input', () => fixture(async ({ h, local, incoming, wake, request }) => {
  await incoming('给我几个名字'); const id = await wake(), state = h.getSocialV2State('private:123'), current = h.localChannels.sessions.get(id);
  assert.equal((await request('close', { key: 'private:123' }, 'synthetic-invalid-token')).ok, false);
  assert.equal(current.inputs.length, 1);
  const source = (await local.management('memory.query')).memories.find(item => item.statement === '给我几个名字');
  await local.management('memory.delete', { id: source.id, expected_revision: source.revision });
  const closed = await request('close', { key: 'private:123' }, state.agentToken);
  assert.equal(closed.ok, false); assert.equal(closed.code, 'STALE_CONTEXT'); assert.ok(closed.hint); assert.equal(current.inputs.length, 1);
}));

