 const CACHE_NAME = 'nexus-cache-v8';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles.css',
  './nexus.js',
  './DevOSSentinel.js',    // ADD THIS
  './SentinelFixer.js',    // ADD THIS
  './NexusContext.js',     // ADD THIS
  './sentinel.worker.js',  // ADD THIS
  './sync.js',
  './injector.js',
  './virtual-keyboard.js',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mathjs/11.8.0/math.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.9/beautify.min.js',
  'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js'
'https://unpkg.com/@rollup/browser@4.13.0/dist/rollup.browser.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) return caches.delete(cacheName);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Network-First Strategy for live IDE development
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseToCache));
        }
        return networkResponse;
      })
      .catch(() => caches.match(e.request)) // Fallback to cache if offline
  );
});
