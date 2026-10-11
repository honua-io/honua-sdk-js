import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function showAttribution(page) {
  const credits = page.locator(".maplibregl-ctrl-attrib-inner");
  if (!(await credits.isVisible())) await page.locator(".maplibregl-ctrl-attrib-button").click();
  await expect(credits).toBeVisible();
  return credits;
}

test("basemap themes preserve live map state and attribution with offline fixture assets", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const externalRequests = [];
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  try {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.goto(`${origin}/test/fixtures/online-basemap/index.html`);
    await expect(page.locator("#status")).toHaveText("ready");
    await showAttribution(page);
    await expect(page.locator(".maplibregl-ctrl-attrib-inner")).toContainText("Basemap fixture © Example contributors");
    await expect(page.locator(".maplibregl-ctrl-attrib-inner")).toContainText("Operational fixture contributor");
    const credits = await page.locator(".maplibregl-ctrl-attrib-inner").boundingBox();
    expect(credits).not.toBeNull();
    expect(credits.x).toBeGreaterThanOrEqual(0);
    expect(credits.x + credits.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("light-mobile-with-credits.png") });
    expect(await page.evaluate(() => window.__HONUA_BASEMAP_FIXTURE__.activate("dark"))).toBe(true);
    await expect(page.locator("#status")).toHaveText("ready");
    expect(await page.evaluate(() => {
      const { map, popup, operationalSource } = window.__HONUA_BASEMAP_FIXTURE__;
      return {
        sameSource: map.getSource("operational") === operationalSource,
        selection: map.getFeatureState({ source: "operational", id: 1 }),
        filter: map.getFilter("operational"), popupOpen: popup.isOpen(), zoom: map.getZoom(),
      };
    })).toEqual({ sameSource: true, selection: { selected: true }, filter: ["==", ["get", "priority"], "high"], popupOpen: true, zoom: 3 });
    await expect(page.locator(".maplibregl-ctrl-attrib-inner")).toContainText("Basemap fixture © Example contributors");
    await showAttribution(page);
    await page.screenshot({ path: testInfo.outputPath("dark-mobile-with-credits.png") });
    expect(await page.evaluate(() => window.__HONUA_BASEMAP_FIXTURE__.activate("missing"))).toBe(false);
    await expect(page.locator("#status")).toContainText("Operational data and controls remain available");
    expect(await page.evaluate(() => window.__HONUA_BASEMAP_FIXTURE__.map.getSource("operational") !== undefined)).toBe(true);
    await expect(page.locator(".maplibregl-popup-content")).toContainText("Selected operational feature");
    expect(externalRequests).toEqual([]);
    await showAttribution(page);
    await page.screenshot({ path: testInfo.outputPath("unavailable-basemap-with-operational-data.png") });
  } finally {
    await server.close();
  }
});

// Provider availability is dated evidence, never a deterministic PR gate.
test("bounded OpenFreeMap online availability smoke", async ({ page }, testInfo) => {
  test.skip(process.env.HONUA_BASEMAP_LIVE_ENABLED !== "true", "Opt in to the mutable public provider lane");
  test.setTimeout(120_000);
  const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  const receipt = { observedAt: new Date().toISOString(), provider: "OpenFreeMap", immutableSnapshot: false, themes: [], failures: [] };
  page.on("requestfailed", (request) => receipt.failures.push({ url: request.url(), failure: request.failure()?.errorText }));
  try {
    await page.setViewportSize({ width: 390, height: 300 });
    await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/online-basemap/index.html`);
    await expect(page.locator("#status")).toHaveText("ready");
    await page.evaluate(() => window.__HONUA_BASEMAP_FIXTURE__.map.setZoom(1));
    for (const theme of ["positron", "liberty", "dark"]) {
      const applied = await page.evaluate((theme) => window.__HONUA_BASEMAP_FIXTURE__.binding.activate({ theme }), theme);
      receipt.themes.push({ theme, applied });
      expect(applied).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const { map } = window.__HONUA_BASEMAP_FIXTURE__;
        return map.areTilesLoaded() && map.queryRenderedFeatures().some((feature) => feature.source.startsWith("honua-online-basemap-"));
      })).toBe(true);
      await expect(page.locator("#status")).toHaveText("ready");
      await showAttribution(page);
      await expect(page.locator(".maplibregl-ctrl-attrib-inner")).toContainText("OpenStreetMap");
      await page.screenshot({ path: testInfo.outputPath(`online-${theme}-with-credits.png`) });
    }
  } finally {
    await testInfo.attach("dated-provider-availability.json", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
    await server.close();
  }
});
