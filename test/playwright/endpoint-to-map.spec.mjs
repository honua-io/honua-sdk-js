import { expect, test } from "@playwright/test";

import { startEndpointToMapFixtureServer } from "../../examples/endpoint-to-map/mock-server.mjs";

test.setTimeout(90_000);

test("endpoint-to-map bridge mounts a public endpoint as styled MapLibre layers", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startEndpointToMapFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect.poll(async () => page.evaluate(() => window.__endpointToMapState?.ready === true)).toBe(true);

    const state = await page.evaluate(() => window.__endpointToMapState);
    expect(state.error).toBeUndefined();
    expect(state.strategy).toBe("geojson");
    expect(state.featureCount).toBeGreaterThan(0);
    expect(state.layerIds.some((id) => id.endsWith("-polygon"))).toBe(true);
    expect(state.layerIds.some((id) => id.endsWith("-polygon-outline"))).toBe(true);
    expect(state.kernelMountReady).toBe(true);
    expect(state.kernelMountDisposed).toBe(true);

    await expect(page.locator("#status-strategy")).toHaveText("geojson");
    await expect(page.locator("#status-feature-count")).not.toHaveText("0");
    await expect(page.locator("#status-error")).toHaveText("None");
    await expect(page.locator("#status-kernel-mount")).toHaveText("Ready → disposed; host survived");
    await expect(page.locator("#strategy-reasons li").first()).toContainText("query-capability");

    // The live-filter dropdown drives mounted.setFilter() diff updates.
    await page.selectOption("#filter-select", { index: 1 });
    await expect(page.locator("#status-error")).toHaveText("None");

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
