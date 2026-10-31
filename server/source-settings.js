// Rundown-Quelle, die auf der Startseite gesetzt wurde: Token und Moderationsliste.
// Liegt im Datenordner (nicht im Repo), nur für den Server lesbar. Der Token verlässt den
// Server nie; Clients sehen höchstens die letzten vier Zeichen.

import fs from 'node:fs';
import path from 'node:path';

const FILE = 'rundown-source.json';

export function loadSourceSettings(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'));
    return {
      token: typeof j.token === 'string' && j.token ? j.token : null,
      hosts: Array.isArray(j.hosts) ? cleanHosts(j.hosts) : null,
      guests: Array.isArray(j.guests) ? cleanHosts(j.guests) : null,
    };
  } catch {
    return { token: null, hosts: null, guests: null };
  }
}

export function saveSourceSettings(dataDir, s) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token: s.token || null, hosts: s.hosts || null, guests: s.guests || null }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Namenslisten säubern: max. 40 Namen à 60 Zeichen, ohne Dubletten. */
export function cleanHosts(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const n = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const k = n.toLowerCase();
    if (!n || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= 40) break;
  }
  return out;
}

export const tokenHint = (t) => (t ? `…${String(t).slice(-4)}` : null);
export const tokenLooksValid = (t) => typeof t === 'string' && /^[A-Za-z0-9._~-]{8,200}$/.test(t);
