// Service worker: cross-origin isolation and caching for a static host.
//
// 1. GitHub Pages cannot set response headers, but ONNX Runtime needs SharedArrayBuffer for
//    multi-threaded WebAssembly, which requires cross-origin isolation. This worker adds
//    COOP/COEP to the site's own responses. COEP "credentialless" keeps cross-origin requests
//    (GitHub, jsDelivr, Hugging Face) working without their cooperation.
// 2. Build assets are content-hashed, so they are cached forever; pages and data are
//    network-first with a cache fallback, so a revisit is instant and the site works offline.
const CACHE = "odin-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("odin-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function isolated(response) {
  if (!response || response.type === "opaque" || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return; // leave cross-origin alone
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (url.pathname.includes("/assets/")) {
      // Content-hashed file names: a cached copy can never be stale.
      const hit = await cache.match(request);
      if (hit) return isolated(hit);
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return isolated(fresh);
    }
    try {
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return isolated(fresh);
    } catch {
      const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
      return hit ? isolated(hit) : Response.error();
    }
  })());
});
