import fs from 'node:fs';
import path from 'node:path';
import { CapabilityError } from './supervisor.js';

export class LocalCapabilities {
  constructor({ supervisor, stateFile, currentCharacter }) {
    Object.assign(this, { supervisor, stateFile, currentCharacter });
    this.active = null; this.bindings = new Map(); this.serial = Promise.resolve();
    try { this.store = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new CapabilityError('INVALID_REQUEST', '本地后端配置损坏，已停止。'); this.store = { characters: {} }; }
  }
  get state() {
    const id = this.currentCharacter().id;
    this.store.characters ||= {};
    return this.store.characters[id] ||= { mode: 'legacy', written: false, shareOwner: false, qqOwner: null };
  }
  get mode() { return this.state.mode; }
  get guarded() { return ['local', 'paused'].includes(this.mode); }
  persist() { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); const tmp = `${this.stateFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600 }); fs.renameSync(tmp, this.stateFile); }
  async setMode(mode) {
    if (!['legacy', 'shadow', 'local', 'paused'].includes(mode)) throw new CapabilityError('INVALID_REQUEST', '未知后端状态。');
    if (this.state.written && ['legacy', 'shadow'].includes(mode)) throw new CapabilityError('PERMISSION_DENIED', '本地库已有正式写入，只能暂停。', '请先导出并核对本地数据。');
    // Retire before changing the pointer; failed retire leaves the old guarded state.
    if (this.active && this.supervisor.child && this.active.generation === this.supervisor.generation) await this.supervisor.raw('lifecycle.retire', this.active);
    this.active = null; this.bindings.clear(); this.state.mode = mode; this.persist();
    if (mode === 'local' || mode === 'shadow') await this.ensureCharacter();
    return this.status();
  }
  status() { return { mode: this.mode, written: this.state.written, shareOwner: this.state.shareOwner, qqOwner: this.state.qqOwner, character: this.currentCharacter(), integrations: { pet: 'available', qq: 'trusted-adapter-wired-platform-not-verified', bili: 'public-projection-wired-autonomous-send-blocked' } }; }
  async ensureCharacter() {
    // Serialize activation so concurrent channels never revoke each other's bindings.
    const work = this.serial.then(async () => {
      const c = this.currentCharacter(); const key = `${c.id}:${c.epoch}`;
      if (this.active?.key === key && this.supervisor.child && this.active.generation === this.supervisor.generation) return;
      await this.supervisor.start();
      if (this.active && this.active.generation === this.supervisor.generation) await this.supervisor.raw('lifecycle.retire', this.active);
      const result = await this.supervisor.raw('character.activate', {}, { character_id: c.id });
      this.active = { character_id: c.id, character_epoch: result.character_epoch, key, generation: this.supervisor.generation }; this.bindings.clear();
    });
    this.serial = work.catch(() => {}); await work;
  }
  async binding(channel) {
    if (!['local', 'shadow'].includes(this.mode)) throw new CapabilityError('SERVICE_UNAVAILABLE', '本地记忆已暂停。', '在本地记忆管理页恢复 local 后端。');
    await this.ensureCharacter();
    if (!['management', 'pet', 'qq-private', 'qq-group', 'bili'].includes(channel.kind)) throw new CapabilityError('BINDING_INVALID', '未知可信渠道。');
    const management = channel.kind === 'management';
    const shared = this.state.shareOwner && channel.kind === 'pet' || channel.kind === 'qq-private' && this.state.qqOwner?.account === String(channel.account) && this.state.qqOwner?.peer === String(channel.peer);
    const audience_scope = management || shared ? 'owner:local' : channel.kind === 'pet' ? 'pet:local' : channel.kind === 'bili' ? 'bili:public' : `qq:${channel.kind === 'qq-group' ? 'group' : 'private'}:${channel.account}:${channel.peer}`;
    const key = JSON.stringify([this.active.key, channel.kind, channel.account, channel.peer, shared]);
    if (!this.bindings.has(key)) {
      const result = await this.supervisor.raw('session.bind', this.active, { platform: management ? 'local' : channel.kind.startsWith('qq') ? 'qq' : channel.kind, account_id: channel.account || 'local', conversation_id: channel.peer || 'local', principal_id: management ? 'owner:local' : channel.principal || channel.peer || 'pet:local', audience_scope, is_owner: management || shared || channel.kind === 'pet', management });
      this.bindings.set(key, { ...this.active, session_binding: result.session_binding });
    }
    return this.bindings.get(key);
  }
  async call(channel, op, params = {}) { return this.supervisor.raw(op, await this.binding(channel), params); }
  async context(channel) {
    const binding = await this.binding(channel);
    // Conversation context is a bounded scoped projection, not a literal search of the new utterance.
    // Explicit search remains available only through the management query interface.
    const result = await this.supervisor.raw('memory.query', binding, { query: '', limit: 20 });
    return { binding, memory_epoch: result.memory_epoch, text: (result.memories || []).map(m => m.statement).join('\n') };
  }
  async validate(context) {
    const current = this.currentCharacter();
    if (this.mode !== 'local' || context.binding.key !== `${current.id}:${current.epoch}`) throw new CapabilityError('STALE_CHARACTER', '角色或后端已切换，本次回复已取消。');
    return this.supervisor.raw('context.validate', context.binding, { memory_epoch: context.memory_epoch });
  }
  async ingest(context, source_event_id, text, { derivedFrom = [] } = {}) {
    if (!Array.isArray(derivedFrom) || derivedFrom.length > 20 || derivedFrom.some(source => !source || typeof source.id !== 'string' || !source.id || source.id.length > 200 || !Number.isSafeInteger(source.revision) || source.revision < 1) || new Set(derivedFrom.map(source => source.id)).size !== derivedFrom.length) throw new CapabilityError('INVALID_REQUEST', '派生来源版本无效。');
    await this.validate(context);
    // Persist intent first: an unknown IPC outcome must never permit rollback to legacy.
    this.state.written = true; this.persist();
    try { return await this.supervisor.raw('memory.ingest', context.binding, { source_event_id, text, source_refs: [`event:${source_event_id}`], expected_memory_epoch: context.memory_epoch, ...(derivedFrom.length ? { derived_from: derivedFrom.map(source => source.id), source_revisions: Object.fromEntries(derivedFrom.map(source => [source.id, source.revision])) } : {}) }); }
    catch (e) { if (e.code === 'AUTO_WRITE_DISABLED') return { skipped: true, stored: false, memory_epoch: context.memory_epoch }; throw e; }
  }
  async management(op, params = {}) {
    const allowed = new Set(['memory.query','memory.detail','memory.correct','memory.suspend','memory.resume','memory.delete','memory.export','memory.settings','memory.migrate','memory.proposals.list','memory.index.rebuild','attention.configure','backup.create','backup.inspect','backup.restore.stage','backup.restore.commit','backup.restore.cancel','backup.recovery.status']);
    if (!allowed.has(op)) throw new CapabilityError('PERMISSION_DENIED', '管理操作未开放。');
    if (['memory.migrate','memory.correct','memory.delete','memory.suspend','memory.resume','backup.restore.commit'].includes(op)) { this.state.written = true; this.persist(); }
    try {
      return await this.call({ kind: 'management' }, op, params);
    } finally {
      // A lost restore response may still mean the database was replaced. Never
      // reuse a cached binding, or automatically retry an old generated reply.
      if (op === 'backup.restore.commit') { this.active = null; this.bindings.clear(); }
    }
  }
  async setQqOwner(mapping) {
    if (mapping !== null && (!/^\d{1,20}$/.test(String(mapping.account)) || !/^\d{1,20}$/.test(String(mapping.peer)))) throw new CapabilityError('INVALID_REQUEST', '请输入有效的 QQ 账号与私聊联系人编号。');
    if (this.active) await this.supervisor.raw('lifecycle.retire', this.active);
    this.active = null; this.bindings.clear(); this.state.qqOwner = mapping ? { account: String(mapping.account), peer: String(mapping.peer) } : null; this.persist(); return this.status();
  }
  async shareOwner(enabled) {
    if (typeof enabled !== 'boolean') throw new CapabilityError('INVALID_REQUEST', '共享选项必须是布尔值。');
    if (this.active) await this.supervisor.raw('lifecycle.retire', this.active);
    this.active = null; this.bindings.clear(); this.state.shareOwner = enabled; this.persist(); return this.status();
  }
}
