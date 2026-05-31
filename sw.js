// LPQ service worker — network-first for app shell, network-only for external images
const CACHE = 'lpq-v33';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=33',
  './app.js?v=33',
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
      .then(() => {
        // Tell every open window to reload via postMessage — more reliable than
        // client.navigate() on iOS Safari. The listener is inlined in index.html.
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_RELOAD' })));
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // External resources (album art URLs) — network only
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request).catch(() => new Response('', { status: 408 }))
    );
    return;
  }

  // App shell — network first, fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (e.request.method === 'GET' && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});
