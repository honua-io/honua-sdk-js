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
    await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapNonBlank())).toBe(true);

    await expect(page.locator("honua-map canvas")).toHaveCount(1);
    await expect(page.locator("honua-layer-list").getByText("Incident response halos")).toBeVisible();
    await expect(page.locator("honua-legend").getByText("High priority")).toBeVisible();
    await expect(page.locator("honua-feature-table").getByText("Harbor response district")).toBeVisible();
    await expect(page.locator("honua-editor").getByText("Source metadata marks incidents read-only.")).toBeVisible();
    await expect(page.locator("honua-editor button[data-action='save']")).toBeDisabled();
    await expect(page.locator("honua-chart").getByText("High")).toBeVisible();

    const harborPoint = await mapPoint(page, [-157.87, 21.31]);
    await page.mouse.move(harborPoint.x, harborPoint.y);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.events.includes("hover:101")))
      .toBe(true);
    await page.mouse.click(harborPoint.x, harborPoint.y);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.selectedFeatureId))
      .toBe(101);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.events.includes("click:101")))
      .toBe(true);

    await page.locator("honua-map").getByLabel("Zoom in").click();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.events.some((event) => event.startsWith("viewport:"))))
      .toBe(true);

    await page.getByLabel("Public safety incidents").uncheck();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.layerVisible("incident-points")))
      .toBe(false);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("incident-points")))
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

    const teardown = await page.locator("honua-map").evaluate((element) => {
      element.remove();
      return {
        connected: element.isConnected,
        hasCanvas: element.shadowRoot?.querySelector("canvas") !== null,
        hasMap: element.map !== undefined,
        hasRuntime: element.runtime !== undefined,
      };
    });
    expect(teardown).toEqual({ connected: false, hasCanvas: false, hasMap: false, hasRuntime: false });

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});

async function mapPoint(page, lngLat) {
  return await page.locator("honua-map").evaluate((element, coordinate) => {
    const map = element.map;
    const host = element.shadowRoot?.querySelector(".map__renderer");
    if (!map?.project || !host) throw new Error("MapLibre map is not ready.");
    const point = map.project(coordinate);
    const rect = host.getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  }, lngLat);
}
