import fs from 'node:fs';
import crypto from 'node:crypto';
import { readCurrentCharacter } from './character-persona.js';
import { captureTargetGate, assertTargetGate } from './role-package-gate.js';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LOCAL_ROOT, localBackendGuarded, localBackendMode } from './local-capabilities-state.js';

export function channelError(code, error, hint = '请在 SurfCore 设置 → 本地能力检查服务和渠道绑定，然后重新发起本轮。') {
  return Object.assign(new Error(error), { ok: false, code, error, hint });
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(channelError(signal.reason?.name === 'TimeoutError' ? 'SEMANTIC_CONTEXT_TIMEOUT' : 'REQUEST_CANCELLED', '原渠道请求已取消或超过准备期限。'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Bridge holds no Python process or binding authority. All identity comes from OneBot ingress. */
export class LocalChannelBridge {
  constructor({ config, currentCharacter = readCurrentCharacter, fetchImpl = fetch, guarded = localBackendGuarded, mode = localBackendMode, keyFile = path.join(LOCAL_ROOT, 'channel.key'), authHeaders = async () => ({}), continuity = () => false, onSupersede = () => {} }) {
    this.currentCharacter = currentCharacter; this.packageRole = this.assertReady();
    Object.assign(this, { config, fetchImpl, guarded, mode, keyFile, authHeaders, continuity, onSupersede });
    this.channels = new Map(); this.sessions = new Map(); this.tokens = new Map();
    this.events = new Map(); this.seen = new Set(); this.origin = new AsyncLocalStorage();
    this.inputRevisions = new Map(); this.handoffReceipts = new Map();
    this.ingressSerial = Promise.resolve();
    this.preparations = new Map();
    this.allocations = new Set();
    this.generation = 0;
    this.activityEpoch = crypto.randomUUID();
    this.activityRevision = 0;
    this.ownerActivity = null;
  }
  reportCleanup(error, cleanup) {
    // Releasing a newer preparation successfully cannot hide an older failure.
    if (error.cleanup?.ok === false) return error;
    if (cleanup?.ok === false) error.hint = `${error.hint || '原请求已经停止。'} ${cleanup.error} ${cleanup.hint}`;
    if (cleanup) error.cleanup = { ...cleanup };
    return error;
  }
  cleanupStatus() {
    const states = [...this.allocations].map(allocation => allocation.cleanup.state);
    const failed = states.filter(state => state === 'failed').length;
    const pending = states.filter(state => state === 'pending').length;
    return {
      ok: failed === 0 && pending === 0, failed, pending,
      code: failed ? 'TURN_CLEANUP_FAILED' : pending ? 'TURN_CLEANUP_PENDING' : 'TURN_CLEANUP_CLEAR',
      error: failed ? `${failed} 个原回合清理未获确认。` : pending ? `${pending} 个原回合正在等待清理确认。` : '',
      hint: failed ? '检查本地能力宿主连接后，在调试与运维点击重启桥接，重试保留的清理任务；不要重发已接受的入站。' : pending ? '等待清理结果；原句柄保留到确认完成。' : '',
    };
  }
  // Called by the real adapter before parsing, DB work or any other await.
  // Keep one account+owner binding, with bounded duplicate IDs, independent of memory writes.
  beginIncoming(key, event) {
    if (!this.guarded()) return null;
    const owner = String(this.config().ownerQQ || '');
    const account = String(event.self_id || ''), peer = String(event.user_id || '');
    const id = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    if (key !== `private:${owner}` || peer !== owner) return null;
    if (!/^\d{1,20}$/.test(account) || !/^\d{1,20}$/.test(peer) || !id) throw channelError('BINDING_INVALID', '可信主人入站缺少账号、发送者或消息标识。');
    let activity = this.ownerActivity;
    if (!activity || activity.account !== account || activity.peer !== peer) {
      activity = { account, peer, revision: 0, receivedAt: 0, lastSentAt: 0, processing: 0, seen: new Set() };
      this.ownerActivity = activity;
    }
    if (activity.seen.has(id)) return { duplicate: true };
    activity.seen.add(id);
    if (activity.seen.size > 10000) activity.seen.delete(activity.seen.values().next().value);
    activity.revision = ++this.activityRevision;
    activity.receivedAt = Date.now();
    activity.processing++;
    for (const record of [...this.sessions.values()]) if (record.intent && record.key === key) this.revokeRecord(record, { reason: 'COMPANION_ACTIVITY_CHANGED' });
    let finished = false;
    return { finish: () => { if (!finished) { finished = true; activity.processing--; } } };
  }
  activity(channel) {
    const value = this.ownerActivity;
    if (!value || value.account !== channel?.account || value.peer !== channel?.peer) return null;
    const foreground = value.processing > 0 || [...this.sessions.values()].some(record => !record.proactive && !record.revoked && !record.writerReleased && record.channel.account === value.account && record.channel.peer === value.peer);
    return { epoch: this.activityEpoch, account: value.account, peer: value.peer, revision: value.revision, receivedAt: value.receivedAt, lastSentAt: value.lastSentAt, foreground };
  }
  assertActivity(snapshot, channel) {
    const current = this.activity(channel);
    if (!snapshot || !current || current.epoch !== snapshot.epoch || current.account !== snapshot.account || current.peer !== snapshot.peer || current.revision !== snapshot.revision || current.foreground || this.channels.get(`private:${channel.peer}`)?.account !== channel.account || String(this.config().ownerQQ) !== channel.peer) throw channelError('COMPANION_ACTIVITY_CHANGED', '主人活动或身份已变化，旧主动候选已取消。', '等待当前对话结束；下一轮重新形成想法，不会补发旧正文。');
  }
  noteConfirmedSend(record) {
    const activity = this.ownerActivity;
    if (activity?.account === record.channel.account && activity.peer === record.channel.peer) activity.lastSentAt = Date.now();
  }
  assertReady(captured = this.packageRole) {
    const current = this.currentCharacter();
    try { return captured ? assertTargetGate(captured, current) : captureTargetGate(current); }
    catch (error) { throw channelError(error.code || 'ROLE_PACKAGE_PAUSED', error.message, error.hint); }
  }
  assertScope(generation, key, channel) {
    this.assertReady();
    if (generation !== this.generation || !this.guarded() || this.mode() !== 'local' || this.channels.get(key) !== channel) {
      throw channelError('STALE_CHARACTER', '本地渠道生命周期或原受众已变化，旧请求不能重新登记。', '保持旧请求取消；由新的可信入站建立当前会话，不要重放旧回调。');
    }
  }
  retainInputs(key, inputs) {
    const merged = new Map([...inputs, ...(this.events.get(key) || [])].map(event => [event.id, event]));
    this.events.set(key, [...merged.values()]);
  }
  discardInputs(key, inputs = []) {
    const ids = new Set(inputs.map(input => input.id));
    const remaining = (this.events.get(key) || []).filter(input => !ids.has(input.id));
    if (remaining.length) this.events.set(key, remaining); else this.events.delete(key);
  }
  completeAllocation(allocation) {
    Object.assign(allocation.cleanup, { ok: true, state: 'released', code: 'TURN_RELEASED', error: '', hint: '' });
    if (allocation.owner) { allocation.owner.writerReleased = true; allocation.owner.releaseError = null; }
    this.allocations.delete(allocation);
  }
  cancelAllocation(allocation, { retry = false } = {}) {
    if (allocation.cleanup.state === 'released') return Promise.resolve(allocation.cleanup);
    if (allocation.cleanupPromise && (!retry || allocation.cleanup.state === 'pending')) return allocation.cleanupPromise;
    Object.assign(allocation.cleanup, { ok: false, state: 'pending', code: 'TURN_CLEANUP_PENDING', error: '原回合正在释放。', hint: '等待渠道清理完成。' });
    allocation.cleanupPromise = Promise.resolve().then(async () => {
      if (allocation.context) {
        const result = await this.request('turn.end', allocation.channel, { context: allocation.owner?.context || allocation.context }, { cleanupAllocation: allocation });
        if (result?.released !== true) throw Error('cleanup rejected');
      } else {
        const response = await this.fetchImpl(allocation.url, {
          method: 'POST', headers: allocation.headers,
          body: JSON.stringify({ action: 'turn.cancel', channel: allocation.channel, ...allocation.identity }), signal: AbortSignal.timeout(15000),
        });
        const result = await response.json();
        if (!result?.ok || result.result?.released !== true) throw Error('cleanup rejected');
      }
      this.completeAllocation(allocation);
      return allocation.cleanup;
    }).catch(() => {
      Object.assign(allocation.cleanup, { ok: false, state: 'failed', code: 'TURN_CLEANUP_FAILED', error: '原回合释放未获确认。', hint: '检查本地能力宿主连接后重试停止或重启，以重试清理；原请求保持停止。' });
      if (allocation.owner) { allocation.owner.writerReleased = false; allocation.owner.releaseError = allocation.cleanup; }
      return allocation.cleanup;
    });
    return allocation.cleanupPromise;
  }
  revokeRecord(record, { carry = false, reason = 'TURN_SUPERSEDED', triggerKey } = {}) {
    if (this.sessions.get(record.sessionId) !== record) return;
    // Synchronous revocation precedes all I/O, including auto_write=false where
    // the DB epoch does not change. Captured async origins cannot be refreshed.
    record.revoked = true;
    this.sessions.delete(record.sessionId);
    for (const [token, value] of this.tokens) if (value === record) this.tokens.delete(token);
    const unanswered = carry && !record.prepareSignal?.aborted && !record.transportAttempted && !record.uncertain && !record.inFlight && !record.intent && !record.toolDelivery && record.inputs?.length;
    if (unanswered) this.retainInputs(record.key, record.inputs);
    if (record.transportAttempted) this.handoffReceipts.set(record.key, {
      confirmed: record.confirmedSends || 0, unknown: !!record.uncertain || !!record.inFlight,
    });
    void this.releaseRecord(record);
    this.onSupersede({ key: record.key, sessionId: record.sessionId, retry: !!unanswered, reason, triggerKey });
  }
  async request(action, channel, extra = {}, { signal, onProgress, timeoutMs, owner, cleanupAllocation } = {}) {
    const requestStartedAt = Date.now();
    const requestGeneration = this.generation;
    // Cleanup uses the original opaque handle and authenticated audience even
    // after the local role/mode has changed. The host still checks ownership.
    if (!['turn.end', 'turn.cancel'].includes(action)) {
      if (this.disposing || this.disposed) throw channelError('REQUEST_CANCELLED', '桥接正在停止，本轮不能建立新的本地工作。');
      this.assertReady();
      if (this.mode() !== 'local') throw channelError('SERVICE_UNAVAILABLE', '本地能力已暂停，渠道不会回退旧记忆。');
    }
    let key;
    try { key = cleanupAllocation?.headers?.['x-surfcore-channel-key'] || fs.readFileSync(this.keyFile, 'utf8').trim(); } catch { throw channelError('SERVICE_UNAVAILABLE', '插件宿主尚未建立可信渠道。'); }
    const cfg = this.config(); const base = cleanupAllocation?.url || new URL(cfg.dsh.baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw channelError('PERMISSION_DENIED', '本地能力渠道只接受本机插件宿主。');
    const semantic = action === 'context.refine';
    // Authentication and transport share the original clock. Only a trusted cold
    // status on this same response may select the longer absolute deadline.
    const maximumMs = semantic ? 120000 : action === 'tool.handle' ? 60000 : 15000;
    const deadlineAt = requestStartedAt + Math.min(timeoutMs ?? maximumMs, maximumMs);
    const readyDeadlineAt = Math.min(deadlineAt, requestStartedAt + 8000);
    const deadlineControl = new AbortController();
    const combined = AbortSignal.any([deadlineControl.signal, ...(signal ? [signal] : [])]);
    let deadline = semantic ? readyDeadlineAt : deadlineAt, timer, coldSelected = false;
    const checkDeadline = () => {
      if (action === 'turn.begin' && requestGeneration !== this.generation) throw channelError('REQUEST_CANCELLED', '原回合登记已由停止操作取消。');
      if (semantic && Date.now() >= deadline) deadlineControl.abort(new DOMException('Request deadline exceeded', 'TimeoutError'));
      if (combined.aborted) throw channelError(combined.reason?.name === 'TimeoutError' ? 'SEMANTIC_CONTEXT_TIMEOUT' : 'REQUEST_CANCELLED', '原渠道请求已取消或超过准备期限。');
    };
    const armDeadline = () => {
      clearTimeout(timer); checkDeadline();
      timer = setTimeout(() => deadlineControl.abort(new DOMException('Request deadline exceeded', 'TimeoutError')), Math.max(1, deadline - Date.now()));
    };
    const identity = action === 'turn.begin' ? {
      bridgeInstance: this.activityEpoch, requestId: crypto.randomUUID(), requestIssuedAt: requestStartedAt,
    } : null;
    let body, beginResponse, requestHeaders, allocation;
    try {
      armDeadline();
      const headers = cleanupAllocation?.headers || await abortable(this.authHeaders(), combined);
      checkDeadline();
      requestHeaders = { 'content-type': 'application/json', 'x-surfcore-channel-key': key, ...headers };
      if (identity) {
        allocation = { identity, channel, owner, sessionId: owner?.sessionId, headers: requestHeaders, url: new URL('/dsh-surfcore/api/local-capabilities/channel', base),
          cleanup: { ok: false, state: 'active', code: 'TURN_ACTIVE', error: '', hint: '' } };
        if (owner) owner.allocation = allocation;
        this.allocations.add(allocation);
      }
      const response = this.fetchImpl(new URL('/dsh-surfcore/api/local-capabilities/channel', base), {
        method: 'POST', headers: requestHeaders,
        body: JSON.stringify({ action, channel, ...extra, ...identity, ...(semantic ? { requestStartedAt, readyDeadlineAt, deadlineAt, stream: true } : {}) }), signal: combined,
      });
      // Keep observing an already issued allocation across cancellation. Its
      // parsed handle can arrive after abortable has returned to the caller.
      if (action === 'turn.begin') beginResponse = response.then(res => res.json());
      const res = action === 'turn.begin' ? null : await abortable(response, combined);
      checkDeadline();
      if (semantic && res.headers?.get('content-type')?.startsWith('application/x-ndjson')) {
        const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = ''; let bytes = 0;
        try {
          while (true) {
            const chunk = await abortable(reader.read(), combined);
            checkDeadline();
            if (chunk.done) break;
            bytes += chunk.value.byteLength; if (bytes > 1024 * 1024) throw channelError('PROTOCOL_MISMATCH', '语义响应超过上限。');
            buffer += decoder.decode(chunk.value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
              const value = JSON.parse(line);
              if (value.progress?.state === 'loading' && !body && !coldSelected) {
                // This frame follows the host's first authenticated cold status.
                // A late frame cannot revive the already expired ready request.
                checkDeadline(); coldSelected = true; deadline = deadlineAt; armDeadline();
                await abortable(Promise.resolve(onProgress?.(value.progress)), combined);
                checkDeadline();
              }
              else if (typeof value.ok === 'boolean' && !body) body = value;
              else throw channelError('PROTOCOL_MISMATCH', '语义进度响应格式无效。');
            }
          }
          if (buffer.trim() || !body) throw channelError('PROTOCOL_MISMATCH', '语义响应未完整结束。');
        } finally { await reader.cancel().catch(() => {}); }
      } else body = await abortable(beginResponse || res.json(), combined);
      checkDeadline();
      if (!body || typeof body.ok !== 'boolean') throw channelError('PROTOCOL_MISMATCH', '渠道响应未包含有效结果。');
      if (!body.ok) throw channelError(body.code || 'SERVICE_UNAVAILABLE', body.error || '本地能力拒绝请求。', body.hint);
      if (allocation && typeof body.result?.context !== 'string') throw channelError('PROTOCOL_MISMATCH', '回合响应缺少上下文凭据。');
    } catch (error) {
      beginResponse?.catch(() => {});
      const failure = combined.aborted
        ? channelError(combined.reason?.name === 'TimeoutError' ? 'SEMANTIC_CONTEXT_TIMEOUT' : 'REQUEST_CANCELLED', '原渠道请求已取消或超过准备期限。')
        : error.ok === false && typeof error.code === 'string' ? error : channelError('SERVICE_UNAVAILABLE', '可信渠道请求失败，本轮已停止。');
      if (allocation) {
        // Cleanup uses exactly the credentials, host and request identity of the
        // failed allocation. No retry of begin or use of a successor's handle.
        this.reportCleanup(failure, await this.cancelAllocation(allocation));
      }
      throw failure;
    }
    finally { clearTimeout(timer); }
    if (allocation) allocation.context = body.result.context;
    if (action === 'turn.end' && body.result?.released === true) {
      for (const turn of this.allocations) if (turn.context === extra.context) this.completeAllocation(turn);
    }
    return body.result;
  }
  incoming(key, event, text) {
    // The native memory epoch is character-wide, including across audiences.
    // Serialize only input context->ingest, never model work or long waits.
    const generation = this.generation;
    const work = this.ingressSerial.then(() => this.ingestIncoming(key, event, text, generation));
    this.ingressSerial = work.catch(() => {});
    return work;
  }
  async ingestIncoming(key, event, text, generation = this.generation) {
    this.assertReady();
    if (!this.guarded()) return;
    if (generation !== this.generation) throw channelError('STALE_CHARACTER', '排队入站的本地代次已撤销。');
    if (String(text).length > 16000) throw channelError('INVALID_REQUEST', '本次入站超过16000字符，未截断或执行。', '将完整请求拆分为较短消息后重新发送；不要依赖被截断的工具参数。');
    const [kind, peer] = key.split(':');
    const account = String(event.self_id ?? ''); const principal = String(event.user_id ?? '');
    const id = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    if (!account || !principal || !id) throw channelError('BINDING_INVALID', '可信 QQ 事件缺少账号、发送者或消息标识。');
    const eventId = `${account}:${kind}:${peer}:${id}`;
    if (this.seen.has(eventId)) return { duplicate: true };
    const channel = { kind: kind === 'private' ? 'qq-private' : 'qq-group', account, peer, principal };
    const previous = this.channels.get(key);
    if (previous && previous.account !== account) {
      this.events.delete(key); this.handoffReceipts.delete(key);
      for (const record of this.sessions.values()) if (record.key === key) this.revokeRecord(record, { reason: 'ACCOUNT_CHANGED' });
    }
    this.channels.set(key, channel);
    if (this.continuity()) {
      const required = new Set((this.events.get(key) || []).map(input => input.id));
      for (const record of this.sessions.values()) if (record.key === key && !record.transportAttempted) {
        for (const input of record.inputs || []) required.add(input.id);
      }
      required.add(eventId);
      if (required.size > 20) throw channelError('INBOUND_QUEUE_FULL', '本轮未答请求超过原生20个来源上限，新入站尚未接受。', '核对并分批处理已有未答请求后重新发送；不会截断请求或生成不完整答复。');
    }
    // Protect the input context->ingest window too: a background commit here
    // must not make a newly arrived ordinary message fail as stale.
    const ingress = { key, channel, eventId };
    const ctx = await this.request('turn.begin', channel, { query: '', eventId, text: String(text).slice(0, 16000) }, { owner: ingress });
    ingress.context = ctx.context;
    ingress.allocation ||= [...this.allocations].find(turn => turn.context === ctx.context);
    if (ingress.allocation) ingress.allocation.owner = ingress;
    let outcome, failure, accepted = false;
    try {
    this.assertScope(generation, key, channel);
    const ingested = await this.request('ingest', channel, { context: ctx.context, eventId, text: String(text).slice(0, 16000) });
    accepted = true;
    this.seen.add(eventId);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
    this.assertScope(generation, key, channel);
    if (ingested.duplicate) {
      if (this.channels.get(key) === channel) {
        if (previous) this.channels.set(key, previous); else this.channels.delete(key);
      }
      return outcome = { duplicate: true, accepted: true, eventId };
    }
    this.inputRevisions.set(key, (this.inputRevisions.get(key) || 0) + 1);
    for (const preparation of this.preparations.values()) if (preparation.key === key) preparation.controller.abort();
    const fresh = { id: eventId, context: ctx.context, neverPersisted: ingested.stored === false && ingested.skipped === true, text: String(text).slice(0, 8000) };
    const events = this.events.get(key) || [];
    this.events.set(key, [...events, fresh]);
    if (this.continuity()) {
      for (const record of [...this.sessions.values()]) if (record.key === key) {
        this.revokeRecord(record, { carry: record.characterEpoch === ctx.character_epoch, triggerKey: key });
      }
      // memory_epoch is character-wide. Another audience's append may revoke
      // an old turn too; retain only its own still-unanswered source IDs.
      for (const record of [...this.sessions.values()]) if (record.key !== key) {
        try { await this.request('validate', record.channel, { context: record.context }); }
        catch (error) {
          if (!['STALE_CONTEXT', 'STALE_CHARACTER', 'BINDING_INVALID'].includes(error.code)) throw error;
          this.revokeRecord(record, { carry: error.code === 'STALE_CONTEXT' && record.characterEpoch === ctx.character_epoch, reason: error.code, triggerKey: key });
        }
      }
    }
    if (kind === 'private') {
      await this.request('attention.respond', channel, { context: ctx.context, params: {} }).catch(error => { if (error.code !== 'PERMISSION_DENIED') throw error; });
    }
    this.assertScope(generation, key, channel);
    // Only fresh source events are retained until the next generation; no private purpose/history copies.
    if (!this.continuity()) this.events.set(key, (this.events.get(key) || []).slice(-20));
    return outcome = { context: ctx.context, eventId, accepted: true };
    } catch (error) {
      failure = error;
      if (accepted) {
        error.accepted = true; error.eventId = eventId;
        error.hint = `${error.hint || '请检查后续处理状态。'} 该入站已接受，不要重复发送，请先查看控制台中的后续处理状态。`;
      }
      throw error;
    } finally {
      const cleanup = await this.releaseRecord(ingress);
      if (failure) this.reportCleanup(failure, cleanup);
      else if (cleanup.ok === false) outcome.cleanup = { ...cleanup };
    }
  }
  async prepare(key, sessionId, token, persona = '', { signal, onNotice } = {}) {
    this.assertReady();
    const generation = this.generation;
    const channel = this.channels.get(key);
    if (!channel) throw channelError('BINDING_INVALID', '该会话尚无可信 QQ 入站身份，请先发一条新消息。');
    if (this.sessions.has(sessionId) || this.preparations.has(sessionId)) throw channelError('STALE_CONTEXT', '本地模式拒绝向已有模型历史追加提示，请重新唤醒。');
    const pending = [...(this.events.get(key) || [])];
    if (pending.length > 20) throw channelError('INBOUND_QUEUE_FULL', '待处理请求超过本轮来源上限，未丢弃或截断。', '暂停生成，核对未答请求后明确重开会话。');
    const inputRevision = this.inputRevisions.get(key) || 0;
    const controller = new AbortController();
    const preparation = { key, channel, sessionId, generation, inputs: pending, controller }; this.preparations.set(sessionId, preparation);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const request = async (action, extra, options = {}) => {
      check(); const result = await this.request(action, channel, extra, { ...options, signal: combined, ...(action === 'turn.begin' ? { owner: preparation } : {}) });
      if (action === 'turn.begin') {
        preparation.context = result.context;
        preparation.allocation ||= [...this.allocations].find(turn => turn.context === result.context);
        if (preparation.allocation) { preparation.allocation.owner = preparation; preparation.allocation.sessionId = sessionId; }
      }
      try { check(); } catch (error) {
        if (action === 'turn.begin') this.reportCleanup(error, await this.releaseRecord(preparation));
        throw error;
      }
      return result;
    };
    const check = () => {
      this.assertScope(generation, key, channel);
      if (combined.aborted || (this.inputRevisions.get(key) || 0) !== inputRevision) throw channelError('REQUEST_CANCELLED', '原提示准备已由新的入站或停止操作取消。');
    };
    const ctx = await request('turn.begin', { query: '' }).catch(error => {
      if (signal?.aborted) this.discardInputs(key, pending);
      if (this.preparations.get(sessionId) === preparation) this.preparations.delete(sessionId);
      throw error;
    });
    const notify = async phase => {
      if (!onNotice || channel.kind !== 'qq-private') return;
      check(); await request('validate', { context: ctx.context }); check();
      // A fixed system notice has its own passive origin. It is never a model
      // candidate, never releases this preparation's Writer lease or consumes input.
      const id = `semantic-notice:${sessionId}`;
      const record = { key, channel, context: ctx.context, sessionId: id, generation, proactive: false,
        writerReleased: true, semanticNotice: { combined, inputRevision } };
      this.sessions.set(id, record);
      try { await this.origin.run(record, () => onNotice(phase)); check(); }
      finally { if (this.sessions.get(id) === record) this.sessions.delete(id); }
    };
    try {
    check();
    const resolved = pending.length
      ? await request('sources', { context: ctx.context, eventIds: pending.map(event => event.id) })
      : { sources: [], memory_epoch: ctx.memory_epoch };
    if (resolved.memory_epoch !== ctx.memory_epoch) throw channelError('STALE_CONTEXT', '来源读取期间记忆已变化，请重新发起本轮。');
    if (resolved.context) ctx.context = resolved.context;
    const byId = new Map(resolved.sources.map(source => [source.source_event_id, source]));
    const events = [];
    for (const event of pending) {
      const source = byId.get(event.id);
      if (source?.status === 'active') {
        events.push({ ...event, text: String(source.text).slice(0, 8000) });
      } else if (source?.status === 'missing' && event.neverPersisted) {
        // Disabled automatic writing creates no durable source. Only an unchanged
        // original context permits this one-turn input; persisted sources never use cached text.
        try { await request('sources.validate', { context: event.context }); events.push(event); }
        catch (error) { if (!['STALE_CONTEXT', 'STALE_CHARACTER', 'BINDING_INVALID'].includes(error.code)) throw error; }
      }
    }
    await request('validate', { context: ctx.context });
    if (this.continuity() && pending.length && !events.length) throw channelError('SOURCE_UNAVAILABLE', '待处理请求已被删除、停用或无法核验，本轮不会转为主动发言。');
    if (events.length) {
      let refined;
      try { refined = await request('context.refine', { context: ctx.context, query: events[events.length - 1].text }, { onProgress: () => notify('loading') }); }
      catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('SEMANTIC_') && !combined.aborted) {
          try { await notify('failed'); } catch { /* Original authority or transport failure cannot authorize another notice. */ }
        }
        throw error;
      }
      check();
      if (refined.memory_epoch !== ctx.memory_epoch) throw channelError('STALE_CONTEXT', '语义检索期间原回合已失效。');
      ctx.text = refined.text;
    }
    const record = { key, channel, context: ctx.context, sessionId, generation, characterEpoch: ctx.character_epoch, inputs: events, prepareCheck: check, prepareController: controller, prepareSignal: combined, allocation: preparation.allocation,
      proactive: events.length === 0, outreachId: `purpose:${Math.floor(Date.now() / 60000)}` };
    for (const [id, old] of [...this.sessions]) if (old.key === key) {
      check(); const cleanup = await this.releaseRecord(old);
      try { check(); } catch (error) { throw this.reportCleanup(error, cleanup); }
      if (cleanup?.ok === false) throw this.reportCleanup(channelError(cleanup.code, cleanup.error, cleanup.hint), cleanup);
      if (this.sessions.get(id) === old) this.sessions.delete(id);
    }
    check();
    for (const [id, old] of this.tokens) if (old.key === key) this.tokens.delete(id);
    if ((this.inputRevisions.get(key) || 0) !== inputRevision) throw channelError('STALE_CONTEXT', '准备提示期间有新入站，旧准备已取消；原请求仍保留。');
    if (record.allocation) record.allocation.owner = record;
    this.sessions.set(sessionId, record); if (token) this.tokens.set(token, record);
    // Ownership moves from the queue to this record. Preparation is not an
    // acknowledgement. Normal rebuild may hand these IDs back for native lookup.
    this.discardInputs(key, pending);
    const delivery = token
      ? `需要发送时使用该会话工具，agentToken=${token}；可自然分条发送并等待新消息。表达完整就及时回答；需要确认补充时用 qq_wait_for_messages(purpose="reply") 补足短静默；确实等下文才用 purpose="messages"。发送后先判断是否自然结束，聊完可用 qq_close_conversation，不需要等五分钟，唤醒配置保持不变。还想聊可继续 wait；只有决定潜水才做沉睡前观察，这时发送后用 qq_set_wake_config 或 qq_mark_read 收尾。新入站会安全结束旧代次，由新代次处理，不要重试旧令牌。`
      : '请直接输出本轮最终回复，由桥接自动转发到当前受众。不要调用 QQ 发送工具，也不要调用 qq_wait_for_messages、qq_set_wake_config 或 qq_mark_read；无需等待或安排后续回合。';
    const receipt = this.handoffReceipts.get(key); this.handoffReceipts.delete(key);
    const prior = receipt ? `\n【上一代次投递状态】已确认发送 ${receipt.confirmed} 条${receipt.unknown ? '，另有无法确认的投递' : ''}；这些旧候选不得重放或补发，只处理本轮入站。` : '';
    return `${persona}\n【工具会话 key】${key}\n【受众类型】${channel.kind}\n【受众标识】${channel.peer}\n【有效记忆】\n${ctx.text || ''}\n【当前入站消息】\n${events.map(e => e.text).join('\n')}${prior}\n只回复当前受众。${delivery}不得读取旧记忆卡、完整归档、跨平台同步或其他会话。`;
    } catch (error) { throw this.reportCleanup(error, await this.releaseRecord(preparation)); }
    finally {
      if (signal?.aborted) this.discardInputs(key, pending);
      if (this.preparations.get(sessionId) === preparation) this.preparations.delete(sessionId);
    }
  }
  assertPrepared(id) {
    const record = this.sessions.get(id);
    if (!record?.prepareCheck) throw channelError('REQUEST_CANCELLED', '原提示准备已失效。');
    this.assertRecord(record);
  }
  cancelSession(id) {
    // Explicit stop cancels only this generation's inputs. A newer ingress may
    // already be queued under the same audience and must survive the old stop.
    const preparation = this.preparations.get(id), record = this.sessions.get(id);
    if (preparation) this.discardInputs(preparation.key, preparation.inputs);
    if (record) {
      this.discardInputs(record.key, record.inputs);
      record.inputs = [];
      record.prepareController?.abort();
    }
    return this.endSession(id, { retry: true });
  }
  retireSession(id, { reason = 'SESSION_RETIRED' } = {}) {
    if (!this.continuity()) return this.cancelSession(id);
    const record = this.sessions.get(id), preparation = this.preparations.get(id);
    let carry = reason === 'TURN_REBUILD' && this.continuity();
    const owner = record || preparation;
    if (owner) {
      const current = this.channels.get(owner.key);
      carry &&= owner.generation === this.generation && this.guarded() && this.mode() === 'local'
        && ['kind', 'account', 'peer', 'principal'].every(field => current?.[field] === owner.channel[field]);
      try { this.assertReady(); }
      catch { carry = false; }
    }
    if (!carry) this.cancelSession(id);
    // A rebuild aborts only the old preparation. Its inputs remain queued and
    // must pass sources/validate again in the successor.
    preparation?.controller.abort();
    if (record) this.revokeRecord(record, { carry, reason });
  }
  async endSession(id, { retry = false } = {}) {
    const preparation = this.preparations.get(id);
    preparation?.controller.abort();
    const record = this.sessions.get(id);
    const work = [];
    if (record || preparation) work.push(this.releaseRecord(record || preparation, { retry }));
    for (const allocation of this.allocations) if (allocation.sessionId === id) work.push(this.cancelAllocation(allocation, { retry }));
    const results = await Promise.all(work);
    return results.find(result => result?.ok === false) || { ok: true };
  }
  async releaseRecord(record, { retry = false } = {}) {
    if (!record || record.intent || record.toolDelivery || record.writerReleased) return { ok: true };
    let allocation = record.allocation;
    if (!allocation && record.context) {
      allocation = { context: record.context, channel: record.channel, owner: record, sessionId: record.sessionId, cleanup: { state: 'active' } };
      record.allocation = allocation;
      this.allocations.add(allocation);
    }
    if (!allocation) return { ok: true };
    record.releasePromise = this.cancelAllocation(allocation, { retry });
    return record.releasePromise;
  }
  enterSession(id) { this.origin.enterWith(this.sessions.get(id) || null); }
  enterToken(token) { this.origin.enterWith(this.tokens.get(token) || null); }
  invalidate() {
    this.generation++;
    for (const preparation of this.preparations.values()) preparation.controller.abort();
    for (const preparation of this.preparations.values()) void this.releaseRecord(preparation);
    this.preparations.clear();
    for (const record of this.sessions.values()) record.revoked = true;
    for (const id of this.sessions.keys()) void this.endSession(id);
    this.sessions.clear(); this.tokens.clear(); this.events.clear(); this.inputRevisions.clear(); this.handoffReceipts.clear();
    this.channels.clear();
    this.ownerActivity = null;
  }
  async dispose() {
    this.disposing = true;
    try {
      this.invalidate();
      const results = await Promise.all([...this.allocations].map(allocation => this.cancelAllocation(allocation, { retry: true })));
      const failed = results.find(result => result.ok === false);
      if (failed) return failed;
      this.disposed = true;
      return { ok: true };
    } finally {
      this.disposing = false;
    }
  }
  async handleTools(key, ingress, deliver) {
    if (!this.guarded() || !ingress) return { handled: false };
    const channel = this.channels.get(key);
    const generation = this.generation;
    const result = await this.request('tool.handle', channel, { context: ingress.context });
    this.assertScope(generation, key, channel);
    if (!result.handled) return result;
    this.events.set(key, (this.events.get(key) || []).filter(event => event.id !== ingress.eventId));
    const reply = result.reply || (result.ok === false ? `${result.code}：${result.error}\n${result.hint}` : '');
    if (reply) {
      const record = { key, channel, context: ingress.context, sessionId: `tool-ack:${ingress.eventId}`, generation, proactive: false };
      this.sessions.set(record.sessionId, record);
      try { await this.origin.run(record, () => deliver(reply, key)); }
      finally { if (this.sessions.get(record.sessionId) === record) this.sessions.delete(record.sessionId); }
    }
    return result;
  }
  async withToolDelivery(deliveryId, { guard, deliver }) {
    const owner = String(this.config().ownerQQ || ''); const key = `private:${owner}`; const channel = this.channels.get(key);
    if (!channel || channel.kind !== 'qq-private' || channel.peer !== owner) throw channelError('BINDING_INVALID', '工具结果缺少当前主人的可信私聊身份。');
    const generation = this.generation;
    let claim, record, outcome = 'failed';
    try {
      claim = await this.request('tool.delivery.claim', channel, { deliveryId });
      this.assertScope(generation, key, channel);
      record = { key, channel, context: claim.context, sessionId: `tool:${deliveryId}`, generation, proactive: false, toolDelivery: true, expiresAt: claim.expiresAt, guard: () => guard(channel) };
      this.sessions.set(record.sessionId, record);
      const result = await this.origin.run(record, () => deliver(claim.text, key)); outcome = 'sent'; return result;
    } catch (error) {
      outcome = error.deliveryOutcome === 'failed' || !record?.transportAttempted ? 'failed' : 'unknown';
      throw Object.assign(error, { deliveryOutcome: outcome });
    } finally {
      if (claim) await this.request('tool.delivery.finish', channel, { context: claim.context, outcome }).catch(() => {});
      if (record && this.sessions.get(record.sessionId) === record) this.sessions.delete(record.sessionId);
    }
  }
  async withIntent(intentId, { guard, syncGuard, deliver }) {
    if (!this.guarded() || this.mode() !== 'local') throw channelError('COMPANION_LOCAL_REQUIRED', '自主陪伴只在 local 后端运行。');
    const owner = String(this.config().ownerQQ || '');
    const key = `private:${owner}`; const channel = this.channels.get(key);
    if (!channel || channel.kind !== 'qq-private' || channel.peer !== owner) throw channelError('BINDING_INVALID', '尚无主人的可信私聊身份，请先由主人发来一条私聊。');
    const generation = this.generation;
    const activity = this.activity(channel);
    this.assertActivity(activity, channel);
    let record, claim;
    try {
      claim = await this.request('intent.claim', channel, { intentId });
      this.assertScope(generation, key, channel);
      this.assertActivity(activity, channel);
      record = { key, channel, context: claim.context, sessionId: `companion:${intentId}`, generation, proactive: true, outreachId: claim.outreachId, intent: true, activity, syncGuard: () => syncGuard?.(channel), expiresAt: claim.expiresAt, guard: () => guard(channel) };
      this.sessions.set(record.sessionId, record);
      return await this.origin.run(record, () => deliver(claim.text, key));
    } catch (error) {
      error.deliveryOutcome = record?.transportAttempted && error.deliveryOutcome !== 'failed' ? 'unknown' : 'failed';
      if (claim) await this.request('intent.finish', channel, { context: claim.context, params: { outcome: error.deliveryOutcome } }).catch(() => {});
      throw error;
    } finally { if (record && this.sessions.get(record.sessionId) === record) this.sessions.delete(record.sessionId); }
  }
  async validateOrigin() {
    const record = this.origin.getStore();
    if (!record || record.revoked || this.sessions.get(record.sessionId) !== record) throw channelError('BINDING_INVALID', '本地模式工具缺少当前可信代次。');
    const result = await this.request('validate', record.channel, { context: record.context });
    this.assertRecord(record);
    return result;
  }
  acknowledgeOrigin({ closedAt } = {}) {
    const record = this.origin.getStore();
    if (record && this.sessions.get(record.sessionId) === record && !record.revoked
      && (record.confirmedSends > 0 || Number.isFinite(closedAt) && closedAt > 0)) record.inputs = [];
  }
  assertRecord(record) {
    this.assertReady();
    if (!this.guarded() || this.mode() !== 'local') throw channelError('STALE_CHARACTER', '旧本地回合不能在变化后的后端发送。');
    if (record.generation !== this.generation || record.revoked || this.sessions.get(record.sessionId) !== record) throw channelError('BINDING_INVALID', '原发送代次已撤销，不能发送旧候选。');
    record.prepareCheck?.();
    if (record.semanticNotice && (record.semanticNotice.combined.aborted || (this.inputRevisions.get(record.key) || 0) !== record.semanticNotice.inputRevision)) throw channelError('REQUEST_CANCELLED', '原语义准备通知已失效。');
    if (record.intent) { this.assertActivity(record.activity, record.channel); record.syncGuard(); }
  }
  async send(key, deliver) {
    this.assertReady();
    if (!this.guarded()) {
      if (this.origin.getStore()) throw channelError('STALE_CHARACTER', '旧本地能力回合不能在切换后的角色或后端发送。');
      return deliver();
    }
    const record = this.origin.getStore();
    if (!record || record.key !== key || this.sessions.get(record.sessionId) !== record) throw channelError('BINDING_INVALID', '发送缺少本轮可信上下文或试图跨会话发送。');
    if ((record.intent || record.toolDelivery) && record.consumed) throw channelError('DELIVERY_UNKNOWN', '本次投递已消费，不能重发。');
    if (record.intent || record.toolDelivery) record.consumed = true;
    const extra = { context: record.context };
    if (record.uncertain) throw channelError('DELIVERY_UNKNOWN', '本轮存在无法确认的发送，禁止补发或备用路径。');
    await this.request('validate', record.channel, extra);
    if (!record.proactive) {
      if (record.toolDelivery) { await record.guard(); await this.request('validate', record.channel, extra); if (Date.now() >= record.expiresAt) throw channelError('TOOL_DELIVERY_INVALID', '工具投递已过期。'); }
      this.assertRecord(record); // last synchronous gate after every awaited check
      record.transportAttempted = true;
      record.inFlight = (record.inFlight || 0) + 1;
      try { const result = await deliver(); record.confirmedSends = (record.confirmedSends || 0) + 1; record.inputs = []; this.noteConfirmedSend(record); return result; }
      catch (error) { record.uncertain = true; throw error; }
      finally { record.inFlight--; }
    }
    const outreach_id = record.outreachId;
    const params = { outreach_id };
    const check = await this.request('attention.check', record.channel, { ...extra, params });
    if (!check.allowed) throw channelError('ATTENTION_BLOCKED', `主动联系已暂停：${check.reason || '预算或安静时段'}`);
    const reserved = await this.request('attention.reserve', record.channel, { ...extra, params });
    if (!reserved.reserved) throw channelError('ATTENTION_BLOCKED', `本轮未获得发送额度：${reserved.reason || '额度已占用'}`);
    let attempted = false;
    try {
      // Account/friend lookup may wait on OneBot. It must finish BEFORE the last
      // context/run-state/policy checks, so changes during that wait can revoke this send.
      await record.guard?.();
      await this.request('validate', record.channel, extra);
      const recheck = await this.request('attention.check', record.channel, { ...extra, params: { ...params, reservation_id: reserved.reservation_id } });
      if (!recheck.allowed) throw channelError('ATTENTION_BLOCKED', `发送前检查拒绝：${recheck.reason || '设置已变化'}`);
      if (record.intent && (!Number.isFinite(record.expiresAt) || Date.now() >= record.expiresAt)) throw channelError('COMPANION_STOPPED', '主动投递凭据已过期，本轮没有发送。');
      this.assertRecord(record);
      attempted = true;
      record.transportAttempted = true;
      const result = await deliver();
      this.noteConfirmedSend(record);
      await this.request('attention.finalize', record.channel, { ...extra, params: { ...params, outcome: 'sent' } });
      return result;
    } catch (error) {
      // Any attempted transport can have delivered despite a timeout. Never replay/fallback.
      const outcome = attempted && error.deliveryOutcome !== 'failed' ? 'unknown' : 'failed';
      if (outcome === 'unknown') record.uncertain = true;
      await this.request('attention.finalize', record.channel, { ...extra, params: { ...params, outcome } }).catch(() => {});
      throw error;
    }
  }
  async sendFetch(key, url, options) {
    if (!this.guarded()) return this.send(key, () => this.fetchImpl(url, options));
    return this.send(key, async () => {
      const res = await this.fetchImpl(url, options);
      const body = await res.clone().json().catch(() => null);
      if (body?.status === 'failed' && Number.isInteger(body.retcode) && body.retcode !== 0) throw Object.assign(channelError('DELIVERY_REJECTED', 'QQ 平台明确拒绝了本次发送。'), { deliveryOutcome: 'failed' });
      if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) throw channelError('DELIVERY_UNKNOWN', 'QQ 发送未获得成功回执，已保守计账，不会补发。');
      return res;
    });
  }
}
