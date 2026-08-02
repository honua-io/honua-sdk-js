const CACHE_NAMESPACE = "honua-offline-region-reference-shell-";
const CONTROL_CACHE_NAME = `${CACHE_NAMESPACE}control-v1`;
const GENERATION_CACHE_PREFIX = `${CACHE_NAMESPACE}generation-v1-`;
const LEGACY_CACHE_NAME = `${CACHE_NAMESPACE}v1`;
const MAX_SHELL_URLS = 128;
const MAX_SHELL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_SHELL_TOTAL_BYTES = 16 * 1024 * 1024;
const scopeUrl = new URL(self.registration.scope);
const activePointerUrl = new URL("__honua-active-shell-v1__", scopeUrl);
let shellUpdateQueue = Promise.resolve();

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
    url.href === activePointerUrl.href ||
    (!url.pathname.startsWith(scopeUrl.pathname) && !url.pathname.startsWith("/dist/"))
  ) {
    return undefined;
  }
  return url;
}

function cacheKey(url) {
  return new Request(url.href, { credentials: "omit", method: "GET" });
}

function createGenerationName() {
  const nonce = new Uint32Array(2);
  crypto.getRandomValues(nonce);
  const suffix = [...nonce].map((value) => value.toString(16).padStart(8, "0")).join("");
  return `${GENERATION_CACHE_PREFIX}${Date.now()}-${suffix}`;
}

async function pointedGenerationName() {
  const control = await caches.open(CONTROL_CACHE_NAME);
  const response = await control.match(cacheKey(activePointerUrl));
  if (!response) return undefined;
  const name = await response.text();
  if (!name.startsWith(GENERATION_CACHE_PREFIX) || name.length > 256) return undefined;
  return (await caches.keys()).includes(name) ? name : undefined;
}

async function activeShellCacheName() {
  const pointed = await pointedGenerationName();
  if (pointed) return pointed;
  return (await caches.keys()).includes(LEGACY_CACHE_NAME) ? LEGACY_CACHE_NAME : undefined;
}

async function hasRetainedShell() {
  const activeName = await activeShellCacheName();
  if (!activeName) return false;
  return (await (await caches.open(activeName)).keys()).length > 0;
}

async function deleteInactiveShellCaches(activeName) {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => (name === LEGACY_CACHE_NAME || name.startsWith(GENERATION_CACHE_PREFIX)) && name !== activeName)
      .map((name) => caches.delete(name)),
  );
}

async function replaceApplicationShell(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SHELL_URLS) {
    throw new Error("Invalid application shell list.");
  }
  const urls = values.map(normalizedShellUrl);
  if (urls.some((url) => url === undefined)) throw new Error("Unreviewed application shell URL.");
  if (new Set(urls.map((url) => url.href)).size !== urls.length) {
    throw new Error("Duplicate application shell URL.");
  }

  const previousName = await activeShellCacheName();
  await deleteInactiveShellCaches(previousName);
  const generationName = createGenerationName();
  const generation = await caches.open(generationName);
  let committed = false;
  let totalBytes = 0;
  try {
    for (const url of urls) {
      const key = cacheKey(url);
      const response = await fetch(key, { cache: "reload" });
      if (!response.ok || response.redirected || response.url !== url.href) {
        throw new Error("Application shell request failed.");
      }
      const byteLength = (await response.clone().arrayBuffer()).byteLength;
      totalBytes += byteLength;
      if (byteLength > MAX_SHELL_ASSET_BYTES || totalBytes > MAX_SHELL_TOTAL_BYTES) {
        throw new Error("Application shell exceeds its byte budget.");
      }
      await generation.put(key, response);
    }
    if ((await generation.keys()).length !== urls.length) {
      throw new Error("Application shell staging is incomplete.");
    }

    const control = await caches.open(CONTROL_CACHE_NAME);
    await control.put(
      cacheKey(activePointerUrl),
      new Response(generationName, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
    committed = true;
    await deleteInactiveShellCaches(generationName);
    return { count: urls.length, totalBytes };
  } finally {
    if (!committed) await caches.delete(generationName);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "HONUA_PRECACHE_V1" || !event.ports[0]) return;
  const port = event.ports[0];
  const update = shellUpdateQueue.then(() => replaceApplicationShell(event.data.urls));
  shellUpdateQueue = update.then(
    () => undefined,
    () => undefined,
  );
  event.waitUntil(
    update
      .then((receipt) => port.postMessage({ ok: true, ...receipt }))
      .catch(async () => port.postMessage({ ok: false, retained: await hasRetainedShell() })),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = normalizedShellUrl(event.request.url);
  if (!url) return;
  event.respondWith(
    (async () => {
      await shellUpdateQueue;
      const activeName = await activeShellCacheName();
      const key = cacheKey(url);
      if (activeName) {
        const cached = await (await caches.open(activeName)).match(key);
        if (cached) return cached;
      }
      return fetch(key);
    })(),
  );
});
