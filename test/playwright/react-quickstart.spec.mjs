import { expect, test } from "@playwright/test";

import { startReactQuickstartFixtureServer } from "../../examples/react-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("react quickstart renders provider-driven data and the honua map", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startReactQuickstartFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    // The HonuaMap runtime is ready (proves the map component owns its lifecycle
    // under React StrictMode without leaking / erroring).
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_REACT_QUICKSTART__?.mapReady === true))
      .toBe(true);

    // useQuery resolved fixture-backed features through the provider.
    await expect(page.getByTestId("query-state")).toHaveText("success");
    await expect(page.getByTestId("feature-count")).toHaveText("3");
    await expect(page.getByTestId("feature-list").locator("li")).toHaveCount(3);

    // The MapLibre canvas mounted inside HonuaMap.
    await expect(page.locator(".map-canvas canvas")).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
