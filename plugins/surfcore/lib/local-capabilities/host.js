import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilitySupervisor } from './supervisor.js';
import { LocalCapabilities } from './facade.js';
import { createSemanticWriter } from './semantic-writer.js';
import { createToolHost } from './tool-host.js';
import { createMediaHost } from './media-host.js';
import { LOCAL_ROOT, LOCAL_STATE } from '../../../../src/local-capabilities-state.js';
import { readCurrentCharacter } from '../../../../src/character-persona.js';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let singleton;
export function localCapabilities() {
  return singleton ||= new LocalCapabilities({
    supervisor: new CapabilitySupervisor({ python: process.env.SURFCORE_LOCAL_PYTHON || path.join(repo, '.venv', 'Scripts', 'python.exe'), entry: path.join(repo, 'services/local-capabilities/server.py'), dataDir: path.join(LOCAL_ROOT, 'data') }),
    stateFile: LOCAL_STATE,
    currentCharacter: () => { const c = readCurrentCharacter(); return { id: c?.id || 'local-test', epoch: c?.epoch || 0 }; },
  });
}

export function configureSemanticWriter({ ctx, tokenBudget = null }) {
  const local = localCapabilities();
  local.semanticWriter?.dispose();
  local.semanticWriter = createSemanticWriter({ ctx, capabilities: local, tokenBudget });
  return local.semanticWriter;
}

export function configureToolHost(options) {
  const local = localCapabilities(); local.toolHost?.dispose();
  local.toolHost = createToolHost({ ...options, capabilities: local, stateFile: path.join(LOCAL_ROOT, 'tool-host-state.json') });
  return local.toolHost;
}

export function configureMediaHost(options) {
  const local = localCapabilities(); local.mediaHost?.dispose();
  local.mediaHost = createMediaHost({ ...options, capabilities: local });
  return local.mediaHost;
}

export async function disposeLocalCapabilities() { const current = singleton; singleton = null; current?.mediaHost?.dispose(); current?.toolHost?.dispose(); current?.semanticWriter?.dispose(); if (current) await current.supervisor.stop(); }
