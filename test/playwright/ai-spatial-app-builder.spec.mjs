import { expect, test } from "@playwright/test";

import { startAiSpatialAppBuilderFixtureServer } from "../../examples/ai-spatial-app-builder/mock-server.mjs";

test.setTimeout(90_000);

test("AI Spatial App Builder runs prompt to generated linked mini-app", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startAiSpatialAppBuilderFixtureServer();
  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_AI_SPATIAL_APP_BUILDER__?.ready === true))
      .toBe(true);

    await expect(page.locator("#fixture-state")).toContainText("Fixture safe mode");
    await expect(page.locator("#capability-state")).toContainText("unsupported");

    await page.getByRole("button", { name: "Draft" }).click();
    await expect(page.locator("#clarification")).toContainText("Use FEMA flood zones");
    await page.getByRole("button", { name: "FEMA flood zones" }).click();
    await expect(page.locator("#draft-review")).toContainText("Pre-1970 parcels near fire stations");
    await expect(page.locator("#draft-review")).toContainText("within-distance");

    await page.getByRole("button", { name: "Preview Plan" }).click();
    await expect(page.locator("#plan-preview")).toContainText("Spatial result query is not cached");
    await expect(page.locator("#plan-preview")).toContainText("degraded cloud mode");

    await page.getByRole("button", { name: "Apply Plan" }).click();
    await expect(page.locator("#job-state")).toHaveText("Accepted");
    await page.getByRole("button", { name: "Advance Job" }).click();
    await expect(page.locator("#job-state")).toHaveText("Running");
    await page.getByRole("button", { name: "Advance Job" }).click();
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#generated-app-state")).toHaveText("linked");
    await expect(page.locator("#result-count")).toHaveText("5");
    await expect(page.locator("#result-table")).toContainText("Kalihi warehouse parcel");

    await page.getByRole("button", { name: /X 2/ }).click();
    await expect(page.locator("#result-count")).toHaveText("2");
    await page.getByRole("button", { name: /Open Airport logistics parcel/ }).click();
    await expect(page.locator("#feature-detail")).toContainText("Airport logistics parcel");
    await expect(page.locator("#workspace-export")).toContainText("honua.saved-workspace");
    await expect(page.locator("#workspace-export")).toContainText("linkedViewSync");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
