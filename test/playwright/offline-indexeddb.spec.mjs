import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("IndexedDB offline region store survives reload and preserves inventory CAS", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toEqual({
      receipt: "committed",
      revision: "present",
      regionCount: 1,
    });

    await page.reload();
    await page.context().setOffline(true);
    await page.waitForTimeout(10);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toEqual({
      revision: "present",
      regionCount: 1,
      logicalByteLength: 3,
      resource: "one",
      sourceVersion: "1",
      lastAccessedChanged: true,
      intercepted: "one",
      contentType: null,
      sourceHeader: "1",
      headBody: "",
      miss: true,
    });
  } finally {
    await server.close();
  }
});

test("offline fetch uses resource provenance and omits invalid header values", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const result = await page.evaluate(async () => {
      const { createOfflineRegionFetchHandler } = await import("/dist/src/offline/index.js");
      const read = {
        regionId: "region",
        manifest: {
          expiresAt: undefined,
          source: {
            observation: { state: "live", observedAt: "2026-07-29T00:00:00Z" },
            sourceVersion: "manifest-source",
            schemaVersion: "manifest-schema",
            planVersion: "manifest-plan",
          },
        },
        resource: {
          sourceVersion: "resource-source",
          schemaVersion: `resource-schema-${String.fromCharCode(1)}`,
          planVersion: "resource-plan",
          contentType: undefined,
        },
        bytes: new Uint8Array([111, 110, 101]),
      };
      const handler = createOfflineRegionFetchHandler({
        store: { readResource: async () => read },
        regionId: "region",
        match: () => "resource",
      });
      const response = await handler(new Request("https://example.test/resource"));
      return {
        source: response?.headers.get("x-honua-offline-source-version"),
        schema: response?.headers.get("x-honua-offline-schema-version"),
        plan: response?.headers.get("x-honua-offline-plan-version"),
      };
    });
    expect(result).toEqual({ source: "resource-source", schema: null, plan: "resource-plan" });
  } finally {
    await server.close();
  }
});

test("IndexedDB store reclaims abandoned staging records and touches LRU reads", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const database = await page.evaluate(() => window.__offlineDatabase);
    await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name });
      const transaction = await store.beginWrite("abandoned");
      await transaction.write({ id: "resource", byteLength: 3 }, new Uint8Array([1, 2, 3]));
    }, database);
    await page.waitForTimeout(10);
    const stagingCount = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name, stagingMaxAgeMs: 0 });
      await store.inventory();
      return await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const count = request.result.transaction("staging", "readonly").objectStore("staging").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
      });
    }, database);
    expect(stagingCount).toBe(0);
  } finally {
    await server.close();
  }
});

test("IndexedDB store supports atomic pinning, expiry pruning, and removal", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const database = await page.evaluate(() => window.__offlineDatabase);
    const result = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name });
      const before = await store.inventory();
      const regionId = before.regions[0].id;
      const pinned = await store.setRegionPinned(regionId, true);
      const unchanged = await store.setRegionPinned(regionId, true);
      const afterPin = await store.inventory();
      const pruned = await store.pruneExpired(new Date("2026-07-29T00:00:00Z"));
      const removed = await store.removeRegion(regionId);
      const absent = await store.removeRegion(regionId);
      return { pinned, unchanged, storedPinned: afterPin.regions[0]?.pinned, pruned, removed, absent, finalCount: (await store.inventory()).regions.length };
    }, database);
    expect(result).toEqual({ pinned: true, unchanged: false, storedPinned: true, pruned: [], removed: true, absent: false, finalCount: 0 });
  } finally {
    await server.close();
  }
});

async function startServer() {
  const fixture = { database: `honua-offline-test-${Date.now()}-${Math.random().toString(16).slice(2)}` };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/fixture.json") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(fixture));
      return;
    }
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><script type="module">
        import {
          createIndexedDbOfflineRegionStore,
          createOfflineRegionManifest,
          createOfflineRegionFetchHandler,
          downloadOfflineRegion,
        } from "/dist/src/offline/index.js";
        const digest = async (value) => {
          const bytes = new TextEncoder().encode(value);
          const hash = await crypto.subtle.digest("SHA-256", bytes);
          return "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const run = async () => {
          const fixture = await fetch("/fixture.json").then((response) => response.json());
          const database = fixture.database;
          window.__offlineDatabase = database;
          const mode = sessionStorage.getItem("offline-test-mode") ?? "write";
          const store = createIndexedDbOfflineRegionStore({ name: database });
          if (mode === "write") {
            const manifest = await createOfflineRegionManifest({
              name: "reload fixture",
              sourceId: "fixture",
              endpoint: "https://example.test/features",
              authorizationScopeFingerprint: "test-scope",
              bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, crs: "EPSG:4326" },
              sourceVersion: "1",
              schemaVersion: "1",
              planVersion: "1",
              observation: { state: "live", observedAt: "2026-07-29T00:00:00Z" },
              resources: [{ id: "metadata", kind: "metadata", byteLength: 3, integrity: await digest("one") }],
            });
            const receipt = await downloadOfflineRegion(manifest, {
              store,
              logicalQuotaBytes: 3,
              load: async () => new TextEncoder().encode("one"),
            });
            const inventory = await store.inventory();
            window.__offlineResult = { receipt: receipt.integrity === "verified" ? "committed" : "invalid", revision: inventory.revision === "0" ? "zero" : "present", regionCount: inventory.regions.length };
            sessionStorage.setItem("offline-test-mode", "read");
          } else {
            const inventory = await store.inventory();
            const regionId = inventory.regions[0]?.id;
            const resource = regionId ? await store.readResource(regionId, "metadata") : undefined;
            const afterRead = await store.inventory();
            const handler = regionId ? createOfflineRegionFetchHandler({ store, regionId, match: (request) => new URL(request.url).pathname === "/features" ? "metadata" : undefined }) : undefined;
            const response = handler ? await handler(new Request("https://example.test/features")) : undefined;
            const head = handler ? await handler(new Request("https://example.test/features", { method: "HEAD" })) : undefined;
            const miss = handler ? await handler(new Request("https://example.test/other")) : undefined;
            window.__offlineResult = { revision: inventory.revision === "0" ? "zero" : "present", regionCount: inventory.regions.length, logicalByteLength: inventory.regions[0]?.logicalByteLength, resource: resource ? new TextDecoder().decode(resource.bytes) : "missing", sourceVersion: resource?.manifest.source.sourceVersion, lastAccessedChanged: afterRead.regions[0]?.lastAccessedAt > inventory.regions[0]?.lastAccessedAt, intercepted: response ? await response.text() : "missing", contentType: response?.headers.get("content-type"), sourceHeader: response?.headers.get("x-honua-offline-source-version"), headBody: head ? await head.text() : "missing", miss: miss === undefined };
          }
        };
        run().catch((error) => { window.__offlineResult = { error: String(error) }; });
      </script>`);
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
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
