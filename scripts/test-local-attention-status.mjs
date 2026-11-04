import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const result = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'scripts/test-local-attention-status.py')],
  { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 60000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
