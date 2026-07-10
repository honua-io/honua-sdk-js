import { expect, test } from "@playwright/test";

import { startQuickstartFixtureServer } from "../../examples/maplibre-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("flagship workflow is transparent, linked, accessible, responsive, and disposable", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const fixtureServer = await startQuickstartFixtureServer();

  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(fixtureServer.url);

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true))
      .toBe(true);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("every decision in the open");
    await expect(page.locator("#mode-badge")).toHaveText("Fixture replay");
    await expect(page.locator("#mode-badge")).toHaveAttribute("data-mode", "fixture");
    for (const stage of ["connect", "discover", "explain", "query", "mount"]) {
      await expect(page.locator(`#journey-${stage}`)).toHaveAttribute("data-state", "complete");
      await expect(page.locator(`#journey-${stage} small`)).not.toHaveText("Waiting");
    }

    await expect(page.locator("#status-compatibility")).toHaveText(/Compatible/);
    await expect(page.locator("#status-feature-count")).toHaveText("3 renderable of 3");
    await expect(page.locator("#status-geometry-types")).toHaveText("polygon");
    await expect(page.locator("#evidence-auth")).toHaveText("none");
    await expect(page.locator("#evidence-freshness")).toContainText("snapshot captured");
    await expect(page.locator("#evidence-data-version")).toContainText("honolulu-operations-v1");
    await expect(page.locator("#evidence-degradation")).toContainText("exact remote pushdown");
    await expect(page.locator("#capability-list")).toContainText("query");
    await expect(page.locator("#plan-pushdown")).toHaveText("full");
    await expect(page.locator("#plan-fidelity")).toHaveText("exact");
    await expect(page.locator("#plan-steps")).toContainText("remote / query");
    await expect(page.locator("#plan-json")).toContainText('"fingerprint"');

    const runtime = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    expect(runtime?.layerIds).toContain("quickstart-fill");
    expect(runtime?.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runtime?.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);

    await expect(page.locator("#linked-visible-count")).toHaveText("3");
    await page.locator("#attribute-filter").selectOption({ label: "STATUS: Ready" });
    await expect(page.locator("#linked-visible-count")).toHaveText("1");
    await expect(page.locator("#map-visible-count")).toHaveText("1 visible");
    await expect(page.locator("#feature-list")).toContainText("Kakaako utility corridor");
    await expect(page.locator("#feature-list")).not.toContainText("Harbor response district");
    await expect(page.locator("#linked-query-projection")).toContainText('"STATUS"');
    await page.locator("#clear-filter-button").click();
    await expect(page.locator("#linked-visible-count")).toHaveText("3");

    const inspect = page.getByRole("button", { name: "Inspect Harbor response district" });
    await inspect.focus();
    await expect(inspect).toBeFocused();
    await inspect.press("Enter");
    await expect(page.locator("#selected-feature-title")).toHaveText("Harbor response district");
    await expect(page.locator(".maplibregl-popup")).toContainText("Harbor response district");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId))
      .toBe("2");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("application", { name: "Interactive map of queried features" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Linked table" })).toBeVisible();
    expect(
      await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth })),
    ).toEqual({ documentWidth: 390, viewportWidth: 390 });

    await page.evaluate(() => window.__HONUA_QUICKSTART_DISPOSE__?.());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.disposed)).toBe(true);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
