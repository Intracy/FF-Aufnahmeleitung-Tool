// WebSocket zum Relay mit Zeitabgleich nach NTP-Prinzip.
// Die Anzeige rechnet jede Sekunde selbst aus Cue-Start (Showzeit) + Abgleich,
// unabhängig davon, ob gerade ein Paket ankommt.

export const perfNow = () => performance.timeOrigin + performance.now();

export class Connection extends EventTarget {
  constructor({ role, key }) {
    super();
    this.role = role;
    this.key = key;
    this.ws = null;
    this.status = 'connecting';
    this.closedAt = perfNow();
    this.lastMessageAt = null;
    this.speed = 1;
    this.sync = null; // { server, client, rtt, at }
    this.burst = null;
    this.seq = 0;
    this.backoff = 500;
    setInterval(() => this.syncBurst(), 30_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.ws || this.ws.readyState > 1) this.connect();
      else this.syncBurst();
    });
    window.addEventListener('online', () => {
      if (!this.ws || this.ws.readyState > 1) this.connect();
    });
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ role: this.role });
    if (this.key) q.set('key', this.key);
    return `${proto}://${location.host}/ws?${q}`;
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState <= 1) return;
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.backoff = 500;
      this.setStatus('open');
      this.syncBurst();
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = perfNow();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') return this.onPong(msg);
      if (msg.speed) this.speed = msg.speed;
      if (msg.type === 'state' && !this.sync) {
        this.sync = { server: msg.serverTime, client: perfNow(), rtt: Infinity, at: perfNow() };
      }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.status === 'open') this.closedAt = perfNow();
      this.setStatus('closed');
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.dispatchEvent(new CustomEvent('status', { detail: s }));
  }

  get open() {
    return this.status === 'open';
  }

  /** Wie lange schon ohne Verbindung (ms), 0 wenn verbunden. */
  offlineForMs() {
    return this.open ? 0 : perfNow() - this.closedAt;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Fünf Pings; der mit der kürzesten Laufzeit gewinnt. */
  syncBurst() {
    if (!this.open) return;
    const id = ++this.seq;
    this.burst = { id, best: null };
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.send({ type: 'ping', id, t0: perfNow() }), i * 120);
    }
    setTimeout(() => {
      if (this.burst?.id === id && this.burst.best) this.sync = this.burst.best;
    }, 1200);
  }

  onPong(m) {
    const t1 = perfNow();
    const rtt = t1 - m.t0;
    const sample = { server: m.ts, client: (m.t0 + t1) / 2, rtt, at: t1 };
    if (m.speed) this.speed = m.speed;
    if (!this.sync || this.sync.rtt === Infinity) this.sync = sample;
    if (this.burst && m.id === this.burst.id && (!this.burst.best || rtt < this.burst.best.rtt)) this.burst.best = sample;
  }

  /** Aktuelle Showzeit (Serveruhr bzw. Replay-Uhr). */
  showNow() {
    if (!this.sync) return Date.now();
    return this.sync.server + (perfNow() - this.sync.client) * this.speed;
  }

  syncInfo() {
    if (!this.sync || this.sync.rtt === Infinity) return null;
    return { rttMs: Math.round(this.sync.rtt), accuracyMs: Math.round(this.sync.rtt / 2) };
  }
}
