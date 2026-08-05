/**
 * Real-Cesium browser fixture matrix and teardown budgets for the scene adapter
 * (honua-sdk-js#928), its temporal binding (#1048), and the accepted-plan
 * `Source` → entity path (#1050).
 *
 * The matrix spans every primitive kind the adapter materializes, every imagery
 * protocol it declares, the 3D-Tiles content variants the server can hand it (a
 * `.pnts` point cloud and the `honua_style` sidecar), and both non-`supported`
 * outcomes. It also proves its own DOM-listener budget by injecting a real
 * per-cycle leak and showing the budget rejects it (#1055).
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
  ARCGIS_MAP_SERVER_LAYER_ID,
  FIXTURE_ORIGIN,
  HONUA_STYLE_COLOR,
  HONUA_STYLE_SIDECAR_URI,
  POINT_CLOUD_POINT_COUNT,
  buildArcGisMapServerMetadata,
  buildHonuaStyleSidecar,
  buildPointCloudPnts,
  buildPointCloudTilesetJson,
  buildQuantizedMeshTile,
  buildSolidPng,
  buildStyledTilesetJson,
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
 * The final-canvas GC floor (honua-sdk-js#928).
 *
 * Chromium keeps the most recently used WebGL canvas — and the drawing buffer
 * behind it — reachable independently of the page's own references. Nothing the
 * page does displaces it: dropping every reference does not, and creating a
 * throwaway context afterwards does not either, which was measured rather than
 * assumed. So "zero retained canvases" is not a property this lane can honestly
 * assert, and asserting it anyway would only teach the next reader to relax the
 * budget the first time it flakes.
 *
 * What *is* honest, and what is asserted below, is that this is a floor and not
 * a slope:
 *
 *  - at most `FINAL_CANVAS_GC_FLOOR` canvases survive forced collection, however
 *    many cycles ran;
 *  - the survivor is always the *final* cycle's — nothing outlives a non-final
 *    cycle;
 *  - the same bound holds for live WebGL contexts.
 *
 * A real retention bug is a slope: it pins one canvas per cycle, so it reports
 * `CYCLES` where the floor reports at most one. `CYCLES` is kept above
 * `FINAL_CANVAS_GC_FLOOR + 1` so the two can never be confused, and the spec
 * asserts that relationship rather than trusting it.
 */
const FINAL_CANVAS_GC_FLOOR = 1;

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
 *  - The final cycle's WebGL canvas: pinned by Chromium, not by the page — see
 *    {@link FINAL_CANVAS_GC_FLOOR}.
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
  retainedCanvases: FINAL_CANVAS_GC_FLOOR,
  liveWebglContexts: FINAL_CANVAS_GC_FLOOR,
  /**
   * Net `addEventListener` minus `removeEventListener` calls per cycle, asserted
   * as an average over the run. Measured at 8 per cycle; the ceiling leaves room
   * for a Cesium upgrade that binds a couple more without hiding an accumulating
   * leak, which grows the run total.
   */
  netListenersPerCycle: 16,
};

/**
 * The DOM-listener budget, as a predicate rather than an inline expectation.
 *
 * Both directions of honua-sdk-js#1055 go through this one function: the matrix
 * case asserts it holds on a clean run (REQ-001's reformulation — a run total,
 * never a per-cycle equality), and the leak-injection case asserts the *same*
 * rule rejects a genuine per-cycle leak (REQ-002). Two hand-written copies of
 * the arithmetic could drift apart and quietly stop being the same claim.
 */
function netListenerRunTotalWithinBudget(netListenersPerCycle, cycles) {
  const total = netListenersPerCycle.reduce((sum, value) => sum + value, 0);
  return total <= RETENTION_BUDGET.netListenersPerCycle * cycles;
}

/**
 * Cycles for the leak-injection negative test (#1055 REQ-002).
 *
 * Two clean cycles and two leaking ones: enough for a per-cycle leak to
 * accumulate into the run total the budget bounds, and cheap enough that the
 * lane's proof of its own budget costs about one extra matrix run.
 */
const LEAK_PROBE_CYCLES = 2;

/**
 * Listeners the fixture leaks per cycle when the injection is switched on.
 *
 * Twice the per-cycle ceiling, so the injected leak is unambiguous: it breaks
 * the run total on its own, without depending on where CesiumJS's own ~8
 * listeners per cycle happen to land.
 */
const INJECTED_LISTENER_LEAK_PER_CYCLE = RETENTION_BUDGET.netListenersPerCycle * 2;

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

/**
 * The decoded query of the first request the fixture server saw for `pathname`.
 *
 * The imagery-protocol case asserts against what actually went over the wire:
 * the request a provider issues is the only place the adapter's per-protocol URL
 * and parameter shaping is observable — the `ImageryLayer` it produced does not
 * carry it. Returns `undefined` when no such request was made, which is itself a
 * failure the case reports.
 */
function queryFor(requestUrls, pathname) {
  const match = requestUrls.find((entry) => entry.startsWith(`${pathname}?`));
  return match ? Object.fromEntries(new URLSearchParams(match.slice(match.indexOf("?") + 1))) : undefined;
}

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
  const styledTilesetJson = Buffer.from(JSON.stringify(buildStyledTilesetJson()), "utf8");
  const styleSidecar = Buffer.from(JSON.stringify(buildHonuaStyleSidecar()), "utf8");
  const pointCloudTilesetJson = Buffer.from(JSON.stringify(buildPointCloudTilesetJson()), "utf8");
  const pointCloudTile = buildPointCloudPnts();
  const terrainLayerJson = Buffer.from(JSON.stringify(buildTerrainLayerJson()), "utf8");
  const terrainTile = buildQuantizedMeshTile();
  const imageryTile = buildSolidPng();
  const arcGisMapServerMetadata = Buffer.from(JSON.stringify(buildArcGisMapServerMetadata()), "utf8");
  const requestLog = [];
  // Full request URLs, query string included. The imagery-protocol case asserts
  // against these: what the adapter shaped for each protocol is only observable
  // on the wire, not from the layer object it produced.
  const requestUrls = [];
  // Which feature snapshot the entity fixture layer answers with. `refresh()`
  // re-executes the accepted plan unchanged, so the source has to be the thing
  // that changes; the page selects the snapshot explicitly rather than relying
  // on request ordering.
  let entitySnapshot = "a";

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    requestLog.push(requestPath);
    requestUrls.push(`${requestPath}${requestUrl.search}`);

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

    if (
      requestPath === "/fixtures/model.glb" ||
      requestPath === "/fixtures/tileset/content.glb" ||
      requestPath === "/fixtures/styled-tileset/content.glb"
    ) {
      send(glb, "model/gltf-binary");
      return;
    }
    if (requestPath === "/fixtures/tileset/tileset.json") {
      send(tilesetJson, "application/json; charset=utf-8");
      return;
    }
    if (requestPath === "/fixtures/styled-tileset/tileset.json") {
      send(styledTilesetJson, "application/json; charset=utf-8");
      return;
    }
    if (requestPath === `/fixtures/styled-tileset/${HONUA_STYLE_SIDECAR_URI}`) {
      send(styleSidecar, "application/json; charset=utf-8");
      return;
    }
    if (requestPath === "/fixtures/point-cloud/tileset.json") {
      send(pointCloudTilesetJson, "application/json; charset=utf-8");
      return;
    }
    if (requestPath === "/fixtures/point-cloud/points.pnts") {
      send(pointCloudTile, "application/octet-stream");
      return;
    }

    // --- imagery protocol endpoints ----------------------------------------
    // Each answers the request shape its Cesium provider actually issues; the
    // spec asserts the shaping separately, off `requestUrls`.
    if (requestPath === "/fixtures/wms" || requestPath === "/fixtures/wmts") {
      send(imageryTile, "image/png");
      return;
    }
    if (requestPath === "/fixtures/single-tile.png") {
      send(imageryTile, "image/png");
      return;
    }
    if (requestPath === "/fixtures/arcgis/MapServer" || requestPath === "/fixtures/arcgis/MapServer/") {
      send(arcGisMapServerMetadata, "application/json; charset=utf-8");
      return;
    }
    if (requestPath === "/fixtures/arcgis/MapServer/export" || requestPath === "/fixtures/arcgis/ImageServer/exportImage") {
      send(imageryTile, "image/png");
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
        requestUrls,
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
        netListenerRunTotalWithinBudget(netListeners, CYCLES),
        `DOM listener retention across ${CYCLES} cycles: ${netListeners.join(", ")}`,
      ).toBe(true);
      // Nothing injected a leak here; the case below turns the same rule against
      // one that was.
      expect(run.cycles.every((cycle) => cycle.resources.injectedListeners === 0)).toBe(true);

      // Every destroyed viewer must become unreachable, and with it the GPU
      // resources it owned. Forced collection uses the same CDP mechanism as
      // `web-components-memory-leak.spec.mjs`.
      //
      // The honest limit is the final-canvas GC floor documented on
      // {@link FINAL_CANVAS_GC_FLOOR}: every viewer object graph is collectible,
      // at most one canvas survives, and the survivor is always the final
      // cycle's. The run has to be long enough for that floor to be
      // distinguishable from per-cycle growth, which is asserted rather than
      // assumed — a leak pins one canvas per cycle and would report CYCLES.
      expect(
        CYCLES,
        "the run must be long enough to tell the final-canvas GC floor apart from per-cycle growth",
      ).toBeGreaterThan(FINAL_CANVAS_GC_FLOOR + 1);

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
        FINAL_CANVAS_GC_FLOOR,
      );
      expect(
        live.liveCanvasCycles.filter((index) => index !== CYCLES - 1),
        `a WebGL canvas outlived a non-final cycle: ${detail}`,
      ).toEqual([]);
      // Non-growth, stated as such: the floor does not scale with cycle count.
      // Per-cycle retention would report one canvas per cycle here.
      expect(live.canvases, `the final-canvas GC floor grew with the cycle count: ${detail}`).toBeLessThan(CYCLES);

      const finalProbe = await page.evaluate(() => globalThis.__honuaSceneProbe.snapshot());
      expect(finalProbe.liveWebglContexts, `WebGL contexts outlived their viewers: ${detail}`).toBeLessThanOrEqual(
        FINAL_CANVAS_GC_FLOOR,
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
   * Every declared Cesium imagery protocol, against real providers (#928 S2).
   *
   * The S1 matrix proved `url-template` and stopped there, so four of the five
   * protocols the adapter advertises — and both halves of the `arcgis-imagery`
   * endpoint fork — had never reached a live Cesium provider. This case mounts
   * all of them at once and asserts three things no jsdom seam can settle:
   *
   *  1. Each protocol became *the* provider the adapter is supposed to route it
   *     to, resolved by `instanceof` against the real runtime's constructors.
   *  2. What the adapter shaped for each protocol reached the wire: the WMS
   *     GetMap query, the WMTS GetTile query, the ArcGIS service-description
   *     fetch and its dynamic export, and the ImageServer `exportImage`
   *     template are all read back off the fixture server's request log.
   *  3. A protocol the adapter does not declare fails closed with a stable
   *     diagnostic and never reaches a Cesium factory — it is never skipped.
   */
  test("materializes every declared imagery protocol against its real Cesium provider", async ({ page }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
      const run = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.runImageryProtocols());
      const matrix = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.imageryProtocolMatrix);
      const { imagery } = run;

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(`${JSON.stringify(imagery, null, 2)}\n`);
      }

      expect(imagery.evidence.cesiumVersion, "the real cesium package must be loaded").toMatch(/^\d+\.\d+/);
      expect(imagery.status, "the plan deliberately carries one fail-closed binding").toBe("unsupported");

      // --- the matrix covers every protocol the adapter declares -------------
      // Asserted against the adapter's own capability list rather than a copy of
      // it, so a protocol added to the surface without evidence fails this lane
      // instead of quietly staying uncovered.
      const coveredProtocols = matrix
        .filter((entry) => entry.materializes)
        .map((entry) => imagery.rendered[entry.id].protocol);
      expect([...new Set(coveredProtocols)].sort()).toEqual([...imagery.evidence.declaredProtocols].sort());

      // --- per-row outcome and diagnostics ----------------------------------
      for (const entry of matrix) {
        const observed = imagery.rendered[entry.id];
        expect(observed, `imagery row ${entry.id} must be reported`).toBeTruthy();
        expect(observed.hasHandle, `${entry.id} handle presence`).toBe(entry.materializes);
        if (entry.materializes) {
          expect(observed.handleKind, `${entry.id} handle kind`).toBe("imagery-layer");
          expect(observed.handleProtocol, `${entry.id} handle protocol`).toBe(observed.protocol);
        }
        for (const code of entry.expectedDiagnostics) {
          expect(observed.codes, `${entry.id} diagnostics`).toContain(code);
        }
        expect(observed.statuses, `${entry.id} status`).toContain(entry.expect);
      }

      // --- each protocol landed on exactly one Cesium provider ---------------
      const materialized = matrix.filter((entry) => entry.materializes);
      expect(imagery.evidence.imageryLayerCount, "one live layer per materialized row").toBe(materialized.length);
      materialized.forEach((entry, at) => {
        const layer = imagery.evidence.layers[at];
        expect(layer.providers, `${entry.id} provider identity`).toEqual([entry.provider]);
        // Every row declares a distinct opacity, so this checks two things at
        // once: the adapter applied it, and layer `at` really is row `at`.
        expect(layer.alpha, `${entry.id} opacity reached ImageryLayer.alpha`).toBeCloseTo(entry.opacity, 3);
      });
      expect(imagery.evidence.litPixels, "the globe carrying the imagery must rasterize").toBeGreaterThan(0);

      // --- the fail-closed row never reached a Cesium factory ----------------
      const refused = imagery.rendered["protocol-unsupported"];
      expect(refused.codes).toContain("scene-primitive-unsupported");
      expect(refused.statuses).toContain("unsupported");
      expect(refused.hasHandle).toBe(false);
      // The refused row binds a URL prefix no other row shares, so this is a
      // claim the request log can settle rather than a hopeful one.
      expect(
        server.requestLog.filter((entry) => entry.startsWith("/fixtures/tms/")),
        "the refused protocol must issue no request of its own",
      ).toEqual([]);

      // --- the shaping reached the wire --------------------------------------
      const wms = queryFor(server.requestUrls, "/fixtures/wms");
      expect(wms, "the WMS provider must have issued a GetMap").toBeTruthy();
      expect(wms.service).toBe("WMS");
      expect(wms.request).toBe("GetMap");
      expect(wms.layers, "the primitive's layer travels as WMS layers").toBe("honua:fixture");
      expect(wms.version, "a parameter override reaches the request").toBe("1.3.0");
      expect(wms.crs, "WMS 1.3.0 is a crs request, not an srs request").toBe("CRS:84");
      expect(wms.format).toBe("image/png");
      expect(wms.styles).toBe("default");
      expect(wms.transparent).toBe("true");

      const wmts = queryFor(server.requestUrls, "/fixtures/wmts");
      expect(wmts, "the WMTS provider must have issued a GetTile").toBeTruthy();
      expect(wmts.service).toBe("WMTS");
      expect(wmts.request).toBe("GetTile");
      expect(wmts.layer).toBe("honua-fixture");
      expect(wmts.style).toBe("default");
      expect(wmts.tilematrixset).toBe("honua-fixture-matrix");
      expect(wmts.format).toBe("image/png");

      const arcGisMetadata = queryFor(server.requestUrls, "/fixtures/arcgis/MapServer/");
      expect(arcGisMetadata, "Cesium fetches the MapServer service description first").toBeTruthy();
      expect(arcGisMetadata.f).toBe("json");
      const arcGisExport = queryFor(server.requestUrls, "/fixtures/arcgis/MapServer/export");
      expect(arcGisExport, "the MapServer row must request a dynamic export").toBeTruthy();
      expect(arcGisExport.f).toBe("image");
      expect(arcGisExport.layers, "the adapter's layers parameter reaches the export").toBe(
        `show:${ARCGIS_MAP_SERVER_LAYER_ID}`,
      );
      expect(arcGisExport.bboxSR, "a geographic tiling scheme exports in EPSG:4326").toBe("4326");

      const imageServer = queryFor(server.requestUrls, "/fixtures/arcgis/ImageServer/exportImage");
      expect(imageServer, "the ImageServer row must request an exportImage").toBeTruthy();
      expect(imageServer.f).toBe("image");
      expect(imageServer.format).toBe("png32");
      expect(imageServer.transparent).toBe("true");
      expect(imageServer.bboxSR, "the adapter's export template is Web Mercator").toBe("3857");
      expect(imageServer.imageSR).toBe("3857");
      expect(imageServer.bbox.split(",")).toHaveLength(4);

      expect(server.requestLog, "the single-tile row must fetch its one image").toContain(
        "/fixtures/single-tile.png",
      );

      // --- teardown, on #1026's measured ceilings -----------------------------
      const teardown = imagery.teardown;
      expect(teardown.afterLayerRemoval.imageryLayerCount).toBe(RETENTION_BUDGET.imageryLayersAfterLayerRemoval);
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
   * 3D-Tiles content variants: a point cloud and the server styling sidecar
   * (#928 S2).
   *
   * Both ride the ordinary `model-layer` / `3d-tiles` path, so what makes them
   * distinct is what the *server* put in the tileset — and neither had any
   * real-Cesium evidence before this case:
   *
   *  1. A `.pnts` point cloud loads through Cesium's point-cloud content
   *     pipeline, the primitive's `pointCloudShading` becomes a real
   *     `PointCloudShading` on the live tileset, and points actually reach the
   *     GPU (they are selected for rendering and picked out of a pick pass).
   *  2. A tileset advertising `extras.honua_style` has its `style.json` sidecar
   *     discovered, fetched, and applied without the caller asking — and the
   *     applied object is a real `Cesium3DTileStyle` whose colour expression
   *     Cesium can execute.
   *  3. A tileset that advertises nothing fetches nothing and stays unstyled.
   *     That silent no-op is half the contract and would otherwise be invisible.
   */
  test("mounts a point-cloud tileset and applies the server styling sidecar", async ({ page }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
      const run = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.runTilesetVariants());
      const expectedShading = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.pointCloudShading);
      const matrix = await page.evaluate(() => globalThis.__honuaCesiumSceneFixture.tilesetVariantMatrix);
      const { variants } = run;

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(`${JSON.stringify(variants, null, 2)}\n`);
      }

      expect(variants.evidence.cesiumVersion, "the real cesium package must be loaded").toMatch(/^\d+\.\d+/);
      expect(variants.status, "every variant in this plan is renderable").toBe("supported");
      expect(variants.evidence.readyWithinBudget, "every variant must reach loaded content in time").toBe(true);
      expect(variants.evidence.tilesetCount).toBe(matrix.length);
      expect(variants.evidence.scenePrimitiveCount).toBe(matrix.length);
      for (const entry of matrix) {
        expect(variants.rendered[entry.id].hasHandle, `${entry.id} handle presence`).toBe(entry.materializes);
        expect(variants.rendered[entry.id].handleFormat, `${entry.id} handle format`).toBe("3d-tiles");
      }

      // --- the point cloud ----------------------------------------------------
      const pointCloud = variants.evidence.pointCloud;
      expect(pointCloud.tilesLoaded, "the point-cloud tileset must finish loading").toBe(true);
      expect(pointCloud.contentReady, "its .pnts content must reach the GPU").toBeGreaterThan(0);
      expect(
        pointCloud.shadingIsCesiumPointCloudShading,
        "the primitive's shading must become a real Cesium PointCloudShading",
      ).toBe(true);
      expect(pointCloud.shading, "every validated shading field must survive the projection").toEqual(expectedShading);
      // Selected for rendering, not merely parsed: Cesium counts the points it
      // draws, and every point in the fixture grid is in the nadir frustum.
      expect(pointCloud.pointsSelected, "the point cloud must actually be drawn").toBe(POINT_CLOUD_POINT_COUNT);
      expect(pointCloud.pickedThisTileset, "the point cloud must be pickable out of a real pick pass").toBe(true);
      expect(variants.evidence.litPixels, "the scene must rasterize").toBeGreaterThan(0);

      // --- the styling sidecar ------------------------------------------------
      const style = variants.evidence.style;
      expect(
        server.requestLog,
        "the adapter must discover and fetch the advertised sidecar without being asked",
      ).toContain(`/fixtures/styled-tileset/${HONUA_STYLE_SIDECAR_URI}`);
      expect(style.advertisedDescriptor, "the descriptor survives onto the loaded tileset").toEqual({
        encoding: "3d-tiles-styling",
        version: "1.0",
        uri: HONUA_STYLE_SIDECAR_URI,
      });
      expect(style.styleIsCesium3DTileStyle, "the applied style must be a real Cesium3DTileStyle").toBe(true);
      expect(style.style, "both sidecar blocks reach Cesium verbatim").toEqual({
        color: { conditions: [["true", `color('${HONUA_STYLE_COLOR}')`]] },
        show: { conditions: [["true", "true"]] },
      });
      // Executed by Cesium's own expression engine, not merely assigned. #ff8800.
      expect(style.colorEvaluates).toEqual({ red: 1, green: 0.533, blue: 0, alpha: 1 });

      // --- and a tileset that advertises nothing fetches nothing ---------------
      expect(style.unstyledAdvertisesNothing).toBe(true);
      expect(style.unstyledHasNoStyle, "an unadvertised tileset must be added unstyled").toBe(true);
      expect(
        server.requestUrls.some((entry) => entry.startsWith(`/fixtures/tileset/${HONUA_STYLE_SIDECAR_URI}`)),
        "a tileset without honua_style must trigger no sidecar fetch at all",
      ).toBe(false);

      // --- teardown, on #1026's measured ceilings ------------------------------
      const teardown = variants.teardown;
      expect(teardown.afterLayerRemoval.scenePrimitiveCount).toBe(RETENTION_BUDGET.scenePrimitivesAfterLayerRemoval);
      expect(teardown.afterLayerRemoval.tilesetCount).toBe(0);
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
   * The listener budget's own negative test (honua-sdk-js#1055 REQ-002).
   *
   * REQ-001 reformulated the DOM-listener assertion from a per-cycle equality
   * (which flaked, because asynchronous teardown moves a listener across a cycle
   * boundary without leaking it) to a run total. A weaker assertion is only an
   * improvement if it still fails on the thing it exists to catch, and that is
   * not self-evident — so it is proven here rather than argued.
   *
   * The same predicate the matrix case asserts, `netListenerRunTotalWithinBudget`,
   * is run twice over the same lane: once on a clean run, where it must hold,
   * and once with a genuine per-cycle listener leak injected into the fixture,
   * where it must fail. The injection is a fixture flag that defaults to off and
   * is switched on only here, so nothing in the committed lane leaks by default.
   */
  test("the run-total listener budget still fails on a genuine per-cycle leak", async ({ page }) => {
    const { server, consoleErrors, pageErrors, offOriginRequests } = await openFixturePage(page);

    try {
      // --- control: the same lane, the same predicate, nothing injected -------
      const clean = await page.evaluate(
        (cycles) => globalThis.__honuaCesiumSceneFixture.runCycles({ cycles }),
        LEAK_PROBE_CYCLES,
      );
      const cleanNetListeners = clean.cycles.map((cycle) => cycle.resources.netListeners);
      expect(clean.cycles.every((cycle) => cycle.resources.injectedListeners === 0)).toBe(true);
      expect(
        netListenerRunTotalWithinBudget(cleanNetListeners, LEAK_PROBE_CYCLES),
        `the control run must satisfy the budget: ${cleanNetListeners.join(", ")}`,
      ).toBe(true);

      // --- the same lane with a listener leaked on every cycle ----------------
      const leaking = await page.evaluate(
        ({ cycles, leak }) => globalThis.__honuaCesiumSceneFixture.runCycles({ cycles, listenerLeakPerCycle: leak }),
        { cycles: LEAK_PROBE_CYCLES, leak: INJECTED_LISTENER_LEAK_PER_CYCLE },
      );
      const leakingNetListeners = leaking.cycles.map((cycle) => cycle.resources.netListeners);

      if (process.env.HONUA_CESIUM_FIXTURE_REPORT === "1") {
        process.stdout.write(
          `${JSON.stringify({ clean: cleanNetListeners, leaking: leakingNetListeners }, null, 2)}\n`,
        );
      }

      // the injection actually happened, on every cycle
      expect(leaking.cycles.map((cycle) => cycle.resources.injectedListeners)).toEqual(
        Array.from({ length: LEAK_PROBE_CYCLES }, () => INJECTED_LISTENER_LEAK_PER_CYCLE),
      );
      // and it is a *per-cycle* leak: every cycle carries it, so the run total
      // grows with the cycle count exactly as a real retention bug would
      for (const [index, value] of leakingNetListeners.entries()) {
        expect(value, `cycle ${index} must carry the injected leak`).toBeGreaterThanOrEqual(
          INJECTED_LISTENER_LEAK_PER_CYCLE,
        );
      }
      expect(
        leakingNetListeners.reduce((total, value) => total + value, 0),
        "the leak accumulates across the run",
      ).toBeGreaterThan(cleanNetListeners.reduce((total, value) => total + value, 0));

      // the load-bearing assertion: the reformulated budget rejects it
      expect(
        netListenerRunTotalWithinBudget(leakingNetListeners, LEAK_PROBE_CYCLES),
        `the run-total budget failed to catch an injected per-cycle leak: ${leakingNetListeners.join(", ")}`,
      ).toBe(false);

      // The leak is a listener leak and nothing else: the lane stays clean, and
      // the leaking run mounts and tears down exactly like the control run.
      for (const cycle of [...clean.cycles, ...leaking.cycles]) {
        expect(cycle.teardown.viewerDestroyed).toBe(true);
        expect(cycle.teardown.canvasesInContainer).toBe(RETENTION_BUDGET.canvasesInContainer);
        expect(cycle.teardown.pendingAnimationFrames).toBe(RETENTION_BUDGET.pendingAnimationFrames);
      }

      expect(clean.console, "in-page console.error output").toEqual([]);
      expect(leaking.console, "in-page console.error output").toEqual([]);
      expect(consoleErrors, "browser console errors").toEqual([]);
      expect(pageErrors, "page errors").toEqual([]);
      expect(offOriginRequests, "the fixture must not reach the public internet").toEqual([]);
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
