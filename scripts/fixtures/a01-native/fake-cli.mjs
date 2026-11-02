// Deterministic factory lifecycle test only. This is never an A01 runtime.
import fs from 'node:fs';
import http from 'node:http';
const c = JSON.parse(fs.readFileSync(process.env.A01_TRIAL_CONFIG, 'utf8'));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = http.createServer((req, res) => {
  const ready = { ready: true, pid: process.pid, observer: true, trialId: c.trialId, repo: c.repo, home: process.env.DSH_HOME, selection: c.selection, node: 'SELF_CHECK_FAKE_NOT_DSH' };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: ready }));
});
server.listen(port, '127.0.0.1');
