import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const packageArea = (root = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh'), 'surfcore', 'characters')) => path.join(root, '.role-packages');
export function targetMarker(root, id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id || '')) throw Object.assign(new Error('角色标识无效。'), { code: 'CHARACTER_ID_CONFLICT' });
  return path.join(packageArea(root), `blocked-${id}.json`);
}
export function isTargetBlocked(id, root) {
  try { fs.lstatSync(targetMarker(root, id)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; return true; }
}
export function assertTargetReady(id, root) {
  if (isTargetBlocked(id, root)) throw Object.assign(new Error('角色包恢复未核对完成，当前角色暂停。'), { code: 'ROLE_PACKAGE_PAUSED', hint: '打开本机角色包页面检查状态并复审。' });
}
export function captureTargetGate(current, root) {
  if (current?.id) assertTargetReady(current.id, root);
  return Object.freeze({ id: current?.id || null, epoch: current?.epoch ?? null });
}
export function assertTargetGate(captured, current, root) {
  const actual = captureTargetGate(current, root);
  if (!captured || captured.id !== actual.id || captured.epoch !== actual.epoch) throw Object.assign(new Error('原角色或代次已改变，旧任务不能继续。'), { code: 'STALE_CHARACTER', hint: '保持旧任务取消；重新选择当前角色并发起新回合。' });
  return actual;
}
