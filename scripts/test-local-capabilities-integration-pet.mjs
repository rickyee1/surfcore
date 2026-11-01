import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(repo,'.local/integration-pet',crypto.randomUUID());
process.env.DSH_HOME=path.join(root,'dsh');
const {CapabilitySupervisor}=await import('../plugins/surfcore/lib/local-capabilities/supervisor.js');
const {LocalCapabilities}=await import('../plugins/surfcore/lib/local-capabilities/facade.js');
const {createPetChatService}=await import('../plugins/surfcore/lib/pet-chat.js');
const supervisor=new CapabilitySupervisor({python:path.join(repo,'.venv/Scripts/python.exe'),entry:path.join(repo,'services/local-capabilities/server.py'),dataDir:path.join(root,'data'),env:{SURFCORE_LOCAL_KEY:crypto.randomBytes(32).toString('hex')}});
let character={id:'pet-fixture',epoch:1};
const local=new LocalCapabilities({supervisor,stateFile:path.join(root,'backend.json'),currentCharacter:()=>character});
let captured, duringModel=async()=>{};
const ctx={get(name){if(name==='agentDefaultModel')return{currentSelection:()=>({provider:'fixture',model:'fixture'})};if(name==='llm')return{async *stream(options){captured=options;await duringModel();yield{type:'text-delta',text:'在这里陪你。'}}};return null}};
const chat=createPetChatService({ctx,stateDir:path.join(root,'pet-state'),capabilities:local});
let count=0;
async function check(name,fn){await fn();console.log(`ok ${++count} ${name}`)}
try{
 await local.setMode('local');
 await check('passive pet uses authoritative context and ingests one event',async()=>{const d=await chat.chat({text:'fixture-first-turn'});assert.equal(d.ok,true);assert.equal(d.remembered,1);assert.equal((await local.management('memory.query')).memories.length,1);});
 await check('old plaintext history never enters local context',async()=>{const dir=path.join(root,'pet-state/pet/chat');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'history-default.json'),JSON.stringify({messages:[{role:'user',text:'LEGACY_PRIVATE_SECRET'}]}));await chat.chat({text:'new-turn'});assert.ok(!JSON.stringify(captured).includes('LEGACY_PRIVATE_SECRET'));});
 await check('correction during generation rejects late reply',async()=>{const m=(await local.management('memory.query')).memories[0];duringModel=()=>local.management('memory.correct',{id:m.id,expected_revision:m.revision,statement:'corrected'});const d=await chat.chat({text:'late-model'});assert.equal(d.ok,false);assert.equal(d.code,'STALE_CONTEXT');assert.ok(d.hint);duringModel=async()=>{};});
 await check('auto-write disabled preserves passive chat',async()=>{await local.management('memory.settings',{auto_write:false});const d=await chat.chat({text:'not-saved'});assert.equal(d.ok,true);assert.equal(d.remembered,0);});
 await check('role switch during generation rejects late reply',async()=>{duringModel=async()=>{character={id:'pet-next',epoch:2}};const d=await chat.chat({text:'old-character'});assert.equal(d.ok,false);assert.equal(d.code,'STALE_CHARACTER');duringModel=async()=>{};});
 await local.setMode('local');
 await local.management('attention.configure',{enabled:true,daily_limit:10,cooldown_seconds:0,quiet_start:'',quiet_end:'',timezone:'UTC',muted:false,focused:false});
 await check('unreserved proactive injection is rejected',async()=>{const d=await chat.proactive({text:'forged'});assert.equal(d.code,'PERMISSION_DENIED');});
 const context=await local.context({kind:'pet'});
 const r=await local.supervisor.raw('attention.reserve',context.binding,{outreach_id:'pet-outreach'});
 await check('queued proactive is validated again at polling transport',async()=>{const d=await chat.proactive({text:'queued message',localContext:context,outreach:{id:'pet-outreach',reservation_id:r.reservation_id}});assert.equal(d.ok,true);await local.management('attention.configure',{muted:true});const poll=await chat.poll({since:0,waitMs:0});assert.equal(poll.events.filter(x=>x.type==='proactive').length,0);});
 await check('focus uses persistent shared policy',async()=>{await chat.setFocus(true);const d=await local.management('attention.configure');assert.equal(d.config.focused,true);});
 await local.management('attention.configure',{muted:false,focused:false});
 await chat.setFocus(false);
 await check('corrected preference is recalled for a differently worded future question',async()=>{
   const c=await local.context({kind:'pet'});await local.ingest(c,'coffee-origin','我喜欢喝咖啡');
   const m=(await local.management('memory.query',{query:'咖啡'})).memories[0];
   await local.management('memory.correct',{id:m.id,expected_revision:m.revision,statement:'我现在不喝咖啡了'});
   const d=await chat.chat({text:'下午给我推荐点饮品吧'});assert.equal(d.ok,true);
   assert.match(captured.system,/我现在不喝咖啡了/);assert.ok(!captured.system.includes('我喜欢喝咖啡'));
 });
 async function queuedService(id,text){
   const service=createPetChatService({ctx,stateDir:path.join(root,id),capabilities:local});
   const c=await local.context({kind:'pet'});const r=await supervisor.raw('attention.reserve',c.binding,{outreach_id:id});
   assert.equal(r.reserved,true);assert.equal((await service.proactive({text,localContext:c,outreach:{id,reservation_id:r.reservation_id}})).ok,true);
   return {service,context:c};
 }
 await check('local character private queue cannot escape after switching to legacy character',async()=>{
   const {service}=await queuedService('switch-queue','PRIVATE_OLD_CHARACTER');
   const prior=character;character={id:'legacy-new-character',epoch:9};assert.equal(local.mode,'legacy');
   assert.equal((await service.poll({since:0,waitMs:0})).events.length,0);
   character=prior;assert.equal((await service.poll({since:0,waitMs:0})).events.length,0);
 });
 await check('simultaneous polls atomically release at most one proactive event',async()=>{
   const {service}=await queuedService('concurrent-queue','ONE_DELIVERY');
   const results=await Promise.all([service.poll({since:0,waitMs:0}),service.poll({since:0,waitMs:0})]);
   assert.equal(results.flatMap(r=>r.events).filter(e=>e.type==='proactive').length,1);
   assert.equal((await service.poll({since:0,waitMs:0})).events.length,0);
 });
 await check('lost finalize response leaves event claimed and unknown budget consumed',async()=>{
   const {service,context}=await queuedService('unknown-queue','UNKNOWN_DELIVERY');
   const raw=supervisor.raw.bind(supervisor);let lost=false;
   supervisor.raw=async(op,fields,params)=>{const result=await raw(op,fields,params);if(op==='attention.finalize'&&params.outcome==='unknown'&&!lost){lost=true;throw Error('fixture lost IPC response')}return result};
   try{assert.equal((await service.poll({since:0,waitMs:0})).events.length,0)}finally{supervisor.raw=raw}
   assert.equal((await service.poll({since:0,waitMs:0})).events.length,0);
   assert.equal((await raw('attention.reserve',context.binding,{outreach_id:'unknown-queue'})).reserved,false);
 });
 console.log(`PASS ${count} pet adapter checks (fixture model, real encrypted service); evidence data: ${root}`);
}finally{await supervisor.stop()}
