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
for (const script of ['test-local-capabilities-service.py', 'test-local-capabilities-service-backend.py', 'test-local-capabilities-tools.py', 'test-local-capabilities-semantic.py', 'test-local-capabilities-media.py', 'test-role-package.py']) {
  const result = spawnSync(interpreter, [path.join(root, 'scripts', script)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 120000,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
