import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { CapabilityError } from './supervisor.js';

// A transport envelope around the existing encrypted DB and authenticated manifest.
// Importing this envelope never activates its contents or registers trusted lineage.
const MAGIC = Buffer.from('SURFCORE-MEMORY1\n');
const MAX_DB = 128 * 1024 * 1024;
const MAX_MANIFEST = 64000;
const fail = (code, message, hint = '选择由本地记忆页面下载的完整加密备份。活动记忆没有改变。') => new CapabilityError(code, message, hint);

function manifestValue(value) {
  const kdf = value?.kdf;
  const validKdf = kdf?.name === 'scrypt' && kdf.n === 16384 && kdf.r === 8 && kdf.p === 1 && kdf.length === 32 && Object.keys(kdf).length === 5;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format_version !== 1 || !/^[a-f0-9]{32}$/.test(value.backup_id)
    || !/^[a-f0-9]{64}$/.test(value.sha256) || !/^[a-f0-9]{32}$/.test(value.salt)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 4096 || value.bytes > MAX_DB
    || !validKdf) {
    throw fail('BACKUP_CORRUPT', '加密备份头部无效。');
  }
  return value;
}

export function createBackupTransfer({ capabilities }) {
  function area() {
    const root = path.resolve(capabilities.supervisor.dataDir);
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) throw fail('PERMISSION_DENIED', '本地数据目录不可用。');
    const directory = path.join(root, 'backups');
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()
      || path.relative(fs.realpathSync(root), fs.realpathSync(directory)) !== 'backups') throw fail('PERMISSION_DENIED', '备份目录不允许链接或越界。');
    return directory;
  }
  function regular(file, max) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw fail('PERMISSION_DENIED', '备份文件类型或大小不受支持。');
    return info;
  }
  function identity() { return JSON.stringify(capabilities.currentCharacter()); }
  function current(expected) {
    if (capabilities.mode !== 'local' || identity() !== expected) throw fail('STALE_CHARACTER', '角色或后端已变化，文件操作已取消。');
  }

  async function download(req, res, params) {
    const expected = identity(); current(expected);
    // The Python authority verifies password, ciphertext, structure and active role.
    await capabilities.management('backup.inspect', { backup_id: params.backup_id, password: params.password, limit: 1 });
    current(expected);
    const directory = area();
    if (!/^[a-f0-9]{32}$/.test(params.backup_id)) throw fail('INVALID_REQUEST', '备份 ID 无效。');
    const file = path.join(directory, `${params.backup_id}.db`);
    const meta = path.join(directory, `${params.backup_id}.json`);
    regular(meta, MAX_MANIFEST); const data = fs.readFileSync(meta);
    const value = manifestValue(JSON.parse(data));
    if (value.backup_id !== params.backup_id || regular(file, MAX_DB).size !== value.bytes) throw fail('BACKUP_CORRUPT', '备份文件在验证后发生变化。');
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-length': MAGIC.length + 4 + data.length + value.bytes,
      'content-disposition': `attachment; filename="${value.backup_id}.scmemory"` });
    res.write(MAGIC); res.write(size); res.write(data);
    await pipeline(fs.createReadStream(file), res);
  }

  async function upload(req) {
    const expected = identity(); current(expected);
    await capabilities.binding({ kind: 'management' }); current(expected);
    const directory = area();
    const temp = path.join(directory, `upload-${crypto.randomUUID()}.tmp`);
    let fd = null, head = Buffer.alloc(0), value = null, manifestBytes = null, count = 0, total = 0;
    const hash = crypto.createHash('sha256');
    req.setTimeout?.(30000, () => req.destroy());
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_DB + MAX_MANIFEST + MAGIC.length + 4) throw fail('INVALID_REQUEST', '加密备份超过 128 MiB 限制。');
        let bytes = chunk;
        if (!value) {
          head = Buffer.concat([head, bytes]);
          if (head.length < MAGIC.length + 4) continue;
          if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('BACKUP_CORRUPT', '这不是 SurfCore 加密备份。');
          const length = head.readUInt32BE(MAGIC.length);
          if (length < 2 || length > MAX_MANIFEST) throw fail('BACKUP_CORRUPT', '备份清单大小无效。');
          const end = MAGIC.length + 4 + length;
          if (head.length < end) continue;
          manifestBytes = Buffer.from(head.subarray(MAGIC.length + 4, end));
          try { value = manifestValue(JSON.parse(manifestBytes.toString('utf8'))); }
          catch (e) { if (e instanceof CapabilityError) throw e; throw fail('BACKUP_CORRUPT', '备份清单无法读取。'); }
          bytes = head.subarray(end); head = Buffer.alloc(0);
          fd = fs.openSync(temp, 'wx', 0o600);
        }
        count += bytes.length;
        if (count > value.bytes) throw fail('BACKUP_CORRUPT', '备份密文超出清单长度。');
        hash.update(bytes);
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw fail('SERVICE_UNAVAILABLE', '备份写入未完成。');
          offset += written;
        }
      }
      if (!value || count !== value.bytes || hash.digest('hex') !== value.sha256) throw fail('BACKUP_CORRUPT', '备份不完整或密文哈希不匹配。');
      fs.fsyncSync(fd); fs.closeSync(fd); fd = null; current(expected);
      const file = path.join(directory, `${value.backup_id}.db`), meta = path.join(directory, `${value.backup_id}.json`);
      if (fs.existsSync(file) || fs.existsSync(meta)) {
        if (!fs.existsSync(file) || !fs.existsSync(meta)) throw fail('VERSION_CONFLICT', '这个备份 ID 已存在不完整文件。', '保留现有文件，选择另一份完整备份；不会覆盖。');
        regular(meta, MAX_MANIFEST); regular(file, MAX_DB);
        const old = fs.readFileSync(meta);
        const oldHash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) oldHash.update(chunk);
        current(expected);
        if (!old.equals(manifestBytes) || oldHash.digest('hex') !== value.sha256) throw fail('VERSION_CONFLICT', '这个备份 ID 已存在不同内容。');
        return { backup_id: value.backup_id, duplicate: true, active_unchanged: true, inspected: false };
      }
      // Exclusive creation prevents an upload from overwriting a local registered backup.
      fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(meta, manifestBytes, { flag: 'wx', mode: 0o600 });
      return { backup_id: value.backup_id, imported: true, active_unchanged: true, inspected: false };
    } finally {
      if (fd !== null) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  return { download, upload };
}
