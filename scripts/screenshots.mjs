// Screenshots in iPad-mini-Größe (744 × 1133 pt, @2x) aus dem Replay.
// Aufruf: npm run screenshots   (braucht Playwright: npm i -D playwright && npx playwright install chromium)
// Ergebnis: docs/screenshots/*.png

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const PORTRAIT = { width: 744, height: 1133 };
const LANDSCAPE = { width: 1133, height: 744 };
let port = 8200;

async function withServer(env, fn) {
  const p = port++;
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'replay', PORT: String(p), REPLAY_HOLD: '1', REPLAY_JITTER: '0', DATA_DIR: path.join(ROOT, 'data', `shot-${p}`), ...env },
    stdio: 'ignore',
  });
  const base = `http://localhost:${p}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* noch nicht da */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    await fn(base);
  } finally {
    proc.kill();
  }
}

async function page(browser, viewport, settings = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  await ctx.addInitScript((s) => {
    localStorage.setItem('al.settings', JSON.stringify(s));
  }, settings);
  return ctx.newPage();
}

async function shot(pg, name) {
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('  ✓', name);
}

const browser = await chromium.launch();
const portraitOp = { rotateToSign: false };

// Moderierter Cue 119 (5:00): läuft, Stufe, Überzug
for (const [offset, tag] of [
  [20, 'laeuft'],
  [190, 'noch2'],
  [345, 'ueber'],
]) {
  await withServer({ REPLAY_START_CUE: '119', REPLAY_START_OFFSET: String(offset) }, async (base) => {
    let pg = await page(browser, PORTRAIT, portraitOp);
    await pg.goto(`${base}/al`);
    await shot(pg, `bedienung-hoch-${tag}`);
    pg = await page(browser, LANDSCAPE);
    await pg.goto(`${base}/schild`);
    await shot(pg, `schild-quer-${tag}`);
    if (tag === 'ueber') {
      pg = await page(browser, PORTRAIT);
      await pg.goto(`${base}/schild`);
      await shot(pg, `schild-hoch-${tag}`);
    }
  });
}

// FERTIG WERDEN (letzte 10 s eines Cues)
await withServer({ REPLAY_START_CUE: '119', REPLAY_START_OFFSET: '293' }, async (base) => {
  const pg = await page(browser, PORTRAIT, portraitOp);
  await pg.goto(`${base}/al`);
  await shot(pg, 'bedienung-hoch-fertig-werden');
  const sg = await page(browser, LANDSCAPE);
  await sg.goto(`${base}/schild`);
  await shot(sg, 'schild-quer-fertig-werden');
});

// STRECKEN-Auswahl mit Drehrad, CUSTOM TEXT und Bedienung per Button
await withServer({ REPLAY_START_CUE: '119', REPLAY_START_OFFSET: '40' }, async (base) => {
  const pg = await page(browser, PORTRAIT, portraitOp);
  await pg.goto(`${base}/al`);
  await pg.waitForTimeout(600);
  await pg.click('#b-stretch');
  await pg.waitForTimeout(400);
  await pg.evaluate(() => {
    document.getElementById('wheel-min').scrollTop = 3 * 44;
    document.getElementById('wheel-sec').scrollTop = 45 * 44;
  });
  await shot(pg, 'bedienung-hoch-strecken');
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  await pg.click('#b-text');
  await pg.waitForTimeout(400);
  await pg.click('#text-editor');
  await pg.keyboard.type('Bitte ');
  await pg.click('#text-sheet [data-cmd="bold"]');
  await pg.keyboard.type('jetzt');
  await pg.click('#text-sheet [data-cmd="bold"]');
  await pg.click('#text-sheet [data-color="#ffd600"]');
  await pg.keyboard.type(' Gast vorstellen');
  await shot(pg, 'bedienung-hoch-custom-text');
  await pg.click('#text-show');
  await shot(pg, 'bedienung-hoch-text-aktiv');
  const sm = await page(browser, LANDSCAPE);
  await sm.goto(`${base}/schild`);
  await shot(sm, 'schild-quer-custom-text');
  await pg.getByRole('button', { name: 'AUSBLENDEN' }).click();
  await pg.waitForTimeout(300);
  await pg.click('#b-sign');
  await shot(pg, 'schild-hoch-button');
  // Schild per 1 s Halten verlassen, dann SCHLUSS halten
  const box = await pg.locator('#sign').boundingBox();
  await pg.mouse.move(box.width / 2, box.height / 2);
  await pg.mouse.down();
  await pg.waitForTimeout(1150);
  await pg.mouse.up();
  const cut = await pg.locator('#b-cut').boundingBox();
  await pg.mouse.move(cut.x + cut.width / 2, cut.y + cut.height / 2);
  await pg.mouse.down();
  await pg.waitForTimeout(800);
  await pg.mouse.up();
  await shot(pg, 'bedienung-hoch-schluss');
  const sg = await page(browser, LANDSCAPE);
  await sg.goto(`${base}/schild`);
  await shot(sg, 'schild-quer-schluss');
});

// Kompletter Rundown (Tipp auf den Cue-Kasten)
await withServer({ REPLAY_START_CUE: '108', REPLAY_START_OFFSET: '0', REPLAY_SPEED: '40', REPLAY_HOLD: '0' }, async (base) => {
  const pg = await page(browser, PORTRAIT, portraitOp);
  await pg.goto(`${base}/al`);
  await pg.waitForTimeout(6000);
  await pg.click('#now');
  await pg.waitForTimeout(1200);
  await shot(pg, 'rundown-hoch');
});

// Regieansicht: Cue-Stapel und reduzierte Steuerung
await withServer({ REPLAY_START_CUE: '118', REPLAY_START_OFFSET: '0', REPLAY_SPEED: '30', REPLAY_HOLD: '0' }, async (base) => {
  const pg = await page(browser, PORTRAIT);
  await pg.goto(`${base}/regie`);
  await pg.waitForTimeout(4000);
  await shot(pg, 'regie-hoch');
});

// Zuspieler vor moderiertem Cue → GLEICH DU
await withServer({ REPLAY_START_CUE: '118', REPLAY_START_OFFSET: '1' }, async (base) => {
  const pg = await page(browser, LANDSCAPE);
  await pg.goto(`${base}/schild`);
  await shot(pg, 'schild-quer-gleich-du');
});

// Spiel (offen) im Finale: Szenario-Auswahl und Sprung-Hinweis, Querformat-Bedienung
await withServer({ REPLAY_START_CUE: '112', REPLAY_START_OFFSET: '1500' }, async (base) => {
  let pg = await page(browser, LANDSCAPE, portraitOp);
  await pg.goto(`${base}/al`);
  await shot(pg, 'bedienung-quer-spiel');
  pg = await page(browser, PORTRAIT, portraitOp);
  await pg.goto(`${base}/al`);
  await shot(pg, 'bedienung-hoch-spiel');
  pg = await page(browser, LANDSCAPE);
  await pg.goto(`${base}/schild`);
  await shot(pg, 'schild-quer-spiel');
});

// Anker-Pause bis 15:45:15
await withServer({ REPLAY_START_CUE: '65', REPLAY_START_OFFSET: '60' }, async (base) => {
  const pg = await page(browser, PORTRAIT, portraitOp);
  await pg.goto(`${base}/al`);
  await shot(pg, 'bedienung-hoch-anker');
});

// Vorlauf SuP3: Back-Time mit Anker-Puffer je Szenario, Einstellungen, helles Erscheinungsbild
await withServer({ REPLAY_START_CUE: '30', REPLAY_START_OFFSET: '20' }, async (base) => {
  let pg = await page(browser, PORTRAIT, portraitOp);
  await pg.goto(`${base}/al`);
  await shot(pg, 'bedienung-hoch-sup3');
  await pg.click('#op-settings');
  await shot(pg, 'einstellungen');
  pg = await page(browser, PORTRAIT, { ...portraitOp, appearance: 'light' });
  await pg.goto(`${base}/al`);
  await shot(pg, 'bedienung-hoch-hell');
  pg = await page(browser, PORTRAIT);
  await pg.goto(`${base}/`);
  await shot(pg, 'startseite');
});

await browser.close();
for (const d of fs.readdirSync(path.join(ROOT, 'data'))) {
  if (d.startsWith('shot-')) fs.rmSync(path.join(ROOT, 'data', d), { recursive: true, force: true });
}
console.log('Fertig:', OUT);
