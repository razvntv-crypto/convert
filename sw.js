// Cache-first service worker: app shell + CDN libraries (incl. ffmpeg core) → works offline after first use.
const VERSION = 'convert-v5';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ffmpeg-worker.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png', 'edit.html', 'edit.js', 'edit.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const cdn = /(^|\.)jsdelivr\.net$|fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !cdn) return;
  if (sameOrigin) {
    // network-first for own files so updates land; fall back to cache offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // versioned CDN files never change → cache-first
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  })));
});
