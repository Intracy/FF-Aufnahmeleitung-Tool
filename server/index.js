import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig, readJson } from './config.js';
import { compileKindConfig } from './model.js';
import { Relay } from './relay.js';
import { LiveSource } from './sources/live.js';
import { ReplaySource } from './sources/replay.js';
import { reportCsv, markersEdl } from './exports.js';
import { loadSourceSettings, saveSourceSettings, cleanHosts, tokenHint, tokenLooksValid } from './source-settings.js';

const cfg = loadConfig();
const pkg = readJson(path.join(cfg.root, 'package.json'));

// Auf der Startseite gesetzter Token / Moderationsliste haben Vorrang vor .env
const stored = loadSourceSettings(cfg.dataDir);
if (stored.token) {
  cfg.rundownToken = stored.token;
  cfg.tokenFrom = 'ui';
  cfg.mode = 'live';
}
if (stored.hosts) cfg.hosts = stored.hosts;
if (stored.guests) cfg.guests = stored.guests;

if (cfg.mode === 'live' && !cfg.rundownToken) {
  console.error('MODE=live braucht RUNDOWN_TOKEN (siehe .env.example) oder einen Token von der Startseite. Für einen Test ohne Show: MODE=replay.');
  process.exit(1);
}

const kindConfig = compileKindConfig(readJson(cfg.cueKindsFile));
const groups = readJson(cfg.scenariosFile).groups || [];

let relay;
let source =
  cfg.mode === 'replay' ? new ReplaySource(cfg, { kindConfig, getJumps: () => relay.jumps() }) : new LiveSource(cfg);
relay = new Relay({ cfg, source, kindConfig, groups });

function wireSource(src) {
  src.on('current', (e) => relay.onCurrent(e));
  src.on('full', (e) => relay.onFull(e));
  src.on('error', (e) => relay.onSourceError(e));
}
wireSource(source);
relay.on('needFull', () => source.requestFull());

/** Auf einen (neuen) Token umschalten: alte Quelle stoppen, Live-Quelle neu starten. */
function restartLiveSource() {
  source.stop();
  source.removeAllListeners();
  cfg.mode = 'live';
  source = new LiveSource(cfg);
  wireSource(source);
  relay.source = source;
  relay.sourceStatus = { ok: false, lastOkAt: null, latencyMs: null, error: null, errorAt: null };
  source.start();
}

/** Token gegen die Rundown-API prüfen, ohne ihn zu übernehmen. */
async function testToken(token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${cfg.rundownBaseUrl}/api/public/rundown/full?token=${encodeURIComponent(token)}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, error: 'Token ungültig oder Rundown nicht gefunden' };
    if (!res.ok) return { ok: false, error: `Rundown-API antwortet mit HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    if (!json || !Array.isArray(json.elements)) return { ok: false, error: 'Unerwartete Antwort der Rundown-API' };
    return { ok: true, title: json.rundown?.title || '', cues: json.elements.filter((e) => e?.type === 'cue').length };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Rundown-API antwortet nicht' : 'Rundown-API nicht erreichbar' };
  } finally {
    clearTimeout(timer);
  }
}

/** Personen neu erkennen (nach geänderter Moderationsliste). */
function rebuildPeople() {
  if (relay.raw.full) {
    relay.rundownKey = '';
    relay.onFull({ json: relay.raw.full, fetchedAt: relay.raw.fullAt });
  }
}

function sourceInfo() {
  return {
    mode: cfg.mode,
    tokenSet: !!cfg.rundownToken,
    tokenHint: tokenHint(cfg.rundownToken),
    tokenFrom: cfg.tokenFrom,
    envTokenSet: !!cfg.envToken,
    hosts: cfg.hosts || [],
    guests: cfg.guests || [],
    rundownTitle: relay.rundown?.title || '',
    status: { ok: relay.sourceStatus.ok, error: relay.sourceStatus.error },
  };
}
let tokenBusy = false;

// ---------- Zugang ----------

function keyOk(provided) {
  if (!cfg.accessKey) return true;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(cfg.accessKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const APP_ROUTES = new Set(['/', '/al', '/schild', '/regie', '/stapel']);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss: https://pingback.giphy.com; img-src 'self' data: https://*.giphy.com; style-src 'self' 'unsafe-inline'; script-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const rel = APP_ROUTES.has(pathname) ? '/index.html' : pathname;
  const file = path.normalize(path.join(cfg.publicDir, decodeURIComponent(rel)));
  if (!file.startsWith(cfg.publicDir + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleApi(req, res, url) {
  const key = url.searchParams.get('key') || req.headers['x-access-key'];
  if (!keyOk(key)) return send(res, 401, { error: 'Zugangsschlüssel fehlt oder falsch' });
  const p = url.pathname;
  if (p === '/api/state') return send(res, 200, relay.snapshot());
  if (p === '/api/rundown') return send(res, 200, relay.rundownMessage());
  if (p === '/api/runview') return send(res, 200, relay.runView());
  if (p === '/api/control' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await relay.control(String(body.action || ''));
    return send(res, r.ok ? 200 : 502, r);
  }
  if (p === '/api/log') return send(res, 200, relay.log);
  if (p === '/api/export/report.csv') {
    const name = `nachbericht-${relay.rundown?.eventDate || 'show'}.csv`;
    return send(res, 200, reportCsv(relay), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
  }
  if (p === '/api/export/markers.edl') {
    const edl = markersEdl(relay, {
      fps: url.searchParams.get('fps') || 25,
      start: url.searchParams.get('start') || '',
      mode: url.searchParams.get('tc') === 'tod' ? 'tod' : 'rec',
    });
    const name = `marker-${relay.rundown?.eventDate || 'show'}.edl`;
    return send(res, 200, edl, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
  }
  if (p === '/api/debug/source') {
    const full = relay.raw.full;
    return send(res, 200, {
      mode: cfg.mode,
      cueStartSource: cfg.cueStartSource,
      status: relay.sourceStatus,
      current: relay.raw.current,
      currentFetchedAt: relay.raw.currentAt,
      full: full ? { rundown: full.rundown, currentItemId: full.currentItemId, isRunning: full.isRunning, elementCount: full.elements?.length } : null,
    });
  }
  if (p === '/api/source' && req.method === 'GET') return send(res, 200, sourceInfo());
  if (p === '/api/source' && req.method === 'POST') {
    const body = await readBody(req);
    const st = loadSourceSettings(cfg.dataDir);
    const peopleChanged = Array.isArray(body.hosts) || Array.isArray(body.guests);
    if (Array.isArray(body.hosts)) {
      cfg.hosts = cleanHosts(body.hosts);
      st.hosts = cfg.hosts;
    }
    if (Array.isArray(body.guests)) {
      cfg.guests = cleanHosts(body.guests);
      st.guests = cfg.guests;
    }
    if (body.reset === true) {
      // zurück zum Token aus .env
      if (!cfg.envToken) return send(res, 400, { error: 'In .env ist kein RUNDOWN_TOKEN gesetzt', ...sourceInfo() });
      st.token = null;
      cfg.rundownToken = cfg.envToken;
      cfg.tokenFrom = 'env';
      saveSourceSettings(cfg.dataDir, st);
      relay.addLog('source', { token: 'env' });
      restartLiveSource();
      return send(res, 200, { ok: true, ...sourceInfo() });
    }
    if (typeof body.token === 'string' && body.token.trim()) {
      const token = body.token.trim();
      if (!tokenLooksValid(token)) return send(res, 400, { error: 'Das sieht nicht nach einem Token aus' });
      if (tokenBusy) return send(res, 429, { error: 'Prüfung läuft schon' });
      tokenBusy = true;
      try {
        const t = await testToken(token);
        if (!t.ok) return send(res, 400, { error: t.error, ...sourceInfo() });
        st.token = token;
        cfg.rundownToken = token;
        cfg.tokenFrom = 'ui';
        saveSourceSettings(cfg.dataDir, st);
        relay.addLog('source', { token: tokenHint(token), title: t.title });
        restartLiveSource();
        return send(res, 200, { ok: true, loaded: { title: t.title, cues: t.cues }, ...sourceInfo() });
      } finally {
        tokenBusy = false;
      }
    }
    saveSourceSettings(cfg.dataDir, st);
    if (peopleChanged) rebuildPeople();
    return send(res, 200, { ok: true, ...sourceInfo() });
  }
  if (p === '/api/giphy') return giphy(res, url);
  if (p === '/api/replay' && req.method === 'POST') {
    if (cfg.mode !== 'replay') return send(res, 400, { error: 'nur im Replay-Modus' });
    const body = await readBody(req);
    relay.handle({ type: 'replay', cmd: body.cmd, cue: body.cue });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

/** GIF-Suche über den Relay: der Giphy-Schlüssel bleibt auf dem Server. */
// GIF-Suche über das offizielle Giphy-SDK. Der Schlüssel bleibt auf dem Server,
// das Gitter im Browser (ebenfalls SDK) bekommt die Ergebnisse von hier.
let giphyFetch = null;
async function giphyClient() {
  if (!giphyFetch) {
    const { GiphyFetch, setServerUrl } = await import('@giphy/js-fetch-api');
    if (process.env.GIPHY_API_URL) setServerUrl(process.env.GIPHY_API_URL); // nur für Tests
    giphyFetch = new GiphyFetch(cfg.giphyApiKey);
  }
  return giphyFetch;
}

async function giphy(res, url) {
  if (!cfg.giphyApiKey) return send(res, 501, { error: 'GIPHY_API_KEY fehlt', data: [] });
  const q = (url.searchParams.get('q') || '').slice(0, 80).trim();
  const offset = Math.max(0, Math.min(4999, Number(url.searchParams.get('offset')) || 0));
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 24));
  const type = url.searchParams.get('type') === 'stickers' ? 'stickers' : 'gifs';
  const opts = { offset, limit, rating: 'pg-13', type };
  try {
    const gf = await giphyClient();
    const result = await Promise.race([
      q ? gf.search(q, { ...opts, lang: 'de' }) : gf.trending(opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    return send(res, 200, result);
  } catch (err) {
    const status = err?.status || 0;
    const msg = err?.message === 'timeout' ? 'Giphy antwortet nicht' : status === 401 || status === 403 ? 'Giphy-Schlüssel ungültig' : 'Giphy nicht erreichbar';
    return send(res, 502, { error: msg, data: [] });
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, mode: cfg.mode, version: pkg.version });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, url.pathname);
}

const tls = cfg.tlsCert && cfg.tlsKey;
const server = tls
  ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) }, handler)
  : http.createServer(handler);

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const ROLES = new Set(['al', 'schild', 'regie']);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' || !keyOk(url.searchParams.get('key'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const role = ROLES.has(url.searchParams.get('role')) ? url.searchParams.get('role') : 'regie';
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, role));
});

function sendWs(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

wss.on('connection', (ws, role) => {
  ws.role = role;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  sendWs(ws, { type: 'hello', role, mode: cfg.mode, version: pkg.version, speed: source.speed || 1, giphy: !!cfg.giphyApiKey });
  sendWs(ws, relay.rundownMessage());
  sendWs(ws, relay.snapshot());
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      sendWs(ws, { type: 'pong', id: msg.id, t0: msg.t0, ts: relay.now(), speed: source.speed || 1 });
      return;
    }
    // AL darf alles; die Regie nur Streckung und Marker (Rundown-Steuerung läuft über /api/control).
    if (ws.role === 'al' || (ws.role === 'regie' && (msg.type === 'stretch' || msg.type === 'marker'))) relay.handle(msg);
  });
});

let pendingBroadcast = null;
function broadcastState() {
  pendingBroadcast = null;
  const msg = JSON.stringify(relay.snapshot());
  for (const ws of wss.clients) sendWs(ws, msg);
}
relay.on('change', () => {
  if (!pendingBroadcast) pendingBroadcast = setTimeout(broadcastState, 50);
});
relay.on('rundown', () => {
  const msg = JSON.stringify(relay.rundownMessage());
  for (const ws of wss.clients) sendWs(ws, msg);
});
setInterval(broadcastState, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 15000);

server.listen(cfg.port, cfg.host, () => {
  const proto = tls ? 'https' : 'http';
  console.log(`AL-Tool ${pkg.version} · Modus ${cfg.mode}${cfg.mode === 'replay' ? ` ×${source.speed} ab Cue ${cfg.replayStartCue}` : ''}`);
  console.log(`  ${proto}://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}/al   Bedienung`);
  console.log(`  ${proto}://…:${cfg.port}/schild   Schild · /regie   Mitlesen`);
  if (!tls) console.log('  Hinweis: Ohne HTTPS laufen Wake Lock und Offline-Cache auf dem iPad nicht (siehe README).');
  source.start();
});

function shutdown() {
  source.stop();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
