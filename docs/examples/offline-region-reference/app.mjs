import {
  createIndexedDbOfflineEditQueue,
  createIndexedDbOfflineRegionStore,
  createLocalFirstStatus,
  createOfflineRegionDiagnostic,
  createOfflineRegionFetchHandler,
  createOfflineRegionManifest,
  downloadOfflineRegion,
} from "/dist/src/offline/index.js";

const DATABASE_NAME = "honua-offline-region-reference-v1";
const EDIT_QUEUE_DATABASE_NAME = "honua-offline-region-reference-edits-v1";
const EDIT_IDEMPOTENCY_KEY = "offline-reference-incident-1-close";
const DATA_PATH = "/offline-data.json";
const SHELL_SCOPE_PATH = new URL("./", window.location.href).pathname;
const SHELL_CACHE_NAMESPACE = `honua-offline-region-reference-shell-${encodeURIComponent(SHELL_SCOPE_PATH)}-`;
const SHELL_CONTROL_CACHE_NAME = `${SHELL_CACHE_NAMESPACE}control-v1`;
const SHELL_GENERATION_PREFIX = `${SHELL_CACHE_NAMESPACE}generation-v1-`;
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
  text("local-first", result.localFirst ? `${result.localFirst.state} · ${result.localFirst.reason}` : "Unavailable");
  text("undelivered", result.localFirst ? String(result.localFirst.undeliveredCount) : "Unavailable");
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
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (
    (!contentEncoding || contentEncoding === "identity") &&
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
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

/**
 * Records the field edit only while the endpoint is unreachable, then reports
 * this partition's durable state. The idempotency key is stable, so a repeated
 * disconnected launch returns the existing edit instead of queueing a second
 * copy. `list` is a bounded detail sample; the counts come from
 * `countByState`, which is the only truthful total for a partition.
 */
async function captureDisconnectedEdit(value, disconnected) {
  const queue = createIndexedDbOfflineEditQueue({ name: EDIT_QUEUE_DATABASE_NAME });
  const partition = {
    authorizationScopeDigest: value.source.authorizationScopeDigest,
    sourceId: value.source.id,
  };
  if (disconnected) {
    await queue.enqueue({
      ...partition,
      idempotencyKey: EDIT_IDEMPOTENCY_KEY,
      edit: { operation: "update", featureId: "incident-1", attributes: { status: "closed" } },
    });
  }
  return {
    edits: await queue.list({ ...partition, limit: 100 }),
    editCounts: await queue.countByState(partition),
  };
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

async function hasCommittedApplicationShell(scopeUrl) {
  if (!navigator.locks) return false;
  const control = await caches.open(SHELL_CONTROL_CACHE_NAME);
  const pointerUrl = new URL("__honua-active-shell-v1__", scopeUrl);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pointer = await control.match(new Request(pointerUrl, { credentials: "omit", method: "GET" }));
    if (!pointer) return false;
    const name = await pointer.text();
    if (!name.startsWith(SHELL_GENERATION_PREFIX) || name.length > 256) return false;
    const result = await navigator.locks.request(
      `${name}-read-v1`,
      { ifAvailable: true, mode: "shared" },
      async (lock) => {
        const currentPointer = await control.match(new Request(pointerUrl, { credentials: "omit", method: "GET" }));
        if (!lock || !currentPointer || (await currentPointer.text()) !== name || !(await caches.has(name))) {
          return { retry: true };
        }
        return { retained: (await (await caches.open(name)).keys()).length > 0, retry: false };
      },
    );
    if (!result.retry) return result.retained;
  }
  return false;
}

function requestApplicationShellRefresh(worker, manifestUrl, retainedBeforeRefresh) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.close();
      callback();
    };
    const timeout = window.setTimeout(
      () =>
        finish(() =>
          retainedBeforeRefresh
            ? resolve("retained")
            : reject(new Error("Application shell caching timed out.")),
        ),
      5000,
    );
    channel.port1.onmessage = (event) => {
      finish(() => {
        if (event.data?.ok === true) resolve("refreshed");
        else if (event.data?.retained === true) resolve("retained");
        else reject(new Error("Application shell caching failed."));
      });
    };
    try {
      worker.postMessage({ type: "HONUA_PRECACHE_V2", manifestUrl }, [channel.port2]);
    } catch (error) {
      finish(() => {
        if (retainedBeforeRefresh) resolve("retained");
        else reject(error);
      });
    }
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
  await waitForActiveWorker(registration, scriptUrl);
  await waitForController(scriptUrl);
  const retainedBeforeRefresh = await hasCommittedApplicationShell(scopeUrl);
  const currentWorker = navigator.serviceWorker.controller;
  if (!currentWorker || currentWorker.scriptURL !== scriptUrl) {
    throw new Error("The application shell worker is inactive.");
  }
  return requestApplicationShellRefresh(
    currentWorker,
    new URL(SHELL_MANIFEST_PATH, window.location.href).href,
    retainedBeforeRefresh,
  );
}

async function main() {
  canonicalizeLaunchUrl();
  const value = await manifest();
  const store = createIndexedDbOfflineRegionStore({ name: DATABASE_NAME });
  await downloadWhenNeeded(value, store);
  const shellState = await prepareApplicationShell();
  const disconnected = !navigator.onLine || shellState === "retained";
  const now = disconnected ? OFFLINE_NOW : ONLINE_NOW;
  const snapshot = await readSnapshot(value, store, now);
  const diagnostic = snapshot.diagnostic;
  const { edits, editCounts } = await captureDisconnectedEdit(value, disconnected);
  const status = createLocalFirstStatus({
    connectivity: disconnected ? "offline" : "online",
    now,
    regions: [diagnostic],
    edits,
    editCounts,
  });
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
    localFirst: {
      state: status.state,
      reason: status.reason,
      connectivity: status.connectivity,
      availability: status.reads.availability,
      freshness: status.reads.freshness,
      completeness: status.reads.completeness,
      coverage: status.writes.coverage,
      undeliveredCount: status.writes.undeliveredCount,
      conflictedCount: status.writes.conflictedCount,
    },
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
    localFirst: undefined,
    error: error instanceof Error ? error.message : "Offline startup failed.",
  });
});
