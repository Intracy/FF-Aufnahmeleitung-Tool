import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, ROOT } from '../server/config.js';
import { compileKindConfig, buildRundown, backtime, zonedToEpoch, jumpMap, nextIndex, optionPossible } from '../server/model.js';
import path from 'node:path';

const TZ = 'Europe/Berlin';
const kc = compileKindConfig(readJson(path.join(ROOT, 'config/cue-kinds.json')));
const groups = readJson(path.join(ROOT, 'config/scenarios.json')).groups;
const fixture = readJson(path.join(ROOT, 'fixtures/ff-offline-finale-2026.json'));
const rd = buildRundown(fixture, kc, TZ);
const hms = (t) => new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(t);
const cue = (n) => rd.byNumber.get(n);

test('Zeitzone: 01.11.2026 ist MEZ (UTC+1)', () => {
  assert.equal(zonedToEpoch('2026-11-01', '10:00:00', TZ), Date.UTC(2026, 10, 1, 9, 0, 0));
  assert.equal(zonedToEpoch('2026-07-01', '10:00:00', TZ), Date.UTC(2026, 6, 1, 8, 0, 0));
});

test('Rundown: 154 Cues, Planzeiten stimmen', () => {
  assert.equal(rd.cues.length, 154);
  assert.equal(hms(cue(65).plannedStartAt), '15:40:15');
  assert.equal(hms(cue(154).plannedStartAt), '21:47:30');
  assert.equal(cue(59).subtitle, 'Gast Gewinner Team');
});

test('Cue-Arten aus Titel und Overrides', () => {
  const k = (n) => cue(n).kind;
  assert.equal(k(3), 'fixed'); // TLC Presenter
  assert.equal(k(5), 'moderated'); // Begrüßung
  assert.equal(k(21), 'special'); // Einlauf Teams
  assert.equal(k(27), 'open'); // Draft Sup3 Game 1
  assert.equal(k(29), 'open'); // SuP3 Game 1
  assert.equal(k(36), 'moderated'); // Analyse SuP3 Game 1 – nicht "open"
  assert.equal(k(33), 'fixed'); // PAUSE
  assert.equal(k(61), 'fixed'); // Countdown Pause
  assert.equal(k(65), 'anchor');
  assert.equal(hms(cue(65).anchorAt), '15:45:15');
  assert.equal(k(62), 'special'); // Noris Liga
});

test('Sprünge folgen der Szenario-Wahl', () => {
  const j = jumpMap(groups, { finale: '3-0' });
  assert.equal(rd.cues[nextIndex(rd, cue(112).index, j)].number, 142);
  assert.equal(rd.cues[nextIndex(rd, cue(112).index, new Map())].number, 113);
  assert.equal(optionPossible(groups[1].options[0], 115), false); // 3:0 nach Cue 112 verpasst
  assert.equal(optionPossible(groups[1].options[1], 115), true);
});

test('Back-Time vor Showstart: Finale endet 19:32:30 / 20:33:50 / 21:47:30', () => {
  const bt = backtime(rd, groups, {}, { startIndex: 0, startAt: cue(1).plannedStartAt, currentRemainingMs: null, currentNumber: null });
  assert.deepEqual(
    bt.ends.map((e) => [e.label, hms(e.endAt), e.deltaMs]),
    [
      ['3:0', '19:32:30', 0],
      ['3:1', '20:33:50', 0],
      ['3:2', '21:47:30', 0],
    ],
  );
  // Anker schluckt SuP3 2:0: Puffer 5:00 (2:1) bzw. 66:20 (2:0)
  const a = bt.anchors.find((x) => x.number === 65);
  assert.deepEqual(
    a.variants.map((v) => [v.label, v.bufferMs / 1000]),
    [
      ['2:1', 300],
      ['2:0', 3980],
    ],
  );
});

test('Back-Time verschiebt sich mit Überzug, Anker fängt ihn ab', () => {
  // Cue 59 (10 min) läuft 2 min über: Ende des Finales unverändert, Puffer bis Anker 2 min kleiner.
  const c = cue(59);
  const now = c.plannedStartAt + 12 * 60e3;
  const bt = backtime(rd, groups, {}, { startIndex: c.index, startAt: now, currentRemainingMs: -120e3, currentNumber: 59 });
  assert.equal(hms(bt.ends.at(-1).endAt), '21:47:30');
  assert.equal(bt.anchors[0].variants[0].bufferMs / 1000, 300 - 120);
});

test('Back-Time im Finale: Überzug verschiebt das Ende', () => {
  const c = cue(119);
  const now = c.plannedStartAt + 330e3; // 30 s über
  const bt = backtime(rd, groups, { finale: '3-2' }, { startIndex: c.index, startAt: now, currentRemainingMs: -30e3, currentNumber: 119 });
  assert.equal(bt.ends.length, 1);
  assert.equal(hms(bt.ends[0].endAt), '21:48:00');
  assert.equal(bt.ends[0].deltaMs, 30e3);
});
