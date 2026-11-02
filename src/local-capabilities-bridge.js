import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LOCAL_ROOT, localBackendGuarded, localBackendMode } from './local-capabilities-state.js';

export function channelError(code, error, hint = '请在 SurfCore 设置 → 本地能力检查服务和渠道绑定，然后重新发起本轮。') {
  return Object.assign(new Error(error), { ok: false, code, error, hint });
}

/** Bridge holds no Python process or binding authority. All identity comes from OneBot ingress. */
export class LocalChannelBridge {
  constructor({ config, fetchImpl = fetch, guarded = localBackendGuarded, mode = localBackendMode, keyFile = path.join(LOCAL_ROOT, 'channel.key'), authHeaders = async () => ({}) }) {
    Object.assign(this, { config, fetchImpl, guarded, mode, keyFile, authHeaders });
    this.channels = new Map(); this.sessions = new Map(); this.tokens = new Map();
    this.events = new Map(); this.seen = new Set(); this.origin = new AsyncLocalStorage();
  }
  async request(action, channel, extra = {}) {
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
        body: JSON.stringify({ action, channel, ...extra }), signal: AbortSignal.timeout(15000),
      });
      body = await res.json();
    } catch { throw channelError('SERVICE_UNAVAILABLE', '可信渠道请求失败，本轮已停止。'); }
    if (!body.ok) throw channelError(body.code || 'SERVICE_UNAVAILABLE', body.error || '本地能力拒绝请求。', body.hint);
    return body.result;
  }
  async incoming(key, event, text) {
    if (!this.guarded()) return;
    const [kind, peer] = key.split(':');
    const account = String(event.self_id ?? ''); const principal = String(event.user_id ?? '');
    const id = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    if (!account || !principal || !id) throw channelError('BINDING_INVALID', '可信 QQ 事件缺少账号、发送者或消息标识。');
    const channel = { kind: kind === 'private' ? 'qq-private' : 'qq-group', account, peer, principal };
    const previous = this.channels.get(key);
    if (previous && previous.account !== account) { this.events.delete(key); for (const [sid, s] of this.sessions) if (s.key === key) this.sessions.delete(sid); }
    this.channels.set(key, channel);
    const eventId = `${account}:${kind}:${peer}:${id}`;
    if (this.seen.has(eventId)) return;
    const ctx = await this.request('context', channel, { query: '' });
    const ingested = await this.request('ingest', channel, { context: ctx.context, eventId, text: String(text).slice(0, 16000) });
    if (ingested.duplicate) { this.seen.add(eventId); return; }
    if (kind === 'private') {
      await this.request('attention.respond', channel, { context: ctx.context, params: {} }).catch(error => { if (error.code !== 'PERMISSION_DENIED') throw error; });
    }
    this.seen.add(eventId);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
    // Only fresh source events are retained until the next generation; no private purpose/history copies.
    const events = this.events.get(key) || [];
    events.push({ id: eventId, context: ctx.context, neverPersisted: ingested.stored === false && ingested.skipped === true, text: String(text).slice(0, 8000) });
    this.events.set(key, events.slice(-20));
  }
  async prepare(key, sessionId, token, persona = '') {
    const channel = this.channels.get(key);
    if (!channel) throw channelError('BINDING_INVALID', '该会话尚无可信 QQ 入站身份，请先发一条新消息。');
    if (this.sessions.has(sessionId)) throw channelError('STALE_CONTEXT', '本地模式拒绝向已有模型历史追加提示，请重新唤醒。');
    const pending = this.events.get(key) || [];
    const ctx = await this.request('context', channel, { query: '' });
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
        events.push({ id: event.id, text: String(source.text).slice(0, 8000) });
      } else if (source?.status === 'missing' && event.neverPersisted) {
        // Disabled automatic writing creates no durable source. Only an unchanged
        // original context permits this one-turn input; persisted sources never use cached text.
        try { await this.request('validate', channel, { context: event.context }); events.push(event); }
        catch (error) { if (!['STALE_CONTEXT', 'STALE_CHARACTER', 'BINDING_INVALID'].includes(error.code)) throw error; }
      }
    }
    await this.request('validate', channel, { context: ctx.context });
    const record = { key, channel, context: ctx.context, sessionId, proactive: events.length === 0, outreachId: `purpose:${Math.floor(Date.now() / 60000)}` };
    for (const [id, old] of this.sessions) if (old.key === key) this.sessions.delete(id);
    for (const [id, old] of this.tokens) if (old.key === key) this.tokens.delete(id);
    this.sessions.set(sessionId, record); if (token) this.tokens.set(token, record);
    this.events.delete(key);
    const delivery = token
      ? `需要发送时使用该会话工具，agentToken=${token}；可自然分条发送并等待新消息。发送后用 qq_set_wake_config 或 qq_mark_read 收尾。`
      : '请直接输出本轮最终回复，由桥接自动转发到当前受众。不要调用 QQ 发送工具，也不要调用 qq_wait_for_messages、qq_set_wake_config 或 qq_mark_read；无需等待或安排后续回合。';
    return `${persona}\n【本轮受众】${channel.kind}:${channel.peer}\n【有效记忆】\n${ctx.text || ''}\n【当前入站消息】\n${events.map(e => e.text).join('\n')}\n只回复当前受众。${delivery}不得读取旧记忆卡、完整归档、跨平台同步或其他会话。`;
  }
  enterSession(id) { this.origin.enterWith(this.sessions.get(id) || null); }
  enterToken(token) { this.origin.enterWith(this.tokens.get(token) || null); }
  async withIntent(intentId, { guard, deliver }) {
    if (!this.guarded() || this.mode() !== 'local') throw channelError('COMPANION_LOCAL_REQUIRED', '自主陪伴只在 local 后端运行。');
    const owner = String(this.config().ownerQQ || '');
    const key = `private:${owner}`; const channel = this.channels.get(key);
    if (!channel || channel.kind !== 'qq-private' || channel.peer !== owner) throw channelError('BINDING_INVALID', '尚无主人的可信私聊身份，请先由主人发来一条私聊。');
    let record;
    try {
      const claim = await this.request('intent.claim', channel, { intentId });
      record = { key, channel, context: claim.context, sessionId: `companion:${intentId}`, proactive: true, outreachId: claim.outreachId, intent: true, expiresAt: claim.expiresAt, guard: () => guard(channel) };
      this.sessions.set(record.sessionId, record);
      return await this.origin.run(record, () => deliver(claim.text, key));
    } catch (error) {
      error.deliveryOutcome = record?.transportAttempted && error.deliveryOutcome !== 'failed' ? 'unknown' : 'failed';
      if (record) await this.request('intent.finish', channel, { context: record.context, params: { outcome: error.deliveryOutcome } }).catch(() => {});
      throw error;
    } finally { if (record) this.sessions.delete(record.sessionId); }
  }
  async validateOrigin() {
    const record = this.origin.getStore();
    if (!record) throw channelError('BINDING_INVALID', '本地模式工具缺少可信代次。');
    return this.request('validate', record.channel, { context: record.context });
  }
  async send(key, deliver) {
    if (!this.guarded()) {
      if (this.origin.getStore()) throw channelError('STALE_CHARACTER', '旧本地能力回合不能在切换后的角色或后端发送。');
      return deliver();
    }
    const record = this.origin.getStore();
    if (!record || record.key !== key || this.sessions.get(record.sessionId) !== record) throw channelError('BINDING_INVALID', '发送缺少本轮可信上下文或试图跨会话发送。');
    if (record.intent && record.consumed) throw channelError('COMPANION_INTENT_INVALID', '本次主动投递已消费，不能重发。');
    if (record.intent) record.consumed = true;
    const extra = { context: record.context };
    if (record.uncertain) throw channelError('DELIVERY_UNKNOWN', '本轮存在无法确认的发送，禁止补发或备用路径。');
    await this.request('validate', record.channel, extra);
    if (!record.proactive) {
      try { return await deliver(); } catch (error) { record.uncertain = true; throw error; }
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
