// AZORES - caché de aplicación prueba envíos limpios 2026-11-16-1
const CACHE = "azores-shell-v108-login-fix-20261117-1";
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./logo-azores.jpg", "./cata-celebracion.gif"];
const SCOPE = new URL(self.registration.scope);
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("azores-shell-") && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  // No interceptar Supabase ni otras aplicaciones GitHub Pages.
  if (req.method !== "GET" || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Evita reutilizar respuestas antiguas de la caché HTTP del navegador.
      const response = await fetch(req, {cache: "no-store"});
      if (response.ok) await cache.put(req, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(req, {ignoreSearch: req.mode === "navigate"});
      if (cached) return cached;
      if (req.mode === "navigate") {
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
