import { expect, test } from "@playwright/test";

import { startQuickstartFixtureServer } from "../../examples/maplibre-quickstart/mock-server.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

test.setTimeout(90_000);

test("First Map proves the bounded public-endpoint journey in source or packed mode", async (
  { browser, browserName },
  testInfo,
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    let clipboardText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => clipboardText,
        writeText: async (value) => {
          clipboardText = String(value);
        },
      },
    });
  });
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const fixtureServer = await startQuickstartFixtureServer();
  const fixtureOrigin = new URL(fixtureServer.url).origin;
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (/^https?:$/.test(requestUrl.protocol) && requestUrl.origin !== fixtureOrigin) externalRequests.push(request.url());
  });

  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const navigation = await page.goto(fixtureServer.url);
    expect(navigation?.headers()["content-security-policy"]).toContain("connect-src 'self'");

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true))
      .toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("every decision in the open");
    await expect(page.locator("#mode-badge")).toHaveText("Fixture replay");
    await expect(page.locator("#mode-badge")).toHaveAttribute("data-mode", "fixture");
    await expect(page.getByTestId("honua-sample-mode")).toHaveText(/source|packed/);
    await expect(page.getByTestId("honua-sample-evidence")).toContainText("Evidence");
    for (const stage of ["connect", "discover", "explain", "query", "mount"]) {
      await expect(page.locator(`#journey-${stage}`)).toHaveAttribute("data-state", "complete");
      await expect(page.locator(`#journey-${stage} small`)).not.toHaveText("Waiting");
    }

    await expect(page.locator("#evidence-protocol")).toHaveText("geoservices-feature-service");
    await expect(page.locator("#evidence-source")).toHaveText("0");
    await expect(page.locator("#evidence-endpoint")).not.toContainText(/token|key|signature/i);
    await expect(page.locator("#capability-list")).toContainText("query");
    await expect(page.locator("#plan-strategy")).toHaveText(/geojson|query-tiles/);
    await expect(page.locator("#copyable-code")).toContainText('from "@honua/sdk-js"');
    await expect(page.locator("#copyable-code")).toContainText("mountSource");

    const runtime = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    expect(runtime?.layerIds?.length).toBeGreaterThan(0);
    expect(runtime?.firstMapDurationMs).toBeGreaterThan(0);
    expect(runtime?.runtimeBudgetMs).toBe(5_000);
    expect(runtime?.withinRuntimeBudget).toBe(true);

    const runtimeReady = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true);
    const sampleReadyDurationMs = await page.evaluate(() => performance.now());
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: "maplibre-quickstart",
      browserName,
      sampleReadyDurationMs,
      runtimeReady,
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#endpoint-form", "#map", "#filter-form", "#copyable-code"],
    });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await expect(page.locator("#linked-visible-count")).toHaveText("3");
    await page.locator("#native-filter").fill("STATUS = 'Ready'");
    await page.locator("#apply-filter").click();
    await expect(page.locator("#linked-visible-count")).toHaveText("1");
    await expect(page.locator("#map-visible-count")).toHaveText("1 visible");
    await expect(page.locator("#copyable-code")).toContainText("STATUS = 'Ready'");
    await page.locator("#copy-code").click();
    await expect(page.locator("#copy-status")).toHaveText("Copied to clipboard.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("mountSource");

    const inspect = page.getByRole("button", { name: "Inspect visible feature" });
    await inspect.focus();
    await expect(inspect).toBeFocused();
    await inspect.press("Enter");
    await expect(page.locator(".maplibregl-popup")).toBeVisible();
    await expect(page.locator(".popup-card")).toBeFocused();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.popupOpen)).toBe(true);

    await page.locator("#clear-filter").click();
    await expect(page.locator("#linked-visible-count")).toHaveText("3");
    await expect(page.locator("#map-filter-count")).toHaveText("No filter");

    await page.locator("#endpoint-url").fill(`${fixtureOrigin}/ogc/features`);
    await page.locator("#protocol-hint").selectOption("ogc-features");
    await page.locator("#build-map").click();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.serviceId))
      .toBe("operations-areas");
    await expect(page.locator("#evidence-protocol")).toHaveText("ogc-features");
    await expect(page.locator("#evidence-source")).toHaveText("operations-areas");
    await expect(page.locator("#mode-badge")).toHaveText("Fixture replay");

    expect(externalRequests).toEqual([]);

    const eventCount = await page.evaluate(() => window.__HONUA_QUICKSTART_EVENTS__?.length ?? 0);
    await page.evaluate(() => window.__HONUA_QUICKSTART_DISPOSE__?.());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.disposed)).toBe(true);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    await page.locator("#endpoint-form").evaluate((form) => form.dispatchEvent(new Event("submit", { cancelable: true })));
    expect(await page.evaluate(() => window.__HONUA_QUICKSTART_EVENTS__?.length ?? 0)).toBe(eventCount);
  } finally {
    try {
      await fixtureServer.close();
      await attestClosedFixture(testInfo, "maplibre-quickstart", "startQuickstartFixtureServer");
    } finally {
      await finalizeSampleConsole({
        testInfo,
        sampleId: "maplibre-quickstart",
        page,
        context,
        pageErrors,
        consoleErrors,
      });
    }
  }
});
