import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inside, IDS, modelControls, fault } from './a01-contract.mjs';

export const name = 'a01-native-host';
export const inject = ['llm','agentDefaultModel','webServer','settings'];

// Observe the installed service; forward the exact options, chunks, configure
// callback, prepared one-shot closure, this receiver, cancellation and throws.
export function observeLlm(llm, { now = Date.now, tags = () => ({}) } = {}) {
  if (!['prepareCall','stream','resolveCallWithInfo'].every(k => typeof llm?.[k] === 'function')) throw fault('LLM_OBSERVER_NOT_SUPPORTED', 'This runtime must expose prepareCall, stream and resolveCallWithInfo.');
  const storage = new AsyncLocalStorage(), calls = [], originals = Object.fromEntries(['prepareCall','stream','resolveCallWithInfo'].map(k => [k, llm[k]]));
  let sequence = 0;
  const create = () => { const call = { callId: `call-${++sequence}`, ...tags(), startedAt: now(), endedAt: null, dispatched: false, finish: null, usage: null, output: '' }; calls.push(call); return call; };
  function monitor(iterable, call) {
    return { async *[Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator](); let complete = false; call.dispatched = true;
      try {
        while (true) {
          const item = await storage.run(call, () => iterator.next());
          if (item.done) { complete = true; return; }
          const chunk = item.value;
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') call.output += chunk.text;
          if (chunk?.type === 'usage') call.usage = structuredClone(chunk.usage);
          if (chunk?.type === 'finish') call.finish = { kind: chunk.reason?.kind || 'unknown', code: chunk.reason?.failure?.code || null };
          yield chunk;
        }
      } catch (e) { call.failure = { code: e.code || 'LLM_THROW' }; throw e; }
      finally { call.endedAt = now(); if (!complete && iterator.return) await storage.run(call, () => iterator.return()); }
    } };
  }
  llm.resolveCallWithInfo = function (...args) {
    const resolved = originals.resolveCallWithInfo.apply(this, args), call = storage.getStore();
    if (call) call.effective = modelControls(resolved.config, args[1]); return resolved;
  };
  llm.stream = function (...args) {
    const call = create(); call.requested = modelControls(args[0]);
    return monitor(storage.run(call, () => originals.stream.apply(this, args)), call);
  };
  llm.prepareCall = async function (...args) {
    const call = create(); call.requested = modelControls(args[0]);
    let prepared;
    try { prepared = await storage.run(call, () => originals.prepareCall.apply(this, args)); }
    catch (e) { call.endedAt = now(); call.failure = { code: e.code || 'PREPARE_FAILED' }; throw e; }
    const descriptors = Object.getOwnPropertyDescriptors(prepared), originalStream = prepared.stream;
    descriptors.stream = { ...descriptors.stream, value: function (...streamArgs) {
      // Preserve synchronous one-shot/config rejection before iteration.
      return monitor(storage.run(call, () => originalStream.apply(prepared, streamArgs)), call);
    } };
    return Object.freeze(Object.create(Object.getPrototypeOf(prepared), descriptors));
  };
  for (const key of Object.keys(originals)) if (llm[key] === originals[key]) throw fault('LLM_OBSERVER_NOT_INSTALLED');
  return { calls, restore() { for (const [key, value] of Object.entries(originals)) llm[key] = value; } };
}

export async function apply(ctx) {
  const configFile = process.env.A01_TRIAL_CONFIG;
  if (!configFile) throw fault('A01_ISOLATION_REQUIRED');
  const c = JSON.parse(fs.readFileSync(configFile, 'utf8')), trial = path.resolve(c.trialDir), repo = inside(trial, c.repo);
  for (const key of ['DSH_HOME','USERPROFILE','HOME','APPDATA','LOCALAPPDATA']) inside(trial, process.env[key] || '.');
  if (!/^[a-f0-9]{64}$/.test(process.env.A01_CONTROL_TOKEN || '')) throw fault('A01_CONTROL_REQUIRED');
  const load = rel => import(pathToFileURL(path.join(repo, rel)).href);
  const chars = await load('src/character-persona.js');
  const persona = fs.readFileSync(c.personaFile, 'utf8');
  const made = chars.createCharacter({ id: 'a01-role', name: '小岚', personaText: persona, source: 'A01_SYNTHETIC' });
  chars.switchCharacter(made.character.id);
  const selection = ctx.get('agentDefaultModel').currentSelection();
  if (['provider', 'model', 'reasoningEffort'].some(key => selection[key] !== c.selection[key])) throw fault('MODEL_SELECTION_CHANGED', 'The isolated profile must select the frozen model before startup.');
  let phase = 'startup', inputWindow = null;
  const observation = observeLlm(ctx.get('llm'), { tags: () => ({ phase, inputWindow }) }), toolEvents = [], turnEvents = [];
  const off = ctx.on('session/event', (session, event) => {
    const data = event.data || {}, at = Date.now(), sessionId = session?.id || session?.sessionId || null;
    if (event.type === 'tool/call' || event.type === 'tool/result') toolEvents.push({ type: event.type, at, sessionId, turn: data.turn ?? null, phase, inputWindow,
      nativeCallId: data.callId || data.message?.source?.callId || null, tool: data.name || null, isError: data.message?.isError === true });
    if (event.type === 'turn/start' || event.type === 'turn/end') turnEvents.push({ type: event.type, at, sessionId, turn: data.turn ?? null, reason: typeof data.reason === 'string' ? data.reason : data.reason?.kind || null });
  });
  const native = await load('plugins/surfcore/lib/pet-chat.js');
  const pet = native.createPetChatService({ ctx, stateDir: path.join(process.env.DSH_HOME, 'surfcore'), pluginLog: () => {} });
  let seeded = false;
  async function seed() {
    if (seeded) throw fault('ALREADY_SEEDED'); seeded = true; phase = 'seed';
    await ctx.get('settings').update('qq-mode', { mode: ['qc','p'].includes(c.scene.setup.channel) ? 'chat' : 'reserved2', ownerQQ: IDS.owner });
    const receipts = [];
    if (c.version === 'fork') {
      const local = (await load('plugins/surfcore/lib/local-capabilities/host.js')).localCapabilities();
      await local.setQqOwner({ account: IDS.bot, peer: IDS.owner }); await local.shareOwner(c.scene.setup.owner_sharing === true); await local.setMode('local');
      for (const [i, item] of (c.scene.setup.memory || []).entries()) {
        const channel = item.scope === 'pet_private_only' ? { kind: 'pet' } : item.scope === 'group_b' ? { kind: 'qq-group', account: IDS.bot, peer: IDS.group_b } : { kind: 'qq-private', account: IDS.bot, peer: IDS.owner };
        const context = await local.context(channel, item.text);
        const receipt = await local.ingest(context, `a01-seed-${i}`, item.text, { actor: 'user' });
        receipts.push({ scope: item.scope, mechanism: 'native.context+ingest', stored: !receipt.skipped });
      }
    } else {
      const memory = await load('src/memory-card.js'), paths = chars.activeMemoryPaths(), card = memory.createEmptyCard();
      for (const [i, item] of (c.scene.setup.memory || []).entries()) {
        const nativeScope = item.scope === 'pet_private_only' ? 'pet' : 'qq';
        memory.addMemoryRecord(card, { source: 'manual', sourceId: `a01-seed-${i}`, text: item.text, scope: nativeScope, platform: nativeScope, isPrivate: true, direct: true, manual: true, manualImportance: 90, tags: ['a01', `requested-scope:${item.scope}`] });
        receipts.push({ scope: item.scope, mechanism: 'native.addMemoryRecord+saveMemoryCardOutputs', nativeScope });
      }
      memory.saveMemoryCardOutputs(paths, card, {});
    }
    return { seeded: true, receipts, character: { id: made.character.id }, nativeScopeLimitations: c.version === 'original' ? 'Original native card stores QQ/pet scopes; per-group/private requested fine scopes remain source tags, not invented access filters.' : null };
  }
  const handlers = {
    ready: async () => ({ ready: true, pid: process.pid, trialId: c.trialId, repo, home: process.env.DSH_HOME, selection: ctx.get('agentDefaultModel').currentSelection(), observer: true, nativePet: 'createPetChatService.chat', node: process.version }),
    seed,
    mark: async data => { if (!['history','scored'].includes(data.phase) || !Number.isInteger(data.inputWindow)) throw fault('INVALID_PHASE'); phase = data.phase; inputWindow = data.inputWindow; return { phase, inputWindow }; },
    pet: async data => { if (!seeded) throw fault('SEED_REQUIRED'); return pet.chat({ text: data.text, modality: 'text' }); },
    observe: async () => ({ calls: observation.calls, toolEvents, turnEvents }),
  };
  const disposers = Object.entries(handlers).map(([op, handler]) => ctx.webServer.register({ kind: 'exact', path: `/a01-native/${op}`, handler: async (req, res) => {
    let result;
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'POST' || req.headers['x-a01-control'] !== process.env.A01_CONTROL_TOKEN || req.headers.origin) throw fault('PERMISSION_DENIED');
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw fault('BODY_TOO_LARGE'); }
      result = { ok: true, result: await handler(JSON.parse(body || '{}')) };
    } catch (e) { result = { ok: false, code: e.code || 'NATIVE_HOST_FAILED', hint: e.hint || 'Keep this failed run; inspect isolated host readiness without retrying the scene.' }; }
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result));
  } }));
  ctx.on('dispose', () => { observation.restore(); off?.(); for (const dispose of disposers) dispose(); });
}
export default { name, inject, apply };
