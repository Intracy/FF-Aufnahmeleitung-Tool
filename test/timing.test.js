import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, stagesFor, formatSignDigits, formatSigned, formatClock } from '../public/js/shared/timing.js';

const base = { hasCue: true, kind: 'moderated', now: 0, signals: {} };
const at = (durationS, elapsedS, extra = {}) => evaluate({ ...base, durationMs: durationS * 1000, elapsedMs: elapsedS * 1000, ...extra });

test('Stufen relativ zur Cue-Länge (höchstens halbe Planlänge)', () => {
  const s = (d) => [stagesFor(d * 1000).stages.map((x) => x / 1000), stagesFor(d * 1000).wrap];
  assert.deepEqual(s(600), [[300, 120, 60, 30], true]);
  assert.deepEqual(s(300), [[120, 60, 30], true]);
  assert.deepEqual(s(180), [[60, 30], true]);
  assert.deepEqual(s(60), [[30], true]);
  assert.deepEqual(s(30), [[], true]);
  assert.deepEqual(s(15), [[], false]);
});

test('Zustandsautomat moderiert: läuft → Stufe → Abrunden → Überzogen', () => {
  assert.equal(at(300, 100).state, 'run');
  assert.equal(at(300, 190).state, 'step');
  assert.equal(at(300, 190).word, 'NOCH 2');
  assert.equal(at(300, 245).word, 'NOCH 1');
  assert.equal(at(300, 275).word, '30 SEK');
  assert.equal(at(300, 292).state, 'wrap');
  const o = at(300, 312);
  assert.equal(o.state, 'over');
  assert.equal(o.word, 'ÜBER');
  assert.equal(Math.round(o.digitsMs / 1000), 12);
});

test('Signale: SCHLUSS schlägt alles, STRECKEN blinkt kurz, ABRUNDEN erzwingt', () => {
  assert.equal(at(300, 10, { signals: { cut: true } }).state, 'cut');
  assert.equal(at(300, 10, { signals: { wrap: true } }).state, 'wrap');
  assert.equal(at(300, 10, { now: 5000, signals: { stretchAt: 4000 } }).state, 'stretch');
  assert.equal(at(300, 10, { now: 9000, signals: { stretchAt: 4000 } }).state, 'run');
});

test('Zuspieler: GLEICH DU 15 s vor einem moderierten Cue, sonst neutral', () => {
  assert.equal(at(60, 50, { kind: 'fixed', nextKind: 'moderated' }).state, 'standby');
  assert.equal(at(60, 50, { kind: 'fixed', nextKind: 'fixed' }).state, 'neutral');
  assert.equal(at(60, 20, { kind: 'fixed', nextKind: 'moderated' }).state, 'neutral');
});

test('Offene Cues zählen hoch, ohne Alarm', () => {
  const r = at(2400, 2700, { kind: 'open' });
  assert.equal(r.state, 'dark');
  assert.equal(r.countUp, true);
  assert.equal(Math.round(r.digitsMs / 1000), 2700);
});

test('Anker zählt auf die Uhrzeit', () => {
  const r = evaluate({ ...base, kind: 'anchor', durationMs: 300e3, elapsedMs: 0, anchorAt: 90e3, now: 0 });
  assert.equal(r.remainingMs, 90e3);
  assert.equal(r.word, 'PAUSE');
});

test('Schild-Formate: MM:SS ab 10 min, M:SS, nur Sekunden unter 1 min', () => {
  assert.deepEqual(formatSignDigits(754e3), { text: '12:34', fmt: 'mmss' });
  assert.deepEqual(formatSignDigits(107e3), { text: '1:47', fmt: 'mss' });
  assert.deepEqual(formatSignDigits(8200), { text: '09', fmt: 'ss' }); // Countdown rundet auf
  assert.deepEqual(formatSignDigits(8900, true), { text: '08', fmt: 'ss' }); // Hochzählen rundet ab
  assert.equal(formatSignDigits(3725e3).fmt, 'hmmss');
});

test('Saldo-Format', () => {
  assert.equal(formatSigned(80e3), '+1:20');
  assert.equal(formatSigned(-45e3), '−0:45');
  assert.equal(formatSigned(200), '±0:00');
  assert.equal(formatClock(61e3), '1:01');
});
