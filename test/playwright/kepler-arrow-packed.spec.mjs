import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function buildSplitPackage(root) {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run build:split-packages --silent"] : ["run", "build:split-packages", "--silent"];
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}

function assertSplitPackageExists(root) {
  const packageRoot = path.join(root, "dist", "packages", "honua-sdk");
  if (!fs.existsSync(path.join(packageRoot, "kepler", "index.js"))) {
    throw new Error(
      "Packed SDK output is missing. Run `npm run verify:split-packages` before the packed browser qualification.",
    );
  }
}

function startPackageServer(root) {
  const packageRoot = path.join(root, "dist", "packages", "honua-sdk");
  const html = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  import {
    createKeplerWorkspaceBridge,
    evaluateKeplerCompatibility,
    projectArrowTableToKeplerDataset,
  } from "/kepler/index.js";

  const provenance = {
    sourceId: "packed-arrow-fixture",
    sourceVersion: "fixture-1",
    planId: "plan-packed-arrow",
    authorizationScope: "scope:fixture-read",
    attribution: "Honua SDK packed qualification fixture",
    freshness: { observedAt: "2026-07-30T00:00:00.000Z" },
  };
  const processors = {
    version: "3.2.6",
    processArrowTable: () => ({
      fields: [
        { name: "objectid", type: "integer" },
        { name: "observed_at", type: "timestamp" },
        { name: "value", type: "real" },
      ],
      rows: [
        [1, "2026-07-30T00:00:00.000Z", 4.5],
        [2, "2026-07-30T01:00:00.000Z", 5.25],
      ],
    }),
  };

  try {
    const projection = projectArrowTableToKeplerDataset({
      datasetId: "packed-readings",
      label: "Packed readings",
      arrowTable: { fixture: true },
      provenance,
      rowIdentityField: "objectid",
      temporalFields: ["observed_at"],
    }, processors);
    const bridge = createKeplerWorkspaceBridge({
      peers: { version: "3.2.6", addDataToMap: (payload) => ({ type: "add", payload }) },
      processors,
    });
    const opened = bridge.openArrowTable({
      datasetId: "packed-readings",
      label: "Packed readings",
      arrowTable: { fixture: true },
      provenance,
      rowIdentityField: "objectid",
      temporalFields: ["observed_at"],
    });
    window.__packedArrowQualification = {
      contractVersion: projection.contractVersion,
      compatibility: evaluateKeplerCompatibility("3.2.6"),
      projection: {
        strategy: projection.diagnostic.strategy,
        geoJsonBytes: projection.diagnostic.geoJsonBytes,
        rows: projection.metrics.rows,
        fields: projection.metrics.fields,
        provenance: projection.dataset.metadata.provenance,
        temporalFields: projection.dataset.metadata.temporalFields,
        rowIdentityField: projection.dataset.metadata.rowIdentityField,
      },
      bridge: {
        dispatched: opened.dispatched,
        datasetIds: bridge.datasetIds,
        metrics: bridge.metrics,
      },
    };
  } catch (error) {
    window.__packedArrowQualificationError = error instanceof Error ? error.message : String(error);
  }
</script>`;

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    const relative = requestUrl.pathname.slice(1);
    const filePath = path.resolve(packageRoot, relative);
    if (!filePath.startsWith(`${packageRoot}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test.describe.configure({ timeout: 240_000 });

test.beforeAll(() => {
  buildSplitPackage(projectRoot());
});

test("packed /kepler entrypoint qualifies the Arrow adapter in a real browser", async ({ page }) => {
  const root = projectRoot();
  assertSplitPackageExists(root);
  const server = await startPackageServer(root);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind packed SDK server.");
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
    await expect.poll(() => page.evaluate(() => window.__packedArrowQualification ?? null)).toMatchObject({
      contractVersion: "1.0",
      compatibility: { supported: true },
      projection: {
        strategy: "arrow-table-processor",
        geoJsonBytes: 0,
        rows: 2,
        fields: 3,
        provenance: { sourceId: "packed-arrow-fixture", planId: "plan-packed-arrow" },
        temporalFields: ["observed_at"],
        rowIdentityField: "objectid",
      },
      bridge: { dispatched: false, datasetIds: ["packed-readings"], metrics: { datasets: 1, rows: 2 } },
    });
    expect(await page.evaluate(() => window.__packedArrowQualificationError ?? null)).toBeNull();
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
