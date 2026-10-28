// Geräteeinstellungen (nur Komfort, pro iPad). Speicher kann fehlen → Standardwerte.

const DEFAULTS = { grip: 'right', rotateToSign: true, appearance: 'dark', fps: '25' };
const KEY = 'al.settings';

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const values = read();
const listeners = new Set();

export const settings = {
  get(k) {
    return values[k];
  },
  set(k, v) {
    values[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch {
      /* privat/blockiert: nur für diese Sitzung */
    }
    listeners.forEach((fn) => fn(k, v));
  },
  onChange(fn) {
    listeners.add(fn);
  },
};

export function storeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function storeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* egal */
  }
}
