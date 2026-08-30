// divIDE service worker
// Paired with manifest.json's file_handlers/share_target. Registered from
// index.html's <head> script — see the comment there for why this has to
// be a real sibling file rather than inlined (blob:/data: registration is
// rejected by spec: "Script URL's scheme is not 'http' or 'https'").

// Bumped from v2 -> v3: adding the version-pinned CDN precache list below
// (see PRECACHE_EXTERNALS) means the cache's actual contents genuinely
// change on this deploy, not just APP_SHELL's own file list — same
// reasoning as the v1->v2 bump: reusing an existing cache name reopens the
// same store rather than resetting it, so a version bump is what actually
// triggers the activate handler's cleanup and a real re-fetch.
const CACHE = 'divide-shell-v3';

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon192.png',
  './icon512.png',
  './icon192maskable.png',
  './icon512maskable.png'
];

// Every version-pinned, plain <script src>/<link> CDN dependency this app
// actually loads — genuinely safe to precache aggressively since a
// version number baked into the URL itself (e.g. .../3.10.1/jszip.min.js)
// can never resolve to different content later; there's no staleness risk
// the way there would be for an unpinned URL. This is the direct answer
// to "cache all the externals": these 20 requests used to only get cached
// opportunistically, AFTER first being fetched live over the network —
// meaning the very first time any given feature was used (Compress,
// GitHub sync, Terminal, PeerJS sync, etc.), it still had to hit the
// network cold, with no offline fallback and no protection against a
// slow/stalling connection on that first use. Precaching them here means
// they're already local from the moment this service worker's install
// step finishes, before any of those features are ever touched.
//
// Deliberately excludes the CM6/esm.sh imports (codemirror and everything
// under @codemirror/, @lezer/, @replit/, @fazelstudio/): those resolve
// through esm.sh's own dynamic dependency-graph resolution at import()
// time, not a single fixed URL each — esm.sh may redirect, append query
// params, or serve versioned sub-paths that aren't predictable without
// live network access to actually observe (confirmed unavailable in the
// sandbox this was written in). Hardcoding a guessed set of exact URLs
// for those risks caching the WRONG thing silently, which is worse than
// the existing cache-on-first-successful-fetch fallback these still rely
// on instead — an approach that already correctly adapts to however
// esm.sh actually resolves things, rather than assuming.
const PRECACHE_EXTERNALS = [
  'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
  'https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/acorn/8.11.3/acorn.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/acorn-walk/8.3.2/walk.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.7/beautify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.7/beautify-html.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.7/beautify-css.min.js',
  'https://unpkg.com/prettier@3.2.5/standalone.js',
  'https://unpkg.com/prettier@3.2.5/plugins/estree.js',
  'https://unpkg.com/prettier@3.2.5/plugins/babel.js',
  'https://unpkg.com/prettier@3.2.5/plugins/html.js',
  'https://unpkg.com/prettier@3.2.5/plugins/postcss.js',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css',
  'https://cdn.jsdelivr.net/npm/astring@1.8.1/dist/astring.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/terser/5.31.0/bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.2/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // Same-origin shell first, external CDN deps second — both via
      // individual put() calls rather than one big addAll() across both
      // lists: addAll() fails ALL-OR-NOTHING (one 404/CORS-blocked
      // request anywhere in the list aborts the entire install), which
      // would mean a single unreachable CDN at install time could leave
      // even the app's own first-party files uncached. Fetching each
      // external with { mode: 'cors' } explicitly and catching failures
      // per-request means one blocked/offline CDN just doesn't get
      // precached (falls back to the existing on-first-use caching) 
      // instead of taking down the whole install.
      c.addAll(APP_SHELL)
        .catch(() => {
          // A single missing shell file (e.g. this SW served from a path
          // where index.html has a different name) shouldn't hard-fail
          // install and leave the app entirely uninstallable offline.
        })
        .then(() => Promise.all(
          PRECACHE_EXTERNALS.map((url) =>
            fetch(url, { mode: 'cors' })
              .then((res) => { if (res && res.ok) return c.put(url, res); })
              .catch(() => {
                // One CDN being unreachable at install time (offline
                // first install, a blocked domain, a transient outage)
                // shouldn't fail the whole precache — that dependency
                // simply falls back to the fetch handler's existing
                // cache-on-first-successful-fetch behavior instead.
              })
          )
        ))
    )
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
      // Network-first for same-origin HTML/JS/CSS (so edits show up
      // immediately on reload instead of serving a stale cached shell),
      // cache-first for everything else (CDN deps, fonts, icons — these
      // are version-pinned URLs that never change content, so cache-first
      // saves a round trip every load with zero staleness risk).
      //
      // Widened from "HTML only" now that index.html was split into three
      // files: before the split, ALL of divIDE's own first-party code
      // lived inside index.html itself and correctly got network-first
      // treatment. app.js/styles.css now hold that exact same
      // continuously-edited first-party code — they are NOT third-party,
      // version-pinned CDN dependencies the way the original cache-first
      // branch's reasoning was written for — so routing them into
      // cache-first by only checking for "document" destination would be
      // a real regression: a fresh index.html could load an old, stale
      // app.js sitting in cache next to it. Checked by same-origin +
      // filename rather than Request.destination, since destination for a
      // <script src>/<link rel=stylesheet> request is "script"/"style"
      // either way regardless of which file it is — there's no built-in
      // way to distinguish "our own script" from "a vendor script" by
      // destination alone.
      const isOwnCode = isSameOrigin && (
        e.request.mode === 'navigate' ||
        e.request.destination === 'document' ||
        url.pathname.endsWith('/app.js') ||
        url.pathname.endsWith('/styles.css')
      );

      if (isOwnCode) {
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
