import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("IndexedDB offline region store survives reload and preserves inventory CAS", async ({ page }) => {
  const server = await startServer();
  const database = `honua-offline-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await page.goto(`${server.url}/?mode=write&database=${encodeURIComponent(database)}`);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toEqual({
      receipt: "committed",
      revision: "present",
      regionCount: 1,
    });

    await page.goto(`${server.url}/?mode=read&database=${encodeURIComponent(database)}`);
    await expect.poll(() => page.evaluate(() => window.__offlineResult)).toEqual({
      revision: "present",
      regionCount: 1,
      logicalByteLength: 3,
    });
  } finally {
    await server.close();
  }
});

async function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><script type="module">
        import {
          createIndexedDbOfflineRegionStore,
          createOfflineRegionManifest,
          downloadOfflineRegion,
        } from "/dist/src/offline/index.js";
        const database = ${JSON.stringify(url.searchParams.get("database"))};
        const digest = async (value) => {
          const bytes = new TextEncoder().encode(value);
          const hash = await crypto.subtle.digest("SHA-256", bytes);
          return "sha256:" + [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const run = async () => {
          const store = createIndexedDbOfflineRegionStore({ name: database });
          if (${JSON.stringify(url.searchParams.get("mode"))} === "write") {
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
          } else {
            const inventory = await store.inventory();
            window.__offlineResult = { revision: inventory.revision === "0" ? "zero" : "present", regionCount: inventory.regions.length, logicalByteLength: inventory.regions[0]?.logicalByteLength };
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
