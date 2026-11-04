import crypto from 'node:crypto';
import { CapabilityError } from './supervisor.js';

export const LAYERS = Object.freeze(['core', 'daily', 'tone', 'pet', 'qq-private', 'qq-group', 'bili']);
export const MAX_PACKAGE = 192 * 1024 * 1024;
export const EXCLUSIONS = Object.freeze(['keys', 'trusted_registry', 'bindings', 'accounts', 'provider_configuration', 'device_tool_grants', 'root_permissions', 'pending_sends', 'model_exports', 'media_results', 'raw_history', 'recovery_approvals', 'schedulers', 'timers']);
const MAGIC = Buffer.from('SURFCORE-ROLE1\n');
const HEADER = MAGIC.length + 2 + 16 + 12 + 4;
const fail = (code = 'ROLE_PACKAGE_CORRUPT', message = '角色包格式、内容或认证无效。') => new CapabilityError(code, message, '保留原包，核对口令与来源；不会自动恢复旧库。');
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw fail();
  return JSON.stringify(value);
}
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) throw fail();
}
export function id(value) { if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value || '')) throw fail('CHARACTER_ID_CONFLICT', '角色身份无效。'); return value; }
function string(value, max = 1000) { if (typeof value !== 'string' || Buffer.byteLength(value) > max) throw fail(); }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail(); }
function bounded(value, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < 0 || value > max) throw fail(); }
export function validatePurposeReplay(value) {
  exact(value, ['terminals', 'bodyHashes']);
  if (!value.terminals || typeof value.terminals !== 'object' || Array.isArray(value.terminals) || Object.keys(value.terminals).length > 10000 ||
      !Array.isArray(value.bodyHashes) || value.bodyHashes.length > 10000 || new Set(value.bodyHashes).size !== value.bodyHashes.length) throw fail();
  for (const [key, outcome] of Object.entries(value.terminals)) { digest(key); if (!['unknown', 'done', 'consumed'].includes(outcome)) throw fail(); }
  for (const key of value.bodyHashes) digest(key);
  return value;
}
export function mergePurposeReplay(...values) {
  const terminals = {}, bodies = new Set();
  for (const value of values) {
    validatePurposeReplay(value);
    for (const [key, outcome] of Object.entries(value.terminals)) {
      const previous = terminals[key];
      terminals[key] = [previous, outcome].includes('unknown') ? 'unknown' : [previous, outcome].includes('done') ? 'done' : 'consumed';
    }
    for (const key of value.bodyHashes) bodies.add(key);
  }
  return validatePurposeReplay({ terminals, bodyHashes: [...bodies].sort() });
}
export function validatePayload(value) {
  exact(value, ['schema', 'packageId', 'sourceCharacterId', 'sourceRevision', 'persona', 'snapshot', 'platformState', 'assets', 'exclusions']);
  if (value.schema !== 1 || !/^[a-f0-9]{32}$/.test(value.packageId)) throw fail();
  id(value.sourceCharacterId);
  exact(value.sourceRevision, ['roleEpoch', 'personaDigest', 'memoryEpoch', 'attentionRevision']);
  string(value.sourceRevision.roleEpoch, 200); digest(value.sourceRevision.personaDigest);
  bounded(value.sourceRevision.memoryEpoch); bounded(value.sourceRevision.attentionRevision);
  exact(value.persona, LAYERS);
  let total = 0;
  for (const layer of LAYERS) {
    const item = value.persona[layer]; exact(item, ['present', 'bytes', 'sha256', 'text']);
    string(item.text, 65536); digest(item.sha256); bounded(item.bytes, 65536);
    if (typeof item.present !== 'boolean' || !item.present && item.text !== '' || item.bytes !== Buffer.byteLength(item.text) || sha256(item.text) !== item.sha256) throw fail();
    total += item.bytes;
  }
  if (total > 512 * 1024 || sha256(canonical(value.persona)) !== value.sourceRevision.personaDigest) throw fail();
  const snapshot = value.snapshot;
  exact(snapshot, ['characterId', 'manifest', 'bytes', 'sha256', 'data']);
  if (snapshot.characterId !== value.sourceCharacterId) throw fail('CHARACTER_ID_CONFLICT');
  bounded(snapshot.bytes, 128 * 1024 * 1024); digest(snapshot.sha256); string(snapshot.data, 180 * 1024 * 1024);
  const bytes = Buffer.from(snapshot.data, 'base64');
  if (bytes.toString('base64') !== snapshot.data || bytes.length !== snapshot.bytes || sha256(bytes) !== snapshot.sha256) throw fail();
  const manifest = snapshot.manifest;
  exact(manifest, ['format_version', 'backup_id', 'salt', 'kdf', 'lineage', 'created_at', 'counts', 'source_requires_review', 'sha256', 'bytes']);
  if (manifest.sha256 !== snapshot.sha256 || manifest.bytes !== snapshot.bytes || manifest.format_version !== 1 || !/^[a-f0-9]{32}$/.test(manifest.backup_id) || !/^[a-f0-9]{32}$/.test(manifest.salt)) throw fail();
  exact(manifest.kdf, ['name', 'n', 'r', 'p', 'length']);
  if (canonical(manifest.kdf) !== canonical({ name: 'scrypt', n: 16384, r: 8, p: 1, length: 32 })) throw fail();
  exact(manifest.counts, ['memories', 'revisions', 'fingerprints', 'tombstones', 'record_source_revisions', 'episode_consumption']);
  let count = 0; for (const number of Object.values(manifest.counts)) { bounded(number, 50000); count += number; } if (count > 50000) throw fail();
  string(manifest.lineage, 200); if (typeof manifest.source_requires_review !== 'boolean' || !Number.isFinite(manifest.created_at)) throw fail();
  const summaryKeys = ['schema', 'sourceTimezone', 'capturedAt', 'attentionRevision', 'unanswered', 'intensity', 'events'];
  if (Object.hasOwn(value.platformState, 'purpose')) { summaryKeys.push('purpose'); validatePurposeReplay(value.platformState.purpose); }
  exact(value.platformState, summaryKeys);
  const state = value.platformState;
  if (state.schema !== 1 || !['UTC', 'Asia/Shanghai'].includes(state.sourceTimezone) || !Array.isArray(state.events) || state.events.length > 50000) throw fail();
  bounded(state.capturedAt); bounded(state.attentionRevision); bounded(state.unanswered);
  if (!Number.isFinite(state.intensity) || state.intensity < .25 || state.intensity > 1) throw fail();
  const keys = new Set();
  for (const event of state.events) {
    exact(event, ['eventKey', 'dedupeDigest', 'createdUtcMs', 'outcome', 'charged']); digest(event.eventKey); digest(event.dedupeDigest); bounded(event.createdUtcMs);
    if (keys.has(event.eventKey) || !['sent', 'unknown', 'failed'].includes(event.outcome) || typeof event.charged !== 'boolean' || event.charged !== (event.outcome !== 'failed')) throw fail(); keys.add(event.eventKey);
  }
  if (!Array.isArray(value.assets) || value.assets.length > 128) throw fail();
  const names = new Set();
  for (const asset of value.assets) {
    exact(asset, ['name', 'version', 'source', 'license', 'sha256', 'required']);
    for (const field of ['name', 'version', 'source', 'license']) string(asset[field], 1000);
    digest(asset.sha256);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(asset.name) || ['version', 'source', 'license'].some(field => !asset[field].trim()) || names.has(asset.name) || typeof asset.required !== 'boolean') throw fail(); names.add(asset.name);
  }
  if (canonical(value.exclusions) !== canonical(EXCLUSIONS)) throw fail();
  return value;
}
function key(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) throw fail('INVALID_REQUEST', '独立口令需为 12 至 1024 字节。');
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
export function sealPackage(payload, password) {
  validatePayload(payload);
  const plain = Buffer.from(canonical(payload));
  if (plain.length + HEADER + 16 > MAX_PACKAGE) throw fail();
  const head = Buffer.alloc(HEADER); MAGIC.copy(head); head[MAGIC.length] = 1; head[MAGIC.length + 1] = 1;
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  salt.copy(head, MAGIC.length + 2); nonce.copy(head, MAGIC.length + 18); head.writeUInt32BE(plain.length, HEADER - 4);
  const derived = key(password, salt);
  try { const cipher = crypto.createCipheriv('aes-256-gcm', derived, nonce); cipher.setAAD(head); return Buffer.concat([head, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); }
  finally { derived.fill(0); plain.fill(0); }
}
export function openPackage(bytes, password) {
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER + 18 || bytes.length > MAX_PACKAGE || !bytes.subarray(0, MAGIC.length).equals(MAGIC)
    || bytes[MAGIC.length] !== 1 || bytes[MAGIC.length + 1] !== 1 || bytes.readUInt32BE(HEADER - 4) !== bytes.length - HEADER - 16) throw fail();
  const derived = key(password, bytes.subarray(MAGIC.length + 2, MAGIC.length + 18));
  let plain;
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', derived, bytes.subarray(MAGIC.length + 18, MAGIC.length + 30));
    cipher.setAAD(bytes.subarray(0, HEADER)); cipher.setAuthTag(bytes.subarray(-16));
    plain = Buffer.concat([cipher.update(bytes.subarray(HEADER, -16)), cipher.final()]);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    if (!plain.equals(Buffer.from(canonical(value)))) throw fail(); // duplicate keys, odd encodings and noncanonical JSON
    return validatePayload(value);
  } catch { throw fail('ROLE_PACKAGE_AUTH_FAILED', '口令、认证标签或角色包内容无效。'); }
  finally { derived.fill(0); plain?.fill(0); }
}
