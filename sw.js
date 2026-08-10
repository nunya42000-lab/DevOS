// sw.js — standalone service worker for divIDE.
//
// Two different caching strategies, deliberately split by request type:
//
//   - HTML / navigation requests: NETWORK-FIRST. If this were cache-first
//     (the simpler, more common approach — and what divIDE's own in-app
//     PWA Forge tool currently does for everything), users who have the
//     app installed would get permanently stuck on whatever HTML shell was
//     cached at install time, even after you ship real updates. Current
//     guidance is explicit that this is a named, well-known anti-pattern,
//     not just a style choice — HTML should always try the network first
//     so a fresh deploy is actually seen, falling back to the cached copy
//     only when genuinely offline.
//
//   - Everything else (icons, CSS, JS, images): CACHE-FIRST. These change
//     far less often than the HTML shell, and cache-first gives instant,
//     truly-offline-capable loading for them without the staleness risk
//     that applies to the shell itself.
//
// Only files confirmed to exist are precached at install time (this file's
// own two icon files). cache.addAll() fails ATOMICALLY — if even one URL
// in the list 404s, the entire install step fails and the service worker
// never activates — so nothing is guessed at or assumed present here.
// Everything else gets cached opportunistically as it's actually
// requested, the first time it's fetched successfully.

const CACHE_NAME = 'divide-pwa-v1';
const PRECACHE_ASSETS = [
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever handle GET — POST/PUT/etc. should always hit the network
  // untouched; caching or intercepting them would be actively wrong.
  if (request.method !== 'GET') return;

  // request.mode === 'navigate' catches actual page loads/navigations;
  // checking the Accept header too catches cases some browsers report
  // differently, so real HTML requests aren't missed either way.
  const isHTMLRequest =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  if (isHTMLRequest) {
    // NETWORK-FIRST for HTML: try the live network first so a real update
    // is always seen. Only fall back to whatever's cached if the network
    // request genuinely fails (offline, DNS failure, etc.) — and only then
    // top up the cache with a fresh copy for the next time we're offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // CACHE-FIRST for everything else: serve instantly from cache when
  // available, and only hit the network on an actual cache miss — then
  // store that response for next time.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached); // cached is undefined here (we already checked), but kept for symmetry/clarity if this branch is ever refactored to fall through from a partial hit
    })
  );
});
