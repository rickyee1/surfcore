import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const interpreter = process.env.SURFCORE_LOCAL_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(interpreter)) {
  console.error('SERVICE_UNAVAILABLE: isolated Python missing. Install services/local-capabilities/requirements.txt into .venv or set SURFCORE_LOCAL_PYTHON.');
  process.exit(1);
}
const result = spawnSync(interpreter, [path.join(root, 'scripts/test-local-capabilities-service.py')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 120000,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
