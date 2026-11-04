import { assertTargetReady, captureTargetGate, assertTargetGate } from '../../../../src/role-package-gate.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CapabilityError } from './supervisor.js';
import { TOOLS_UI_OPS } from './tools-client.js';
import { refineSemanticContext, SEMANTIC_UI_OPS } from './semantic-context.js';

export class LocalCapabilities {
  // Host-only credentials: never part of a binding, context, state or response.
  #ingress = new Map();
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
  assertReady(captured) {
    try { return captured ? assertTargetGate(captured, this.currentCharacter()) : captureTargetGate(this.currentCharacter()); }
    catch (error) { throw new CapabilityError(error.code || 'ROLE_PACKAGE_PAUSED', error.message, error.hint); }
  }
  get mode() { return this.state.mode; }
  get guarded() { return ['local', 'paused'].includes(this.mode); }
  persist() { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); const tmp = `${this.stateFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600 }); fs.renameSync(tmp, this.stateFile); }
  async setMode(mode) {
    if (!['legacy', 'shadow', 'local', 'paused'].includes(mode)) throw new CapabilityError('INVALID_REQUEST', '未知后端状态。');
    if (this.state.written && ['legacy', 'shadow'].includes(mode)) throw new CapabilityError('PERMISSION_DENIED', '本地库已有正式写入，只能暂停。', '请先导出并核对本地数据。');
    this.semanticWriter?.cancel();
    this.toolHost?.invalidate('BACKEND_CHANGED');
    // Retire before changing the pointer; failed retire leaves the old guarded state.
    if (this.active && this.supervisor.child && this.active.generation === this.supervisor.generation) await this.supervisor.raw('lifecycle.retire', this.active);
    this.active = null; this.bindings.clear(); this.#ingress.clear(); this.state.mode = mode; this.persist();
    if (mode === 'local' || mode === 'shadow') await this.ensureCharacter();
    return this.status();
  }
  status() { return { mode: this.mode, written: this.state.written, shareOwner: this.state.shareOwner, qqOwner: this.state.qqOwner, character: this.currentCharacter(), toolHost: this.toolHost?.status() || null, integrations: { pet: 'available', qq: 'trusted-adapter-wired-platform-not-verified', bili: 'public-projection-wired-autonomous-send-blocked' } }; }
  async ensureCharacter() {
    // Serialize activation so concurrent channels never revoke each other's bindings.
    const work = this.serial.then(async () => {
      const c = this.currentCharacter(); this.assertReady(); const key = `${c.id}:${c.epoch}`;
      if (this.active?.key === key && this.supervisor.child && this.active.generation === this.supervisor.generation) return;
      this.semanticWriter?.cancel();
      this.toolHost?.invalidate('CHARACTER_CHANGED');
      await this.supervisor.start();
      if (this.active && this.active.generation === this.supervisor.generation) await this.supervisor.raw('lifecycle.retire', this.active);
      const result = await this.supervisor.raw('character.activate', {}, { character_id: c.id });
      this.active = { character_id: c.id, character_epoch: result.character_epoch, key, generation: this.supervisor.generation }; this.bindings.clear(); this.#ingress.clear();
    });
    this.serial = work.catch(() => {}); await work;
  }
  async binding(channel) {
    this.assertReady();
    if (!['local', 'shadow'].includes(this.mode)) throw new CapabilityError('SERVICE_UNAVAILABLE', '本地记忆已暂停。', '在本地记忆管理页恢复 local 后端。');
    await this.ensureCharacter();
    if (!['management', 'pet', 'qq-private', 'qq-group', 'bili'].includes(channel.kind)) throw new CapabilityError('BINDING_INVALID', '未知可信渠道。');
    const management = channel.kind === 'management';
    if (!management && this.toolHost) await this.toolHost.syncPolicy();
    const shared = this.state.shareOwner && channel.kind === 'pet' || channel.kind === 'qq-private' && this.state.qqOwner?.account === String(channel.account) && this.state.qqOwner?.peer === String(channel.peer);
    const audience_scope = management || shared ? 'owner:local' : channel.kind === 'pet' ? 'pet:local' : channel.kind === 'bili' ? 'bili:public' : `qq:${channel.kind === 'qq-group' ? 'group' : 'private'}:${channel.account}:${channel.peer}`;
    const key = JSON.stringify([this.active.key, channel.kind, channel.account, channel.peer, shared]);
    if (!this.bindings.has(key)) {
      const result = await this.supervisor.raw('session.bind', this.active, { platform: management ? 'local' : channel.kind.startsWith('qq') ? 'qq' : channel.kind, account_id: channel.account || 'local', conversation_id: channel.peer || 'local', principal_id: management ? 'owner:local' : channel.principal || channel.peer || 'pet:local', audience_scope, is_owner: management || shared || channel.kind === 'pet', management });
      // Scope sharing never erases the original transport identity used by tools/turn gates.
      this.bindings.set(key, { ...this.active, session_binding: result.session_binding, audience_scope, platform: management ? 'local' : channel.kind.startsWith('qq') ? 'qq' : channel.kind, account: String(channel.account || 'local'), conversation: String(channel.peer || 'local') });
    }
    const binding = this.bindings.get(key);
    return !management && this.toolHost ? { ...binding, host_gate: this.toolHost.capture(channel) } : binding;
  }
  async call(channel, op, params = {}) { return this.supervisor.raw(op, await this.binding(channel), params); }
  async context(channel, query = '') {
    const binding = await this.binding(channel);
    // Recent context remains available with semantic search disabled. Enabled
    // search supplements it from this same binding and original memory epoch.
    const result = await this.supervisor.raw('memory.query', binding, { query: '', limit: 20 });
    const context = { binding, memory_epoch: result.memory_epoch, records: result.memories || [], text: (result.memories || []).map(m => m.statement).join('\n') };
    return query ? this.refineContext(context, query) : context;
  }
  async refineContext(context, query, options = {}) { return refineSemanticContext(this, context, query, options); }
  async materials(channel, options = {}) {
    const { limit = 20 } = options;
    if (Object.keys(options).some(key => key !== 'limit') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new CapabilityError('INVALID_REQUEST', '目的素材数量必须为 1–50，且不能指定查询或受众。', '使用实际目的地渠道和有界数量重新读取。');
    if (!channel || channel.kind === 'management')
      throw new CapabilityError('PERMISSION_DENIED', '目的素材必须使用实际目的地的普通绑定。', '选择 QQ 或桌宠目的地后重新读取。');
    const target = this.assertReady();
    const binding = await this.binding({ ...channel });
    this.assertReady(target);
    const result = await this.supervisor.raw('memory.materials', binding, { limit });
    this.assertReady(target);
    if (binding.generation !== this.supervisor.generation || binding.key !== this.active?.key ||
        binding.character_epoch !== this.active?.character_epoch || result.character_epoch !== binding.character_epoch ||
        ![...this.bindings.values()].some(value => value.session_binding === binding.session_binding))
      throw new CapabilityError('STALE_CHARACTER', '素材读取期间原绑定已失效。', '丢弃本轮素材，在当前角色重新开始。');
    return { binding, memory_epoch: result.memory_epoch, records: result.records || [],
      text: (result.records || []).map(record => record.statement).join('\n'),
      coverage: { limit, returned_count: (result.records || []).length, has_more: result.has_more,
        unknown_time_count: result.unknown_time_count, audience_scope: binding.audience_scope } };
  }
  async validate(context) {
    const current = this.currentCharacter(); assertTargetReady(current.id);
    if (this.mode !== 'local' || context.binding.key !== `${current.id}:${current.epoch}`) throw new CapabilityError('STALE_CHARACTER', '角色或后端已切换，本次回复已取消。');
    if (this.toolHost) await this.toolHost.checkCapture(context.binding.host_gate);
    const result = await this.supervisor.raw('context.validate', context.binding, { memory_epoch: context.memory_epoch });
    this.toolHost?.validateCapture(context.binding.host_gate);
    return result;
  }
  async beginTurn(channel) { if (!this.semanticWriter || this.mode !== 'local') return null; return this.semanticWriter.begin(await this.binding(channel)); }
  async validateSourceContext(context) {
    const current = this.currentCharacter(); assertTargetReady(current.id);
    if (this.mode !== 'local' || context.binding.key !== `${current.id}:${current.epoch}`) throw new CapabilityError('STALE_CHARACTER', '原入站来源的角色已失效。');
    if (this.toolHost) await this.toolHost.checkCapture(context.binding.host_gate, { sourceOnly: true });
    const result = await this.supervisor.raw('context.validate', context.binding, { memory_epoch: context.memory_epoch });
    this.toolHost?.validateCapture(context.binding.host_gate, { sourceOnly: true });
    return result;
  }
  endTurn(lease) { if (lease) this.semanticWriter?.end(lease); }
  async ingest(context, source_event_id, text, { derivedFrom = [], actor = 'unknown', original = false } = {}) {
    if (typeof source_event_id !== 'string' || !source_event_id || source_event_id.length > 500) throw new CapabilityError('INVALID_REQUEST', '经历事件标识无效。');
    if (!['user', 'assistant', 'external', 'unknown'].includes(actor)) throw new CapabilityError('INVALID_REQUEST', '经历来源类型无效。');
    if (!Array.isArray(derivedFrom) || derivedFrom.length > 20 || derivedFrom.some(source => !source || typeof source.id !== 'string' || !source.id || source.id.length > 200 || !Number.isSafeInteger(source.revision) || source.revision < 1) || new Set(derivedFrom.map(source => source.id)).size !== derivedFrom.length) throw new CapabilityError('INVALID_REQUEST', '派生来源版本无效。');
    if (typeof original !== 'boolean' || original && (derivedFrom.length || actor === 'unknown'))
      throw new CapabilityError('INVALID_REQUEST', '原始来源不能包含派生证明或未知发言者。', '仅在可信宿主收到本次原始输入、输出或公共来源时声明 original。');
    // Capture this write's authority once, including the ORIGINAL state object.
    // host_gate is an opaque frozen capability: keep its identity, never clone it.
    const target = this.assertReady(), character = { ...this.currentCharacter() }, state = this.state;
    const { host_gate, ...bindingFields } = context.binding;
    const binding = Object.freeze({ ...structuredClone(bindingFields), ...(host_gate === undefined ? {} : { host_gate }) });
    const sourceContext = { binding, memory_epoch: context.memory_epoch }, generation = this.supervisor.generation;
    const derived = derivedFrom.map(source => ({ id: source.id, revision: source.revision }));
    const assertOriginal = () => {
      this.assertReady(target);
      const current = this.currentCharacter();
      if (current.id !== character.id || current.epoch !== character.epoch || binding.key !== `${character.id}:${character.epoch}` ||
          this.store.characters[character.id] !== state || state.mode !== 'local' || !this.supervisor.child ||
          this.supervisor.generation !== generation || binding.generation !== generation ||
          this.active?.key !== binding.key || this.active?.character_epoch !== binding.character_epoch ||
          ![...this.bindings.values()].some(value => value.session_binding === binding.session_binding && value.generation === generation))
        throw new CapabilityError('STALE_CHARACTER', '原入库角色、绑定或服务代次已失效。', '核对原角色的入库结果；丢弃旧轮，不会转给新角色或自动重试。');
      this.toolHost?.validateCapture(binding.host_gate);
    };
    const validateOriginal = async () => {
      assertOriginal(); await this.validate(sourceContext); assertOriginal();
    };
    if (original && (binding.platform === 'local' || !['pet', 'qq', 'bili'].includes(binding.platform) ||
        (binding.platform === 'bili' ? actor !== 'external' : !['user', 'assistant'].includes(actor)) ||
        ![...this.bindings.values()].some(value => value.session_binding === binding.session_binding && value.platform === binding.platform)))
      throw new CapabilityError('PERMISSION_DENIED', '原始来源类型与原普通渠道绑定不匹配。', '使用本次真实来源的原绑定；管理、迁移和 Writer 不得声明原话。');
    await validateOriginal(); assertOriginal();
    let ingress;
    if (original) {
      if (!this.#ingress.has(binding.session_binding)) {
        const opening = this.supervisor.raw('memory.ingress.open', binding).then(result => result.ingress_token);
        this.#ingress.set(binding.session_binding, opening);
        opening.catch(() => { if (this.#ingress.get(binding.session_binding) === opening) this.#ingress.delete(binding.session_binding); });
      }
      const token = await this.#ingress.get(binding.session_binding);
      assertOriginal();
      await validateOriginal();
      assertOriginal();
      ingress = { token, kind: { user: 'user_input', assistant: 'assistant_output', external: 'external_source' }[actor] };
    }
    // Persist intent first: an unknown IPC outcome must never permit rollback to legacy.
    assertOriginal(); state.written = true; this.persist(); assertOriginal();
    const refs = [`event:${source_event_id}`, ...(actor !== 'unknown' ? [`writer-origin:${actor}:${crypto.createHash('sha256').update(source_event_id).digest('hex')}`] : [])];
    try {
      assertOriginal();
      const result = await this.supervisor.raw('memory.ingest', binding, { source_event_id, text, source_refs: refs, expected_memory_epoch: sourceContext.memory_epoch, ...(ingress ? { ingress } : {}), ...(derived.length ? { derived_from: derived.map(source => source.id), source_revisions: Object.fromEntries(derived.map(source => [source.id, source.revision])) } : {}) });
      assertOriginal();
      if (!result.duplicate) this.semanticWriter?.notify(binding);
      return result;
    }
    catch (e) { assertOriginal(); if (e.code === 'AUTO_WRITE_DISABLED') return { skipped: true, stored: false, memory_epoch: sourceContext.memory_epoch }; throw e; }
  }
  async management(op, params = {}, expectedCharacter) {
    const allowed = new Set([...SEMANTIC_UI_OPS, ...TOOLS_UI_OPS.filter(op => op !== 'status'),'memory.query','memory.detail','memory.correct','memory.suspend','memory.resume','memory.delete','memory.export','memory.settings','memory.migrate','memory.proposals.list','memory.index.rebuild','attention.configure','backup.create','backup.inspect','backup.restore.stage','backup.restore.commit','backup.restore.cancel','backup.recovery.status']);
    if (!allowed.has(op)) throw new CapabilityError('PERMISSION_DENIED', '管理操作未开放。');
    const fixed = expectedCharacter !== undefined;
    if (fixed && (!expectedCharacter || typeof expectedCharacter !== 'object' || Array.isArray(expectedCharacter) ||
      Object.keys(expectedCharacter).sort().join(',') !== 'epoch,id' || typeof expectedCharacter.id !== 'string' ||
      !expectedCharacter.id || expectedCharacter.id.length > 200 || !Number.isSafeInteger(expectedCharacter.epoch) || expectedCharacter.epoch < 0))
      throw new CapabilityError('INVALID_REQUEST', '管理操作的原角色与代次无效。', '刷新本机页面，重新核对当前角色。');
    const expectedKey = fixed ? `${expectedCharacter.id}:${expectedCharacter.epoch}` : null;
    const checkExpected = binding => {
      if (!fixed) return;
      const current = this.currentCharacter();
      if (this.mode !== 'local' || `${current.id}:${current.epoch}` !== expectedKey || (binding && binding.key !== expectedKey))
        throw new CapabilityError('STALE_CHARACTER', '角色或代次已经变化，操作不会转给新角色。', '刷新页面核对原操作结果；不会自动重试。');
      assertTargetReady(current.id);
    };
    checkExpected();
    // Capture once. A later current-character lookup cannot silently choose B
    // for an action the user reviewed on A, including during session.bind.
    const binding = fixed ? await this.binding({ kind: 'management' }) : null;
    checkExpected(binding);
    const dispatch = async () => {
      checkExpected(binding);
      const result = binding ? await this.supervisor.raw(op, binding, params) : await this.call({ kind: 'management' }, op, params);
      checkExpected(binding);
      return result;
    };
    if (this.toolHost && ['tool.emergency.stop', 'tool.emergency.reset'].includes(op)) return this.toolHost.emergency(op.endsWith('.stop') ? 'stop' : 'reset');
    if (this.toolHost && ['tool.grants.revoke', 'tool.roots.revoke'].includes(op)) return this.toolHost.policyChange(dispatch);
    if (['memory.correct', 'memory.delete', 'memory.suspend', 'memory.resume'].includes(op)) this.toolHost?.invalidate('SOURCE_CHANGED');
    if (['backup.restore.commit', 'backup.restore.stage'].includes(op)) this.toolHost?.invalidate('RECOVERY_CHANGED');
    if (['memory.migrate','memory.correct','memory.delete','memory.suspend','memory.resume','backup.restore.commit'].includes(op)) { (fixed ? this.store.characters[expectedCharacter.id] : this.state).written = true; this.persist(); }
    try {
      return await dispatch();
    } finally {
      // A lost restore response may still mean the database was replaced. Never
      // reuse a cached binding, or automatically retry an old generated reply.
      if (op === 'backup.restore.commit') { this.active = null; this.bindings.clear(); this.#ingress.clear(); }
    }
  }
  async setQqOwner(mapping) {
    if (mapping !== null && (!/^\d{1,20}$/.test(String(mapping.account)) || !/^\d{1,20}$/.test(String(mapping.peer)))) throw new CapabilityError('INVALID_REQUEST', '请输入有效的 QQ 账号与私聊联系人编号。');
    this.semanticWriter?.cancel();
    this.toolHost?.invalidate('OWNER_CHANGED');
    if (this.active) await this.supervisor.raw('lifecycle.retire', this.active);
    this.active = null; this.bindings.clear(); this.#ingress.clear(); this.state.qqOwner = mapping ? { account: String(mapping.account), peer: String(mapping.peer) } : null; this.persist(); return this.status();
  }
  async shareOwner(enabled) {
    if (typeof enabled !== 'boolean') throw new CapabilityError('INVALID_REQUEST', '共享选项必须是布尔值。');
    this.semanticWriter?.cancel();
    this.toolHost?.invalidate('OWNER_SHARING_CHANGED');
    if (this.active) await this.supervisor.raw('lifecycle.retire', this.active);
    this.active = null; this.bindings.clear(); this.#ingress.clear(); this.state.shareOwner = enabled; this.persist(); return this.status();
  }
}
