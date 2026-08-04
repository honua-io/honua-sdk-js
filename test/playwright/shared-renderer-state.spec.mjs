/**
 * Shared 2D/3D application state across two *live* renderers (#395 AC3, #1049).
 *
 * The fixture drives a real MapLibre `Map` and a real Cesium `Viewer` in one
 * page through the SDK's shipped state-sync ports. Every assertion below reads
 * destination-renderer state — `map.getCenter()`, `map.getZoom()`,
 * `map.getFilter()`, `map.getFeatureState()`, `viewer.camera.positionCartographic`,
 * `viewer.selectedEntity`, `viewer.entities.getById(...).show`, `viewer.clock` —
 * rather than a dictionary the fixture kept for itself.
 *
 * Camera expectations are recomputed here from the SDK's own exported
 * correspondence (`mapLibreZoomToCameraHeight` / `mapLibreCameraHeightToZoom`)
 * against the viewport the live map actually reported, so the spec checks the
 * renderer against the shipped math instead of against a literal that mirrors
 * what was pushed in.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exampleRoot = path.join(projectRoot, "docs", "examples", "shared-renderer-state");

/** The default lens the correspondence documents; the viewport is read live. */
const LENS = { fovRadians: 0.6435011087932844, tileSizePixels: 512 };

function mime(filePath) {
  return (
    {
      ".css": "text/css",
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".mjs": "text/javascript",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".wasm": "application/wasm",
      ".woff2": "font/woff2",
      ".ktx2": "image/ktx2",
      ".jpg": "image/jpeg",
      ".gif": "image/gif",
    }[path.extname(filePath)] ?? "application/octet-stream"
  );
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let filePath = pathname === "/" ? path.join(exampleRoot, "index.html") : null;
    if (pathname === "/app.mjs") filePath = path.join(exampleRoot, "app.mjs");
    if (pathname.startsWith("/dist/src/") || pathname.startsWith("/node_modules/"))
      filePath = path.join(projectRoot, pathname.slice(1));
    if (filePath?.startsWith(projectRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      response.writeHead(200, { "content-type": mime(filePath), "cache-control": "no-store" });
      response.end(fs.readFileSync(filePath));
      return;
    }
    response.writeHead(404).end("Not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("real MapLibre and Cesium renderers share versioned application state", async ({ page }) => {
  // Real Cesium on SwiftShader plus a real 2D map is well past the 30s default.
  test.setTimeout(180_000);
  const { mapLibreCameraHeightToZoom, mapLibreZoomToCameraHeight } = await import(
    pathToFileURL(path.join(projectRoot, "dist", "src", "scene-workspace", "index.js")).href
  );
  const server = await startServer();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.__sharedRendererStateDone), {
        message: `fixture module failed: ${pageErrors.join("; ")}`,
        timeout: 60_000,
      })
      .toBe("boolean");
    await expect
      .poll(() => page.evaluate(() => globalThis.__sharedRendererStateDone), { timeout: 120_000 })
      .toBe(true);
    const error = await page.evaluate(() => globalThis.__sharedRendererStateError);
    const result = await page.evaluate(() => globalThis.__sharedRendererStateResult);

    expect(error).toBeNull();
    expect(pageErrors).toEqual([]);
    expect(result.canvasEvidence).toEqual({ maplibre: true, cesium: true });
    expect(result.cesiumVersion, "the real cesium package must be loaded").toMatch(/^\d+\.\d+/);
    expect(result.slices).toEqual([
      "attribution",
      "camera",
      "detail",
      "filters",
      "realtime",
      "selection",
      "time",
    ]);

    const geometry = { ...LENS, viewportHeightPixels: result.mapCamera.viewportHeightPixels };
    expect(geometry.viewportHeightPixels).toBeGreaterThan(0);

    // --- camera 2D -> 3D, asserted on the live globe ------------------------
    expect(result.globeCamera.longitude).toBeCloseTo(-157.86, 6);
    expect(result.globeCamera.latitude).toBeCloseTo(21.31, 6);
    expect(result.globeCamera.heading).toBeCloseTo(8, 4);
    expect(result.globeCamera.pitch).toBeCloseTo(-65, 4);
    expect(result.globeCamera.height).toBeCloseTo(mapLibreZoomToCameraHeight(11, 21.31, 25, geometry), 3);

    // --- camera 3D -> 2D, asserted on the live map --------------------------
    expect(result.mapCamera.center[0]).toBeCloseTo(-157.84, 6);
    expect(result.mapCamera.center[1]).toBeCloseTo(21.29, 6);
    expect(result.mapCamera.bearing).toBeCloseTo(30, 4);
    expect(result.mapCamera.pitch).toBeCloseTo(30, 4);
    expect(result.mapCamera.zoom).toBeCloseTo(
      mapLibreCameraHeightToZoom(8_000, result.mapCamera.center[1], result.mapCamera.pitch, geometry),
      6,
    );

    // --- selection crosses in both directions -------------------------------
    expect(result.selectionFrom2D.cesiumSelectedEntityId).toBe("incident-17");
    expect(result.selectionFrom2D.sharedSelection).toEqual([{ sourceId: "live-incidents", id: 17 }]);
    expect(result.selectionFrom3D.sharedSelection).toEqual([{ sourceId: "live-incidents", id: 18 }]);
    expect(result.selectionFrom3D.mapFeatureState18).toMatchObject({ selected: true });
    expect(result.selectionFrom3D.mapFeatureState17.selected).toBeUndefined();

    // --- filters measurably change both renderers ---------------------------
    expect(result.filters.mapLayerFilter).toEqual([
      "all",
      ["!=", "kind", "exercise"],
      [">=", "severity", 3],
    ]);
    expect(result.filters.cesiumEntityShow).toEqual({ "incident-17": true, "incident-18": false });

    // --- time measurably changes both renderers -----------------------------
    expect(result.time.cesiumClockCurrentTime).toBe("2026-07-11T12:00:02.000Z");
    expect(result.time.cesiumClockAnimating).toBe(true);
    expect(result.time.mapLayerFilter).toEqual([
      "all",
      ["!=", "kind", "exercise"],
      [">=", "severity", 3],
      [">=", "observed_at", Date.parse("2026-07-11T00:00:00.000Z")],
      ["<=", "observed_at", Date.parse("2026-07-11T12:00:02.000Z")],
    ]);

    // --- detail lands on the map and is honestly refused by the globe -------
    expect(result.detail.mapFeatureState17).toMatchObject({ detail: true });
    expect(result.detail.cesiumDetailMapping).toMatchObject({
      inbound: "exact",
      outbound: "unsupported",
      code: "cesium-detail-focus-owned-by-selection",
    });

    // --- attribution derived from live style credit + primitive attribution -
    expect(result.attribution.ids).toEqual(["cesium-world-ellipsoid", "county-orthophotography"]);
    expect(result.realtime).toMatchObject({ status: "connected", freshness: "fresh", cursorPresent: true });

    // --- an unprojectable globe pose degrades, and does not overwrite 3D ----
    expect(result.degraded.codes).toEqual(["camera-latitude-clamped", "camera-pitch-clamped"]);
    expect(result.degraded.latitudeDegradation).toMatchObject({
      portId: "map-2d",
      slice: "camera",
      code: "camera-latitude-clamped",
      requested: 88,
    });
    expect(result.degraded.latitudeDegradation.applied).toBeCloseTo(85.05112877980659, 6);
    // The renderer then applies its own edge constraint on top of the projection
    // clamp, which is exactly why the port records both read-back and delivered
    // poses as echoes instead of publishing the difference back as a new change.
    expect(result.degraded.mapCenterLatitude).toBeLessThanOrEqual(85.05112877980659);
    expect(result.degraded.mapCenterLatitude).toBeGreaterThan(84.9);
    expect(result.degraded.mapPitch).toBe(60);
    // Roll is feature-detected, and every supported renderer major carries it,
    // so it is applied rather than reported as dropped.
    expect(result.degraded.mapRoll).toBeCloseTo(15, 4);
    expect(result.degraded.sharedCameraLatitude).toBe(88);

    // --- loop closure and refusal are both observable -----------------------
    expect(result.diagnostics).toEqual(expect.arrayContaining(["loop-suppressed", "unsupported-target"]));

    // --- listener lifecycles ------------------------------------------------
    expect(result.listeners.mapWhileAttached).toBe(3);
    expect(result.listeners.cesiumWhileAttached).toBe(result.listeners.cesiumBaseline + 3);
    expect(result.afterDispose.mapNetListeners).toBe(0);
    expect(result.afterDispose.cesiumListeners).toBe(result.listeners.cesiumBaseline);
    // Dispose restores exactly what the ports changed.
    expect(result.afterDispose.mapLayerFilter).toEqual(["!=", "kind", "exercise"]);
    expect(result.afterDispose.mapFeatureState17).toEqual({});
    expect(result.afterDispose.cesiumEntityShow).toEqual({ "incident-17": true, "incident-18": true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
