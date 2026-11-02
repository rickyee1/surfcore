import fs from 'node:fs';
import { readCurrentCharacter } from './character-persona.js';
import { captureTargetGate, assertTargetGate } from './role-package-gate.js';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LOCAL_ROOT, localBackendGuarded, localBackendMode } from './local-capabilities-state.js';

export function channelError(code, error, hint = '请在 SurfCore 设置 → 本地能力检查服务和渠道绑定，然后重新发起本轮。') {
  return Object.assign(new Error(error), { ok: false, code, error, hint });
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
    this.generation = 0;
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
  revokeRecord(record, { carry = false, reason = 'TURN_SUPERSEDED', triggerKey } = {}) {
    if (this.sessions.get(record.sessionId) !== record) return;
    // Synchronous revocation precedes all I/O, including auto_write=false where
    // the DB epoch does not change. Captured async origins cannot be refreshed.
    record.revoked = true;
    this.sessions.delete(record.sessionId);
    for (const [token, value] of this.tokens) if (value === record) this.tokens.delete(token);
    const unanswered = carry && !record.transportAttempted && !record.intent && !record.toolDelivery && record.inputs?.length;
    if (unanswered) this.retainInputs(record.key, record.inputs);
    if (record.transportAttempted) this.handoffReceipts.set(record.key, {
      confirmed: record.confirmedSends || 0, unknown: !!record.uncertain || !!record.inFlight,
    });
    void this.releaseRecord(record);
    this.onSupersede({ key: record.key, sessionId: record.sessionId, retry: !!unanswered, reason, triggerKey });
  }
  async request(action, channel, extra = {}) {
    this.assertReady();
    if (this.mode() !== 'local') throw channelError('SERVICE_UNAVAILABLE', '本地能力已暂停，渠道不会回退旧记忆。');
    let key;
    try { key = fs.readFileSync(this.keyFile, 'utf8').trim(); } catch { throw channelError('SERVICE_UNAVAILABLE', '插件宿主尚未建立可信渠道。'); }
    const cfg = this.config(); const base = new URL(cfg.dsh.baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw channelError('PERMISSION_DENIED', '本地能力渠道只接受本机插件宿主。');
    let body;
    try {
      const res = await this.fetchImpl(new URL('/dsh-surfcore/api/local-capabilities/channel', base), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-surfcore-channel-key': key,
          ...await this.authHeaders() },
        body: JSON.stringify({ action, channel, ...extra }), signal: AbortSignal.timeout(action === 'tool.handle' ? 60000 : 15000),
      });
      body = await res.json();
    } catch { throw channelError('SERVICE_UNAVAILABLE', '可信渠道请求失败，本轮已停止。'); }
    if (!body.ok) throw channelError(body.code || 'SERVICE_UNAVAILABLE', body.error || '本地能力拒绝请求。', body.hint);
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
    const ctx = await this.request('turn.begin', channel, { query: '', eventId, text: String(text).slice(0, 16000) });
    try {
    this.assertScope(generation, key, channel);
    const ingested = await this.request('ingest', channel, { context: ctx.context, eventId, text: String(text).slice(0, 16000) });
    this.assertScope(generation, key, channel);
    if (ingested.duplicate) {
      this.seen.add(eventId);
      if (this.channels.get(key) === channel) {
        if (previous) this.channels.set(key, previous); else this.channels.delete(key);
      }
      return { duplicate: true };
    }
    this.inputRevisions.set(key, (this.inputRevisions.get(key) || 0) + 1);
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
    this.seen.add(eventId);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
    // Only fresh source events are retained until the next generation; no private purpose/history copies.
    if (!this.continuity()) this.events.set(key, (this.events.get(key) || []).slice(-20));
    return { context: ctx.context, eventId };
    } finally { await this.request('turn.end', channel, { context: ctx.context }).catch(() => {}); }
  }
  async prepare(key, sessionId, token, persona = '') {
    this.assertReady();
    const generation = this.generation;
    const channel = this.channels.get(key);
    if (!channel) throw channelError('BINDING_INVALID', '该会话尚无可信 QQ 入站身份，请先发一条新消息。');
    if (this.sessions.has(sessionId)) throw channelError('STALE_CONTEXT', '本地模式拒绝向已有模型历史追加提示，请重新唤醒。');
    const pending = [...(this.events.get(key) || [])];
    if (pending.length > 20) throw channelError('INBOUND_QUEUE_FULL', '待处理请求超过本轮来源上限，未丢弃或截断。', '暂停生成，核对未答请求后明确重开会话。');
    const inputRevision = this.inputRevisions.get(key) || 0;
    const ctx = await this.request('turn.begin', channel, { query: '' });
    try {
    this.assertScope(generation, key, channel);
    const resolved = pending.length
      ? await this.request('sources', channel, { context: ctx.context, eventIds: pending.map(event => event.id) })
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
        try { await this.request('sources.validate', channel, { context: event.context }); events.push(event); }
        catch (error) { if (!['STALE_CONTEXT', 'STALE_CHARACTER', 'BINDING_INVALID'].includes(error.code)) throw error; }
      }
    }
    await this.request('validate', channel, { context: ctx.context });
    if (this.continuity() && pending.length && !events.length) throw channelError('SOURCE_UNAVAILABLE', '待处理请求已被删除、停用或无法核验，本轮不会转为主动发言。');
    if (events.length) {
      const refined = await this.request('context.refine', channel, { context: ctx.context, query: events[events.length - 1].text });
      if (refined.memory_epoch !== ctx.memory_epoch) throw channelError('STALE_CONTEXT', '语义检索期间原回合已失效。');
      ctx.text = refined.text;
    }
    const record = { key, channel, context: ctx.context, sessionId, generation, characterEpoch: ctx.character_epoch, inputs: events,
      proactive: events.length === 0, outreachId: `purpose:${Math.floor(Date.now() / 60000)}` };
    for (const [id, old] of [...this.sessions]) if (old.key === key) {
      await this.releaseRecord(old);
      this.assertScope(generation, key, channel);
      if (this.sessions.get(id) === old) this.sessions.delete(id);
    }
    this.assertScope(generation, key, channel);
    for (const [id, old] of this.tokens) if (old.key === key) this.tokens.delete(id);
    if ((this.inputRevisions.get(key) || 0) !== inputRevision) throw channelError('STALE_CONTEXT', '准备提示期间有新入站，旧准备已取消；原请求仍保留。');
    this.sessions.set(sessionId, record); if (token) this.tokens.set(token, record);
    this.events.delete(key);
    const delivery = token
      ? `需要发送时使用该会话工具，agentToken=${token}；可自然分条发送并等待新消息。表达完整就及时回答；需要确认补充时用 qq_wait_for_messages(purpose="reply") 补足短静默；确实等下文才用 purpose="messages"。发送后先判断是否自然结束，聊完可用 qq_close_conversation，不需要等五分钟，唤醒配置保持不变。还想聊可继续 wait；只有决定潜水才做沉睡前观察，这时发送后用 qq_set_wake_config 或 qq_mark_read 收尾。新入站会安全结束旧代次，由新代次处理，不要重试旧令牌。`
      : '请直接输出本轮最终回复，由桥接自动转发到当前受众。不要调用 QQ 发送工具，也不要调用 qq_wait_for_messages、qq_set_wake_config 或 qq_mark_read；无需等待或安排后续回合。';
    const receipt = this.handoffReceipts.get(key); this.handoffReceipts.delete(key);
    const prior = receipt ? `\n【上一代次投递状态】已确认发送 ${receipt.confirmed} 条${receipt.unknown ? '，另有无法确认的投递' : ''}；这些旧候选不得重放或补发，只处理本轮入站。` : '';
    return `${persona}\n【本轮受众】${channel.kind}:${channel.peer}\n【有效记忆】\n${ctx.text || ''}\n【当前入站消息】\n${events.map(e => e.text).join('\n')}${prior}\n只回复当前受众。${delivery}不得读取旧记忆卡、完整归档、跨平台同步或其他会话。`;
    } catch (error) { await this.request('turn.end', channel, { context: ctx.context }).catch(() => {}); throw error; }
  }
  async endSession(id) {
    const record = this.sessions.get(id);
    return this.releaseRecord(record);
  }
  async releaseRecord(record) {
    if (!record || record.intent || record.writerReleased) return;
    record.writerReleased = true;
    await this.request('turn.end', record.channel, { context: record.context }).catch(() => {});
  }
  enterSession(id) { this.origin.enterWith(this.sessions.get(id) || null); }
  enterToken(token) { this.origin.enterWith(this.tokens.get(token) || null); }
  invalidate() {
    this.generation++;
    for (const record of this.sessions.values()) record.revoked = true;
    for (const id of this.sessions.keys()) void this.endSession(id);
    this.sessions.clear(); this.tokens.clear(); this.events.clear(); this.inputRevisions.clear(); this.handoffReceipts.clear();
    this.channels.clear();
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
  async withIntent(intentId, { guard, deliver }) {
    if (!this.guarded() || this.mode() !== 'local') throw channelError('COMPANION_LOCAL_REQUIRED', '自主陪伴只在 local 后端运行。');
    const owner = String(this.config().ownerQQ || '');
    const key = `private:${owner}`; const channel = this.channels.get(key);
    if (!channel || channel.kind !== 'qq-private' || channel.peer !== owner) throw channelError('BINDING_INVALID', '尚无主人的可信私聊身份，请先由主人发来一条私聊。');
    const generation = this.generation;
    let record, claim;
    try {
      claim = await this.request('intent.claim', channel, { intentId });
      this.assertScope(generation, key, channel);
      record = { key, channel, context: claim.context, sessionId: `companion:${intentId}`, generation, proactive: true, outreachId: claim.outreachId, intent: true, expiresAt: claim.expiresAt, guard: () => guard(channel) };
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
  acknowledgeOrigin() {
    const record = this.origin.getStore();
    if (record && this.sessions.get(record.sessionId) === record && !record.revoked) record.inputs = [];
  }
  assertRecord(record) {
    this.assertReady();
    if (!this.guarded() || this.mode() !== 'local') throw channelError('STALE_CHARACTER', '旧本地回合不能在变化后的后端发送。');
    if (record.generation !== this.generation || record.revoked || this.sessions.get(record.sessionId) !== record) throw channelError('BINDING_INVALID', '原发送代次已撤销，不能发送旧候选。');
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
      try { const result = await deliver(); record.confirmedSends = (record.confirmedSends || 0) + 1; return result; }
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
