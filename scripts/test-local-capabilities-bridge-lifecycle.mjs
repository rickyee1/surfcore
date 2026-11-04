// T3-H attempt2 F1. Native SQLCipher + actual bridge sendToQQ/HTTP recorder.
// Claim/finish use the production host issuer and native HTTP; DSH/QQ are recorders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createChannelHandler } from '../plugins/surfcore/lib/local-capabilities/channel.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
const implementation=process.env.SURFCORE_F1_FROZEN_T3==='1'
  ? path.join(repo,'.local/evidence/t3-h-f1/attempt2/frozen-t3-runtime/src/local-capabilities-bridge.js')
  : process.env.SURFCORE_F1_FROZEN_T6==='1'
  ? path.join(repo,'.local/evidence/t3-h-f1/attempt2/frozen-t6-runtime/src/local-capabilities-bridge.js')
  : path.join(repo,'src/local-capabilities-bridge.js');
const { LocalChannelBridge }=await import(pathToFileURL(implementation));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-f1-')),keyFile=path.join(root,'channel.key');
  const supervisor=new CapabilitySupervisor({python:path.join(repo,'.venv/Scripts/python.exe'),entry:path.join(repo,'services/local-capabilities/server.py'),dataDir:path.join(root,'data'),env:{SURFCORE_LOCAL_KEY:crypto.randomBytes(32).toString('hex'),PYTHONUTF8:'1'}});
  const local=new LocalCapabilities({supervisor,stateFile:path.join(root,'backend.json'),currentCharacter:()=>({id:'synthetic-f1',epoch:1})});
  const handler=createChannelHandler({capabilities:local,keyFile});const server=http.createServer((req,res)=>void handler(req,res));let h;
  try {
    await local.setMode('local');await local.setQqOwner({account:'999',peer:'123'});
    await local.management('attention.configure',{enabled:true,daily_limit:100,cooldown_seconds:0,quiet_start:'',quiet_end:'',timezone:'UTC',muted:false,focused:false});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,bytes=[],settlements=[];
    class FixtureBridge extends LocalChannelBridge {
      constructor(options){super({...options,config:()=>({ownerQQ:123,dsh:{baseUrl:base}}),keyFile,guarded:()=>true,mode:()=>local.mode,fetchImpl:async(url,options)=>{
        if(String(url).startsWith(base))return fetch(url,options);
        bytes.push(JSON.parse(options.body));return new Response(JSON.stringify({status:'ok',retcode:0,data:{message_id:bytes.length}}));
      }});}
    }
    h=await bridgeHarness({config:{sendDelayMs:0,fishGuard:{enabled:false}},globals:{LocalChannelBridge:FixtureBridge,localBackendGuarded:()=>true,localBackendMode:()=>local.mode}});h.setMode('chat');
    let next=1;const ingress=async(text,account=999)=>{
      const event={self_id:account,user_id:123,message_id:next++},ticket=h.localChannels.beginIncoming('private:123',event);
      try{return await h.localChannels.incoming('private:123',event,text);}finally{ticket?.finish();}
    };
    await ingress('SYNTHETIC_OLD_SCOPE_REQUEST');await h.deliverPrompt('private:123','discarded old history');
    const oldId=h.state.sessions['private:123'],old=h.localChannels.sessions.get(oldId);
    const original=h.localChannels.request.bind(h.localChannels);
    h.localChannels.request=async(action,channel,extra)=>{
      const result=await original(action,channel,extra);
      if(action.endsWith('.finish')||action==='attention.finalize')settlements.push({action,...extra?.params,outcome:extra?.outcome??extra?.params?.outcome,nativeOutcome:result.outcome??result.status});
      return result;
    };
    const issue=async kind=>{
      // A proactive delivery starts after the ordinary foreground turn settles.
      await h.localChannels.endSession(oldId);
      const channel=h.localChannels.channels.get('private:123');
      const ownerContext=await local.context({kind:'qq-private',account:'999',peer:'123',principal:'123'});
      if(kind==='tool')return handler.issueToolDelivery({channel,context:ownerContext,text:'SYNTHETIC_LATE_CLAIM_BODY',memory_write:false,expiresAt:Date.now()+60000,guard:()=>local.validate(ownerContext),syncGuard:()=>{}});
      const publicContext=await local.context({kind:'bili',account:'999',peer:'public',principal:'public'});
      return handler.issueIntent({publicContext,ownerContext,channel,text:'SYNTHETIC_LATE_CLAIM_BODY',outreachId:'synthetic-issued-outreach',active:()=>true});
    };
    await run({h,local,bytes,settlements,old,oldId,ingress,original,issue,handler});
  } finally {
    await h?.close();await new Promise(resolve=>server.close(resolve));await supervisor.stop();
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('surfcore-f1-'));fs.rmSync(root,{recursive:true,force:true});
  }
}

for(const kind of ['ordinary','tool','companion'])test(`F1 ${kind}: final successful async check after emergency/invalidate/retire produces zero actual HTTP bytes`,()=>fixture(async({h,local,bytes,settlements,old,oldId})=>{
  if(kind==='tool')Object.assign(old,{toolDelivery:true,expiresAt:Date.now()+60000,guard:async()=>{}});
  if(kind==='companion')Object.assign(old,{proactive:true,intent:true,outreachId:'synthetic-companion-f1',expiresAt:Date.now()+60000,guard:async()=>{}});
  const ready=deferred(),release=deferred(),request=h.localChannels.request.bind(h.localChannels);let validates=0,checks=0,held=false;
  h.localChannels.request=async(action,...args)=>{
    const result=await request(action,...args);if(action==='validate')validates++;if(action==='attention.check')checks++;
    const final=kind==='ordinary'?action==='validate'&&validates===1:kind==='tool'?action==='validate'&&validates===2:action==='attention.check'&&checks===2;
    if(final&&!held){held=true;ready.resolve();await release.promise;}return result;
  };
  const sending=h.localChannels.origin.run(old,()=>h.sendToQQ('private:123','SYNTHETIC_OLD_PENDING_REPLY'));
  // Convert rejection to data while the RPC is held, avoiding unhandled promises.
  const outcome=sending.then(()=>({sent:true}),error=>({error}));await ready.promise;
  h.localChannels.invalidate();h.retireSession('private:123');await local.management('tool.emergency.stop',{});release.resolve();
  await outcome;assert.equal(bytes.length,0,`sessions=${h.localChannels.sessions.size}, sends=${bytes.length}`);
  // sendToQQ reports failed sends through its native activity path; its return
  // value is not a transport receipt. Assert the actual recorder, never resolve/reject alone.
  assert.equal(h.localChannels.sessions.size,0);assert.equal(h.localChannels.tokens.size,0);assert.ok(h.calls.cancelled.includes(oldId));
  if(kind==='companion')assert.ok(settlements.some(item=>item.action==='attention.finalize'&&item.outcome==='failed'));
}));

for(const kind of ['tool','companion'])test(`F1 late ${kind} claim cannot register an old record or deliver after invalidate/reset`,()=>fixture(async({h,local,bytes,settlements,old,issue,handler})=>{
  const ready=deferred(),release=deferred(),request=h.localChannels.request.bind(h.localChannels);
  const claimAction=kind==='tool'?'tool.delivery.claim':'intent.claim',identifier=await issue(kind);let callbacks=0;
  h.localChannels.request=async(action,channel,extra)=>{
    const result=await request(action,channel,extra);
    if(action===claimAction){ready.resolve();await release.promise;}
    return result;
  };
  const method=kind==='tool'?'withToolDelivery':'withIntent';
  const running=h.localChannels[method](identifier,{guard:async()=>{},deliver:async(text,key)=>{callbacks++;return h.sendToQQ(key,text);}});
  const outcome=running.then(()=>({delivered:true}),error=>({error}));await ready.promise;
  h.localChannels.invalidate();h.retireSession('private:123');await local.management('tool.emergency.stop',{});await local.management('tool.emergency.reset',{});release.resolve();
  const result=await outcome;assert.equal(callbacks,0,'old claim must not expose body to a deliver callback');assert.equal(bytes.length,0);assert.ok(result.error);assert.equal(result.error.deliveryOutcome,'failed');
  assert.equal(h.localChannels.sessions.size,0);assert.equal(h.localChannels.tokens.size,0);
  assert.ok(settlements.some(item=>item.action===(kind==='tool'?'tool.delivery.finish':'intent.finish')&&item.outcome==='failed'&&item.nativeOutcome==='failed'));
  if(kind==='companion')assert.equal(handler.intentStatus(identifier),'failed');
}));

test('F1 late prepare cannot replace new scope after invalidate, reset and a fresh account ingress',()=>fixture(async({h,local,old,ingress,bytes})=>{
  const ready=deferred(),release=deferred(),request=h.localChannels.request.bind(h.localChannels);let held=false;
  // queue a second native source so prepare's final awaited step is refine.
  await ingress('SYNTHETIC_PREPARE_REQUEST');
  h.localChannels.request=async(action,...args)=>{const result=await request(action,...args);if(action==='context.refine'&&!held){held=true;ready.resolve();await release.promise;}return result;};
  const preparing=h.localChannels.prepare('private:123','synthetic-late-prepare','synthetic-old-token');const outcome=preparing.then(prompt=>({prompt}),error=>({error}));await ready.promise;
  h.localChannels.invalidate();h.retireSession('private:123');await local.management('tool.emergency.stop',{});await local.management('tool.emergency.reset',{});
  // Reach the same per-key input revision as before reset. Revision equality
  // alone must not authorize the older lifecycle or account scope.
  await ingress('SYNTHETIC_NEW_SCOPE_ONE',1000);await ingress('SYNTHETIC_NEW_SCOPE_TWO',1000);
  release.resolve();const result=await outcome;assert.ok(result.error,'old successful prepare must be rejected');assert.equal(h.localChannels.sessions.has('synthetic-late-prepare'),false);assert.equal(h.localChannels.tokens.has('synthetic-old-token'),false);assert.equal(bytes.length,0);
  const prompt=await h.localChannels.prepare('private:123','synthetic-current-prepare','synthetic-current-token');
  assert.match(prompt,/SYNTHETIC_NEW_SCOPE/);assert.doesNotMatch(prompt,/SYNTHETIC_OLD_SCOPE_REQUEST|SYNTHETIC_PREPARE_REQUEST/);assert.equal(h.localChannels.sessions.get('synthetic-current-prepare').channel.account,'1000');
}));

test('F1 actual transport already attempted stays unknown and is never retried after invalidate',()=>fixture(async({h,bytes,old})=>{
  const ready=deferred(),release=deferred();let attempts=0;
  const sending=h.localChannels.origin.run(old,()=>h.localChannels.send('private:123',async()=>{attempts++;bytes.push({synthetic:'attempted'});ready.resolve();await release.promise;throw Error('synthetic uncertain transport');}));
  const outcome=sending.then(()=>({}),error=>({error}));await ready.promise;h.localChannels.invalidate();h.retireSession('private:123');release.resolve();const result=await outcome;
  assert.ok(result.error);assert.equal(old.uncertain,true);
  await assert.rejects(()=>h.localChannels.origin.run(old,()=>h.localChannels.send('private:123',async()=>{attempts++;})));assert.equal(attempts,1);
}));

for(const kind of ['tool','companion'])test(`F1 ${kind} native unknown settlement survives invalidate and fresh ingress without replay`,()=>fixture(async({h,bytes,settlements,issue,handler,ingress})=>{
  const identifier=await issue(kind),method=kind==='tool'?'withToolDelivery':'withIntent';let attempts=0;
  await assert.rejects(()=>h.localChannels[method](identifier,{guard:async()=>{},deliver:(_text,key)=>h.localChannels.send(key,async()=>{
    attempts++;bytes.push({synthetic:'uncertain-native-delivery'});h.localChannels.invalidate();h.retireSession(key);throw Error('synthetic ambiguous transport');
  })}),error=>error.deliveryOutcome==='unknown');
  assert.ok(settlements.some(item=>item.action===(kind==='tool'?'tool.delivery.finish':'intent.finish')&&item.nativeOutcome==='unknown'));
  if(kind==='companion')assert.equal(handler.intentStatus(identifier),'unknown');
  await ingress('SYNTHETIC_FRESH_AFTER_UNKNOWN');
  await assert.rejects(()=>h.localChannels[method](identifier,{guard:async()=>{},deliver:async()=>{attempts++;}}));
  assert.equal(attempts,1);assert.equal(bytes.length,1);
}));

test('F1 queued ingress and late turn.begin cannot refill channels or sources after invalidation',()=>fixture(async({h,ingress})=>{
  const ready=deferred(),release=deferred(),request=h.localChannels.request.bind(h.localChannels);let held=false;
  h.localChannels.request=async(action,...args)=>{const result=await request(action,...args);if(action==='turn.begin'&&!held){held=true;ready.resolve();await release.promise;}return result;};
  const first=ingress('SYNTHETIC_QUEUED_OLD_ONE').then(()=>({accepted:true}),error=>({error}));
  const second=ingress('SYNTHETIC_QUEUED_OLD_TWO').then(()=>({accepted:true}),error=>({error}));
  await ready.promise;h.localChannels.invalidate();h.retireSession('private:123');release.resolve();
  assert.ok((await first).error);assert.ok((await second).error);assert.equal(h.localChannels.channels.size,0);assert.equal(h.localChannels.events.size,0);assert.equal(h.localChannels.sessions.size,0);
  await ingress('SYNTHETIC_CURRENT_INGRESS');assert.equal(h.localChannels.channels.size,1);assert.equal(h.localChannels.events.get('private:123').length,1);
}));

test('F1 a duplicate pre-reset platform event cannot restore cached identity without a fresh accepted source',()=>fixture(async({h,ingress})=>{
  h.localChannels.invalidate();h.retireSession('private:123');
  const duplicate=await h.localChannels.incoming('private:123',{self_id:999,user_id:123,message_id:1},'SYNTHETIC_OLD_SCOPE_REQUEST');
  assert.equal(duplicate.duplicate,true);assert.equal(h.localChannels.channels.size,0);
  await assert.rejects(()=>h.localChannels.withToolDelivery('synthetic-old-id',{guard:async()=>{},deliver:async()=>{throw Error('must not deliver');}}),error=>error.code==='BINDING_INVALID');
  await ingress('SYNTHETIC_ACTUAL_FRESH_REQUEST');assert.equal(h.localChannels.channels.size,1);
}));
