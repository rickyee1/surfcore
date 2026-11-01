import fs from 'node:fs';
import { readCurrentCharacter } from './character-persona.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const LOCAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local/local-capabilities');
export const LOCAL_STATE = path.join(LOCAL_ROOT, 'backend.json');
export function localBackendMode() {
  try { const state = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8')); const mode = state.characters?.[readCurrentCharacter()?.id || 'local-test']?.mode || 'legacy'; return ['legacy','shadow','local','paused'].includes(mode) ? mode : 'paused'; }
  catch (e) { return e.code === 'ENOENT' ? 'legacy' : 'paused'; }
}
export function localBackendGuarded() { return ['local','paused'].includes(localBackendMode()); }
