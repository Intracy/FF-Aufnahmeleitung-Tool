// Einstieg: Rolle aus der URL (/al, /schild, /regie, /), Verbindung, Ansichten, Ausrichtung.

import { Connection } from './connection.js';
import { settings, storeGet, storeSet } from './settings.js';
import { buildVM } from './viewmodel.js';
import { OperatorView } from './views/operator.js';
import { SignView } from './views/sign.js';
import { LocalFallback } from './local.js';
import { initWakeLock } from './ui/wakelock.js';
import { bindHold, bindTap } from './ui/hold.js';
import { formatTimeOfDay } from './shared/timing.js';

const ROUTES = { '/': 'home', '/al': 'al', '/schild': 'schild', '/regie': 'regie' };
const path = location.pathname.replace(/\/+$/, '') || '/';
const role = ROUTES[path] || 'home';
const $ = (s) => document.querySelector(s);

// ---------- Zugangsschlüssel (optional) ----------
const qs = new URLSearchParams(location.search);
if (qs.get('key')) {
  storeSet('al.key', qs.get('key'));
  history.replaceState(null, '', location.pathname);
}
const key = storeGet('al.key') || '';
const withKey = (url) => {
  if (!key) return url;
  const u = new URL(url, location.origin);
  u.searchParams.set('key', key);
  return u.pathname + u.search;
};

// ---------- Erscheinungsbild ----------
const applyAppearance = () => {
  document.documentElement.dataset.appearance = role === 'al' || role === 'regie' ? settings.get('appearance') : 'dark';
};
applyAppearance();

// ---------- Service Worker (Offline-Start, Homescreen-App) ----------
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------- Toast / Widerrufen ----------
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}
let undoTimer;
let undoFn = null;
function undo(text, fn) {
  $('#undo-text').textContent = `${text} gewählt`;
  $('#undo').hidden = false;
  undoFn = fn;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => ($('#undo').hidden = true), 5000);
}
bindTap($('#undo-btn'), () => {
  $('#undo').hidden = true;
  undoFn?.();
  undoFn = null;
});

// ---------- Verbindung und Daten ----------
const conn = new Connection({ role: role === 'home' ? 'regie' : role, key });
const data = { rundown: null, state: null };
const local = new LocalFallback();
let wake = null;

try {
  const cached = JSON.parse(storeGet('al.rundown') || 'null');
  if (cached) data.rundown = cached;
} catch {
  /* egal */
}

conn.addEventListener('rundown', (e) => {
  const d = e.detail;
  data.rundown = d.rundown ? { ...d.rundown, groups: d.groups } : null;
  storeSet('al.rundown', JSON.stringify(data.rundown));
});
let lastEventId = null;
conn.addEventListener('state', (e) => {
  data.state = e.detail;
  if (local.active) {
    for (const m of local.drain()) conn.send(m);
    local.exit();
    toast('Verbindung wieder da – Relay übernimmt');
  }
  const le = data.state.lastEvent;
  if (le && le.id !== lastEventId) {
    if (lastEventId !== null && le.type === 'marker') toast(`Marker gesetzt · ${formatTimeOfDay(le.at, data.state.timeZone, true)}`);
    lastEventId = le.id;
  }
  frame();
});
// Fehlt der Zugangsschlüssel (z. B. in der Homescreen-App, die einen eigenen Speicher hat),
// lehnt der Server ab. Dann einmal nachfragen statt still offline zu bleiben.
let keyAsked = false;
conn.addEventListener('status', async (e) => {
  frame();
  if (e.detail !== 'closed' || keyAsked || data.state) return;
  try {
    const r = await fetch(withKey('/api/state'), { cache: 'no-store' });
    if (r.status !== 401) return;
    keyAsked = true;
    const k = prompt(key ? 'Zugangsschlüssel stimmt nicht. Bitte neu eingeben:' : 'Zugangsschlüssel für das AL-Tool:');
    if (k && k.trim()) {
      storeSet('al.key', k.trim());
      location.reload();
    }
  } catch {
    /* Server nicht erreichbar – kein Schlüsselproblem */
  }
});
conn.connect();

/** Befehl der AL: an das Relay, ohne Relay an den lokalen Rückfall. */
function act(msg) {
  if (role !== 'al') return;
  if (local.active) {
    local.handle(msg, conn.showNow());
    if (msg.type === 'marker') toast('Marker vorgemerkt – wird nachgereicht');
    frame();
    return;
  }
  if (!conn.send(msg)) toast('Keine Verbindung zum Relay');
}

function onManual(cmd) {
  const now = conn.showNow();
  if (cmd === 'enter') {
    if (conn.open) conn.send({ type: 'manual', cmd: 'enter' });
    else {
      local.enter(data.state, data.rundown, now);
      toast('Lokaler Modus – Cues mit ◀ ▶ schalten');
    }
  } else if (local.active && (cmd === 'prev' || cmd === 'next')) {
    local.step(cmd === 'next' ? 1 : -1, now);
  } else {
    conn.send({ type: 'manual', cmd });
  }
  frame();
}

// ---------- Ansichten ----------
const signEl = $('#sign');
const opEl = $('#operator');
const signView = new SignView(signEl);
let opView = null;
let signShown = false;

function showSign(show) {
  signShown = show;
  signEl.hidden = !show;
  if (role === 'al') {
    const hint = $('#sign-hint');
    hint.hidden = !show;
    hint.classList.remove('fade');
    if (show) setTimeout(() => hint.classList.add('fade'), 2500);
  }
  frame();
}

if (role === 'home') {
  $('#home').hidden = false;
  document.querySelectorAll('[data-keep-key]').forEach((a) => (a.href = withKey(a.getAttribute('href'))));
} else if (role === 'schild') {
  showSign(true);
  wake = initWakeLock(() => {});
} else {
  opEl.hidden = false;
  opView = new OperatorView({
    root: opEl,
    act,
    onSign: () => showSign(true),
    onSettings: openSettings,
    onManual,
    undo,
    readonly: role === 'regie',
  });
  opView.setGrip(settings.get('grip'));
  wake = initWakeLock(() => frame());

  if (role === 'al') {
    // Drehen ist der Moduswechsel: quer = Schild, hoch = Bedienung.
    const landscape = matchMedia('(orientation: landscape)');
    const onOrientation = () => {
      if (!settings.get('rotateToSign')) return;
      showSign(landscape.matches);
    };
    landscape.addEventListener('change', onOrientation);
    if (landscape.matches && settings.get('rotateToSign')) showSign(true);
    // Schild verlassen: 1 s irgendwo halten.
    bindHold(signEl, () => showSign(false), 1000);
  }
}

// ---------- Einstellungen ----------
const dlg = $('#settings');
function syncSegmented(id, value) {
  document.querySelectorAll(`#${id} [data-value]`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));
}
function exportLinks() {
  const fps = settings.get('fps');
  $('#exp-csv').href = withKey('/api/export/report.csv');
  $('#exp-edl').href = withKey(`/api/export/markers.edl?fps=${fps}`);
  $('#exp-edl-tod').href = withKey(`/api/export/markers.edl?fps=${fps}&tc=tod`);
}
function openSettings() {
  syncSegmented('set-grip', settings.get('grip'));
  syncSegmented('set-appearance', settings.get('appearance'));
  syncSegmented('set-fps', settings.get('fps'));
  $('#set-rotate').checked = !!settings.get('rotateToSign');
  $('#grp-replay').hidden = data.state?.mode !== 'replay';
  exportLinks();
  document.querySelectorAll('#settings [data-keep-key]').forEach((a) => (a.href = withKey(a.getAttribute('href').split('?')[0])));
  renderSettingsInfo();
  dlg.showModal();
}
function renderSettingsInfo() {
  if (!dlg.open) return;
  $('#set-wake').textContent = wake?.status ?? '–';
  const s = conn.syncInfo();
  $('#set-sync').textContent = s ? `±${s.accuracyMs} ms (Laufzeit ${s.rttMs} ms)` : conn.open ? 'läuft …' : 'getrennt';
  const src = data.state?.source;
  $('#set-source').textContent = !src
    ? '–'
    : data.state.mode === 'replay'
      ? `Replay ×${data.state.speed}`
      : src.stale
        ? `keine Antwort${src.error ? ` (${src.error})` : ''}`
        : `ok · ${src.latencyMs ?? '–'} ms`;
  $('#set-starthow').textContent = src?.startHow ? { observed: 'Beobachtung (±0,5 s)', manual: 'manuell' }[src.startHow] || `API-Feld ${src.startHow}` : '–';
  $('#set-version').textContent = `Relay-Modus ${data.state?.mode ?? '–'} · Rolle ${role}`;
}
for (const [id, k] of [
  ['set-grip', 'grip'],
  ['set-appearance', 'appearance'],
  ['set-fps', 'fps'],
]) {
  document.getElementById(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    settings.set(k, b.dataset.value);
    syncSegmented(id, b.dataset.value);
  });
}
$('#set-rotate').addEventListener('change', (e) => settings.set('rotateToSign', e.target.checked));
settings.onChange((k) => {
  if (k === 'grip') opView?.setGrip(settings.get('grip'));
  if (k === 'appearance') applyAppearance();
  if (k === 'fps') exportLinks();
});
bindTap($('#replay-go'), () => {
  const cue = Number($('#replay-cue').value);
  if (cue > 0) conn.send({ type: 'replay', cmd: 'jump', cue });
  dlg.close();
});

// ---------- Darstellung ----------
function frame() {
  const now = conn.showNow();
  const state = local.active ? local.state() : data.state;
  const vm = buildVM(state, now);
  const meta = {
    timeZone: data.state?.timeZone || 'Europe/Berlin',
    offlineMs: conn.offlineForMs(),
    sync: conn.syncInfo(),
    local: local.active,
    wakeBad: !!wake && /blockiert|freigegeben|HTTPS/.test(wake.status || ''),
  };
  if (role === 'home') {
    const t = data.state?.rundown?.title;
    $('#home-rundown').textContent = t ? `${t} · ${data.state.mode === 'replay' ? 'Replay' : 'Live'}` : conn.open ? 'Verbunden' : 'Verbinde mit dem Relay …';
    return;
  }
  if (signShown) signView.render(vm, meta);
  if (opView && !signShown) opView.render(vm, meta);
  renderSettingsInfo();
}
setInterval(frame, 100);
frame();
