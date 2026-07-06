import { expect, test } from "@playwright/test";

import { startPmtilesStaticFixtureServer } from "../../examples/pmtiles-static/mock-server.mjs";

test.setTimeout(90_000);

test("PMTiles Static Quickstart renders a PMTiles source with no server and no manual addProtocol", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startPmtilesStaticFixtureServer();
  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PMTILES_STATIC_DEMO__?.ready === true), { timeout: 30_000 })
      .toBe(true);

    // Protocol auto-registered by the runtime (no manual addProtocol call).
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PMTILES_STATIC_DEMO__?.protocolRegistered === true))
      .toBe(true);
    await expect(page.locator("#protocol-state")).toContainText("registered");

    // The PMTiles source is present on the map.
    expect(await page.evaluate(() => window.__HONUA_PMTILES_STATIC_DEMO__?.hasSource === true)).toBe(true);
    await expect(page.locator("#source-state")).toContainText("basemap ready");

    // describe() surfaced archive metadata.
    const archive = await page.evaluate(() => window.__HONUA_PMTILES_STATIC_DEMO__?.archive ?? null);
    expect(archive).not.toBeNull();
    expect(archive.tileKind).toBe("png");
    expect(archive.minZoom).toBe(0);
    expect(archive.maxZoom).toBe(5);
    expect(archive.bounds).toEqual([-123.2, 37, -121.5, 38.2]);
    await expect(page.locator("#tilekind-state")).toContainText("PNG");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
