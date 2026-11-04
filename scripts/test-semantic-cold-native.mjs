// Native QQ prompt wrapper -> authenticated channel HTTP -> real SQLCipher authority.
// Only semantic worker timing/results and DSH model/platform transports are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { MessageChain, text } from '@snowluma/sdk';
const repo=path.resolve(import.meta.dirname,'..'), root=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-semantic-cold-'));
process.env.DSH_HOME=path.join(root,'home');process.env.SURFCORE_ROOT=path.join(root,'qq');
fs.mkdirSync(path.join(process.env.SURFCORE_ROOT,'src'),{recursive:true});fs.writeFileSync(path.join(process.env.SURFCORE_ROOT,'src/bridge.js'),'// synthetic');fs.writeFileSync(path.join(process.env.SURFCORE_ROOT,'config.json'),'{}');
const {CapabilitySupervisor}=await import('../plugins/surfcore/lib/local-capabilities/supervisor.js');
const {LocalCapabilities}=await import('../plugins/surfcore/lib/local-capabilities/facade.js');
const {createChannelHandler}=await import('../plugins/surfcore/lib/local-capabilities/channel.js');
const {refineSemanticContext}=await import('../plugins/surfcore/lib/local-capabilities/semantic-context.js');
const {createSemanticWriter}=await import('../plugins/surfcore/lib/local-capabilities/semantic-writer.js');
const {LocalChannelBridge}=await import('../src/local-capabilities-bridge.js');
const {bridgeHarness}=await import('./audit-bridge-harness.mjs');
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const listen=async fn=>{const s=http.createServer(fn);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s};
const base=s=>'http://127.0.0.1:'+s.address().port;
async function checkConsoleCleanupUi(kind, result) {
 const html = fs.readFileSync(path.join(repo, 'public/console.html'), 'utf8');
 const markers = {
   restart: ["document.getElementById('restartBtn').addEventListener", "document.getElementById('clearWsBtn').addEventListener"],
   workspace: ["document.getElementById('clearWsBtn').addEventListener", "document.getElementById('aiNotifySend').addEventListener"],
   session: ["box.querySelectorAll('[data-reset-key]').forEach", '  } catch {}'],
 };
 const [start, end] = markers[kind], offset = html.indexOf(start);
 assert.ok(offset >= 0); const stop = html.indexOf(end, offset); assert.ok(stop > offset);
 const nodes = new Map(), alerts = [], calls = [];
 const node = id => { if (!nodes.has(id)) nodes.set(id, { dataset: { resetKey: 'private:123' }, textContent: '', className: '', addEventListener(_event, callback) { this.click = callback; } }); return nodes.get(id); };
 const api = async route => { calls.push(route); return result; };
 new Function('document', 'box', 'api', 'confirm', 'alert', 'refreshSessions', 'refresh', html.slice(offset, stop))(
   { getElementById: node }, { querySelectorAll: () => [node('session')] }, api, () => true, value => alerts.push(value), () => {}, () => {},
 );
 await node(kind === 'restart' ? 'restartBtn' : kind === 'workspace' ? 'clearWsBtn' : 'session').click();
 assert.deepEqual(calls, [kind === 'restart' ? '/api/restart' : '/api/' + kind + '/reset']);
 const output = kind === 'session' ? alerts[0] : node(kind === 'restart' ? 'restartMsg' : 'clearWsMsg').textContent;
 if (result.ok === false) {
   for (const value of [result.code, result.error, result.hint]) assert.ok(output.includes(value));
   assert.doesNotMatch(output, /正在重启/);
   if (kind !== 'session') assert.equal(node(kind === 'restart' ? 'restartMsg' : 'clearWsMsg').className, 'meta err');
 } else assert.ok(output && !output.includes('❌'));
}
let count=0;
async function withCleanupStatus(f, body) {
 const server = f.h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
 const status = async (headers = {}) => (await fetch('http://127.0.0.1:' + server.address().port + '/api/status', { headers: { 'x-console-token': 'fixture-console-token', ...headers } })).json();
 try { await body(status); } finally { await new Promise(resolve => server.close(resolve)); }
}
function checkCleanupStatusUi(...statuses) {
 const html = fs.readFileSync(path.join(repo, 'public/console.html'), 'utf8'), start = html.indexOf('function renderLocalCleanup('), end = html.indexOf('async function refresh()', start);
 assert.ok(start >= 0 && end > start);
 const warning = { style: {}, textContent: '' };
 const render = new Function('document', html.slice(start, end) + '\nreturn renderLocalCleanup;')({ getElementById: id => { assert.equal(id, 'localCleanupWarn'); return warning; } });
 for (const status of statuses) {
   render(status);
   if (status.failed || status.pending) {
     assert.equal(warning.style.display, 'block');
     for (const value of [status.code, status.error, status.hint]) assert.ok(value && warning.textContent.includes(value));
   } else { assert.equal(warning.style.display, 'none'); assert.equal(warning.textContent, ''); }
 }
}
async function fixture(name,body,{processStub}={}){
 const dir=path.join(root,name);let character={id:name,epoch:1};let time=0,state='unloaded',elapsed=37000,job,hook,wallDelay=0;let cancels=0,starts=0,statuses=0;
 const supervisor=new CapabilitySupervisor({python:path.join(repo,'.venv/Scripts/python.exe'),entry:path.join(repo,'services/local-capabilities/server.py'),dataDir:path.join(dir,'data'),env:{SURFCORE_LOCAL_KEY:crypto.randomBytes(32).toString('hex')}});
 const local=new LocalCapabilities({supervisor,stateFile:path.join(dir,'state.json'),currentCharacter:()=>character});
 const raw=supervisor.raw.bind(supervisor);supervisor.raw=async(op,binding,params)=>{
  if(op==='memory.semantic.status')return{enabled:true,model_state:state};
  if(op==='memory.semantic.query.start'){starts++;job={job_id:'synthetic-job',state:'running',memory_epoch:params.expected_memory_epoch,character_epoch:binding.character_epoch,kind:'query',coverage:{offset:0,page_size:64,eligible_count:1,has_more:false,next_offset:null,complete:true}};if(hook)await hook();return job;}
  if(op==='memory.semantic.job.status'){statuses++;if(wallDelay)await pause(wallDelay);time+=elapsed;return{...job,state:'succeeded',memories:[{id:'synthetic-semantic-hit',statement:'合成相关路线',semantic_score:.9}]};}
  if(op==='memory.semantic.job.cancel'){cancels++;return{state:'cancelled'};}
  return raw(op,binding,params);
 };
 local.refineContext=(ctx,q,options)=>refineSemanticContext(local,ctx,q,{...options,now:()=>time,requestStartedAt:0,deadlineAt:Infinity,wait:async ms=>{time+=ms}});
 const keyFile=path.join(dir,'channel.key'),handler=createChannelHandler({capabilities:local,keyFile});
 let outbound=[],h,host,platform;
 try{
  await local.setMode('local');local.semanticWriter=createSemanticWriter({capabilities:local,debounceMs:3600000});host=await listen((req,res)=>void handler(req,res));
  platform=await listen((req,res)=>void(async()=>{let raw='';for await(const chunk of req)raw+=chunk;outbound.push(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:outbound.length}}));})());
  class Adapter extends LocalChannelBridge{constructor(options){super({...options,currentCharacter:()=>character,config:()=>({...options.config(),dsh:{baseUrl:base(host)}}),keyFile,guarded:()=>true,mode:()=>'local'})}}
  h=await bridgeHarness({config:{ownerQQ:'123',allow:{private:['123'],groups:[]},snowluma:{httpUrl:base(platform)},sendDelayMs:0},globals:{MessageChain,text,...(processStub?{process:processStub}:{}),LocalChannelBridge:Adapter,localBackendGuarded:()=>true,localBackendMode:()=>'local',__auditMuxOnce:true}});h.setMode('chat');
  await h.localChannels.incoming('private:123',{self_id:999,user_id:123,message_id:1},'合成测试问题（不得泄露进通知）');
  const sid=await h.ensureSession('private:123');
  const run=(extra={})=>h.api.sessions.prompt({sessionId:sid,content:[{type:'text',text:'must be replaced'}],...extra});
  await body({h,run,sid,local,outbound,counts:()=>({cancels,starts,statuses}),useWallClock(ms){wallDelay=ms;local.refineContext=(ctx,q,options)=>refineSemanticContext(local,ctx,q,options)},setState:v=>state=v,setElapsed:v=>elapsed=v,setHook:v=>hook=v,changeRole:()=>{character={id:name+'-other',epoch:2}},host,handler,base:base(host)});
  console.log('ok '+(++count)+' '+name);
 }finally{if(h)await h.close();if(platform)await new Promise(r=>platform.close(r));if(host){host.closeAllConnections();await new Promise(r=>host.close(r));}local.semanticWriter?.dispose();await supervisor.stop();}
}
try{
await fixture('native-cold-37s',async f=>{await f.run();assert.equal(f.h.calls.prompts.length,1);assert.match(f.h.calls.prompts[0].content[0].text,/合成相关路线/);assert.equal(f.outbound.length,1);assert.match(f.outbound[0].message[0].data.text,/首次加载/);assert.doesNotMatch(JSON.stringify(f.outbound),/不得泄露|合成相关路线/);assert.equal(f.counts().starts,1);});

await fixture('cold-single-ndjson-response',async f=>{
 const a=f.h.localChannels,fetcher=a.fetchImpl;let count=0,wire;
 a.fetchImpl=async(url,options)=>{const res=await fetcher(url,options);if(JSON.parse(options.body).action==='context.refine'){count++;assert.equal(res.headers.get('content-type'),'application/x-ndjson');wire=res.clone().text()}return res};
 await f.run();const frames=(await wire).trim().split('\n').map(JSON.parse);assert.equal(count,1);assert.equal(frames.length,2);assert.equal(frames[0].progress.state,'loading');assert.equal(frames[1].ok,true);assert.equal(f.counts().starts,1);assert.equal(f.h.calls.prompts.length,1);
});
await fixture('native-cold-real-over-15s-http',async f=>{f.useWallClock(16050);const at=Date.now();await f.run();assert.ok(Date.now()-at>=16000);assert.equal(f.h.calls.prompts.length,1);assert.equal(f.outbound.length,1);assert.equal(f.counts().starts,1);});
await fixture('native-cold-120s-terminal',async f=>{f.setElapsed(120001);await assert.rejects(f.run(),e=>e.code==='SEMANTIC_CONTEXT_TIMEOUT');assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,2);assert.match(f.outbound[1].message[0].data.text,/尚未生成回答/);assert.equal(f.counts().cancels,1);assert.equal(f.h.localChannels.events.get('private:123').length,1);});
await fixture('native-ready-8s-terminal',async f=>{f.setState('ready');f.setElapsed(8001);await assert.rejects(f.run(),e=>e.code==='SEMANTIC_CONTEXT_TIMEOUT');assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,1);assert.match(f.outbound[0].message[0].data.text,/尚未生成回答/);assert.equal(f.counts().starts,1);});
await fixture('native-cancel-late-start',async f=>{f.setState('ready');const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});const running=f.run(),rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await entered.promise;await f.h.api.stopSessionWork(f.sid);await rejected;gate.resolve();for(let i=0;i<50&&!f.counts().cancels;i++)await pause(10);assert.equal(f.counts().cancels,1);assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);});
await fixture('native-outer-abort',async f=>{f.setState('ready');const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});const controller=new AbortController();const running=f.run({signal:controller.signal}),rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await entered.promise;controller.abort();await rejected;gate.resolve();for(let i=0;i<50&&!f.counts().cancels;i++)await pause(10);assert.equal(f.counts().cancels,1);assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);});
await fixture('native-role-change-no-late-model',async f=>{f.setState('ready');const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});const running=f.run(),rejected=assert.rejects(running,e=>['STALE_CONTEXT','STALE_CHARACTER','ROLE_PACKAGE_STALE'].includes(e.code));await entered.promise;f.changeRole();gate.resolve();await rejected;assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);assert.equal(f.counts().cancels,1);});
await fixture('native-permission-change-no-model',async f=>{f.setState('ready');f.setElapsed(1);const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});const running=f.run(),rejected=assert.rejects(running,e=>e.code==='TURN_SUPERSEDED');await entered.promise;f.h.cfg.allow.private=[];gate.resolve();await rejected;assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);});
await fixture('native-authority-invalidate-aborts',async f=>{f.setState('ready');const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});const running=f.run(),rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await entered.promise;f.h.localChannels.invalidate();await rejected;gate.resolve();for(let i=0;i<50&&!f.counts().cancels;i++)await pause(10);assert.equal(f.counts().cancels,1);assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);});
await fixture('native-cancel-during-auth',async f=>{const gate=deferred(),entered=deferred(),controller=new AbortController(),a=f.h.localChannels,original=a.authHeaders;a.authHeaders=()=>{entered.resolve();return gate.promise};const channel=a.channels.get('private:123');const running=a.request('context.refine',channel,{context:a.events.get('private:123')[0].context},{signal:controller.signal});const rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await entered.promise;controller.abort();await rejected;gate.resolve({});a.authHeaders=original;assert.equal(f.counts().starts,0);assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);});
await fixture('native-permission-retirement-cancels-job',async f=>{f.setState('ready');const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});const running=f.run(),rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await entered.promise;f.h.cfg.allow.private=[];f.h.retireSession('private:123');await rejected;gate.resolve();for(let i=0;i<50&&!f.counts().cancels;i++)await pause(10);assert.equal(f.counts().cancels,1);assert.equal(f.h.calls.prompts.length,0);assert.equal(f.outbound.length,0);});

// Keep the actual native successor creation, HTTP authority and Writer lease.

await fixture('cancel-original-preparation',async f=>{
 f.setState('ready');const entered=deferred(),gate=deferred();f.setHook(async()=>{entered.resolve();await gate.promise});
 const first=f.run(),cancelled=assert.rejects(first,e=>e.code==='REQUEST_CANCELLED');await entered.promise;
 await assert.rejects(f.run(),e=>e.code==='STALE_CONTEXT');await f.h.api.stopSessionWork(f.sid);await cancelled;gate.resolve();
 assert.equal(f.h.calls.prompts.length,0);assert.equal(f.h.localChannels.sessions.has(f.sid),false);assert.equal(f.h.localChannels.preparations.size,0);assert.equal(f.local.semanticWriter.status().foreground,0);
});
await fixture('cancel-released-old',async f=>{
 f.setState('ready');f.setElapsed(1);await f.run();const before=f.h.calls.prompts.length,a=f.h.localChannels,old=a.sessions.get(f.sid);
 await a.incoming('private:123',{self_id:999,user_id:123,message_id:2},'second synthetic');const next=await f.h.ensureSession('private:123');assert.notEqual(next,f.sid);await old.releasePromise;assert.equal(old.writerReleased,true);
 const release=a.releaseRecord.bind(a);let stopped=false;
 a.releaseRecord=record=>{const result=release(record);if(record===old&&!stopped){stopped=true;queueMicrotask(()=>void f.h.api.stopSessionWork(next));}return result};
 await assert.rejects(f.h.api.sessions.prompt({sessionId:next,content:[]}),e=>e.code==='REQUEST_CANCELLED'&&!!e.hint);
 assert.equal(stopped,true);assert.equal(a.sessions.has(next),false);assert.equal(f.h.calls.prompts.length,before);assert.equal(a.preparations.size,0);
 await pause(30);assert.equal(f.local.semanticWriter.status().foreground,0);assert.equal(old.writerReleased,true);
});

await fixture('cancel-successor-end-wait',async f=>{
 f.setState('ready');f.setElapsed(1);await f.run();const a=f.h.localChannels,old=a.sessions.get(f.sid),before=f.h.calls.prompts.length,request=a.request.bind(a),ending=deferred(),gate=deferred();
 a.request=async(action,channel,extra,...rest)=>{if(action==='turn.end'&&extra.context===old.context){ending.resolve();await gate.promise}return request(action,channel,extra,...rest)};
 await a.incoming('private:123',{self_id:999,user_id:123,message_id:2},'second synthetic');const next=await f.h.ensureSession('private:123');assert.notEqual(next,f.sid);await ending.promise;assert.notEqual(old.writerReleased,true);assert.equal(old.allocation.cleanup.state,'pending');assert.ok(f.local.semanticWriter.status().foreground>0);
 const release=a.releaseRecord.bind(a),waiting=deferred();a.releaseRecord=record=>{if(record===old)waiting.resolve();return release(record)};
 const running=f.h.api.sessions.prompt({sessionId:next,content:[]}),rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await waiting.promise;await f.h.api.stopSessionWork(next);gate.resolve();await rejected;
 assert.equal(a.sessions.has(next),false);assert.equal(f.h.calls.prompts.length,before);assert.equal(f.local.semanticWriter.status().foreground,0);await pause(20);assert.equal(f.local.semanticWriter.status().foreground,0);
});
await fixture('cancel-old-end-await',async f=>{
 f.setState('ready');f.setElapsed(1);const a=f.h.localChannels;await a.prepare('private:123','previous-id');const old=a.sessions.get('previous-id');assert.equal(old.writerReleased,undefined);
 await a.incoming('private:123',{self_id:999,user_id:123,message_id:2},'second synthetic');
 const request=a.request.bind(a),entered=deferred(),gate=deferred();let held=false;
 a.request=async(action,channel,extra,...rest)=>{if(action==='turn.end'&&extra.context===old.context&&!held){held=true;entered.resolve();await gate.promise;}return request(action,channel,extra,...rest)};
 const running=f.run(),rejected=assert.rejects(running,e=>e.code==='REQUEST_CANCELLED');await entered.promise;await f.h.api.stopSessionWork(f.sid);gate.resolve();await rejected;
 assert.equal(a.sessions.has(f.sid),false);assert.equal(f.h.calls.prompts.length,0);assert.equal(old.writerReleased,true);assert.equal(f.local.semanticWriter.status().foreground,0);
});
for(const kind of ['stop','outer'])await fixture('cancel-before-submit-'+kind,async f=>{
 f.setState('ready');f.setElapsed(1);const a=f.h.localChannels,prepare=a.prepare.bind(a),controller=new AbortController();let record;
 a.prepare=async(...args)=>{const prompt=await prepare(...args);record=a.sessions.get(f.sid);if(kind==='stop')await f.h.api.stopSessionWork(f.sid);else controller.abort();return prompt};
 await assert.rejects(f.run({signal:controller.signal}),e=>e.code==='REQUEST_CANCELLED');
 assert.equal(f.h.calls.prompts.length,0);assert.throws(()=>a.assertRecord(record),e=>e.code==='REQUEST_CANCELLED');assert.equal(record.writerReleased,true);assert.equal(f.local.semanticWriter.status().foreground,0);
});
await fixture('ready-auth-nine-seconds',async f=>{
 f.setState('ready');f.useWallClock(0);const a=f.h.localChannels,request=a.request.bind(a),auth=a.authHeaders;let refining=false,authDone;
 a.request=async(action,...args)=>{if(action==='context.refine')refining=true;try{return await request(action,...args)}finally{refining=false}};
 a.authHeaders=()=>refining?(authDone=pause(9000).then(()=>auth())):auth();
 const at=Date.now();await assert.rejects(f.run(),e=>e.code==='SEMANTIC_CONTEXT_TIMEOUT'&&!!e.hint);assert.ok(Date.now()-at<8800);await authDone;
 assert.equal(f.counts().starts,0);assert.equal(f.h.calls.prompts.length,0);assert.equal(f.local.semanticWriter.status().foreground,0);
});
await fixture('ready-original-http-clock',async f=>{
 f.setState('ready');f.useWallClock(0);const a=f.h.localChannels,fetcher=a.fetchImpl,clock=Date.now;let shift=0,requestBody;
 a.fetchImpl=async(url,options)=>{const data=JSON.parse(options.body);if(data.action==='context.refine'){requestBody=data;shift=9000;}return fetcher(url,options)};
 try{Date.now=()=>clock()+shift;await assert.rejects(f.run(),e=>e.code==='SEMANTIC_CONTEXT_TIMEOUT');assert.equal(requestBody.readyDeadlineAt-requestBody.requestStartedAt,8000);assert.equal(requestBody.deadlineAt-requestBody.requestStartedAt,120000);assert.equal(f.counts().starts,0);assert.equal(f.h.calls.prompts.length,0);}finally{Date.now=clock;}
});

for (const phase of ['context', 'beginTurn', 'response', 'parse-failure', 'bad-envelope']) await fixture('lease-cancel-' + phase.toLowerCase(), async f => {
 f.setState('ready'); f.setElapsed(1);
 const a = f.h.localChannels, entered = deferred(), gate = deferred(), completed = deferred();
 const context = f.local.context.bind(f.local), begin = f.local.beginTurn.bind(f.local), fetcher = a.fetchImpl;
 const released = [], end = f.local.endTurn.bind(f.local);
 f.local.endTurn = lease => { if (lease) released.push(lease); return end(lease); };
 if (phase === 'context') f.local.context = async (...args) => { entered.resolve(); await gate.promise; const value = await context(...args); completed.resolve(); return value; };
 if (phase === 'beginTurn') f.local.beginTurn = async (...args) => { entered.resolve(); await gate.promise; const value = await begin(...args); completed.resolve(); return value; };
 if (['response', 'parse-failure', 'bad-envelope'].includes(phase)) a.fetchImpl = async (url, options) => {
   const response = await fetcher(url, options), input = JSON.parse(options.body);
   if (input.action === 'turn.begin') { const json = response.json.bind(response); response.json = async () => {
     const result = await json(); entered.resolve(); await gate.promise; completed.resolve();
     if (phase === 'parse-failure') throw new SyntaxError('synthetic parse boundary');
     return phase === 'bad-envelope' ? { unexpected: true } : result;
   }; } return response;
 };
 const running = f.run();
 const rejected = assert.rejects(running, error => ['REQUEST_CANCELLED', 'SERVICE_UNAVAILABLE', 'PROTOCOL_MISMATCH'].includes(error.code) && !!error.hint && !!error.error);
 await entered.promise;
 if (!['parse-failure', 'bad-envelope'].includes(phase)) { await f.h.api.stopSessionWork(f.sid); await rejected; }
 gate.resolve(); await completed.promise; await rejected;
 for (let i = 0; i < 100 && (f.local.semanticWriter.status().foreground || a.allocations.size); i++) await pause(10);
 assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(a.allocations.size, 0);
 assert.equal(released.length, 1); assert.equal(new Set(released).size, 1);
 assert.equal(f.h.calls.prompts.length, 0); assert.equal(a.preparations.size, 0); assert.equal(a.sessions.size, 0);
});
await fixture('lease-request-identity', async f => {
 const a = f.h.localChannels, channel = a.channels.get('private:123');
 const identity = () => ({ bridgeInstance: a.activityEpoch, requestId: crypto.randomUUID(), requestIssuedAt: Date.now() });
 // Raw authenticated HTTP preserves the supplied identity for deliberate replay checks.
 const call = async (action, who, fields) => { const response = await fetch(f.base + '/dsh-surfcore/api/local-capabilities/channel', {
   method: 'POST', headers: { 'content-type': 'application/json', 'x-surfcore-channel-key': fs.readFileSync(a.keyFile, 'utf8').trim() },
   body: JSON.stringify({ action, channel: who, ...fields }),
 }); return response.json(); };
 const old = identity(), next = identity(), before = f.local.semanticWriter.status().foreground;
 const first = await call('turn.begin', channel, old), second = await call('turn.begin', channel, next);
 assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(f.local.semanticWriter.status().foreground, before + 2);
 await call('turn.cancel', { ...channel, peer: '456', principal: '456' }, old);
 await call('turn.cancel', channel, { ...old, bridgeInstance: crypto.randomUUID() });
 assert.equal(f.local.semanticWriter.status().foreground, before + 2);
 await call('turn.cancel', channel, old); await call('turn.cancel', channel, old);
 assert.equal(f.local.semanticWriter.status().foreground, before + 1);
 const replay = await call('turn.begin', channel, old); assert.equal(replay.code, 'REQUEST_CANCELLED'); assert.ok(replay.error && replay.hint);
 const ended = await call('turn.end', channel, { context: second.result.context }); assert.equal(ended.ok, true);
 assert.equal(f.local.semanticWriter.status().foreground, before);
 const cancelled = identity(); await call('turn.cancel', channel, cancelled);
 const late = await call('turn.begin', channel, cancelled); assert.equal(late.code, 'REQUEST_CANCELLED');
 const expired = await call('turn.begin', channel, { ...identity(), requestIssuedAt: Date.now() - 60001 });
 assert.equal(expired.code, 'REQUEST_CANCELLED'); assert.ok(expired.error && expired.hint);
 assert.equal(f.local.semanticWriter.status().foreground, before);
});
for (const phase of ['context', 'beginTurn', 'success']) await fixture('lease-dispose-' + phase.toLowerCase(), async f => {
 f.setState('ready'); f.setElapsed(1);
 const entered = deferred(), gate = deferred(), done = deferred();
 if (phase === 'success') { await f.run(); assert.equal(f.local.semanticWriter.status().foreground, 1); f.handler.dispose(); assert.equal(f.local.semanticWriter.status().foreground, 0); return; }
 const original = f.local[phase].bind(f.local);
 f.local[phase] = async (...args) => { entered.resolve(); await gate.promise; const result = await original(...args); done.resolve(); return result; };
 const running = f.run(), rejected = assert.rejects(running, error => error.code === 'REQUEST_CANCELLED');
 await entered.promise; f.handler.dispose(); gate.resolve(); await done.promise; await rejected;
 assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(f.h.calls.prompts.length, 0);
});
await fixture('lease-client-dispose', async f => {
 f.setState('ready'); f.setElapsed(1); await f.run();
 assert.equal(f.local.semanticWriter.status().foreground, 1);
 await f.h.localChannels.dispose(); assert.equal(f.local.semanticWriter.status().foreground, 0);
});

for (const failure of ['network-after-finish', 'host-context-error', 'cleanup-failure']) await fixture('lease-' + failure, async f => {
 const a = f.h.localChannels, fetcher = a.fetchImpl; let begins = 0, cancels = 0;
 if (failure === 'host-context-error') f.local.context = async () => { throw Error('synthetic context failure'); };
 a.fetchImpl = async (url, options) => {
   const action = JSON.parse(options.body).action;
   if (action === 'turn.begin') begins++;
   if (action === 'turn.cancel') { cancels++; if (failure === 'cleanup-failure') throw Error('synthetic cleanup unavailable'); }
   const response = await fetcher(url, options);
   if (action === 'turn.begin' && failure !== 'host-context-error') { await response.json(); throw Error('synthetic network loss after complete body'); }
   return response;
 };
 let error;
 try { await f.run(); } catch (value) { error = value; }
 assert.equal(error.code, 'SERVICE_UNAVAILABLE'); assert.ok(error.error && error.hint);
 for (let i = 0; i < 100 && error.cleanup.state === 'pending'; i++) await pause(10);
 assert.equal(begins, 1); assert.equal(cancels, 1); assert.equal(f.h.calls.prompts.length, 0);
 if (failure === 'cleanup-failure') {
   assert.equal(error.cleanup.code, 'TURN_CLEANUP_FAILED'); assert.ok(error.cleanup.error && error.cleanup.hint);
   assert.equal(f.local.semanticWriter.status().foreground, 1); f.handler.dispose();
 } else assert.equal(error.cleanup.state, 'released');
 assert.equal(f.local.semanticWriter.status().foreground, 0);
});
await fixture('lease-timeout-and-late-context', async f => {
 const a = f.h.localChannels, entered = deferred(), gate = deferred(), done = deferred(), context = f.local.context.bind(f.local);
 f.local.context = async (...args) => { entered.resolve(); await gate.promise; const value = await context(...args); done.resolve(); return value; };
 const running = a.request('turn.begin', a.channels.get('private:123'), {}, { timeoutMs: 100 });
 const rejected = assert.rejects(running, error => error.code === 'SEMANTIC_CONTEXT_TIMEOUT' && !!error.hint);
 await entered.promise; await rejected;
 for (let i = 0; i < 100 && f.local.semanticWriter.status().foreground; i++) await pause(10);
 assert.equal(f.local.semanticWriter.status().foreground, 0);
 gate.resolve(); await done.promise; await pause(20); assert.equal(f.local.semanticWriter.status().foreground, 0);
});
await fixture('lease-client-dispose-failure-visible', async f => {
 f.setState('ready'); f.setElapsed(1); await f.run();
 const a = f.h.localChannels, fetcher = a.fetchImpl;
 a.fetchImpl = (url, options) => JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic lost end')) : fetcher(url, options);
 const result = await a.dispose(); assert.equal(result.ok, false); assert.equal(result.code, 'TURN_CLEANUP_FAILED'); assert.ok(result.error && result.hint);
 assert.equal(f.local.semanticWriter.status().foreground, 1); f.handler.dispose(); assert.equal(f.local.semanticWriter.status().foreground, 0);
});
for (const phase of ['context', 'beginTurn']) await fixture('lease-client-dispose-pending-' + phase.toLowerCase(), async f => {
 const entered = deferred(), gate = deferred(), done = deferred(), original = f.local[phase].bind(f.local);
 f.local[phase] = async (...args) => { entered.resolve(); await gate.promise; const result = await original(...args); done.resolve(); return result; };
 const running = f.run(), rejected = assert.rejects(running, error => error.code === 'REQUEST_CANCELLED');
 await entered.promise; const result = await f.h.localChannels.dispose(); await rejected;
 assert.equal(result.ok, true); assert.equal(f.local.semanticWriter.status().foreground, 0);
 gate.resolve(); await done.promise;
 for (let i = 0; i < 100 && f.local.semanticWriter.status().foreground; i++) await pause(10);
 assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(f.h.calls.prompts.length, 0);
});
await fixture('cleanup-stop-failure-retry', async f => {
 f.setState('ready'); f.setElapsed(1); await f.run();
 const a = f.h.localChannels, record = a.sessions.get(f.sid), fetcher = a.fetchImpl;
 let failing = true, ends = 0; const entered = deferred(), gate = deferred();
 a.fetchImpl = async (url, options) => {
   if (JSON.parse(options.body).action === 'turn.end') {
     ends++; if (failing) throw Error('synthetic cleanup unavailable');
     entered.resolve(); await gate.promise;
   }
   return fetcher(url, options);
 };
 const failed = await f.h.api.stopSessionWork(f.sid);
 assert.equal(failed.ok, false); assert.equal(failed.code, 'TURN_CLEANUP_FAILED'); assert.ok(failed.error && failed.hint);
 assert.equal(record.writerReleased, false); assert.equal(a.allocations.size, 1); assert.equal(f.local.semanticWriter.status().foreground, 1);
 failing = false;
 const one = f.h.api.stopSessionWork(f.sid), two = f.h.api.stopSessionWork(f.sid);
 await entered.promise; assert.equal(ends, 2); assert.equal(record.writerReleased, false);
 gate.resolve(); const results = await Promise.all([one, two]);
 assert.ok(results.every(result => result.ok !== false)); assert.equal(record.writerReleased, true);
 assert.equal(a.allocations.size, 0); assert.equal(f.local.semanticWriter.status().foreground, 0);
 await f.h.api.stopSessionWork(f.sid); assert.equal(ends, 2);
});

for (const phase of ['turn.begin', 'sources']) for (const action of ['stop', 'dispose']) await fixture('cleanup-' + action + '-' + phase.replace('.', '-'), async f => {
 const a = f.h.localChannels, request = a.request.bind(a), entered = deferred(), gate = deferred(); let failing = true, begins = 0;
 a.request = async (operation, ...args) => {
   if (operation === 'turn.begin') begins++;
   if (operation === 'turn.end' && failing) throw Error('synthetic end unavailable');
   const result = await request(operation, ...args);
   if (operation === phase) { entered.resolve(); await gate.promise; }
   return result;
 };
 const running = f.run().catch(error => error); await entered.promise;
 const result = action === 'stop' ? await f.h.api.stopSessionWork(f.sid) : await a.dispose();
 assert.equal(result.ok, false); assert.equal(result.code, 'TURN_CLEANUP_FAILED'); assert.ok(result.hint);
 assert.equal(a.allocations.size, 1); assert.equal(f.local.semanticWriter.status().foreground, 1);
 gate.resolve(); const failure = await running;
 assert.ok(['STALE_CHARACTER', 'REQUEST_CANCELLED'].includes(failure.code)); assert.equal(failure.cleanup.code, 'TURN_CLEANUP_FAILED');
 assert.match(failure.hint, /释放未获确认/); assert.equal(f.h.calls.prompts.length, 0);
 assert.equal(a.preparations.size, 0); assert.equal(a.sessions.size, 0); assert.equal(a.allocations.size, 1);
 failing = false;
 const retried = action === 'stop' ? await f.h.api.stopSessionWork(f.sid) : await a.dispose();
 assert.notEqual(retried.ok, false); assert.equal(a.allocations.size, 0); assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(begins, 1);
});

await fixture('cleanup-lost-receipt-successor', async f => {
 f.setState('ready'); f.setElapsed(1); await f.run();
 const a = f.h.localChannels, old = a.sessions.get(f.sid), fetcher = a.fetchImpl;
 let lost = false, releases = 0; const end = f.local.endTurn.bind(f.local);
 f.local.endTurn = lease => { if (lease) releases++; return end(lease); };
 a.fetchImpl = async (url, options) => {
   const response = await fetcher(url, options);
   if (JSON.parse(options.body).action === 'turn.end' && !lost) { lost = true; await response.json(); throw Error('synthetic lost cleanup receipt'); }
   return response;
 };
 const result = await f.h.api.stopSessionWork(f.sid); assert.equal(result.code, 'TURN_CLEANUP_FAILED');
 assert.equal(old.writerReleased, false); assert.equal(a.allocations.size, 1); assert.equal(f.local.semanticWriter.status().foreground, 0);
 a.revokeRecord(old); // A failed old cleanup remains recoverable after its model record retires.
 await a.prepare('private:123', 'cleanup-successor', ''); assert.equal(f.local.semanticWriter.status().foreground, 1);
 await f.h.api.stopSessionWork(f.sid);
 assert.equal(old.writerReleased, true); assert.equal(f.local.semanticWriter.status().foreground, 1); assert.equal(releases, 1);
 await a.endSession('cleanup-successor'); assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(releases, 2);
});

await fixture('cleanup-allocation-retry', async f => {
 const a = f.h.localChannels, fetcher = a.fetchImpl; let failing = true, begins = 0, originalIdentity;
 a.fetchImpl = async (url, options) => {
   const body = JSON.parse(options.body);
   if (body.action === 'turn.cancel') { assert.equal(body.requestId, originalIdentity); if (failing) throw Error('synthetic cancel unavailable'); }
   const response = await fetcher(url, options);
   if (body.action === 'turn.begin') { begins++; originalIdentity = body.requestId; await response.json(); throw Error('synthetic unreadable begin response'); }
   return response;
 };
 const failure = await f.run().catch(error => error);
 assert.equal(failure.code, 'SERVICE_UNAVAILABLE'); assert.equal(failure.cleanup.code, 'TURN_CLEANUP_FAILED'); assert.match(failure.hint, /释放未获确认/);
 assert.equal(a.allocations.size, 1); assert.equal(f.local.semanticWriter.status().foreground, 1);
 failing = false; const result = await f.h.api.stopSessionWork(f.sid);
 assert.notEqual(result.ok, false); assert.equal(a.allocations.size, 0); assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(begins, 1);
});

for (const failingFirst of [false, true]) {
 let exitCode = null;
 const processStub = { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: process.env.DSH_HOME }, exit: code => { exitCode = code; } };
 await fixture('cleanup-console-restart-' + (failingFirst ? 'retry' : 'success'), async f => {
   f.setState('ready'); f.setElapsed(1); await f.run();
   const a = f.h.localChannels, fetcher = a.fetchImpl, dispose = a.dispose.bind(a);
   let failing = failingFirst, disposeCalls = 0;
   a.dispose = async () => { disposeCalls++; return dispose(); };
   a.fetchImpl = (url, options) => failing && JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic cleanup unavailable')) : fetcher(url, options);
   const server = f.h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
   const restart = () => fetch('http://127.0.0.1:' + server.address().port + '/api/restart', { method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }, body: '{}' });
   try {
     if (failingFirst) {
       const response = await restart(), result = await response.json();
       await checkConsoleCleanupUi('restart', result);
       assert.equal(response.status, 503); assert.equal(result.code, 'TURN_CLEANUP_FAILED'); assert.ok(result.error && result.hint);
       await pause(650); assert.equal(exitCode, null); assert.equal(a.allocations.size, 1); assert.equal(f.local.semanticWriter.status().foreground, 1);
       await a.incoming('private:123', { self_id: 999, user_id: 123, message_id: 8 }, '合成后继被动请求');
       await a.prepare('private:123', 'after-failed-restart', '');
       const next = a.sessions.get('after-failed-restart'); assert.equal(next.proactive, false);
       let sends = 0; await a.origin.run(next, () => a.send('private:123', async () => { sends++; })); assert.equal(sends, 1);
       failing = false;
     }
     const response = await restart(), result = await response.json();
     await checkConsoleCleanupUi('restart', result);
     assert.equal(result.ok, true); assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(a.allocations.size, 0);
     await assert.rejects(a.request('turn.begin', { kind: 'qq-private', account: '999', peer: '123' }), error => error.code === 'REQUEST_CANCELLED');
     await pause(650); assert.equal(exitCode, 0); assert.equal(disposeCalls, failingFirst ? 2 : 1);
   } finally { await new Promise(resolve => server.close(resolve)); }
 }, { processStub });
}
for (const route of ['session', 'workspace']) for (const failingFirst of [false, true]) {
 let exitCode = null;
 const processStub = { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: process.env.DSH_HOME }, exit: code => { exitCode = code; } };
 await fixture('cleanup-reset-' + route + '-' + (failingFirst ? 'retry' : 'success'), async f => {
   f.setState('ready'); f.setElapsed(1); await f.run();
   const a = f.h.localChannels, fetcher = a.fetchImpl;
   let failing = failingFirst;
   a.fetchImpl = (url, options) => failing && JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic cleanup unavailable')) : fetcher(url, options);
   f.h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId: f.sid, cwd: path.join(f.h.temp, 'state', 'agents') }] } } });
   const server = f.h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
   const call = (pathname, body) => fetch('http://127.0.0.1:' + server.address().port + pathname, { method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
   try {
     const response = await call('/api/' + route + '/reset', { key: 'private:123' }), result = await response.json();
     await checkConsoleCleanupUi(route, result);
     if (failingFirst) {
       assert.equal(response.status, 503); assert.equal(result.code, 'TURN_CLEANUP_FAILED'); assert.ok(result.error && result.hint);
       assert.equal(a.allocations.size, 1); assert.equal(f.local.semanticWriter.status().foreground, 1);
       failing = false; const restarted = await (await call('/api/restart', {})).json();
       assert.equal(restarted.ok, true); assert.equal(f.local.semanticWriter.status().foreground, 0); assert.equal(a.allocations.size, 0);
       await pause(650); assert.equal(exitCode, 0);
     } else {
       assert.equal(result.ok, true); assert.equal(a.allocations.size, 0); assert.equal(f.local.semanticWriter.status().foreground, 0);
       assert.equal(exitCode, null);
     }
   } finally { await new Promise(resolve => server.close(resolve)); }
 }, { processStub });
}
for (const phase of ['auth', 'body']) await fixture('cleanup-dispose-direct-' + phase, async f => {
 const a = f.h.localChannels, entered = deferred(), gate = deferred(), fetcher = a.fetchImpl, auth = a.authHeaders;
 const channel = a.channels.get('private:123'); let begins = 0;
 if (phase === 'auth') a.authHeaders = async () => { entered.resolve(); await gate.promise; return auth(); };
 a.fetchImpl = async (url, options) => {
   const body = JSON.parse(options.body); if (body.action === 'turn.begin') begins++;
   const response = await fetcher(url, options);
   if (phase === 'body' && body.action === 'turn.begin') {
     const json = response.json.bind(response); response.json = async () => { const result = await json(); entered.resolve(); await gate.promise; return result; };
   }
   return response;
 };
 const running = a.request('turn.begin', channel), rejected = assert.rejects(running, error => error.code === 'REQUEST_CANCELLED');
 await entered.promise; assert.equal((await a.dispose()).ok, true); gate.resolve(); await rejected;
 assert.equal(begins, phase === 'auth' ? 0 : 1); assert.equal(a.allocations.size, 0); assert.equal(f.local.semanticWriter.status().foreground, 0);
});
await fixture('visibility-permission', async f => withCleanupStatus(f, async status => {
 f.setState('ready'); f.setElapsed(1); const a = f.h.localChannels, fetcher = a.fetchImpl;
 a.fetchImpl = (url, options) => JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic end unavailable')) : fetcher(url, options);
 f.setHook(async () => { f.h.cfg.allow.private = []; });
 const failure = await f.run().catch(error => error);
 assert.equal(failure.code, 'TURN_SUPERSEDED'); assert.equal(failure.cleanup.code, 'TURN_CLEANUP_FAILED'); assert.ok(failure.cleanup.error && failure.cleanup.hint); assert.match(failure.hint, /释放未获确认/);
 assert.equal(f.outbound.length, 0); assert.equal(f.h.calls.prompts.length, 0);
 const failed = (await status()).localCleanup; assert.equal(failed.failed, 1);
 assert.equal((await status({ 'x-agent-call': 'fixture' })).localCleanup, undefined);
 a.fetchImpl = fetcher; assert.equal((await a.dispose()).ok, true);
 checkCleanupStatusUi(failed, (await status()).localCleanup);
}));

for (const phase of ['complete', 'post-ingest', 'ingest']) await fixture('visibility-ingress-' + phase, async f => withCleanupStatus(f, async status => {
 const a = f.h.localChannels, request = a.request.bind(a), fetcher = a.fetchImpl;
 const event = { self_id: 999, user_id: 123, message_id: 22 }; let writes = 0;
 a.fetchImpl = (url, options) => JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic end unavailable')) : fetcher(url, options);
 a.request = async (action, ...args) => {
   if (action === 'ingest') writes++;
   if (action === (phase === 'post-ingest' ? 'attention.respond' : phase === 'ingest' ? 'ingest' : 'unused')) throw Object.assign(Error('synthetic primary failure'), { code: 'SERVICE_UNAVAILABLE', hint: 'synthetic primary hint' });
   return request(action, ...args);
 };
 let result, failure;
 try { result = await a.incoming('private:123', event, 'synthetic accepted input'); } catch (error) { failure = error; }
 const value = failure || result; assert.equal(value.cleanup.code, 'TURN_CLEANUP_FAILED'); assert.ok(value.cleanup.hint);
 if (phase === 'ingest') assert.notEqual(value.accepted, true);
 else {
   assert.equal(value.accepted, true); assert.ok(value.eventId);
   assert.equal((await a.incoming('private:123', event, 'same platform event')).duplicate, true); assert.equal(writes, 1);
   assert.equal(a.events.get('private:123').filter(input => input.id === value.eventId).length, 1);
 }
 if (failure) {
   assert.equal(failure.code, 'SERVICE_UNAVAILABLE'); assert.match(failure.hint, /synthetic primary hint.*释放未获确认/);
   if (phase === 'post-ingest') assert.match(failure.hint, /入站已接受，不要重复发送/);
 }
 const failed = (await status()).localCleanup; assert.equal(failed.failed, 1);
 a.request = request; a.fetchImpl = fetcher; assert.equal((await a.dispose()).ok, true);
 checkCleanupStatusUi(failed, (await status()).localCleanup);
}));

await fixture('visibility-old-replacement', async f => withCleanupStatus(f, async status => {
 f.setState('ready'); f.setElapsed(1); await f.run(); const a = f.h.localChannels, old = a.sessions.get(f.sid), fetcher = a.fetchImpl;
 a.fetchImpl = (url, options) => { const body = JSON.parse(options.body); return body.action === 'turn.end' && body.context === old.context ? Promise.reject(Error('synthetic old end unavailable')) : fetcher(url, options); };
 const next = await f.h.ensureSession('private:123'), before = f.h.calls.prompts.length;
 const failure = await f.h.api.sessions.prompt({ sessionId: next, content: [] }).catch(error => error);
 assert.equal(failure.code, 'TURN_CLEANUP_FAILED'); assert.equal(failure.cleanup.code, 'TURN_CLEANUP_FAILED'); assert.equal(failure.cleanup.ok, false);
 assert.equal(f.h.calls.prompts.length, before); assert.equal(f.local.semanticWriter.status().foreground, 1); assert.equal(a.allocations.size, 1);
 const failed = (await status()).localCleanup; a.fetchImpl = fetcher; await a.dispose();
 assert.equal(failure.cleanup.ok, false, 'recovery must not rewrite the previously reported failure');
 checkCleanupStatusUi(failed, (await status()).localCleanup);
}));

for (const command of ['/reset', '/new']) await fixture('visibility-command-' + command.slice(1), async f => withCleanupStatus(f, async status => {
 f.setState('ready'); f.setElapsed(1); await f.run(); f.h.setSelfIdentity('fixture', '999');
 const a = f.h.localChannels, old = a.sessions.get(f.sid), fetcher = a.fetchImpl;
 a.handleTools = async () => ({ handled: false }); // This fixture exercises the bridge's own management command.
 a.fetchImpl = (url, options) => { const body = JSON.parse(options.body); return body.action === 'turn.end' && body.context === old.context ? Promise.reject(Error('synthetic old end unavailable')) : fetcher(url, options); };
 const result = await f.h.handleIncoming('private', 123, { self_id: 999, user_id: 123, message_id: 33, message: [{ type: 'text', data: { text: command } }] }, f.h.cfg);
 assert.equal(result.code, 'TURN_CLEANUP_FAILED'); assert.equal(result.reset, true); assert.equal(result.accepted, true); assert.ok(result.error && result.hint);
 assert.equal(f.outbound.length, 0); assert.equal(f.h.state.sessions['private:123'], undefined);
 const view = await status(); assert.equal(view.localCleanup.failed, 1); assert.match(view.activity, /TURN_CLEANUP_FAILED/);
 a.fetchImpl = fetcher; await a.dispose(); checkCleanupStatusUi(view.localCleanup, (await status()).localCleanup);
}));

await fixture('visibility-native-turn-end', async f => withCleanupStatus(f, async status => {
 f.setState('ready'); f.setElapsed(1); await f.run(); const a = f.h.localChannels, fetcher = a.fetchImpl;
 a.fetchImpl = (url, options) => JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic end unavailable')) : fetcher(url, options);
 f.h.api.events.mux = async function* () {
   for (const event of [{ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'synthetic delivered reply' }] } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]) yield { payload: { type: 'session/event', sessionId: f.sid, event } };
 };
 await f.h.pumpMux(); const view = await status();
 assert.equal(view.localCleanup.failed, 1); assert.match(view.activity, /TURN_CLEANUP_FAILED/); assert.equal(f.outbound.length, 1);
 a.fetchImpl = fetcher; await a.dispose(); assert.equal(f.outbound.length, 1); checkCleanupStatusUi(view.localCleanup, (await status()).localCleanup);
}));

for (const operation of ['revoke', 'retire', 'invalidate']) await fixture('visibility-background-' + operation, async f => withCleanupStatus(f, async status => {
 f.setState('ready'); f.setElapsed(1); await f.run(); const a = f.h.localChannels, old = a.sessions.get(f.sid), fetcher = a.fetchImpl;
 a.fetchImpl = (url, options) => JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic end unavailable')) : fetcher(url, options);
 if (operation === 'revoke') a.revokeRecord(old);
 else if (operation === 'retire') f.h.retireSession('private:123');
 else a.invalidate();
 await old.releasePromise; const failed = (await status()).localCleanup;
 assert.equal(failed.failed, 1); assert.equal(failed.code, 'TURN_CLEANUP_FAILED');
 a.fetchImpl = fetcher; await a.dispose(); checkCleanupStatusUi(failed, (await status()).localCleanup);
}));

await fixture('visibility-pending-preparation', async f => withCleanupStatus(f, async status => {
 const a = f.h.localChannels, request = a.request.bind(a), fetcher = a.fetchImpl, entered = deferred(), gate = deferred();
 a.fetchImpl = (url, options) => JSON.parse(options.body).action === 'turn.end' ? Promise.reject(Error('synthetic end unavailable')) : fetcher(url, options);
 a.request = async (action, ...args) => { const result = await request(action, ...args); if (action === 'sources') { entered.resolve(); await gate.promise; } return result; };
 const running = f.run().catch(error => error); await entered.promise; a.invalidate();
 await [...a.allocations][0].cleanupPromise; const failed = (await status()).localCleanup; assert.equal(failed.failed, 1);
 gate.resolve(); const error = await running; assert.equal(error.cleanup.code, 'TURN_CLEANUP_FAILED'); assert.equal(f.h.calls.prompts.length, 0);
 a.fetchImpl = fetcher; a.request = request; await a.dispose(); checkCleanupStatusUi(failed, (await status()).localCleanup);
}));

console.log('PASS '+count+' actual native QQ/HTTP/SQLCipher cold semantic checks; synthetic worker clock/model and loopback OneBot only.');
}finally{const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('surfcore-semantic-cold-'));fs.rmSync(resolved,{recursive:true,force:true});}
