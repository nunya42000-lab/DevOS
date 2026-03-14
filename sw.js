const CACHE_NAME = 'nexus-cache-v6-ultimate';
const ASSETS = [
  './index.html',
  './manifest.json',
  './styles.css',
  './nexus.js',
  'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mathjs/11.8.0/math.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.9/beautify.min.js',
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
            console.log("Purging old cache:", cacheName);
            return caches.delete(cacheName); // Deletes the old v3 cache with the 14 files
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
      return response || fetch(e.request).then((fetchResponse) => {
        return caches.open(CACHE_NAME).then((cache) => {
            if (e.request.url.startsWith('http')) { 
                cache.put(e.request, fetchResponse.clone());
            }
            return fetchResponse;
        });
      });
    }).catch(() => {
      if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
      }
    })
  );
});
