/** App-shell cache - same-origin static assets load fast/offline after first visit */
const SHELL_CACHE  = 'qwikipedia-shell-v6';
const API_CACHE    = 'qwikipedia-api-v1';
const VENDOR_CACHE = 'qwikipedia-vendor-v1';
const CORE = [
  './', './index.html', './manifest.webmanifest',
  './styles.css',
  './app.js', './ui.js', './wiki.js', './engine.js', './cache.js',
  './storage.js', './settings.js', './auth.js', './toast.js', './icons.js', './pronounce.js',
  './deepdive.js', './entity.js', './search.js', './account.js',
  './ai.js', './ai-heuristics.js', './text-utils.js', './usePullToRefresh.js', './supabase-config.js',
  './pwa-install.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon-180.png',
  './Qwikipedia%20logo.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => ![SHELL_CACHE, API_CACHE, VENDOR_CACHE].includes(k)).map(k => caches.delete(k))
      )
    ).then(() => clients.claim())
  );
});

// ── Wikipedia API patterns ──────────────────────────────────────────────
const WIKI_SUMMARY_RE   = /^https:\/\/.+\.wikipedia\.org\/api\/rest_v1\/page\/summary\//;
const WIKI_FEATURED_RE  = /^https:\/\/.+\.wikipedia\.org\/api\/rest_v1\/feed\/featured\//;
const WIKI_ACTION_RE    = /^https:\/\/.+\.wikipedia\.org\/w\/api\.php/;
const WIKI_THUMB_RE     = /^https:\/\/.+\.wikipedia\.org\/(thumb\/)?Special:FilePath\//;
const WIKI_UPLOAD_RE    = /^https:\/\/upload\.wikimedia\.org\//;

// ── Caching strategies ─────────────────────────────────────────────────

/** Stale-while-revalidate: serve cached response instantly, fetch fresh in bg. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);

  // Return cached immediately if available, otherwise wait for network
  return cached || fetchPromise;
}

/** Cache-first: serve from cache if present, otherwise re-fetch. */
async function cacheFirstWithExpiry(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request).catch(() => null);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

/** Network-first with cache fallback: always try fresh, fall back to cache. */
async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// ── Request routing ─────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const r = event.request;
  if (r.method !== 'GET') return;

  if (r.mode === 'navigate') {
    event.respondWith(
      fetch(r).catch(() => caches.match('./index.html').then(c => c || caches.match('./')))
    );
    return;
  }

  const url = new URL(r.url);

  // ── Same-origin: app shell & static assets ──────────────────────────
  if (url.origin === location.origin) {
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
            caches.open(SHELL_CACHE).then(c => c.put(r, copy));
          }
          return res;
        }),
      ),
    );
    return;
  }

  // ── Cross-origin: vendor CDNs, Wikipedia API & images ───────────────

  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(r, VENDOR_CACHE));
    return;
  }

  // Article summaries: stale-while-revalidate
  // The CDN already caches these for 14 days; our SW adds offline support
  if (WIKI_SUMMARY_RE.test(url.href)) {
    event.respondWith(staleWhileRevalidate(r, API_CACHE));
    return;
  }

  // Featured article of the day: stale-while-revalidate
  if (WIKI_FEATURED_RE.test(url.href)) {
    event.respondWith(staleWhileRevalidate(r, API_CACHE));
    return;
  }

  // Random endpoints are non-deterministic - never cache them.
  if (url.href.includes('generator=random') || url.href.includes('list=random')) {
    event.respondWith(fetch(r).catch(() => new Response('{"error":"offline"}', {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })));
    return;
  }

  // Action API (random, search, categories, extracts): network-first
  // Search results need freshness; random benefits from network; cache for offline
  if (WIKI_ACTION_RE.test(url.href)) {
    event.respondWith(networkFirstWithCache(r, API_CACHE));
    return;
  }

  // Wikipedia article thumbnails & uploaded images: cache-first
  // These are immutable once published - cache aggressively
  if (WIKI_THUMB_RE.test(url.href) || WIKI_UPLOAD_RE.test(url.href)) {
    event.respondWith(cacheFirstWithExpiry(r, API_CACHE));
    return;
  }

  // Any other cross-origin request: pass through to network
});
