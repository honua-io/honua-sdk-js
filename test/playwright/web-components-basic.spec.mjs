import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

test.setTimeout(90_000);

test("web components compose map, layers, legend, table, search, and editor state", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startWebComponentsFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.ready === true)).toBe(true);

    await expect(page.locator("honua-map").getByText("Public safety incidents")).toBeVisible();
    await expect(page.locator("honua-layer-list").getByText("Incident labels")).toBeVisible();
    await expect(page.locator("honua-legend").getByText("High priority")).toBeVisible();
    await expect(page.locator("honua-feature-table").getByText("Harbor response district")).toBeVisible();
    await expect(page.locator("honua-editor").getByText("Source metadata marks incidents read-only.")).toBeVisible();
    await expect(page.locator("honua-editor button[data-action='save']")).toBeDisabled();
    await expect(page.locator("honua-chart").getByText("High")).toBeVisible();

    await page.getByLabel("Public safety incidents").uncheck();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.layerVisible("incident-points")))
      .toBe(false);
    await expect(page.locator("#event-log")).toHaveText("layer:incident-points:false");

    await page.locator("honua-search").getByRole("textbox", { name: "Search" }).fill("harbor");
    await page.locator("honua-search").getByRole("button", { name: "Search" }).click();
    await expect(page.locator("#event-log")).toHaveText("search:harbor:1");
    await page.getByRole("button", { name: "Harbor response district" }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.selectedFeatureId))
      .toBe(101);
    await expect(page.locator("honua-editor").getByText("Harbor response district")).toBeVisible();

    await page.locator("honua-feature-table tbody tr[data-feature-id='102']").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.selectedFeatureId))
      .toBe("102");
    await expect(
      page.locator("honua-feature-table tbody tr[aria-selected='true']").getByText("Kakaako utility corridor"),
    ).toBeVisible();

    await page.locator("honua-feature-table").evaluate((element) => element.setAttribute("filter-text", "kakaako"));
    await expect(page.locator("#event-log")).toHaveText("filter:incidents:kakaako");
    await expect(page.locator("honua-feature-table").getByText("Ala Moana shelter route")).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
