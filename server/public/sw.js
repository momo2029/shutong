const CACHE = 'shutong-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => {
      return cache.addAll(['/public/css/app.css', '/public/js/app.js']);
    }),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) {
    return; // Network first for API
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return cached || fetch(e.request);
    }),
  );
});
