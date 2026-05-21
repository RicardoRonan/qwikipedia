/** App-shell cache - same-origin static assets load fast/offline after first visit */
const CACHE = 'qwikipedia-shell-v1';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './wiki.js',
  './engine.js',
  './storage.js',
  './settings.js',
  './auth.js',
  './toast.js',
  './icons.js',
  './Qwikipedia%20logo.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  const r = event.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  if (url.origin !== location.origin) return;

  // SPA fallback: /account has no static file; serve the app shell
  if (url.pathname === '/account' || url.pathname === '/account/') {
    event.respondWith(
      caches.match('./index.html').then(cached => cached || fetch('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(r).then(cached =>
      cached || fetch(r).then(res => {
        if (res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(r, copy));
        }
        return res;
      }),
    ),
  );
});
