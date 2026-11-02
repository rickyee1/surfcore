import { createRolePackages, ROLE_PACKAGE_OPS } from './role-package.js';
import { CHARACTERS_DIR } from '../../../../src/character-persona.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { errorResult, CapabilityError } from './supervisor.js';
import { createBackupTransfer } from './backup-transfer.js';
import { TOOLS_UI_OPS } from './tools-client.js';

const ui = fs.readFileSync(new URL('./management.html', import.meta.url), 'utf8');
const toolsUi = fs.readFileSync(new URL('./tools-management.html', import.meta.url), 'utf8');
const toolsClient = fs.readFileSync(new URL('./tools-client.js', import.meta.url), 'utf8');
const semanticUi = fs.readFileSync(new URL('./semantic-management.html', import.meta.url), 'utf8');
const semanticClient = fs.readFileSync(new URL('./semantic-client.js', import.meta.url), 'utf8');
const roleUi = fs.readFileSync(new URL('./role-package-management.html', import.meta.url), 'utf8');
const roleClient = fs.readFileSync(new URL('./role-package-client.js', import.meta.url), 'utf8');
const mediaUi = fs.readFileSync(new URL('./media-management.html', import.meta.url), 'utf8');
const mediaClient = fs.readFileSync(new URL('./media-client.js', import.meta.url), 'utf8');
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); }
function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw new CapabilityError('INVALID_REQUEST', '请求过大。', '缩小迁移批次后重试。'); }
  try { return JSON.parse(text || '{}'); } catch { throw new CapabilityError('INVALID_REQUEST', 'JSON 格式无效。', '检查输入格式后重试。'); }
}
// Both hosts use this exact handler. The host authenticates the initial local page;
// HttpOnly cookie + random header secret + exact Origin protect every admin call.
export function createManagementHandler({ capabilities, base = '/local-capabilities', authorizePage = () => true, charactersRoot = CHARACTERS_DIR }) {
  const sessions = new Map();
  const backups = createBackupTransfer({ capabilities });
  const packages = createRolePackages({ capabilities, charactersRoot });
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const remote = req.socket?.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new CapabilityError('PERMISSION_DENIED', '只允许本机访问。');
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new CapabilityError('PERMISSION_DENIED', '请求主机无效。');
      if (req.method === 'GET' && [base, `${base}/tools`, `${base}/semantic`, `${base}/role-package`, `${base}/media`].includes(url.pathname)) {
        if (!await authorizePage(req)) throw new CapabilityError('PERMISSION_DENIED', '请先登录本机设置页。');
        const cookie = crypto.randomBytes(32).toString('hex'); const token = crypto.randomBytes(32).toString('hex');
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
        const mediaPage = url.pathname === `${base}/media`;
        sessions.set(cookie, { token, expires: Date.now() + 8 * 3600000, ...(mediaPage ? { mediaPageId: crypto.randomBytes(32).toString('hex') } : {}) });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': `surfcore_local=${cookie}; HttpOnly; SameSite=Strict; Path=${base}`, 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'" + (mediaPage ? '; img-src data:' : ''), 'referrer-policy': 'no-referrer' });
        const page = url.pathname === `${base}/tools` ? toolsUi.replace('__TOOLS_CLIENT__', () => toolsClient) :
          url.pathname === `${base}/semantic` ? semanticUi.replace('__SEMANTIC_CLIENT__', () => semanticClient) :
          url.pathname === `${base}/role-package` ? roleUi.replace('__ROLE_PACKAGE_CLIENT__', () => roleClient) :
          mediaPage ? mediaUi.replace('__MEDIA_CLIENT__', () => mediaClient) : ui;
        res.end(page.replace('__SESSION_TOKEN__', token).replaceAll('__API_BASE__', base)); return;
      }
      if (![`${base}/api`, `${base}/backup/import`, `${base}/backup/download`, `${base}/role-package/upload`, `${base}/role-package/download`].includes(url.pathname) || req.method !== 'POST') { json(res, 404, { ok: false, code: 'INVALID_REQUEST', error: '接口不存在。', hint: '打开本地记忆页面。' }); return; }
      const origin = req.headers.origin;
      if (!origin || ![`http://${host}`, `https://${host}`].includes(origin)) throw new CapabilityError('PERMISSION_DENIED', '跨站操作已拒绝。', '刷新本地页面后重试。');
      const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('surfcore_local='))?.slice(15);
      const session = sessions.get(cookie);
      if (!session || session.expires < Date.now() || !equal(session.token, req.headers['x-surfcore-session'])) throw new CapabilityError('PERMISSION_DENIED', '本地管理会话已过期。', '刷新此页面后重试。');
      if (url.pathname === `${base}/role-package/upload`) {
        if (!String(req.headers['content-type']).startsWith('application/octet-stream')) throw new CapabilityError('INVALID_REQUEST', '请选择加密角色包。');
        json(res, 200, { ok: true, result: await packages.upload(req) }); return;
      }
      if (url.pathname === `${base}/backup/import`) {
        if (!String(req.headers['content-type']).startsWith('application/octet-stream')) throw new CapabilityError('INVALID_REQUEST', '请选择加密备份文件。');
        json(res, 200, { ok: true, result: await backups.upload(req) }); return;
      }
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new CapabilityError('INVALID_REQUEST', '请求必须是 JSON。');
      if (url.pathname === `${base}/role-package/download`) { packages.download(req, res, await body(req)); return; }
      if (url.pathname === `${base}/backup/download`) { await backups.download(req, res, await body(req)); return; }
      const data = await body(req); let result;
      if (typeof data.op === 'string' && data.op.startsWith('media.')) {
        if (!data.op.startsWith('media.host.') || !session.mediaPageId) throw new CapabilityError('PERMISSION_DENIED', '请在本机语音与窗口控制页操作。', '重新打开控制页，核对原角色和设备用途。');
        if (!capabilities.mediaHost) throw new CapabilityError('SERVICE_UNAVAILABLE', '当前服务未连接桌宠媒体宿主。', '从 DSH 设置打开语音与窗口控制页。');
        result = await capabilities.mediaHost.dispatch(data.op, data.params ?? {}, { pageId: session.mediaPageId });
      }
      else if (ROLE_PACKAGE_OPS.includes(data.op)) result = await packages.dispatch(data.op, data.params || {});
      else if (data.op === 'status') result = capabilities.status();
      else if (data.op === 'backend.set') result = await capabilities.setMode(data.params?.mode);
      else if (data.op === 'health') { await capabilities.supervisor.start(); result = await capabilities.supervisor.raw('health', {}); }
      else if (data.op === 'qq-owner.set') result = await capabilities.setQqOwner(data.params?.mapping ?? null);
      else if (data.op === 'sharing.set') result = await capabilities.shareOwner(data.params?.enabled);
      else if (data.op === 'writer.status' || data.op === 'writer.run') {
        const writer = capabilities.semanticWriter;
        if (!writer) throw new CapabilityError('SERVICE_UNAVAILABLE', '当前管理服务未连接记忆整理器。', '请从 DSH 设置打开本地记忆管理，检查当前模型和 local 后端。');
        const params = data.params ?? {};
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'scopeId') ||
          (params.scopeId !== undefined && !/^[a-f0-9]{24}$/.test(params.scopeId))) throw new CapabilityError('INVALID_REQUEST', '只能选择当前已有的整理队列。', '刷新整理状态；不能在此提交正文、目标或权限。');
        result = data.op === 'writer.status' ? writer.status() : await writer.flush(params.scopeId || null);
      }
      else if (data.op === 'migration.preview') {
        const records = data.params?.records;
        if (!Array.isArray(records) || records.length > 1000 || records.some(x => !x || typeof x.text !== 'string' || !x.source_event_id)) throw new CapabilityError('INVALID_REQUEST', '迁移记录无效。', '提供最多 1000 条含 text 和 source_event_id 的记录。');
        result = { count: records.length, audience_scope: 'quarantine', source: 'legacy_summary', records };
      } else {
        // Browser tools are narrower than trusted host delivery operations.
        if (typeof data.op === 'string' && data.op.startsWith('tool.') && !TOOLS_UI_OPS.includes(data.op)) throw new CapabilityError('PERMISSION_DENIED', '本机工具浏览器操作未开放。', '由可信宿主准备固定请求，再到本页核对。');
        result = await capabilities.management(data.op, data.params || {}, data.expectedCharacter);
      }
      json(res, 200, { ok: true, result });
    } catch (e) { if (res.headersSent) res.destroy(); else json(res, e.code === 'PERMISSION_DENIED' ? 403 : 400, errorResult(e)); }
  };
}
