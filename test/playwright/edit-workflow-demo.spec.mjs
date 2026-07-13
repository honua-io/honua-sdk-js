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

    // Vertex snapping: a probe near the Pier 2 marker (46, 44) resolves to
    // the exact vertex coordinates within the pixel tolerance.
    const vertexSnap = await page.evaluate(() => window.__HONUA_EDIT_WORKFLOW_DEMO__.snapProbe(47, 45));
    expect(vertexSnap).toEqual({
      snapped: true,
      kind: "vertex",
      sourceId: "inspections",
      featureId: 4101,
      x: 46,
      y: 44,
    });
    await expect(page.locator("#snap-status")).toHaveAttribute("data-snapped", "true");
    await expect(page.locator("#snap-status")).toContainText("vertex → Pier 2 pump station @ 46.0, 44.0");

    // Edge snapping: a probe near the harbor corridor line (y = 78) snaps
    // onto the segment at the pointer's x.
    const edgeSnap = await page.evaluate(() => window.__HONUA_EDIT_WORKFLOW_DEMO__.snapProbe(30, 79));
    expect(edgeSnap).toMatchObject({
      snapped: true,
      kind: "edge",
      sourceId: "corridors",
      featureId: "harbor-corridor",
    });
    expect(edgeSnap.x).toBeCloseTo(30, 6);
    expect(edgeSnap.y).toBeCloseTo(78, 6);
    await expect(page.locator("#snap-status")).toContainText("edge → harbor corridor @ 30.0, 78.0");

    // Far from every snap source the probe reports no target.
    const noSnap = await page.evaluate(() => window.__HONUA_EDIT_WORKFLOW_DEMO__.snapProbe(75, 15));
    expect(noSnap).toEqual({ snapped: false });
    await expect(page.locator("#snap-status")).toHaveAttribute("data-snapped", "false");

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
