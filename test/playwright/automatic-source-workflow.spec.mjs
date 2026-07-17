import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exampleRoot = path.join(projectRoot, "docs", "examples", "automatic-source-workflow");

function mime(filePath) {
  return {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
  }[path.extname(filePath)] ?? "application/octet-stream";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let filePath = pathname === "/" ? path.join(exampleRoot, "index.html") : null;
    if (pathname === "/app.mjs") filePath = path.join(exampleRoot, "app.mjs");
    if (pathname.startsWith("/dist/src/") || pathname.startsWith("/node_modules/")) {
      filePath = path.join(projectRoot, pathname.slice(1));
    }
    if (filePath?.startsWith(projectRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      response.writeHead(200, { "content-type": mime(filePath) });
      response.end(fs.readFileSync(filePath));
      return;
    }
    // Deterministic empty response for local tile/query probes from native mounts.
    response.writeHead(204).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("automatic Source→MapLibre workflow drives selection, filter, popup, and realtime across strategies", async ({
  page,
}) => {
  const server = await startServer();
  const pageErrors = [];
  const wmsRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/wms" && url.searchParams.get("REQUEST") === "GetMap") wmsRequests.push(url.href);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
    await page.goto(`http://127.0.0.1:${address.port}`);

    await expect
      .poll(() => page.evaluate(() => globalThis.__automaticSourceWorkflowDone), { timeout: 30_000 })
      .toBe(true);

    const error = await page.evaluate(() => globalThis.__automaticSourceWorkflowError);
    expect(error).toBeNull();
    expect(pageErrors).toEqual([]);

    const result = await page.evaluate(() => globalThis.__automaticSourceWorkflowResult);
    expect(result).not.toBeNull();

    // Strategy selection covers every source shape #390 calls out.
    const strategyNames = [
      "vector-tiles",
      "native-raster-tiles",
      "wms-raster",
      "wmts-raster",
      "pmtiles-vector",
      "pmtiles-raster",
      "dynamic-query-tiles",
    ];
    for (const name of strategyNames) {
      expect(result.strategies[name]?.match, `${name} strategy selection`).toBe(true);
    }

    const wmsTemplate = result.strategies["wms-raster"]?.tileTemplate;
    expect(wmsTemplate).toContain("BBOX={bbox-epsg-3857}");
    expect(wmsTemplate).toContain("WIDTH=256");
    expect(wmsTemplate).toContain("HEIGHT=256");
    expect(wmsTemplate).not.toMatch(/\{(?:bbox-epsg3857|width|height)\}/u);
    expect(wmsRequests.length).toBeGreaterThan(0);
    for (const href of wmsRequests) {
      const url = new URL(href);
      const bbox = url.searchParams.get("BBOX")?.split(",").map(Number);
      expect(bbox).toHaveLength(4);
      expect(bbox?.every(Number.isFinite)).toBe(true);
      expect(url.searchParams.get("WIDTH")).toBe("256");
      expect(url.searchParams.get("HEIGHT")).toBe("256");
      expect(href).not.toMatch(/%7B|%7D|\{|\}/iu);
    }

    // Native strategies mount and dispose cleanly on the real renderer.
    for (const name of ["vector-tiles", "native-raster-tiles", "wms-raster", "dynamic-query-tiles"]) {
      expect(result.strategies[name]?.mounted, `${name} mounted`).toBe(true);
      expect(result.strategies[name]?.disposedClean, `${name} disposed clean`).toBe(true);
    }

    // Golden interactive geojson-query workflow.
    const interactive = result.interactive;
    expect(interactive.layerCount).toBeGreaterThanOrEqual(1);
    expect(interactive.selectionApplied, "selection feature-state").toBe(true);
    expect(interactive.popupApplied, "popup").toBe(true);
    expect(interactive.popupText).toContain("Engine 5");
    expect(interactive.filterApplied, "runtime filter").toBe(true);
    expect(JSON.stringify(interactive.layerFilter)).toContain("status");
    expect(interactive.realtimeApplied, "realtime feature-state").toBe(true);
    expect(interactive.realtimeState).toMatchObject({ status: "responding" });
    expect(interactive.hitTestRan, "hit-test").toBe(true);
    expect(interactive.disposedLeakFree, "leak-free disposal").toBe(true);
    expect(interactive.diagnosticCodes).toEqual(
      expect.arrayContaining(["selection-changed", "filter-registry-bound", "realtime-feature-state", "edit-refreshed"]),
    );

    expect(result.ok).toBe(true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
