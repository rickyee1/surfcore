// Extended from critical's actual ChatHost -> did-finish-load -> bubble.play counterexample.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { patchPetMedia, patchPetRenderer } from './patch-surfpet-media.mjs';
const base = path.resolve('.local/evidence/t4-host-attempt1/surfpet-t3-base.js');
const dist = path.resolve(process.argv[2] || '.local/apps/surfpet/v0.2.3-prep-1a4cdf9b/dist');
const patched = patchPetMedia(fs.readFileSync(base, 'utf8'));
const tick = async () => { for (let n = 0; n < 4; n++) await new Promise(r => setImmediate(r)); };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function renderer(kind) {
  const nodes = new Map(), created = [], callbacks = {}, timers = [];
  class Node {
    listeners = new Map(); children = []; dataset = {}; style = {}; value = ''; scrollTop = 0; clientHeight = 100; scrollHeight = 100;
    classList = { toggle() {}, add() {}, remove() {} };
    addEventListener(name, fn) { this.listeners.set(name, fn); } append(...items) { this.children.push(...items); }
    querySelectorAll() { return []; } getBoundingClientRect() { return { height: 100 }; } focus() {} select() {}
  }
  let plays = 0; const audio = new Node(); Object.assign(audio, { paused: true, pause() { this.paused = true; }, removeAttribute(name) { delete this[name]; }, load() {}, async play() { plays++; this.paused = false; } });
  const document = { hidden: false, body: new Node(), getElementById(id) { if (id === 'audio' || id === 'player') return audio; if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement(tag) { const node = new Node(); node.tag = tag; created.push(node); return node; }, addEventListener() {}, querySelectorAll: () => [audio] };
  const api = kind === 'bubble' ? { resize() {}, audioStarted() {}, hover() {}, action() {}, onShow(f) { callbacks.show = f; }, onHide() {}, onPauseAudio(f) { callbacks.pause = f; }, ready() {} } : {
    setMode() {}, audioStarted() {}, close() {}, reconnect() {}, history: async () => ({ connected: true, messages: [], config: null }),
    onState(f) { callbacks.state = f; }, onMode() {}, onMessage(f) { callbacks.message = f; }, onTyping() {}, onError() {}, onFocusInput() {}, onPauseAudio(f) { callbacks.pause = f; },
  };
  const window = { innerWidth: 300, addEventListener() {}, pet: { [kind === 'bubble' ? 'bubble' : 'chat']: api }, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} };
  const context = { document, window, location: { search: '' }, URLSearchParams, setTimeout: window.setTimeout, cancelAnimationFrame() {}, requestAnimationFrame: () => 1 };
  const original = fs.readFileSync(path.join(dist, `${kind}.js`), 'utf8'); vm.runInNewContext(patchPetRenderer(original, kind), context);
  const win = { isDestroyed: () => false, showInactive() {}, webContents: { isLoading: () => false, once(_e, fn) { callbacks.loaded = fn; }, send(type, payload) { if (type === 'bubble:show') callbacks.show(payload); if (type === 'bubble:pause-audio' || type === 'chat:pause-audio') callbacks.pause(); if (type === 'chat:message') callbacks.message(payload); }, executeJavaScript(code) { return Promise.resolve(vm.runInNewContext(code, context)); } } };
  return { window, document, win, callbacks, timers, created, audio, plays: () => plays, reset: () => { plays = 0; }, playTimers() { for (const { fn } of timers.splice(0).filter(x => x.ms === 120)) fn(); } };
}
const bubble = renderer('bubble'), dialog = renderer('dialog'); await tick();
const posted = [], delivered = [];
class Client { info = { baseUrl: 'http://127.0.0.1:12345' }; isConnected = false; on() {} absoluteUrl(v) { return v; } async request(url, options) { posted.push({ url, ...options }); return { ok: true }; } }
const ctx = { SurfCoreClient: Client, BUBBLE_W: 300, BUBBLE_MIN_H: 100, URL, nowMs: Date.now, setTimeout: () => 1, clearTimeout() {}, import_electron: { shell: { openExternal: async () => {} } } };
const begin = patched.indexOf('var ChatHost = class {'), end = patched.indexOf('\n};', begin) + 3;
vm.runInNewContext(patched.slice(begin, end) + ';globalThis.Host=ChatHost;', ctx);
const host = new ctx.Host({ log() {}, onSpeak() {} }); host.positionBubble = () => {}; host.scheduleBubbleHide = () => {}; host.bubble = bubble.win; host.dialog = dialog.win; host.ensureBubble = () => host.bubble;
host.broadcastDialog = (channel, value) => { if (channel === 'chat:message') { delivered.push(value); dialog.callbacks.message(value); } else if (channel === 'chat:pause-audio') dialog.callbacks.pause(); };
const config = suppressed => ({ role: { id: 'synthetic-role' }, voice: { mediaSuppressed: suppressed, mediaSuppressionNonce: suppressed ? 'a'.repeat(48) : null } });
async function policy(suppressed) { host.config = config(suppressed); await host.applyMediaOutput(host.config); }
const message = (id, generation = host.mediaPlaybackGeneration) => ({ id, messageId: id, role: 'assistant', text: 'synthetic', modality: 'voice', at: 1, playbackGeneration: generation, audio: { url: 'http://127.0.0.1:1/synthetic.wav' }, autoplay: true });
let count = 0; const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`); };
await check('renderer rebuild starts closed; only an installed current permit enables ordinary playback', async () => {
  bubble.callbacks.show(message('default-closed', 0)); assert.equal(bubble.plays(), 0); await policy(false);
  bubble.callbacks.show(message('positive-current')); assert.equal(bubble.plays(), 1); bubble.reset();
});
await check('actual late bubble load after suppression ACK cannot call actual renderer play', async () => {
  bubble.win.webContents.isLoading = () => true; host.displayBubble(message('queued-old')); assert.ok(bubble.callbacks.loaded); const late = bubble.callbacks.loaded;
  await policy(true); assert.equal(posted.length, 1); late(); await tick(); assert.equal(bubble.plays(), 0); bubble.win.webContents.isLoading = () => false; assert.equal(bubble.audio.src, undefined);
});
await check('dialog 120ms autoplay and existing buttons cannot play after suppression or later reopen', async () => {
  await policy(false); const prior = message('dialog-old'); dialog.callbacks.message(prior); const button = dialog.created.findLast(n => n.className === 'voice-play'); assert.ok(button);
  await policy(true); dialog.playTimers(); button.listeners.get('click')(); assert.equal(dialog.plays(), 0);
  await policy(false); button.listeners.get('click')(); assert.equal(dialog.plays(), 0);
  dialog.callbacks.message(message('dialog-current')); dialog.playTimers(); assert.equal(dialog.plays(), 1); dialog.reset();
});
await check('late native chat HTTP cannot adopt a newer playback generation', async () => {
  const pending = defer(); host.client.isConnected = true; host.client.chat = () => pending.promise;
  const generation = host.mediaPlaybackGeneration; const task = host.sendChat('synthetic question', 'voice');
  await policy(true); await policy(false); pending.resolve({ ok: true, reply: message('late-http', generation) }); await task; await tick(); dialog.playTimers();
  assert.equal(delivered.at(-1).audio, undefined); assert.equal(bubble.plays(), 0); assert.equal(dialog.plays(), 0); host.client.isConnected = false;
});
await check('new renderer stays closed until current main permit; old payload remains invalid after grant', async () => {
  const rebuilt = renderer('bubble'); rebuilt.callbacks.show(message('stale-before-grant', host.mediaPlaybackGeneration - 1)); assert.equal(rebuilt.plays(), 0);
  await host.installPlaybackPermit(rebuilt.win); rebuilt.callbacks.show(message('stale-after-grant', host.mediaPlaybackGeneration - 1)); assert.equal(rebuilt.plays(), 0);
  rebuilt.callbacks.show(message('new-current')); assert.equal(rebuilt.plays(), 1);
});
await check('old permit cannot reopen a denied generation or roll back a newer renderer policy', async () => {
  const g = host.mediaPlaybackGeneration; await policy(true); const generation = host.mediaPlaybackGeneration;
  const a = bubble.window.__surfcoreSetPlaybackPermit({ generation: g, allowed: true }); assert.equal(a.allowed, false);
  const b = bubble.window.__surfcoreSetPlaybackPermit({ generation, allowed: true }); assert.equal(b.allowed, false);
  bubble.callbacks.show(message('denied', generation)); assert.equal(bubble.plays(), 0);
});
await check('real SurfCoreClient request stamps replies/events/history before any network await', async () => {
  const clientStart = patched.indexOf('var SurfCoreClient = class extends'), clientEnd = patched.indexOf('\n};', clientStart) + 3; const response = defer();
  const env = { import_node_events: { EventEmitter }, AbortSignal, URL, fetch: () => response.promise };
  vm.runInNewContext(patched.slice(clientStart, clientEnd) + ';globalThis.Client=SurfCoreClient;', env); const client = new env.Client(); client.mediaPlaybackGeneration = 3;
  client.ensureHost = async () => ({ baseUrl: 'http://127.0.0.1:1', api: '/synthetic', token: 'synthetic' });
  const result = client.request('/events'); client.mediaPlaybackGeneration = 9; response.resolve({ ok: true, text: async () => JSON.stringify({ reply: message('reply'), events: [message('event')], messages: [message('history')] }) });
  const data = await result; assert.equal(data.reply.playbackGeneration, 3); assert.equal(data.events[0].playbackGeneration, 3); assert.equal(data.messages[0].playbackGeneration, 3);
});
console.log(`PASS ${count} exact main/bubble/dialog late-play checks; no Electron windows/devices or HTTP requests.`);
