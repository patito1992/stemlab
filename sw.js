// Service worker de StemLab: deja la app lista para abrir sin internet. La versión cambia sola con cada publicación.
const CACHE = 'stemlab-pwa-48e1e9eb9b';
const FILES = [
 "./",
 "chords.js",
 "config.js",
 "data-pwa.js",
 "data.js",
 "engine.js",
 "export.js",
 "google.js",
 "icon-192.png",
 "icon-512.png",
 "icon-maskable-512.png",
 "index.html",
 "library.css",
 "lyrics.js",
 "manifest.webmanifest",
 "player.css",
 "player.html",
 "player.js",
 "privacy.html",
 "pwa-app.js",
 "pwa.css",
 "store.js",
 "style.css",
 "ui.js",
 "vendor/SOUNDTOUCHJS-LICENSE-MPL2.txt",
 "vendor/soundtouch-node.js",
 "vendor/soundtouch-processor.js",
 "zip.js"
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => fetch(f, { cache: 'reload' }).then(r => { if (!r.ok) throw new Error(f); return c.put(f, r); })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;       // Google y Drive van directo a internet
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
