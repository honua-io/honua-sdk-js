import { expect, test } from "@playwright/test";

import { startRuntimeParityShowcaseFixtureServer } from "../../examples/runtime-parity-showcase/mock-server.mjs";

test.setTimeout(90_000);

test("runtime parity showcase loads package, surface, widgets, selection, and layer state", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startRuntimeParityShowcaseFixtureServer();
  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_RUNTIME_PARITY_SHOWCASE__?.ready === true))
      .toBe(true);

    await expect(page.locator("#package-status")).toHaveText("Loaded");
    await expect(page.locator("#map-status")).toHaveText("Ready");
    await expect(page.locator("honua-layer-list").getByText("Incident points")).toBeVisible();
    await expect(page.locator("honua-feature-table").getByText("Harbor fuel sheen")).toBeVisible();
    await expect(page.locator("#widget-count")).toHaveText("6");

    const firstRefreshCount = Number(await page.locator("#widget-refresh-count").textContent());
    await page.getByRole("button", { name: "Refresh widgets" }).click();
    await expect
      .poll(async () => Number(await page.locator("#widget-refresh-count").textContent()))
      .toBeGreaterThan(firstRefreshCount);
    await expect(page.locator("#event-log")).toContainText("widget:manual");

    await page.locator("#status-filter").selectOption("Open");
    await expect(page.locator("#widget-count")).toHaveText("3");
    await expect(page.locator("#visible-feature-count")).toHaveText("3");
    await expect(page.locator("honua-feature-table").getByText("Airport logistics delay")).toHaveCount(0);

    await page.getByRole("button", { name: "Kakaako utility corridor" }).click();
    await expect(page.locator("#selected-title")).toHaveText("Kakaako utility corridor");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_RUNTIME_PARITY_SHOWCASE__?.selectedFeatureId))
      .toBe("inc-103");

    await page.getByLabel("Incident points").uncheck();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_RUNTIME_PARITY_SHOWCASE__?.layerVisible("incident-points")))
      .toBe(false);
    await expect(page.locator("#event-log")).toHaveText("layer:incident-points:false");

    await page.getByRole("button", { name: "Fit Downtown" }).click();
    await expect(page.locator("#share-state")).toHaveValue(/viewport=/);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_RUNTIME_PARITY_SHOWCASE__?.shareState().includes("sel=")))
      .toBe(true);

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
