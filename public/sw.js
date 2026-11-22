// Minimal offline shell: cache-first for same-origin app assets, network for everything else.
// Map tiles are intentionally NOT cached here (provider terms + storage size); see README.
const CACHE = 'stride-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network-first for navigations so new deploys show up; fall back to cache offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(e.request, c)); } return r; })));
});
