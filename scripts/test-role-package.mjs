import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CapabilitySupervisor } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { createRolePackages } from '../plugins/surfcore/lib/local-capabilities/role-package.js';
import { LAYERS, openPackage, sealPackage, sha256, canonical } from '../plugins/surfcore/lib/local-capabilities/role-package-format.js';
import { isTargetBlocked } from '../src/role-package-gate.js';
import { mountRolePackages } from '../plugins/surfcore/lib/local-capabilities/role-package-client.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(repository, '.venv', 'Scripts', 'python.exe');
const entry = path.join(process.env.T5_SERVICE_OVERLAY || path.join(repository, 'services/local-capabilities'), 'server.py');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-t5-native-'));
const supervisors = [];
const password = 'synthetic-role-package-password';
const filenames = { core:'persona.md',daily:'persona.daily.md',tone:'persona.tone.md',pet:'persona.scenes/pet.md','qq-private':'persona.scenes/qq-private.md','qq-group':'persona.scenes/qq-group.md',bili:'persona.scenes/bili.md' };
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function fixture(name, fault = () => {}, clock = Date.now) {
  const root = path.join(temporary, name), charactersRoot = path.join(root, 'characters'), dataDir = path.join(root, 'library');
  const supervisor = new CapabilitySupervisor({ python, entry, dataDir, timeoutMs:30000, env:{ SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex'), PYTHONUTF8:'1' } });
  supervisors.push(supervisor);
  const capabilities = { supervisor, currentCharacter:()=>{ try { return JSON.parse(fs.readFileSync(path.join(charactersRoot,'current.json'),'utf8')); } catch { return null; } }, store:{characters:{}}, bindings:new Map(), persist() { fs.writeFileSync(path.join(dataDir,'host-state.json'),JSON.stringify(this.store)); } };
  const packages = createRolePackages({ capabilities, charactersRoot, fault, clock });
  return { root, charactersRoot, supervisor, capabilities, packages, call:(operation, params)=>packages.dispatch(`role.package.${operation}`,params) };
}
async function session(fixture, scope='owner:local') {
  await fixture.supervisor.start();
  const active = await fixture.supervisor.raw('character.activate',{}, { character_id:'synthetic' });
  const fields = { character_id:'synthetic',character_epoch:active.character_epoch };
  const binding = await fixture.supervisor.raw('session.bind',fields,{platform:'local',account_id:'local',conversation_id:'local',principal_id:'owner:local',audience_scope:scope,is_owner:true,management:scope==='owner:local'});
  return {...fields,...binding};
}
async function upload(fixture, bytes) { return fixture.packages.upload((async function*(){ yield bytes; })()); }
async function stage(fixture, bytes, mode='new') {
  const uploaded = await upload(fixture, bytes);
  const inspection = await fixture.call('import.inspect',{package_id:uploaded.package_id,password,mode});
  if (inspection.duplicate) return inspection;
  return fixture.call('import.stage',{inspection_id:inspection.inspection_id,password,package_digest:inspection.package_digest,expected_target_revision:inspection.target_revision});
}
async function commit(fixture, row) { return fixture.call('import.commit',{operation_id:row.operation_id,expected_revision:row.revision,confirmation_digest:row.confirmation_digest}); }

try {
  const source = fixture('source');
  fs.mkdirSync(path.join(source.charactersRoot,'synthetic','persona.scenes'),{recursive:true});
  for (const layer of LAYERS) fs.writeFileSync(path.join(source.charactersRoot,'synthetic',filenames[layer]),`Synthetic ${layer} 人格\n`);
  fs.writeFileSync(path.join(source.charactersRoot,'synthetic','character.json'),JSON.stringify({version:1,id:'synthetic',name:'Synthetic',updatedAt:'2026-11-02'}));
  fs.writeFileSync(path.join(source.charactersRoot,'current.json'),JSON.stringify({id:'synthetic',epoch:1,name:'Synthetic'}));
  let owner = await session(source);
  let memoryEpoch = 0;
  for (const [event,text] of [['episode-source','Synthetic project fact'],['to-delete','Synthetic deletion priority fact']]) {
    const result = await source.supervisor.raw('memory.ingest',owner,{source_event_id:event,text,source_refs:[`source:${event}`],expected_memory_epoch:memoryEpoch}); memoryEpoch=result.memory_epoch;
  }
  const privateBinding=await source.supervisor.raw('session.bind',owner,{platform:'qq',account_id:'old-account',conversation_id:'old-peer',principal_id:'old-peer',audience_scope:'qq:private:old-account:old-peer',is_owner:false,management:false});
  await source.supervisor.raw('memory.ingest',{...owner,...privateBinding},{source_event_id:'old-private',text:'Synthetic old private audience fact',source_refs:['source:old-private'],expected_memory_epoch:memoryEpoch});
  await source.supervisor.raw('attention.configure',owner,{enabled:true,daily_limit:5,cooldown_seconds:0});
  await source.supervisor.raw('attention.reserve',owner,{outreach_id:'synthetic-uncertain'});
  await source.supervisor.raw('attention.finalize',owner,{outreach_id:'synthetic-uncertain',outcome:'unknown'});
  let exported, bytes, payload;
  await check('sealed export is coherent, seven layers, no permission/key transfer',async()=>{
    exported=await source.call('export.prepare',{password,assets:[]});
    assert.throws(()=>source.packages.download(null,{writeHead(){},end(){}},{package_id:exported.package_id,package_digest:exported.package_digest}),{code:'PERMISSION_DENIED'});
  });
  // download is synchronous by design; assert.throws covers the boundary.
  exported=await source.call('export.commit',{package_id:exported.package_id,package_digest:exported.package_digest,expected_revision:exported.revision,confirmation_digest:exported.confirmation_digest});
  source.packages.download(null,{writeHead(){},end(value){bytes=value;}},{package_id:exported.package_id,package_digest:exported.package_digest});
  payload=openPackage(bytes,password);
  assert.equal(Object.keys(payload.persona).length,7); assert.equal(payload.platformState.events[0].outcome,'unknown');
  assert.equal(payload.snapshot.characterId,'synthetic'); assert.ok(payload.exclusions.includes('keys'));
  const sourceBefore = fs.readFileSync(path.join(source.charactersRoot,'synthetic','persona.md'));

  for (const boundary of ['exact','await_before_begin']) await check(`original approval expires at ${boundary}: zero begin and no persona install`,async()=>{
    let now=Date.now();const destination=fixture(`ttl-${boundary}`,()=>{},()=>now);
    const prepared=await stage(destination,bytes);let begins=0;let crossed=false;
    const raw=destination.supervisor.raw.bind(destination.supervisor);
    destination.supervisor.raw=async(op,...args)=>{
      if(op==='portable.begin')begins++;
      const value=await raw(op,...args);
      if(boundary==='await_before_begin'&&op==='portable.status'&&!crossed){crossed=true;now=prepared.expires+1;}
      return value;
    };
    if(boundary==='exact')now=prepared.expires;
    await assert.rejects(commit(destination,prepared),error=>error.code==='VERSION_CONFLICT'&&!!error.hint);
    assert.equal(begins,0);assert.equal(fs.existsSync(path.join(destination.charactersRoot,'synthetic','persona.md')),false);
    assert.equal((await destination.call('import.status',{operation_id:prepared.operation_id})).receipt,null);
    assert.notEqual(destination.capabilities.store.characters.synthetic?.mode,'paused');
  });
  await check('valid begin may finish settlement after approval expires without restarting restore',async()=>{
    let now=Date.now(),prepared;
    const destination=fixture('valid-begin-expires',point=>{if(point==='after_begin')now=prepared.expires+1;},()=>now);
    prepared=await stage(destination,bytes);const result=await commit(destination,prepared);
    assert.ok(result.receipt);assert.equal(result.status,'published_paused');assert.equal(fs.existsSync(path.join(destination.charactersRoot,'synthetic','persona.md')),true);
  });

  await check('fixed authenticated format rejects wrong password/corruption/truncation/header KDF/unknown fields',()=>{
    assert.throws(()=>openPackage(bytes,'incorrect-password-123'));
    const corrupt=Buffer.from(bytes);corrupt[corrupt.length-20]^=1;assert.throws(()=>openPackage(corrupt,password));
    assert.throws(()=>openPackage(bytes.subarray(0,-1),password));
    const kdf=Buffer.from(bytes);kdf[Buffer.byteLength('SURFCORE-ROLE1\n')+1]=255;assert.throws(()=>openPackage(kdf,password));
    assert.throws(()=>sealPackage({...payload,extra:'not allowed'},password));
    assert.throws(()=>sealPackage({...payload,persona:{...payload.persona,'../escape':payload.persona.core}},password));
    const rawSeal=plain=>{
      const length=Buffer.byteLength('SURFCORE-ROLE1\n'),head=Buffer.from(bytes.subarray(0,length+34));
      crypto.randomBytes(16).copy(head,length+2);crypto.randomBytes(12).copy(head,length+18);head.writeUInt32BE(Buffer.byteLength(plain),head.length-4);
      const key=crypto.scryptSync(password,head.subarray(length+2,length+18),32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
      try{const cipher=crypto.createCipheriv('aes-256-gcm',key,head.subarray(length+18,length+30));cipher.setAAD(head);return Buffer.concat([head,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}finally{key.fill(0);}
    };
    assert.throws(()=>openPackage(rawSeal('{"schema":1,'+canonical(payload).slice(1)),password));
    assert.throws(()=>openPackage(rawSeal(canonical({...payload,unknown:'extra'})),password));
  });
  const target=fixture('target');let result;
  await check('logical required assets are previewed and block import without download',async()=>{
    const destination=fixture('assets');const asset={name:'synthetic.voice',version:'1',source:'synthetic-local-fixture',license:'MIT',sha256:'a'.repeat(64),required:true};
    const artifact=sealPackage({...payload,assets:[asset]},password);const uploaded=await upload(destination,artifact);
    const view=await destination.call('import.inspect',{package_id:uploaded.package_id,password,mode:'new'});assert.equal(view.assets[0].available,false);assert.ok(view.unavailable_scopes.includes('qq:private:old-account:old-peer'));
    await assert.rejects(()=>destination.call('import.stage',{inspection_id:view.inspection_id,password,package_digest:view.package_digest,expected_target_revision:view.target_revision}),{code:'ASSET_UNAVAILABLE'});
    assert.equal(fs.existsSync(path.join(destination.charactersRoot,'synthetic')),false);
  });
  await check('new import rejects an ID already retained by index even without its directory',async()=>{
    const destination=fixture('index-collision');const uploaded=await upload(destination,bytes);
    fs.writeFileSync(path.join(destination.charactersRoot,'index.json'),JSON.stringify({version:1,characters:[{id:'synthetic',name:'existing-index-only'}]}));
    await assert.rejects(()=>destination.call('import.inspect',{package_id:uploaded.package_id,password,mode:'new'}),{code:'CHARACTER_ID_CONFLICT'});
  });
  await check('actual SQLCipher import, unchanged persona hashes and paused target',async()=>{
    const prepared=await stage(target,bytes);result=await commit(target,prepared);
    assert.equal(result.phase,'published_paused');assert.equal(result.status,'published_paused');assert.ok(result.receipt);
    assert.ok(isTargetBlocked('synthetic',target.charactersRoot));
    assert.equal(fs.existsSync(path.join(target.charactersRoot,'current.json')),false);
    for(const layer of LAYERS)assert.equal(fs.readFileSync(path.join(target.charactersRoot,'synthetic',filenames[layer]),'utf8'),payload.persona[layer].text);
    assert.equal(target.capabilities.store.characters.synthetic.mode,'paused');
    await assert.rejects(()=>session(target),{code:'ROLE_PACKAGE_PAUSED'});
  });
  await check('permanent target/package receipt prevents new-op replay while paused',async()=>{
    const repeated=await stage(target,bytes);assert.equal(repeated.duplicate,true);assert.equal(repeated.operation_id,result.operation_id);
    assert.equal(repeated.receipt.memory_epoch,result.receipt.memory_epoch);
  });
  await check('fresh native ledger review restores source facts, proactive off, source untouched',async()=>{
    result=await target.call('import.status',{operation_id:result.operation_id});
    await target.call('review',{operation_id:result.operation_id,expected_revision:result.revision,review_digest:result.native_review.review_digest});
    assert.equal(isTargetBlocked('synthetic',target.charactersRoot),false);
    const binding=await session(target);
    const query=await target.supervisor.raw('memory.query',binding,{limit:20});
    assert.equal(query.memories.length,3);assert.ok(query.memories.some(item=>item.statement==='Synthetic project fact'));
    const unrelated=await target.supervisor.raw('session.bind',binding,{platform:'qq',account_id:'new-account',conversation_id:'new-peer',principal_id:'new-peer',audience_scope:'qq:private:new-account:new-peer',is_owner:false,management:false});
    assert.equal((await target.supervisor.raw('memory.query',{...binding,...unrelated},{limit:20})).memories.length,0);
    const attention=await target.supervisor.raw('attention.check',binding,{outreach_id:'synthetic-uncertain'});assert.equal(attention.reason,'disabled');
    assert.deepEqual(fs.readFileSync(path.join(source.charactersRoot,'synthetic','persona.md')),sourceBefore);
  });
  await check('same-ID restore backs up first; old package cannot revive destination-deleted memory',async()=>{
    // Select the same-ID target explicitly; no source ID relabeling.
    fs.writeFileSync(path.join(target.charactersRoot,'current.json'),JSON.stringify({id:'synthetic',epoch:1}));
    const binding=await session(target);
    const query=await target.supervisor.raw('memory.query',binding,{limit:20});
    const victim=query.memories.find(item=>item.statement.includes('deletion priority'));
    await target.supervisor.raw('memory.delete',binding,{id:victim.id,expected_revision:victim.revision});
    // Reseal the same authenticated native snapshot with a new package identity.
    const distinct=sealPackage({...payload,packageId:crypto.randomBytes(16).toString('hex')},password);
    const prepared=await stage(target,distinct,'restore_same_id');
    assert.ok(prepared.prechange_backup_id);assert.ok(fs.existsSync(path.join(target.charactersRoot,'.role-packages',`${prepared.prechange_backup_id}.prechange.scrole`)));
    let current=await commit(target,prepared);current=await target.call('import.status',{operation_id:current.operation_id});
    await target.call('review',{operation_id:current.operation_id,expected_revision:current.revision,review_digest:current.native_review.review_digest});
    const rebound=await session(target);const after=await target.supervisor.raw('memory.query',rebound,{limit:20});
    assert.equal(after.memories.filter(item=>item.status==='active').length,2);
    assert.ok(after.memories.some(item=>item.statement==='Synthetic project fact'));
    assert.ok(after.memories.some(item=>item.id===victim.id&&item.status==='deleted'&&item.statement===''));
  });
  await check('actual isolated A to B to A keeps one uncertain charge and blocks replay of its ID',async()=>{
    const ready=await target.call('export.prepare',{password,assets:[]});
    await target.call('export.commit',{package_id:ready.package_id,package_digest:ready.package_digest,expected_revision:ready.revision,confirmation_digest:ready.confirmation_digest});
    let returned;target.packages.download(null,{writeHead(){},end(value){returned=value;}},{package_id:ready.package_id,package_digest:ready.package_digest});
    const prepared=await stage(source,returned,'restore_same_id');let result=await commit(source,prepared);result=await source.call('import.status',{operation_id:result.operation_id});
    await source.call('review',{operation_id:result.operation_id,expected_revision:result.revision,review_digest:result.native_review.review_digest});owner=await session(source);
    await source.supervisor.raw('attention.configure',owner,{enabled:true,daily_limit:2,cooldown_seconds:0});
    assert.equal((await source.supervisor.raw('attention.check',owner,{outreach_id:'synthetic-uncertain'})).reason,'duplicate');
    assert.equal((await source.supervisor.raw('attention.check',owner,{outreach_id:'new-after-roundtrip'})).allowed,true);
  });
  for(const point of ['after_begin','after_persona','after_db','after_publish']) await check(`durable crash ${point}, restart/status/fresh recovery, no replay`,async()=>{
    let enabled=true;const destination=fixture(point,phase=>{if(enabled&&phase===point)throw new Error(`synthetic crash ${point}`);});
    const prepared=await stage(destination,bytes);
    await assert.rejects(()=>commit(destination,prepared),/synthetic crash/);
    assert.ok(isTargetBlocked('synthetic',destination.charactersRoot));
    const previous=await destination.call('import.status',{operation_id:prepared.operation_id});
    await destination.supervisor.stop();
    // Native child restart with identical synthetic test key/profile.
    destination.supervisor.stopped=false;enabled=false;
    const recovered=await destination.call('recovery.inspect',{operation_id:prepared.operation_id});
    const finished=await destination.call('recovery.commit',{operation_id:prepared.operation_id,expected_revision:recovered.revision,package_digest:recovered.package_digest,confirmation_digest:recovered.confirmation_digest});
    if(previous.receipt)assert.equal(finished.receipt.memory_epoch,previous.receipt.memory_epoch);
    assert.equal(finished.phase,'published_paused');assert.ok(finished.persona_matches);
  });
  await check('stale export approval rejects role/epoch and attention mutation',async()=>{
    const prepared=await source.call('export.prepare',{password,assets:[]});
    await source.supervisor.raw('attention.respond',owner,{});
    await assert.rejects(()=>source.call('export.commit',{package_id:prepared.package_id,package_digest:prepared.package_digest,expected_revision:prepared.revision,confirmation_digest:prepared.confirmation_digest}),{code:'VERSION_CONFLICT'});
  });
  await check('attention mutation during native capture discards entire export',async()=>{
    const before=fs.readdirSync(path.join(source.charactersRoot,'.role-packages')).filter(name=>name.endsWith('.scrole')).length;
    const raw=source.supervisor.raw.bind(source.supervisor);let changed=false;
    source.supervisor.raw=async(op,...args)=>{const result=await raw(op,...args);if(op==='portable.capture'&&!changed){changed=true;await raw('attention.respond',owner,{});}return result;};
    try{await assert.rejects(()=>source.call('export.prepare',{password,assets:[]}),{code:'VERSION_CONFLICT'});}finally{source.supervisor.raw=raw;}
    assert.equal(fs.readdirSync(path.join(source.charactersRoot,'.role-packages')).filter(name=>name.endsWith('.scrole')).length,before);
  });
  await check('stale role epoch at commit pauses before begin; owned pre-begin cancel removes only own marker',async()=>{
    const distinct=sealPackage({...payload,packageId:crypto.randomBytes(16).toString('hex')},password);
    const prepared=await stage(target,distinct,'restore_same_id');
    const pointer=path.join(target.charactersRoot,'current.json');const current=JSON.parse(fs.readFileSync(pointer,'utf8'));fs.writeFileSync(pointer,JSON.stringify({...current,epoch:current.epoch+1}));
    await assert.rejects(()=>commit(target,prepared),{code:'VERSION_CONFLICT'});assert.ok(isTargetBlocked('synthetic',target.charactersRoot));
    const cancelled=await target.call('import.cancel',{operation_id:prepared.operation_id,expected_revision:prepared.revision});assert.equal(cancelled.phase,'cancelled');assert.equal(isTargetBlocked('synthetic',target.charactersRoot),false);
  });
  await check('target marker has operation ownership; cancelled A cannot erase begun B',async()=>{
    const destination=fixture('cas');const first=await stage(destination,bytes), second=await stage(destination,bytes);
    await commit(destination,second);
    await destination.call('import.cancel',{operation_id:first.operation_id,expected_revision:first.revision});
    const marker=JSON.parse(fs.readFileSync(path.join(destination.charactersRoot,'.role-packages','blocked-synthetic.json'),'utf8'));
    assert.equal(marker.operation_id,second.operation_id);assert.ok(isTargetBlocked('synthetic',destination.charactersRoot));
  });
  await check('reparse/hardlink role files rejected before export',async()=>{
    const where=path.join(source.charactersRoot,'synthetic','persona.tone.md'), saved=fs.readFileSync(where);fs.unlinkSync(where);fs.linkSync(path.join(source.charactersRoot,'synthetic','persona.md'),where);
    await assert.rejects(()=>source.call('export.prepare',{password,assets:[]}),{code:'PERMISSION_DENIED'});
    fs.unlinkSync(where);fs.writeFileSync(where,saved);
    const linked=fixture('junction');fs.mkdirSync(linked.charactersRoot,{recursive:true});
    fs.symlinkSync(path.join(source.charactersRoot,'synthetic'),path.join(linked.charactersRoot,'synthetic'),process.platform==='win32'?'junction':'dir');
    fs.writeFileSync(path.join(linked.charactersRoot,'current.json'),JSON.stringify({id:'synthetic',epoch:1}));
    await assert.rejects(()=>linked.call('export.prepare',{password,assets:[]}),{code:'PERMISSION_DENIED'});
  });
  await check('real mounted client invalidates consent and does not retry uncertain commit',async()=>{
    const elements=new Map();
    for(const name of ['password','mode','file','assets','confirm','consent','stage','download','status','recover','review','cancel','export','upload','inspect','id','operation','diagnostics','output'])elements.set(`package-${name}`,{value:'',checked:false,disabled:false,textContent:'',events:{},addEventListener(name,callback){this.events[name]=callback;}});
    const document={getElementById:name=>elements.get(name),querySelectorAll:()=>[...elements.values()],createElement:()=>({click(){}})};
    let commits=0;
    mountRolePackages({document,base:'/local-capabilities',token:'synthetic-session',fetch:async(_url,options)=>{const body=JSON.parse(options.body);if(body.op.endsWith('export.prepare'))return {json:async()=>({ok:true,result:{package_id:'1'.repeat(32),package_digest:'2'.repeat(64),revision:1,confirmation_digest:'x'}})};if(body.op.endsWith('export.commit')){commits++;throw new Error('synthetic transport loss');}throw new Error('unexpected request');}});
    elements.get('package-password').value=password;await elements.get('package-export').events.click();
    elements.get('package-consent').checked=true;elements.get('package-consent').events.change();
    assert.equal(elements.get('package-confirm').disabled,false);
    await elements.get('package-confirm').events.click();assert.equal(commits,1);assert.equal(elements.get('package-confirm').disabled,true);assert.equal(elements.get('package-password').value,'');
    await elements.get('package-confirm').events.click();assert.equal(commits,1);
  });
  console.log(`T5 native Node checks: ${passed} PASS; no model/platform/device calls.`);
} finally {
  for(const supervisor of supervisors)await supervisor.stop();
  // Only the resolved fresh test directory is removed; no user profile paths.
  if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('surfcore-t5-native-'))throw new Error('unsafe cleanup');
  fs.rmSync(temporary,{recursive:true,force:true});
}
