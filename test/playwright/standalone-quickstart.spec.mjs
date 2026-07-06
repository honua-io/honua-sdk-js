import { expect, test } from "@playwright/test";

import { startStandaloneFixtureServer } from "../../examples/standalone-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("standalone quickstart renders public-endpoint features with no Honua server", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
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

    // MapLibre wired the SDK-produced geojson source into real layers.
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.mapReady === true))
      .toBe(true);
    const layerIds = await page.evaluate(() => window.__HONUA_STANDALONE_RUNTIME__?.layerIds ?? []);
    expect(layerIds).toContain("standalone-fill");

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
