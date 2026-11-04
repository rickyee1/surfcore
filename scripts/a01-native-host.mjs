import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { isPromise } from 'node:util/types';
import { inside, IDS, modelControls, fault } from './a01-contract.mjs';
import { createModelPolicy, installAgentPolicy, requestControls, verifyPrepared, verifyCallEvidence } from './a01-model-policy.mjs';

export const name = 'a01-native-host';
export const inject = ['llm','agentDefaultModel','webServer','settings','configEditor'];

// Observe the installed service; forward the exact options, chunks, configure
// callback, prepared one-shot closure, this receiver, cancellation and throws.
export function observeLlm(llm, { now = Date.now, tags = () => ({}), readModelCall = () => undefined, isAgentLoopRequest = () => false, steps = new Map(), timeoutPolicy = null } = {}) {
  if (!['prepareCall','stream','resolveCallWithInfo'].every(k => typeof llm?.[k] === 'function')) throw fault('LLM_OBSERVER_NOT_SUPPORTED', 'This runtime must expose prepareCall, stream and resolveCallWithInfo.');
  const storage = new AsyncLocalStorage(), producers = new AsyncLocalStorage(), calls = [], originals = Object.fromEntries(['prepareCall','stream','resolveCallWithInfo'].map(k => [k, llm[k]]));
  let sequence = 0;
  const create = (recordType = 'attempt') => { const call = { callId: `call-${++sequence}`, ...tags(), recordType, startedAt: now(), endedAt: null, dispatched: false, finish: null, usage: null, output: '', producer: 'unknown' }; calls.push(call); return call; };
  const failed = (call, e) => { call.endedAt = now(); let code = 'LLM_THROW'; try { if (typeof e?.code === 'string') code = e.code; } catch {} call.failure = { code }; };
  function describe(call, options = {}) {
    call.finalStreamControls = streamControls(options);
    call.sessionId = options.sessionId ?? null; call.purpose = options.purpose ?? null;
    call.isAgentLoopRequest = isAgentLoopRequest(options) === true;
    const registered = readModelCall(options);
    if (registered) { Object.assign(call, registered); call.producerSource = 'options-weakmap'; }
    else if (call.isAgentLoopRequest) { call.producer = 'agent-loop'; call.producerSource = 'native-agent-marker'; Object.assign(call, steps.get(call.sessionId) || {}); }
    else if (options.purpose === 'session-title') { call.producer = 'session-title'; call.producerSource = 'native-purpose'; }
    else if (producers.getStore() === 'pet-chat') { call.producer = 'pet-chat'; call.producerSource = 'pet-chat-scope'; }
    if (timeoutPolicy) call.timeoutPolicy = { ...timeoutPolicy };
  }
  function monitor(iterable, call) {
    const proxies = new WeakMap();
    const observe = item => {
      // Observation must never replace a producer's returned value or failure.
      try {
        if (item?.done) call.endedAt = now();
        else if (item && typeof item === 'object') {
          call.endedAt = null;
          const chunk = item.value;
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') call.output += chunk.text;
          if (chunk?.type === 'usage') call.usage = structuredClone(chunk.usage);
          if (chunk?.type === 'finish') call.finish = { kind: chunk.reason?.kind || 'unknown', code: chunk.reason?.failure?.code || null };
        }
      } catch { call.observationFailure = { code: 'LLM_OBSERVER_CAPTURE_FAILED' }; }
    };
    const returned = result => {
      if (isPromise(result)) {
        // Retain the native Promise itself, including its rejection and timing.
        Promise.prototype.then.call(result, observe, error => { failed(call, error); });
        return result;
      }
      if (result && ['object','function'].includes(typeof result) && 'then' in result) {
        // Observe a custom thenable only when its consumer invokes then; do not
        // consume it a second time or turn a synchronous result into a Promise.
        const thenable = new Proxy(Object.create(Object.getPrototypeOf(result)), { has: (_shell, key) => Reflect.has(result, key), get(_shell, key) {
          let member; try { member = Reflect.get(result, key, result); } catch (error) { failed(call, error); throw error; }
          if (key !== 'then' || typeof member !== 'function') return member;
          return function (fulfilled, rejected, ...args) {
            return member.call(this === thenable ? result : this, function (value) { observe(value); return typeof fulfilled === 'function' ? fulfilled.call(this, value) : value; }, function (error) { failed(call, error); if (typeof rejected === 'function') return rejected.call(this, error); throw error; }, ...args);
          };
        } }); return thenable;
      }
      observe(result); return result;
    };
    const wrap = target => {
      if (!target || !['object','function'].includes(typeof target)) return target;
      if (proxies.has(target)) return proxies.get(target);
      const proxy = new Proxy(Object.create(Object.getPrototypeOf(target)), { has: (_shell, key) => Reflect.has(target, key), get(_shell, key) {
        let member; try { member = Reflect.get(target, key, target); } catch (error) { failed(call, error); throw error; }
        if (![Symbol.asyncIterator, 'next', 'throw', 'return'].includes(key) || typeof member !== 'function') return member;
        return function (...args) {
          try {
            const receiver = this === proxy ? target : this;
            const result = storage.run(call, () => member.apply(receiver, args));
            return key === Symbol.asyncIterator ? wrap(result) : returned(result);
          } catch (error) { failed(call, error); throw error; }
        };
      } });
      proxies.set(target, proxy); return proxy;
    };
    return wrap(iterable);
  }
  llm.resolveCallWithInfo = function (...args) {
    const resolved = originals.resolveCallWithInfo.apply(this, args), call = storage.getStore();
    if (call) { call.effective = modelControls(resolved.config, args[1]); call.resolvedConfig = modelControls(resolved.config); call.resolvedContext = contextControls(resolved.context ?? args[1]?.context); } return resolved;
  };
  llm.stream = function (...args) {
    const call = create(); call.stage = 'stream'; call.requested = modelControls(args[0]); describe(call, args[0]);
    try { const iterable = storage.run(call, () => originals.stream.apply(this, args)); call.recordType = 'call'; call.dispatched = true; return monitor(iterable, call); }
    catch (e) { failed(call, e); throw e; }
  };
  llm.prepareCall = async function (...args) {
    const call = create('preparation'); call.stage = 'prepare'; call.requested = modelControls(args[0]);
    let prepared;
    try { prepared = await storage.run(call, () => originals.prepareCall.apply(this, args)); }
    catch (e) { call.recordType = 'attempt'; failed(call, e); throw e; }
    call.preparedConfig = modelControls(prepared.config); call.preparedContext = contextControls(prepared.context);
    call.effective = { ...(call.effective || modelControls(prepared.config)), contextWindow: prepared.context?.contextWindow ?? call.effective?.contextWindow ?? null };
    const descriptors = Object.getOwnPropertyDescriptors(prepared), originalStream = prepared.stream;
    let attempted = false;
    descriptors.stream = { ...descriptors.stream, value: function (...streamArgs) {
      const attempt = attempted ? create() : call; attempted = true;
      if (attempt !== call) {
        attempt.preparedCallId = call.callId;
        for (const key of ['requested','preparedConfig','preparedContext','effective','resolvedConfig','resolvedContext']) if (call[key] !== undefined) attempt[key] = structuredClone(call[key]);
      }
      attempt.recordType = 'attempt'; attempt.stage = 'prepared.stream'; describe(attempt, streamArgs[0]);
      try { const iterable = storage.run(attempt, () => originalStream.apply(prepared, streamArgs)); attempt.recordType = 'call'; attempt.dispatched = true; return monitor(iterable, attempt); }
      catch (e) { failed(attempt, e); throw e; }
    } };
    return Object.freeze(Object.create(Object.getPrototypeOf(prepared), descriptors));
  };
  return { calls, runPet: action => producers.run('pet-chat', action), restore() { for (const [key, value] of Object.entries(originals)) llm[key] = value; } };
}
export function streamControls(options = {}) {
  const out = {};
  for (const key of ['provider','model','temperature','maxTokens','reasoningEffort','stop','seed','sessionId','purpose']) if (options[key] !== undefined) out[key] = structuredClone(options[key]);
  out.signalAborted = options.signal?.aborted === true; return out;
}
export function contextControls(context) {
  if (!context) return null;
  const out = {}; for (const key of ['contextWindow','maxInputTokens','maxOutputTokens']) if (context[key] !== undefined) out[key] = context[key]; return out;
}
export function nativeControlEvidence(ctx, policy) {
  const entries = ctx.get('configEditor').entries();
  const adapter = entries.find(row => row.options.id === 'llm-deepseek');
  const value = key => { const field = adapter?.fiber?.config?.[key]; return typeof field?.get === 'function' ? field.get() : field; };
  const idle = value('streamIdleTimeoutMs'), reasoning = value('reasoningEffort');
  const active = id => entries.some(row => row.options.id === id && row.fiber?.state === 2);
  if (idle !== policy.controls.adapterIdleTimeoutMs || reasoning !== 'off' || active('session-title-llm') || !active('session-title') || !active('agent-loop')) throw fault('NATIVE_CONTROL_NOT_VERIFIED', 'Check native active Loader entries and adapter settings before starting a scene.');
  return Object.freeze({ policyHash: policy.hash, adapterIdleTimeoutMs: idle, totalDeadlineMs: policy.controls.totalDeadlineMs, adapterEvidence: 'native-config' });
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
  const policy = createModelPolicy(c.selection, c.scene.setup.channel);
  if (policy.hash !== c.modelPolicy?.hash) throw fault('MODEL_POLICY_CHANGED', 'Use the frozen trial policy.');
  const nativeRequire = createRequire(path.resolve(process.argv[1]));
  const { isAgentLoopRequest } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href);
  let readModelCall = () => undefined;
  if (c.version === 'fork') {
    readModelCall = (await load('plugins/surfcore/lib/local-capabilities/model-call-registry.js')).readModelCall;
    (await load('plugins/surfcore/lib/local-capabilities/host.js')).configureSemanticWriterModelPolicy(policy);
  }
  let phase = 'startup', inputWindow = null;
  const steps = new Map(), offPolicy = installAgentPolicy(ctx, policy, steps);
  const timeoutPolicy = { policyHash: policy.hash, adapterIdleTimeoutMs: null, totalDeadlineMs: null, adapterEvidence: 'unknown' };
  const observation = observeLlm(ctx.get('llm'), { tags: () => ({ phase, inputWindow, modelPolicy: policy }), readModelCall, isAgentLoopRequest, steps, timeoutPolicy }), toolEvents = [], turnEvents = [];
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
    ready: async () => {
      Object.assign(timeoutPolicy, nativeControlEvidence(ctx, policy));
      const prepared = await ctx.get('llm').prepareCall(requestControls(policy)); verifyPrepared(policy, prepared);
      return { ready: true, pid: process.pid, trialId: c.trialId, repo, home: process.env.DSH_HOME, selection: ctx.get('agentDefaultModel').currentSelection(), observer: true, nativePet: 'createPetChatService.chat', node: process.version, modelPolicy: policy, timeoutPolicy };
    },
    seed,
    mark: async data => { if (!['history','scored'].includes(data.phase) || !Number.isInteger(data.inputWindow)) throw fault('INVALID_PHASE'); phase = data.phase; inputWindow = data.inputWindow; return { phase, inputWindow }; },
    pet: async data => { if (!seeded) throw fault('SEED_REQUIRED'); return observation.runPet(() => pet.chat({ text: data.text, modality: 'text' })); },
    observe: async () => ({ calls: observation.calls, toolEvents, turnEvents, modelPolicy: policy, controlProblems: observation.calls.filter(call => call.dispatched).flatMap(call => verifyCallEvidence(call, policy).map(code => ({ callId: call.callId, code }))) }),
  };
  const disposers = Object.entries(handlers).map(([op, handler]) => ctx.webServer.register({ kind: 'exact', path: `/a01-native/${op}`, handler: async (req, res) => {
    let result;
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'POST' || req.headers['x-a01-control'] !== process.env.A01_CONTROL_TOKEN || req.headers.origin) throw fault('PERMISSION_DENIED');
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw fault('BODY_TOO_LARGE'); }
      result = { ok: true, result: await handler(JSON.parse(body || '{}')) };
    } catch (e) { result = { ok: false, code: e.code || 'NATIVE_HOST_FAILED', error: 'A01 native control or preflight failed.', hint: e.hint || 'Keep this failed run; inspect isolated host readiness without retrying the scene.' }; }
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result));
  } }));
  ctx.on('dispose', () => { observation.restore(); offPolicy?.(); off?.(); for (const dispose of disposers) dispose(); });
}
export default { name, inject, apply };
