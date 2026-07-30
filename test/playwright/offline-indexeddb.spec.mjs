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
    });
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
        const request = indexedDB.open(name);
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

test("IndexedDB startup recovery removes corrupt records while preserving valid regions", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toMatchObject({ regionCount: 1 });
    const database = await page.evaluate(() => window.__offlineDatabase);
    await page.evaluate(async (name) => {
      const request = indexedDB.open(name);
      await new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      }).then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(["regions", "resources", "staging"], "readwrite");
        transaction.objectStore("regions").put({ id: "broken", manifest: { resources: [] }, logicalByteLength: "bad" });
        transaction.objectStore("resources").put({ key: "orphan\\u0000resource", regionId: "missing", resourceId: "resource", bytes: new Uint8Array([1]) });
        transaction.objectStore("staging").put({ key: "broken-stage", transactionId: "tx", regionId: "missing", resourceId: "resource", bytes: "bad", createdAt: "bad" });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      }));
    }, database);

    const recovered = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name });
      const inventory = await store.inventory();
      const counts = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(["resources", "staging"], "readonly");
          const resources = transaction.objectStore("resources").count();
          const staging = transaction.objectStore("staging").count();
          let resourceCount;
          let stagingCount;
          resources.onsuccess = () => { resourceCount = resources.result; if (stagingCount !== undefined) resolve({ resourceCount, stagingCount }); };
          staging.onsuccess = () => { stagingCount = staging.result; if (resourceCount !== undefined) resolve({ resourceCount, stagingCount }); };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      return { regionCount: inventory.regions.length, counts };
    }, database);
    expect(recovered).toEqual({ regionCount: 1, counts: { resourceCount: 1, stagingCount: 0 } });
  } finally {
    await server.close();
  }
});

test("IndexedDB schema upgrade backfills legacy staging timestamps", async ({ page }) => {
  const server = await startServer();
  try {
    await page.goto(server.url);
    const legacyDatabase = `${await page.evaluate(() => window.__offlineDatabase)}-legacy`;
    await page.evaluate(async (name) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("inventory", { keyPath: "key" });
        db.createObjectStore("regions", { keyPath: "id" });
        const resources = db.createObjectStore("resources", { keyPath: "key" });
        resources.createIndex("regionId", "regionId");
        const staging = db.createObjectStore("staging", { keyPath: "key" });
        staging.createIndex("transactionId", "transactionId");
      };
      const db = await new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("staging", "readwrite");
        transaction.objectStore("staging").put({ key: "legacy-stage", transactionId: "tx", regionId: "region", resourceId: "resource", bytes: new Uint8Array([1, 2, 3]) });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    }, legacyDatabase);
    const createdAt = await page.evaluate(async (name) => {
      const { createIndexedDbOfflineRegionStore } = await import("/dist/src/offline/index.js");
      const store = createIndexedDbOfflineRegionStore({ name, stagingMaxAgeMs: 24 * 60 * 60 * 1000 });
      await store.inventory();
      return await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("staging", "readonly");
          const get = transaction.objectStore("staging").get("legacy-stage");
          get.onsuccess = () => resolve(get.result?.createdAt);
          get.onerror = () => reject(get.error);
        };
      });
    }, legacyDatabase);
    expect(createdAt).toEqual(expect.any(Number));
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
            window.__offlineResult = { revision: inventory.revision === "0" ? "zero" : "present", regionCount: inventory.regions.length, logicalByteLength: inventory.regions[0]?.logicalByteLength, resource: resource ? new TextDecoder().decode(resource.bytes) : "missing", sourceVersion: resource?.manifest.source.sourceVersion, lastAccessedChanged: afterRead.regions[0]?.lastAccessedAt > inventory.regions[0]?.lastAccessedAt };
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
