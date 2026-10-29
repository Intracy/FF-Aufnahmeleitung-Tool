import { EventEmitter } from 'node:events';
import { readJson } from '../config.js';
import { buildRundown, nextIndex } from '../model.js';

/**
 * Spielt einen Rundown-Schnappschuss ab und liefert dieselben Antworten wie die API.
 * Die Uhr läuft im Showtag (virtuelle Zeit), optional beschleunigt.
 * Die Regie folgt dabei den Szenario-Entscheidungen der AL (getJumps).
 */
export class ReplaySource extends EventEmitter {
  constructor(cfg, { kindConfig, getJumps = () => new Map(), fixture = null }) {
    super();
    this.cfg = cfg;
    this.mode = 'replay';
    this.fixture = fixture || readJson(cfg.replayFile);
    this.rd = buildRundown(this.fixture, kindConfig, cfg.timeZone);
    this.rawById = new Map(this.fixture.elements.map((e) => [e.id, e]));
    this.getJumps = getJumps;
    this.speed = cfg.replaySpeed > 0 ? cfg.replaySpeed : 1;
    this.jitter = cfg.replayJitter ?? 0.15;
    this.timers = [];
    this.actual = new Map();
    const start = this.rd.byNumber.get(cfg.replayStartCue) || this.rd.cues[0];
    const planned = start.plannedStartAt ?? Date.now();
    this.v0 = planned + (cfg.replayStartOffsetS || 0) * 1000;
    this.r0 = Date.now();
    this.idx = start.index;
    this.cueStartV = planned;
    this.showStartV = this.rd.cues[0]?.plannedStartAt ?? planned;
    this.hold = !!cfg.replayHold;
    this.paused = false;
    this.pausedAtV = null;
  }

  /** Steuerung wie die Companion-Schnittstelle des Backends (für Tests und Proben). */
  async control(action, params = {}) {
    this.tick();
    const now = this.now();
    const cur = this.rd.cues[this.idx];
    const closeCur = () => {
      if (cur) this.actual.set(cur.id, now - this.cueStartV);
    };
    if (action === 'toggle') {
      if (!cur) return { ok: false, error: 'Show läuft nicht' };
      if (this.paused) {
        this.cueStartV += now - this.pausedAtV;
        this.paused = false;
        this.pausedAtV = null;
      } else {
        this.paused = true;
        this.pausedAtV = now;
      }
    } else if (action === 'next') {
      if (this.paused) return { ok: false, error: 'Pausiert – erst fortsetzen' };
      closeCur();
      if (!cur) {
        this.idx = 0;
        this.actual.clear();
        this.showStartV = now;
      } else this.idx = nextIndex(this.rd, this.idx, this.getJumps());
      this.cueStartV = now;
    } else if (action === 'prev') {
      if (!cur || this.idx <= 0) return { ok: false, error: 'Kein vorheriger Cue' };
      this.idx -= 1;
      this.cueStartV = now;
      this.paused = false;
    } else if (action === 'add' || action === 'set') {
      if (!cur) return { ok: false, error: 'Show läuft nicht' };
      const m = /^(\d{2}):(\d{2})$/.exec(params.time || '');
      if (!m) return { ok: false, error: 'Zeit fehlt' };
      const ms = (Number(m[1]) * 60 + Number(m[2])) * 1000;
      const raw = this.rawById.get(cur.id);
      const newMs = action === 'add' ? cur.durationMs + ms : Math.max(0, now - this.cueStartV) + ms;
      cur.durationMs = newMs;
      this.jitterOff ||= new Set();
      this.jitterOff.add(cur.id);
      this.rawById.set(cur.id, { ...raw, durationSeconds: Math.round(newMs / 1000) });
      this.fixture = { ...this.fixture, elements: this.fixture.elements.map((e) => (e.id === cur.id ? { ...e, durationSeconds: Math.round(newMs / 1000) } : e)) };
    } else if (action === 'finish') {
      closeCur();
      this.idx = -1;
      this.paused = false;
    } else return { ok: false, error: 'Unbekannte Aktion' };
    this.emitCurrent();
    this.emitFull();
    return { ok: true };
  }

  now() {
    return this.v0 + (Date.now() - this.r0) * this.speed;
  }

  /** Deterministische Streuung je Cue, damit Überzug und Puffer sichtbar werden. */
  durationOf(c) {
    if (c.kind === 'anchor' && c.anchorAt != null) return null;
    if (c.kind === 'fixed' || this.jitter <= 0 || this.jitterOff?.has(c.id)) return c.durationMs;
    let h = 2166136261;
    for (const ch of String(c.number * 7919)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const r = ((h >>> 0) % 1000) / 1000;
    const bias = c.kind === 'moderated' ? 0.35 : 0;
    return Math.round(c.durationMs * (1 + this.jitter * (2 * r - 1 + bias)));
  }

  tick() {
    if (this.hold || this.paused) return;
    const now = this.now();
    let guard = this.rd.cues.length + 2;
    while (this.idx >= 0 && guard-- > 0) {
      const c = this.rd.cues[this.idx];
      const d = this.durationOf(c);
      const endV = d == null ? Math.max(c.anchorAt, this.cueStartV) : this.cueStartV + d;
      if (now < endV) break;
      this.actual.set(c.id, endV - this.cueStartV);
      this.cueStartV = endV;
      this.idx = nextIndex(this.rd, this.idx, this.getJumps());
    }
  }

  jump(number) {
    const c = this.rd.byNumber.get(Number(number));
    if (!c) return false;
    this.tick();
    const cur = this.rd.cues[this.idx];
    if (cur) this.actual.set(cur.id, this.now() - this.cueStartV);
    this.idx = c.index;
    this.cueStartV = this.now();
    this.emitCurrent();
    this.emitFull();
    return true;
  }

  currentPayload() {
    this.tick();
    const cue = this.rd.cues[this.idx] || null;
    const running = !!cue;
    const ni = cue ? nextIndex(this.rd, cue.index, this.getJumps()) : -1;
    const next = ni >= 0 ? this.rd.cues[ni] : null;
    const iso = (t) => new Date(t).toISOString();
    return {
      rundown: { id: this.rd.id, title: this.rd.title, status: running ? 'live' : 'done' },
      isRunning: running,
      isPaused: this.paused,
      showStartedAt: iso(this.showStartV),
      liveSinceSeconds: cue ? Math.floor((this.now() - this.cueStartV) / 1000) : null,
      current: cue ? { ...this.rawById.get(cue.id), isActive: true, startedAt: iso(this.cueStartV) } : null,
      next: next ? { ...this.rawById.get(next.id) } : null,
      position: cue ? cue.index + 1 : 0,
      totalCues: this.rd.cues.length,
    };
  }

  fullPayload() {
    this.tick();
    const cur = this.rd.cues[this.idx];
    return {
      ...this.fixture,
      currentItemId: cur ? cur.id : null,
      isRunning: !!cur,
      elements: this.fixture.elements.map((e) => ({
        ...e,
        isActive: !!cur && e.id === cur.id,
        actualDurationSeconds: this.actual.has(e.id) ? Math.round(this.actual.get(e.id) / 1000) : null,
      })),
    };
  }

  emitCurrent() {
    this.emit('current', { json: this.currentPayload(), fetchedAt: this.now(), latencyMs: 0 });
  }

  emitFull() {
    this.emit('full', { json: this.fullPayload(), fetchedAt: this.now(), latencyMs: 0 });
  }

  start() {
    this.emitFull();
    this.emitCurrent();
    this.timers.push(setInterval(() => this.emitCurrent(), this.cfg.pollCurrentMs));
    this.timers.push(setInterval(() => this.emitFull(), this.cfg.pollFullMs));
  }

  requestFull() {
    setImmediate(() => this.emitFull());
  }

  stop() {
    this.timers.forEach(clearInterval);
  }
}
