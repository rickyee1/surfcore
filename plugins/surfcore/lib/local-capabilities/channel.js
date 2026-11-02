import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CapabilityError, errorResult } from './supervisor.js';

export function createChannelHandler({ capabilities, keyFile }) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // Only the plugin owns this credential; neither the browser nor model sees it.
  let key;
  try { key = fs.readFileSync(keyFile, 'utf8').trim(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' }); }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new CapabilityError('KEY_UNAVAILABLE', '渠道身份密钥格式无效。');
  const contexts = new Map();
  const intents = new Map();
  const canonical = channel => ({ kind: channel.kind, account: String(channel.account || ''), peer: String(channel.peer || ''), principal: channel.kind === 'qq-private' ? String(channel.peer) : String(channel.principal || channel.peer || 'public') });
  function checkIntentExpiry(intent) {
    if (Date.now() >= intent.expires) throw new CapabilityError('COMPANION_STOPPED', '主动轮次已过期。', '重新预览并发起新的轮次。');
  }
  async function validateIntent(intent) {
    checkIntentExpiry(intent);
    if (!await intent.active()) throw new CapabilityError('COMPANION_STOPPED', '主动轮次已停用或过期。', '重新预览并发起新的轮次。');
    const owner = capabilities.state.qqOwner;
    if (!owner || owner.account !== intent.channel.account || owner.peer !== intent.channel.peer) throw new CapabilityError('BINDING_INVALID', '主人绑定已变化，旧轮次已取消。');
    await capabilities.validate(intent.publicContext);
    await capabilities.validate(intent.ownerContext);
    checkIntentExpiry(intent);
  }
  const handler = async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const supplied = Buffer.from(String(req.headers['x-surfcore-channel-key'] || ''));
      const expected = Buffer.from(key);
      if (req.method !== 'POST' || req.headers.origin || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new CapabilityError('PERMISSION_DENIED', '渠道调用身份无效。');
      let raw = ''; for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 128 * 1024) throw new CapabilityError('INVALID_REQUEST', '渠道请求过大。'); }
      let data; try { data = JSON.parse(raw); } catch { throw new CapabilityError('INVALID_REQUEST', '渠道请求 JSON 无效。'); }
      const channel = data.channel;
      if (!channel || !['qq-private','qq-group','bili'].includes(channel.kind) || (channel.kind !== 'bili' && (!/^\d{1,20}$/.test(String(channel.account)) || !/^\d{1,20}$/.test(String(channel.peer))))) throw new CapabilityError('BINDING_INVALID', '渠道身份未验证。');
      // principal comes from authenticated private peer; groups never become owner.
      const trusted = canonical(channel);
      let result, checkedIntent;
      if (data.action === 'intent.claim') {
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
        const writerTurn = data.action === 'turn.begin' ? { lease: await capabilities.beginTurn?.(trusted) } : null;
        let context;
        try { context = await capabilities.context(trusted, String(data.query || '').slice(0, 2000)); }
        catch (error) { capabilities.endTurn?.(writerTurn?.lease); throw error; }
        const handle = crypto.randomBytes(24).toString('hex');
        if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
        contexts.set(handle, { context, channel: JSON.stringify(trusted), expires: Date.now() + 30 * 60000, writerTurn });
        result = { context: handle, text: context.text, memory_epoch: context.memory_epoch, character_epoch: context.binding.character_epoch };
      } else {
        const stored = contexts.get(data.context);
        if (!stored || stored.channel !== JSON.stringify(trusted) || (stored.expires < Date.now() && !['attention.finalize', 'intent.finish', 'turn.end'].includes(data.action))) throw new CapabilityError('BINDING_INVALID', '渠道上下文已失效。', '重新建立本会话上下文。');
        // Finalization releases no content; retain the original binding even after stop/correction.
        // Python still verifies reservation ownership and character epoch.
        if (!['attention.finalize', 'intent.finish', 'turn.end'].includes(data.action)) {
          if (stored.intent) { await validateIntent(stored.intent); checkedIntent = stored.intent; }
          await capabilities.validate(stored.context);
        }
        if (stored.intent && (!['validate', 'attention.check', 'attention.reserve', 'attention.finalize', 'intent.finish'].includes(data.action) || (data.action.startsWith('attention.') && data.params?.outreach_id !== stored.intent.outreachId))) throw new CapabilityError('PERMISSION_DENIED', '主动凭据仅可核查及结算原有投递，不能更改材料或事件。');
        if (data.action === 'turn.end') {
          capabilities.endTurn?.(stored.writerTurn?.lease);
          if (stored.writerTurn) stored.writerTurn.lease = null;
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
          contexts.set(handle, { context: { ...stored.context, memory_epoch: projection.memory_epoch }, channel: stored.channel, expires: Date.now() + 30 * 60000, writerTurn: stored.writerTurn });
          result = { ...projection, context: handle };
        }
        else if (data.action === 'validate') result = { valid: true };
        else if (data.action === 'ingest') {
          result = await capabilities.ingest(stored.context, String(data.eventId || ''), String(data.text || ''), { actor: trusted.kind.startsWith('qq-') ? 'user' : 'external' });
          stored.context.memory_epoch = result.memory_epoch;
        } else if (['attention.check','attention.reserve','attention.finalize','attention.respond'].includes(data.action)) {
          if (stored.intent && !['attention.check', 'attention.reserve', 'attention.finalize'].includes(data.action)) throw new CapabilityError('PERMISSION_DENIED', '主动凭据不能代替主人回复。');
          result = await capabilities.supervisor.raw(data.action, stored.context.binding, { ...(data.params || {}), memory_epoch: stored.context.memory_epoch });
          if (stored.intent && data.action === 'attention.finalize') stored.intent.status = result.status;
        } else throw new CapabilityError('PERMISSION_DENIED', '渠道操作未开放。');
      }
      // IPC/ledger work can outlive the validity check; expiry also gates the response.
      // Finalization intentionally has no checkedIntent and remains available after expiry.
      if (checkedIntent) checkIntentExpiry(checkedIntent);
      send(200, { ok: true, result });
    } catch (e) { send(e.code === 'PERMISSION_DENIED' ? 403 : 400, errorResult(e)); }
  };
  // Only host code can issue: HTTP has no issue/text/recipient operation.
  handler.issueIntent = async ({ publicContext, ownerContext, channel, text, outreachId, active }) => {
    if (channel.kind !== 'qq-private' || typeof text !== 'string' || !text.trim() || Array.from(text).length > 800 || typeof active !== 'function') throw new CapabilityError('INVALID_REQUEST', '主动投递材料无效。');
    for (const [id, old] of intents) if (old.expires < Date.now()) intents.delete(id);
    if (intents.size >= 1000) throw new CapabilityError('COMPANION_BUSY', '主动投递记录尚未释放。');
    const intent = { publicContext, ownerContext, channel: canonical(channel), text, outreachId, active, expires: Date.now() + 120000, status: 'issued' };
    await validateIntent(intent);
    const intentId = crypto.randomBytes(24).toString('hex'); intents.set(intentId, intent);
    return intentId;
  };
  handler.intentStatus = id => intents.get(id)?.status || 'missing';
  return handler;
}
