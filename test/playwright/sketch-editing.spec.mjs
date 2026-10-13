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

test("feature editor synchronizes real pointer gestures, single undo and successive update drafts", async ({ page }) => {
  const { startEditorSketchFixture } = await import("./editor-sketch-fixture.mjs");
  const server = await startEditorSketchFixture();
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  try {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(server.url);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    const editor = page.locator("honua-feature-editor");
    const geometry = editor.locator("[data-geometry-json]");
    const observed = () => page.evaluate(() => window.editorSketchObservation());
    await editor.locator('[data-operation="create"]').click();
    await editor.locator('[data-sketch-tool="point"]').click();
    await page.mouse.click(350, 350);
    await expect(geometry).toHaveValue(/"Point"/);
    expect(JSON.parse(await geometry.inputValue())).toEqual({ type: "Point", coordinates: [0, 0] });
    expect((await observed()).snapshot.dirty).toBe(true);
    expect((await observed()).calls).toBe(0);
    await editor.locator('[data-action="undo"]').click();
    await expect(geometry).not.toHaveValue(/"Point"/);
    await expect(editor.locator('[data-action="undo"]')).toBeDisabled();
    await editor.locator('[data-action="redo"]').click();
    await expect(geometry).toHaveValue(/"Point"/);
    await expect(editor.locator('[data-action="redo"]')).toBeDisabled();
    await editor.locator('[data-action="submit"]').click();
    await expect.poll(async () => (await observed()).calls).toBe(1);
    await editor.locator('[data-operation="update"]').click();
    await expect(geometry).toHaveValue(/"Point"/);
    await page.mouse.click(350, 350);
    await page.mouse.move(350, 350);
    await page.mouse.down();
    await page.mouse.move(400, 310, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => JSON.parse(await geometry.inputValue()).coordinates[0]).toBeGreaterThan(0);
    const reshaped = JSON.parse(await geometry.inputValue());
    expect(reshaped.coordinates[1]).toBeGreaterThan(0);
    expect((await observed()).calls).toBe(1);
    await editor.locator('[data-action="undo"]').click();
    expect(JSON.parse(await geometry.inputValue())).toEqual({ type: "Point", coordinates: [0, 0] });
    await expect(editor.locator('[data-action="undo"]')).toBeDisabled();
    await editor.locator('[data-action="redo"]').click();
    expect(JSON.parse(await geometry.inputValue())).toEqual(reshaped);
    await editor.locator('[data-action="cancel"]').click();
    await page.mouse.click(450, 450);
    expect((await observed()).calls).toBe(1);
    expect((await observed()).snapshot.form).toBeUndefined();
    await editor.locator('[data-operation="create"]').click();
    await editor.locator('[data-sketch-tool="point"]').click();
    await page.mouse.click(300, 300);
    await expect(geometry).toHaveValue(/"Point"/);
    expect(JSON.parse(await geometry.inputValue()).coordinates[0]).toBeLessThan(0);
    expect((await observed()).calls).toBe(1);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
