// Kompletter Rundown als Tabelle (Sheet). Öffnet sich per Tipp auf den Cue-Kasten.
// Vergangene Cues mit Ist-Zeiten, der aktuelle hervorgehoben, kommende mit erwarteter
// Startzeit entlang der gewählten Szenarien. Daten: /api/rundown (Plan) + /api/runview (Lauf).

import { KINDS, formatDuration, formatSigned, formatTimeOfDay, formatClock } from '../shared/timing.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class RundownSheet {
  /**
   * @param {object} o
   * @param {HTMLDialogElement} o.dialog
   * @param {() => any} o.getRundown   Plan (Cues, Spalten)
   * @param {() => any} o.getState     aktueller Zustand (für currentId, Zeitzone)
   * @param {() => number} o.now       Showzeit
   * @param {() => Promise<any>} o.fetchRun  Laufdaten vom Relay
   */
  constructor(o) {
    Object.assign(this, o);
    this.body = this.dialog.querySelector('#rd-body');
    this.scroll = this.dialog.querySelector('.rd-scroll');
    this.info = this.dialog.querySelector('#rd-info');
    this.hint = this.dialog.querySelector('#rd-hint');
    this.run = null;
    this.timer = null;
    this.tick = null;
    this.renderedKey = '';
    this.dialog.querySelector('#rd-jump').addEventListener('click', () => this.scrollToCurrent(true));
    this.dialog.addEventListener('close', () => this.stop());
    // Tippen neben das Sheet schließt es (wie in iPadOS)
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
  }

  async open() {
    this.renderedKey = '';
    this.render();
    this.dialog.showModal();
    requestAnimationFrame(() => this.scrollToCurrent(false));
    await this.refresh();
    this.scrollToCurrent(false);
    this.timer = setInterval(() => this.refresh(), 5000);
    this.tick = setInterval(() => this.live(), 500);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.tick);
  }

  async refresh() {
    try {
      this.run = await this.fetchRun();
      this.hint.hidden = true;
    } catch {
      this.hint.hidden = false;
      this.hint.textContent = 'Keine Verbindung zum Relay – Ist-Zeiten und Prognose fehlen.';
    }
    this.render();
  }

  currentId() {
    return this.getState()?.cue?.id ?? this.run?.currentId ?? null;
  }

  /** Neu zeichnen, wenn sich Lauf oder aktueller Cue geändert haben. */
  render() {
    const rd = this.getRundown();
    const tz = this.getState()?.timeZone || 'Europe/Berlin';
    const cur = this.currentId();
    if (!rd?.cues?.length) {
      this.body.innerHTML = '<tr><td colspan="6" class="rd-empty">Noch kein Rundown geladen.</td></tr>';
      return;
    }
    // Läuft ein anderer Cue als in den Laufdaten, gleich nachladen.
    if (this.run && cur !== this.run.currentId && this.dialog.open && !this.pendingRefresh) {
      this.pendingRefresh = true;
      this.refresh().finally(() => (this.pendingRefresh = false));
    }
    const key = JSON.stringify([rd.id, rd.cues.length, cur, this.run?.now ? Math.floor(this.run.now / 5000) : 0]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    const run = this.run || { cues: {}, eta: {} };
    const curIndex = rd.cues.findIndex((c) => c.id === cur);
    const t = (ms, sec = true) => formatTimeOfDay(ms, tz, sec);
    const rows = [];
    let block = undefined;
    let done = 0;

    for (const [i, c] of rd.cues.entries()) {
      if (c.block !== block) {
        block = c.block;
        if (block) rows.push(`<tr class="rd-block"><th colspan="6" scope="rowgroup">${esc(block)}</th></tr>`);
      }
      const r = run.cues?.[c.id];
      const eta = run.eta?.[c.id];
      let status;
      if (c.id === cur) status = 'current';
      else if (r?.endAt != null || (r?.actualMs != null && r.startAt == null)) status = 'past';
      else if (eta != null) status = 'next';
      else if (curIndex >= 0 && i < curIndex) status = 'past'; // vor dem aktuellen Cue (ohne Ist-Daten)
      else status = this.run ? 'skipped' : 'next'; // liegt nicht auf dem gewählten Szenario-Weg
      if (status === 'past') done++;

      const cols = Object.entries(c.columns || {})
        .map(([k, v]) => `<span class="rd-chip"><b>${esc(k)}</b> ${esc(v)}</span>`)
        .join('');
      const notes = c.notes ? `<div class="rd-notes">${esc(c.notes)}</div>` : '';
      const sub = c.subtitle ? `<div class="rd-sub">${esc(c.subtitle)}</div>` : '';
      const kind = c.kind && KINDS[c.kind] ? `<span class="rd-kind k-${esc(c.kind)}">${KINDS[c.kind]}</span>` : '';
      const anchor = c.kind === 'anchor' && c.anchorAt != null ? `<span class="rd-kind k-anchor">bis ${t(c.anchorAt)}</span>` : '';
      const stretch = r?.stretchMs ? `<div class="rd-stretch">+${formatDuration(r.stretchMs)}</div>` : '';

      let when = '';
      let delta = '';
      if (status === 'current') {
        when = `<div>${r?.startAt != null ? t(r.startAt) : '–'}</div><div class="rd-now-label">JETZT</div>`;
        delta = `<div class="rd-live" data-start="${r?.startAt ?? ''}" data-eff="${c.durationMs + (r?.stretchMs || 0)}"></div>`;
      } else if (status === 'past') {
        when = r?.startAt != null ? t(r.startAt) : '<span class="rd-dim">–</span>';
        if (r?.actualMs != null) {
          const d = r.deltaMs ?? 0;
          const cls = d > 999 ? 'over' : d < -999 ? 'under' : 'even';
          delta = `<div>${formatDuration(r.actualMs)}</div><div class="rd-delta ${cls}">${Math.abs(d) < 1000 ? '±0:00' : formatSigned(d)}</div>`;
        }
      } else if (status === 'next') {
        when = eta != null ? `<span class="rd-eta">~${t(eta)}</span>` : '';
      } else {
        when = '<span class="rd-skip">entfällt</span>';
      }

      rows.push(`<tr class="rd-row ${status}" data-id="${esc(c.id)}"${status === 'current' ? ' aria-current="true"' : ''}>
  <td class="rd-num"><span class="rd-stripe" style="${c.color ? `background:${esc(c.color)}` : ''}"></span>${esc(c.number ?? '')}</td>
  <td class="rd-cue"><div class="rd-title">${c.emoji ? `<span class="rd-emoji">${esc(c.emoji)}</span>` : ''}${esc(c.title)}</div>${sub}<div class="rd-meta">${kind}${anchor}${cols}</div>${notes}</td>
  <td class="rd-plan">${c.plannedStartAt != null ? t(c.plannedStartAt) : '–'}</td>
  <td class="rd-dur">${formatDuration(c.durationMs)}${stretch}</td>
  <td class="rd-when">${when}</td>
  <td class="rd-delta-cell">${delta}</td>
</tr>`);
    }
    this.body.innerHTML = rows.join('');
    const total = rd.cues.length;
    const pos = curIndex >= 0 ? `Cue ${rd.cues[curIndex].number} · ` : '';
    this.info.textContent = `${rd.title || 'Rundown'} · ${pos}${done} von ${total} gelaufen`;
    this.live();
  }

  /** Laufende Zeit im aktuellen Cue (Restzeit bzw. Überzug) sekündlich aktualisieren. */
  live() {
    if (!this.dialog.open) return;
    this.render();
    const el = this.body.querySelector('.rd-live');
    if (!el) return;
    const start = Number(el.dataset.start);
    const eff = Number(el.dataset.eff);
    if (!el.dataset.start || !Number.isFinite(start)) {
      el.textContent = '';
      return;
    }
    const left = eff - (this.now() - start);
    el.className = `rd-live ${left < 0 ? 'over' : ''}`;
    el.textContent = left < 0 ? `+${formatClock(-left, true)}` : formatClock(left);
  }

  scrollToCurrent(smooth) {
    const row = this.body.querySelector('tr.current');
    if (!row) return;
    const top = row.offsetTop - this.scroll.clientHeight / 2 + row.offsetHeight / 2;
    this.scroll.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }
}
