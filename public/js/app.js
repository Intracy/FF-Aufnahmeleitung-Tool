// Einstieg: Rolle aus der URL (/al, /schild, /regie, /), Verbindung, Ansichten, Ausrichtung.

import { Connection } from './connection.js';
import { settings, storeGet, storeSet } from './settings.js';
import { buildVM } from './viewmodel.js';
import { OperatorView } from './views/operator.js';
import { RundownSheet } from './views/rundown.js';
import { SignView } from './views/sign.js';
import { LocalFallback } from './local.js';
import { initWakeLock } from './ui/wakelock.js';
import { bindHold, bindTap } from './ui/hold.js';
import { formatTimeOfDay, formatSigned } from './shared/timing.js';
import { createWheel } from './ui/wheel.js';
import { sanitize, plainText, safeGifUrl, gifFromGiphyLink } from './ui/richtext.js';

const ROUTES = { '/': 'home', '/al': 'al', '/schild': 'schild', '/regie': 'regie' };
const path = location.pathname.replace(/\/+$/, '') || '/';
const role = ROUTES[path] || 'home';
const $ = (s) => document.querySelector(s);
const dlg = $('#settings'); // früh anlegen: frame() liest es schon beim Start

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

// ---------- LEA MODE: alle Farben in Pastell (rosé, lila, orange, pink), pro Gerät ----------
const applyLea = () => {
  const on = !!settings.get('lea');
  if (on) document.documentElement.dataset.lea = 'on';
  else delete document.documentElement.dataset.lea;
  const b = document.getElementById('op-lea');
  if (b) b.setAttribute('aria-pressed', String(on));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = on ? '#1d1020' : '#000000';
};
applyLea();
document.getElementById('op-lea')?.addEventListener('click', () => {
  settings.set('lea', !settings.get('lea'));
  toast(settings.get('lea') ? 'LEA MODE an' : 'LEA MODE aus');
});

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
  // Regie darf strecken und Marker setzen, sonst nur die AL
  if (role !== 'al' && !(role === 'regie' && (msg.type === 'stretch' || msg.type === 'marker'))) return;
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
    onStretch: openStretch,
    onText: openText,
    onRundown: () => rundownSheet.open(),
    onControl: control,
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

// ---------- Strecken: Zeit wählen ----------
const stretchDlg = $('#stretch-sheet');
function openStretch() {
  const st = local.active ? local.state() : data.state;
  const cue = st?.cue;
  if (!cue) return;
  const parts = [`${cue.emoji ? cue.emoji + ' ' : ''}${cue.title}`];
  if (cue.stretchMs) parts.push(`bisher ${formatSigned(cue.stretchMs)}`);
  $('#stretch-info').textContent = parts.join(' · ');
  stretchDlg.returnValue = '';
  stretchDlg.showModal();
  requestAnimationFrame(() => {
    wheelMin.sync();
    wheelSec.sync();
  });
}
// Eigene Zeit: zwei Scrollräder MM:SS, je 00–99
const customTime = { m: 0, s: 0 };
const pad2 = (n) => String(n).padStart(2, '0');
const customBtn = $('#stretch-custom-btn');
const customMs = () => (customTime.m * 60 + customTime.s) * 1000;
function updateCustom() {
  customBtn.disabled = customMs() <= 0;
  customBtn.textContent = `+${pad2(customTime.m)}:${pad2(customTime.s)} übernehmen`;
}
const wheelMin = createWheel($('#wheel-min'), { label: 'Minuten', onChange: (v) => ((customTime.m = v), updateCustom()) });
const wheelSec = createWheel($('#wheel-sec'), { label: 'Sekunden', onChange: (v) => ((customTime.s = v), updateCustom()) });
updateCustom();
stretchDlg.addEventListener('close', () => {
  const rv = stretchDlg.returnValue;
  const ms = rv === 'custom' ? customMs() : Number(rv);
  if (ms > 0) act({ type: 'stretch', ms });
});
// Tippen neben das Sheet schließt es (wie in iPadOS)
stretchDlg.addEventListener('click', (e) => {
  if (e.target === stretchDlg) stretchDlg.close('cancel');
});

// ---------- Rundown im Backend steuern (Start, Next, Pause, Zurück, Beenden) ----------
const CONTROL_TOAST = { start: 'Show gestartet', next: 'Nächster Cue', toggle: 'Pause / Weiter', prev: 'Zurück', finish: 'Show beendet' };
async function control(action) {
  try {
    const r = await fetch(withKey('/api/control'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
      cache: 'no-store',
    });
    const j = await r.json().catch(() => ({}));
    if (j.ignored) return;
    toast(r.ok ? CONTROL_TOAST[action] : `Rundown: ${j.error || 'Fehler'}`);
  } catch {
    toast('Rundown: keine Verbindung zum Relay');
  }
}

// ---------- Kompletter Rundown (Tipp auf den Cue-Kasten) ----------
const rundownSheet = new RundownSheet({
  dialog: $('#rundown-sheet'),
  getRundown: () => data.rundown,
  getState: () => (local.active ? local.state() : data.state),
  now: () => conn.showNow(),
  fetchRun: async () => {
    const r = await fetch(withKey('/api/runview'), { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  },
});

// ---------- Custom Text fürs Schild ----------
const textDlg = $('#text-sheet');
const editor = $('#text-editor');
const draft = { gif: null, upper: false, only: false };
let giphyEnabled = false;
conn.addEventListener('hello', (e) => (giphyEnabled = !!e.detail.giphy));

function currentState() {
  return local.active ? local.state() : data.state;
}
function syncTextUi() {
  editor.classList.toggle('upper', draft.upper);
  $('#fmt-upper').setAttribute('aria-pressed', String(draft.upper));
  syncSegmented('msg-mode', draft.only ? 'only' : 'with');
  const sel = $('#gif-selected');
  sel.hidden = !draft.gif;
  if (draft.gif) $('#gif-selected-img').src = draft.gif.url;
  else $('#gif-selected-img').removeAttribute('src');
  $('#text-show').disabled = !plainText(sanitize(editor.innerHTML)) && !draft.gif;
}
function openText() {
  const m = currentState()?.message;
  if (m) {
    editor.innerHTML = sanitize(m.html);
    draft.gif = m.gif && safeGifUrl(m.gif.url) ? m.gif : null;
    draft.upper = !!m.upper;
    draft.only = !!m.only;
  }
  $('#text-hide').hidden = !m;
  $('#text-show').textContent = m ? 'Aktualisieren' : 'Anzeigen';
  syncTextUi();
  textDlg.returnValue = '';
  textDlg.showModal();
  $('#gif-type').hidden = !giphyEnabled;
  if (giphyEnabled) requestAnimationFrame(() => renderGifGrid());
  else $('#gif-hint').textContent = 'Für die GIF-Suche fehlt auf dem Server ein Giphy-Schlüssel. Einen Giphy-Link einfügen funktioniert trotzdem.';
}

// Nur Text: Schild zeigt ausschließlich den Custom Text (ohne Restzeit, Cue und Zustandsfarben)
document.querySelectorAll('#msg-mode [data-value]').forEach((b) =>
  b.addEventListener('click', () => {
    draft.only = b.dataset.value === 'only';
    syncTextUi();
  }),
);

// Formatierung: Knöpfe nehmen dem Editor den Fokus nicht weg, damit die Auswahl bleibt.
document.querySelectorAll('#text-sheet .fmt-bar button').forEach((b) => {
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('click', () => {
    if (b.id === 'fmt-upper') {
      draft.upper = !draft.upper;
      syncTextUi();
      return;
    }
    editor.focus();
    document.execCommand('styleWithCSS', false, false);
    if (b.dataset.color) document.execCommand('foreColor', false, b.dataset.color);
    else if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
    syncTextUi();
  });
});
editor.addEventListener('input', syncTextUi);
editor.addEventListener('paste', (e) => {
  // Nur reinen Text einfügen, keine fremde Formatierung
  e.preventDefault();
  const t = e.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, t);
});
$('#quick-texts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  editor.textContent = b.textContent;
  syncTextUi();
});

// GIFs: Gitter aus dem Giphy-SDK (@giphy/js-components). Die Daten holt das Relay mit dem
// SDK-Fetch (@giphy/js-fetch-api), damit der Schlüssel auf dem Server bleibt.
// Ein eingefügter Giphy-Link funktioniert auch ohne Schlüssel.
let gifTimer;
let gifQuery = '';
let gifType = 'gifs';
let gifSdk = null;
let gifGridRemove = null;
let gifGridKey = '';

function gifRendition(gif) {
  const im = gif.images || {};
  const big = im.downsized_medium || im.downsized || im.original || {};
  return { url: safeGifUrl(big.url), width: Number(big.width) || 0, height: Number(big.height) || 0 };
}

function gifColumns(w) {
  return w >= 560 ? 3 : 2;
}

async function renderGifGrid(force = false) {
  const grid = $('#gif-grid');
  const hint = $('#gif-hint');
  const width = grid.clientWidth;
  if (!giphyEnabled || !width) return;
  const key = `${gifType}|${gifQuery}|${width}`;
  if (!force && key === gifGridKey) return;
  gifGridKey = key;
  try {
    gifSdk ||= await import('../vendor/giphy.js');
  } catch {
    hint.textContent = 'GIF-Suche konnte nicht geladen werden.';
    return;
  }
  gifGridRemove?.();
  grid.replaceChildren();
  grid.classList.toggle('stickers', gifType === 'stickers');
  hint.textContent = '';
  const q = gifQuery;
  const type = gifType;
  gifGridRemove = gifSdk.renderGrid(
    {
      width,
      columns: gifColumns(width),
      gutter: 8,
      borderRadius: 10,
      noLink: true,
      hideAttribution: true,
      noResultsMessage: 'Keine GIFs gefunden.',
      fetchGifs: async (offset) => {
        const r = await fetch(withKey(`/api/giphy?q=${encodeURIComponent(q)}&type=${type}&offset=${offset}&limit=24`), { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) {
          hint.textContent = j.error || 'GIF-Suche nicht verfügbar.';
          throw new Error(j.error || 'giphy');
        }
        return j;
      },
      onGifClick: (gif, e) => {
        e?.preventDefault?.();
        const r = gifRendition(gif);
        if (!r.url) return;
        draft.gif = { ...r, id: gif.id, title: gif.title || '' };
        grid.querySelectorAll('.giphy-gif.is-selected').forEach((n) => n.classList.remove('is-selected'));
        e?.currentTarget?.classList?.add('is-selected');
        syncTextUi();
        $('#gif-selected').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      onGifKeyPress: (gif, e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const r = gifRendition(gif);
        if (!r.url) return;
        draft.gif = { ...r, id: gif.id, title: gif.title || '' };
        syncTextUi();
      },
    },
    grid,
  );
}

async function searchGifs(q) {
  const hint = $('#gif-hint');
  const link = gifFromGiphyLink(q);
  if (link) {
    draft.gif = { url: link, width: 0, height: 0 };
    hint.textContent = 'GIF aus dem Link übernommen.';
    syncTextUi();
    return;
  }
  if (!giphyEnabled) return;
  gifQuery = q;
  renderGifGrid();
}

document.querySelectorAll('#gif-type [data-value]').forEach((b) =>
  b.addEventListener('click', () => {
    gifType = b.dataset.value;
    syncSegmented('gif-type', gifType);
    renderGifGrid();
  }),
);
// Breite ändert sich beim Drehen des iPads: Gitter neu aufbauen
new ResizeObserver(() => textDlg.open && renderGifGrid()).observe($('#gif-grid'));
$('#gif-query').addEventListener('input', (e) => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => searchGifs(e.target.value.trim()), 400);
});
$('#gif-query').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // sonst schickt Enter das Formular ab und schließt den Dialog
  clearTimeout(gifTimer);
  searchGifs(e.target.value.trim());
  e.target.blur();
});
bindTap($('#gif-remove'), () => {
  draft.gif = null;
  syncTextUi();
});
textDlg.addEventListener('close', () => {
  const rv = textDlg.returnValue;
  if (rv === 'hide') {
    act({ type: 'message', clear: true });
    return;
  }
  if (rv !== 'show') return;
  const html = sanitize(editor.innerHTML);
  const text = plainText(html);
  if (!text && !draft.gif) return;
  act({ type: 'message', html, text, gif: draft.gif, upper: draft.upper, only: draft.only });
  toast('Text auf dem Schild');
});

// ---------- Einstellungen ----------
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
  if (k === 'lea') applyLea();
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
