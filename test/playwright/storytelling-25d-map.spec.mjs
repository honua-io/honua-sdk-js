import { expect, test } from "@playwright/test";

import { startStory25dFixtureServer } from "../../examples/storytelling-25d-map/mock-server.mjs";

test.setTimeout(90_000);

test("2.5D storytelling demo loads, pitches, extrudes, and replays the route", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startStory25dFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_25D_RUNTIME__?.mapReady === true))
      .toBe(true);

    const initialPitch = await page.evaluate(() => window.__HONUA_25D_RUNTIME__?.pitch ?? 0);
    expect(initialPitch).toBeGreaterThan(10);

    const layerIds = await page.evaluate(() => window.__HONUA_25D_RUNTIME__?.layerIds ?? []);
    expect(layerIds).toContain("story-assets-extrusion");

    await expect(page.locator("#story-step-title")).toHaveText(/Pitched corridor overview/);

    await page.locator('[data-testid="story-step-route-replay"]').click();
    await expect(page.locator("#story-step-title")).toHaveText(/Replay the inspection route/);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_25D_RUNTIME__?.currentStepId))
      .toBe("route-replay");
    await expect
      .poll(async () =>
        page.evaluate(() => (window.__HONUA_25D_EVENTS__ ?? []).some((event) => event.type === "route-playback-started")),
      )
      .toBe(true);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_25D_RUNTIME__?.routeProgress ?? 0))
      .toBeGreaterThan(0.05);

    await page.locator('[data-testid="story-step-asset-focus"]').click();
    await expect(page.locator("#story-step-title")).toHaveText(/Close on the highest-risk asset/);
    await expect(page.locator("#story-step-body")).toContainText("2.5D");
    await expect(page.locator("#selection-title")).toHaveText("Harbor substation");

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
