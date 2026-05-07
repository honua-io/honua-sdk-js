import { expect, test } from "@playwright/test";

import { startEditWorkflowFixtureServer } from "../../examples/edit-workflow-demo/mock-server.mjs";

test.setTimeout(90_000);

test("edit workflow demo coordinates map, table, forms, attachments, rollback, and capability states", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startEditWorkflowFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_EDIT_WORKFLOW_DEMO__?.ready === true)).toBe(true);

    await expect(page.locator("#cache-state")).toContainText("ready");
    await expect(page.locator("#capability-summary")).toContainText("applyEdits supported");
    await expect(page.locator("#visible-count")).toHaveText("1");
    await expect(page.locator("#feature-table")).toContainText("Pier 2 pump station");

    await page.locator("#feature-table").getByRole("button", { name: /Open Pier 2 pump station/ }).click();
    await expect(page.locator("#feature-detail")).toContainText("PUMP-HBR-02");

    await page.locator("#field-status").selectOption("closed");
    await page.locator("#field-inspection_score").fill("88");
    await page.getByRole("button", { name: "Add Photo" }).click();
    await page.getByRole("button", { name: "Delete File" }).click();
    await expect(page.locator("#pending-count")).toHaveText("2");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#submit-status")).toHaveText("Succeeded");
    await expect(page.locator("#feature-table")).toContainText("Closed");
    await expect(page.locator("#attachment-list")).toContainText("after-action.png");
    await expect(page.locator("#pending-count")).toHaveText("0");

    await page.getByRole("button", { name: "Force Conflict" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#submit-status")).toHaveText("Failed");
    await expect(page.locator("#rollback-state")).toHaveText("Rolled back");
    await expect(page.locator("#failure-list")).toContainText("conflict");

    await page.getByRole("button", { name: "Add Oversize" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#submit-status")).toHaveText("Partial");
    await expect(page.locator("#failure-list")).toContainText("attachment exceeds source upload limit");

    await page.getByRole("button", { name: "New" }).click();
    await page.locator("#field-asset_name").fill("Ala Moana temporary generator");
    await page.locator("#field-priority").selectOption("high");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#submit-status")).toHaveText("Succeeded");
    await expect(page.locator("#feature-table")).toContainText("Ala Moana temporary generator");

    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.locator("#workspace-export")).toContainText("honua.saved-workspace");
    await expect(page.locator("#workspace-export")).toContainText("edit-workflow");

    await page.getByRole("button", { name: "Read-only Check" }).click();
    await expect(page.locator("#submit-status")).toHaveText("Unsupported");
    await expect(page.locator("#source-readiness")).toContainText("field-inspections-readonly");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
