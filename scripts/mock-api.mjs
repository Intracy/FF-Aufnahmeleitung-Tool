// Nachbau der Rundown-API für Tests ohne echte Show.
// Liefert /api/public/rundown/current und /full aus dem Replay.
// Aufruf: MOCK_PORT=9090 REPLAY_START_CUE=119 npm run mock-api
//   dann: MODE=live RUNDOWN_BASE_URL=http://localhost:9090 RUNDOWN_TOKEN=test npm start

import http from 'node:http';
import path from 'node:path';
import { loadConfig, readJson } from '../server/config.js';
import { compileKindConfig } from '../server/model.js';
import { ReplaySource } from '../server/sources/replay.js';

const cfg = loadConfig();
const port = Number(process.env.MOCK_PORT || 9090);
const token = process.env.MOCK_TOKEN || 'test';
const kindConfig = compileKindConfig(readJson(cfg.cueKindsFile));
const src = new ReplaySource({ ...cfg, replayFile: path.resolve(cfg.root, process.env.REPLAY_FILE || cfg.replayFile) }, { kindConfig });

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const kind = url.pathname.match(/^\/api\/public\/rundown\/(current|full)$/)?.[1];
    if (!kind) return res.writeHead(404).end();
    if (url.searchParams.get('token') !== token) return res.writeHead(401).end('{"error":"invalid token"}');
    const body = kind === 'current' ? src.currentPayload() : src.fullPayload();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  })
  .listen(port, () => console.log(`Mock-API auf http://localhost:${port} (Token "${token}")`));
