import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exampleRoot = path.join(projectRoot, "docs", "examples", "shared-renderer-state");

function mime(filePath) {
  return { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2" }[path.extname(filePath)] ?? "application/octet-stream";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let filePath = pathname === "/" ? path.join(exampleRoot, "index.html") : null;
    if (pathname === "/app.mjs") filePath = path.join(exampleRoot, "app.mjs");
    if (pathname.startsWith("/dist/src/") || pathname.startsWith("/node_modules/")) filePath = path.join(projectRoot, pathname.slice(1));
    if (filePath?.startsWith(projectRoot) && fs.existsSync(filePath)) {
      response.writeHead(200, { "content-type": mime(filePath) });
      response.end(fs.readFileSync(filePath));
      return;
    }
    response.writeHead(404).end("Not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("real MapLibre and Cesium renderers share versioned application state", async ({ page }) => {
  const server = await startServer();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.__sharedRendererStateDone), { message: `fixture module failed: ${pageErrors.join("; ")}` })
      .toBe("boolean");
    await expect.poll(() => page.evaluate(() => globalThis.__sharedRendererStateDone)).toBe(true);
    const error = await page.evaluate(() => globalThis.__sharedRendererStateError);
    const result = await page.evaluate(() => globalThis.__sharedRendererStateResult);

    expect(pageErrors).toEqual([]);
    expect(error).toBeNull();
    expect(result).toMatchObject({
      canvasEvidence: { maplibre: true, cesium: true },
      revision: 5,
      listenerCountsAfterDispose: { maplibre: 0, cesium: 0 },
      mapState: {
        filters: { severity: { field: "severity", operator: ">=", value: 3 } },
        time: { currentTime: "2026-07-11T12:00:02.000Z", playing: true },
        camera: { longitude: -157.84, latitude: 21.29, height: 8000 },
      },
      globeState: {
        selection: [{ sourceId: "live-incidents", id: 17 }],
      },
    });
    expect(result.slices).toEqual(["camera", "filters", "selection", "time"]);
    expect(result.diagnostics).toEqual(expect.arrayContaining(["coalesced", "loop-suppressed"]));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
