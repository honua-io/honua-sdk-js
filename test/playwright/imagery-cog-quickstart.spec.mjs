import { expect, test } from "@playwright/test";

import { startImageryCogFixtureServer } from "../../examples/imagery-cog-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("Imagery and COG Quickstart renders fixture-backed raster paths", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startImageryCogFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.ready === true)).toBe(true);

    await expect(page.locator("#mode-state")).toContainText("Fixture safe mode");
    await expect(page.locator("#capability-state")).toContainText("WMS GetMap");
    await expect(page.locator("#capability-state")).toContainText("ImageServer tile");
    await expect(page.locator("#cache-state")).toContainText("2 ready");
    await expect(page.locator("#layer-list")).toContainText("Published COG through ImageServer");
    await expect(page.locator("#audit-table")).toContainText("HonuaImageService.tileUrl");

    const tileTemplates = await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.tileTemplates ?? []);
    expect(tileTemplates.some((template) => template.includes("/ImageServer/tile/{z}/{y}/{x}?f=png"))).toBe(true);
    expect(tileTemplates.some((template) => template.includes("REQUEST=GetMap"))).toBe(true);

    await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.toggleLayer("oahu-cog-image-server", false));
    await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.activeLayerCount)).toBe(1);
    await expect(page.locator("#active-layer-count")).toHaveText("1 active");

    await page.getByRole("button", { name: /COG export preview/ }).click();
    await expect(page.locator("#export-state")).toContainText("/fixtures/imagery/export/oahu-cog-preview.png");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
