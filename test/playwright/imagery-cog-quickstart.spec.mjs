import { expect, test } from "@playwright/test";

import { startImageryCogFixtureServer } from "../../examples/imagery-cog-quickstart/mock-server.mjs";
import { SAMPLE_PERFORMANCE_BUDGET_MS } from "../../scripts/lib/sample-gates.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const SAMPLE_ID = "imagery-cog-quickstart";
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];
const WORKFLOW_SELECTORS = [
  "#stac-search-form",
  "#map",
  "#asset-inspection",
  "#direct-cog-render",
  "#elevation-profile",
];
// The WFS ProtocolModule is part of the synchronous HonuaClient surface used
// by this sample's /honua entrypoint. Reset the ceiling to the verified
// post-WFS measurement plus the repository's standard 10% headroom.
const BUNDLE_BYTES_BUDGET = 2_899_353;
const HEAP_BYTES_BUDGET = 192 * 1024 * 1024;

test.setTimeout(90_000);

test(
  "imagery and terrain journey completes supported and degraded MapLibre workflows",
  async ({ browser, browserName }, testInfo) => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const externalRequests = [];
    const failedRequests = [];
    const errorResponses = [];
    const wmsGetMapRequests = [];
    const bundleMapFixtureRequests = [];
    const cogChunkRequests = [];
    const completeCogObjectRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      failedRequests.push({ href: request.url(), error: request.failure()?.errorText ?? "unknown" });
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("/fixtures/cog/chunks/")) cogChunkRequests.push(url.pathname);
      if (url.pathname.endsWith("/fixtures/cog/assets/oahu-natural-color-v1.tif")) {
        completeCogObjectRequests.push({ href: url.href, range: request.headers().range ?? null });
      }
      if (url.pathname.includes("/fixtures/cog/tiles/")) bundleMapFixtureRequests.push(url.pathname);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) errorResponses.push({ href: response.url(), status: response.status() });
    });

    const fixtureServer = await startImageryCogFixtureServer();
    const fixtureOrigin = new URL(fixtureServer.url).origin;
    await context.route(/^https?:\/\//u, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== fixtureOrigin) {
        externalRequests.push(url.href);
        await route.abort("blockedbyclient");
        return;
      }
      if (
        url.pathname === "/rest/services/OahuImagery/MapServer/WMS" &&
        url.searchParams.get("REQUEST")?.toLowerCase() === "getmap"
      ) {
        wmsGetMapRequests.push(url.href);
      }
      await route.continue();
    });

    try {
      await page.goto(fixtureServer.url);
      await expect
        .poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.ready === true))
        .toBe(true);
      const sampleReadyDurationMs = await page.evaluate(() => performance.now());
      expect(sampleReadyDurationMs).toBeLessThanOrEqual(SAMPLE_PERFORMANCE_BUDGET_MS);

      const runtimeIdentity = await page.evaluate(() => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        return {
          ready: runtime?.ready,
          disposed: runtime?.disposed,
          selectedAssetKey: runtime?.selectedAssetKey,
          inspectionStatus: runtime?.inspectionStatus,
          activeLayerCount: runtime?.activeLayerCount,
          tileTemplates: runtime?.tileTemplates,
          resources: runtime?.resources,
          directCog: runtime?.directCog,
        };
      });
      expect(runtimeIdentity).toMatchObject({
        ready: true,
        disposed: false,
        selectedAssetKey: "cog",
        inspectionStatus: "ready",
        activeLayerCount: 3,
        resources: { activeRequests: 0, disposed: false },
        directCog: {
          phase: "ready",
          selectedAssetKey: "cog",
          candidateCount: 7,
          decoderModuleLoads: 1,
          decoderLoads: 1,
          decoderDisposals: 0,
          mapSourceMounted: true,
          mapLayerMounted: true,
          render: { state: "ready", mounted: true, lastRender: { transfer: { requests: 3 } } },
          transfer: { requests: 3, bytesFetched: 28672 },
        },
      });
      expect(
        runtimeIdentity.directCog.transfer.ranges.every(
          (range) => range.outcome === "success" && range.length <= 64 * 1024,
        ),
      ).toBe(true);
      expect(runtimeIdentity.tileTemplates.some((template) => template.includes("REQUEST=GetMap"))).toBe(true);
      expect(
        runtimeIdentity.tileTemplates.some((template) => template.includes("/OahuCog/ImageServer/tile/{z}/{y}/{x}")),
      ).toBe(true);
      expect(
        runtimeIdentity.tileTemplates.some((template) => template.includes("/OahuTerrain/ImageServer/tile/{z}/{y}/{x}")),
      ).toBe(true);
      expect(wmsGetMapRequests).toEqual([]);
      await expect
        .poll(() => [...new Set(bundleMapFixtureRequests)].sort())
        .toEqual(
          [
            "/fixtures/cog/tiles/image-server-natural-color.png",
            "/fixtures/cog/tiles/wms-natural-color.png",
          ].sort(),
        );

      await expect(page.getByRole("heading", { level: 1, name: "Imagery and Terrain" })).toBeVisible();
      await expect(page.getByTestId("honua-sample-mode")).toHaveText(/^(source|packed) SDK$/u);
      await expect(page.locator("#search-status")).toContainText("HonuaClient.stac().search");
      await expect(page.locator("#scene-results")).toContainText("Oahu south shore clear pass");
      await expect(page.locator("#inspection-content")).toHaveAttribute("data-status", "ready");
      await expect(page.locator("#inspection-content")).toContainText("bytes 0-63/");
      await expect(page.locator("#inspection-content")).toContainText('"oahu-range-fixture-v1"');
      await expect(page.locator("#inspection-content")).toContainText("CC-BY-4.0 fixture terms");
      await expect(page.locator("#attribution-state")).toContainText("Copernicus Sentinel");
      await expect(page.locator("#direct-cog-status")).toContainText("ready");
      await expect(page.locator("#direct-cog-inspection")).toContainText("256×192");
      await expect(page.locator("#direct-cog-provenance")).toContainText("oahu-natural-color-fixture-v1/cog");
      await expect(page.locator("#direct-cog-provenance")).toContainText(
        "image/tiff;application=geotiff;profile=cloud-optimized",
      );
      await expect(page.locator("#direct-cog-transfer-summary")).toContainText("28672 bytes across 3 exact range request");
      await expect(page.locator("#direct-cog-ranges li")).toHaveCount(3);
      await expect(page.locator(".cog-legend")).toContainText("Vegetation");
      await expect(page.locator("#direct-cog-pixel")).toHaveAttribute("data-ready", "true");
      await expect(page.locator("#direct-cog-pixel")).toContainText("Bounded pixel inspection: RGB");
      expect(new Set(cogChunkRequests).size).toBe(2);
      expect(completeCogObjectRequests).toEqual([]);
      await expect(page.locator("#fidelity-list")).toContainText("classified STAC COG is decoded through bounded reads");
      await expect(page.locator("#fidelity-list")).toContainText("exact MapLibre bbox token");
      await expect(page.locator("#fidelity-list")).toContainText("Cesium production is intentionally excluded");
      await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);

      const unsupportedCases = [
        ["credential-cog", "credentials", "credentials"],
        ["cors-cog", "cors", "cors-unavailable"],
        ["no-range-cog", "range", "range-unsupported"],
        ["oversized-cog", "range", "range"],
        ["chunked-oversized-cog", "range", "range"],
        ["unsupported-crs", "crs", "unsupported-crs"],
        ["unsupported-format", "format", "unsupported-format"],
        ["missing-nodata", "nodata", "nodata"],
      ];
      for (const [assetKey, code, directCode] of unsupportedCases) {
        const outcome = await page.evaluate((key) => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.selectAsset(key), assetKey);
        expect(outcome).toMatchObject({
          status: "unsupported",
          code,
          identity: { assetKey, itemId: "S2A_20260412T211901_OAHU_RANGE_01" },
        });
        await expect(page.locator("#inspection-content")).toHaveAttribute("data-status", "unsupported");
        await expect(page.locator("#inspection-content")).toContainText(code);
        await expect(page.locator("#inspection-content")).toContainText("S2A_20260412T211901_OAHU_RANGE_01");
        await expect(page.locator("#asset-switch-state")).toContainText("WMS remains available");
        expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.activeLayerCount)).toBe(1);
        await expect(page.locator("#direct-cog-status")).toContainText(directCode);
        await expect(page.locator("#direct-cog-error")).toContainText(directCode);
        expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.directCog)).toMatchObject({
          phase: "failed",
          selectedAssetKey: assetKey,
          errorCode: directCode,
          mapSourceMounted: false,
          mapLayerMounted: false,
        });
      }
      await expect(page.locator("body")).not.toContainText("fixture-super-secret");
      await expect(page.locator("body")).not.toContainText("fixture-password");

      const switchOutcomes = await page.evaluate(async () => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        if (!runtime) throw new Error("Imagery and Terrain runtime is unavailable");
        const obsolete = runtime.selectAsset("slow-cog");
        await new Promise((resolve) => setTimeout(resolve, 40));
        const latest = runtime.selectAsset("cog");
        return Promise.all([obsolete, latest]);
      });
      expect(switchOutcomes[0]).toMatchObject({ status: "cancelled", reason: "superseded" });
      expect(switchOutcomes[1]).toMatchObject({ status: "ready", identity: { assetKey: "cog" } });
      expect(
        await page.evaluate(() => ({
          cancellations: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.cancellationCount,
          releases: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources,
          activeLayerCount: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.activeLayerCount,
          retained: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources.retainedRasterResource,
          directCog: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.directCog,
        })),
      ).toMatchObject({
        cancellations: 1,
        activeLayerCount: 3,
        directCog: { phase: "ready", selectedAssetKey: "cog", mapSourceMounted: true, mapLayerMounted: true },
      });
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources)).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources.retainedRasterResource)).toContain(
        "/cog",
      );
      const switchedDirect = await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.directCog);
      expect(switchedDirect.abortedOperations).toBeGreaterThanOrEqual(1);
      expect(switchedDirect.decoderDisposals).toBeGreaterThanOrEqual(1);
      expect(switchedDirect.staleCompletions).toBeGreaterThanOrEqual(1);

      const directDisposalsBefore = switchedDirect.decoderDisposals;
      await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.disposeCog());
      await expect(page.locator("#direct-cog-status")).toContainText("disposed");
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.directCog)).toMatchObject({
        phase: "disposed",
        mapSourceMounted: false,
        mapLayerMounted: false,
      });
      expect(
        await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.directCog.decoderDisposals),
      ).toBeGreaterThan(directDisposalsBefore);
      await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.selectCogAsset("cog"));
      await expect(page.locator("#direct-cog-status")).toContainText("ready");

      const comparison = page.locator("#comparison-slider");
      await comparison.focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator("#comparison-value")).toHaveText("1% direct COG over published imagery");
      await comparison.fill("35");
      await expect(page.locator("#comparison-value")).toHaveText("35% direct COG over published imagery");

      const terrainToggle = page.locator("#terrain-toggle");
      await terrainToggle.focus();
      await page.keyboard.press("Space");
      await expect(terrainToggle).toBeChecked();
      await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.terrainEnabled)).toBe(true);
      await expect(page.locator("#fidelity-list")).toContainText("enabled at 1.25× exaggeration");
      await expect.poll(() => bundleMapFixtureRequests.some((path) => path.endsWith("/terrain-rgb.png"))).toBe(true);

      const invalidElevation = await page.evaluate(() =>
        window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.lookupAt(181, 91),
      );
      expect(invalidElevation).toBeUndefined();
      await expect(page.locator("#elevation-result")).toContainText("Elevation coordinate must be a finite WGS84");

      const elevationRace = await page.evaluate(async () => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        if (!runtime) throw new Error("Imagery and Terrain runtime is unavailable");
        const obsolete = runtime.lookupAt(-157.7777, 21.35);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const latest = runtime.lookupAt(-157.9, 21.35);
        return Promise.all([obsolete, latest]);
      });
      expect(elevationRace).toMatchObject([
        { status: "cancelled", coordinate: [-157.7777, 21.35] },
        { status: "ready", coordinate: [-157.9, 21.35], elevationMeters: 900 },
      ]);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.lastElevationMeters)).toBe(900);

      await page.locator("#longitude-input").fill("-157.9000");
      await page.locator("#latitude-input").fill("21.3500");
      await page.locator("#latitude-input").press("Enter");
      await expect(page.locator("#elevation-result")).toContainText("900.0 m");
      await expect(page.locator("#elevation-result")).toContainText("EGM96");
      const profileRace = await page.evaluate(async () => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        if (!runtime) throw new Error("Imagery and Terrain runtime is unavailable");
        const obsolete = runtime.runFixtureProfile();
        const latest = runtime.runFixtureProfile();
        return Promise.all([obsolete, latest]);
      });
      expect(profileRace[0]).toMatchObject({ status: "cancelled" });
      expect(profileRace[1]).toMatchObject({ status: "ready", profile: { samples: expect.any(Array) } });
      expect(profileRace[1]?.profile.samples).toHaveLength(4);
      await page.locator("#run-profile").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#profile-result")).toContainText("4 samples");
      await expect(page.locator("#profile-result svg")).toHaveAttribute("aria-label", /Route elevation profile/u);

      const resolutionEvidence = await page.evaluate(async () => {
        const response = await fetch("/honua-sample-sdk-resolution.json", { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`SDK resolution evidence failed with HTTP ${response.status}`);
        return response.json();
      });
      expect(resolutionEvidence).toMatchObject({
        format: "honua.sdk.sample-resolution.v1",
        schemaVersion: 1,
        package: { name: "@honua/sdk-js" },
      });
      expect(["source", "packed"]).toContain(resolutionEvidence.mode);
      await expect(page.getByTestId("honua-sample-mode")).toHaveText(`${resolutionEvidence.mode} SDK`);
      expect(resolutionEvidence.entrypoints.map(({ specifier }) => specifier).sort()).toEqual(
        [
          "@honua/sdk-js",
          "@honua/sdk-js/cog",
          "@honua/sdk-js/contract",
          "@honua/sdk-js/honua",
          "@honua/sdk-js/runtime",
        ].sort(),
      );
      const bundleBytes = resolutionEvidence.bundle.reduce((total, entry) => total + entry.bytes, 0);
      expect(bundleBytes).toBeGreaterThan(0);
      expect(bundleBytes).toBeLessThanOrEqual(BUNDLE_BYTES_BUDGET);

      const performanceEvidence = await page.evaluate(() => {
        const memory = performance.memory;
        return {
          resourceCount: performance.getEntriesByType("resource").length,
          usedJSHeapSize: memory?.usedJSHeapSize,
        };
      });
      expect(performanceEvidence.resourceCount).toBeGreaterThan(0);
      expect(performanceEvidence.usedJSHeapSize).toBeGreaterThan(0);
      expect(performanceEvidence.usedJSHeapSize).toBeLessThanOrEqual(HEAP_BYTES_BUDGET);

      await page.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
      });
      await attestBrowserQuality({
        page,
        testInfo,
        sampleId: SAMPLE_ID,
        browserName,
        sampleReadyDurationMs,
        runtimeReady: true,
        responsiveViewports: VIEWPORTS,
        workflowSelectors: WORKFLOW_SELECTORS,
      });

      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(page.locator(".workflow-panel")).toHaveScreenshot("imagery-terrain-workflow.png", {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.015,
      });
      await expect(page.locator(".map-stage")).toHaveScreenshot("imagery-cog-render.png", {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.015,
      });
      await expect(page.locator("#direct-cog-status").locator("xpath=ancestor::section[1]")).toHaveScreenshot(
        "imagery-cog-evidence.png",
        {
          animations: "disabled",
          caret: "hide",
          maxDiffPixelRatio: 0.015,
        },
      );

      const emptyStacSearch = (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            type: "FeatureCollection",
            features: [],
            numberMatched: 0,
            numberReturned: 0,
            links: [],
          }),
        });
      const stacSearchPattern = /\/stac\/search(?:\?|$)/u;
      const releasesBeforeEmptySearch = await page.evaluate(
        () => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources,
      );
      await page.route(stacSearchPattern, emptyStacSearch);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.search())).toBe(true);
      await expect(page.locator("#search-status")).toContainText("No scenes matched");
      await expect(page.locator("#inspection-content")).not.toHaveAttribute("data-status", "ready");
      expect(
        await page.evaluate(() => {
          const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
          return {
            selectedAssetKey: runtime?.selectedAssetKey ?? null,
            inspectionStatus: runtime?.inspectionStatus,
            retained: runtime?.resources.retainedRasterResource ?? null,
            directCog: runtime?.directCog,
          };
        }),
      ).toMatchObject({
        selectedAssetKey: null,
        inspectionStatus: "idle",
        retained: null,
        directCog: {
          phase: "disposed",
          candidateCount: 0,
          mapSourceMounted: false,
          mapLayerMounted: false,
        },
      });
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources)).toBe(
        releasesBeforeEmptySearch + 2,
      );
      await page.unroute(stacSearchPattern, emptyStacSearch);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.search())).toBe(true);
      await expect(page.locator("#inspection-content")).toHaveAttribute("data-status", "ready");

      const failStacSearch = (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"type":"FeatureCollection"' });
      await page.route(stacSearchPattern, failStacSearch);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.search())).toBe(false);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.ready)).toBe(false);
      await expect(page.locator("#search-status")).toContainText("STAC search failed");
      await page.unroute(stacSearchPattern, failStacSearch);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.search())).toBe(true);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.ready)).toBe(true);

      const interactionCountBeforeDispose = await page.evaluate(
        () => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.interactionCount,
      );
      const releaseCountBeforeDispose = await page.evaluate(
        () => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources,
      );
      const pageErrorsBeforeDispose = pageErrors.length;
      const consoleErrorsBeforeDispose = consoleErrors.length;
      const cancelledDuringDispose = await page.evaluate(async () => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        if (!runtime) throw new Error("Imagery and Terrain runtime is unavailable");
        const pendingElevation = runtime.lookupAt(-157.7777, 21.35);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await Promise.all([runtime.dispose(), runtime.dispose()]);
        return pendingElevation;
      });
      expect(cancelledDuringDispose).toMatchObject({ status: "cancelled", coordinate: [-157.7777, 21.35] });
      await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.disposed)).toBe(true);
      await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
      expect(
        await page.evaluate(() => ({
          ready: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.ready,
          resources: {
            ...window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources,
            activeSelectionId: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources.activeSelectionId ?? null,
            retainedRasterResource:
              window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources.retainedRasterResource ?? null,
          },
          releases: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources,
          directCog: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.directCog,
          presentationCount: document.querySelectorAll(".honua-sample-kit").length,
        })),
      ).toMatchObject({
        ready: false,
        resources: { activeRequests: 0, activeSelectionId: null, retainedRasterResource: null, disposed: true },
        releases: releaseCountBeforeDispose + 2,
        directCog: {
          phase: "disposed",
          mapSourceMounted: false,
          mapLayerMounted: false,
        },
        presentationCount: 0,
      });

      const requestCountAfterDispose = await page.evaluate(() => performance.getEntriesByType("resource").length);
      await page.locator("#comparison-slider").evaluate((slider) => {
        slider.value = "70";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.interactionCount)).toBe(
        interactionCountBeforeDispose + 1,
      );
      expect(await page.evaluate(() => performance.getEntriesByType("resource").length)).toBe(requestCountAfterDispose);
      expect(pageErrors).toHaveLength(pageErrorsBeforeDispose);
      expect(consoleErrors).toHaveLength(consoleErrorsBeforeDispose);
      expect(externalRequests).toEqual([]);
      expect(errorResponses).toEqual([]);
      expect(
        failedRequests.every(({ href, error }) => {
          const url = new URL(href);
          return url.origin === fixtureOrigin && error.includes("ERR_ABORTED");
        }),
      ).toBe(true);
    } finally {
      try {
        const closure = await fixtureServer.close();
        expect(closure).toEqual({ closed: true, listeningAfterClose: false, activeConnectionsAfterClose: 0 });
        await attestClosedFixture(testInfo, SAMPLE_ID, "startImageryCogFixtureServer");
      } finally {
        await finalizeSampleConsole({
          testInfo,
          sampleId: SAMPLE_ID,
          page,
          context,
          pageErrors,
          consoleErrors,
        });
      }
    }
  },
);
