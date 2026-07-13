import { expect, test } from "@playwright/test";

import { startReactQuickstartFixtureServer } from "../../examples/react-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("react quickstart renders external-map interop, bridge layers, and shared selection", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startReactQuickstartFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    // The externally-created maplibre-gl map is live (proves the app-owned map
    // lifecycle survives React StrictMode without leaking / erroring).
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_REACT_QUICKSTART__?.mapReady === true))
      .toBe(true);

    // useQuery resolved fixture-backed features through the provider.
    await expect(page.getByTestId("query-state")).toHaveText("success");
    await expect(page.getByTestId("feature-count")).toHaveText("3");
    await expect(page.getByTestId("feature-list").locator("li")).toHaveCount(3);

    // The MapLibre canvas mounted inside the app-owned container.
    await expect(page.locator(".map-canvas canvas")).toBeVisible();

    // HonuaSourceLayer mounted the queried source through the bridge without
    // reporting an error.
    const bridgeError = await page.evaluate(() => window.__HONUA_REACT_QUICKSTART__?.error ?? null);
    expect(bridgeError).toBeNull();

    // Selection is shared: toggling a sidebar row updates the selection
    // context (and, through the map binding, MapLibre feature-state).
    await expect(page.getByTestId("selection-count")).toHaveText("0 selected");
    await page.getByTestId("feature-list").locator("li button").first().click();
    await expect(page.getByTestId("selection-count")).toContainText("1 selected");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_REACT_QUICKSTART__?.selectedCount))
      .toBe(1);
    await page.getByTestId("selection-clear").click();
    await expect(page.getByTestId("selection-count")).toHaveText("0 selected");

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
