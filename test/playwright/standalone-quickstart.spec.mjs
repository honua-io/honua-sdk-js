import { expect, test } from "@playwright/test";

import { startStandaloneFixtureServer } from "../../examples/standalone-quickstart/mock-server.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

test.setTimeout(90_000);

test("standalone quickstart renders public-endpoint features with no Honua server", async ({ browser, browserName }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const fixtureServer = await startStandaloneFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.ready === true))
      .toBe(true);

    // Data path succeeded with no server involvement.
    const runtime = await page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__);
    expect(runtime.error).toBeUndefined();
    expect(runtime.usedServer).toBe(false);
    expect(runtime.featureCount).toBeGreaterThan(0);

    // The esri-compat drop-in returned the same records as the map path.
    expect(runtime.compatFeatureCount).toBe(runtime.featureCount);

    await expect(page.locator("#status-feature-count")).not.toHaveText("0");
    await expect(page.locator("#status-error")).toHaveText("None");
    await expect(page.locator("#feature-list")).toContainText("California");
    await expect(page.getByTestId("honua-sample-mode")).toHaveText(/source|packed/);
    await expect(page.getByTestId("honua-sample-evidence")).toContainText("Evidence");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // MapLibre wired the SDK-produced geojson source into real layers.
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.mapReady === true))
      .toBe(true);
    const layerIds = await page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.layerIds ?? []);
    expect(layerIds).toContain("standalone-fill");

    const runtimeReady = await page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.ready === true);
    const sampleReadyDurationMs = await page.evaluate(() => performance.now());
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: "standalone-quickstart",
      browserName,
      sampleReadyDurationMs,
      runtimeReady,
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#status-feature-count", "#feature-list", "#map"],
    });

    await page.evaluate(() => window.__HONUA_STANDALONE_DISPOSE__?.());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.disposed)).toBe(true);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  } finally {
    try {
      await fixtureServer.close();
      await attestClosedFixture(testInfo, "standalone-quickstart", "startStandaloneFixtureServer");
    } finally {
      await finalizeSampleConsole({
        testInfo,
        sampleId: "standalone-quickstart",
        page,
        context,
        pageErrors,
        consoleErrors,
      });
    }
  }
});
