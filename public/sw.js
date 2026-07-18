/**
 * sw.js — မြန်မာ ကျားကွက် Service Worker
 * Cache-first strategy for static assets.
 * Network-first for Supabase API calls (never cached).
 * Offline fallback → auth.html
 */

const CACHE_VERSION = 'kk-v2';
const STATIC_ASSETS = [
  './auth.html',
  './index.html',
  './session-guard.js',
  './manifest.json',
  './logo.png',
  './background.png',
  './liquid-glass-2.css',
  './liquid-glass-timer.js',
];

/* ── INSTALL: pre-cache all static assets ── */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        /* Silent fail — if caching fails, SW still installs */
        console.warn('[SW] Pre-cache failed:', err);
        return self.skipWaiting();
      })
  );
});

/* ── ACTIVATE: purge old cache versions ── */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ── FETCH: cache-first for static, network-first for API ── */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  /* Skip non-GET requests */
  if (e.request.method !== 'GET') return;

  /* Skip Supabase / external API requests — never cache auth data */
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('youtube.com') ||
    url.hostname.includes('google.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.protocol === 'chrome-extension:'
  ) return;

  /* For everything else: cache-first with network fallback */
  e.respondWith(
    caches.match(e.request)
      .then((cached) => {
        if (cached) return cached;

        return fetch(e.request)
          .then((resp) => {
            /* Only cache same-origin successful responses */
            if (
              resp &&
              resp.status === 200 &&
              (resp.type === 'basic' || resp.type === 'cors')
            ) {
              const clone = resp.clone();
              caches.open(CACHE_VERSION)
                .then((cache) => cache.put(e.request, clone))
                .catch(() => {});
            }
            return resp;
          })
          .catch(() => {
            /* Offline fallback for document requests */
            if (e.request.destination === 'document') {
              return caches.match('./auth.html');
            }
          });
      })
  );
});
