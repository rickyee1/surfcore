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
      constructor(options) { super({...options,config:()=>({dsh:{baseUrl:base}}),keyFile,guarded:()=>true,mode:()=>local.mode,fetchImpl:async(url,options)=>{
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

test('new ingress immediately revokes a reserved2 origin even when auto_write is disabled',()=>fixture(async({h,incoming,wake})=>{
  await incoming('Please explain the synthetic invoice');const first=await wake();h.localChannels.enterSession(first);
  await incoming('And use Chinese');
  await assert.rejects(()=>h.localChannels.validateOrigin(),error=>['STALE_CONTEXT','BINDING_INVALID','TURN_SUPERSEDED'].includes(error.code));
  assert.notEqual(h.state.sessions['private:123'],first);
},{autoWrite:false}));

test('new ingress releases pendingWakeKey instead of waiting for old turn/end or five-minute observation',()=>fixture(async({h,incoming,wake})=>{
  await incoming('Synthetic first request');const first=await wake();assert.equal(h.isConversationBusyV2('private:123',h.getSocialV2State('private:123')),true);
  await incoming('Synthetic second request');
  assert.notEqual(h.state.sessions['private:123'],first,'old reserved2 session must be retired at ingress');
  assert.ok(h.calls.cancelled.includes(first),'old native DSH work must be stopped');
  const second=await wake();assert.notEqual(second,first);assert.equal(h.calls.prompts.length,2);
}));

test('unsent original request and language supplement are re-resolved together, without old model history',()=>fixture(async({h,incoming,wake,outgoing})=>{
  await incoming('Please explain my synthetic invoice');const first=await wake();const old=h.localChannels.sessions.get(first);
  await incoming('And use Chinese');const second=await wake();const prompt=h.calls.prompts.at(-1).content[0].text;
  assert.match(prompt,/Please explain my synthetic invoice/);assert.match(prompt,/And use Chinese/);assert.notEqual(first,second);
  assert.equal(old.writerReleased,true);assert.equal(old.revoked,true);assert.equal(h.getMode(),'reserved2');
  await assert.rejects(()=>h.localChannels.origin.run(old,()=>h.localChannels.send('private:123',()=>{throw Error('must not execute');})),error=>error.code==='BINDING_INVALID');assert.equal(outgoing.length,0);
}));

test('three consecutive turns retain native send/array bubbles/reply wait and natural close',()=>fixture(async({h,incoming,wake,request,outgoing})=>{
  const sessions=[];
  for(let turn=1;turn<=3;turn++){
    await incoming(`Synthetic question ${turn}`);const sid=await wake();sessions.push(sid);const st=h.getSocialV2State('private:123');
    st.lastIncomingAt=Date.now()-1000;
    const ready=await request('wait',{key:'private:123',purpose:'reply',timeoutMs:1000,quietMs:100},st.agentToken);assert.equal(ready.ok,true);assert.equal(ready.quiet,true);
    const sent=await request('send-message',{key:'private:123',messages:[`Synthetic reply ${turn} part A`,`Synthetic reply ${turn} part B`],gapMode:'fixed',gapMs:100},st.agentToken);assert.equal(sent.ok,true,JSON.stringify(sent));
  }
  assert.equal(new Set(sessions).size,3);assert.equal(outgoing.length,6);
  const st=h.getSocialV2State('private:123');assert.equal(h.localChannels.sessions.get(sessions.at(-1)).confirmedSends,2);
  // Explicit natural end is not sleep and must not require a 300-second wait.
  st.recentMessages.push({text:'晚安，不聊了',plain:'晚安，不聊了',isSelf:false,time:Date.now()});
  const before=JSON.stringify(st.wakeConfig);const closed=await request('close',{key:'private:123',reason:'explicit_end',summary:'synthetic natural endpoint'},st.agentToken);
  assert.equal(closed.ok,true,JSON.stringify(closed));assert.equal(closed.wakeKept,true);assert.equal(JSON.stringify(st.wakeConfig),before);
  assert.deepEqual(h.localChannels.sessions.get(sessions.at(-1)).inputs,[]);
  const prompt=h.calls.prompts.at(-1).content[0].text;assert.match(prompt,/qq_close_conversation/);assert.match(prompt,/purpose="reply"/);assert.match(prompt,/只有决定潜水才/);
}));

test('a five-minute wait exits on ingress; its late finish cannot clear the new wait lease',()=>fixture(async({h,incoming,wake,request})=>{
  await incoming('Synthetic first turn');await wake();const firstToken=h.getSocialV2State('private:123').agentToken;
  const oldWait=request('wait',{key:'private:123',timeoutMs:300000,quietMs:100},firstToken);await pause(40);assert.ok(h.activeWaits.has('private:123'));
  const start=Date.now();await incoming('Synthetic next turn');await wake();const token=h.getSocialV2State('private:123').agentToken;
  const newWait=request('wait',{key:'private:123',timeoutMs:900,quietMs:100},token);await pause(30);const lease=h.activeWaits.get('private:123');assert.ok(lease);
  const ended=await oldWait;assert.equal(ended.status,403);assert.ok(Date.now()-start<1500,'must not wait for 300 seconds');assert.equal(h.activeWaits.get('private:123'),lease);
  const duplicate=await request('wait',{key:'private:123',timeoutMs:100},token);assert.equal(duplicate.status,429);
  assert.equal((await newWait).ok,true);assert.equal(h.activeWaits.has('private:123'),false);
}));

test('already sent and unknown deliveries are never requeued as candidate replies',()=>fixture(async({h,incoming,wake,outgoing})=>{
  await incoming('Synthetic already answered request');let sid=await wake();h.localChannels.enterSession(sid);
  await h.localChannels.send('private:123',async()=>{outgoing.push({synthetic:'confirmed'});});
  await incoming('Synthetic new subject');await wake();let pending=h.localChannels.sessions.get(h.state.sessions['private:123']).inputs;
  assert.deepEqual(pending.map(item=>item.text),['Synthetic new subject']);assert.match(h.calls.prompts.at(-1).content[0].text,/已确认发送 1 条/);
  sid=h.state.sessions['private:123'];h.localChannels.enterSession(sid);
  await assert.rejects(()=>h.localChannels.send('private:123',async()=>{outgoing.push({synthetic:'unknown'});throw Error('synthetic network timeout');}));
  await incoming('Synthetic followup after unknown');await wake();pending=h.localChannels.sessions.get(h.state.sessions['private:123']).inputs;
  assert.deepEqual(pending.map(item=>item.text),['Synthetic followup after unknown']);assert.match(h.calls.prompts.at(-1).content[0].text,/无法确认的投递/);assert.equal(outgoing.length,2);
}));

test('new ingress between native burst parts cancels unsent parts without replay or alternate transport',()=>fixture(async({h,incoming,wake,request,outgoing})=>{
  await incoming('Synthetic burst request');await wake();const token=h.getSocialV2State('private:123').agentToken;
  const original=h.localChannels.fetchImpl;let injected=false;
  h.localChannels.fetchImpl=async(url,options)=>{const result=await original(url,options);if(String(url).includes('/send_private_msg')&&!injected){injected=true;await incoming('Synthetic interruption during bubble delivery');}return result;};
  const result=await request('send-message',{key:'private:123',messages:['Synthetic first delivered bubble','Synthetic forbidden second bubble','Synthetic forbidden third bubble'],gapMode:'fixed',gapMs:100},token);
  assert.equal(result.ok,false);assert.equal(outgoing.length,1);await wake();assert.equal(outgoing.length,1);
  const prompt=h.calls.prompts.at(-1).content[0].text;assert.match(prompt,/Synthetic interruption/);assert.doesNotMatch(prompt,/Synthetic forbidden/);
}));

test('handoff interrupts an old typing gap so it cannot occupy the shared send chain for five more seconds',()=>fixture(async({h,incoming,wake,request,outgoing})=>{
  await incoming('Synthetic slow typing request');await wake();h.cfg.socialV2.send.maxGapMs=10000;const token=h.getSocialV2State('private:123').agentToken;
  const burst=request('send-message',{key:'private:123',messages:['Synthetic delivered first part','Synthetic stale delayed second part'],gapMode:'fixed',gapMs:5000},token);
  while(!outgoing.length)await pause(10);await pause(40);
  const start=Date.now();await incoming('Synthetic prompt interruption during typing gap');await wake();const newToken=h.getSocialV2State('private:123').agentToken;
  assert.equal((await burst).ok,false);
  assert.equal((await request('send-message',{key:'private:123',messages:'Synthetic fresh reply after interrupted gap'},newToken)).ok,true);
  assert.ok(Date.now()-start<1800,`cancelled gap occupied send chain for ${Date.now()-start}ms`);assert.equal(outgoing.length,2);
}));

test('late completion of an old prompt cannot remove the newer pending wake owner',()=>fixture(async({h,incoming,wake})=>{
  const prepare=h.localChannels.prepare.bind(h.localChannels);let release,entered;const waiting=new Promise(resolve=>entered=resolve);let first=true;
  h.localChannels.prepare=async(...args)=>{const prompt=await prepare(...args);if(first){first=false;entered();await new Promise(resolve=>release=resolve);}return prompt;};
  await incoming('Synthetic slow prompt request');const old=wake();await waiting;
  await incoming('Synthetic supplement while prompt dispatch is pending');const second=await wake();const owner=h.pendingWakeOwners.get('private:123');assert.ok(owner);
  release();await old;assert.equal(h.state.sessions['private:123'],second);assert.equal(h.pendingWakeOwners.get('private:123'),owner);assert.equal(h.pendingWakeKeys.has('private:123'),true);
}));

test('late old turn/end never clears new session or wake; raw model text is not auto-forwarded',()=>fixture(async({h,incoming,wake,outgoing})=>{
  await incoming('Synthetic old turn');const old=await wake();await incoming('Synthetic current turn');const current=await wake();const owner=h.pendingWakeOwners.get('private:123');
  let release,processed;const observed=new Promise(resolve=>processed=resolve);
  h.api.events.mux=async function*(){yield {payload:{type:'session/event',sessionId:old,event:{type:'turn/end',data:{reason:{kind:'completed'}}}}};processed();await new Promise(resolve=>release=resolve);};
  const pump=h.pumpMux();await observed;assert.equal(h.state.sessions['private:123'],current);assert.equal(h.pendingWakeOwners.get('private:123'),owner);assert.equal(h.pendingWakeKeys.has('private:123'),true);assert.equal(outgoing.length,0);release();await pump;
}));

test('cross-scope epoch changes retire old origins and re-resolve only their own unanswered IDs',()=>fixture(async({h,incoming,wake})=>{
  await incoming('Synthetic private secret request');const privateOld=await wake();
  await incoming('Synthetic public group question',456,'group');const group=await wake('group:456');
  assert.equal(h.localChannels.sessions.has(privateOld),false);assert.ok(h.calls.cancelled.includes(privateOld));
  const groupPrompt=h.calls.prompts.find(item=>item.sessionId===group).content[0].text;assert.match(groupPrompt,/Synthetic public group question/);assert.doesNotMatch(groupPrompt,/Synthetic private secret/);
  const privateNew=await wake();const privatePrompt=h.calls.prompts.find(item=>item.sessionId===privateNew).content[0].text;assert.match(privatePrompt,/Synthetic private secret request/);assert.doesNotMatch(privatePrompt,/Synthetic public group/);
}));

test('correction/deletion never rebase an old origin or revive cached input as proactive work',()=>fixture(async({h,local,incoming,wake,outgoing})=>{
  await incoming('Synthetic original uncorrected statement');const sid=await wake();const old=h.localChannels.sessions.get(sid);
  let row=(await local.management('memory.query')).memories.find(item=>item.statement.includes('uncorrected'));
  await local.management('memory.correct',{id:row.id,statement:'Synthetic current corrected statement',expected_revision:row.revision});
  await assert.rejects(()=>h.localChannels.origin.run(old,()=>h.localChannels.send('private:123',async()=>outgoing.push('must not send'))),error=>error.code==='STALE_CONTEXT');
  await incoming('Synthetic supplemental instruction');await wake();const prompt=h.calls.prompts.at(-1).content[0].text;assert.match(prompt,/Synthetic current corrected statement/);assert.doesNotMatch(prompt,/uncorrected statement/);
  row=(await local.management('memory.query')).memories.find(item=>item.statement==='Synthetic supplemental instruction');
  await local.management('memory.delete',{id:row.id,expected_revision:row.revision});
  // Only deleted source IDs remain: no fresh prompt and no proactive conversion.
  h.localChannels.events.set('private:123',[{id:'999:private:123:2',neverPersisted:false,text:'must not revive'}]);
  await assert.rejects(()=>h.localChannels.prepare('private:123','synthetic-deleted','deleted-token'),error=>error.code==='SOURCE_UNAVAILABLE');assert.equal(outgoing.length,0);
}));

test('duplicate ingress and permission/character/backend changes cannot resurrect a revoked token',()=>fixture(async({h,local,incoming,wake,request,character,outgoing})=>{
  const event=await incoming('Synthetic trusted request');const sid=await wake();const token=h.getSocialV2State('private:123').agentToken;
  const seq=h.getSocialV2State('private:123').lastUnreadSeq;
  await h.handleIncoming('private',123,event,h.cfg);assert.equal(h.state.sessions['private:123'],sid);assert.equal(h.getSocialV2State('private:123').lastUnreadSeq,seq,'duplicate input must not create another unread wake');
  h.cfg.allow.private=[];h.cfg.allowAllWhenEmpty=false;
  assert.equal((await request('send-message',{key:'private:123',messages:'forbidden'},token)).ok,false);
  h.cfg.allow.private=['123'];character({id:'another-synthetic-role',epoch:2});await local.setMode('local');
  h.localChannels.enterSession(sid);await assert.rejects(()=>h.localChannels.send('private:123',async()=>outgoing.push('forbidden')));
  await local.setMode('paused');await assert.rejects(()=>h.localChannels.validateOrigin());assert.equal(outgoing.length,0);
}));

test('late successful validate RPC cannot send bytes after ingress synchronously revoked its original record',()=>fixture(async({h,incoming,wake,outgoing})=>{
  await incoming('Synthetic original request');const oldId=await wake();const old=h.localChannels.sessions.get(oldId);
  const request=h.localChannels.request.bind(h.localChannels);let release,entered;const blocked=new Promise(resolve=>entered=resolve);let held=false;
  h.localChannels.request=async(action,channel,extra)=>{const result=await request(action,channel,extra);if(action==='validate'&&extra.context===old.context&&!held){held=true;entered();await new Promise(resolve=>release=resolve);}return result;};
  const sending=h.localChannels.origin.run(old,()=>h.localChannels.send('private:123',async()=>outgoing.push('forbidden old bytes')));const rejected=assert.rejects(sending,error=>error.code==='BINDING_INVALID');
  await blocked;await incoming('Synthetic supplement after old validation');release();await rejected;assert.equal(outgoing.length,0);
}));

test('successful native close with no send settles displayed input on the next ingress',()=>fixture(async({h,incoming,wake,request})=>{
  await incoming('晚安，不聊了');await wake();const st=h.getSocialV2State('private:123');
  const closed=await request('close',{key:'private:123',reason:'explicit_end'},st.agentToken);
  assert.equal(closed.ok,true);assert.ok(closed.closedAt);assert.equal(closed.blocked,undefined);
  await incoming('Synthetic new request after natural close');await wake();
  assert.deepEqual(h.localChannels.sessions.get(h.state.sessions['private:123']).inputs.map(item=>item.text),['Synthetic new request after natural close']);
}));

test('concurrent same-subject ingress merges both requests without a context-to-ingest epoch race',()=>fixture(async({h,incoming,wake})=>{
  await Promise.all([incoming('Synthetic concurrent original question'),incoming('Synthetic concurrent language supplement')]);
  await wake();const prompt=h.calls.prompts.at(-1).content[0].text;
  assert.match(prompt,/Synthetic concurrent original question/);assert.match(prompt,/Synthetic concurrent language supplement/);
}));

test('native source limit rejects overflow before acceptance and never silently drops an unanswered request',()=>fixture(async({h,incoming})=>{
  for(let index=0;index<20;index++)await incoming(`Synthetic bounded unanswered item ${index}`);
  await assert.rejects(()=>incoming('Synthetic overflow must be retried explicitly'),error=>error.code==='INBOUND_QUEUE_FULL');
  const retained=new Set((h.localChannels.events.get('private:123')||[]).map(item=>item.id));
  for(const record of h.localChannels.sessions.values())for(const input of record.inputs||[])retained.add(input.id);
  assert.equal(retained.size,20);
},{autoWrite:false}));
