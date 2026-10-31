// Rundown-Modell: Cue-Arten, Zeitzonen, Szenarien, Back-Time.
// Reine Funktionen, damit sie ohne Server testbar sind.

import { derivePeople } from './people.js';

const DAY = 24 * 3600 * 1000;

export function firstLine(s) {
  return String(s ?? '').split('\n')[0].trim();
}

export function restLines(s) {
  return String(s ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ');
}

// ---------- Cue-Arten ----------

export function compileKindConfig(raw) {
  return {
    def: raw.default || 'moderated',
    rules: (raw.rules || []).map((r) => ({ kind: r.kind, re: new RegExp(r.match, r.flags ?? 'i') })),
    byNumber: raw.overrides || {},
    byId: raw.overridesById || {},
    emojiRules: (raw.emojis || []).map((r) => ({ emoji: r.emoji, re: new RegExp(r.match, r.flags ?? 'i') })),
    emojiByKind: raw.emojiByKind || {},
  };
}

export function classifyCue(cue, kc) {
  const o = kc.byId[cue.id] || kc.byNumber[String(cue.number)];
  const title = firstLine(cue.title);
  let kind = kc.def;
  let anchorTime = null;
  if (o && o.kind) {
    kind = o.kind;
    anchorTime = o.anchorTime ?? null;
  } else {
    const rule = kc.rules.find((r) => r.re.test(title));
    if (rule) kind = rule.kind;
  }
  const emoji = o?.emoji ?? kc.emojiRules?.find((r) => r.re.test(title))?.emoji ?? kc.emojiByKind?.[kind] ?? '';
  return { kind, anchorTime, emoji };
}

// ---------- Zeitzone ----------

const partsFormatters = new Map();
function wallAsUtc(epochMs, timeZone) {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

/** "2026-11-01" + "10:00:00" in Europe/Berlin → Epoch-Millisekunden. */
export function zonedToEpoch(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s = 0] = timeStr.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc - (wallAsUtc(asUtc, timeZone) - asUtc);
  guess = asUtc - (wallAsUtc(guess, timeZone) - guess);
  return guess;
}

/** Datum (YYYY-MM-DD) eines Zeitpunkts in einer Zeitzone. */
export function zonedDate(epochMs, timeZone) {
  const w = new Date(wallAsUtc(epochMs, timeZone));
  return w.toISOString().slice(0, 10);
}

/** Akzeptiert ISO-Strings mit Datum, Epoch-ms oder Epoch-s. Uhrzeiten ohne Datum → null. */
export function parseTimestamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ---------- Rundown ----------

/** Eigene Spalten des Rundowns (z. B. GFX, Ort, Ton): nur befüllte Textwerte. */
function cleanColumns(cols) {
  const out = {};
  if (!cols || typeof cols !== 'object') return out;
  for (const [k, v] of Object.entries(cols)) {
    if (v == null) continue;
    const t = String(v).trim();
    if (t) out[String(k).slice(0, 60)] = t.slice(0, 500);
  }
  return out;
}

/** Baut aus der /full-Antwort das interne Modell. */
/**
 * @param {{hosts?: string[]}} [opts]  Moderationsnamen für die Personen-Erkennung
 */
export function buildRundown(full, kc, timeZone, opts = {}) {
  const r = full.rundown || {};
  const cues = [];
  let block = null;
  let prev = null;
  for (const el of full.elements || []) {
    if (el.type === 'block') {
      block = { id: el.id, title: firstLine(el.title) };
      continue;
    }
    if (el.type !== 'cue') continue;
    const { kind, anchorTime, emoji } = classifyCue(el, kc);
    let plannedStartAt = null;
    if (el.plannedStart && r.eventDate) {
      plannedStartAt = zonedToEpoch(r.eventDate, el.plannedStart, timeZone);
      if (prev?.plannedStartAt != null) {
        while (plannedStartAt < prev.plannedStartAt - DAY / 2) plannedStartAt += DAY;
      }
    }
    let anchorAt = null;
    if (anchorTime && r.eventDate) {
      anchorAt = zonedToEpoch(r.eventDate, anchorTime, timeZone);
      if (plannedStartAt != null) while (anchorAt < plannedStartAt - DAY / 2) anchorAt += DAY;
    }
    const cue = {
      id: el.id,
      number: el.number,
      index: cues.length,
      title: firstLine(el.title),
      subtitle: restLines(el.title),
      notes: (el.notes || '').trim(),
      color: el.color || null,
      kind,
      emoji,
      durationMs: Math.max(0, Number(el.durationSeconds) || 0) * 1000,
      actualDurationMs: el.actualDurationSeconds != null ? Number(el.actualDurationSeconds) * 1000 : null,
      plannedStartAt,
      anchorAt,
      block: block?.title ?? null,
      blockId: block?.id ?? null,
      columns: cleanColumns(el.columns),
      isActive: !!el.isActive,
    };
    cues.push(cue);
    prev = cue;
  }
  // Personen aus GFX- und Personen-Spalten (Moderation / Gäste)
  derivePeople(cues, opts).forEach((list, i) => (cues[i].people = list));
  return {
    id: r.id ?? null,
    title: r.title ?? '',
    eventDate: r.eventDate ?? null,
    startTime: r.startTime ?? null,
    status: r.status ?? null,
    currentItemId: full.currentItemId ?? null,
    columns: (full.columns || []).map((c) => String(c?.name ?? '')).filter(Boolean),
    cues,
    byId: new Map(cues.map((c) => [c.id, c])),
    byNumber: new Map(cues.map((c) => [c.number, c])),
  };
}

/** Kompakte Cue-Liste für die Clients. */
export function publicCue(c) {
  if (!c) return null;
  return {
    id: c.id,
    number: c.number,
    title: c.title,
    subtitle: c.subtitle,
    notes: c.notes,
    color: c.color,
    kind: c.kind,
    emoji: c.emoji,
    durationMs: c.durationMs,
    plannedStartAt: c.plannedStartAt,
    anchorAt: c.anchorAt,
    block: c.block,
    columns: c.columns,
    people: c.people || [],
  };
}

// ---------- Szenarien ----------

export function jumpMap(groups, selections) {
  const m = new Map();
  for (const g of groups) {
    const opt = g.options.find((o) => o.id === selections[g.id]);
    if (!opt) continue;
    for (const j of opt.jumps || []) m.set(j.after, j.to);
  }
  return m;
}

export function nextIndex(rd, idx, jumps) {
  const cue = rd.cues[idx];
  if (!cue) return -1;
  const to = jumps.get(cue.number);
  if (to != null) {
    const t = rd.byNumber.get(to);
    if (t) return t.index;
  }
  return idx + 1 < rd.cues.length ? idx + 1 : -1;
}

/** Ist eine Option nach Cue-Nummer noch möglich? Ein übersprungener Sprung macht sie unmöglich. */
export function optionPossible(opt, currentNumber) {
  if (currentNumber == null) return true;
  return (opt.jumps || []).every((j) => currentNumber <= j.after || currentNumber >= j.to);
}

function cartesian(lists) {
  return lists.reduce((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
}

/**
 * Projiziert das Ende ab einem Cue.
 * Anker-Cues enden frühestens zu ihrer Ankerzeit (Puffer schluckt Vorlauf).
 */
export function project(rd, startIndex, startAt, jumps, currentRemainingMs = null) {
  let t = startAt;
  let idx = startIndex;
  const anchors = [];
  let first = true;
  let guard = rd.cues.length + 2;
  while (idx >= 0 && guard-- > 0) {
    const c = rd.cues[idx];
    const isAnchor = c.kind === 'anchor' && c.anchorAt != null;
    if (first && currentRemainingMs != null) {
      t = isAnchor ? Math.max(t, c.anchorAt) : t + Math.max(0, currentRemainingMs);
    } else if (isAnchor) {
      anchors.push({ number: c.number, anchorAt: c.anchorAt, arriveAt: t, bufferMs: c.anchorAt - t });
      t = Math.max(t, c.anchorAt);
    } else {
      t += c.durationMs;
    }
    first = false;
    idx = nextIndex(rd, idx, jumps);
  }
  return { endAt: t, anchors };
}

/**
 * Back-Time über alle offenen Szenarien.
 * ctx: { startIndex, startAt, currentRemainingMs, currentNumber }
 * Liefert sortierte Enden mit Label der Optionen, die zu diesem Ende führen,
 * plus Anker-Puffer und Abweichung zum Plan desselben Szenarios.
 */
export function backtime(rd, groups, selections, ctx) {
  if (!rd || ctx.startIndex == null || ctx.startIndex < 0) return { ends: [], anchors: [] };
  const cur = ctx.currentNumber;
  const undecided = groups.filter(
    (g) => !selections[g.id] && g.options.some((o) => (o.jumps || []).some((j) => cur == null || j.after >= cur)),
  );
  const optionLists = undecided.map((g) => g.options.filter((o) => optionPossible(o, cur)));
  const combos = cartesian(optionLists);
  const first = rd.cues[0];
  const planStart = first?.plannedStartAt ?? ctx.startAt;

  const results = combos.map((combo) => {
    const sel = { ...selections };
    combo.forEach((o, i) => (sel[undecided[i].id] = o.id));
    const jumps = jumpMap(groups, sel);
    const p = project(rd, ctx.startIndex, ctx.startAt, jumps, ctx.currentRemainingMs);
    const plan = project(rd, 0, planStart, jumps, null);
    return { combo, endAt: p.endAt, plannedEndAt: plan.endAt, anchors: p.anchors };
  });

  const label = (rs) => {
    const parts = [];
    undecided.forEach((g, i) => {
      const ids = new Set(rs.map((r) => r.combo[i].id));
      if (ids.size < optionLists[i].length) {
        parts.push(g.options.filter((o) => ids.has(o.id)).map((o) => o.label).join('/'));
      }
    });
    return parts.join(' · ');
  };

  const groupBy = (keyFn) => {
    const m = new Map();
    for (const r of results) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  const ends = [...groupBy((r) => Math.round(r.endAt / 1000)).values()]
    .map((rs) => ({ endAt: rs[0].endAt, deltaMs: rs[0].endAt - rs[0].plannedEndAt, label: label(rs) }))
    .sort((a, b) => a.endAt - b.endAt);

  const anchorNumbers = [...new Set(results.flatMap((r) => r.anchors.map((a) => a.number)))];
  const anchors = anchorNumbers.map((number) => {
    const byBuffer = new Map();
    for (const r of results) {
      const a = r.anchors.find((x) => x.number === number);
      if (!a) continue;
      const k = Math.round(a.bufferMs / 1000);
      if (!byBuffer.has(k)) byBuffer.set(k, { a, rs: [] });
      byBuffer.get(k).rs.push(r);
    }
    const variants = [...byBuffer.values()]
      .map(({ a, rs }) => ({ bufferMs: a.bufferMs, arriveAt: a.arriveAt, label: label(rs) }))
      .sort((x, y) => x.bufferMs - y.bufferMs);
    const anchorAt = results.find((r) => r.anchors.some((x) => x.number === number)).anchors.find((x) => x.number === number).anchorAt;
    return { number, anchorAt, variants };
  });

  return { ends, anchors };
}
