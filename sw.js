// divIDE service worker
// Paired with manifest.json's file_handlers/share_target. Registered from
// index.html's <head> script — see the comment there for why this has to
// be a real sibling file rather than inlined (blob:/data: registration is
// rejected by spec: "Script URL's scheme is not 'http' or 'https'").

const CACHE = 'divide-shell-v1';

// Everything needed to boot divIDE with no network. The CDN scripts
// (CodeMirror deps, localforage, acorn, prettier, etc.) are cached
// opportunistically on first fetch below rather than listed here up
// front — pinning ~20 cross-origin esm.sh/jsdelivr/unpkg URLs by hand
// would silently rot the moment any of those packages ship a new
// version, so the fetch handler's cache-as-you-go strategy is the
// version that actually stays correct over time.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL).catch(() => {
      // A single missing shell file (e.g. this SW served from a path
      // where index.html has a different name) shouldn't hard-fail
      // install and leave the app entirely uninstallable offline.
    }))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// share_target is declared with method: "GET" in manifest.json, so Android
// delivers a shared title/text/url as ordinary query params on a normal
// navigation to the action URL — there is no special "share" fetch event
// to intercept. The only SW-relevant part is making sure that navigation
// still resolves offline, which the network-first/cache-fallback logic
// below already covers since the action URL ("./") is the same app shell.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      // Network-first for same-origin HTML (so edits to index.html show up
      // immediately on reload instead of serving a stale cached shell),
      // cache-first for everything else (CDN deps, fonts, icons — these
      // are version-pinned URLs that never change content, so cache-first
      // saves a round trip every load with zero staleness risk).
      const isHTML = e.request.mode === 'navigate' || e.request.destination === 'document';

      if (isSameOrigin && isHTML) {
        return fetch(e.request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => cached || caches.match('./index.html'));
      }

      if (cached) return cached;

      return fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});

// Lets the page force a fresh shell (e.g. after Nexus.pwa re-forges or the
// user bumps a version) without waiting for the next natural activate
// cycle. Call via: navigator.serviceWorker.controller.postMessage({type:'SKIP_WAITING'})
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (e.data && e.data.type === 'CLEAR_CACHE') {
    e.waitUntil(caches.delete(CACHE));
  }
});
