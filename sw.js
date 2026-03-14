const CACHE_NAME = 'nexus-cache-v4';
const ASSETS = [
  './index.html',
  './manifest.json',
  './styles.ces',
  './nexus.js',
  './virtual-keyboard.js',
  'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mathjs/11.8.0/math.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.13/codemirror.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.13/theme/dracula.min.css',
  'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName); // Purges v3 and older module caches
          }
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      // Fallback to network if cache misses, then cache the result
      return response || fetch(e.request).then((fetchResponse) => {
        return caches.open(CACHE_NAME).then((cache) => {
            if (e.request.url.startsWith('http')) { // Only cache valid HTTP/HTTPS requests
                cache.put(e.request, fetchResponse.clone());
            }
            return fetchResponse;
        });
      });
    }).catch(() => {
      // Fallback for failed offline navigation requests
      if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
      }
    })
  );
});
