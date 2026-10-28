import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimaler .env-Loader (keine Abhängigkeit). Bereits gesetzte Variablen gewinnen. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function loadConfig(env = process.env) {
  loadDotEnv(path.join(ROOT, '.env'));
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const token = env.RUNDOWN_TOKEN || '';
  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    tlsCert: env.TLS_CERT || '',
    tlsKey: env.TLS_KEY || '',
    accessKey: env.ACCESS_KEY || '',
    giphyApiKey: env.GIPHY_API_KEY || '',
    mode: env.MODE || (token ? 'live' : 'replay'),
    rundownBaseUrl: (env.RUNDOWN_BASE_URL || 'https://rundown.ffverwaltung.de').replace(/\/+$/, ''),
    rundownToken: token,
    pollCurrentMs: num(env.POLL_CURRENT_MS, 500),
    pollFullMs: num(env.POLL_FULL_MS, 15000),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 2500),
    staleAfterMs: num(env.STALE_AFTER_MS, 3000),
    cueStartSource: env.CUE_START_SOURCE || 'auto',
    timeZone: env.TIME_ZONE || 'Europe/Berlin',
    replayFile: path.resolve(ROOT, env.REPLAY_FILE || 'fixtures/ff-offline-finale-2026.json'),
    replaySpeed: num(env.REPLAY_SPEED, 1),
    replayStartCue: num(env.REPLAY_START_CUE, 1),
    replayJitter: num(env.REPLAY_JITTER, 0.15),
    replayStartOffsetS: num(env.REPLAY_START_OFFSET, 0),
    replayHold: env.REPLAY_HOLD === '1' || env.REPLAY_HOLD === 'true',
    dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
    cueKindsFile: path.join(ROOT, 'config', 'cue-kinds.json'),
    scenariosFile: path.join(ROOT, 'config', 'scenarios.json'),
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
