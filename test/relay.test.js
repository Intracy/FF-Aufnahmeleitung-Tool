import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readJson, ROOT } from '../server/config.js';
import { compileKindConfig } from '../server/model.js';
import { Relay } from '../server/relay.js';

const fixture = readJson(path.join(ROOT, 'fixtures', 'ff-offline-finale-2026.json'));
const kindConfig = compileKindConfig(readJson(path.join(ROOT, 'config', 'cue-kinds.json')));
const groups = readJson(path.join(ROOT, 'config', 'scenarios.json')).groups || [];

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-relay-'));
  const cfg = { ...loadConfig(), mode: 'live', dataDir, cueStartSource: 'observed' };
  let clock = Date.parse('2026-11-01T10:00:00Z');
  const source = { mode: 'live', now: () => clock };
  const relay = new Relay({ cfg, source, kindConfig, groups });
  relay.onFull({ json: { ...fixture, currentItemId: null, isRunning: false }, fetchedAt: clock });
  const cues = relay.rundown.cues;
  const current = (cue, extra = {}) => {
    relay.onCurrent({
      json: { rundown: { id: fixture.rundown.id }, isRunning: !!cue, isPaused: false, current: cue ? { id: cue.id } : null, position: cue ? cue.index + 1 : 0, ...extra },
      fetchedAt: clock,
      latencyMs: 0,
    });
  };
  const advance = (ms) => (clock += ms);
  return { relay, cues, current, advance, now: () => clock };
}

test('Streckung verschwindet, wenn die Show gestoppt und neu gestartet wird', () => {
  const { relay, cues, current, advance } = setup();
  current(cues[0]);
  advance(5000);
  current(cues[1]);
  relay.handle({ type: 'stretch', ms: 120000 });
  assert.equal(relay.snapshot().cue.stretchMs, 120000);
  advance(1000);
  current(null, { isRunning: false });
  advance(2000);
  current(null, { isRunning: false });
  current(cues[0]);
  advance(5000);
  current(cues[1]);
  const snap = relay.snapshot();
  assert.equal(snap.cue.id, cues[1].id);
  assert.equal(snap.cue.stretchMs, 0);
  assert.equal(relay.st.visited.length, 2);
  assert.ok(relay.log.some((e) => e.type === 'reset' && e.reason === 'stopStart'));
});

test('Neuer showStartedAt setzt alle Zeiten zurück', () => {
  const { relay, cues, current, advance, now } = setup();
  const start1 = new Date(now()).toISOString();
  current(cues[0], { showStartedAt: start1 });
  advance(4000);
  current(cues[1], { showStartedAt: start1 });
  relay.handle({ type: 'stretch', ms: 60000 });
  relay.handle({ type: 'message', text: 'Hallo', html: 'Hallo' });
  advance(60000);
  const start2 = new Date(now()).toISOString();
  current(cues[1], { showStartedAt: start2 });
  const snap = relay.snapshot();
  assert.equal(snap.cue.stretchMs, 0);
  assert.equal(snap.message, null);
  assert.ok(relay.log.some((e) => e.type === 'reset' && e.reason === 'showStartedAt'));
});

test('Sprung zurück auf den ersten Cue gilt als Neustart', () => {
  const { relay, cues, current, advance } = setup();
  current(cues[0]);
  advance(3000);
  current(cues[1]);
  advance(3000);
  current(cues[2]);
  relay.handle({ type: 'stretch', ms: 30000 });
  advance(3000);
  current(cues[0]);
  assert.deepEqual(relay.st.stretch, {});
  assert.deepEqual(relay.st.visited, [cues[0].id]);
  assert.ok(relay.log.some((e) => e.type === 'reset' && e.reason === 'firstCue'));
});

test('Pause, Cue-Wechsel und kurzer Aussetzer setzen nichts zurück', () => {
  const { relay, cues, current, advance, now } = setup();
  const start = new Date(now()).toISOString();
  current(cues[0], { showStartedAt: start });
  advance(3000);
  current(cues[1], { showStartedAt: start });
  relay.handle({ type: 'stretch', ms: 30000 });
  current(cues[1], { showStartedAt: start, isPaused: true });
  advance(20000);
  current(cues[1], { showStartedAt: start });
  // Backend verschiebt den Showstart nach der Pause: kein frischer Start, also kein Reset
  advance(20 * 60000);
  current(cues[1], { showStartedAt: new Date(Date.parse(start) + 20000).toISOString() });
  // isRunning flackert nur kurz
  current(null, { isRunning: false });
  advance(500);
  current(cues[1]);
  assert.equal(relay.snapshot().cue.stretchMs, 30000);
  assert.ok(!relay.log.some((e) => e.type === 'reset'));
});

test('Streckung eines Cues gilt nur für diesen Durchlauf des Cues', () => {
  const { relay, cues, current, advance } = setup();
  current(cues[0]);
  advance(3000);
  current(cues[1]);
  advance(3000);
  current(cues[2]);
  relay.handle({ type: 'stretch', ms: 30000 });
  advance(3000);
  current(cues[3]);
  advance(3000);
  current(cues[2]); // im Backend zurückgesprungen
  assert.equal(relay.snapshot().cue.stretchMs, 0);
});

test('Rundown-Steuerung: Aktionen werden übersetzt, Doppeltipp zählt einmal', async () => {
  const { relay } = setup();
  const calls = [];
  relay.source.control = async (a) => {
    calls.push(a);
    return { ok: true };
  };
  await relay.control('start');
  await relay.control('toggle');
  await relay.control('toggle'); // innerhalb von 800 ms: ignoriert
  await relay.control('prev');
  await relay.control('finish');
  const bad = await relay.control('löschen');
  assert.deepEqual(calls, ['next', 'toggle', 'prev', 'finish']);
  assert.equal(bad.ok, false);
});

test('Zeit erweitern/setzen: lokal sofort, Backend-Fehler lässt lokale Streckung stehen', async () => {
  const { relay, cues, current, advance } = setup();
  const calls = [];
  relay.source.control = async (a, p) => {
    calls.push(`${a} ${p?.time}`);
    return { ok: false, error: 'offline' };
  };
  current(cues[0]);
  advance(10_000);
  relay.handle({ type: 'stretch', mode: 'add', ms: 90_000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(relay.snapshot().cue.stretchMs, 90_000);
  relay.handle({ type: 'stretch', mode: 'set', ms: 125_000 });
  await new Promise((r) => setImmediate(r));
  const s = relay.snapshot();
  assert.equal(s.cue.effectiveMs - (s.serverTime - s.cue.startedAt), 125_000);
  assert.deepEqual(calls, ['add 01:30', 'set 02:05']);
  assert.equal(relay.lastEvent.type, 'timeSync');
  assert.equal(relay.lastEvent.ok, false);
});
