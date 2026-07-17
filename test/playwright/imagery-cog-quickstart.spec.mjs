import { expect, test } from "@playwright/test";

import { startImageryCogFixtureServer } from "../../examples/imagery-cog-quickstart/mock-server.mjs";
import { SAMPLE_PERFORMANCE_BUDGET_MS } from "../../scripts/lib/sample-gates.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const SAMPLE_ID = "imagery-cog-quickstart";
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];
const WORKFLOW_SELECTORS = ["#stac-search-form", "#map", "#asset-inspection", "#elevation-profile"];
const BUNDLE_BYTES_BUDGET = 2.5 * 1024 * 1024;
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
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      failedRequests.push({ href: request.url(), error: request.failure()?.errorText ?? "unknown" });
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
        };
      });
      expect(runtimeIdentity).toMatchObject({
        ready: true,
        disposed: false,
        selectedAssetKey: "cog",
        inspectionStatus: "ready",
        activeLayerCount: 2,
        resources: { activeRequests: 0, disposed: false },
      });
      expect(runtimeIdentity.tileTemplates.some((template) => template.includes("REQUEST=GetMap"))).toBe(true);
      expect(
        runtimeIdentity.tileTemplates.some((template) => template.includes("/OahuCog/ImageServer/tile/{z}/{y}/{x}")),
      ).toBe(true);
      expect(
        runtimeIdentity.tileTemplates.some((template) => template.includes("/OahuTerrain/ImageServer/tile/{z}/{y}/{x}")),
      ).toBe(true);
      await expect.poll(() => wmsGetMapRequests.length).toBeGreaterThan(0);
      for (const href of wmsGetMapRequests) {
        const requestUrl = new URL(href);
        const bbox = requestUrl.searchParams.get("BBOX")?.split(",").map(Number);
        expect(bbox).toHaveLength(4);
        expect(bbox?.every(Number.isFinite)).toBe(true);
        expect(requestUrl.searchParams.get("WIDTH")).toBe("256");
        expect(requestUrl.searchParams.get("HEIGHT")).toBe("256");
        expect(href).not.toMatch(/%7B|%7D|\{|\}/iu);
      }

      await expect(page.getByRole("heading", { level: 1, name: "Imagery and Terrain" })).toBeVisible();
      await expect(page.getByTestId("honua-sample-mode")).toHaveText(/^(source|packed) SDK$/u);
      await expect(page.locator("#search-status")).toContainText("HonuaClient.stac().search");
      await expect(page.locator("#scene-results")).toContainText("Oahu south shore clear pass");
      await expect(page.locator("#inspection-content")).toHaveAttribute("data-status", "ready");
      await expect(page.locator("#inspection-content")).toContainText("bytes 0-63/");
      await expect(page.locator("#inspection-content")).toContainText('"oahu-range-fixture-v1"');
      await expect(page.locator("#inspection-content")).toContainText("CC-BY-4.0 fixture terms");
      await expect(page.locator("#attribution-state")).toContainText("Copernicus Sentinel");
      await expect(page.locator("#fidelity-list")).toContainText("direct decoding/rendering remains #537");
      await expect(page.locator("#fidelity-list")).toContainText("#620 corrects it package-wide");
      await expect(page.locator("#fidelity-list")).toContainText("Cesium production is intentionally excluded");
      await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);

      const unsupportedCases = [
        ["credential-cog", "credentials"],
        ["cors-cog", "cors"],
        ["no-range-cog", "range"],
        ["oversized-cog", "range"],
        ["chunked-oversized-cog", "range"],
        ["unsupported-crs", "crs"],
        ["unsupported-format", "format"],
        ["missing-nodata", "nodata"],
      ];
      for (const [assetKey, code] of unsupportedCases) {
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
      }
      await expect(page.locator("body")).not.toContainText("fixture-super-secret");
      await expect(page.locator("body")).not.toContainText("fixture-password");

      const switchOutcomes = await page.evaluate(async () => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        if (!runtime) throw new Error("Imagery and Terrain runtime is unavailable");
        return Promise.all([runtime.selectAsset("slow-cog"), runtime.selectAsset("cog")]);
      });
      expect(switchOutcomes[0]).toMatchObject({ status: "cancelled", reason: "superseded" });
      expect(switchOutcomes[1]).toMatchObject({ status: "ready", identity: { assetKey: "cog" } });
      expect(
        await page.evaluate(() => ({
          cancellations: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.cancellationCount,
          releases: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources,
          activeLayerCount: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.activeLayerCount,
          retained: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources.retainedRasterResource,
        })),
      ).toMatchObject({ cancellations: 1, activeLayerCount: 2 });
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources)).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources.retainedRasterResource)).toContain(
        "/cog",
      );

      const comparison = page.locator("#comparison-slider");
      await comparison.focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator("#comparison-value")).toHaveText("1% ImageServer over WMS");
      await comparison.fill("35");
      await expect(page.locator("#comparison-value")).toHaveText("35% ImageServer over WMS");

      const terrainToggle = page.locator("#terrain-toggle");
      await terrainToggle.focus();
      await page.keyboard.press("Space");
      await expect(terrainToggle).toBeChecked();
      await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.terrainEnabled)).toBe(true);
      await expect(page.locator("#fidelity-list")).toContainText("enabled at 1.25× exaggeration");

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
        ["@honua/sdk-js/contract", "@honua/sdk-js/honua", "@honua/sdk-js/runtime"].sort(),
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
          resources: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.resources,
          releases: window.__HONUA_IMAGERY_TERRAIN_RUNTIME__?.releasedRasterResources,
          presentationCount: document.querySelectorAll(".honua-sample-kit").length,
        })),
      ).toEqual({
        ready: false,
        resources: { activeRequests: 0, activeSelectionId: undefined, retainedRasterResource: undefined, disposed: true },
        releases: releaseCountBeforeDispose + 1,
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
