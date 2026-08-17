const CACHE_NAME = "voiceish-web-v0.3.0";
const SHELL = [
  "/", "/index.html", "/popup.css", "/web.css", "/web-chrome-shim.js", "/background.js",
  "/popup.js", "/web-bootstrap.js", "/audio-recorder-worklet.js", "/manifest.webmanifest",
  "/icons/icon16.png", "/icons/icon32.png", "/icons/icon48.png", "/icons/icon128.png",
  "/icons/icon192.png", "/icons/icon512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    })
    .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html"))));
});
