// Service Worker: App-Hülle offline verfügbar, API und WebSocket nie aus dem Cache.
const VERSION = 'al-1.6.2';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/manifest.webmanifest',
  '/js/app.js',
  '/js/connection.js',
  '/js/settings.js',
  '/js/viewmodel.js',
  '/js/local.js',
  '/js/shared/timing.js',
  '/js/views/operator.js',
  '/js/views/sign.js',
  '/js/ui/hold.js',
  '/js/ui/fit.js',
  '/js/ui/wakelock.js',
  '/js/ui/wheel.js',
  '/vendor/giphy.js',
  '/js/views/rundown.js',
  '/js/ui/richtext.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
const APP_ROUTES = new Set(['/', '/al', '/schild', '/regie']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/healthz') return;

  // Seiten: Netz zuerst, offline die gespeicherte Hülle.
  if (e.request.mode === 'navigate' || APP_ROUTES.has(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Dateien: sofort aus dem Cache, im Hintergrund aktualisieren.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
