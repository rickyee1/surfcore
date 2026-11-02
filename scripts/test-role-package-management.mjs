import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { isLoopbackReq, json, sameOrigin } from '../plugins/surfcore/lib/http-guard.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-t5-http-'));
process.env.DSH_HOME=path.join(temporary,'isolated-dsh');
const { LocalCapabilities }=await import('../plugins/surfcore/lib/local-capabilities/facade.js');
const { createManagementHandler }=await import('../plugins/surfcore/lib/local-capabilities/management.js');
const persona=await import('../src/character-persona.js');
const root=persona.CHARACTERS_DIR;fs.mkdirSync(root,{recursive:true});
const character=persona.createCharacter({name:'Synthetic role',id:'synthetic',personaText:'Synthetic core persona'});persona.switchCharacter(character.character.id);
const supervisor=new CapabilitySupervisor({python:path.join(repository,'.venv/Scripts/python.exe'),entry:path.join(repository,'services/local-capabilities/server.py'),dataDir:path.join(temporary,'library'),env:{SURFCORE_LOCAL_KEY:crypto.randomBytes(32).toString('hex'),PYTHONUTF8:'1'}});
const local=new LocalCapabilities({supervisor,stateFile:path.join(temporary,'backend.json'),currentCharacter:persona.readCurrentCharacter});
const mount='/dsh-surfcore/local-capabilities',handler=createManagementHandler({capabilities:local,base:mount,charactersRoot:root});
const source=fs.readFileSync(path.join(repository,'plugins/surfcore/lib/index.js'),'utf8');
const start=source.indexOf('  function route(kind, pathname, handler) {'),end=source.indexOf('\n  const local = localCapabilities();',start);
assert.ok(start>0&&end>start);
const routes=new Map();
const route=vm.runInNewContext(`(${source.slice(start,end).trim()})`,{disposers:[],isLoopbackReq,json,sameOrigin,pluginLog:()=>{},ctx:{webServer:{register({path,handler}){routes.set(path,handler);return()=>{};}},get:()=>({requestRejection:req=>req.headers['x-test-host']==='synthetic-session'?false:401})}});
for(const suffix of ['', '/api','/role-package','/role-package/upload','/role-package/download'])route('exact',mount+suffix,handler);
const server=http.createServer((req,res)=>{const route=routes.get(new URL(req.url,'http://127.0.0.1').pathname);if(route)void route(req,res);else{res.statusCode=404;res.end();}});
let passed=0;async function check(name,action){await action();console.log(`PASS ${++passed} ${name}`);}
try{
 await local.setMode('local');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const page=await fetch(base+mount+'/role-package',{headers:{'x-test-host':'synthetic-session'}});const html=await page.text();
 const token=html.match(/token:'([a-f0-9]+)'/)[1];
 const headers={origin:base,cookie:page.headers.get('set-cookie').split(';')[0],'x-surfcore-session':token,'x-test-host':'synthetic-session'};
 const post=(suffix,body,type='application/json',overrides={})=>fetch(base+mount+suffix,{method:'POST',headers:{...headers,'content-type':type,...overrides},body:type==='application/json'?JSON.stringify(body):body});
 const call=async(op,params={})=>(await post('/api',{op,params})).json();
 await check('actual host wrapper authenticates role package HTML and renders seven-layer client',async()=>{
  assert.equal((await fetch(base+mount+'/role-package')).status,401);assert.equal(page.status,200);assert.match(html,/mountRolePackages/);assert.doesNotMatch(html,/__ROLE_PACKAGE_CLIENT__|__API_BASE__|__SESSION_TOKEN__/);
 });
 await check('browser private portable, spoofed params, wrong Origin and cookie denied',async()=>{
  for(const op of ['portable.coordinator.open','portable.capture','portable.begin','portable.commit','portable.review']){const value=await call(op);assert.equal(value.code,'PERMISSION_DENIED');assert.ok(value.error&&value.hint);}
  assert.equal((await call('role.package.diagnostics',{character_id:'another'})).code,'INVALID_REQUEST');
  for(const overrides of [{origin:'https://foreign.invalid'},{'x-surfcore-session':'wrong'}])assert.equal((await post('/api',{op:'role.package.diagnostics'},'application/json',overrides)).status,403);
 });
 const password='synthetic-http-role-password';let exported,uploaded,staged,current;
 await check('real authenticated upload/download fixed routes preserve sealed digest',async()=>{
  exported=(await call('role.package.export.prepare',{password,assets:[]})).result;assert.ok(exported);
  const denied=await post('/role-package/download',{package_id:exported.package_id,package_digest:exported.package_digest});assert.equal(denied.status,403);
  assert.equal((await call('role.package.export.commit',{package_id:exported.package_id,package_digest:exported.package_digest,expected_revision:exported.revision,confirmation_digest:exported.confirmation_digest})).ok,true);
  const response=await post('/role-package/download',{package_id:exported.package_id,package_digest:exported.package_digest});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());
  const upload=await post('/role-package/upload',bytes,'application/octet-stream');assert.equal(upload.status,200);uploaded=(await upload.json()).result;
  assert.equal(uploaded.package_digest,exported.package_digest);
 });
 await check('same-ID explicit mode, stale stage fence and identity override rejected',async()=>{
  assert.equal((await call('role.package.import.inspect',{package_id:uploaded.package_id,password,mode:'new'})).code,'CHARACTER_ID_CONFLICT');
  const preview=(await call('role.package.import.inspect',{package_id:uploaded.package_id,password,mode:'restore_same_id'})).result;
  assert.equal((await call('role.package.import.stage',{inspection_id:preview.inspection_id,password,package_digest:preview.package_digest,expected_target_revision:'stale'})).code,'VERSION_CONFLICT');
  staged=(await call('role.package.import.stage',{inspection_id:preview.inspection_id,password,package_digest:preview.package_digest,expected_target_revision:preview.target_revision})).result;assert.ok(staged.prechange_backup_id);
 });
 await check('persistent marker blocks actual persona same-ID fast path and facade/context; management survives',async()=>{
  const before=persona.readCurrentCharacter();
  current=(await call('role.package.import.commit',{operation_id:staged.operation_id,expected_revision:staged.revision,confirmation_digest:staged.confirmation_digest})).result;assert.ok(current.receipt);
  assert.equal(persona.readCurrentCharacter().id,'synthetic');assert.equal(persona.readCurrentCharacter().packagePaused,true);assert.equal(persona.isCurrentEpoch(before.epoch),false);
  for(const action of [()=>persona.switchCharacter('synthetic'),()=>persona.bumpEpoch('synthetic'),()=>persona.updateCharacter('synthetic',{personaText:'must not write'}),()=>persona.restoreSnapshot('synthetic','nonexistent')])assert.throws(action,{code:'ROLE_PACKAGE_PAUSED'});
  await assert.rejects(()=>local.context({kind:'pet'}));
  assert.equal((await call('role.package.import.status',{operation_id:staged.operation_id})).ok,true);
  assert.equal((await call('role.package.diagnostics')).result.service.database_schema,1);
  assert.equal((await call('memory.query')).ok,false);
 });
 await check('current native review removes only owned pause and leaves proactive/backend off',async()=>{
  current=(await call('role.package.import.status',{operation_id:staged.operation_id})).result;
  assert.equal((await call('role.package.review',{operation_id:staged.operation_id,expected_revision:current.revision,review_digest:'stale'})).code,'VERSION_CONFLICT');
  const completed=await call('role.package.review',{operation_id:staged.operation_id,expected_revision:current.revision,review_digest:current.native_review.review_digest});assert.equal(completed.ok,true);
  assert.equal(persona.readCurrentCharacter().packagePaused,false);assert.equal(local.mode,'paused');
  await local.setMode('local');assert.equal((await local.call({kind:'management'},'attention.check',{outreach_id:'new'})).reason,'disabled');
 });
 console.log(`T5 real host management checks: ${passed} PASS.`);
}finally{
 await new Promise(resolve=>server.close(resolve));await supervisor.stop();
 if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('surfcore-t5-http-'))throw new Error('unsafe cleanup');fs.rmSync(temporary,{recursive:true,force:true});
}
