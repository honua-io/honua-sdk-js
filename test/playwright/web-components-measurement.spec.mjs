/**
 * `<honua-measurement>` in a real browser (issue #1419): touch taps and
 * keyboard operation on a live MapLibre map, unit/precision attributes, and
 * teardown that releases every map listener, the sketch overlay, the
 * double-click-zoom suspension, and the element itself.
 *
 * Expected distances are computed here from the map's own `unproject` of the
 * tapped pixels with the haversine formula on the sphere `@honua/geometry`
 * measures on (turf's 6,371,008.8 m) — independent of the element's code.
 */

import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

test.setTimeout(120_000);

const EARTH_RADIUS_METERS = 6_371_008.8;

function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

async function openDemo(page, server) {
  await page.goto(server.url);
  await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.ready === true)).toBe(true);
  await expect
    .poll(async () => page.evaluate(() => document.querySelector("honua-measurement")?.map !== undefined))
    .toBe(true);
}

async function canvasPoints(page) {
  const box = await page.locator("honua-map canvas").first().boundingBox();
  if (!box) throw new Error("map canvas has no layout box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    box,
    first: { x: cx - box.width / 5, y: cy },
    second: { x: cx + box.width / 5, y: cy + box.height / 8 },
  };
}

async function unproject(page, box, point) {
  return page.evaluate(
    ({ x, y }) => {
      const lngLat = document.querySelector("honua-map").map.unproject([x, y]);
      return [lngLat.lng, lngLat.lat];
    },
    { x: point.x - box.x, y: point.y - box.y },
  );
}

test("touch taps measure a geodesic distance and Finish completes it", async ({ browser }) => {
  const server = await startWebComponentsFixtureServer();
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await openDemo(page, server);
    const measurement = page.locator("honua-measurement");
    await measurement.getByRole("button", { name: "Distance" }).tap();
    await expect(measurement.getByRole("button", { name: "Distance" })).toHaveAttribute("aria-pressed", "true");

    const { box, first, second } = await canvasPoints(page);
    await page.touchscreen.tap(first.x, first.y);
    await page.touchscreen.tap(second.x, second.y);
    await expect.poll(async () => page.evaluate(() => document.querySelector("honua-measurement").vertices.length)).toBe(2);

    const [a, b] = await page.evaluate(() => document.querySelector("honua-measurement").vertices.map((v) => [...v]));
    // The recorded vertices are the tapped pixels, unprojected by the map itself.
    const expectedA = await unproject(page, box, first);
    const expectedB = await unproject(page, box, second);
    expect(a[0]).toBeCloseTo(expectedA[0], 4);
    expect(a[1]).toBeCloseTo(expectedA[1], 4);
    expect(b[0]).toBeCloseTo(expectedB[0], 4);
    expect(b[1]).toBeCloseTo(expectedB[1], 4);

    const distance = await page.evaluate(() => document.querySelector("honua-measurement").result.distance);
    const expected = haversineMeters(a, b);
    expect(Math.abs(distance - expected) / expected).toBeLessThan(1e-6);

    await measurement.getByRole("button", { name: "Finish" }).tap();
    await expect(measurement.getByRole("status")).toContainText("(finished)");
  } finally {
    await context.close();
    await server.close();
  }
});

test("keyboard operates modes, Escape cancels, and unit attributes reformat the live readout", async ({ page }) => {
  const server = await startWebComponentsFixtureServer({ build: process.env.HONUA_SKIP_FIXTURE_BUILD !== "true" });
  try {
    await openDemo(page, server);
    const measurement = page.locator("honua-measurement");
    const distanceButton = measurement.getByRole("button", { name: "Distance" });
    await distanceButton.focus();
    await page.keyboard.press("Enter");
    await expect(distanceButton).toHaveAttribute("aria-pressed", "true");
    await expect(distanceButton).toBeFocused();

    const { first, second } = await canvasPoints(page);
    await page.mouse.click(first.x, first.y);
    await page.mouse.click(second.x, second.y);
    await expect.poll(async () => page.evaluate(() => document.querySelector("honua-measurement").vertices.length)).toBe(2);

    await page.evaluate(() => {
      const element = document.querySelector("honua-measurement");
      element.setAttribute("unit", "feet");
      element.setAttribute("precision", "0");
    });
    const meters = await page.evaluate(() => document.querySelector("honua-measurement").result.distance);
    await expect(measurement.getByRole("status")).toHaveText(`Distance: ${(meters / 0.3048).toFixed(0)} ft`);
    await expect(measurement.getByRole("status")).toHaveAttribute("aria-live", "polite");

    const finish = measurement.getByRole("button", { name: "Finish" });
    await finish.focus();
    await page.keyboard.press("Enter");
    await expect(measurement.getByRole("status")).toContainText("(finished)");

    await page.mouse.click(first.x, first.y);
    await expect.poll(async () => page.evaluate(() => document.querySelector("honua-measurement").vertices.length)).toBe(1);
    await page.keyboard.press("Escape");
    await expect.poll(async () => page.evaluate(() => document.querySelector("honua-measurement").vertices.length)).toBe(0);
  } finally {
    await server.close();
  }
});

test("removing an active measurement releases the map and is collectible", async ({ page }) => {
  const server = await startWebComponentsFixtureServer({ build: process.env.HONUA_SKIP_FIXTURE_BUILD !== "true" });
  const client = await page.context().newCDPSession(page);
  try {
    await openDemo(page, server);
    const before = await page.evaluate(() => {
      const map = document.querySelector("honua-map").map;
      const count = (type) => map._listeners?.[type]?.length ?? 0;
      return { click: count("click"), dblclick: count("dblclick"), remove: count("remove") };
    });

    const during = await page.evaluate(() => {
      const map = document.querySelector("honua-map").map;
      const count = (type) => map._listeners?.[type]?.length ?? 0;
      const element = document.createElement("honua-measurement");
      document.body.append(element);
      element.map = map;
      element.setMode("area");
      element.addVertex([0, 0]);
      element.addVertex([0.01, 0]);
      element.addVertex([0.01, 0.01]);
      const snapshot = {
        click: count("click"),
        dblclick: count("dblclick"),
        remove: count("remove"),
        zoomEnabled: map.doubleClickZoom.isEnabled(),
        overlay: map.getSource("honua-measurement") !== undefined,
      };
      window.__HONUA_MEASUREMENT_REF__ = new WeakRef(element);
      element.remove();
      return snapshot;
    });
    expect(during.click).toBe(before.click + 1);
    expect(during.dblclick).toBe(before.dblclick + 1);
    expect(during.remove).toBe(before.remove + 1);
    expect(during.zoomEnabled).toBe(false);
    expect(during.overlay).toBe(true);

    const after = await page.evaluate(() => {
      const map = document.querySelector("honua-map").map;
      const count = (type) => map._listeners?.[type]?.length ?? 0;
      return {
        click: count("click"),
        dblclick: count("dblclick"),
        remove: count("remove"),
        zoomEnabled: map.doubleClickZoom.isEnabled(),
        overlay: map.getSource("honua-measurement") !== undefined,
      };
    });
    // The page's own <honua-measurement> is idle, so it holds no listeners either way.
    expect(after).toEqual({ ...before, zoomEnabled: true, overlay: false });

    await client.send("HeapProfiler.enable");
    let collected = false;
    for (let attempt = 0; attempt < 20 && !collected; attempt += 1) {
      await client.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(100);
      collected = await page.evaluate(() => window.__HONUA_MEASUREMENT_REF__?.deref() === undefined);
    }
    expect(collected).toBe(true);
  } finally {
    await client.detach();
    await server.close();
  }
});
