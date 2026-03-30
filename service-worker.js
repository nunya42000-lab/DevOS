const CACHE_NAME = 'devos-nexus-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/sentinel.js',
  '/wires.js'
  '/NexusTactical.js'
  '/NexusContext.js'
  '/NexusSimulation.js'
  '/NexusRefactor.js'
  '/NexusNeural.js'
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Nexus SW] Pre-caching core assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Nexus SW] Clearing old cache');
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Cache-first strategy for speed, fallback to network
      if (cachedResponse) return cachedResponse;
      return fetch(event.request);
    })
  );
});
