import { EventEmitter } from 'node:events';

/**
 * Pollt die öffentliche Rundown-API.
 * Events: 'current' | 'full' mit { json, fetchedAt, latencyMs }, 'error' mit { kind, error, at }.
 * Der Token bleibt auf dem Server und taucht in keiner Meldung auf.
 */
export class LiveSource extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.mode = 'live';
    this.speed = 1;
    this.inflight = { current: false, full: false };
    this.fullRequested = false;
    this.timers = [];
    this.stopped = false;
  }

  now() {
    return Date.now();
  }

  url(kind) {
    return `${this.cfg.rundownBaseUrl}/api/public/rundown/${kind}?token=${encodeURIComponent(this.cfg.rundownToken)}`;
  }

  async fetchJson(kind) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await fetch(this.url(kind), {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Timeout nach ${this.cfg.requestTimeoutMs} ms`);
      throw new Error(err.cause?.code || err.message || 'Netzwerkfehler');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Steuert den Rundown im Backend über die Companion-Schnittstelle
   * (next | toggle | prev | finish). Der Token bleibt auf dem Server.
   */
  async control(action, params = {}) {
    let url = `${this.cfg.rundownBaseUrl}/api/public/companion?token=${encodeURIComponent(this.cfg.rundownToken)}&action=${encodeURIComponent(action)}`;
    // Zeitwerte im Format MM:SS (z. B. add/set), Doppelpunkt wie in der Backend-Doku unkodiert
    if (params.time && /^\d{2}:\d{2}$/.test(params.time)) url += `&time=${params.time}`;
    const send = async (method) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
      try {
        return await fetch(url, { method, signal: ctrl.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      let res = await send('GET');
      if (res.status === 404 || res.status === 405) res = await send('POST');
      const text = await res.text().catch(() => '');
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* keine JSON-Antwort */
      }
      if (!res.ok || body?.success === false || body?.ok === false) {
        const msg = body?.error || body?.message || `HTTP ${res.status}`;
        return { ok: false, error: String(msg).slice(0, 200) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'Rundown antwortet nicht' : 'Rundown nicht erreichbar' };
    } finally {
      // Sofort neu abfragen, damit alle iPads den Wechsel ohne Verzögerung sehen
      this.poll('current');
      this.requestFull?.();
    }
  }

  async poll(kind) {
    if (this.stopped) return;
    if (this.inflight[kind]) {
      if (kind === 'full') this.fullRequested = true;
      return;
    }
    this.inflight[kind] = true;
    const t0 = Date.now();
    try {
      const json = await this.fetchJson(kind);
      const t1 = Date.now();
      this.emit(kind, { json, fetchedAt: Math.round((t0 + t1) / 2), latencyMs: t1 - t0 });
    } catch (err) {
      this.emit('error', { kind, error: err.message, at: Date.now() });
    } finally {
      this.inflight[kind] = false;
      if (kind === 'full' && this.fullRequested) {
        this.fullRequested = false;
        setImmediate(() => this.poll('full'));
      }
    }
  }

  start() {
    const loop = (kind, interval) => {
      const run = async () => {
        const t = Date.now();
        await this.poll(kind);
        if (!this.stopped) this.timers.push(setTimeout(run, Math.max(0, interval - (Date.now() - t))));
      };
      run();
    };
    loop('full', this.cfg.pollFullMs);
    loop('current', this.cfg.pollCurrentMs);
  }

  requestFull() {
    this.poll('full');
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
  }
}
