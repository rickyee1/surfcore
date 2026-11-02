import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IDS, fault } from './a01-contract.mjs';

// A bounded OneBot transport fixture. It never loads credentials or connects to
// SnowLuma. Native bridge/SDK/MCP clients remain untouched.
export async function createRecorder({ now = Date.now } = {}) {
  const events = new EventEmitter(), sockets = new Set(), bubbles = [], requests = [], messages = new Map(); let nextId = 1;
  function action(name, p = {}) {
    requests.push({ action: name, at: now() }); // Never record auth headers.
    if (['send_private_msg','send_group_msg','send_msg'].includes(name)) {
      const group = name === 'send_group_msg' || p.group_id !== undefined;
      const target = String(group ? p.group_id : p.user_id);
      if (!(group ? [IDS.group_a, IDS.group_b] : [IDS.owner, IDS.other]).includes(target)) return { status: 'failed', retcode: 1403, data: null };
      const message_id = nextId++, segments = typeof p.message === 'string' ? [{ type: 'text', data: { text: p.message } }] : p.message;
      const item = { message_id, kind: group ? 'group' : 'private', target, segments: structuredClone(segments), text: segments.filter(s => s.type === 'text').map(s => s.data.text).join(''), at: now() };
      bubbles.push(item); messages.set(String(message_id), item); events.emit('bubble', item);
      return { status: 'ok', retcode: 0, data: { message_id } };
    }
    const data = {
      get_login_info: { user_id: Number(IDS.bot), nickname: '小岚' },
      get_status: { online: true, good: true, receiveHealthy: true },
      get_version_info: { app_name: 'A01-isolated-recorder', app_version: '1', protocol_version: 'v11' },
      get_friend_list: [{ user_id: Number(IDS.owner), nickname: '小禾', remark: '小禾' }, { user_id: Number(IDS.other), nickname: '乙' }],
      get_group_list: [{ group_id: Number(IDS.group_a), group_name: '合成群甲' }, { group_id: Number(IDS.group_b), group_name: '合成群乙' }],
      get_group_member_list: [{ user_id: Number(IDS.owner), nickname: '甲' }, { user_id: Number(IDS.other), nickname: '乙' }, { user_id: Number(IDS.bot), nickname: '小岚' }],
      get_group_info: { group_id: p.group_id, group_name: '合成测试群', member_count: 3 },
      get_group_member_info: { group_id: p.group_id, user_id: p.user_id, nickname: String(p.user_id) === IDS.owner ? '甲' : '乙', role: 'member' },
      get_stranger_info: { user_id: p.user_id, nickname: String(p.user_id) === IDS.owner ? '小禾' : '乙' },
      get_msg: messages.get(String(p.message_id)) || null,
      get_friend_msg_history: { messages: [] }, get_group_msg_history: { messages: [] },
      get_sticker_list: [], get_custom_face: [], can_send_image: { yes: false }, can_send_record: { yes: false },
    };
    return Object.hasOwn(data, name) ? { status: 'ok', retcode: 0, data: data[name] } : { status: 'failed', retcode: 1404, data: null, message: 'A01 transport action unsupported' };
  }
  function frame(data, opcode = 1) {
    const body = Buffer.from(data), header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    if (body.length < 126) header[1] = body.length; else { if (body.length > 65535) throw fault('FRAME_TOO_LARGE'); header[1] = 126; header.writeUInt16BE(body.length, 2); }
    return Buffer.concat([header, body]);
  }
  function send(socket, data) { socket.write(frame(JSON.stringify(data))); }
  const server = http.createServer(async (req, res) => {
    let body = ''; try {
      if (req.method !== 'POST' && req.method !== 'GET') throw fault('METHOD_NOT_ALLOWED');
      for await (const c of req) { body += c; if (body.length > 1024 * 1024) throw fault('BODY_TOO_LARGE'); }
      const url = new URL(req.url, 'http://127.0.0.1'), params = body ? JSON.parse(body) : Object.fromEntries(url.searchParams);
      const result = action(url.pathname.slice(1), params); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(JSON.stringify({ status: 'failed', retcode: 1400, data: null })); }
  });
  server.on('upgrade', (req, socket) => {
    if (!req.headers['sec-websocket-key']) return socket.destroy();
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); events.emit('connected'); let pending = Buffer.alloc(0);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 1024 * 1024) return socket.destroy();
      while (pending.length >= 2) {
        const opcode = pending[0] & 15; let size = pending[1] & 127, offset = 2;
        if (!(pending[0] & 128) || !(pending[1] & 128) || size === 127) return socket.destroy();
        if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); offset = 4; }
        if (pending.length < offset + 4 + size) return;
        const mask = pending.subarray(offset, offset + 4), payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        pending = pending.subarray(offset + 4 + size);
        if (opcode === 8) { socket.end(frame('', 8)); return; }
        if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
        if (opcode !== 1) continue;
        try { const call = JSON.parse(payload); send(socket, { ...action(call.action, call.params), echo: call.echo }); } catch { socket.destroy(); }
      }
    });
    send(socket, { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: Number(IDS.bot), time: Math.floor(now() / 1000) });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl, wsUrl: baseUrl.replace('http:', 'ws:'), events, bubbles, requests,
    inject(text, { group = false, sender = IDS.owner, groupId = IDS.group_a, phase = 'scored', turn = 0 } = {}) {
      if (!sockets.size) throw fault('ONEBOT_NOT_CONNECTED', 'Wait for the native bridge transport.');
      const message_id = nextId++, at = now(), event = { time: Math.floor(at / 1000), self_id: Number(IDS.bot), post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend',
        user_id: Number(sender), ...(group ? { group_id: Number(groupId) } : {}), message_id, message: [{ type: 'text', data: { text } }], raw_message: text,
        sender: { user_id: Number(sender), nickname: sender === IDS.owner ? (group ? '甲' : '小禾') : '乙', ...(group ? { role: 'member' } : {}) } };
      messages.set(String(message_id), event); for (const socket of sockets) send(socket, event);
      return { message_id, text, at, phase, turn, sender };
    },
    connected: () => sockets.size > 0,
    async close() { for (const s of sockets) s.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
