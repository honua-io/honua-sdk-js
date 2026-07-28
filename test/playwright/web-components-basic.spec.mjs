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
    // Derive-mode rows parsed from the zoning layer's match expression,
    // including the fallback color row.
    await expect(page.locator("honua-legend").getByText("Residential")).toBeVisible();
    await expect(page.locator("honua-legend").getByText("Open-Park")).toBeVisible();
    await expect(page.locator("honua-legend").getByText("Other")).toBeVisible();
    await expect(page.locator("honua-feature-table").getByText("Harbor response district")).toBeVisible();
    await expect(page.locator("honua-editor").getByText("Source metadata marks incidents read-only.")).toBeVisible();
    await expect(page.locator("honua-editor button[data-action='save']")).toBeDisabled();
    await expect(page.locator("honua-chart").getByText("High")).toBeVisible();
    await expect(page.locator("honua-basemap-switcher").getByRole("radio", { name: "Dark" })).toBeVisible();
    await expect(page.locator("honua-basemap-switcher").getByRole("radio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator("honua-bookmarks").getByRole("button", { name: "Home" })).toBeVisible();
    await expect(page.locator("honua-locate-control").getByRole("button", { name: "Use location" })).toBeVisible();
    await expect(
      page.locator("honua-measure-control").getByText("Measurement is disabled because no geometry provider is configured"),
    ).toBeVisible();
    await expect(
      page.locator("honua-sketch-control").getByText("Sketching is disabled because no geometry provider is configured"),
    ).toBeVisible();
    await expect(page.locator("honua-measure-control").getByRole("button", { name: "Distance" })).toBeDisabled();
    await expect(page.locator("honua-sketch-control").getByRole("button", { name: "Point" })).toBeDisabled();
    await expect(page.locator("honua-print-export").getByRole("button", { name: "Snapshot" })).toBeVisible();
    await expect(page.locator("honua-map-status").getByText("Honua demo data")).toBeVisible();
    await expect(page.locator("honua-action-panel").getByRole("button", { name: "Refresh sources" })).toBeVisible();

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

    const initialViewportEvents = await page.evaluate(
      () => window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0,
    );
    await page.locator("honua-map").getByLabel("Zoom in").click();
    await expect
      .poll(async () =>
        page.evaluate(
          (before) =>
            (window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0) >
            before,
          initialViewportEvents,
        ),
      )
      .toBe(true);
    await page.waitForTimeout(500);
    const baselineViewportEvents = await page.evaluate(
      (before) =>
        (window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0) -
        before,
      initialViewportEvents,
    );

    const zoomIn = page.locator("honua-map").getByLabel("Zoom in");
    await zoomIn.focus();
    await page.locator("honua-map").evaluate((element) => {
      const viewport = element.controller?.getState().viewport ?? {};
      for (let index = 0; index < 4; index += 1) {
        element.controller?.setViewport({ ...viewport, zoom: (viewport.zoom ?? 0) + index / 10 });
      }
    });
    await expect
      .poll(async () => page.locator("honua-map").evaluate((element) => element.shadowRoot?.activeElement?.getAttribute("aria-label")))
      .toBe("Zoom in");
    await page.waitForTimeout(500);
    const viewportEventsBeforeClick = await page.evaluate(
      () => window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0,
    );
    await zoomIn.click();
    await expect
      .poll(async () =>
        page.evaluate(
          (before) =>
            (window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0) -
            before,
          viewportEventsBeforeClick,
        ),
      )
      .toBe(baselineViewportEvents);

    const viewportEventsBeforeKey = await page.evaluate(
      () => window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0,
    );
    await zoomIn.press("Enter");
    await expect
      .poll(async () =>
        page.evaluate(
          (before) =>
            (window.__HONUA_WEB_COMPONENTS_DEMO__?.events.filter((event) => event.startsWith("viewport:")).length ?? 0) -
            before,
          viewportEventsBeforeKey,
        ),
      )
      .toBe(baselineViewportEvents);

    await page.getByLabel("Public safety incidents").uncheck();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.layerVisible("incident-points")))
      .toBe(false);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("incident-points")))
      .toBe(false);
    await expect(page.locator("#event-log")).toHaveText("layer:incident-points:false");

    // follow-layer-visibility: hiding the zoning layer hides its derived
    // legend section; re-showing it brings the section back.
    await page.getByLabel("Zoning districts").uncheck();
    await expect(page.locator("honua-legend").getByText("Residential")).toBeHidden();
    await page.getByLabel("Zoning districts").check();
    await expect(page.locator("honua-legend").getByText("Residential")).toBeVisible();

    await page.locator("#incident-search").getByRole("textbox", { name: "Search" }).fill("harbor");
    await page.keyboard.press("Enter");
    await expect(page.locator("#event-log")).toHaveText("search:harbor:1");
    await expect
      .poll(async () =>
        page.locator("#incident-search").evaluate((element) => element.shadowRoot?.activeElement?.id),
      )
      .toBe("honua-search-input");
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

    await page.locator("honua-basemap-switcher").getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("#event-log")).toHaveText("basemap:dark");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("base-dark")))
      .toBe(true);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("base-light")))
      .toBe(false);
    await expect(page.locator("honua-basemap-switcher").getByRole("radio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.locator("honua-basemap-switcher").getByRole("radio", { name: "Terrain" }).click();
    await expect(page.locator("#event-log")).toHaveText("basemap:terrain");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("base-terrain")))
      .toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("base-terrain-contours")),
      )
      .toBe(true);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.mapLayerVisible("base-dark")))
      .toBe(false);

    await page.locator("honua-bookmarks").getByRole("button", { name: "Harbor" }).click();
    await expect(page.locator("#event-log")).toHaveText("bookmark:harbor");

    await page.locator("honua-locate-control").getByRole("button", { name: "Use location" }).click();
    await expect(page.locator("#event-log")).toHaveText("locate:ready");

    await page.locator("honua-print-export").getByRole("button", { name: "Snapshot" }).click();
    await expect(page.locator("#event-log")).toHaveText("export:png:unsupported");

    await page.locator("honua-action-panel").getByRole("button", { name: "Refresh sources" }).click();
    await expect(page.locator("#event-log")).toHaveText("action:refresh:ready");

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

test("honua-map package-url failures render persistent status text", async ({ page }) => {
  const server = await startWebComponentsFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => customElements.get("honua-map") !== undefined)).toBe(true);

    const statusText = await page.evaluate(async () => {
      const element = document.createElement("honua-map");
      element.setAttribute("src", "/__missing-map-package__.json");
      document.body.append(element);
      await new Promise((resolve) => element.addEventListener("honua-map-error", resolve, { once: true }));
      return element.shadowRoot?.querySelector(".map__status")?.textContent ?? "";
    });

    expect(statusText).not.toBe("Loading map package");
    expect(statusText.length).toBeGreaterThan(0);
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
