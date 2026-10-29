import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { buildRundown, publicCue, jumpMap, nextIndex, backtime, parseTimestamp, optionPossible } from './model.js';
import { STRETCH_STEP_MS, elapsedFor } from '../public/js/shared/timing.js';

const START_FIELDS = ['startedAt', 'started_at', 'actualStart', 'actualStartAt', 'actualStartedAt', 'liveAt', 'startTimestamp'];
const emptySignals = () => ({ wrap: false, cut: false, standby: false, stretchAt: null });

function resolveCurrentId(json) {
  const c = json?.current;
  if (c && typeof c === 'object') return c.id ?? c.itemId ?? c.cueId ?? c.elementId ?? undefined;
  if (typeof c === 'string') return c;
  if (json && 'currentItemId' in json) return json.currentItemId;
  if (c === null) return null;
  return undefined;
}

/**
 * Hält den Zustand zwischen Rundown-Quelle und iPads:
 * aktueller Cue samt Startzeit, AL-Signale, Szenarien, Log.
 * Alle Zeiten sind Showzeit der Quelle (live: Serveruhr, replay: virtuelle Uhr).
 */
export class Relay extends EventEmitter {
  constructor({ cfg, source, kindConfig, groups }) {
    super();
    this.cfg = cfg;
    this.source = source;
    this.kc = kindConfig;
    this.groups = groups;
    this.rundown = null;
    this.rundownKey = null;
    this.raw = { current: null, currentAt: null, full: null, fullAt: null };
    this.sourceStatus = { ok: false, lastOkAt: null, latencyMs: null, error: null, errorAt: null };
    this.show = { isRunning: false, isPaused: false, showStartedAt: null };
    this.lastPositionKey = null;
    this.fullCurrentId = null;
    this.currentHasId = false;
    this.lastEvent = null;
    this.log = [];
    this.st = this.emptyState();
    this.pending = null;
    this.runningSeen = null; // zuletzt gesehenes isRunning (null = noch nichts gesehen)
    this.stoppedSince = null;
    const replay = cfg.mode === 'replay';
    this.persistFile = replay ? null : path.join(cfg.dataDir, 'state.json');
    this.logFile = path.join(cfg.dataDir, replay ? 'log-replay.jsonl' : 'log.jsonl');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    if (replay) fs.writeFileSync(this.logFile, '');
    this.loadPersisted();
  }

  emptyState() {
    return {
      rundownId: null,
      currentId: null,
      cueStarts: {},
      cueEnds: {},
      startHow: {},
      visited: [],
      stretch: {},
      signals: emptySignals(),
      selections: {},
      manual: { active: false, since: null },
      pausedAt: null,
      message: null,
      showStartedAt: null,
    };
  }

  now() {
    return this.source.now();
  }

  // ---------- Persistenz ----------

  loadPersisted() {
    if (!this.persistFile || !fs.existsSync(this.persistFile)) return;
    try {
      this.pending = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
    } catch {
      this.pending = null;
    }
  }

  persist() {
    if (!this.persistFile) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const tmp = this.persistFile + '.tmp';
      fs.writeFile(tmp, JSON.stringify(this.st), (err) => {
        if (!err) fs.rename(tmp, this.persistFile, () => {});
      });
    }, 300);
  }

  loadLogFor(rundownId) {
    this.log = [];
    if (!fs.existsSync(this.logFile)) return;
    for (const line of fs.readFileSync(this.logFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.rundownId === rundownId) this.log.push(e);
      } catch {
        /* defekte Zeile ignorieren */
      }
    }
  }

  addLog(type, detail = {}, at = this.now()) {
    const cue = this.currentCue();
    const entry = {
      at,
      type,
      rundownId: this.rundown?.id ?? null,
      cueId: cue?.id ?? null,
      cueNumber: cue?.number ?? null,
      cueTitle: cue?.title ?? null,
      ...detail,
    };
    this.log.push(entry);
    if (this.log.length > 20000) this.log.splice(0, this.log.length - 20000);
    fs.appendFile(this.logFile, JSON.stringify(entry) + '\n', () => {});
    return entry;
  }

  changed() {
    this.emit('change');
  }

  // ---------- Quelle ----------

  onSourceError({ kind, error, at }) {
    this.sourceStatus.error = `${kind}: ${error}`;
    this.sourceStatus.errorAt = at;
    if (kind === 'current') this.sourceStatus.ok = false;
    this.changed();
  }

  onFull({ json, fetchedAt }) {
    this.raw.full = json;
    this.raw.fullAt = fetchedAt;
    const key = JSON.stringify([
      json.rundown?.id,
      json.rundown?.title,
      json.rundown?.eventDate,
      (json.elements || []).map((e) => [e.id, e.type, e.number, e.title, e.notes, e.durationSeconds, e.color, e.plannedStart, e.columns]),
      (json.columns || []).map((c) => c?.name),
    ]);
    if (key !== this.rundownKey) {
      this.rundownKey = key;
      this.rundown = buildRundown(json, this.kc, this.cfg.timeZone);
      if (this.st.rundownId !== this.rundown.id) {
        if (this.pending && this.pending.rundownId === this.rundown.id) {
          this.st = { ...this.emptyState(), ...this.pending, signals: { ...emptySignals(), ...this.pending.signals } };
        } else {
          this.st = this.emptyState();
        }
        this.st.rundownId = this.rundown.id;
        this.pending = null;
        this.loadLogFor(this.rundown.id);
      }
      this.emit('rundown');
    } else {
      for (const el of json.elements || []) {
        const c = this.rundown.byId.get(el.id);
        if (c) c.actualDurationMs = el.actualDurationSeconds != null ? Number(el.actualDurationSeconds) * 1000 : null;
      }
    }
    this.fullCurrentId = json.currentItemId ?? (json.elements || []).find((e) => e.isActive)?.id ?? null;
    if (this.raw.current) this.applyCurrent(this.raw.current, this.raw.currentAt);
    this.changed();
  }

  onCurrent({ json, fetchedAt, latencyMs }) {
    this.sourceStatus = { ok: true, lastOkAt: fetchedAt, latencyMs, error: null, errorAt: null };
    this.raw.current = json;
    this.raw.currentAt = fetchedAt;
    this.show = {
      isRunning: !!json.isRunning,
      isPaused: !!json.isPaused,
      showStartedAt: parseTimestamp(json.showStartedAt),
    };
    const posKey = `${json.position}|${json.isRunning}|${json.rundown?.id}|${resolveCurrentId(json)}`;
    if (posKey !== this.lastPositionKey) {
      this.lastPositionKey = posKey;
      this.emit('needFull');
    }
    if (!this.rundown || (json.rundown?.id && json.rundown.id !== this.rundown.id)) {
      this.emit('needFull');
      this.changed();
      return;
    }
    this.detectRestart(json, fetchedAt);
    this.applyCurrent(json, fetchedAt);
    this.changed();
  }

  /**
   * Erkennt einen Neustart der Show im Rundown-Backend und setzt dann alle Zeiten zurück
   * (Streckungen, Cue-Starts, Salden, Signale, Szenarien, Custom Text).
   * Anzeichen, jedes für sich reicht:
   *  1. `showStartedAt` ändert sich (neuer Showstart, auch nach Neustart des Relays),
   *  2. die Show war gestoppt (isRunning=false, mind. 1,5 s) und läuft wieder,
   *  3. die Show springt mitten im Lauf zurück auf den ersten Cue.
   */
  detectRestart(json, fetchedAt) {
    const showStart = parseTimestamp(json.showStartedAt);
    const running = !!json.isRunning;
    let reason = null;

    // Nur ein frischer Showstart zählt (≤ 15 min alt). So löst ein Backend, das den Startwert
    // z. B. nach einer Pause verschiebt, keinen Reset mitten in der Show aus.
    if (showStart != null && this.st.showStartedAt != null && showStart - this.st.showStartedAt > 5000 && fetchedAt - showStart < 15 * 60000) reason = 'showStartedAt';

    if (!running) {
      if (this.runningSeen === true && this.stoppedSince == null) this.stoppedSince = fetchedAt;
    } else if (this.runningSeen === false && this.stoppedSince != null && fetchedAt - this.stoppedSince >= 1500 && this.st.visited.length) {
      reason ||= 'stopStart';
    }
    if (running) this.stoppedSince = null;
    this.runningSeen = running;

    if (!reason && running && !this.st.manual.active) {
      const id = resolveCurrentId(json) ?? this.fullCurrentId;
      const first = this.rundown?.cues?.[0]?.id;
      if (id && first && id === first && this.st.currentId && this.st.currentId !== first && this.st.visited.length > 1) reason = 'firstCue';
    }

    if (reason) this.resetRun(reason, fetchedAt);
    if (showStart != null && this.st.showStartedAt !== showStart) {
      this.st.showStartedAt = showStart;
      this.persist();
    }
  }

  /**
   * Rundown im Backend steuern. Gleiche Aktion innerhalb von 800 ms wird ignoriert,
   * damit ein Doppeltipp (oder zwei iPads gleichzeitig) nicht zwei Cues weiterschaltet.
   */
  async control(action) {
    const map = { start: 'next', next: 'next', toggle: 'toggle', pause: 'toggle', prev: 'prev', finish: 'finish' };
    const api = map[action];
    if (!api) return { ok: false, error: 'Unbekannte Aktion' };
    if (typeof this.source.control !== 'function') return { ok: false, error: 'Quelle kann nicht steuern' };
    const t = Date.now();
    if (this.lastControl && this.lastControl.api === api && t - this.lastControl.t < 800) return { ok: true, ignored: true };
    this.lastControl = { api, t };
    const result = await this.source.control(api);
    this.addLog('control', { action, ok: !!result.ok, error: result.ok ? undefined : result.error });
    this.changed();
    return result;
  }

  /** Neuer Showlauf: alles, was zum alten Lauf gehört, verwerfen. */
  resetRun(reason, at = this.now()) {
    const rundownId = this.st.rundownId;
    this.st = { ...this.emptyState(), rundownId };
    this.addLog('reset', { reason }, at);
    this.persist();
  }

  /** Log ab dem letzten Show-Neustart (für Nachbericht und Marker-Export). */
  runLog() {
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].type === 'reset') return this.log.slice(i + 1);
    return this.log;
  }

  applyCurrent(json, fetchedAt) {
    if (!this.rundown) return;
    if (json.isPaused && this.st.pausedAt == null) {
      this.st.pausedAt = fetchedAt;
      this.addLog('pause');
      this.persist();
    } else if (!json.isPaused && this.st.pausedAt != null) {
      const d = fetchedAt - this.st.pausedAt;
      const id = this.st.currentId;
      if (id && this.st.startHow[id] === 'observed') this.st.cueStarts[id] += d;
      this.st.pausedAt = null;
      this.addLog('resume', { pausedMs: d });
      this.persist();
    }
    if (this.st.manual.active) return;

    let id = resolveCurrentId(json);
    this.currentHasId = id !== undefined;
    if (id === undefined || (id === null && json.isRunning)) id = json.isRunning ? this.fullCurrentId : null;
    if (id && !this.rundown.byId.has(id)) {
      this.emit('needFull');
      return;
    }
    const derived = id ? this.deriveStart(json, fetchedAt) : null;
    if (id !== this.st.currentId) {
      const prevStart = this.st.currentId ? this.st.cueStarts[this.st.currentId] : null;
      const ok = derived && (prevStart == null || derived.at >= prevStart);
      this.setCue(id, ok ? derived.at : fetchedAt, ok ? derived.how : 'observed', fetchedAt);
    } else if (id && derived && Math.abs(derived.at - this.st.cueStarts[id]) > 1500) {
      // Startzeit nachschärfen, aber nie vor den Start des vorherigen Cues.
      const v = this.st.visited;
      const prevId = v.length > 1 ? v[v.length - 2] : null;
      const prevStart = prevId ? this.st.cueStarts[prevId] : null;
      if (prevStart == null || derived.at >= prevStart) {
        this.st.cueStarts[id] = derived.at;
        this.st.startHow[id] = derived.how;
        if (prevId) this.st.cueEnds[prevId] = derived.at;
        this.persist();
      }
    }
  }

  /** Startzeit des Cues aus der API ableiten; null = selbst beobachten. */
  deriveStart(json, fetchedAt) {
    const mode = this.cfg.cueStartSource;
    if (mode === 'observed') return null;
    const c = json.current && typeof json.current === 'object' ? json.current : {};
    const sane = (t) => t != null && t <= fetchedAt + 2000 && t >= fetchedAt - 24 * 3600e3;
    if (mode.startsWith('field:')) {
      const f = mode.slice(6);
      const t = parseTimestamp(c[f] ?? json[f]);
      return sane(t) ? { at: t, how: f } : null;
    }
    if (mode === 'auto') {
      for (const f of START_FIELDS) {
        const t = parseTimestamp(c[f]);
        if (sane(t)) return { at: t, how: f };
      }
    }
    if ((mode === 'auto' || mode === 'liveSince') && typeof json.liveSinceSeconds === 'number') {
      const sinceMs = json.liveSinceSeconds * 1000;
      const showStart = parseTimestamp(json.showStartedAt);
      const showLevel = mode === 'auto' && showStart != null && Math.abs(fetchedAt - showStart - sinceMs) < 2500;
      const t = fetchedAt - sinceMs;
      if (!showLevel && sane(t)) return { at: t, how: 'liveSinceSeconds' };
    }
    return null;
  }

  setCue(id, startedAt, how, at) {
    const prev = this.st.currentId;
    if (prev) this.st.cueEnds[prev] = Math.max(id ? startedAt : at, this.st.cueStarts[prev] ?? -Infinity);
    this.st.currentId = id;
    this.st.signals = emptySignals();
    if (id) {
      // Ein Cue, der erneut beginnt (nach anderen Cues), startet ohne Streckung aus dem
      // früheren Durchlauf. Ein kurzer Aussetzer der Quelle auf demselben Cue zählt nicht.
      if (this.st.visited[this.st.visited.length - 1] !== id) delete this.st.stretch[id];
      this.st.cueStarts[id] = startedAt;
      this.st.startHow[id] = how;
      delete this.st.cueEnds[id];
      if (this.st.visited[this.st.visited.length - 1] !== id) this.st.visited.push(id);
      this.addLog('cue', { startedAt, how });
    } else if (prev) {
      this.addLog('idle');
    }
    this.persist();
  }

  // ---------- Hilfen ----------

  currentCue() {
    return this.rundown && this.st.currentId ? this.rundown.byId.get(this.st.currentId) || null : null;
  }

  jumps() {
    return jumpMap(this.groups, this.st.selections);
  }

  previousIndex(cue) {
    const v = this.st.visited;
    for (let i = v.length - 1; i >= 0; i--) {
      if (v[i] !== cue.id) {
        const c = this.rundown.byId.get(v[i]);
        if (c) return c.index;
      }
    }
    return cue.index - 1;
  }

  // ---------- Befehle der AL ----------

  handle(msg) {
    const cue = this.currentCue();
    switch (msg.type) {
      case 'signal': {
        if (!cue || !['wrap', 'cut', 'standby'].includes(msg.kind)) return;
        this.st.signals[msg.kind] = !!msg.on;
        this.addLog('signal', { signal: msg.kind, on: !!msg.on });
        break;
      }
      case 'stretch': {
        if (!cue) return;
        const step = Number.isFinite(msg.ms) ? Math.max(-600_000, Math.min(600_000, msg.ms)) : STRETCH_STEP_MS;
        this.st.stretch[cue.id] = Math.max(0, (this.st.stretch[cue.id] || 0) + step);
        this.st.signals.stretchAt = this.now();
        this.addLog('stretch', { ms: step, totalMs: this.st.stretch[cue.id] });
        break;
      }
      case 'marker': {
        // Nachgereichte Marker (Offline-Rückfall) behalten ihre Zeit, höchstens 1 h zurück.
        const now = this.now();
        const at = Number.isFinite(msg.at) && msg.at <= now && msg.at > now - 3600e3 ? msg.at : now;
        const e = this.addLog('marker', { label: String(msg.label || '').slice(0, 80), late: at !== now }, at);
        this.lastEvent = { type: 'marker', at: e.at, id: `${now}-${this.log.length}` };
        break;
      }
      case 'scenario': {
        const g = this.groups.find((x) => x.id === msg.group);
        if (!g) return;
        const opt = msg.option == null ? null : g.options.find((o) => o.id === msg.option);
        if (msg.option != null && !opt) return;
        const before = this.st.selections[g.id] ?? null;
        this.st.selections[g.id] = opt ? opt.id : null;
        this.addLog('scenario', { group: g.id, option: opt?.id ?? null, label: opt ? `${g.short} ${opt.label}` : `${g.short} offen`, before });
        break;
      }
      case 'message': {
        // Custom-Text fürs Schild. Das HTML wird beim Anzeigen auf dem Gerät bereinigt;
        // hier nur Größe und GIF-Herkunft begrenzen.
        if (msg.clear) {
          if (this.st.message) this.addLog('message', { on: false });
          this.st.message = null;
          break;
        }
        const html = String(msg.html || '').slice(0, 16000);
        const text = String(msg.text || '').slice(0, 500);
        let gif = null;
        try {
          const u = new URL(msg.gif?.url || '');
          if (u.protocol === 'https:' && /(^|\.)giphy\.com$/i.test(u.hostname)) {
            gif = { url: u.href, width: Number(msg.gif.width) || 0, height: Number(msg.gif.height) || 0 };
          }
        } catch {
          /* kein GIF */
        }
        if (!text.trim() && !gif) return;
        this.st.message = { html, text, gif, upper: !!msg.upper, only: !!msg.only, at: this.now() };
        this.addLog('message', { on: true, label: text || 'GIF' });
        break;
      }
      case 'manual':
        this.manual(msg.cmd);
        break;
      case 'replay': {
        if (this.source.mode !== 'replay') return;
        if (msg.cmd === 'jump' && this.source.jump(msg.cue)) this.addLog('replay', { jumpTo: Number(msg.cue) });
        break;
      }
      default:
        return;
    }
    this.persist();
    this.changed();
  }

  manual(cmd) {
    if (!this.rundown) return;
    const now = this.now();
    if (cmd === 'enter' && !this.st.manual.active) {
      this.st.manual = { active: true, since: now };
      this.addLog('manual', { on: true });
    } else if (cmd === 'exit' && this.st.manual.active) {
      this.st.manual = { active: false, since: null };
      this.addLog('manual', { on: false });
      if (this.raw.current) this.applyCurrent(this.raw.current, now);
    } else if ((cmd === 'next' || cmd === 'prev') && this.st.manual.active) {
      const cue = this.currentCue();
      let idx;
      if (cmd === 'next') idx = cue ? nextIndex(this.rundown, cue.index, this.jumps()) : 0;
      else idx = cue ? this.previousIndex(cue) : -1;
      if (idx >= 0 && this.rundown.cues[idx]) this.setCue(this.rundown.cues[idx].id, now, 'manual', now);
    }
  }

  // ---------- Auswertung ----------

  balance(now, cue, elapsed) {
    let moderationMs = 0;
    let gameMs = 0;
    const seen = new Set();
    for (let i = this.st.visited.length - 1; i >= 0; i--) {
      const id = this.st.visited[i];
      if (seen.has(id) || id === cue?.id) continue;
      seen.add(id);
      const c = this.rundown.byId.get(id);
      if (!c) continue;
      const s = this.st.cueStarts[id];
      const e = this.st.cueEnds[id];
      const actual = c.actualDurationMs ?? (s != null && e != null ? e - s : null);
      if (actual == null) continue;
      if (c.kind === 'moderated') moderationMs += actual - (c.durationMs + (this.st.stretch[id] || 0));
      else if (c.kind === 'open') gameMs += actual - c.durationMs;
    }
    if (cue?.kind === 'moderated') moderationMs += Math.max(0, elapsed - (cue.durationMs + (this.st.stretch[cue.id] || 0)));
    if (cue?.kind === 'open') gameMs += Math.max(0, elapsed - cue.durationMs);
    return { moderationMs, gameMs };
  }

  groupsView(cue) {
    const n = cue?.number ?? null;
    return this.groups.map((g) => ({
      id: g.id,
      label: g.label,
      short: g.short,
      selected: this.st.selections[g.id] ?? null,
      visible: n != null && n >= g.visibleFromCue && n <= g.visibleUntilCue,
      options: g.options.map((o) => ({ id: o.id, label: o.label, possible: optionPossible(o, n) })),
    }));
  }

  jumpHints(cue) {
    if (!cue || !this.rundown) return [];
    const hints = [];
    for (const g of this.groups) {
      for (const o of g.options) {
        for (const j of o.jumps || []) {
          if (j.after !== cue.number) continue;
          const to = this.rundown.byNumber.get(j.to);
          hints.push({
            group: g.short,
            option: o.label,
            to: j.to,
            toTitle: to?.title ?? '',
            selected: this.st.selections[g.id] === o.id,
            decided: this.st.selections[g.id] != null,
          });
        }
      }
    }
    return hints;
  }

  snapshot() {
    const now = this.now();
    const rd = this.rundown;
    const cue = this.currentCue();
    const jumps = this.jumps();
    let next = null;
    let nextReason = null;
    if (rd && cue) {
      const ni = nextIndex(rd, cue.index, jumps);
      next = ni >= 0 ? rd.cues[ni] : null;
      nextReason = ni >= 0 && ni !== cue.index + 1 ? 'jump' : 'sequence';
    } else if (rd && !this.st.visited.length) {
      next = rd.cues[0] || null;
      nextReason = 'start';
    }
    const stretchMs = cue ? this.st.stretch[cue.id] || 0 : 0;
    const startedAt = cue ? this.st.cueStarts[cue.id] : null;
    // Vorheriger Cue (zuletzt gelaufen) mit Ist-Dauer für die Regieansicht
    let prev = null;
    if (rd) {
      const v = this.st.visited;
      for (let i = v.length - 1; i >= 0; i--) {
        if (v[i] === this.st.currentId) continue;
        const c = rd.byId.get(v[i]);
        if (!c) break;
        const s = this.st.cueStarts[c.id] ?? null;
        const e = this.st.cueEnds[c.id] ?? null;
        const actual = c.actualDurationMs ?? (s != null && e != null ? e - s : null);
        const st = this.st.stretch[c.id] || 0;
        prev = { ...publicCue(c), startedAt: s, actualMs: actual, stretchMs: st, deltaMs: actual == null ? null : actual - c.durationMs - st };
        break;
      }
    }
    const elapsed = cue ? elapsedFor({ startedAt }, now, this.st.pausedAt) : 0;
    const effective = cue ? cue.durationMs + stretchMs : 0;
    let remaining = null;
    if (cue) {
      if (cue.kind === 'anchor' && cue.anchorAt != null) remaining = cue.anchorAt - now;
      else remaining = (cue.kind === 'open' ? cue.durationMs : effective) - elapsed;
    }
    let ctx = null;
    if (rd && cue) {
      ctx = { startIndex: cue.index, startAt: now, currentRemainingMs: remaining, currentNumber: cue.number };
    } else if (rd && !this.st.visited.length && rd.cues.length) {
      ctx = { startIndex: 0, startAt: Math.max(now, rd.cues[0].plannedStartAt ?? now), currentRemainingMs: null, currentNumber: null };
    }
    const bt = ctx ? backtime(rd, this.groups, this.st.selections, ctx) : { ends: [], anchors: [] };
    const lastOk = this.sourceStatus.lastOkAt;
    const staleForMs = lastOk == null ? null : Math.max(0, now - lastOk);
    return {
      type: 'state',
      serverTime: now,
      timeZone: this.cfg.timeZone,
      mode: this.source.mode,
      speed: this.source.speed || 1,
      rundown: rd ? { id: rd.id, title: rd.title, eventDate: rd.eventDate, cueCount: rd.cues.length } : null,
      source: {
        ok: this.sourceStatus.ok,
        stale: lastOk == null || staleForMs > this.cfg.staleAfterMs * (this.source.speed || 1),
        staleForMs,
        latencyMs: this.sourceStatus.latencyMs,
        error: this.sourceStatus.error,
        startHow: cue ? this.st.startHow[cue.id] ?? null : null,
      },
      show: {
        isRunning: this.show.isRunning,
        isPaused: this.st.pausedAt != null,
        pausedAt: this.st.pausedAt,
        showStartedAt: this.show.showStartedAt,
      },
      manual: this.st.manual,
      cue: cue ? { ...publicCue(cue), startedAt, stretchMs, effectiveMs: effective } : null,
      next: next ? publicCue(next) : null,
      prev,
      nextReason,
      signals: this.st.signals,
      message: this.st.message,
      groups: this.groupsView(cue),
      jumpHints: this.jumpHints(cue),
      balance: rd ? this.balance(now, cue, elapsed) : { moderationMs: 0, gameMs: 0 },
      backtime: bt,
      lastEvent: this.lastEvent,
    };
  }

  rundownMessage() {
    const rd = this.rundown;
    return {
      type: 'rundown',
      rundown: rd ? { id: rd.id, title: rd.title, eventDate: rd.eventDate, columns: rd.columns, cues: rd.cues.map(publicCue) } : null,
      groups: this.groups,
    };
  }

  /** Daten für den Nachbericht: gespielte Cues in Reihenfolge. */
  /**
   * Ablauf für die Rundown-Tabelle: je Cue Ist-Start/-Ende/-Dauer und Streckung aus dem
   * aktuellen Lauf, für kommende Cues die erwartete Startzeit entlang der gewählten
   * Szenarien. Cues, die der aktuelle Weg überspringt, fehlen in `eta`.
   */
  runView() {
    const rd = this.rundown;
    if (!rd) return { rundownId: null, cues: {}, eta: {}, currentId: null };
    const now = this.now();
    const cues = {};
    for (const id of new Set(this.st.visited)) {
      const c = rd.byId.get(id);
      if (!c) continue;
      const s = this.st.cueStarts[id] ?? null;
      const e = id === this.st.currentId ? null : this.st.cueEnds[id] ?? null;
      const stretch = this.st.stretch[id] || 0;
      const actual = e != null ? (c.actualDurationMs ?? (s != null ? e - s : null)) : null;
      cues[id] = { startAt: s, endAt: e, actualMs: actual, stretchMs: stretch, deltaMs: actual == null ? null : actual - c.durationMs - stretch };
    }
    for (const c of rd.cues) {
      if (cues[c.id] || c.actualDurationMs == null) continue;
      cues[c.id] = { startAt: null, endAt: null, actualMs: c.actualDurationMs, stretchMs: 0, deltaMs: c.actualDurationMs - c.durationMs };
    }
    const eta = {};
    const cur = this.currentCue();
    const jumps = this.jumps();
    let idx;
    let t;
    if (cur) {
      const start = this.st.cueStarts[cur.id] ?? now;
      const effective = cur.durationMs + (this.st.stretch[cur.id] || 0);
      const pausedFor = this.st.pausedAt != null ? now - this.st.pausedAt : 0;
      t = Math.max(now, start + effective + pausedFor);
      idx = nextIndex(rd, cur.index, jumps);
    } else {
      idx = this.st.visited.length ? -1 : 0;
      t = Math.max(now, rd.cues[0]?.plannedStartAt ?? now);
    }
    let guard = rd.cues.length + 2;
    while (idx >= 0 && guard-- > 0) {
      const c = rd.cues[idx];
      eta[c.id] = t;
      t = c.kind === 'anchor' && c.anchorAt != null ? Math.max(t, c.anchorAt) : t + c.durationMs;
      idx = nextIndex(rd, idx, jumps);
    }
    return { rundownId: rd.id, currentId: this.st.currentId, now, cues, eta };
  }

  report() {
    const rd = this.rundown;
    if (!rd) return [];
    const rows = [];
    const seen = new Set();
    for (const id of this.st.visited) {
      if (seen.has(id)) continue;
      seen.add(id);
      const c = rd.byId.get(id);
      if (!c) continue;
      const s = this.st.cueStarts[id] ?? null;
      const e = this.st.cueEnds[id] ?? null;
      const actual = c.actualDurationMs ?? (s != null && e != null ? e - s : null);
      const stretch = this.st.stretch[id] || 0;
      rows.push({
        number: c.number,
        title: c.title,
        kind: c.kind,
        block: c.block,
        plannedStartAt: c.plannedStartAt,
        actualStartAt: s,
        plannedMs: c.durationMs,
        stretchMs: stretch,
        actualMs: actual,
        deltaMs: actual == null ? null : actual - c.durationMs - stretch,
        startHow: this.st.startHow[id] ?? null,
      });
    }
    return rows;
  }
}
