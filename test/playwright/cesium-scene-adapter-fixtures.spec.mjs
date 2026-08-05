/**
 * Real-Cesium browser fixture matrix and teardown budgets for the scene adapter
 * (honua-sdk-js#928), its temporal binding (#1048), and the accepted-plan
 * `Source` → entity path (#1050).
 *
 * Every other scene-adapter test in this repository runs in jsdom against a
 * `vi.mock("cesium")` stub. This lane is the opposite: a real Chromium page, the
 * real `cesium` package, a real WebGL context, and the SDK's public
 * `createCesiumSceneAdapter` / `mountScenePrimitivesToCesium` /
 * `mountSourceToCesium` surfaces driving a live `Viewer`.
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
  ENTITY_EXPECTATIONS,
  ENTITY_SOURCE_LAYER_PATH,
  ENTITY_SOURCE_SNAPSHOTS,
  ENTITY_SOURCE_SNAPSHOT_PATH,
  buildEntitySourceLayerMetadata,
  buildEntitySourceQueryResponse,
} from "./cesium-entity-source-fixture.mjs";
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
 *    rather than through `removeEventListener` → bounded as a run total.
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
   * Net `addEventListener` minus `removeEventListener` calls per cycle, asserted
   * as an average over the run. Measured at 8 per cycle; the ceiling leaves room
   * for a Cesium upgrade that binds a couple more without hiding an accumulating
   * leak, which grows the run total.
   */
  netListenersPerCycle: 16,
};

/**
 * Mount/teardown cycles for the accepted-plan entity lane (#1050).
 *
 * Each cycle opens its own SDK connection, mounts, refreshes against a changed
 * source, and tears everything down, so three cycles cost noticeably more than
 * three primitive cycles. Three still gives two post-warmup cycles for the
 * retention sums below to accumulate against.
 */
const ENTITY_CYCLES = 3;

/**
 * Retention budgets for the entity lane.
 *
 * Every budget here is a *total across the whole run*, never a per-cycle
 * equality: this lane opens and closes an SDK connection per cycle whose
 * teardown is asynchronous, so per-cycle splits are not stable quantities even
 * when nothing leaks — that shape is what flaked in honua-sdk-js#1055. Totals
 * still catch what matters, because a real retention bug scales with cycles
 * while these ceilings do not.
 *
 * Measured over repeated three- and five-cycle runs: after forced GC exactly one
 * cycle's object graph stays reachable — its canvas, its viewer, and one of its
 * entities — and it is always the most recent one. Older cycles release
 * everything. That is the same Chromium floor `RETENTION_BUDGET.retainedCanvases`
 * documents, now observed to pin the viewer and entity hanging off it too.
 *
 * `netListenersTotal` was measured at 24 for a three-cycle run (8 per cycle, all
 * of them listeners CesiumJS binds to its own widget elements and drops with the
 * element rather than through `removeEventListener`). The ceiling leaves room
 * for a Cesium upgrade without hiding a leak.
 */
const ENTITY_RETENTION_BUDGET = {
  retainedViewers: 1,
  retainedCanvases: 1,
  netListenersTotal: 64,
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

const FIXTURE_MODULES = new Set([
  "/test/playwright/cesium-scene-adapter-fixture.mjs",
  "/test/playwright/cesium-entity-source-fixture.mjs",
]);

function resolveStaticPath(requestPath) {
  if (requestPath === "/") return path.join(projectRoot, "test/playwright/cesium-scene-adapter-fixture.html");
  if (
    requestPath.startsWith("/dist/src/") ||
    requestPath.startsWith("/node_modules/cesium/") ||
    FIXTURE_MODULES.has(requestPath)
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
  // Which feature snapshot the entity fixture layer answers with. `refresh()`
  // re-executes the accepted plan unchanged, so the source has to be the thing
  // that changes; the page selects the snapshot explicitly rather than relying
  // on request ordering.
  let entitySnapshot = "a";

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    requestLog.push(requestPath);

    const send = (body, contentType) => {
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    };
    const sendJson = (body) => send(Buffer.from(JSON.stringify(body), "utf8"), "application/json; charset=utf-8");

    if (requestPath === ENTITY_SOURCE_SNAPSHOT_PATH) {
      const requested = requestUrl.searchParams.get("name");
      if (!Object.hasOwn(ENTITY_SOURCE_SNAPSHOTS, requested ?? "")) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Unknown snapshot");
        return;
      }
      entitySnapshot = requested;
      sendJson({ snapshot: entitySnapshot });
      return;
    }
    if (requestPath === ENTITY_SOURCE_LAYER_PATH) {
      sendJson(buildEntitySourceLayerMetadata());
      return;
    }
    if (requestPath === `${ENTITY_SOURCE_LAYER_PATH}/query`) {
      sendJson(buildEntitySourceQueryResponse(entitySnapshot));
      return;
    }

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

/**
 * Wire one page against a freshly bound fixture server: loopback-only routing,
 * console/pageerror capture, and the harness readiness gate. Shared by both
 * tests so the "no network, no console errors" evidence is identical in each.
 */
async function openFixturePage(page) {
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

  await page.goto(server.url);
  await expect
    .poll(() => page.evaluate(() => globalThis.__honuaCesiumSceneFixtureReady === true), { timeout: 30_000 })
    .toBe(true);

  return { server, consoleErrors, pageErrors, offOriginRequests };
}

test.describe("Cesium scene adapter — real-Cesium fixture matrix", () => {
  // SwiftShader software rasterization plus four full mount/teardown cycles of a
  // real globe is comfortably slower than the repository's 30s default. The
  // whole run lands around 20s locally; the ceiling is sized for a cold, heavily
  // contended CI runner.
  test.setTimeout(240_000);

  test("mounts every primitive kind on a live viewer and releases everything on teardown", async ({ page }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
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
      // cycle leaves around 8 more `addEventListener` calls than
      // `removeEventListener` calls. Those are listeners CesiumJS binds to the
      // widget's own elements and drops with the element rather than through
      // `removeEventListener` — which is legitimate precisely because the element
      // is proven collectible above.
      //
      // Bounded as a run total rather than as a per-cycle equality: which cycle a
      // listener is attributed to depends on when asynchronous teardown lands, so
      // the split is not a stable quantity even when nothing leaks (that shape is
      // honua-sdk-js#1055). A real listener leak grows the sum instead.
      const netListeners = run.cycles.map((cycle) => cycle.resources.netListeners);
      expect(
        netListeners.reduce((total, value) => total + value, 0),
        `DOM listener retention across ${CYCLES} cycles: ${netListeners.join(", ")}`,
      ).toBeLessThanOrEqual(RETENTION_BUDGET.netListenersPerCycle * CYCLES);

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

  /**
   * Application time and realtime deltas against a real `Viewer` (#1048).
   *
   * The two properties this proves are the ones the epic's REQ-004 asks for and
   * that no jsdom seam can settle on its own:
   *
   *  1. Advancing application time moves the live `viewer.clock`, Cesium's own
   *     availability predicate changes answer because of it, and *nothing* is
   *     rebuilt — proven by object identity of the layer handles and of the live
   *     `Cesium3DTileset` across the update.
   *  2. A realtime-shaped delta rebuilds exactly the binding whose configuration
   *     changed, leaves the rest attached by identity, reaches the renderer (the
   *     live `ImageryLayer.alpha` moves), and names the boundary it crossed.
   */
  test("binds application time and applies a realtime delta without rebuilding the scene", async ({ page }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
      const run = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.runTemporal());
      const { temporal } = run;

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(`${JSON.stringify(temporal, null, 2)}\n`);
      }

      expect(temporal.cesiumVersion, "the real cesium package must be loaded").toMatch(/^\d+\.\d+/);

      // --- the clock is bound, and only because the target opted in ---------
      expect(temporal.initial.timeCodes, "the mount must report how time was bound").toEqual(["scene-time-applied"]);
      expect(Date.parse(temporal.initial.clock)).toBe(Date.parse(temporal.times.beforeWindow));
      expect(temporal.initial.clock).not.toBe(temporal.clockBeforeMount);
      expect(temporal.initial.rebuildBoundaries, "the initial application crosses no boundary").toEqual([]);
      expect(temporal.initial.entityAvailable, "the probe entity must start outside its availability window").toBe(
        false,
      );

      // --- advancing time rebuilds nothing ----------------------------------
      const advanced = temporal.advanced;
      expect(advanced.revision).toBe(2);
      expect(Date.parse(advanced.clock)).toBe(Date.parse(temporal.times.insideWindow));
      expect(advanced.timeCodes).toEqual(["scene-time-applied"]);
      expect(advanced.entityAvailable, "Cesium availability must follow the bound application time").toBe(true);

      expect(advanced.created, "an in-place time update must construct nothing").toEqual([]);
      expect(advanced.disposed, "an in-place time update must release nothing").toEqual([]);
      expect(advanced.reused.sort()).toEqual(["fixture-imagery", "fixture-tileset"]);
      expect(advanced.handlesReusedByIdentity, "every layer handle must survive the time update by identity").toBe(
        true,
      );
      expect(advanced.tilesetPrimitiveReused, "the live Cesium3DTileset instance must survive the time update").toBe(
        true,
      );
      expect(advanced.scenePrimitiveCount, "the adapter still owns exactly the tileset").toBe(1);
      expect(advanced.imageryLayerCount).toBe(1);
      // Every plan binding is accounted for, including the handle-less camera:
      // an unchanged viewpoint is not re-driven under a moving clock.
      expect(advanced.rebuildBoundaries).toEqual([
        "fixture-camera:none:in-place",
        "fixture-imagery:none:in-place",
        "fixture-tileset:none:in-place",
      ]);
      expect(advanced.rebuildBoundaryDiagnostics, "no boundary was crossed, so none may be reported").toBe(0);

      // --- a data delta rebuilds only what changed --------------------------
      const delta = temporal.delta;
      expect(delta.revision).toBe(3);
      expect(delta.created).toEqual(["fixture-imagery"]);
      expect(delta.disposed).toEqual(["fixture-imagery"]);
      expect(delta.reused).toEqual(["fixture-tileset"]);
      expect(delta.tilesetHandleReused, "the unchanged binding's handle must be carried forward").toBe(true);
      expect(delta.tilesetPrimitiveReused, "the unchanged binding's Cesium object must not be reconstructed").toBe(
        true,
      );
      expect(delta.imageryHandleRebuilt, "the changed binding must get a new handle").toBe(true);
      expect(delta.imageryAlpha, "the rebuild must reach the renderer").toBeCloseTo(0.4, 3);
      expect(delta.imageryLayerCount, "the displaced imagery layer must not linger").toBe(1);
      expect(delta.scenePrimitiveCount, "the delta added no scene primitive").toBe(1);
      expect(delta.rebuildBoundaries).toEqual([
        "fixture-camera:none:in-place",
        "fixture-imagery:primitive-configuration:rebuilt",
        "fixture-tileset:none:in-place",
      ]);
      expect(delta.boundaryDiagnostics).toEqual(["fixture-imagery:primitive-configuration"]);
      expect(delta.appliedContext, "the delta's realtime provenance travels with the application").toEqual({
        status: "live",
        cursor: "fixture-seq-2",
      });

      // --- teardown, on #1026's measured ceilings ---------------------------
      const teardown = temporal.teardown;
      expect(teardown.afterLayerRemoval.imageryLayerCount).toBe(RETENTION_BUDGET.imageryLayersAfterLayerRemoval);
      expect(teardown.afterLayerRemoval.scenePrimitiveCount).toBe(RETENTION_BUDGET.scenePrimitivesAfterLayerRemoval);
      expect(teardown.afterLayerRemoval.mountState).toBe("disposed");
      expect(teardown.viewerDestroyed).toBe(true);
      expect(teardown.canvasesInContainer).toBe(RETENTION_BUDGET.canvasesInContainer);
      expect(teardown.layerTeardownMs).toBeLessThan(TEARDOWN_BUDGET_MS.layerTeardown);
      expect(teardown.viewerDestroyMs).toBeLessThan(TEARDOWN_BUDGET_MS.viewerDestroy);
      expect(teardown.totalMs).toBeLessThan(TEARDOWN_BUDGET_MS.total);

      expect(run.console, "in-page console.error output").toEqual([]);
      expect(run.errors, "in-page errors and unhandled rejections").toEqual([]);
      expect(consoleErrors, "browser console errors").toEqual([]);
      expect(pageErrors, "page errors").toEqual([]);
      expect(offOriginRequests, "the fixture must not reach the public internet").toEqual([]);
    } finally {
      await server.close();
    }
  });

  /**
   * The accepted-plan `Source` → Cesium entity path against a real `Viewer`
   * (#1050).
   *
   * Before this case the entity slice had no real-Cesium evidence at all: its
   * only coverage ran in jsdom against a `vi.mock("cesium")` stub. Here the
   * page connects to a loopback GeoServices layer with `createHonua()`, accepts
   * a plan with `explainQuery`, and hands both to `mountSourceToCesium` — the
   * SDK's own entity code path, with no Cesium module injected, so the lazy
   * optional-peer import is exercised too.
   *
   * What only a real runtime can settle, and what is therefore asserted here:
   *
   *  1. Every projected feature became a real `Cesium.Entity` whose position is
   *     a real `Cartesian3` that converts back to the source coordinate,
   *     including the ellipsoidal height the mount required a vertical datum for.
   *  2. Cesium — not the SDK — decides availability, and its answer changes with
   *     the clock the page moves. The point pair is drawn at one instant and not
   *     at the other, read out of a real GPU pick pass.
   *  3. The polygon's interior ring reached the GPU: the zone is picked on its
   *     solid side and not inside its hole.
   *  4. Refresh is a diff, and the only place that claim can be settled is a
   *     live collection: a byte-identical feature comes back as the *same*
   *     `Entity` object, with the `viewer.selectedEntity` set on it still
   *     pointing at it, while a changed feature keeps its object and a departed
   *     one leaves (see `docs/cesium-entity-adapter.md`).
   *  5. Disposal returns the collection to baseline, and the entities, viewers,
   *     canvases, and listeners the run creates stop accumulating.
   */
  test("mounts entities from a Source onto a live viewer and releases every one on teardown", async ({ page }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
      const run = await page.evaluate(
        (cycles) => globalThis.__honuaCesiumSceneFixture.runEntityCycles({ cycles }),
        ENTITY_CYCLES,
      );

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(
          `${JSON.stringify(
            run.cycles.map((cycle) => ({
              index: cycle.index,
              mountMs: cycle.mountMs,
              refreshMs: cycle.refresh.ms,
              teardown: cycle.teardown,
              resources: cycle.resources,
              litPixels: cycle.litPixels,
            })),
            null,
            2,
          )}\n`,
        );
      }

      expect(run.cycles).toHaveLength(ENTITY_CYCLES);

      for (const cycle of run.cycles) {
        expect(cycle.cesiumVersion, "the real cesium package must be loaded").toMatch(/^\d+\.\d+/);
        expect(cycle.descriptorProtocol, "the plan must come from a real connected source").toBe(
          "geoservices-feature-service",
        );
        expect(cycle.planFingerprint, "the mount re-hashes the plan it was handed").toMatch(/^sha256:[0-9a-f]{64}$/);

        // --- REQ-001 / AC-1: entities materialized through the public path ----
        expect(cycle.mountedIds, "every projectable feature must mount, in source order").toEqual(cycle.expectedIds);
        expect(cycle.litPixels, "the globe carrying the entities must actually rasterize").toBeGreaterThan(0);

        for (const expected of ENTITY_EXPECTATIONS.a) {
          const observed = cycle.described[expected.featureId];
          expect(observed, `entity ${expected.featureId} must be present`).toMatchObject({
            present: true,
            isCesiumEntity: true,
            kind: expected.kind,
            availabilityIsTimeIntervalCollection: true,
            label: expected.label,
          });
          if (expected.kind === "point") {
            expect(observed.positionIsCartesian3).toBe(true);
            // Round-tripped through real Cesium geodesy, not compared to the
            // SDK's own copy of the number.
            expect(observed.cartographic.longitude).toBeCloseTo(expected.position.longitude, 6);
            expect(observed.cartographic.latitude).toBeCloseTo(expected.position.latitude, 6);
            expect(observed.cartographic.height, "the declared vertical datum must survive").toBeCloseTo(
              expected.position.height,
              1,
            );
          }
          if (expected.kind === "polyline") {
            expect(observed.polylineVertexCount).toBe(expected.vertexCount);
            expect(observed.polylinePositionsAreCartesian3).toBe(true);
          }
          if (expected.kind === "polygon") {
            expect(observed.hierarchyIsPolygonHierarchy).toBe(true);
            expect(observed.holeCount).toBe(expected.holeCount);
            expect(observed.hierarchyPositionsAreCartesian3).toBe(true);
          }
        }

        // --- AC-2: omissions are reported, never quietly substituted ----------
        expect(cycle.state, "omitted features make the mount honestly degraded").toBe("degraded");
        for (const code of ENTITY_EXPECTATIONS.omittedDiagnostics) {
          expect(cycle.diagnostics.some((entry) => entry.startsWith(`${code}:`)), `diagnostic ${code}`).toBe(true);
        }
        expect(cycle.diagnostics[0]).toBe("strategy-selected:info:exact");

        // --- AC-3: Cesium decides availability, and it follows the clock ------
        const inside = cycle.availability.insideWindow;
        const early = cycle.availability.earlyWindow;
        for (const expected of ENTITY_EXPECTATIONS.a) {
          expect(inside.isAvailable[expected.featureId], `${expected.featureId} @ inside`).toBe(
            expected.availableAt.insideWindow,
          );
          expect(early.isAvailable[expected.featureId], `${expected.featureId} @ early`).toBe(
            expected.availableAt.earlyWindow,
          );
        }
        // Availability is not just bookkeeping: it decides what is drawn.
        expect(inside.picked, "the day-shift unit renders only inside its window").toEqual({
          "medic-1": true,
          "engine-2": false,
        });
        expect(early.picked, "the night-shift unit renders only inside its window").toEqual({
          "medic-1": false,
          "engine-2": true,
        });

        // --- the polygon hole is a real hole ----------------------------------
        expect(cycle.polygonPicks.solid, "the zone must be drawn where it is solid").toBe(true);
        expect(cycle.polygonPicks.hole, "the zone's interior ring must not be drawn").toBe(false);

        // --- AC-4: refresh, and the rebuild boundary it declares ---------------
        const refresh = cycle.refresh;
        expect(refresh.ids, "the refreshed snapshot is what the source now returns").toEqual(refresh.expectedIds);
        expect(refresh.departedId).toContain("patrol-3");
        expect(refresh.departedRemovedFromCollection, "a departed feature must leave the collection").toBe(true);
        expect(refresh.arrivedId).toContain("ladder-9");
        expect(refresh.arrived).toMatchObject({ present: true, isCesiumEntity: true, kind: "point" });
        expect(refresh.moved.cartographic.longitude).toBeCloseTo(ENTITY_EXPECTATIONS.b[1].position.longitude, 6);
        expect(refresh.entityCount, "no orphan may survive the reconciliation").toBe(ENTITY_EXPECTATIONS.b.length);
        expect(refresh.revision).toBe(2);
        // The diff partition: two features untouched (the point and the
        // hole-bearing polygon, both byte-identical across the snapshots), one
        // updated in place, one constructed, one released.
        expect(refresh.reused).toEqual([`${cycle.sourceId}:s:medic-1`, `${cycle.sourceId}:s:zone-a`]);
        expect(refresh.updated).toEqual([`${cycle.sourceId}:s:engine-2`]);
        expect(refresh.created).toEqual([`${cycle.sourceId}:s:ladder-9`]);
        expect(refresh.disposed).toEqual([`${cycle.sourceId}:s:patrol-3`]);
        expect(refresh.boundaries).toEqual([
          `${cycle.sourceId}:s:engine-2:entity-configuration`,
          `${cycle.sourceId}:s:ladder-9:entity-identity`,
          `${cycle.sourceId}:s:patrol-3:snapshot-membership`,
        ]);
        expect(refresh.rebuildBoundary, "the escalated boundary names the worst crossing").toBe("snapshot-membership");
        // The load-bearing measurement, inverted by #1050's refresh diff:
        // `medic-1` is byte-identical across both snapshots and now comes back as
        // the SAME `Entity` object, asserted by object identity on a live
        // collection rather than inferred from the source.
        expect(
          refresh.unchangedEntityPreserved,
          "a byte-identical feature must keep its live Entity object across refresh()",
        ).toBe(true);
        expect(refresh.unchangedStillPresent).toBe(true);
        // A changed feature keeps its object too: only the facets that moved are
        // written onto it.
        expect(refresh.movedEntityPreserved, "a changed feature is updated in place, not replaced").toBe(true);
        expect(refresh.movedPositionChanged, "and the update actually reached the live entity").toBe(true);
        // Host-set state is the reason any of this matters. Cesium clears
        // `selectedEntity` when the entity leaves the collection, so this holds
        // only because the entity was never removed.
        expect(refresh.selectionApplied, "the fixture must have set viewer.selectedEntity before refreshing").toBe(
          true,
        );
        expect(refresh.selectedEntitySurvived, "viewer.selectedEntity must survive a refresh").toBe(true);

        // --- REQ-002 / NFR-001: teardown -------------------------------------
        const teardown = cycle.teardown;
        expect(teardown.afterEntityRemoval.entityCount, "the mount owns every entity it added").toBe(0);
        expect(teardown.afterEntityRemoval.residualIds).toEqual([]);
        expect(teardown.afterEntityRemoval.mountState).toBe("disposed");
        expect(teardown.viewerDestroyed).toBe(true);
        expect(teardown.canvasesInContainer).toBe(RETENTION_BUDGET.canvasesInContainer);
        expect(teardown.pendingAnimationFrames).toBe(RETENTION_BUDGET.pendingAnimationFrames);
        expect(teardown.entityTeardownMs).toBeLessThan(TEARDOWN_BUDGET_MS.layerTeardown);
        expect(teardown.viewerDestroyMs).toBeLessThan(TEARDOWN_BUDGET_MS.viewerDestroy);
        expect(teardown.totalMs).toBeLessThan(TEARDOWN_BUDGET_MS.total);
      }

      // Cesium's global worker pool is warmed by the first cycle and never
      // terminated on viewer destroy, so the honest budget is non-growth after it.
      const workersAfterWarmup = run.cycles.slice(1).map((cycle) => cycle.resources.workersCreated);
      expect(
        workersAfterWarmup.every((created) => created === 0),
        `worker pool grew after warmup: ${workersAfterWarmup.join(", ")}`,
      ).toBe(true);

      // DOM listener retention is bounded in *total* rather than compared cycle
      // to cycle: this lane runs a full SDK connection per cycle, whose teardown
      // is asynchronous, so the per-cycle split is not a stable quantity even
      // when nothing leaks (honua-sdk-js#1055). A real leak still breaks the sum.
      const netListeners = run.cycles.reduce((total, cycle) => total + cycle.resources.netListeners, 0);
      expect(netListeners, `DOM listener retention across ${ENTITY_CYCLES} cycles`).toBeLessThanOrEqual(
        ENTITY_RETENTION_BUDGET.netListenersTotal,
      );

      // Every Entity the mount ever owned, and every viewer it was mounted on,
      // must stop accumulating. Forced collection uses the same CDP mechanism as
      // the matrix case above.
      const client = await page.context().newCDPSession(page);
      let live;
      try {
        await client.send("HeapProfiler.enable");
        live = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.liveEntityRetained());
        for (let attempt = 0; attempt < 8 && (live.viewers > 1 || live.entities > 1 || live.canvases > 1); attempt++) {
          await client.send("HeapProfiler.collectGarbage");
          await page.waitForTimeout(100);
          live = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.liveEntityRetained());
        }
      } finally {
        await client.detach();
      }
      const detail = JSON.stringify(live);
      expect(live.total).toBe(ENTITY_CYCLES);
      // At most one cycle's worth of entities may still be reachable, and only
      // because one whole cycle graph is pinned; a mount that failed to release
      // its entities accumulates them cycle after cycle instead.
      expect(live.entities, `mounted entities accumulated across cycles: ${detail}`).toBeLessThanOrEqual(
        ENTITY_EXPECTATIONS.b.length,
      );
      expect(live.viewers, `destroyed viewers accumulated across cycles: ${detail}`).toBeLessThanOrEqual(
        ENTITY_RETENTION_BUDGET.retainedViewers,
      );
      expect(live.canvases, `WebGL canvases accumulated across cycles: ${detail}`).toBeLessThanOrEqual(
        ENTITY_RETENTION_BUDGET.retainedCanvases,
      );

      expect(run.console, "in-page console.error output").toEqual([]);
      expect(run.errors, "in-page errors and unhandled rejections").toEqual([]);
      expect(consoleErrors, "browser console errors").toEqual([]);
      expect(pageErrors, "page errors").toEqual([]);
      expect(offOriginRequests, "the fixture must not reach the public internet").toEqual([]);
      expect(server.requestLog.some((entry) => entry.startsWith("/fixtures/entity-source/"))).toBe(true);
    } finally {
      await server.close();
    }
  });

  /**
   * Two mounts, one viewer, then one owner over both (#1050 REQ-003 / NFR-002).
   *
   * The entity mount and the scene primitive mount are separate lifecycle
   * owners, and the first half of this case is the evidence that one application
   * can hold both by hand: they mount onto the same live `Viewer`, each disposal
   * releases exactly its own resources, and the survivor's Cesium objects are
   * still the same objects by identity. The refused over-ceiling mount in the
   * middle proves the fail-closed path leaves a healthy neighbour untouched too.
   *
   * The second half is the reconciliation #1050 asks for: the same two halves are
   * mounted again through `mountCesiumScene`, handed the live `Viewer` itself,
   * and a single idempotent `dispose()` releases both.
   */
  test("composes an entity mount with a scene-primitive mount and fails closed on the entity ceiling", async ({
    page,
  }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
      const run = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.runEntityCoexistence());
      const { coexistence } = run;

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(`${JSON.stringify(coexistence, null, 2)}\n`);
      }

      expect(coexistence.cesiumVersion).toMatch(/^\d+\.\d+/);

      // --- both mounts live on one viewer -----------------------------------
      expect(coexistence.both.entityCount).toBe(ENTITY_EXPECTATIONS.a.length);
      expect(coexistence.both.imageryLayerCount).toBe(1);
      expect(coexistence.both.tilesetPresent).toBe(true);
      expect(coexistence.both.tilesetContentReady).toBeGreaterThan(0);
      expect(coexistence.both.entityPicked, "an entity renders alongside the primitive plan").toBe(true);
      expect(coexistence.both.primitiveMountState).toBe("ready");
      expect(coexistence.both.entityMountState).toBe("degraded");

      // --- NFR-002: the ceiling refuses before Cesium is touched -------------
      expect(coexistence.ceilingError, "an over-ceiling mount must reject").not.toBeNull();
      expect(coexistence.ceilingError.name).toBe("HonuaCesiumEntityAdapterError");
      expect(coexistence.ceilingError.code).toBe("entity-limit-exceeded");
      expect(coexistence.ceilingError.isAdapterError, "the error is the exported adapter error type").toBe(true);
      expect(coexistence.afterCeiling, "a refused mount changes nothing").toEqual({
        entityCount: ENTITY_EXPECTATIONS.a.length,
        tilesetPresent: true,
        imageryLayerCount: 1,
      });

      // --- REQ-003: each owner releases exactly its own ----------------------
      expect(coexistence.afterEntityDispose.entityCount).toBe(0);
      expect(coexistence.afterEntityDispose.entityMountState).toBe("disposed");
      expect(coexistence.afterEntityDispose.imageryLayerCount, "the primitive mount keeps its imagery").toBe(1);
      expect(
        coexistence.afterEntityDispose.imageryLayerPreserved,
        "the surviving imagery layer must be the same object",
      ).toBe(true);
      expect(coexistence.afterEntityDispose.tilesetPreserved, "the surviving tileset must not be rebuilt").toBe(true);
      expect(coexistence.afterEntityDispose.primitiveMountState).toBe("ready");

      expect(coexistence.afterPrimitiveDispose).toEqual({
        entityCount: 0,
        tilesetPresent: false,
        imageryLayerCount: 0,
        primitiveMountState: "disposed",
      });

      // --- REQ-003: one owner over both halves --------------------------------
      expect(coexistence.composed, "mountCesiumScene owns a live primitive plan and a live source").toMatchObject({
        ownerState: "ready",
        entityCount: ENTITY_EXPECTATIONS.a.length,
        imageryLayerCount: 1,
        tilesetPresent: true,
        sourceCount: 1,
        sourceOwnedByIdentity: true,
        primitiveMountState: "ready",
        entityMountState: "degraded",
      });
      expect(coexistence.composed.entityPicked, "the owned entity renders over the owned scene").toBe(true);
      // One dispose(), twice, releasing both halves and nothing else.
      expect(coexistence.afterComposedDispose).toEqual({
        ownerState: "disposed",
        entityCount: 0,
        imageryLayerCount: 0,
        tilesetPresent: false,
        sourceCount: 0,
        entityMountState: "disposed",
        primitiveMountState: "disposed",
      });

      // --- teardown, on #1026's measured ceilings -----------------------------
      expect(coexistence.teardown.viewerDestroyed).toBe(true);
      expect(coexistence.teardown.canvasesInContainer).toBe(RETENTION_BUDGET.canvasesInContainer);
      expect(coexistence.teardown.layerTeardownMs).toBeLessThan(TEARDOWN_BUDGET_MS.layerTeardown);
      expect(
        coexistence.teardown.composedTeardownMs,
        "one owner's teardown must fit the same layer ceiling as the two it replaces",
      ).toBeLessThan(TEARDOWN_BUDGET_MS.layerTeardown);
      expect(coexistence.teardown.viewerDestroyMs).toBeLessThan(TEARDOWN_BUDGET_MS.viewerDestroy);
      expect(coexistence.teardown.totalMs).toBeLessThan(TEARDOWN_BUDGET_MS.total);

      expect(run.console, "in-page console.error output").toEqual([]);
      expect(run.errors, "in-page errors and unhandled rejections").toEqual([]);
      expect(consoleErrors, "browser console errors").toEqual([]);
      expect(pageErrors, "page errors").toEqual([]);
      expect(offOriginRequests, "the fixture must not reach the public internet").toEqual([]);
    } finally {
      await server.close();
    }
  });
});
