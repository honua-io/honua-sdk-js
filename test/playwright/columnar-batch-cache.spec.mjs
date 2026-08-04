import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Browser truth for issue #940: the columnar batch cache is only durable if a
// real IndexedDB origin store keeps it across a real reload, so the page writes
// on first load and reads after `page.reload()` rather than in one session.
// `mode` rides in sessionStorage so the reload is a genuine navigation, not a
// new context.
const PAGE = `<!doctype html><title>Columnar batch cache</title><script type="module">
  import {
    COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES,
    columnarBatchCacheFixtureBatch,
    columnarBatchCacheFixtureIdentity,
    columnarBatchCacheLegacyEntry,
    createColumnarBatchCache,
    createIndexedDbColumnarBatchCacheStorage,
    runColumnarBatchCacheConformance,
  } from "/dist/src/columnar/index.js";

  const SCOPE = "dispatch-read-v2";
  // A live observation instant: freshness is checked against the record on
  // read, and the fixture's own instant is fixed in the past.
  const OBSERVED_AT = new Date().toISOString();
  const identity = (overrides = {}) =>
    columnarBatchCacheFixtureIdentity({
      authorizationScope: SCOPE,
      freshness: { observedAt: OBSERVED_AT },
      ...overrides,
    });

  const run = async () => {
    const parameters = new URL(location.href).searchParams;
    const database = parameters.get("database") ?? "honua-columnar-batch-cache-test";
    const scenario = parameters.get("scenario") ?? "durability";
    const mode = sessionStorage.getItem("columnar-cache-mode") ?? "write";

    if (scenario === "conformance") {
      let index = 0;
      const report = await runColumnarBatchCacheConformance({
        label: "indexeddb",
        createStorage: () => createIndexedDbColumnarBatchCacheStorage({ name: database + "-case-" + index++ }),
        disposeStorage: (storage) => storage.dispose?.(),
      });
      window.__columnarCache = { report, expectedCases: COLUMNAR_BATCH_CACHE_CONFORMANCE_CASES.length };
      return;
    }

    const diagnostics = [];
    const storage = createIndexedDbColumnarBatchCacheStorage({ name: database });
    const cache = createColumnarBatchCache(storage, {
      quotaBytes: 4 * 1024 * 1024,
      onDiagnostic: (diagnostic) => diagnostics.push({ operation: diagnostic.operation, reason: diagnostic.reason }),
    });

    if (mode === "write") {
      const written =
        scenario === "migration"
          ? await (async () => {
              // What an older SDK left behind: an envelope at layout 1.0.
              const legacy = await columnarBatchCacheLegacyEntry(identity(), Date.now());
              await storage.write(legacy, []);
              return { outcome: "stored", key: legacy.record.key };
            })()
          : await cache.write(columnarBatchCacheFixtureBatch(identity()));
      sessionStorage.setItem("columnar-cache-mode", "read");
      window.__columnarCache = {
        phase: "written",
        outcome: written.outcome,
        reason: written.reason ?? null,
        records: (await cache.records()).length,
        diagnostics,
      };
      return;
    }

    const read = await cache.read(identity());
    const foreign = await cache.read(identity({ authorizationScope: "another-tenant" }));
    const records = await cache.records();
    window.__columnarCache = {
      phase: "read",
      outcome: read.outcome,
      reason: read.reason ?? null,
      rowCount: read.outcome === "hit" ? read.batch.rowCount : null,
      migrations: read.outcome === "hit" ? read.metrics.migrations : null,
      envelopeVersion: read.outcome === "hit" ? read.metrics.envelopeVersion : null,
      restoredScope: read.outcome === "hit" ? (read.batch.identity?.authorizationScope ?? null) : null,
      foreignOutcome: foreign.outcome,
      foreignReason: foreign.reason ?? null,
      recordKeys: [...new Set(records.flatMap((record) => Object.keys(record)))].sort(),
      recordStrings: records.flatMap((record) =>
        [
          record.key,
          record.format,
          record.envelopeVersion,
          record.sourceId,
          record.sourceVersion,
          record.schemaVersion,
          record.planId,
          record.authorizationScopeDigest,
          record.orderingDigest,
          record.integrity,
          ...Object.values(record.freshness),
        ].filter((value) => typeof value === "string"),
      ),
      diagnostics,
    };
  };

  run().catch((error) => {
    window.__columnarCache = { error: String(error) };
  });
</script>`;

test("a cached batch survives a real reload and stays bound to its authorization scope", async ({ page }) => {
  const server = await startServer();
  const database = `honua-columnar-cache-${Date.now()}`;
  try {
    await page.goto(`${server.url}/?database=${database}`);
    await expect.poll(() => page.evaluate(() => window.__columnarCache)).toMatchObject({
      phase: "written",
      outcome: "stored",
      records: 1,
      diagnostics: [],
    });

    await page.reload({ waitUntil: "load" });
    const restored = await pollState(page);
    expect(restored).toMatchObject({
      phase: "read",
      outcome: "hit",
      rowCount: 2,
      envelopeVersion: "1.1",
      // The caller's own scope is restored; storage never held it.
      restoredScope: "dispatch-read-v2",
      // A different authorization scope addresses a different entry, and there
      // is none: never the batch that was written.
      foreignOutcome: "miss",
      foreignReason: "absent",
    });
    expect(restored.migrations).toEqual([]);
    expect(restored.recordKeys).toEqual([
      "authorizationScopeDigest",
      "byteLength",
      "envelopeVersion",
      "format",
      "freshness",
      "integrity",
      "key",
      "observedAt",
      "orderingDigest",
      "planId",
      "rowCount",
      "schemaVersion",
      "sourceId",
      "sourceVersion",
    ]);
    for (const value of restored.recordStrings) {
      expect(value).not.toMatch(/^https?:\/\//i);
      expect(value).not.toMatch(/(?:authorization|bearer|cookie|password|secret|session|token|api[-_]?key)/i);
    }
    // Only the digest of the authorization scope is persisted.
    expect(restored.recordStrings).not.toContain("dispatch-read-v2");
  } finally {
    await server.close();
  }
});

test("an envelope persisted at layout 1.0 is migrated forward after a reload", async ({ page }) => {
  const server = await startServer();
  const database = `honua-columnar-cache-migration-${Date.now()}`;
  try {
    await page.goto(`${server.url}/?database=${database}&scenario=migration`);
    await expect.poll(() => page.evaluate(() => window.__columnarCache)).toMatchObject({
      phase: "written",
      records: 1,
    });

    await page.reload({ waitUntil: "load" });
    const restored = await pollState(page);
    // The old entry is read, not discarded, and the chain that carried it is
    // reported rather than assumed.
    expect(restored).toMatchObject({ outcome: "hit", rowCount: 2, envelopeVersion: "1.1" });
    expect(restored.migrations).toEqual(["1.0->1.1"]);
  } finally {
    await server.close();
  }
});

test("every shared conformance case passes against real IndexedDB", async ({ page }) => {
  test.slow();
  const server = await startServer();
  try {
    await page.goto(`${server.url}/?database=honua-columnar-conformance-${Date.now()}&scenario=conformance`);
    const state = await pollReport(page);
    expect(state.report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(state.report.failed).toBe(0);
    expect(state.report.label).toBe("indexeddb");
    // Every shared case really ran; a suite that silently selected none would
    // otherwise report a vacuous pass.
    expect(state.report.total).toBe(state.expectedCases);
    expect(state.report.passed).toBe(state.report.total);
  } finally {
    await server.close();
  }
});

test("a device-imposed origin quota is reported as quota pressure, not a silent drop", async ({ page, context }) => {
  test.slow();
  const server = await startServer();
  try {
    // A genuine per-origin quota, enforced by the browser's own storage layer.
    // Applied before the origin is first visited: the storage layer caches a
    // bucket's quota when its first connection opens.
    const client = await context.newCDPSession(page);
    await client.send("Storage.overrideQuotaForOrigin", { origin: server.url, quotaSize: 1024 * 1024 });
    await page.goto(`${server.url}/?database=honua-columnar-quota-${Date.now()}`);
    await expect.poll(() => page.evaluate(() => window.__columnarCache?.phase)).toBe("written");

    const result = await page.evaluate(async () => {
      const { createColumnarBatchCache, createIndexedDbColumnarBatchCacheStorage, createGeoArrowBatch } = await import(
        "/dist/src/columnar/index.js"
      );
      const identity = {
        sourceId: "parcels",
        sourceVersion: "source-1",
        schemaVersion: "parcels-v1",
        planId: "plan-oversized",
        authorizationScope: "dispatch-read-v2",
        ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        freshness: { observedAt: new Date().toISOString() },
      };
      const sample = createGeoArrowBatch({
        id: "oversized:0",
        sequence: 0,
        schemaId: identity.schemaVersion,
        identity,
        geometry: {
          kind: "point",
          coordinateLayout: "interleaved",
          crs: "OGC:CRS84",
          values: [
            [-157.86, 21.31],
            [-157.85, 21.32],
          ],
        },
      }).batch;
      // Incompressible: IndexedDB charges quota against stored bytes, so a
      // repeating payload would slip under the override after compression.
      const rows = 400_000;
      const coordinates = new Float64Array(rows * 2);
      const bytes = new Uint8Array(coordinates.buffer);
      for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.byteLength)));
      }
      // Random bit patterns include NaN and infinities; the layout validator
      // requires finite coordinates, so those few slots carry an index instead.
      for (let index = 0; index < coordinates.length; index += 1) {
        if (!Number.isFinite(coordinates[index])) coordinates[index] = index;
      }
      const template = sample.buffers.find((buffer) => buffer.role === "geometry");
      const batch = {
        ...sample,
        rowCount: rows,
        buffers: [
          {
            id: template.id,
            role: template.role,
            field: template.field,
            data: coordinates.buffer,
            byteOffset: 0,
            byteLength: coordinates.byteLength,
          },
        ],
      };
      const storage = createIndexedDbColumnarBatchCacheStorage({ name: `honua-columnar-quota-pressure-${Date.now()}` });
      const cache = createColumnarBatchCache(storage, { quotaBytes: 64 * 1024 * 1024 });
      const estimate = await navigator.storage.estimate();
      const written = await cache.write(batch);
      return {
        estimate,
        outcome: written.outcome,
        reason: written.reason ?? null,
        records: (await cache.records()).length,
      };
    });

    // The browser really was reporting a constrained origin quota.
    expect(result.estimate.quota).toBeLessThanOrEqual(1024 * 1024);
    expect(result).toMatchObject({ outcome: "refused", reason: "quota-pressure", records: 0 });
    await client.send("Storage.overrideQuotaForOrigin", { origin: server.url });
  } finally {
    await server.close();
  }
});

async function pollState(page) {
  await expect.poll(() => page.evaluate(() => window.__columnarCache?.phase ?? window.__columnarCache?.error)).toEqual(
    expect.any(String),
  );
  return page.evaluate(() => window.__columnarCache);
}

async function pollReport(page) {
  await expect
    .poll(() => page.evaluate(() => window.__columnarCache?.report?.total ?? window.__columnarCache?.error ?? null), {
      timeout: 60_000,
    })
    .not.toBeNull();
  return page.evaluate(() => window.__columnarCache);
}

async function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(PAGE);
      return;
    }
    if (url.pathname.startsWith("/dist/")) {
      try {
        const file = await readFile(path.join(repoRoot, url.pathname));
        response.setHeader("content-type", "application/javascript; charset=utf-8");
        response.end(file);
      } catch {
        response.statusCode = 404;
        response.end("not found");
      }
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
