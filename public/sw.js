// Service worker — network-first strategy (always fetch fresh, fall back to cache)
const CACHE_NAME = 'clawd-voice-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Skip WebSocket and API requests
  if (e.request.url.includes('/api/') || e.request.url.includes('ws')) return;
  
  e.respondWith(
    fetch(e.request).then(res => {
      // Cache successful responses
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request)) // Offline fallback
  );
});
