// Offline app shell. At build time `vite.config.ts` (precacheManifest) replaces
// the two values below with every file in dist/ and a hash of their contents,
// so each deploy gets its own cache and old chunks are cleaned up.
// Map tiles are intentionally NOT cached here (provider terms + storage size); see README.
const VERSION = 'dev'; /*__VERSION__*/
const PRECACHE = []; /*__PRECACHE__*/
const CACHE = `stride-shell-${VERSION}`;
const SHELL = './';

self.addEventListener('install', (e) => {
  // Fetch fresh copies (bypass the HTTP cache) so a half-deployed build can't be pinned.
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([SHELL, ...PRECACHE].map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('stride-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations: network first so new deploys show up; offline, serve the cached shell
  // for any route (the app uses client-side routing).
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(SHELL, c)); }
          return r;
        })
        .catch(() => caches.match(SHELL, { cacheName: CACHE }).then((r) => r || Response.error())),
    );
    return;
  }

  // Everything else: precached files are content-hashed, so cache first is safe.
  // Don't cache misses: a 404 or an HTML fallback for a missing chunk must not stick.
  e.respondWith(
    caches.match(e.request, { cacheName: CACHE }).then((hit) => hit || fetch(e.request).then((r) => {
      const type = r.headers.get('content-type') || '';
      if (r.ok && !type.includes('text/html')) { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(e.request, c)); }
      return r;
    })),
  );
});
