import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';

export class CapabilityError extends Error {
  constructor(code, error, hint = '打开本地记忆管理页检查状态后重试。') { super(error); this.code = code; this.hint = hint; }
  toJSON() { return { ok: false, code: this.code, error: this.message, hint: this.hint }; }
}
export function errorResult(e) { return e instanceof CapabilityError ? e.toJSON() : new CapabilityError('SERVICE_UNAVAILABLE', '本地能力服务不可用。').toJSON(); }

// One owner, one child, no TCP listener and no protocol access exposed to a model.
export class CapabilitySupervisor {
  constructor({ python, entry, dataDir, env = {}, spawnProcess = spawn, timeoutMs = 10000 }) {
    Object.assign(this, { python, entry, dataDir, env, spawnProcess, timeoutMs });
    this.generation = 0; this.pending = new Map(); this.child = null; this.starting = null; this.stopped = false;
  }
  async start() {
    if (this.stopped) throw new CapabilityError('SERVICE_UNAVAILABLE', '服务已停止。');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      const child = this.spawnProcess(this.python, [this.entry, '--data-dir', this.dataDir], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...this.env },
      });
      this.child = child; this.generation += 1;
      const fail = () => {
        if (this.child === child) this.child = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CapabilityError('SERVICE_UNAVAILABLE', '本地能力进程退出；当前操作已停止。')); }
        this.pending.clear();
      };
      child.on('error', fail); child.on('exit', fail);
      child.stderr.on('data', () => {}); // Never log text or keys from the private child.
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) { child.kill(); return; }
        let reply; try { reply = JSON.parse(line); } catch { child.kill(); return; }
        const p = this.pending.get(reply.request_id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(reply.request_id);
        if (reply.protocol_version !== 1) p.reject(new CapabilityError('PROTOCOL_MISMATCH', '本地服务协议不兼容。'));
        else if (!reply.ok) p.reject(new CapabilityError(reply.code, reply.error, reply.hint));
        else p.resolve(reply.result);
      });
      await this.raw('health', {});
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  raw(op, fields, params = {}) {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new CapabilityError('SERVICE_UNAVAILABLE', '本地服务未运行。'));
    const request_id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new CapabilityError('SERVICE_UNAVAILABLE', '本地服务响应超时；结果未确认，请查询后重试。'));
      }, this.timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...fields, protocol_version: 1, request_id, op, deadline: Date.now() + this.timeoutMs, params }) + '\n', e => {
        if (e) { clearTimeout(timer); this.pending.delete(request_id); reject(new CapabilityError('SERVICE_UNAVAILABLE', '本地服务写入失败。')); }
      });
    });
  }
  async stop() {
    this.stopped = true;
    const child = this.child; if (!child) return;
    child.stdin.end();
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}
