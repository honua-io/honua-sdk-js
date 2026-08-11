import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { preview } from "vite";

import { SAMPLE_PERFORMANCE_BUDGET_MS } from "../../scripts/lib/sample-gates.mjs";
import { attachSampleGate, attestBrowserQuality, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const SAMPLE_ID = "coverages-wcs-basic";
const configFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/coverages-wcs-basic/vite.config.ts",
);

test.setTimeout(90_000);

test("renders both bounded clients through one MapLibre handoff and fails locally", async ({ browser, browserName }, testInfo) => {
  const previewServer = await preview({ configFile, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  const serverUrl = previewServer.resolvedUrls?.local[0];
  if (!serverUrl) throw new Error("Coverage preview server did not publish a local URL.");
  const fixtureOrigin = new URL(serverUrl).origin;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const failedRequests = [];
  const errorResponses = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`);
  });
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixtureOrigin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(serverUrl);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.ready === true)).toBe(true);
    const sampleReadyDurationMs = await page.evaluate(() => performance.now());
    expect(sampleReadyDurationMs).toBeLessThanOrEqual(SAMPLE_PERFORMANCE_BUDGET_MS);

    expect(
      await page.evaluate(() => {
        const runtime = window.__HONUA_COVERAGES_WCS__;
        return {
          ready: runtime?.ready,
          phase: runtime?.phase,
          protocol: runtime?.activeProtocol,
          collectionId: runtime?.collectionId,
          selectedBand: runtime?.selectedBand,
          sourceId: runtime?.mapSourceId,
          ogcBytes: runtime?.ogcByteLength,
          wcsBytes: runtime?.wcsByteLength,
          requestCount: runtime?.requestCount,
          error: runtime?.error,
        };
      }),
    ).toEqual({
      ready: true,
      phase: "ready",
      protocol: "ogc",
      collectionId: "7",
      selectedBand: "elevation",
      sourceId: "ogc-elevation",
      ogcBytes: 494,
      wcsBytes: 494,
      requestCount: 8,
      error: null,
    });

    const requests = await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requests ?? []);
    expect(requests).toHaveLength(8);
    expect(requests.every((requestUrl) => new URL(requestUrl).origin === "https://coverages.fixture.invalid")).toBe(true);
    const ogcRequest = new URL(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.ogcRequestUrl ?? ""));
    expect(ogcRequest.pathname).toBe("/ogc/coverages/collections/7/coverage");
    expect(ogcRequest.searchParams.get("properties")).toBe("elevation");
    expect(ogcRequest.searchParams.get("scale-size")).toBe("x(320),y(220)");
    expect(ogcRequest.searchParams.get("bbox")).toBe("-158.1,21.3,-157.9,21.5");
    const wcsRequest = new URL(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.wcsRequestUrl ?? ""));
    expect(wcsRequest.searchParams.get("REQUEST")).toBe("GetCoverage");
    expect(wcsRequest.searchParams.get("RANGESUBSET")).toBe("elevation");
    expect(wcsRequest.searchParams.get("SCALESIZE")).toBe("Lat(220),Long(320)");
    expect(wcsRequest.searchParams.getAll("SUBSET")).toEqual([
      "Lat(21.3,21.5)",
      "Long(-158.1,-157.9)",
    ]);

    await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);
    await expect(page.locator(".legend")).toContainText("elevation");
    await expect(page.locator("#pixel-value")).toHaveText("412 m");
    await expect(page.locator("#collection")).toContainText("7 / Oahu elevation");
    await expect(page.locator("#range")).toContainText("Elevation, Quality mask");
    await expect(page.locator("#wcs")).toContainText("2.0.1 / Lat x Long / elevation, quality");
    expect(await page.evaluate(() => Boolean(window.__honuaMaps?.[0]?.getSource("ogc-elevation")))).toBe(true);

    await page.getByRole("button", { name: "WCS 2.0.1" }).click();
    await expect(page.locator("#active-protocol")).toHaveText("WCS image source");
    expect(
      await page.evaluate(() => ({
        protocol: window.__HONUA_COVERAGES_WCS__?.activeProtocol,
        sourceId: window.__HONUA_COVERAGES_WCS__?.mapSourceId,
        sourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("wcs-elevation")),
        staleSourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("ogc-elevation")),
      })),
    ).toEqual({ protocol: "wcs", sourceId: "wcs-elevation", sourceMounted: true, staleSourceMounted: false });

    await page.getByRole("button", { name: "Prove cancellation" }).click();
    await expect(page.locator("#safety-status")).toContainText("Cancelled safely");
    expect(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.cancellationCount)).toBe(1);
    expect(await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.activeProtocol)).toBe("wcs");

    await page.getByRole("button", { name: "Prove degraded WCS" }).click();
    await expect(page.locator("#safety-status")).toContainText("InvalidParameterValue");
    expect(
      await page.evaluate(() => ({
        phase: window.__HONUA_COVERAGES_WCS__?.phase,
        degradations: window.__HONUA_COVERAGES_WCS__?.degradationCount,
        protocol: window.__HONUA_COVERAGES_WCS__?.activeProtocol,
        sourceMounted: Boolean(window.__honuaMaps?.[0]?.getSource("wcs-elevation")),
      })),
    ).toEqual({ phase: "degraded", degradations: 1, protocol: "wcs", sourceMounted: true });

    const runtimeReady = await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.ready === true);
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: SAMPLE_ID,
      browserName,
      sampleReadyDurationMs,
      runtimeReady,
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#map", ".evidence-panel", "#resilience"],
    });

    expect(externalRequests).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(errorResponses).toEqual([]);
    await attachSampleGate(testInfo, SAMPLE_ID, "fixture", {
      provider: "examples/coverages-wcs-basic/src/pinned-fixtures.ts",
      transport: "in-memory-fetch",
      escapedRequests: externalRequests.length,
      requestCount: await page.evaluate(() => window.__HONUA_COVERAGES_WCS__?.requestCount),
    });
  } finally {
    try {
      await finalizeSampleConsole({ testInfo, sampleId: SAMPLE_ID, page, context, pageErrors, consoleErrors });
    } finally {
      previewServer.httpServer.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        previewServer.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});