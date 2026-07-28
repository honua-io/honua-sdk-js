import { expect, test } from "@playwright/test";

import { startPlanningWorkbenchFixtureServer } from "../../examples/planning-permitting-workbench/mock-server.mjs";

test.setTimeout(90_000);

test("planning workbench links map, query, editing, and print with no JS errors", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startPlanningWorkbenchFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.ready === true))
      .toBe(true);

    await expect(page.getByRole("button", { name: "Review Board" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#parcel-count")).toHaveText("8");

    // Query: filter to a zoning class drives the linked map/table/chart context.
    await page.locator("#zoning-filter").selectOption("B-2");
    await expect(page.locator("#filter-count")).toHaveText("1");
    await expect(page.locator("#parcel-count")).toHaveText("2");

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.locator("#filter-count")).toHaveText("0");
    await expect(page.locator("#parcel-count")).toHaveText("8");

    // Select a parcel; detail panel shows zoning + flood overlay warning.
    await page.getByRole("button", { name: "Open 8 Amala Pl, Kahului" }).first().click();
    await expect(page.locator("#detail-title")).toHaveText("8 Amala Pl, Kahului");
    await expect(page.locator("#flood-warning")).toHaveAttribute("data-active", "true");

    // Sketch + measure + flood check.
    await page.getByRole("button", { name: "Query & Analysis" }).click();
    await page.getByRole("button", { name: "Sketch AOI" }).click();
    await expect(page.locator("#sketch-status")).toHaveText("AOI drawn");
    await page.getByRole("button", { name: "Measure", exact: true }).click();
    await expect(page.locator("#measure-readout")).not.toHaveText("0 m");

    // Print/export manifest.
    await page.getByRole("button", { name: "Generate print manifest" }).click();
    await expect(page.locator("#print-status")).toHaveText("generated");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_PLANNING_WORKBENCH_RUNTIME__?.printId))
      .not.toBeNull();

    // Editing lane against the writable permit layer.
    await page.getByRole("button", { name: "Permit Editing" }).click();
    await expect(page.locator("#permit-count")).toHaveText("4");
    await page.getByRole("button", { name: /B2026-0455/ }).click();
    await page.locator("#edit-status-field").selectOption("approved");
    await page.getByRole("button", { name: "Save permit", exact: true }).click();
    await expect(page.locator("#edit-status-readout")).toHaveText("applied");

    // Conflict path is surfaced, not silently dropped.
    await page.getByRole("button", { name: "Force conflict" }).click();
    await page.getByRole("button", { name: "Save permit", exact: true }).click();
    await expect(page.locator("#edit-status-readout")).toHaveText("failed");

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
