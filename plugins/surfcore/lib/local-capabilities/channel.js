import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CapabilityError, errorResult } from './supervisor.js';

export function createChannelHandler({ capabilities, keyFile, getPersona }) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // Only the plugin owns this credential; neither the browser nor model sees it.
  let key;
  try { key = fs.readFileSync(keyFile, 'utf8').trim(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' }); }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new CapabilityError('KEY_UNAVAILABLE', '渠道身份密钥格式无效。');
  const contexts = new Map();
  const intents = new Map();
  const toolDeliveries = new Map();
  const turnRequests = new Map();
  const activeRequests = new Set();
  let disposed = false;
  const canonical = channel => ({ kind: channel.kind, account: String(channel.account || ''), peer: String(channel.peer || ''), principal: channel.kind === 'qq-private' ? String(channel.peer) : String(channel.principal || channel.peer || 'public') });
  function releaseTurn(turn) {
    if (!turn?.lease) return;
    const lease = turn.lease;
    turn.lease = null;
    capabilities.endTurn?.(lease);
  }
  function cancelTurn(turn) {
    if (!turn) return;
    turn.cancelled = true;
    releaseTurn(turn);
  }
  function requestTurn(data, trusted, cancelling) {
    if (!/^[a-f0-9-]{36}$/.test(data.bridgeInstance || '') || !/^[a-f0-9-]{36}$/.test(data.requestId || '') || !Number.isSafeInteger(data.requestIssuedAt)) {
      throw new CapabilityError('INVALID_REQUEST', '回合请求标识无效。');
    }
    const now = Date.now();
    // Never evict in-flight or live leases. A cancelled in-flight object remains
    // cancelled even after its registration window closes.
    for (const [id, turn] of turnRequests) if (!turn.pending && !turn.lease && turn.expires < now) turnRequests.delete(id);
    const id = JSON.stringify([trusted, data.bridgeInstance, data.requestId]);
    const previous = turnRequests.get(id);
    if (previous) {
      if (cancelling) return previous;
      throw new CapabilityError(previous.cancelled ? 'REQUEST_CANCELLED' : 'BINDING_INVALID', '原回合请求已使用或取消，不能重放。');
    }
    // Cancellation tombstones outlive every admissible begin. Late begin is
    // rejected by its original timestamp even after the tombstone is collected.
    if (data.requestIssuedAt > now + 5000 || now - data.requestIssuedAt > 15000) {
      if (cancelling) return null;
      throw new CapabilityError('REQUEST_CANCELLED', '回合登记期限已结束。');
    }
    if (turnRequests.size >= 1000) throw new CapabilityError('CHANNEL_BUSY', '渠道回合登记已满。', '结束已有回合后重新发起请求。');
    const turn = { lease: null, pending: !cancelling, cancelled: cancelling, expires: data.requestIssuedAt + 60000 };
    turnRequests.set(id, turn);
    return turn;
  }
  function checkIntentExpiry(intent) {
    if (Date.now() >= intent.expires) throw new CapabilityError('COMPANION_STOPPED', '主动轮次已过期。', '重新预览并发起新的轮次。');
  }
  async function validateIntent(intent) {
    checkIntentExpiry(intent);
    if (!await intent.active()) throw new CapabilityError('COMPANION_STOPPED', '主动轮次已停用或过期。', '重新预览并发起新的轮次。');
    const owner = capabilities.state.qqOwner;
    if (!owner || owner.account !== intent.channel.account || owner.peer !== intent.channel.peer) throw new CapabilityError('BINDING_INVALID', '主人绑定已变化，旧轮次已取消。');
    for (const context of intent.contexts) { await capabilities.validate(context); intent.syncGuard(); }
    if (intent.validateSources) await intent.validateSources();
    intent.syncGuard();
    checkIntentExpiry(intent);
  }
  const handler = async (req, res) => {
    const requestStartedAt = Date.now(); const operation = new AbortController();
    let pendingTurn, pendingHandle;
    const abandon = () => {
      cancelTurn(pendingTurn);
      if (pendingHandle) contexts.delete(pendingHandle);
    };
    const abort = () => { operation.abort(); abandon(); };
    const close = () => { if (!res.writableFinished) abort(); };
    const detach = () => { req.off('aborted', abort); res.off('close', close); res.off('finish', detach); };
    req.on('aborted', abort); res.on('close', close);
    res.once('finish', detach);
    let streaming = false;
    const send = (status, data) => {
      if (res.destroyed || operation.signal.aborted) return;
      if (!streaming) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data) + (streaming ? '\n' : ''));
    };
    const stop = () => {
      send(503, errorResult(new CapabilityError('REQUEST_CANCELLED', '渠道宿主已停止，原回合已取消。')));
      abort();
    };
    activeRequests.add(stop);
    try {
      const supplied = Buffer.from(String(req.headers['x-surfcore-channel-key'] || ''));
      const expected = Buffer.from(key);
      if (req.method !== 'POST' || req.headers.origin || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new CapabilityError('PERMISSION_DENIED', '渠道调用身份无效。');
      if (disposed) throw new CapabilityError('SERVICE_UNAVAILABLE', '渠道宿主已停止。');
      let raw = ''; for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 128 * 1024) throw new CapabilityError('INVALID_REQUEST', '渠道请求过大。'); }
      let data; try { data = JSON.parse(raw); } catch { throw new CapabilityError('INVALID_REQUEST', '渠道请求 JSON 无效。'); }
      const channel = data.channel;
      if (!channel || !['qq-private','qq-group','bili'].includes(channel.kind) || (channel.kind !== 'bili' && (!/^\d{1,20}$/.test(String(channel.account)) || !/^\d{1,20}$/.test(String(channel.peer))))) throw new CapabilityError('BINDING_INVALID', '渠道身份未验证。');
      // principal comes from authenticated private peer; groups never become owner.
      const trusted = canonical(channel);
      let result, checkedIntent, checkedTool;
      if (data.action === 'turn.cancel') {
        cancelTurn(requestTurn(data, trusted, true));
        result = { released: true };
      } else if (data.action === 'tool.delivery.claim') {
        const delivery = toolDeliveries.get(data.deliveryId);
        if (!delivery || delivery.state !== 'issued' || delivery.channel !== JSON.stringify(trusted) || Date.now() >= delivery.expires) throw new CapabilityError('TOOL_DELIVERY_INVALID', '工具投递凭据无效、已使用或已过期。');
        delivery.state = 'claimed';
        await delivery.envelope.guard();
        if (Date.now() >= delivery.expires) throw new CapabilityError('TOOL_DELIVERY_INVALID', '工具投递凭据已过期。');
        const handle = crypto.randomBytes(24).toString('hex');
        if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
        contexts.set(handle, { context: delivery.envelope.context, channel: delivery.channel, expires: delivery.expires, toolDelivery: delivery });
        result = { context: handle, text: delivery.text, expiresAt: delivery.expires };
        delivery.text = ''; checkedTool = delivery;
      } else if (data.action === 'intent.claim') {
        const intent = intents.get(data.intentId);
        if (!intent || intent.status !== 'issued' || JSON.stringify(intent.channel) !== JSON.stringify(trusted)) throw new CapabilityError('COMPANION_INTENT_INVALID', '主动投递凭据无效或已使用。', '本轮不会重放；请检查主动陪伴状态。');
        // Synchronous consume before awaiting: even concurrent bridge requests get one claim.
        intent.status = 'claimed';
        await validateIntent(intent);
        checkedIntent = intent;
        const handle = crypto.randomBytes(24).toString('hex');
        if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
        contexts.set(handle, { context: intent.ownerContext, channel: JSON.stringify(trusted), expires: intent.expires, intent });
        result = { context: handle, text: intent.text, outreachId: intent.outreachId, expiresAt: intent.expires };
      } else if (data.action === 'context' || data.action === 'turn.begin') {
        const writerTurn = data.action === 'turn.begin'
          ? data.requestId === undefined ? { lease: null } : requestTurn(data, trusted, false)
          : null;
        pendingTurn = writerTurn;
        let toolInput;
        if (data.action === 'turn.begin' && typeof data.eventId === 'string' && data.eventId.length <= 500)
          handler.onInput?.({ channel: trusted, eventId: data.eventId, replyTo: typeof data.replyTo === 'string' ? data.replyTo : null,
            conversationEpoch: data.conversationEpoch, sequence: data.sequence });
        if (data.action === 'turn.begin' && data.eventId !== undefined && capabilities.toolHost) {
          await capabilities.binding(trusted);
          toolInput = capabilities.toolHost.input(trusted, { eventId: data.eventId, text: data.text });
        }
        if (operation.signal.aborted || disposed || writerTurn?.cancelled) throw new CapabilityError('REQUEST_CANCELLED', '原渠道请求已经取消。');
        if (writerTurn) writerTurn.lease = await capabilities.beginTurn?.(trusted);
        if (operation.signal.aborted || disposed || writerTurn?.cancelled) throw new CapabilityError('REQUEST_CANCELLED', '原渠道请求已经取消。');
        const context = await capabilities.context(trusted, String(data.query || '').slice(0, 2000));
        if (operation.signal.aborted || disposed || writerTurn?.cancelled) throw new CapabilityError('REQUEST_CANCELLED', '原渠道请求已经取消。');
        const handle = crypto.randomBytes(24).toString('hex');
        pendingHandle = handle;
        if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
        contexts.set(handle, { context, channel: JSON.stringify(trusted), expires: Date.now() + 30 * 60000, writerTurn, toolInput, persona: typeof data.persona === 'string' ? data.persona : null, personaMode: data.personaMode });
        result = { context: handle, text: context.text, memory_epoch: context.memory_epoch, character_epoch: context.binding.character_epoch };
      } else {
        const stored = contexts.get(data.context);
        if (!stored || stored.channel !== JSON.stringify(trusted) || (stored.expires < Date.now() && !['attention.finalize', 'intent.finish', 'tool.delivery.finish', 'turn.end'].includes(data.action))) throw new CapabilityError('BINDING_INVALID', '渠道上下文已失效。', '重新建立本会话上下文。');
        if (stored.writerTurn?.cancelled && data.action !== 'turn.end') throw new CapabilityError('REQUEST_CANCELLED', '原回合已取消。');
        if (stored.toolDelivery && !['validate', 'tool.delivery.finish'].includes(data.action)) throw new CapabilityError('PERMISSION_DENIED', '工具投递只能验证和结算原内容。');
        // Finalization releases no content; retain the original binding even after stop/correction.
        // Python still verifies reservation ownership and character epoch.
        if (!['attention.finalize', 'intent.finish', 'tool.delivery.finish', 'turn.end', 'sources.validate'].includes(data.action)) {
          if (stored.intent) { await validateIntent(stored.intent); checkedIntent = stored.intent; }
          if (stored.toolDelivery) { await stored.toolDelivery.envelope.guard(); checkedTool = stored.toolDelivery; }
          await capabilities.validate(stored.context);
        }
        if (stored.intent && (!['validate', 'attention.check', 'attention.reserve', 'attention.finalize', 'intent.finish'].includes(data.action) || (data.action.startsWith('attention.') && data.params?.outreach_id !== stored.intent.outreachId))) throw new CapabilityError('PERMISSION_DENIED', '主动凭据仅可核查及结算原有投递，不能更改材料或事件。');
        if (data.action === 'tool.delivery.finish') {
          if (!stored.toolDelivery || !['sent', 'failed', 'unknown'].includes(data.outcome)) throw new CapabilityError('PERMISSION_DENIED', '工具投递收据无效。');
          if (stored.toolDelivery.state === 'claimed') stored.toolDelivery.state = data.outcome;
          stored.toolDelivery.envelope.text = '';
          result = { outcome: stored.toolDelivery.state };
        } else if (data.action === 'tool.handle') {
          if (!stored.toolInput || !capabilities.toolHost || typeof handler.deliverTool !== 'function') throw new CapabilityError('TOOL_HOST_UNAVAILABLE', '原生工具宿主尚未接好。');
          result = await capabilities.toolHost.handle(stored.toolInput, { deliver: envelope => handler.deliverTool(envelope) });
        } else if (data.action === 'sources.validate') {
          if (stored.intent || !stored.neverPersisted) throw new CapabilityError('PERMISSION_DENIED', '只可核验已登记且明确未持久化的入站来源。');
          await capabilities.validateSourceContext(stored.context);
          result = { valid: true };
        } else if (data.action === 'turn.output') {
          if (trusted.kind !== 'qq-private' || !stored.writerTurn?.lease || (!stored.inputSources?.length && !stored.unstoredInput) ||
              typeof getPersona !== 'function' || stored.persona === null)
            throw new CapabilityError('PERMISSION_DENIED', '普通输出缺少原回合、来源或人格凭据。', '核对本轮记忆结果；已送消息不会重发。');
          if (!stored.writerTurn.outputCommit) {
            const guard = () => {
              if (operation.signal.aborted || disposed || stored.writerTurn.cancelled || !stored.writerTurn.lease)
                throw new CapabilityError('REQUEST_CANCELLED', '普通输出的原回合已取消。');
              if (getPersona(trusted, stored.personaMode) !== stored.persona)
                throw new CapabilityError('STALE_PERSONA', '普通输出的原人格层已变化。');
            };
            const sources = [...new Map([...stored.inputSources, ...(stored.context.records || [])].map(source => [source.id, { id: source.id, revision: source.revision }])).values()];
            stored.writerTurn.outputCommit = stored.unstoredInput ? Promise.resolve({ skipped: true, stored: false }) : capabilities.ingestConfirmedOutput(stored.context, `qq-output:${data.eventId}`, data.text, { sources, guard });
          }
          result = await stored.writerTurn.outputCommit;
        } else if (data.action === 'turn.end') {
          releaseTurn(stored.writerTurn);
          result = { released: true };
        } else if (data.action === 'intent.finish') {
          if (!stored.intent || !['failed', 'unknown'].includes(data.params?.outcome)) throw new CapabilityError('PERMISSION_DENIED', '主动结果结算无效。');
          if (stored.intent.status === 'claimed') stored.intent.status = data.params.outcome;
          result = { status: stored.intent.status };
        } else if (data.action === 'sources') {
          const ids = data.eventIds;
          if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !id || id.length > 500) || new Set(ids).size !== ids.length) throw new CapabilityError('INVALID_REQUEST', '来源事件列表无效。', '提供最多 20 个不重复的来源事件编号。');
          const projection = await capabilities.supervisor.raw('context.sources', stored.context.binding, { source_event_ids: ids });
          // Never bless an earlier memory projection with a later epoch after a correction/delete race.
          if (projection.memory_epoch !== stored.context.memory_epoch) throw new CapabilityError('STALE_CONTEXT', '来源查询期间记忆已变更。', '重新读取本轮上下文。');
          const handle = crypto.randomBytes(24).toString('hex');
          if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
          contexts.set(handle, { ...stored, context: { ...stored.context, memory_epoch: projection.memory_epoch }, expires: Date.now() + 30 * 60000,
            inputSources: projection.sources.filter(source => source.status === 'active'), unstoredInput: projection.sources.some(source => source.status !== 'active') });
          result = { ...projection, context: handle };
        }
        else if (data.action === 'context.refine') {
          const progress = data.stream === true ? value => {
            if (operation.signal.aborted) return;
            if (!streaming) { res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }); streaming = true; }
            res.write(JSON.stringify({ progress: value }) + '\n');
          } : undefined;
          const refined = await capabilities.refineContext(stored.context, String(data.query || ''), {
            signal: operation.signal,
            requestStartedAt: Number.isFinite(data.requestStartedAt) ? Math.min(data.requestStartedAt, requestStartedAt) : requestStartedAt,
            readyDeadlineAt: Number.isFinite(data.readyDeadlineAt) ? Math.min(data.readyDeadlineAt, requestStartedAt + 8000) : requestStartedAt + 8000,
            deadlineAt: Number.isFinite(data.deadlineAt) ? Math.min(data.deadlineAt, requestStartedAt + 120000) : requestStartedAt + 120000,
            onProgress: progress,
          });
          if (operation.signal.aborted) throw new CapabilityError('REQUEST_CANCELLED', '原语义检索请求已经断开。');
          if (refined.memory_epoch !== stored.context.memory_epoch) throw new CapabilityError('STALE_CONTEXT', '语义检索不能更新原回合代次。');
          stored.context = refined;
          result = { context: data.context, text: refined.text, memory_epoch: refined.memory_epoch, retrieval: refined.retrieval };
        }
        else if (data.action === 'validate') result = { valid: true };
        else if (data.action === 'ingest') {
          result = await capabilities.ingest(stored.context, String(data.eventId || ''), String(data.text || ''), { actor: trusted.kind.startsWith('qq-') ? 'user' : 'external', original: true });
          stored.context.memory_epoch = result.memory_epoch;
          stored.neverPersisted = result.stored === false && result.skipped === true;
        } else if (['attention.check','attention.reserve','attention.finalize','attention.respond'].includes(data.action)) {
          if (stored.intent && !['attention.check', 'attention.reserve', 'attention.finalize'].includes(data.action)) throw new CapabilityError('PERMISSION_DENIED', '主动凭据不能代替主人回复。');
          result = await capabilities.supervisor.raw(data.action, stored.context.binding, { ...(data.params || {}), memory_epoch: stored.context.memory_epoch });
          if (stored.intent && data.action === 'attention.finalize') stored.intent.status = result.status;
        } else throw new CapabilityError('PERMISSION_DENIED', '渠道操作未开放。');
      }
      // IPC/ledger work can outlive the validity check; expiry also gates the response.
      // Finalization intentionally has no checkedIntent and remains available after expiry.
      if (checkedIntent) { checkIntentExpiry(checkedIntent); checkedIntent.syncGuard(); }
      if (checkedTool) { checkedTool.envelope.syncGuard(); if (Date.now() >= checkedTool.expires) throw new CapabilityError('TOOL_DELIVERY_INVALID', '工具投递凭据已过期。'); }
      send(200, { ok: true, result });
    } catch (e) { abandon(); send(e.code === 'PERMISSION_DENIED' ? 403 : 400, errorResult(e)); }
    finally {
      activeRequests.delete(stop);
      if (pendingTurn) pendingTurn.pending = false;
      if (res.destroyed || res.writableFinished) detach();
    }
  };
  handler.dispose = () => {
    disposed = true;
    for (const abort of activeRequests) abort();
    for (const turn of turnRequests.values()) cancelTurn(turn);
    for (const stored of contexts.values()) cancelTurn(stored.writerTurn);
    contexts.clear();
  };
  // Only host code can issue: HTTP has no issue/text/recipient operation.
  handler.issueIntent = async ({ publicContext, ownerContext, contexts = [publicContext, ownerContext].filter(Boolean), channel, text, outreachId, active, validateSources, syncGuard = () => {} }) => {
    if (channel.kind !== 'qq-private' || typeof text !== 'string' || !text.trim() || Array.from(text).length > 800 || typeof active !== 'function') throw new CapabilityError('INVALID_REQUEST', '主动投递材料无效。');
    for (const [id, old] of intents) if (old.expires < Date.now()) intents.delete(id);
    if (intents.size >= 1000) throw new CapabilityError('COMPANION_BUSY', '主动投递记录尚未释放。');
    if (!Array.isArray(contexts) || !contexts.length || !contexts.includes(ownerContext) || typeof syncGuard !== 'function') throw new CapabilityError('INVALID_REQUEST', '主动投递必须绑定实际目的地原上下文。');
    const intent = { contexts: [...contexts], ownerContext, channel: canonical(channel), text, outreachId, active, validateSources, syncGuard, expires: Date.now() + 120000, status: 'issued' };
    await validateIntent(intent);
    const intentId = crypto.randomBytes(24).toString('hex'); intents.set(intentId, intent);
    return intentId;
  };
  handler.intentStatus = id => intents.get(id)?.status || 'missing';
  handler.issueToolDelivery = envelope => {
    if (!envelope || envelope.channel?.kind !== 'qq-private' || envelope.memory_write !== false || typeof envelope.guard !== 'function' || typeof envelope.syncGuard !== 'function' || typeof envelope.text !== 'string' || Array.from(envelope.text).length > 6000 || !Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= Date.now()) throw new CapabilityError('INVALID_REQUEST', '工具投递材料无效。');
    for (const [id, item] of toolDeliveries) if (item.expires <= Date.now()) toolDeliveries.delete(id);
    if (toolDeliveries.size >= 64) throw new CapabilityError('TOOL_HOST_BUSY', '工具投递记录已满。');
    const deliveryId = crypto.randomBytes(24).toString('hex');
    toolDeliveries.set(deliveryId, { envelope, text: envelope.text, channel: JSON.stringify(canonical(envelope.channel)), expires: envelope.expiresAt, state: 'issued' });
    return deliveryId;
  };
  return handler;
}
