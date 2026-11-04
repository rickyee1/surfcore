import assert from 'node:assert/strict';
import { observeLlm } from './a01-native-host.mjs';
import { parity } from './a01-contract.mjs';
let count = 0;
const check = async (name, action) => { await action(); console.log(`ok ${++count} ${name}`); };
const chunk = text => ({ type: 'text-delta', text });
function runtime(stream, prepare) {
  return { stream, resolveCallWithInfo: (config, info) => ({ config, context: info?.context }), prepareCall: prepare || (async config => ({ config, stream })) };
}
await check('next/throw/return forward exact args, receiver, recovered values and done:false return', async () => {
  const sent = [], error = Error('recover'), first = { value: chunk('one'), done: false }, recovered = { value: chunk('two'), done: false }, returning = { value: chunk('three'), done: false }, done = { value: { terminal: true }, done: true };
  const iterator = { next(...args) { assert.equal(this, iterator); sent.push(['next', ...args]); return Promise.resolve(sent.length === 1 ? first : done); }, throw(...args) { assert.equal(this, iterator); sent.push(['throw', ...args]); return Promise.resolve(recovered); }, return(...args) { assert.equal(this, iterator); sent.push(['return', ...args]); return Promise.resolve(returning); }, [Symbol.asyncIterator]() { assert.equal(this, iterator); return this; } };
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try {
    const stream = llm.stream({}), wrapped = stream[Symbol.asyncIterator](); assert.equal(wrapped[Symbol.asyncIterator](), wrapped);
    assert.equal(await wrapped.next('input', 2), first); assert.equal(await wrapped.throw(error, 'extra'), recovered); assert.equal(await wrapped.return('return-value', 4), returning); assert.equal(observed.calls[0].endedAt, null);
    assert.equal(await wrapped.next('after-return'), done); assert.deepEqual(sent, [['next','input',2],['throw',error,'extra'],['return','return-value',4],['next','after-return']]); assert.equal(observed.calls[0].output, 'onetwothree'); assert.ok(observed.calls[0].endedAt); assert.equal(observed.calls[0].failure, undefined);
  } finally { observed.restore(); }
});
await check('sync iterator return objects and throws stay synchronous; missing throw stays absent', () => {
  const error = Error('sync method'), result = { value: 'returned', done: true };
  const iterator = { next() { assert.equal(this, iterator); throw error; }, return(value) { assert.equal(value, 42); return result; }, [Symbol.asyncIterator]() { return this; } };
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try { const wrapped = llm.stream({})[Symbol.asyncIterator](); assert.equal(wrapped.throw, undefined); assert.equal('throw' in wrapped, false); assert.throws(() => wrapped.next(), value => value === error); assert.equal(wrapped.return(42), result); }
  finally { observed.restore(); }
});
await check('async throw/rejection is unchanged and does not synthesize return cleanup', async () => {
  const error = Error('async iterator error'); let returned = 0;
  const iterator = { next: () => Promise.reject(error), return() { returned++; return Promise.resolve({ done: true }); }, [Symbol.asyncIterator]() { return this; } };
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try { await assert.rejects(llm.stream({})[Symbol.asyncIterator]().next(), value => value === error); assert.equal(returned, 0); assert.ok(observed.calls[0].endedAt); }
  finally { observed.restore(); }
});
await check('real frozen async generator recovers throw and yields from finally during return(value)', async () => {
  const error = Error('caught by generator'); let caught;
  const iterator = (async function* () { try { try { yield chunk('first'); } catch (value) { caught = value; yield chunk('recovered'); } } finally { yield chunk('closing'); } })(); Object.freeze(iterator);
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try { const stream = llm.stream({}); assert.deepEqual(await stream.next(), { value: chunk('first'), done: false }); assert.deepEqual(await stream.throw(error), { value: chunk('recovered'), done: false }); assert.equal(caught, error); assert.deepEqual(await stream.return('terminal-value'), { value: chunk('closing'), done: false }); assert.equal(observed.calls[0].endedAt, null); assert.deepEqual(await stream.next(), { value: 'terminal-value', done: true }); assert.equal(observed.calls[0].output, 'firstrecoveredclosing'); assert.equal(observed.calls[0].failure, undefined); }
  finally { observed.restore(); }
});
await check('native Promise identity and primitive synchronous exceptions are retained', async () => {
  const result = { value: chunk('promise'), done: false }, promise = Promise.resolve(result);
  const iterator = Object.freeze({ next() { return promise; }, throw() { throw null; }, [Symbol.asyncIterator]() { return this; } });
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try { const stream = llm.stream({}); assert.equal(stream.next(), promise); assert.equal(await promise, result); let caught = false; try { stream.throw(); } catch (value) { caught = true; assert.equal(value, null); } assert.equal(caught, true); assert.equal(observed.calls[0].failure.code, 'LLM_THROW'); }
  finally { observed.restore(); }
});
await check('borrowed protocol methods keep explicit caller receiver and native unbound rejection', async () => {
  const receiver = { custom: true }, result = { done: true };
  const iterator = { next(value) { assert.equal(this, receiver); assert.equal(value, 'borrowed'); return result; }, [Symbol.asyncIterator]() { return this; } };
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try { assert.equal(llm.stream({}).next.call(receiver, 'borrowed'), result); }
  finally { observed.restore(); }
  const generator = (async function* () { yield chunk('native'); })(), native = runtime(() => generator), monitor = observeLlm(native);
  try { const originalUnbound = generator.next; await assert.rejects(originalUnbound(), TypeError); const unbound = native.stream({}).next; await assert.rejects(unbound(), TypeError); }
  finally { monitor.restore(); }
});
await check('custom thenables stay lazy, preserve result and then getter rejection boundary', async () => {
  const result = { value: chunk('thenable'), done: false }, error = Error('then getter'); let invoked = 0;
  const thenable = Object.freeze({ then(resolve) { invoked++; assert.equal(this, thenable); resolve(result); } });
  const iterator = { next: () => thenable, return: () => ({ get then() { throw error; } }), [Symbol.asyncIterator]() { return this; } };
  const llm = runtime(() => iterator), observed = observeLlm(llm);
  try { const stream = llm.stream({}), pending = stream.next(); assert.equal(invoked, 0); assert.equal(await pending, result); assert.equal(invoked, 1); const returned = stream.return(); await assert.rejects(async () => returned, value => value === error); assert.equal(observed.calls[0].output, 'thenable'); }
  finally { observed.restore(); }
});
function preparedRuntime({ rejectFirst = false, delayedError = null, prepareError = null } = {}) {
  let used = false;
  return runtime(() => { throw Error('unexpected direct path'); }, async config => {
    if (prepareError) throw prepareError;
    return Object.freeze({ config, context: { contextWindow: 1048576 }, stream(options) {
      if (rejectFirst || used) throw Object.assign(Error('one-shot/config reject'), { code: 'INVALID_PREPARED_CALL' }); used = true;
      return { [Symbol.asyncIterator]() { if (delayedError) throw delayedError; return (async function* () { yield chunk('success'); yield { type: 'finish', reason: { kind: 'stop' } }; return 'terminal'; })(); } };
    } });
  });
}
await check('second prepared sync rejection is a separate non-dispatched attempt; successful evidence stays identical', async () => {
  const llm = preparedRuntime(), observed = observeLlm(llm);
  try {
    const prepared = await llm.prepareCall({ provider: 'p', model: 'm', maxTokens: 700 });
    for await (const part of prepared.stream({ ...prepared.config, sessionId: 'original', purpose: 'main' })) void part;
    const success = structuredClone(observed.calls[0]);
    assert.throws(() => prepared.stream({ provider: 'p', model: 'm', maxTokens: 123, sessionId: 'rejected', purpose: 'session-title' }), value => value.code === 'INVALID_PREPARED_CALL');
    assert.deepEqual(observed.calls[0], success); assert.equal(observed.calls.length, 2);
    const attempt = observed.calls[1]; assert.equal(attempt.recordType, 'attempt'); assert.equal(attempt.dispatched, false); assert.equal(attempt.preparedCallId, success.callId); assert.equal(attempt.sessionId, 'rejected'); assert.equal(attempt.finalStreamControls.maxTokens, 123); assert.equal(attempt.failure.code, 'INVALID_PREPARED_CALL'); assert.equal(attempt.output, ''); assert.equal(attempt.finish, null); assert.ok(attempt.endedAt);
    assert.ok(parity([{ state: 'completed', channel: 'p', calls: observed.calls }]).some(value => value.code === 'MODEL_CALL_ATTEMPT_REJECTED'));
  } finally { observed.restore(); }
});
await check('first synchronous config rejection and preparation failure are attempts, never model dispatches', async () => {
  for (const mode of ['rejectFirst','prepareError']) {
    const error = Object.assign(Error('prepare error'), { code: 'PREPARE_NATIVE' }), llm = preparedRuntime(mode === 'rejectFirst' ? { rejectFirst: true } : { prepareError: error }), observed = observeLlm(llm);
    try { if (mode === 'rejectFirst') { const prepared = await llm.prepareCall({}); assert.throws(() => prepared.stream({}), value => value.code === 'INVALID_PREPARED_CALL'); } else await assert.rejects(llm.prepareCall({}), value => value === error);
      assert.equal(observed.calls[0].dispatched, false); assert.equal(observed.calls[0].recordType, 'attempt'); assert.equal(observed.calls[0].output, ''); assert.ok(observed.calls[0].failure); assert.ok(observed.calls[0].endedAt);
    } finally { observed.restore(); }
  }
});
await check('accepted iterable with delayed acquisition error stays a real failed model call', async () => {
  const error = Object.assign(Error('delayed'), { code: 'ITERATOR_ACQUIRE' }), llm = preparedRuntime({ delayedError: error }), observed = observeLlm(llm);
  try { const prepared = await llm.prepareCall({}); const stream = prepared.stream({}); assert.equal(observed.calls[0].dispatched, true); assert.throws(() => stream[Symbol.asyncIterator](), value => value === error); assert.equal(observed.calls[0].recordType, 'call'); assert.equal(observed.calls[0].failure.code, 'ITERATOR_ACQUIRE'); assert.ok(observed.calls[0].endedAt); }
  finally { observed.restore(); }
});
console.log(`PASS ${count} transparent observer protocol/attempt checks; pure memory only.`);
