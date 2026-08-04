/**
 * Real-Cesium browser fixture matrix and teardown budgets for the scene adapter
 * (honua-sdk-js#928).
 *
 * Every other scene-adapter test in this repository runs in jsdom against a
 * `vi.mock("cesium")` stub. This lane is the opposite: a real Chromium page, the
 * real `cesium` package, a real WebGL context, and the SDK's public
 * `createCesiumSceneAdapter` surface driving a live `Viewer`.
 *
 * Run it on its own with:
 *
 *     npm run build && npm run test:playwright:cesium-scene
 *
 * `HONUA_CESIUM_FIXTURE_REPORT=1` additionally prints the per-cycle apply and
 * teardown timings the budgets below were derived from.
 *
 * It is also picked up by the repository's default Playwright project, so CI's
 * `npm run test:playwright:prepared` browser-smoke step runs it on the same gate
 * as every other browser spec (REQ-004).
 *
 * GL strategy: Playwright's bundled headless Chromium rasterizes WebGL through
 * SwiftShader (a CPU rasterizer). That is real WebGL — contexts, shaders,
 * textures, and buffers are genuinely allocated and released — so no
 * reduced-fidelity fallback is needed and this lane never silently skips.
 * SwiftShader is slow, which is why the timing budgets below are absolute
 * regression ceilings with wide headroom rather than performance claims.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  FIXTURE_ORIGIN,
  buildQuantizedMeshTile,
  buildSolidPng,
  buildTerrainLayerJson,
  buildTilesetJson,
  buildTriangleGlb,
} from "./cesium-scene-fixture-assets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Mount/unmount cycles per run.
 *
 * One cycle proves teardown happens; repeated cycles on fresh viewers are what
 * turn that into a leak budget, because anything the adapter fails to release
 * accumulates monotonically across them. Four keeps the whole lane around 20s on
 * a SwiftShader runner while still giving three post-warmup cycles to compare
 * against each other.
 */
const CYCLES = 4;

/**
 * Absolute teardown budgets.
 *
 * Measured before they were written down. Repeated 4-cycle runs on Playwright's
 * bundled headless chromium with SwiftShader (no GPU), on a loaded multi-core
 * dev box, produced:
 *
 *   layerTeardownMs   1.0 – 4.2 ms    → ceiling   250 ms
 *   viewerDestroyMs   1.8 – 6.7 ms    → ceiling 1 500 ms
 *   totalMs           2.9 – 10.9 ms   → ceiling 2 000 ms
 *
 * The first cycle is always the slowest (cold shader/worker warmup); cycles 2-4
 * settle around a third of it.
 *
 * The ceilings are two orders of magnitude above the observed values on
 * purpose. They exist to catch a teardown path that starts *blocking* — a
 * synchronous GPU flush, a busy-wait on a worker, an unbounded destroy loop —
 * not to police runner jitter. A regression that matters here changes teardown
 * from "microseconds of bookkeeping" to "seconds of stalling"; anything
 * narrower would flake on a shared CI runner without catching more real bugs.
 */
const TEARDOWN_BUDGET_MS = {
  layerTeardown: 250,
  viewerDestroy: 1_500,
  total: 2_000,
};

/**
 * Retention budgets.
 *
 * Where the adapter or the viewer owns a resource outright the honest bound is
 * exactly zero, and that is what is asserted. Three resources are not owned
 * outright, and each is bounded by what was actually measured rather than by
 * what would look tidier:
 *
 *  - Web workers: CesiumJS pools its `TaskProcessor` workers globally and
 *    deliberately does not terminate them on viewer destroy → non-growth after
 *    the warmup cycle, asserted separately.
 *  - The final cycle's WebGL canvas: pinned by Chromium, not by the page.
 *  - DOM listeners bound to the widget's own elements: released with the element
 *    rather than through `removeEventListener` → constant per cycle, bounded.
 */
const RETENTION_BUDGET = {
  scenePrimitivesAfterLayerRemoval: 0,
  imageryLayersAfterLayerRemoval: 0,
  canvasesInContainer: 0,
  pendingAnimationFrames: 0,
  /** Every destroyed `Viewer` object graph must become unreachable. */
  retainedViewers: 0,
  /**
   * Chromium pins the most recently used WebGL canvas independently of the
   * page's references (creating a throwaway context afterwards does not
   * displace it), so one surviving canvas — and only the final cycle's — is the
   * honest floor here. A real retention bug accumulates instead, which this
   * bound catches.
   */
  retainedCanvases: 1,
  liveWebglContexts: 1,
  /**
   * Net `addEventListener` minus `removeEventListener` calls per cycle. Measured
   * at exactly 8, constant across cycles; the ceiling leaves room for a Cesium
   * upgrade that binds a couple more without hiding an accumulating leak (which
   * the constant-across-cycles assertion catches independently).
   */
  netListenersPerCycle: 16,
};

function mimeTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ktx2":
      return "image/ktx2";
    default:
      return "application/octet-stream";
  }
}

function resolveStaticPath(requestPath) {
  if (requestPath === "/") return path.join(projectRoot, "test/playwright/cesium-scene-adapter-fixture.html");
  if (
    requestPath.startsWith("/dist/src/") ||
    requestPath.startsWith("/node_modules/cesium/") ||
    requestPath === "/test/playwright/cesium-scene-adapter-fixture.mjs"
  ) {
    return path.join(projectRoot, requestPath.slice(1));
  }
  return null;
}

/**
 * Serve the fixture page, the built SDK, the real Cesium runtime, and every 3D
 * asset the plan binds — all from loopback, all generated or checked in, so the
 * lane makes no network request whatsoever (AC-5).
 */
function startFixtureServer() {
  const glb = buildTriangleGlb();
  const tilesetJson = Buffer.from(JSON.stringify(buildTilesetJson()), "utf8");
  const terrainLayerJson = Buffer.from(JSON.stringify(buildTerrainLayerJson()), "utf8");
  const terrainTile = buildQuantizedMeshTile();
  const imageryTile = buildSolidPng();
  const requestLog = [];

  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requestLog.push(requestPath);

    const send = (body, contentType) => {
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    };

    if (requestPath === "/fixtures/model.glb" || requestPath === "/fixtures/tileset/content.glb") {
      send(glb, "model/gltf-binary");
      return;
    }
    if (requestPath === "/fixtures/tileset/tileset.json") {
      send(tilesetJson, "application/json; charset=utf-8");
      return;
    }
    if (requestPath === "/fixtures/terrain/layer.json") {
      send(terrainLayerJson, "application/json; charset=utf-8");
      return;
    }
    if (/^\/fixtures\/terrain\/\d+\/\d+\/\d+\.terrain$/.test(requestPath)) {
      send(terrainTile, "application/vnd.quantized-mesh");
      return;
    }
    if (/^\/fixtures\/imagery\/\d+\/\d+\/\d+\.png$/.test(requestPath)) {
      send(imageryTile, "image/png");
      return;
    }

    const filePath = resolveStaticPath(requestPath);
    if (filePath && filePath.startsWith(projectRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      send(fs.readFileSync(filePath), mimeTypeFor(filePath));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Cesium scene fixture server failed to bind.");
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        requestLog,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      });
    });
  });
}

test.describe("Cesium scene adapter — real-Cesium fixture matrix", () => {
  // SwiftShader software rasterization plus four full mount/teardown cycles of a
  // real globe is comfortably slower than the repository's 30s default. The
  // whole run lands around 20s locally; the ceiling is sized for a cold, heavily
  // contended CI runner.
  test.setTimeout(240_000);

  test("mounts every primitive kind on a live viewer and releases everything on teardown", async ({ page }) => {
    const server = await startFixtureServer();
    const consoleErrors = [];
    const pageErrors = [];
    const offOriginRequests = [];

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // Hard evidence for "no network access": anything that is not the loopback
    // fixture origin is aborted and recorded, so an accidental Ion/asset fetch
    // fails the spec instead of quietly succeeding on a networked runner.
    await page.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.hostname === "127.0.0.1") {
        await route.continue();
        return;
      }
      offOriginRequests.push(target.href);
      await route.abort();
    });

    try {
      await page.goto(server.url);
      await expect
        .poll(() => page.evaluate(() => globalThis.__honuaCesiumSceneFixtureReady === true), { timeout: 30_000 })
        .toBe(true);

      const run = await page.evaluate(
        (cycles) => globalThis.__honuaCesiumSceneFixture.runCycles({ cycles }),
        CYCLES,
      );
      const matrix = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.matrix);

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(
          `${JSON.stringify(
            run.cycles.map((cycle) => ({
              index: cycle.index,
              applyMs: cycle.applyMs,
              teardown: {
                layerTeardownMs: cycle.teardown.layerTeardownMs,
                viewerDestroyMs: cycle.teardown.viewerDestroyMs,
                totalMs: cycle.teardown.totalMs,
                liveWorkers: cycle.teardown.liveWorkers,
                pendingAnimationFrames: cycle.teardown.pendingAnimationFrames,
              },
              readyWithinBudget: cycle.evidence.readyWithinBudget,
              resources: cycle.resources,
            })),
            null,
            2,
          )}\n`,
        );
      }

      expect(run.cycles).toHaveLength(CYCLES);

      // --- REQ-001 / AC-1: the whole matrix mounted against a real Viewer ----
      for (const cycle of run.cycles) {
        expect(cycle.evidence.cesiumVersion, "the real cesium package must be loaded").toMatch(/^\d+\.\d+/);
        expect(cycle.evidence.readyWithinBudget, "tileset content and model did not become ready in time").toBe(true);
        expect(cycle.evidence.canvasSize.width, "a real WebGL canvas must be sized").toBeGreaterThan(0);
        expect(cycle.evidence.litPixels, "the globe must actually rasterize pixels").toBeGreaterThan(0);

        // terrain: a real CesiumTerrainProvider built from the local layer.json
        expect(cycle.evidence.terrainProviderIsCesiumTerrain).toBe(true);
        expect(cycle.evidence.verticalExaggeration).toBeCloseTo(1.5, 5);

        // imagery: both bindings reached real Cesium providers, with the
        // adapter's opacity applied to each layer's alpha
        expect(cycle.evidence.imageryProvidersAreUrlTemplate).toEqual([true, true]);
        expect(cycle.evidence.imageryAlphas).toEqual([0.85, 0.35]);

        // 3D Tiles + glTF: real primitives, loaded content, ready model
        expect(cycle.evidence.scenePrimitiveCount).toBe(2);
        expect(cycle.evidence.tilesetLoaded).toBe(true);
        expect(cycle.evidence.tilesetContentReady).toBeGreaterThan(0);
        expect(cycle.evidence.modelReady).toBe(true);

        // camera: the adapter drove the live camera to the plan's viewpoint
        expect(cycle.evidence.camera.longitude).toBeCloseTo(FIXTURE_ORIGIN.longitude, 2);
        expect(cycle.evidence.camera.latitude).toBeCloseTo(FIXTURE_ORIGIN.latitude, 2);
      }

      // --- REQ-002 / AC-2: per-primitive outcome and stable diagnostic codes -
      const first = run.cycles[0];
      expect(first.status).toBe("unsupported"); // the plan deliberately carries one fail-closed binding
      for (const entry of matrix) {
        const observed = first.rendered[entry.id];
        expect(observed, `matrix row ${entry.id} must be reported`).toBeTruthy();
        expect(observed.hasHandle, `${entry.id} handle presence`).toBe(entry.materializes);
        for (const code of entry.expectedDiagnostics) {
          expect(observed.codes, `${entry.id} diagnostics`).toContain(code);
        }
      }

      // the page itself reports the per-binding outcome, not just the harness's
      // return value (the issue's workflow step 3)
      const reportedOutcomes = await page.$$eval("#outcomes tbody tr", (rows) =>
        rows.map((row) => `${row.dataset.binding}:${row.dataset.outcome}`),
      );
      expect(reportedOutcomes).toEqual([
        "fixture-camera:supported",
        "fixture-terrain:supported",
        "fixture-imagery:supported",
        "fixture-imagery-mercator:degraded",
        "fixture-tileset:supported",
        "fixture-model:supported",
        "fixture-i3s:unsupported",
      ]);

      // the deliberately degraded binding renders *and* declares why
      const degraded = first.rendered["fixture-imagery-mercator"];
      expect(degraded.codes).toContain("scene-primitive-crs-equivalent");
      expect(degraded.statuses).toContain("degraded");
      expect(degraded.fidelity).toBe("equivalent");
      expect(degraded.handleKind).toBe("imagery-layer");
      expect(degraded.handleProtocol).toBe("url-template");

      // the deliberately unsupported binding fails closed before Cesium is touched
      const unsupported = first.rendered["fixture-i3s"];
      expect(unsupported.codes).toContain("scene-primitive-model-format-not-materialized");
      expect(unsupported.statuses).toContain("unsupported");
      expect(unsupported.hasHandle).toBe(false);

      // codes are stable across every cycle, not incidental to the first mount
      const codesPerCycle = run.cycles.map((cycle) =>
        cycle.diagnostics.map((entry) => `${entry.primitiveId}:${entry.code}:${entry.status}`).sort(),
      );
      for (const codes of codesPerCycle) expect(codes).toEqual(codesPerCycle[0]);

      // --- REQ-003 / NFR-001 / AC-3: teardown budgets -----------------------
      for (const cycle of run.cycles) {
        const teardown = cycle.teardown;

        // adapter-owned handles are gone *before* the viewer is destroyed
        expect(teardown.afterLayerRemoval.scenePrimitiveCount).toBe(
          RETENTION_BUDGET.scenePrimitivesAfterLayerRemoval,
        );
        expect(teardown.afterLayerRemoval.imageryLayerCount).toBe(RETENTION_BUDGET.imageryLayersAfterLayerRemoval);
        expect(teardown.afterLayerRemoval.terrainProvider).toBeNull();
        expect(teardown.afterLayerRemoval.verticalExaggeration).toBe(1);

        // the viewer itself, its canvas, and its render loop are gone
        expect(teardown.viewerDestroyed).toBe(true);
        expect(teardown.canvasesInContainer).toBe(RETENTION_BUDGET.canvasesInContainer);
        expect(teardown.pendingAnimationFrames).toBe(RETENTION_BUDGET.pendingAnimationFrames);

        // wall-clock ceilings (see TEARDOWN_BUDGET_MS for measured actuals)
        expect(teardown.layerTeardownMs).toBeLessThan(TEARDOWN_BUDGET_MS.layerTeardown);
        expect(teardown.viewerDestroyMs).toBeLessThan(TEARDOWN_BUDGET_MS.viewerDestroy);
        expect(teardown.totalMs).toBeLessThan(TEARDOWN_BUDGET_MS.total);
      }

      // Cesium pools TaskProcessor workers globally and never terminates them on
      // viewer destroy, so the honest budget is non-growth after warmup rather
      // than zero.
      const workersAfterWarmup = run.cycles.slice(1).map((cycle) => cycle.resources.workersCreated);
      expect(
        workersAfterWarmup.every((created) => created === 0),
        `worker pool grew after warmup: ${workersAfterWarmup.join(", ")}`,
      ).toBe(true);

      // The "retained listeners" half of NFR-001. Measured, not assumed: each
      // cycle leaves exactly 8 more `addEventListener` calls than
      // `removeEventListener` calls, identically on every cycle. Those are
      // listeners CesiumJS binds to the widget's own elements and drops with the
      // element rather than through `removeEventListener` — which is legitimate
      // precisely because the element is proven collectible above. So the budget
      // is non-growth plus a ceiling, both of which a real listener leak breaks.
      const netListeners = run.cycles.map((cycle) => cycle.resources.netListeners);
      expect(
        new Set(netListeners).size,
        `per-cycle DOM listener retention is not constant: ${netListeners.join(", ")}`,
      ).toBe(1);
      expect(netListeners[0], "per-cycle DOM listener retention grew").toBeLessThanOrEqual(
        RETENTION_BUDGET.netListenersPerCycle,
      );

      // Every destroyed viewer must become unreachable, and with it the GPU
      // resources it owned. Forced collection uses the same CDP mechanism as
      // `web-components-memory-leak.spec.mjs`.
      //
      // Honest limit: Chromium keeps the *most recently used* WebGL canvas
      // reachable regardless of what the page does with it — creating a
      // throwaway context afterwards does not displace it either, which was
      // measured rather than assumed. So the budget is stated as: every viewer
      // object graph is collectible, and no canvas older than the final cycle
      // survives. That is exactly the property a leak would violate — a real
      // retention bug accumulates across cycles rather than pinning only the
      // last one.
      const client = await page.context().newCDPSession(page);
      let live;
      try {
        await client.send("HeapProfiler.enable");
        live = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.liveRetained());
        for (let attempt = 0; attempt < 8 && (live.viewers > 0 || live.canvases > 1); attempt += 1) {
          await client.send("HeapProfiler.collectGarbage");
          await page.waitForTimeout(100);
          live = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.liveRetained());
        }
      } finally {
        await client.detach();
      }
      const detail = JSON.stringify(live);
      expect(live.total).toBe(CYCLES);
      expect(live.viewers, `destroyed viewers were not collectible: ${detail}`).toBe(
        RETENTION_BUDGET.retainedViewers,
      );
      expect(live.canvases, `WebGL canvases accumulated across cycles: ${detail}`).toBeLessThanOrEqual(
        RETENTION_BUDGET.retainedCanvases,
      );
      expect(
        live.liveCanvasCycles.filter((index) => index !== CYCLES - 1),
        `a WebGL canvas outlived a non-final cycle: ${detail}`,
      ).toEqual([]);

      const finalProbe = await page.evaluate(() => globalThis.__honuaSceneProbe.snapshot());
      expect(finalProbe.liveWebglContexts, `WebGL contexts outlived their viewers: ${detail}`).toBeLessThanOrEqual(
        RETENTION_BUDGET.liveWebglContexts,
      );

      // --- NFR-002 / AC-4: no console errors, no unhandled rejections -------
      expect(run.console, "in-page console.error output").toEqual([]);
      expect(run.errors, "in-page errors and unhandled rejections").toEqual([]);
      expect(consoleErrors, "browser console errors").toEqual([]);
      expect(pageErrors, "page errors").toEqual([]);

      // --- AC-5: no network egress -----------------------------------------
      expect(offOriginRequests, "the fixture must not reach the public internet").toEqual([]);
      expect(server.requestLog.some((entry) => entry.startsWith("/fixtures/"))).toBe(true);
    } finally {
      await server.close();
    }
  });
});
