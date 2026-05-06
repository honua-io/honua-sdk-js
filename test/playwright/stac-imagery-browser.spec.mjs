import { expect, test } from "@playwright/test";

import { startStacBrowserFixtureServer } from "../../examples/stac-imagery-browser/mock-server.mjs";

test.setTimeout(90_000);

test("STAC Imagery Browser searches fixtures, pages, and shows unsupported raster messaging", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startStacBrowserFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_STAC_BROWSER__?.ready === true)).toBe(true);

    await expect(page.locator("#mode-state")).toContainText("Fixture safe mode");
    await expect(page.locator("#cache-state")).toContainText("schema cached");
    await expect(page.locator("#capability-state")).toContainText("raster unsupported");
    await expect(page.locator("#page-state")).toContainText("2/3 loaded");
    await expect(page.locator("#result-list")).toContainText("Oahu south shore clear pass");
    await expect(page.locator("#preview-state")).toContainText("ready as a Honua map preview layer");

    await page.getByRole("button", { name: "Load Next Page" }).click();
    await expect(page.locator("#page-state")).toContainText("3/3 loaded, complete");
    await expect(page.locator("#result-list")).toContainText("Leeward coast recent tasking");

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.selectAsset("S2A_20260412T211901_OAHU_01", "cog"));
    await expect(page.locator("#preview-state")).toContainText("Raster band math and coverage export are not enabled");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
