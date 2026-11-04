import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CapabilityError } from './supervisor.js';
import { LAYERS, EXCLUSIONS, MAX_PACKAGE, canonical, id, openPackage, sealPackage, sha256, mergePurposeReplay } from './role-package-format.js';
import { packageArea, targetMarker } from '../../../../src/role-package-gate.js';

export const ROLE_PACKAGE_OPS = Object.freeze(['export.prepare', 'export.commit', 'import.inspect', 'import.stage', 'import.commit', 'import.status', 'import.cancel', 'recovery.inspect', 'recovery.commit', 'review', 'diagnostics'].map(name => `role.package.${name}`));
const FILENAMES = Object.freeze({ core: 'persona.md', daily: 'persona.daily.md', tone: 'persona.tone.md', pet: 'persona.scenes/pet.md', 'qq-private': 'persona.scenes/qq-private.md', 'qq-group': 'persona.scenes/qq-group.md', bili: 'persona.scenes/bili.md' });
const PARAMETERS = { 'export.prepare':'password assets', 'export.commit':'package_id package_digest expected_revision confirmation_digest', 'import.inspect':'package_id password mode', 'import.stage':'inspection_id password package_digest expected_target_revision', 'import.commit':'operation_id expected_revision confirmation_digest', 'import.status':'operation_id', 'import.cancel':'operation_id expected_revision', 'recovery.inspect':'operation_id', 'recovery.commit':'operation_id expected_revision package_digest confirmation_digest', review:'operation_id expected_revision review_digest', diagnostics:'' };
const error = (code, message, hint = '保留文件和暂停状态，刷新核对后重新明确确认。') => new CapabilityError(code, message, hint);
const opaque = value => { if (!/^[0-9a-f]{32}$/.test(value || '')) throw error('INVALID_REQUEST', '只接受本机生成的角色包 ID。'); return value; };
function privatePath(file) {
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().split(',').at(-1).replaceAll('"', '');
    const rights = fs.statSync(file).isDirectory() ? '(OI)(CI)(F)' : '(F)';
    try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:${rights}`, `*S-1-5-18:${rights}`], { stdio: 'ignore', windowsHide: true }); }
    catch { throw error('PERMISSION_DENIED', '角色包暂存区权限无法限制。'); }
  } else fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o700 : 0o600);
}
function safe(file, directory = false, maximum = MAX_PACKAGE) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > maximum)) throw error('PERMISSION_DENIED', '角色包路径不能为链接、重解析点或多重链接。');
  return info;
}
function parents(file) {
  let current = path.resolve(file);
  for (;;) { safe(current, true); const next = path.dirname(current); if (next === current) break; current = next; }
}
function mkdir(directory) { const existed = fs.existsSync(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); parents(directory); if (!existed) privatePath(directory); }
function atomic(file, data, exclusive = false) {
  parents(path.dirname(file));
  if (fs.existsSync(file)) safe(file);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { privatePath(temp); fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (exclusive) { try { fs.linkSync(temp, file); } finally { fs.unlinkSync(temp); } }
  else fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  safe(file, false, 1024 * 1024); return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Fixed host coordinator. No raw Python op, path, identity override or factory is exposed to browser callers. */
export function createRolePackages({ capabilities, charactersRoot, purposeStateDir = capabilities.stateFile ? path.join(path.dirname(capabilities.stateFile), 'companion') : null, clock = Date.now, assetAvailable = () => false, fault = () => {} }) {
  const root = path.resolve(charactersRoot), area = packageArea(root);
  const initialize = () => { mkdir(root); mkdir(area); };
  let token, generation, serial = Promise.resolve();
  const file = (identifier, suffix) => path.join(area, `${opaque(identifier)}.${suffix}`);
  const writeJson = (where, value, exclusive = false) => atomic(where, Buffer.from(canonical(value)), exclusive);
  async function internal(op, params) {
    await capabilities.supervisor.start();
    if (generation !== capabilities.supervisor.generation || !token) {
      token = (await capabilities.supervisor.raw('portable.coordinator.open', {})).coordinator_token;
      generation = capabilities.supervisor.generation;
    }
    return capabilities.supervisor.raw(`portable.${op}`, { portable_coordinator: token }, params);
  }
  function rolePaths(character) {
    id(character); const directory = path.join(root, character);
    if (fs.existsSync(directory)) parents(directory);
    return { directory, manifest: path.join(directory, 'character.json') };
  }
  function persona(directory) {
    const value = {};
    for (const layer of LAYERS) {
      const where = path.join(directory, FILENAMES[layer]);
      let text = '', present = false;
      if (fs.existsSync(where)) { parents(path.dirname(where)); safe(where, false, 65536); text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(where)); present = true; }
      value[layer] = { present, text, bytes: Buffer.byteLength(text), sha256: sha256(text) };
    }
    return value;
  }
  function purposeState(character) {
    if (!purposeStateDir) return { terminals: {}, bodyHashes: [] };
    const name = sha256(character).slice(0, 24) + '.state.json', where = path.join(purposeStateDir, name);
    if (!fs.existsSync(where)) return { terminals: {}, bodyHashes: [] };
    parents(path.dirname(where)); safe(where, false, 4 * 1024 * 1024);
    const state = JSON.parse(fs.readFileSync(where, 'utf8'));
    if (state.purpose?.version !== 'governed-purpose-v1') return { terminals: {}, bodyHashes: [] };
    const replay = mergePurposeReplay({ terminals: state.purpose.terminals || {}, bodyHashes: state.bodyHashes || [] },
      { terminals: state.purpose.transferTerminals || {}, bodyHashes: [] });
    const receipts = {};
    // A transferred package never resumes a source machine's pending work.
    for (const row of state.purpose.receipts || []) if (row.terminalKey && ['sent', 'unknown'].includes(row.outcome))
      receipts[row.terminalKey] = row.outcome === 'unknown' ? 'unknown' : 'consumed';
    return mergePurposeReplay(replay, { terminals: receipts, bodyHashes: [] });
  }
  function filesystem(character) {
    const paths = rolePaths(character), value = persona(paths.directory);
    const manifest = readJson(paths.manifest, null), current = capabilities.currentCharacter();
    const index = readJson(path.join(root, 'index.json'), { characters: [] });
    if (!Array.isArray(index.characters)) throw error('ROLE_PACKAGE_CORRUPT', '角色索引格式损坏。');
    const entries = index.characters.filter(item => item.id === character);
    if (entries.length > 1) throw error('CHARACTER_ID_CONFLICT', '角色索引包含重复身份。');
    return { exists: !!manifest, indexExists: entries.length > 0, indexDigest: sha256(canonical(entries)), roleEpoch: current?.id === character ? String(current.epoch) : String(manifest?.updatedAt || ''),
      purposeDigest: sha256(canonical(purposeState(character))), personaDigest: sha256(canonical(value)), manifestDigest: sha256(canonical(manifest)), persona: value };
  }
  function fsFence(value) { return { purposeDigest: value.purposeDigest, exists: value.exists, indexExists: value.indexExists, indexDigest: value.indexDigest, roleEpoch: value.roleEpoch, personaDigest: value.personaDigest, manifestDigest: value.manifestDigest }; }
  function source() { const current = capabilities.currentCharacter(); if (!current?.id) throw error('NOT_FOUND', '没有当前角色。'); return id(current.id); }
  async function sourceFence(character) {
    const before = filesystem(character), db = await internal('fence', { character_id: character }), after = filesystem(character);
    if (canonical(fsFence(before)) !== canonical(fsFence(after)) || source() !== character) throw error('VERSION_CONFLICT', '读取过程中源角色发生变化。');
    return { ...fsFence(after), memoryEpoch: db.memory_epoch, attentionRevision: db.attention_revision };
  }
  function ownedBackup(manifest, data) {
    const directory = path.join(path.resolve(capabilities.supervisor.dataDir), 'backups'); mkdir(directory);
    const backup = path.join(directory, `${opaque(manifest.backup_id)}.db`), meta = path.join(directory, `${manifest.backup_id}.json`);
    if (fs.existsSync(backup) || fs.existsSync(meta)) {
      if (!fs.existsSync(backup) || !fs.existsSync(meta)) throw error('VERSION_CONFLICT', '内层快照 ID 已有不完整文件。');
      safe(backup); safe(meta);
      if (sha256(fs.readFileSync(backup)) !== manifest.sha256 || canonical(readJson(meta)) !== canonical(manifest)) throw error('VERSION_CONFLICT', '内层快照 ID 已有不同内容。');
    } else { atomic(backup, data, true); writeJson(meta, manifest, true); }
  }
  async function createSealed(character, password, assets) {
    const before = await sourceFence(character), layers = filesystem(character).persona;
    const captured = await internal('capture', { character_id: character, password });
    const manifest = captured.snapshot.manifest;
    const directory = path.join(capabilities.supervisor.dataDir, 'backups'); parents(directory);
    const dbfile = path.join(directory, `${opaque(manifest.backup_id)}.db`); safe(dbfile);
    const data = fs.readFileSync(dbfile);
    const summaryFile = path.join(capabilities.supervisor.dataDir, 'portable-inputs', `${opaque(captured.attention_id)}.json`);
    parents(path.dirname(summaryFile)); safe(summaryFile, false, 16 * 1024 * 1024);
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    summary.purpose = mergePurposeReplay(summary.purpose || { terminals: {}, bodyHashes: [] }, purposeState(character));
    const payload = { schema: 1, packageId: crypto.randomBytes(16).toString('hex'), sourceCharacterId: character,
      sourceRevision: { roleEpoch: before.roleEpoch, personaDigest: before.personaDigest, memoryEpoch: captured.memory_epoch, attentionRevision: captured.attention_revision },
      persona: layers, snapshot: { characterId: character, manifest, bytes: data.length, sha256: sha256(data), data: data.toString('base64') }, platformState: summary, assets, exclusions: EXCLUSIONS };
    const sealed = sealPackage(payload, password), after = await sourceFence(character);
    if (canonical(before) !== canonical(after) || captured.memory_epoch !== before.memoryEpoch || captured.attention_revision !== before.attentionRevision) throw error('VERSION_CONFLICT', '导出期间角色、记忆或主动账目已变化。');
    return { sealed, payload, revision: sha256(canonical(after)) };
  }
  function confirmation(value) { return sha256(canonical(value)); }
  function approval(row, params, expectedField = 'expected_revision') {
    if (clock() >= row.expires || params[expectedField] !== row.revision || params.confirmation_digest !== row.confirmation_digest) throw error('VERSION_CONFLICT', '核对版本、摘要或有效期已变化。');
  }
  function operation(identifier) { const row = readJson(file(identifier, 'journal')); if (!row) throw error('NOT_FOUND', '角色包操作不存在。'); return row; }
  function save(row) { writeJson(file(row.operation_id, 'journal'), row); return row; }
  function marker(row, create = false) {
    const where = targetMarker(root, row.target_id);
    if (create) { writeJson(where, { operation_id: row.operation_id, package_digest: row.package_digest, target_id: row.target_id }, true); return; }
    const value = readJson(where);
    if (!value || value.operation_id !== row.operation_id || value.package_digest !== row.package_digest) throw error('VERSION_CONFLICT', '角色暂停标记不属于当前操作。');
  }
  function release(row) { marker(row); fs.unlinkSync(targetMarker(root, row.target_id)); }
  function install(row) {
    const stage = path.join(area, row.operation_id), target = rolePaths(row.target_id).directory;
    parents(stage); mkdir(target);
    const incoming = persona(stage);
    if (sha256(canonical(incoming)) !== row.persona_digest) throw error('ROLE_PACKAGE_CORRUPT', '隔离人格文件已改变。');
    for (const layer of LAYERS) {
      const where = path.join(target, FILENAMES[layer]); mkdir(path.dirname(where));
      if (incoming[layer].present) atomic(where, Buffer.from(incoming[layer].text));
      else if (fs.existsSync(where)) { safe(where); fs.unlinkSync(where); }
    }
  }
  function publish(row) {
    const paths = rolePaths(row.target_id), previous = readJson(paths.manifest, null);
    const now = new Date(clock()).toISOString();
    const manifest = { ...(previous || { version: 1, id: row.target_id, name: row.target_id, createdAt: now, source: 'role-package' }), updatedAt: now, packageDigest: row.package_digest };
    writeJson(paths.manifest, manifest);
    const indexFile = path.join(root, 'index.json'), index = readJson(indexFile, { version: 1, characters: [] });
    if (!Array.isArray(index.characters)) throw error('ROLE_PACKAGE_CORRUPT', '角色索引格式损坏。');
    writeJson(indexFile, { ...index, characters: [...index.characters.filter(item => item.id !== row.target_id), manifest] });
    const currentFile = path.join(root, 'current.json'), current = readJson(currentFile, null);
    if (current?.id === row.target_id && current.packageOperation !== row.operation_id) {
      writeJson(currentFile, { ...current, epoch: Number(current.epoch || 0) + 1, switchedAt: now, packageOperation: row.operation_id });
    }
  }
  async function status(row) {
    const db = await internal('status', { operation_id: row.operation_id });
    return { ...db, phase: row.phase, prechange_backup_id: row.prechange_backup_id, uncertainty: row.phase !== 'complete',
      next_action: db.receipt ? '核对已提交人格与数据库并复审；不能重放快照。' : '目标保持暂停，检查后明确继续。',
      revision: row.revision, db_revision: db.revision, persona_matches: filesystem(row.target_id).personaDigest === row.persona_digest };
  }
  async function continueOperation(row) {
    marker(row);
    let db = await internal('status', { operation_id: row.operation_id });
    if (db.status === 'staged') {
      // Fence is checked again after durable marker and immediately before begin.
      if (canonical(fsFence(filesystem(row.target_id))) !== canonical(row.target_fs)) throw error('VERSION_CONFLICT', '开始前目标人格或代次发生变化。');
      if (clock() >= row.expires) throw error('VERSION_CONFLICT', '等待核验时原始确认已过期。', '目标保持暂停；重新检查本次恢复并明确确认。');
      capabilities.semanticWriter?.cancel(); capabilities.toolHost?.invalidate('ROLE_PACKAGE_PAUSED');
      db = await internal('begin', { operation_id: row.operation_id, expected_revision: db.revision, approval_expires_at: row.expires });
      if (capabilities.store && capabilities.persist) {
        capabilities.store.characters ||= {};
        capabilities.store.characters[row.target_id] = { ...(capabilities.store.characters[row.target_id] || {}), mode: 'paused', written: true, shareOwner: false, qqOwner: null };
        capabilities.persist();
      }
      capabilities.active = null; capabilities.bindings?.clear();
    }
    row.phase = 'blocked'; save(row); fault('after_begin');
    if (!db.receipt) { install(row); row.phase = 'persona_installed'; save(row); fault('after_persona');
      db = await internal('commit', { operation_id: row.operation_id, expected_revision: db.revision }); }
    else if (filesystem(row.target_id).personaDigest !== row.persona_digest) throw error('VERSION_CONFLICT', '数据库已提交但人格有不同写入。', '保持暂停并人工核对，不能覆盖合法新内容。');
    row.phase = 'db_committed'; save(row); fault('after_db');
    publish(row); row.phase = 'published_paused'; save(row); fault('after_publish');
    db = await internal('publish', { operation_id: row.operation_id, expected_revision: db.revision, persona_digest: row.persona_digest });
    row.revision++; row.expires = clock() + 300000; row.confirmation_digest = confirmation({ operation: row.operation_id, package: row.package_digest, revision: row.revision }); save(row);
    return status(row);
  }
  async function dispatch(op, params = {}) {
    if (!ROLE_PACKAGE_OPS.includes(op)) throw error('PERMISSION_DENIED', '角色包操作未开放。');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw error('INVALID_REQUEST', '请求字段无效。');
    const allowed = PARAMETERS[op.slice('role.package.'.length)].split(' ').filter(Boolean);
    if (Object.keys(params).some(key => !allowed.includes(key)) || allowed.some(key => !(key in params))) throw error('INVALID_REQUEST', '角色包请求字段集合不匹配。');
    if (op === 'role.package.diagnostics') return { schema: 1, owned_area_exists: fs.existsSync(area), layers: 7,
      service: capabilities.supervisor.child ? await internal('diagnostics', {}) : { status: 'stopped', python_available: fs.existsSync(capabilities.supervisor.python), entry_available: fs.existsSync(capabilities.supervisor.entry) }, deployment: 'NOT_VERIFIED', no_credentials: true, no_downloads: true };
    initialize();
    if (op === 'role.package.export.prepare') {
      const value = await createSealed(source(), params.password, params.assets || []), identifier = value.payload.packageId, digest = sha256(value.sealed);
      atomic(file(identifier, 'scrole'), value.sealed, true);
      const row = { package_id: identifier, package_digest: digest, target_id: value.payload.sourceCharacterId, revision: value.revision, expires: clock() + 300000, approved: false };
      row.confirmation_digest = confirmation(row); writeJson(file(identifier, 'export'), row, true);
      return { ...row, manifest: { persona_hashes: Object.fromEntries(LAYERS.map(layer => [layer, value.payload.persona[layer].sha256])), counts: value.payload.snapshot.manifest.counts, exclusions: EXCLUSIONS, assets: value.payload.assets } };
    }
    if (op === 'role.package.export.commit') {
      const row = readJson(file(params.package_id, 'export')); if (!row) throw error('NOT_FOUND', '导出核对不存在。');
      approval(row, params);
      if (params.package_digest !== row.package_digest || sha256(canonical(await sourceFence(row.target_id))) !== row.revision) throw error('VERSION_CONFLICT', '源角色或封存摘要已变化。');
      approval(row,params);
      safe(file(row.package_id, 'scrole')); if (sha256(fs.readFileSync(file(row.package_id, 'scrole'))) !== row.package_digest) throw error('ROLE_PACKAGE_CORRUPT', '封存文件已变化。');
      row.approved = true; writeJson(file(row.package_id, 'export'), row); return row;
    }
    if (op === 'role.package.import.inspect') {
      safe(file(params.package_id, 'scrole')); const bytes = fs.readFileSync(file(params.package_id, 'scrole')), payload = openPackage(bytes, params.password);
      const target = payload.sourceCharacterId, state = filesystem(target);
      const receipt = await internal('receipt', { target_character_id: target, package_digest: sha256(bytes) });
      if (receipt.found) return { ...receipt, duplicate: true, next_action: '相同目标与角色包已有永久回执；只查询和复审，不再应用。' };
      if (!['new', 'restore_same_id'].includes(params.mode) || state.exists !== (params.mode === 'restore_same_id') || !state.exists && (state.indexExists || fs.existsSync(rolePaths(target).directory))) throw error('CHARACTER_ID_CONFLICT', '角色目录/索引/清单与导入方式冲突。');
      ownedBackup(payload.snapshot.manifest, Buffer.from(payload.snapshot.data, 'base64'));
      const db = await internal('inspect', { backup_id: payload.snapshot.manifest.backup_id, password: params.password, target_character_id: target, mode: params.mode });
      const inspection = crypto.randomBytes(16).toString('hex'), targetRevision = sha256(canonical({ fs: fsFence(state), memory: db.memory_epoch, ledger: db.ledger_instance }));
      const row = { inspection_id: inspection, package_id: params.package_id, package_digest: sha256(bytes), target_id: target, mode: params.mode, target_fs: fsFence(state), memory_epoch: db.memory_epoch, ledger_instance: db.ledger_instance, target_revision: targetRevision, expires: clock() + 300000 };
      writeJson(file(inspection, 'inspection'), row, true);
      return { ...row, counts: db.counts, scopes: db.scopes, unavailable_scopes: db.scopes.filter(scope => scope.startsWith('qq:')), requires_review: true, persona_hashes: Object.fromEntries(LAYERS.map(layer => [layer, payload.persona[layer].sha256])), assets: payload.assets.map(asset => ({ ...asset, available: !!assetAvailable(asset) })), exclusions: EXCLUSIONS, proactive: 'off' };
    }
    if (op === 'role.package.import.stage') {
      const view = readJson(file(params.inspection_id, 'inspection')); if (!view || clock() >= view.expires || params.package_digest !== view.package_digest || params.expected_target_revision !== view.target_revision || canonical(fsFence(filesystem(view.target_id))) !== canonical(view.target_fs)) throw error('VERSION_CONFLICT', '预览或目标版本已变化。');
      safe(file(view.package_id, 'scrole')); const bytes = fs.readFileSync(file(view.package_id, 'scrole'));
      if (sha256(bytes) !== view.package_digest) throw error('ROLE_PACKAGE_CORRUPT', '角色包在预览后发生变化。');
      const payload = openPackage(bytes, params.password);
      if (payload.assets.some(asset => asset.required && !assetAvailable(asset))) throw error('ASSET_UNAVAILABLE', '所需资产尚未在本机安装。', '核对来源、许可和哈希；不会自动下载。');
      const identifier = crypto.randomBytes(16).toString('hex'); let backupId = null;
      if (view.target_fs.exists) {
        // Same-ID export reads this target; do not switch another active role to obtain it.
        if (source() !== view.target_id) throw error('STALE_CHARACTER', '现有角色恢复前请先选择该角色并重新预览。');
        const backup = await createSealed(view.target_id, params.password, []); backupId = crypto.randomBytes(16).toString('hex'); atomic(file(backupId, 'prechange.scrole'), backup.sealed, true);
      }
      const summaryDirectory = path.join(capabilities.supervisor.dataDir, 'portable-inputs'); mkdir(summaryDirectory);
      const summaryId = crypto.randomBytes(16).toString('hex'); writeJson(path.join(summaryDirectory, `${summaryId}.json`), payload.platformState, true);
      const staged = await internal('stage', { operation_id: identifier, package_digest: view.package_digest, backup_id: payload.snapshot.manifest.backup_id, password: params.password, target_character_id: view.target_id, mode: view.mode, expected_memory_epoch: view.memory_epoch, persona_digest: payload.sourceRevision.personaDigest, attention_id: summaryId });
      if (staged.duplicate) return { ...staged, duplicate: true };
      const stage = path.join(area, identifier); mkdir(stage);
      for (const layer of LAYERS) if (payload.persona[layer].present) { const where = path.join(stage, FILENAMES[layer]); mkdir(path.dirname(where)); atomic(where, Buffer.from(payload.persona[layer].text), true); }
      const row = { operation_id: identifier, target_id: view.target_id, package_digest: view.package_digest, mode: view.mode, target_fs: view.target_fs, persona_digest: payload.sourceRevision.personaDigest, prechange_backup_id: backupId, phase: 'staged', revision: 1, expires: clock() + 300000 };
      row.confirmation_digest = confirmation(row); save(row); return { ...row, proactive: 'off', requires_review: true };
    }
    const row = operation(params.operation_id);
    if (op === 'role.package.import.status') return status(row);
    if (op === 'role.package.recovery.inspect') {
      const current = await status(row); row.revision++; row.expires = clock() + 300000;
      row.confirmation_digest = confirmation({ operation: row.operation_id, package: row.package_digest, revision: row.revision, db: current.receipt, persona: filesystem(row.target_id).personaDigest }); save(row);
      return { ...current, revision: row.revision, expires: row.expires, confirmation_digest: row.confirmation_digest };
    }
    if (op === 'role.package.import.cancel') {
      if (params.expected_revision !== row.revision) throw error('VERSION_CONFLICT', '取消核对版本已改变。');
      const db = await internal('status', { operation_id: row.operation_id });
      const result = await internal('cancel', { operation_id: row.operation_id, expected_revision: db.revision });
      if (db.status === 'staged' || db.status === 'cancelled') {
        const ownedMarker = readJson(targetMarker(root, row.target_id), null);
        if (ownedMarker?.operation_id === row.operation_id) release(row);
        row.phase = 'cancelled';
      }
      save(row); return { ...result, phase: row.phase };
    }
    if (op === 'role.package.review') {
      if (params.expected_revision !== row.revision || filesystem(row.target_id).personaDigest !== row.persona_digest) throw error('VERSION_CONFLICT', '复审人格或操作版本已变化。');
      marker(row); const db = await internal('status', { operation_id: row.operation_id });
      const result = db.status === 'complete' ? db : await internal('review', { operation_id: row.operation_id, expected_revision: db.revision, persona_digest: row.persona_digest, review_digest: params.review_digest });
      release(row); row.phase = 'complete'; row.revision++; save(row); return result;
    }
    if (op === 'role.package.import.commit' || op === 'role.package.recovery.commit') {
      approval(row, params);
      if (op.endsWith('recovery.commit') && params.package_digest !== row.package_digest) throw error('VERSION_CONFLICT', '恢复包摘要不一致。');
      if (op === 'role.package.import.commit') { if (row.phase !== 'staged') throw error('VERSION_CONFLICT', '提交结果不明确时只能查询状态。'); marker(row, true); }
      return continueOperation(row);
    }
    throw error('PERMISSION_DENIED', '角色包操作未开放。');
  }
  return {
    dispatch(op, params) { const pending = serial.then(() => dispatch(op, params)); serial = pending.catch(() => {}); return pending; },
    async upload(req) {
      initialize();
      let size = 0; const chunks = []; req.setTimeout?.(30000, () => req.destroy());
      for await (const chunk of req) { size += chunk.length; if (size > MAX_PACKAGE) throw error('INVALID_REQUEST', '角色包超过 192 MiB。'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), identifier = crypto.randomBytes(16).toString('hex');
      if (!size) throw error('INVALID_REQUEST', '角色包为空。'); atomic(file(identifier, 'scrole'), bytes, true);
      return { package_id: identifier, package_digest: sha256(bytes), inspected: false };
    },
    download(_req, res, params) {
      initialize();
      const row = readJson(file(params.package_id, 'export'));
      if (!row?.approved || row.package_digest !== params.package_digest) throw error('PERMISSION_DENIED', '此封存角色包尚未批准下载。');
      const where = file(row.package_id, 'scrole'); safe(where); const bytes = fs.readFileSync(where);
      if (sha256(bytes) !== row.package_digest) throw error('ROLE_PACKAGE_CORRUPT', '封存角色包已变化。');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': bytes.length, 'content-disposition': `attachment; filename="${row.package_id}.scrole"` }); res.end(bytes);
    },
  };
}
