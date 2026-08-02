const CACHE_NAME = "honua-offline-region-reference-shell-v1";
const MAX_SHELL_URLS = 128;
const scopeUrl = new URL(self.registration.scope);

function normalizedShellUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.origin !== scopeUrl.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!url.pathname.startsWith(scopeUrl.pathname) && !url.pathname.startsWith("/dist/"))
  ) {
    return undefined;
  }
  return url;
}

function cacheKey(url) {
  return new Request(url.href, { credentials: "omit", method: "GET" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("honua-offline-region-reference-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "HONUA_PRECACHE_V1" || !event.ports[0]) return;
  const port = event.ports[0];
  event.waitUntil(
    (async () => {
      const values = event.data.urls;
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SHELL_URLS) {
        throw new Error("Invalid application shell list.");
      }
      const urls = values.map(normalizedShellUrl);
      if (urls.some((url) => url === undefined)) throw new Error("Unreviewed application shell URL.");
      const cache = await caches.open(CACHE_NAME);
      for (const url of urls) {
        const key = cacheKey(url);
        const response = await fetch(key, { cache: "reload" });
        if (!response.ok) throw new Error("Application shell request failed.");
        await cache.put(key, response);
      }
      port.postMessage({ ok: true, count: urls.length });
    })().catch(() => port.postMessage({ ok: false })),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = normalizedShellUrl(event.request.url);
  if (!url) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = cacheKey(url);
      const cached = await cache.match(key);
      if (cached) return cached;
      return fetch(key);
    })(),
  );
});
