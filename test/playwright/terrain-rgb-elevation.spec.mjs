import { expect, test } from "@playwright/test";

import { startTerrainElevationFixtureServer } from "../../examples/terrain-rgb-elevation/mock-server.mjs";

test.setTimeout(90_000);

test("Terrain-RGB Elevation renders tiles, samples a point, and queries a line profile", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startTerrainElevationFixtureServer();
  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_TERRAIN_ELEVATION_DEMO__?.ready === true))
      .toBe(true);

    await expect(page.locator("#mode-state")).toContainText("Fixture safe mode");
    await expect(page.locator("#capability-state")).toContainText("Terrain-RGB tiles");
    await expect(page.locator("#cache-state")).toContainText("interactions uncached");
    await expect(page.locator("#metadata-state")).toContainText("Oahu Terrain-RGB Elevation ImageServer");
    await expect(page.locator("#audit-table")).toContainText("HonuaImageService.tileUrl");
    await expect(page.locator("#audit-table")).toContainText("typed Terrain API gap");

    const tileTemplates = await page.evaluate(() => window.__HONUA_TERRAIN_ELEVATION_DEMO__?.tileTemplates ?? []);
    expect(tileTemplates).toContain(`${server.url}/rest/services/OahuTerrain/ImageServer/tile/{z}/{y}/{x}?f=png`);

    await page.evaluate(() => window.__HONUA_TERRAIN_ELEVATION_DEMO__?.lookupAt(-157.84, 21.42));
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_TERRAIN_ELEVATION_DEMO__?.lastElevationMeters))
      .toBeGreaterThan(0);
    await expect(page.locator("#point-elevation")).toContainText("m");
    await expect(page.locator("#point-source")).toContainText("/api/v1/terrain/OahuTerrain/elevation/value");

    await page.getByRole("button", { name: "Fixture Line" }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_TERRAIN_ELEVATION_DEMO__?.profileSampleCount))
      .toBe(8);
    await expect(page.locator("#profile-summary")).toContainText("8 samples");
    await expect(page.locator("#profile-chart svg")).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
