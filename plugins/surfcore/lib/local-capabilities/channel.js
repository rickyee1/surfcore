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
  return async (req, res) => {
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
      const trusted = { kind: channel.kind, account: String(channel.account || ''), peer: String(channel.peer || ''), principal: channel.kind === 'qq-private' ? String(channel.peer) : String(channel.principal || channel.peer || 'public') };
      let result;
      if (data.action === 'context') {
        const context = await capabilities.context(trusted, String(data.query || '').slice(0, 2000));
        const handle = crypto.randomBytes(24).toString('hex');
        if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
        contexts.set(handle, { context, channel: JSON.stringify(trusted), expires: Date.now() + 30 * 60000 });
        result = { context: handle, text: context.text, memory_epoch: context.memory_epoch, character_epoch: context.binding.character_epoch };
      } else {
        const stored = contexts.get(data.context);
        if (!stored || stored.expires < Date.now() || stored.channel !== JSON.stringify(trusted)) throw new CapabilityError('BINDING_INVALID', '渠道上下文已失效。', '重新建立本会话上下文。');
        await capabilities.validate(stored.context);
        if (data.action === 'sources') {
          const ids = data.eventIds;
          if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !id || id.length > 500) || new Set(ids).size !== ids.length) throw new CapabilityError('INVALID_REQUEST', '来源事件列表无效。', '提供最多 20 个不重复的来源事件编号。');
          const projection = await capabilities.supervisor.raw('context.sources', stored.context.binding, { source_event_ids: ids });
          // Never bless an earlier memory projection with a later epoch after a correction/delete race.
          if (projection.memory_epoch !== stored.context.memory_epoch) throw new CapabilityError('STALE_CONTEXT', '来源查询期间记忆已变更。', '重新读取本轮上下文。');
          const handle = crypto.randomBytes(24).toString('hex');
          if (contexts.size >= 1000) contexts.delete(contexts.keys().next().value);
          contexts.set(handle, { context: { ...stored.context, memory_epoch: projection.memory_epoch }, channel: stored.channel, expires: Date.now() + 30 * 60000 });
          result = { ...projection, context: handle };
        }
        else if (data.action === 'validate') result = { valid: true };
        else if (data.action === 'ingest') {
          result = await capabilities.ingest(stored.context, String(data.eventId || ''), String(data.text || ''));
          stored.context.memory_epoch = result.memory_epoch;
        } else if (['attention.check','attention.reserve','attention.finalize','attention.respond'].includes(data.action)) {
          result = await capabilities.supervisor.raw(data.action, stored.context.binding, data.params || {});
        } else throw new CapabilityError('PERMISSION_DENIED', '渠道操作未开放。');
      }
      send(200, { ok: true, result });
    } catch (e) { send(e.code === 'PERMISSION_DENIED' ? 403 : 400, errorResult(e)); }
  };
}
