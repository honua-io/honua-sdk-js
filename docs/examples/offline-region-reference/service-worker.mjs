const CACHE_NAMESPACE = "honua-offline-region-reference-shell-";
const CONTROL_CACHE_NAME = `${CACHE_NAMESPACE}control-v1`;
const GENERATION_CACHE_PREFIX = `${CACHE_NAMESPACE}generation-v1-`;
const LEGACY_CACHE_NAME = `${CACHE_NAMESPACE}v1`;
const MAX_SHELL_URLS = 128;
const MAX_SHELL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_SHELL_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SHELL_MANIFEST_BYTES = 64 * 1024;
const SHELL_REFRESH_TIMEOUT_MS = 3000;
const SHELL_MANIFEST_FORMAT = "honua.offline-shell-manifest.v1";
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

function createGenerationName(deploymentId) {
  const nonce = new Uint32Array(2);
  crypto.getRandomValues(nonce);
  const suffix = [...nonce].map((value) => value.toString(16).padStart(8, "0")).join("");
  return `${GENERATION_CACHE_PREFIX}${deploymentId}-${Date.now()}-${suffix}`;
}

async function sha256Integrity(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function loadShellManifest(value, signal) {
  const manifestUrl = normalizedShellUrl(value);
  if (!manifestUrl) throw new Error("Unreviewed application shell manifest URL.");
  const response = await fetch(cacheKey(manifestUrl), { cache: "reload", signal });
  if (!response.ok || response.redirected || response.url !== manifestUrl.href) {
    throw new Error("Application shell manifest request failed.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SHELL_MANIFEST_BYTES) {
    throw new Error("Application shell manifest exceeds its byte budget.");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Application shell manifest is invalid JSON.");
  }
  if (
    manifest?.format !== SHELL_MANIFEST_FORMAT ||
    typeof manifest.deploymentId !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(manifest.deploymentId) ||
    !Array.isArray(manifest.resources) ||
    manifest.resources.length === 0 ||
    manifest.resources.length > MAX_SHELL_URLS
  ) {
    throw new Error("Application shell manifest is invalid.");
  }

  let declaredTotalBytes = 0;
  const resources = manifest.resources.map((resource) => {
    if (
      typeof resource?.url !== "string" ||
      !Number.isSafeInteger(resource.byteLength) ||
      resource.byteLength < 0 ||
      resource.byteLength > MAX_SHELL_ASSET_BYTES ||
      typeof resource.integrity !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(resource.integrity)
    ) {
      throw new Error("Application shell manifest resource is invalid.");
    }
    const url = normalizedShellUrl(new URL(resource.url, manifestUrl).href);
    if (!url) throw new Error("Unreviewed application shell URL.");
    declaredTotalBytes += resource.byteLength;
    if (declaredTotalBytes > MAX_SHELL_TOTAL_BYTES) {
      throw new Error("Application shell manifest exceeds its byte budget.");
    }
    return { url, byteLength: resource.byteLength, integrity: resource.integrity };
  });
  if (new Set(resources.map((resource) => resource.url.href)).size !== resources.length) {
    throw new Error("Duplicate application shell URL.");
  }
  return { deploymentId: manifest.deploymentId, resources };
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

async function replaceApplicationShell(manifestUrl, signal) {
  const manifest = await loadShellManifest(manifestUrl, signal);
  const previousName = await activeShellCacheName();
  await deleteInactiveShellCaches(previousName);
  const generationName = createGenerationName(manifest.deploymentId);
  const generation = await caches.open(generationName);
  let committed = false;
  let totalBytes = 0;
  try {
    for (const resource of manifest.resources) {
      const key = cacheKey(resource.url);
      const response = await fetch(key, { cache: "reload", signal });
      if (!response.ok || response.redirected || response.url !== resource.url.href) {
        throw new Error("Application shell request failed.");
      }
      const bytes = await response.clone().arrayBuffer();
      const byteLength = bytes.byteLength;
      totalBytes += byteLength;
      if (
        byteLength !== resource.byteLength ||
        totalBytes > MAX_SHELL_TOTAL_BYTES ||
        (await sha256Integrity(bytes)) !== resource.integrity
      ) {
        throw new Error("Application shell resource integrity failed.");
      }
      await generation.put(key, response);
    }
    if ((await generation.keys()).length !== manifest.resources.length) {
      throw new Error("Application shell staging is incomplete.");
    }

    const control = await caches.open(CONTROL_CACHE_NAME);
    await control.put(
      cacheKey(activePointerUrl),
      new Response(generationName, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
    committed = true;
    await deleteInactiveShellCaches(generationName);
    return { count: manifest.resources.length, deploymentId: manifest.deploymentId, totalBytes };
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
  if (event.data?.type !== "HONUA_PRECACHE_V2" || !event.ports[0]) return;
  const port = event.ports[0];
  const update = shellUpdateQueue.then(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SHELL_REFRESH_TIMEOUT_MS);
    try {
      return await replaceApplicationShell(event.data.manifestUrl, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  });
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
