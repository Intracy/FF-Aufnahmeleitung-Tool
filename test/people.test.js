import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeopleText, derivePeople, looksLikeName } from '../server/people.js';

const names = (list) => list.map((p) => `${p.name}:${p.role}`);

test('GFX: Rollen-Präfixe, Klammern und Trennzeichen', () => {
  assert.deepEqual(names(parsePeopleText('Moderation: Anna Beispiel, Ben Muster\nGast: Carla Probe')), [
    'Anna Beispiel:host',
    'Ben Muster:host',
    'Carla Probe:guest',
  ]);
  assert.deepEqual(names(parsePeopleText('LT: Dana Test (Gast) & Emil Probe (Mod)')), ['Dana Test:guest', 'Emil Probe:host']);
  assert.deepEqual(names(parsePeopleText('Bauchbinde Felix von Beispiel – Moderation')), []); // ohne Doppelpunkt kein Präfix
  assert.deepEqual(names(parsePeopleText('Bauchbinde: Felix von Beispiel – Moderation')), ['Felix von Beispiel:host']);
  assert.deepEqual(names(parsePeopleText('HandOfBlood / Anna-Lena Meier')), ['HandOfBlood:null', 'Anna-Lena Meier:null']);
});

test('GFX: Grafik-Begriffe sind keine Personen', () => {
  assert.deepEqual(parsePeopleText('Logo, Countdown, Scoreboard'), []);
  assert.deepEqual(parsePeopleText('Fullscreen Bracket'), []);
  assert.deepEqual(parsePeopleText('QR-Code Gewinnspiel'), []);
  assert.equal(looksLikeName('Winner MAZ 2026'), false);
  assert.equal(looksLikeName('https://x.de'), false);
  assert.equal(looksLikeName('Jörg Müller'), true);
});

test('Moderation aus Häufigkeit, Liste und ausdrücklicher Nennung', () => {
  const cues = [
    { columns: { GFX: 'Anna Beispiel, Ben Muster' } },
    { columns: { GFX: 'Anna Beispiel, Ben Muster, Carla Probe' } },
    { columns: { GFX: 'Anna Beispiel, Ben Muster' } },
    { columns: { GFX: 'Anna Beispiel, Dana Test' } },
    { columns: { GFX: 'Logo' } },
    { columns: { GFX: 'Emil Probe (Moderation)' } },
    { columns: { GFX: 'Fritz Probe' } },
  ];
  const p = derivePeople(cues);
  assert.deepEqual(names(p[1]), ['Anna Beispiel:host', 'Ben Muster:host', 'Carla Probe:guest']);
  assert.deepEqual(names(p[3]), ['Anna Beispiel:host', 'Dana Test:guest']);
  assert.deepEqual(p[4], []);
  assert.deepEqual(names(p[5]), ['Emil Probe:host']);
  // Liste macht Fritz zur Moderation
  assert.deepEqual(names(derivePeople(cues, { hosts: ['fritz probe'] })[6]), ['Fritz Probe:host']);
});

test('Personen-Spalten: Moderation und Gäste getrennt', () => {
  const p = derivePeople([{ columns: { Moderation: 'Anna Beispiel', Gäste: 'Carla Probe, Dana Test', Ort: 'Bühne' } }]);
  assert.deepEqual(names(p[0]), ['Anna Beispiel:host', 'Carla Probe:guest', 'Dana Test:guest']);
});

test('Gästeliste schlägt Häufigkeit und ausdrückliche Moderation', () => {
  const cues = [1, 2, 3, 4].map(() => ({ columns: { GFX: 'Anna Beispiel, Emil Probe (Moderation)' } }));
  const p = derivePeople(cues, { guests: ['Anna Beispiel', 'emil probe'] });
  assert.deepEqual(names(p[0]), ['Anna Beispiel:guest', 'Emil Probe:guest']);
});
