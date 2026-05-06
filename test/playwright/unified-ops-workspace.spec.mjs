import { expect, test } from "@playwright/test";

import { startUnifiedOpsWorkspaceFixtureServer } from "../../examples/unified-ops-workspace/mock-server.mjs";

test.setTimeout(90_000);

test("unified ops workspace preserves linked context across modules, drafts, realtime, and snapshots", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startUnifiedOpsWorkspaceFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect.poll(async () => page.evaluate(() => window.__HONUA_UNIFIED_OPS_RUNTIME__?.ready === true)).toBe(true);

    await expect(page.getByRole("button", { name: "Incident Command" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#visible-count")).toHaveText("4");
    await expect(page.locator("#critical-count")).toHaveText("1");

    await page.locator("#status-filter").selectOption("open");
    await expect(page.locator("#filter-count")).toHaveText("1");
    await expect(page.locator("#visible-count")).toHaveText("2");

    await page.getByRole("button", { name: "Open Harbor fuel sheen" }).first().click();
    await expect(page.locator("#detail-title")).toHaveText("Harbor fuel sheen");

    await page.getByRole("button", { name: "Analysis Review" }).click();
    await expect(page.getByRole("button", { name: "Analysis Review" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#detail-title")).toHaveText("Harbor fuel sheen");
    await expect.poll(async () => page.evaluate(() => window.__HONUA_UNIFIED_OPS_RUNTIME__?.activeModule)).toBe(
      "analysis-review",
    );

    await page.getByRole("button", { name: "Stage AI Action" }).click();
    await expect(page.locator("#draft-count")).toHaveText("1");
    await expect(page.locator("#filter-count")).toHaveText("1");

    await page.getByRole("button", { name: "Apply Draft" }).click();
    await expect(page.locator("#draft-count")).toHaveText("0");
    await expect(page.locator("#filter-count")).toHaveText("2");
    await expect(page.locator("#visible-count")).toHaveText("1");
    await expect(page.locator("#detail-title")).toHaveText("Harbor fuel sheen");

    await page.getByRole("button", { name: "Save Snapshot" }).click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_UNIFIED_OPS_RUNTIME__?.snapshotId)).not.toBeNull();

    await page.locator("#status-filter").selectOption("assigned");
    await expect(page.locator("#visible-count")).toHaveText("0");
    await page.getByRole("button", { name: "Incident Command" }).click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_UNIFIED_OPS_RUNTIME__?.activeModule)).toBe(
      "incident-command",
    );

    await page.evaluate(() => window.__HONUA_UNIFIED_OPS_RUNTIME__?.restoreSnapshot());
    await expect(page.getByRole("button", { name: "Analysis Review" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#filter-count")).toHaveText("2");
    await expect(page.locator("#visible-count")).toHaveText("1");
    await expect(page.locator("#detail-title")).toHaveText("Harbor fuel sheen");

    await page.getByRole("button", { name: "Step Live Event" }).click();
    await expect(page.locator("#last-step")).toHaveText("Escalate outage");
    await expect(page.locator("#visible-count")).toHaveText("2");
    await expect(page.locator("#detail-title")).toHaveText("Harbor fuel sheen");
    await expect.poll(async () => page.evaluate(() => window.__HONUA_UNIFIED_OPS_RUNTIME__?.filterCount)).toBe(2);

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
