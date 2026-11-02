import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CapabilitySupervisor, CapabilityError } from '../plugins/surfcore/lib/local-capabilities/supervisor.js';
import { LocalCapabilities } from '../plugins/surfcore/lib/local-capabilities/facade.js';
import { createManagementHandler } from '../plugins/surfcore/lib/local-capabilities/management.js';
import { isLoopbackReq, json, sameOrigin } from '../plugins/surfcore/lib/http-guard.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, '.local/integration-tests', 'management-' + crypto.randomUUID());
const secret = 'synthetic-backup-passphrase';
const magic = Buffer.from('SURFCORE-MEMORY1\n');
const resources = [];
// Execute the actual host route wrapper, without starting the rest of DSH.
const hostSource = fs.readFileSync(path.join(repo, 'plugins/surfcore/lib/index.js'), 'utf8');
const routeStart = hostSource.indexOf('  function route(kind, pathname, handler) {');
const routeEnd = hostSource.indexOf('\n  const local = localCapabilities();', routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart);
const routeSource = hostSource.slice(routeStart, routeEnd);
let count = 0;
async function check(name, action) { await action(); console.log(`ok ${++count} ${name}`); }
async function fixture(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const supervisor = new CapabilitySupervisor({ python: path.join(repo, '.venv/Scripts/python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(directory, 'data'), env: { SURFCORE_LOCAL_KEY: crypto.randomBytes(32).toString('hex') } });
  const local = new LocalCapabilities({ supervisor, stateFile: path.join(directory, 'backend.json'), currentCharacter: () => ({ id: 'synthetic-role', epoch: 1 }) });
  const mount = '/dsh-surfcore/local-capabilities';
  const handler = createManagementHandler({ capabilities: local, base: mount });
  const routes = new Map();
  const route = vm.runInNewContext(`(${routeSource.trim()})`, {
    disposers: [], isLoopbackReq, json, sameOrigin, pluginLog: () => {},
    ctx: { webServer: { register({ path, handler }) { routes.set(path, handler); return () => {}; } },
      get: () => ({ requestRejection: req => req.headers['x-test-dsh-session'] === 'synthetic-host-session' ? false : 401 }) },
  });
  for (const suffix of ['', '/tools', '/semantic', '/api', '/backup/import', '/backup/download']) route('exact', mount + suffix, handler);
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
    if (handler) void handler(req, res); else { res.statusCode = 404; res.end(); }
  });
  resources.push({ supervisor, server });
  await local.setMode('local');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + mount, { headers: { 'x-test-dsh-session': 'synthetic-host-session' } });
  const html = await page.text();
  const token = html.match(/const token='([a-f0-9]+)'/)[1];
  const headers = { origin: base, cookie: page.headers.get('set-cookie').split(';')[0], 'x-surfcore-session': token, 'x-test-dsh-session': 'synthetic-host-session' };
  const post = (suffix, body, type = 'application/json', override = {}) => fetch(base + mount + suffix, { method: 'POST', headers: { ...headers, 'content-type': type, ...override }, body: type === 'application/json' ? JSON.stringify(body) : body });
  const call = async (op, params = {}) => (await post('/api', { op, params })).json();
  return { local, supervisor, directory, base, html, headers, post, call };
}

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; }
  set textContent(value) { this._text = String(value); this.children = []; } get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set innerHTML(_) { throw Error('Unsafe HTML'); }
  append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; this._text = ''; }
  setAttribute(key, value) { this[key] = value; }
}
function all(el) { return [el, ...el.children.flatMap(all)]; }

import { mountSemanticManagement } from '../plugins/surfcore/lib/local-capabilities/semantic-client.js';

try {
 await check('real UI save cannot configure another role after last status response', async()=>{
  const a=await fixture('configure-race'); let role={id:'semantic-role-a',epoch:1};a.local.currentCharacter=()=>role;
  await a.local.setMode('local');role={id:'semantic-role-b',epoch:1};await a.local.setMode('local');role={id:'semantic-role-a',epoch:1};await a.local.setMode('local');
  const display=new Element('main');let flip=false;
  const app=mountSemanticManagement({document:{createElement:tag=>new Element(tag)},root:display,base:'/local',token:'unused-fixture',pollMs:0,fetch:async(url,init)=>{
   const req=JSON.parse(init.body);const response=await a.post('/api',req);const value=await response.json();
   if(flip&&req.op==='status'){flip=false;role={id:'semantic-role-b',epoch:1};}
   return {ok:response.ok,json:async()=>value};
  }});await app.ready;
  const el=id=>all(display).find(e=>e.id===id);el('semanticEnabled').checked=true;flip=true;await el('semanticSave').onclick();
  const b=await a.call('memory.semantic.status');role={id:'semantic-role-a',epoch:1};const original=await a.call('memory.semantic.status');app.dispose();
  assert.equal(b.result.enabled,false,'the old A page must not enable B');assert.equal(original.result.enabled,false);assert.match(el('semanticError').textContent,/STALE_CHARACTER/);
 });
 for(const change of ['other-role','new-epoch'])for(const op of ['memory.semantic.configure','memory.correct','memory.suspend','memory.delete']){
  await check(op+' binds expected role and epoch across '+change,async()=>{
   const f=await fixture(op.replaceAll('.','-')+'-'+change);let role={id:'fixed-role-a',epoch:1};f.local.currentCharacter=()=>role;await f.local.setMode('local');await f.local.shareOwner(true);
   const c=await f.local.context({kind:'pet'});await f.local.ingest(c,'synthetic-event','合成来源应保持不变',{actor:'user'});const records=await f.local.management('memory.query',{query:'',limit:10});const item=records.memories[0];assert.ok(item);
   const reviewed={...role};role=change==='other-role'?{id:'fixed-role-b',epoch:1}:{id:'fixed-role-a',epoch:2};await f.local.setMode('local');
   let commands=0;const raw=f.supervisor.raw.bind(f.supervisor);f.supervisor.raw=(name,...args)=>{if(name===op)commands++;return raw(name,...args);};
   const params=op==='memory.semantic.configure'?{enabled:true}:{id:item.id,expected_revision:item.revision,...(op==='memory.correct'?{statement:'不应保存的修改'}:{})};
   const result=await(await f.post('/api',{op,params,expectedCharacter:reviewed})).json();assert.equal(result.ok,false);assert.equal(result.code,'STALE_CHARACTER');assert.ok(result.hint);assert.equal(commands,0);
   f.supervisor.raw=raw;role={id:'fixed-role-a',epoch:1};const unchanged=await f.local.management('memory.detail',{id:item.id});assert.equal(unchanged.memory.statement,item.statement);assert.equal(unchanged.memory.status,'active');
  });
 }
 await check('late management session.bind cannot mutate using a newly active role',async()=>{
  const f=await fixture('late-binding');let role={id:'bind-role-a',epoch:1};f.local.currentCharacter=()=>role;await f.local.setMode('local');
  const raw=f.supervisor.raw.bind(f.supervisor);let configures=0;f.supervisor.raw=async(op,...args)=>{const result=await raw(op,...args);if(op==='session.bind')role={id:'bind-role-b',epoch:1};if(op==='memory.semantic.configure')configures++;return result;};
  const result=await(await f.post('/api',{op:'memory.semantic.configure',params:{enabled:true},expectedCharacter:{id:'bind-role-a',epoch:1}})).json();assert.equal(result.code,'STALE_CHARACTER');assert.equal(configures,0);assert.ok(result.hint);
 });
 console.log('PASS '+count+' real wrapper/HTTP/SQLCipher semantic role-precondition checks; no model/device/platform');
} finally { for(const r of resources){r.server.closeAllConnections?.();await new Promise(resolve=>r.server.close(resolve));await r.supervisor.stop();} }
