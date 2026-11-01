import crypto from 'node:crypto';
import fs from 'node:fs';
import { errorResult, CapabilityError } from './supervisor.js';

const ui = fs.readFileSync(new URL('./management.html', import.meta.url), 'utf8');
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); }
function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw new CapabilityError('INVALID_REQUEST', '请求过大。', '缩小迁移批次后重试。'); }
  try { return JSON.parse(text || '{}'); } catch { throw new CapabilityError('INVALID_REQUEST', 'JSON 格式无效。', '检查输入格式后重试。'); }
}
// Both hosts use this exact handler. The host authenticates the initial local page;
// HttpOnly cookie + random header secret + exact Origin protect every admin call.
export function createManagementHandler({ capabilities, base = '/local-capabilities', authorizePage = () => true }) {
  const sessions = new Map();
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const remote = req.socket?.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new CapabilityError('PERMISSION_DENIED', '只允许本机访问。');
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new CapabilityError('PERMISSION_DENIED', '请求主机无效。');
      if (req.method === 'GET' && url.pathname === base) {
        if (!await authorizePage(req)) throw new CapabilityError('PERMISSION_DENIED', '请先登录本机设置页。');
        const cookie = crypto.randomBytes(32).toString('hex'); const token = crypto.randomBytes(32).toString('hex');
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
        sessions.set(cookie, { token, expires: Date.now() + 8 * 3600000 });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': `surfcore_local=${cookie}; HttpOnly; SameSite=Strict; Path=${base}`, 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'", 'referrer-policy': 'no-referrer' });
        res.end(ui.replace('__SESSION_TOKEN__', token).replaceAll('__API_BASE__', base)); return;
      }
      if (url.pathname !== `${base}/api` || req.method !== 'POST') { json(res, 404, { ok: false, code: 'INVALID_REQUEST', error: '接口不存在。', hint: '打开本地记忆页面。' }); return; }
      const origin = req.headers.origin;
      if (!origin || ![`http://${host}`, `https://${host}`].includes(origin)) throw new CapabilityError('PERMISSION_DENIED', '跨站操作已拒绝。', '刷新本地页面后重试。');
      const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('surfcore_local='))?.slice(15);
      const session = sessions.get(cookie);
      if (!session || session.expires < Date.now() || !equal(session.token, req.headers['x-surfcore-session'])) throw new CapabilityError('PERMISSION_DENIED', '本地管理会话已过期。', '刷新此页面后重试。');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new CapabilityError('INVALID_REQUEST', '请求必须是 JSON。');
      const data = await body(req); let result;
      if (data.op === 'status') result = capabilities.status();
      else if (data.op === 'backend.set') result = await capabilities.setMode(data.params?.mode);
      else if (data.op === 'health') { await capabilities.supervisor.start(); result = await capabilities.supervisor.raw('health', {}); }
      else if (data.op === 'qq-owner.set') result = await capabilities.setQqOwner(data.params?.mapping ?? null);
      else if (data.op === 'sharing.set') result = await capabilities.shareOwner(data.params?.enabled);
      else if (data.op === 'migration.preview') {
        const records = data.params?.records;
        if (!Array.isArray(records) || records.length > 1000 || records.some(x => !x || typeof x.text !== 'string' || !x.source_event_id)) throw new CapabilityError('INVALID_REQUEST', '迁移记录无效。', '提供最多 1000 条含 text 和 source_event_id 的记录。');
        result = { count: records.length, audience_scope: 'quarantine', source: 'legacy_summary', records };
      } else result = await capabilities.management(data.op, data.params || {});
      json(res, 200, { ok: true, result });
    } catch (e) { json(res, e.code === 'PERMISSION_DENIED' ? 403 : 400, errorResult(e)); }
  };
}
