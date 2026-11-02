import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-t5-native-gates-'));
process.env.DSH_HOME=path.join(root,'dsh');
// paths.js otherwise probes the repository config even with an isolated DSH_HOME.
const qqRoot=path.join(root,'qq');fs.mkdirSync(path.join(qqRoot,'src'),{recursive:true});
fs.writeFileSync(path.join(qqRoot,'config.json'),JSON.stringify({ownerQQ:123,persona:{},socialV2:{voice:{enabled:false}}}));
fs.writeFileSync(path.join(qqRoot,'src/bridge.js'),'// Synthetic root discovery marker only.\n');
process.env.SURFCORE_ROOT=qqRoot;process.env.SURFCORE_QQBOT_ROOT=qqRoot;
const moduleRoot=process.env.T5_HOST_OVERLAY||repository;
const load=relative=>import(pathToFileURL(path.join(moduleRoot,relative)).href);
const {LocalCapabilities}=await load('plugins/surfcore/lib/local-capabilities/facade.js');
const {createPetChatService}=await load('plugins/surfcore/lib/pet-chat.js');
const {createPetApiService}=await load('plugins/surfcore/lib/pet-api.js');
const {LocalChannelBridge}=await load('src/local-capabilities-bridge.js');
const {readCurrentCharacter}=await load('src/character-persona.js');
const {targetMarker}=await load('src/role-package-gate.js');
const characters=path.join(process.env.DSH_HOME,'surfcore/characters'),directory=path.join(characters,'synthetic');
fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'character.json'),JSON.stringify({version:1,id:'synthetic',name:'Synthetic',updatedAt:'2026-11-02'}));
fs.writeFileSync(path.join(directory,'persona.md'),'Synthetic persona only.');
fs.writeFileSync(path.join(characters,'current.json'),JSON.stringify({id:'synthetic',epoch:1,name:'Synthetic'}));
const marker=targetMarker(characters,'synthetic');
function pause(){fs.mkdirSync(path.dirname(marker),{recursive:true});fs.writeFileSync(marker,JSON.stringify({operation_id:'a'.repeat(32),package_digest:'b'.repeat(64),target_id:'synthetic'}));}
function unpause(){if(fs.existsSync(marker))fs.unlinkSync(marker);}
let modelCalls=0,whileModel=async()=>{};
const supervisor={child:null,generation:0,async start(){throw Error('Unexpected native service start');}};
const local=new LocalCapabilities({supervisor,stateFile:path.join(root,'backend.json'),currentCharacter:readCurrentCharacter});
const ctx={get(name){if(name==='agentDefaultModel')return{currentSelection:()=>({provider:'fixture',model:'fixture'})};if(name==='llm')return{async *stream(){modelCalls++;await whileModel();yield{type:'text-delta',text:'SYNTHETIC_REPLY_BODY'};}};return null;}};
function pet(name){return createPetChatService({ctx,stateDir:path.join(root,name),capabilities:local});}
const output=()=>{let body='';return {writeHead(){},once(){},end(value,done){body+=String(value);done?.();},get body(){return body;}};};
let passed=0;
async function check(name,fn){unpause();whileModel=async()=>{};await fn();passed++;console.log(`PASS ${name}`);}
try{
  await check('actual legacy facade/pet blocks an existing durable marker before model',async()=>{
    const chat=pet('before');pause();assert.equal(local.mode,'legacy');assert.equal(readCurrentCharacter().packagePaused,true);
    const before=modelCalls,result=await chat.chat({text:'Synthetic question'});
    assert.equal(result.ok,false);assert.equal(result.code,'ROLE_PACKAGE_PAUSED');assert.ok(result.hint);assert.equal(modelCalls,before);
  });
  await check('marker appearing during actual legacy model await rejects late reply and history',async()=>{
    const chat=pet('during');whileModel=async()=>pause();const result=await chat.chat({text:'Synthetic question'});
    assert.equal(result.ok,false);assert.equal(result.code,'ROLE_PACKAGE_PAUSED');assert.ok(result.hint);
    unpause();assert.equal(chat.history().messages.length,0);
  });
  await check('actual legacy queued proactive body is blocked at polling',async()=>{
    const chat=pet('queued');assert.equal((await chat.proactive({text:'QUEUED_PRIVATE_BODY'})).ok,true);pause();
    let result;try{result=await chat.poll({since:0,waitMs:0});}catch(error){assert.equal(error.code,'ROLE_PACKAGE_PAUSED');assert.ok(error.hint);return;}
    assert.ok(!JSON.stringify(result).includes('QUEUED_PRIVATE_BODY'));assert.equal(result.events.length,0);
  });
  await check('actual final pet HTTP boundary blocks a legacy result returned before pause',async()=>{
    const chat=pet('http');const result=await chat.chat({text:'Synthetic question'});assert.equal(result.ok,true);
    const api=createPetApiService({chat,stateDir:path.join(root,'http'),petService:{status:()=>({})},currentDshUrl:()=>''});
    pause();const response=output();await api.sendChatResult(response,200,result);
    const body=JSON.parse(response.body);assert.equal(body.code,'ROLE_PACKAGE_PAUSED');assert.ok(body.hint);assert.ok(!response.body.includes('SYNTHETIC_REPLY_BODY'));
  });
  await check('actual final poll HTTP boundary rechecks marker after queued body was selected',async()=>{
    const chat=pet('poll-http');await chat.proactive({text:'SELECTED_QUEUED_BODY'});const result=await chat.poll({since:0,waitMs:0});assert.match(JSON.stringify(result),/SELECTED_QUEUED_BODY/);
    const api=createPetApiService({chat,stateDir:path.join(root,'poll-http'),petService:{status:()=>({})},currentDshUrl:()=>''});
    pause();const response=output();await api.sendChatResult(response,200,result);assert.equal(JSON.parse(response.body).code,'ROLE_PACKAGE_PAUSED');assert.ok(!response.body.includes('SELECTED_QUEUED_BODY'));
  });
  await check('native legacy QQ adapter startup and incoming honor marker with zero requests',async()=>{
    const config=()=>({dsh:{baseUrl:'http://127.0.0.1:1'}});let requests=0;
    const bridge=new LocalChannelBridge({config,guarded:()=>false,mode:()=> 'legacy',currentCharacter:readCurrentCharacter,fetchImpl:async()=>{requests++;throw Error('Unexpected network');}});
    pause();assert.throws(()=>new LocalChannelBridge({config,guarded:()=>false,mode:()=> 'legacy',currentCharacter:readCurrentCharacter}),error=>error.code==='ROLE_PACKAGE_PAUSED'&&!!error.hint);
    await assert.rejects(bridge.incoming('private:123',{self_id:999,user_id:123,message_id:1},'Synthetic input'),error=>error.code==='ROLE_PACKAGE_PAUSED'&&!!error.hint);assert.equal(requests,0);
  });
  await check('native legacy QQ final queued HTTP has zero sends after pause',async()=>{
    let sends=0,release;const barrier=new Promise(resolve=>release=resolve);
    const bridge=new LocalChannelBridge({config:()=>({}),guarded:()=>false,mode:()=> 'legacy',currentCharacter:readCurrentCharacter,fetchImpl:async()=>{sends++;return{};}});
    const queued=barrier.then(()=>bridge.sendFetch('private:123','http://127.0.0.1:1/send_private_msg',{}));pause();release();
    await assert.rejects(queued,error=>error.code==='ROLE_PACKAGE_PAUSED'&&!!error.hint);assert.equal(sends,0);
  });
  await check('unblocked legacy still generates and queued final transport remains functional',async()=>{
    const chat=pet('positive');const result=await chat.chat({text:'Synthetic positive'});assert.equal(result.ok,true);await chat.validateDelivery(result);chat.validateDeliverySync(result);
    let sends=0;const bridge=new LocalChannelBridge({config:()=>({}),guarded:()=>false,mode:()=> 'legacy',currentCharacter:readCurrentCharacter});await bridge.send('private:123',async()=>sends++);assert.equal(sends,1);
  });
  await check('exposed purpose-model entry cannot bypass a legacy package marker',async()=>{
    const chat=pet('purpose');const before=modelCalls;pause();await assert.rejects(chat.complete({system:'Synthetic',user:'Synthetic'}),error=>error.code==='ROLE_PACKAGE_PAUSED'&&!!error.hint);assert.equal(modelCalls,before);
  });
  await check('actual bridge legacy prompt and queued send never reach model/HTTP while paused',async()=>{
    const {bridgeHarness}=await load('scripts/audit-bridge-harness.mjs');
    const bridge=await bridgeHarness({config:{sendDelayMs:0},globals:{readCurrentCharacter}});
    try{
      const queued=bridge.sendToQQ('private:123','SYNTHETIC_QUEUED_QQ');pause();
      await assert.rejects(bridge.api.sessions.prompt({sessionId:'synthetic-legacy-session'}),error=>error.code==='ROLE_PACKAGE_PAUSED'&&!!error.hint);
      await queued.catch(error=>{assert.equal(error.code,'ROLE_PACKAGE_PAUSED');});
      assert.equal(bridge.calls.prompts.length,0);assert.equal(bridge.calls.sent.length,0);assert.equal(bridge.calls.http.filter(item=>/send_(private|group)_msg/.test(item.url)).length,0);
    }finally{await bridge.close();}
  });
  await check('actual settings pet handler denies startup/chat with structured package error',async()=>{
    const gates=await load('src/role-package-gate.js');const source=fs.readFileSync(path.join(moduleRoot,'plugins/surfcore/lib/index.js'),'utf8');
    const begin=source.indexOf('  async function handlePet(req, res, url) {'),end=source.indexOf('\n  // ── 目的机制',begin);assert.ok(begin>0&&end>begin);
    let starts=0;const chat=pet('settings');
    const handler=vm.runInNewContext(`(${source.slice(begin,end).trim()})`,{API_PREFIX:'/dsh-surfcore/api',readCurrentCharacter,...gates,readBody:async()=>'{}',petChat:chat,petService:{start:async()=>{starts++;}},json:(res,status,body)=>{res.status=status;res.body=body;}});
    pause();const before=modelCalls;
    for(const suffix of ['start','chat-test']){const response={};await handler({method:'POST'},response,new URL(`http://127.0.0.1/dsh-surfcore/api/pet/${suffix}`));assert.equal(response.body.code,'ROLE_PACKAGE_PAUSED');assert.ok(response.body.error&&response.body.hint);}
    assert.equal(starts,0);assert.equal(modelCalls,before);
  });
  console.log(`PASS ${passed} native role-package host checks; isolated mock model/transport only; ${root}`);
}finally{unpause();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
