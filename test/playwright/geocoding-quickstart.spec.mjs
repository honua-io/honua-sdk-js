import { expect, test } from "@playwright/test";

import { startGeocodingFixtureServer } from "../../examples/geocoding-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("Geocoding Quickstart exercises forward, reverse, suggest, and audit mapping", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startGeocodingFixtureServer();

  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.ready === true)).toBe(true);

    await expect(page.locator("#mode-state")).toHaveText("Fixture safe mode");
    await expect(page.locator("#locator-state")).toHaveText("World");
    await expect(page.locator("#endpoint-state")).toHaveText("/rest/services/World/GeocodeServer");
    await expect(page.locator("#forward-results")).toContainText("Honolulu Hale");
    await expect(page.locator("#audit-table")).toContainText("HonuaGeocodingClient.forwardGeocode");
    await expect(page.locator("#audit-table")).toContainText("HonuaGeocodingClient.reverseGeocode");
    await expect(page.locator("#audit-table")).toContainText("HonuaGeocodingClient.suggest");

    await page.locator("#address-input").fill("Ala");
    await expect(page.locator("#suggestion-list")).toContainText("Ala Moana Center");
    await expect
      .poll(async () =>
        page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.suggestions.some((text) => text.includes("Ala Moana"))),
      )
      .toBe(true);
    await page.getByRole("button", { name: /Ala Moana Center/ }).click();
    await expect(page.locator("#forward-results")).toContainText("Ala Moana Center");
    await expect.poll(async () => page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.forwardCount)).toBe(1);

    await page.locator("#map").click({ position: { x: 420, y: 260 } });
    await expect(page.locator("#reverse-address")).toContainText("Honolulu");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_GEOCODING_DEMO__?.reverseAddress ?? ""))
      .toContain("Honolulu");

    const runtime = await page.evaluate(() => ({
      endpointBase: window.__HONUA_GEOCODING_DEMO__?.endpointBase,
      auditRowCount: window.__HONUA_GEOCODING_DEMO__?.auditRows.length ?? 0,
      lastError: window.__HONUA_GEOCODING_DEMO__?.lastError ?? null,
    }));

    expect(runtime.endpointBase).toBe("/rest/services/World/GeocodeServer");
    expect(runtime.auditRowCount).toBe(3);
    expect(runtime.lastError).toBeNull();
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
