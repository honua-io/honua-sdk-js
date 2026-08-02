import {
  createIndexedDbOfflineRegionStore,
  createOfflineRegionDiagnostic,
  createOfflineRegionFetchHandler,
  createOfflineRegionManifest,
  downloadOfflineRegion,
} from "/dist/src/offline/index.js";

const DATABASE_NAME = "honua-offline-region-reference-v1";
const DATA_PATH = "/offline-data.json";
const SHELL_MANIFEST_PATH = "./shell-manifest.v1.json";
const RESOURCE_ID = "incidents";
const RESOURCE_BYTE_LENGTH = 50;
const RESOURCE_INTEGRITY = "sha256:01bffe15679e8bd02244b4c9a402bddb86e1e9e1a4ece7f6e0be9df512c0059d";
const LOGICAL_QUOTA_BYTES = 1024;
const OBSERVED_AT = "2026-08-01T10:00:00.000Z";
const ONLINE_NOW = new Date("2026-08-01T10:05:00.000Z");
const OFFLINE_NOW = new Date("2026-08-02T10:00:00.000Z");
const STALE_AFTER_MS = 60 * 60 * 1000;

function text(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function publish(result) {
  document.querySelector("main")?.setAttribute("data-state", result.availability);
  text("status", `${result.mode} · ${result.availability}`);
  text("payload", result.payload ?? "Unavailable");
  text("freshness", result.freshness);
  text("provenance", `${result.sourceVersion} / ${result.schemaVersion} / ${result.planVersion}`);
  text("attribution", result.attribution || "Unavailable");
  text("error", result.error ?? "");
  window.__HONUA_OFFLINE_REFERENCE__ = Object.freeze(result);
}

function canonicalizeLaunchUrl() {
  const url = new URL(window.location.href);
  if (!url.search && !url.hash) return;
  url.search = "";
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
}

async function readBoundedResponseBytes(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Offline resource exceeds its byte budget.");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Offline resource exceeds its byte budget.");
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function manifest() {
  return createOfflineRegionManifest({
    name: "Incident field snapshot",
    sourceId: "incidents",
    endpoint: new URL(DATA_PATH, window.location.href),
    authorizationScopeFingerprint: "offline-reference-public-scope",
    bounds: { minX: -158.3, minY: 21.2, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
    sourceVersion: "source-v1",
    schemaVersion: "schema-v1",
    planVersion: "plan-v1",
    observation: { state: "live", observedAt: OBSERVED_AT },
    expiresAt: "2030-01-01T00:00:00.000Z",
    attribution: { county: "Honua deterministic incident fixture" },
    resources: [
      {
        id: RESOURCE_ID,
        kind: "features",
        byteLength: RESOURCE_BYTE_LENGTH,
        integrity: RESOURCE_INTEGRITY,
        contentType: "application/json; charset=utf-8",
        attributionIds: ["county"],
      },
    ],
  });
}

async function downloadWhenNeeded(value, store) {
  const diagnostic = await createOfflineRegionDiagnostic(value, await store.inventory(), {
    logicalQuotaBytes: LOGICAL_QUOTA_BYTES,
    now: ONLINE_NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
  if (diagnostic.cache.readable || !navigator.onLine) return;
  await downloadOfflineRegion(value, {
    store,
    logicalQuotaBytes: LOGICAL_QUOTA_BYTES,
    load: async () => {
      const response = await fetch(DATA_PATH, { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(`Fixture request failed with ${response.status}.`);
      return readBoundedResponseBytes(response, RESOURCE_BYTE_LENGTH);
    },
  });
}

async function readSnapshot(value, store, now) {
  const inventory = await store.inventory();
  const diagnostic = await createOfflineRegionDiagnostic(value, inventory, {
    logicalQuotaBytes: LOGICAL_QUOTA_BYTES,
    now,
    staleAfterMs: STALE_AFTER_MS,
  });
  if (!diagnostic.cache.readable) {
    return {
      diagnostic,
      payload: undefined,
      error: `Persisted region is unavailable (${diagnostic.cache.reason}).`,
    };
  }
  const handler = createOfflineRegionFetchHandler({
    store,
    regionId: value.id,
    match: (request) => (new URL(request.url).pathname === DATA_PATH ? RESOURCE_ID : undefined),
    now: () => now,
  });
  const response = await handler(new Request(new URL(DATA_PATH, window.location.href)));
  if (!response) {
    return { diagnostic, payload: undefined, error: "Persisted resource is unavailable." };
  }
  return { diagnostic, payload: await response.text(), error: undefined };
}

function referenceWorker(registration, scriptUrl) {
  return [registration.active, registration.installing, registration.waiting].find(
    (worker) => worker?.scriptURL === scriptUrl,
  );
}

async function waitForActiveWorker(registration, scriptUrl) {
  if (registration.active?.scriptURL === scriptUrl) return registration.active;
  const worker = referenceWorker(registration, scriptUrl);
  if (!worker) throw new Error("The reference application shell worker is missing.");
  await new Promise((resolve, reject) => {
    const finish = (result) => {
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", stateChanged);
      result();
    };
    const stateChanged = () => {
      if (registration.active?.scriptURL === scriptUrl) {
        finish(resolve);
      } else if (worker.state === "redundant") {
        finish(() => reject(new Error("The reference application shell worker became redundant.")));
      }
    };
    const timeout = window.setTimeout(() => finish(() => reject(new Error("Service worker did not activate."))), 5000);
    worker.addEventListener("statechange", stateChanged);
  });
  return registration.active;
}

async function waitForController(scriptUrl) {
  if (navigator.serviceWorker.controller?.scriptURL === scriptUrl) return;
  await new Promise((resolve, reject) => {
    const finish = (result) => {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
      result();
    };
    const controllerChanged = () => {
      if (navigator.serviceWorker.controller?.scriptURL === scriptUrl) {
        finish(resolve);
      }
    };
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("Service worker did not take control."))),
      5000,
    );
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
  });
}

async function prepareApplicationShell() {
  if (!("serviceWorker" in navigator)) throw new Error("Service workers are unavailable.");
  const scopeUrl = new URL("./", window.location.href);
  const scriptUrl = new URL("./service-worker.mjs", scopeUrl).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  let registration = registrations.find(
    (candidate) => candidate.scope === scopeUrl.href && referenceWorker(candidate, scriptUrl),
  );
  if (!registration) {
    registration = await navigator.serviceWorker.register(scriptUrl, { scope: scopeUrl.href });
  }
  if (registration.scope !== scopeUrl.href) throw new Error("The reference application shell scope is unavailable.");
  const active = await waitForActiveWorker(registration, scriptUrl);
  await waitForController(scriptUrl);
  if (!active) throw new Error("The application shell worker is inactive.");
  const channel = new MessageChannel();
  const reply = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Application shell caching timed out.")), 5000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      if (event.data?.ok === true) resolve("refreshed");
      else if (event.data?.retained === true) resolve("retained");
      else reject(new Error("Application shell caching failed."));
    };
  });
  active.postMessage(
    { type: "HONUA_PRECACHE_V2", manifestUrl: new URL(SHELL_MANIFEST_PATH, window.location.href).href },
    [channel.port2],
  );
  return reply;
}

async function main() {
  canonicalizeLaunchUrl();
  const value = await manifest();
  const store = createIndexedDbOfflineRegionStore({ name: DATABASE_NAME });
  await downloadWhenNeeded(value, store);
  const shellState = await prepareApplicationShell();
  const disconnected = !navigator.onLine || shellState === "retained";
  const snapshot = await readSnapshot(value, store, disconnected ? OFFLINE_NOW : ONLINE_NOW);
  const diagnostic = snapshot.diagnostic;
  publish({
    ready: true,
    shellReady: true,
    mode: disconnected ? "offline" : "online",
    availability: diagnostic.cache.readable ? "ready" : "unavailable",
    freshness: diagnostic.cache.freshness,
    payload: snapshot.payload,
    attribution: diagnostic.contents.attributionIds
      .map((id) => value.attribution[id])
      .filter(Boolean)
      .join("; "),
    sourceVersion: diagnostic.provenance.sourceVersion,
    schemaVersion: diagnostic.provenance.schemaVersion,
    planVersion: diagnostic.provenance.planVersion,
    error: snapshot.error,
  });
}

void main().catch((error) => {
  publish({
    ready: true,
    shellReady: false,
    mode: navigator.onLine ? "online" : "offline",
    availability: "unavailable",
    freshness: "unknown",
    sourceVersion: "unknown",
    schemaVersion: "unknown",
    planVersion: "unknown",
    attribution: "",
    error: error instanceof Error ? error.message : "Offline startup failed.",
  });
});
