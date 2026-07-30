import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

test.setTimeout(90_000);

test("native controls-kit layer list toggles from real keyboard input", async ({ page }) => {
  const server = await startWebComponentsFixtureServer();
  try {
    await page.goto(`${server.url}?controls-layer-list=1`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.ready === true)).toBe(true);

    await page.evaluate(() => {
      const map = document.querySelector("honua-map").map;
      const list = document.createElement("honua-controls-layer-list");
      list.id = "controls-layer-list-keyboard-fixture";
      list.map = map;
      list.overlays = [{ id: "incidents", label: "Public safety incidents", layers: ["incident-points"] }];
      document.body.append(list);
    });

    const checkbox = page.locator("#controls-layer-list-keyboard-fixture").locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await expect
      .poll(async () =>
        page.evaluate(() => document.querySelector("honua-map").map.getLayoutProperty("incident-points", "visibility")),
      )
      .toBe("none");
  } finally {
    await server.close();
  }
});

test("controller-driven layer list responds to focused Space and Enter activation", async ({ page }) => {
  const server = await startWebComponentsFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.ready === true)).toBe(true);

    const layerList = page.locator("honua-layer-list");
    const visibility = layerList.locator("input[data-layer-id='incident-points']");
    await expect(visibility).toBeChecked();
    await visibility.focus();
    await page.keyboard.press("Space");

    await expect(visibility).not.toBeChecked();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.layerVisible("incident-points")))
      .toBe(false);
    await expect(layerList.locator("input[data-layer-id='incident-points']")).not.toBeChecked();

    const reorder = layerList.locator("button[data-move='up:incident-points']");
    await expect(reorder).toBeEnabled();
    await reorder.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator("#event-log")).toHaveText("reorder:incident-points:zoning-districts,incident-points,incident-halos");
    await expect
      .poll(async () =>
        page.locator("honua-layer-list").evaluate((element) =>
          [...(element.shadowRoot?.querySelectorAll("[data-layer-row]") ?? [])].map((row) => row.getAttribute("data-layer-row")),
        ),
      )
      .toEqual(["zoning-districts", "incident-points", "incident-halos"]);
  } finally {
    await server.close();
  }
});

test("feature table keeps keyboard selection deterministic across reconnect", async ({ page }) => {
  const server = await startWebComponentsFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.ready === true)).toBe(true);

    const table = page.locator("honua-feature-table");
    const firstCell = table.locator("tbody tr[data-feature-id='101'] [role='gridcell']").first();
    await expect(firstCell).toBeVisible();
    await firstCell.focus();
    await firstCell.press("ArrowDown");

    await expect
      .poll(async () =>
        table.evaluate((element) => {
          const active = element.shadowRoot?.activeElement;
          return active?.closest("tr")?.getAttribute("data-feature-id");
        }),
      )
      .toBe("102");

    await table.evaluate((element) => {
      element.setAttribute("data-selection-event-count", "0");
      element.addEventListener("honua-selection-change", () => {
        const count = Number(element.getAttribute("data-selection-event-count") ?? "0");
        element.setAttribute("data-selection-event-count", String(count + 1));
      });
      element.remove();
      document.body.append(element);
    });

    const reconnectedCell = table.locator("tbody tr[data-feature-id='102'] [role='gridcell']").first();
    await expect(reconnectedCell).toBeVisible();
    await reconnectedCell.focus();
    await reconnectedCell.press("Enter");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.selectedFeatureId))
      .toBe("102");

    await expect(table).toHaveAttribute("data-selection-event-count", "1");
  } finally {
    await server.close();
  }
});

test("production feature editor visual baseline is reproducible", async ({ page }) => {
  const server = await startWebComponentsFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => customElements.get("honua-feature-editor") !== undefined)).toBe(true);

    await page.evaluate(() => {
      const editor = document.createElement("honua-feature-editor");
      editor.id = "visual-feature-editor";
      editor.setAttribute("for", "ops-map");
      editor.setAttribute("source", "incidents");
      document.body.append(editor);
    });
    const editor = page.locator("#visual-feature-editor");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveScreenshot("feature-editor.png", {
      animations: "disabled",
      caret: "hide",
    });
  } finally {
    await server.close();
  }
});

test("web components compose map, layers, legend, table, search, and editor state", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startWebComponentsFixtureServer();
  try {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
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

    const darkBasemap = page.locator("honua-basemap-switcher").getByRole("radio", { name: "Dark" });
    await darkBasemap.focus();
    await darkBasemap.press("Space");
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

    const harborBookmark = page.locator("honua-bookmarks").getByRole("button", { name: "Harbor" });
    await harborBookmark.focus();
    await harborBookmark.press("Enter");
    await expect(page.locator("#event-log")).toHaveText("bookmark:harbor");

    const locateButton = page.locator("honua-locate-control").getByRole("button", { name: "Use location" });
    await locateButton.focus();
    await locateButton.press("Enter");
    await expect(page.locator("#event-log")).toHaveText("locate:ready");

    const snapshotButton = page.locator("honua-print-export").getByRole("button", { name: "Snapshot" });
    await snapshotButton.focus();
    await snapshotButton.press("Enter");
    await expect(page.locator("#event-log")).toHaveText("export:png:unsupported");

    const refreshButton = page.locator("honua-action-panel").getByRole("button", { name: "Refresh sources" });
    await refreshButton.focus();
    await refreshButton.press("Enter");
    await expect(page.locator("#event-log")).toHaveText("action:refresh:ready");

    const fullscreenButton = page.locator("honua-map-status").getByRole("button", { name: "Fullscreen" });
    await fullscreenButton.focus();
    await fullscreenButton.press("Enter");
    await expect(page.locator("#event-log")).toHaveText("fullscreen:unsupported");

    await page.evaluate(() => {
      const controller = {
        getState: () => ({ status: "ready" }),
        subscribe: () => ({ remove() {} }),
        canMeasure: () => true,
        canSketch: () => true,
        setMeasureMode: (mode) => Promise.resolve({ mode, status: "ready" }),
        setSketchMode: (mode) => Promise.resolve({ mode, status: "ready" }),
      };
      const measure = document.createElement("honua-measure-control");
      measure.dataset.keyboardProbe = "measure";
      measure.controller = controller;
      measure.addEventListener("honua-measure-change", (event) => {
        measure.dataset.lastMode = event.detail.mode;
      });
      const sketch = document.createElement("honua-sketch-control");
      sketch.dataset.keyboardProbe = "sketch";
      sketch.controller = controller;
      sketch.addEventListener("honua-sketch-change", (event) => {
        sketch.dataset.lastMode = event.detail.mode;
      });
      document.body.append(measure, sketch);
    });
    const measureDistance = page.locator("honua-measure-control[data-keyboard-probe='measure']").getByRole("button", {
      name: "Distance",
    });
    await measureDistance.focus();
    await measureDistance.press("Enter");
    await expect(page.locator("honua-measure-control[data-keyboard-probe='measure']")).toHaveAttribute(
      "data-last-mode",
      "distance",
    );
    const sketchPoint = page.locator("honua-sketch-control[data-keyboard-probe='sketch']").getByRole("button", {
      name: "Point",
    });
    await sketchPoint.focus();
    await sketchPoint.press("Enter");
    await expect(page.locator("honua-sketch-control[data-keyboard-probe='sketch']")).toHaveAttribute(
      "data-last-mode",
      "point",
    );

    await page.evaluate(() => {
      const model = {
        sourceId: "incidents",
        status: "ready",
        capabilities: { canCreate: true, canUpdate: true, canDelete: true, readOnly: false },
      };
      const controller = {
        getState: () => ({
          status: "ready",
          editor: model,
          selection: { feature: { id: 101, sourceId: "incidents", title: "Harbor response district" } },
        }),
        subscribe: () => ({ remove() {} }),
        applyEdit: () => Promise.resolve(model),
      };
      const editor = document.createElement("honua-editor");
      editor.dataset.keyboardProbe = "editor";
      editor.controller = controller;
      editor.addEventListener("honua-edit-change", (event) => {
        editor.dataset.lastOperation = event.detail.request.operation;
      });
      document.body.append(editor);
    });
    const newEditor = page.locator("honua-editor[data-keyboard-probe='editor']").getByRole("button", { name: "New" });
    await newEditor.focus();
    await newEditor.press("Enter");
    await expect(page.locator("honua-editor[data-keyboard-probe='editor']")).toHaveAttribute(
      "data-last-operation",
      "create",
    );

    await page.evaluate(() => {
      const switcher = document.createElement("honua-basemap-switcher");
      switcher.dataset.keyboardProbe = "controls-basemap";
      switcher.bases = [
        { id: "probe-one", label: "Probe one", kind: "vector", sources: {}, layers: [] },
        { id: "probe-two", label: "Probe two", kind: "vector", sources: {}, layers: [] },
      ];
      switcher.addEventListener("change", (event) => {
        switcher.dataset.lastValue = event.detail.value;
      });
      document.body.append(switcher);
    });
    const probeOne = page
      .locator("honua-basemap-switcher[data-keyboard-probe='controls-basemap']")
      .getByRole("radio", { name: "Probe one" });
    await probeOne.focus();
    await probeOne.press("ArrowRight");
    await expect(page.locator("honua-basemap-switcher[data-keyboard-probe='controls-basemap']")).toHaveAttribute(
      "data-last-value",
      "probe-two",
    );

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
