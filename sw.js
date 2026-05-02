// LPQ service worker — cache-first for app shell, network-first for external images
const CACHE = 'lpq-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // App shell — cache first
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request)
        .then(cached => cached || fetch(e.request).then(res => {
          // Cache successful GET responses for the app shell
          if (e.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }))
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // External resources (e.g. album art URLs) — network first, silent fail
  e.respondWith(
    fetch(e.request).catch(() => new Response('', { status: 408 }))
  );
});
