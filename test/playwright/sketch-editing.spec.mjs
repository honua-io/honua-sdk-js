import { expect, test } from "@playwright/test";

import { startSketchEditingFixtureServer } from "../../examples/sketch-editing/mock-server.mjs";

test.setTimeout(120_000);

test("sketch editing demo draws through terra-draw with workflow undo/redo, delete, and applyEdits", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startSketchEditingFixtureServer();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_SKETCH_EDITING_DEMO__?.ready === true), { timeout: 45_000 })
      .toBe(true);

    const snapshot = () => page.evaluate(() => window.__HONUA_SKETCH_EDITING_DEMO__.snapshot());

    // Draw a point through terra-draw's real pointer pipeline.
    await page.locator("#tool-point").click();
    await expect(page.locator("#sketch-status")).toHaveText("sketching");
    const canvas = page.locator("#map canvas.maplibregl-canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect.poll(async () => (await snapshot()).geometryType).toBe("Point");
    expect(await snapshot()).toMatchObject({ undoDepth: 1, redoDepth: 0, dirty: true, drawnFeatureCount: 1 });

    // A second point is another undoable workflow step.
    await canvas.click({ position: { x: box.width / 2 + 90, y: box.height / 2 - 60 } });
    await expect.poll(async () => (await snapshot()).undoDepth).toBe(2);

    // Undo/redo run through the workflow model and mirror back into terra-draw.
    await page.locator("#undo").click();
    await expect.poll(async () => (await snapshot()).undoDepth).toBe(1);
    expect(await snapshot()).toMatchObject({ redoDepth: 1, geometryType: "Point" });
    await page.locator("#redo").click();
    await expect.poll(async () => (await snapshot()).undoDepth).toBe(2);

    // Submit lands in the edit-session applyEdits path against the fixture source.
    await page.locator("#submit-edit").click();
    await expect.poll(async () => (await snapshot()).appliedEditCount).toBe(1);
    await expect(page.locator("#submit-status")).toHaveText("succeeded");
    await expect(page.locator("#operation-log")).toContainText("applyEdits → succeeded");

    // Deleting the tracked feature stages an undoable null geometry.
    await page.locator("#delete-feature").click();
    await expect.poll(async () => (await snapshot()).geometryType).toBe(null);
    await page.locator("#undo").click();
    await expect.poll(async () => (await snapshot()).geometryType).toBe("Point");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
