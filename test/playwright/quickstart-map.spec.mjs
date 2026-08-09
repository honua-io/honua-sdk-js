import { expect, test } from "@playwright/test";

import { startQuickstartFixtureServer } from "../../examples/maplibre-quickstart/mock-server.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

const SAMPLE_ID = "maplibre-quickstart";

test.setTimeout(90_000);

test("First Map proves the canonical fixture journey in source or packed mode", async ({ browser, browserName }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const failedRequiredRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === fixtureOrigin && response.status() >= 400) {
      failedRequiredRequests.push(`${response.status()} ${url.pathname}`);
    }
  });

  const fixtureServer = await startQuickstartFixtureServer();
  const fixtureOrigin = new URL(fixtureServer.url).origin;
  let fixtureClosed = false;
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (/^https?:$/.test(requestUrl.protocol) && requestUrl.origin !== fixtureOrigin) {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    const navigation = await page.goto(fixtureServer.url);
    expect(navigation?.headers()["content-security-policy"]).toContain("connect-src 'self'");
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixtureOrigin });
    }

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true))
      .toBe(true);
    const sampleReadyDurationMs = await page.evaluate(() => performance.now());

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your first map is already working.");
    await expect(page.getByTestId("honua-sample-mode")).toHaveText("Fixture replay");
    await expect(page.getByTestId("honua-sample-mode")).toHaveAttribute("data-mode", "fixture");
    for (const stage of ["connect", "discover", "explain", "query", "mount"]) {
      await expect(page.locator(`#journey-${stage}`)).toHaveAttribute("data-state", "complete");
      await expect(page.locator(`#journey-${stage} small`)).not.toHaveText("Waiting");
    }

    await expect(page.locator("#status-compatibility")).toHaveText(/geoservices-feature-service/);
    await expect(page.locator("#status-feature-count")).toHaveText("3 accepted");
    await expect(page.locator("#status-geometry-types")).toHaveText("polygon");
    await expect(page.locator("#evidence-auth")).toHaveText("anonymous public");
    await expect(page.locator("#evidence-freshness")).toContainText("SDK observation available");
    await expect(page.locator("#evidence-data-version")).toContainText("3 accepted feature(s)");
    await expect(page.locator("#evidence-degradation")).toContainText("exact accepted plan");
    await expect(page.locator("#evidence-timing")).toHaveText(/\d+ ms \/ 10000 ms/);
    await expect(page.locator("#capability-list")).toContainText("query");
    await expect(page.locator("#plan-pushdown")).toHaveText("full");
    await expect(page.locator("#plan-fidelity")).toHaveText("exact");
    await expect(page.locator("#plan-steps")).toContainText("remote / query");
    await expect(page.locator("#plan-json")).toContainText('"fingerprint"');

    const runtime = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    expect(runtime?.layerIds).toContain("first-map-feature-polygon");
    expect(runtime?.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runtime?.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(runtime?.firstMapBudgetMs).toBe(10_000);
    expect(runtime?.firstMapBudgetMet).toBe(true);
    expect(runtime?.authorizationMode).toBe("anonymous");
    expect(runtime?.sourceId).toBe("0");
    expect(runtime?.cacheStatus).toMatch(/^(bypass|hit|miss|refreshed)$/);

    await expect(page.getByTestId("first-map-result-legend")).toContainText("3 mapped features");
    await expect(page.locator("#result-provenance")).toHaveText(
      `${fixtureOrigin}/rest/services/natural-earth/FeatureServer/0`,
    );
    await expect(page.locator("#selected-feature-title")).toHaveText("Civic center service zone");
    await expect(page.locator('[data-feature-id="1"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#map-overlay")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#status-error")).toHaveText("None");
    expect(failedRequiredRequests).toEqual([]);
    const desktopMap = await page.locator("#map").boundingBox();
    expect(desktopMap?.height).toBeGreaterThanOrEqual(500);
    const undersizedAuthoredTargets = await page.evaluate(() =>
      [...document.querySelectorAll("button, input, select, summary")]
        .filter((element) => !element.closest(".maplibregl-control-container"))
        .map((element) => ({ id: element.id, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width < 44 || rect.height < 44)
        .map(({ id, rect }) => ({ id, width: rect.width, height: rect.height })),
    );
    expect(undersizedAuthoredTargets).toEqual([]);

    await expect(page.locator("#linked-visible-count")).toHaveText("3");
    await page.locator("#attribute-filter").selectOption({ label: "STATUS: Ready" });
    await expect(page.locator("#linked-visible-count")).toHaveText("1");
    await expect(page.locator("#map-visible-count")).toHaveText("1 visible");
    await expect(page.locator("#feature-list")).toContainText("Kakaako utility corridor");
    await expect(page.locator("#feature-list")).not.toContainText("Harbor response district");
    await expect(page.locator("#linked-query-projection")).toContainText('"scope": "mounted bounded result"');
    await expect(page.locator("#linked-query-projection")).toContainText('"field": "STATUS"');
    const filterTiming = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    expect(filterTiming?.interactionBudgetMet).toBe(true);
    expect(filterTiming?.interactionDurationMs).toBeLessThanOrEqual(100);
    await page.locator("#clear-filter-button").click();
    await expect(page.locator("#linked-visible-count")).toHaveText("3");

    const inspect = page.getByRole("button", { name: "Inspect Harbor response district" });
    await inspect.focus();
    await expect(inspect).toBeFocused();
    await inspect.press("Enter");
    await expect(page.locator("#selected-feature-title")).toHaveText("Harbor response district");
    await expect(page.locator("#result-interaction")).toHaveText("Selected Harbor response district");
    await expect(inspect).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".maplibregl-popup")).toContainText("Harbor response district");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId))
      .toBe("2");

    await page.locator("#copy-code-button").click();
    const copyStatus = page.locator("#copy-code-status");
    await expect(copyStatus).toHaveText(/Copied workflow call site|Copy unavailable; select the visible code manually/);
    if ((await copyStatus.textContent())?.startsWith("Copy unavailable")) {
      await expect(page.locator("#workflow-code")).toBeFocused();
    }
    await expect(page.locator("#workflow-code")).toContainText("runFirstMapWorkflow");
    await expect(page.locator("#workflow-code")).toContainText('result.state !== "ready"');

    await page.locator("#endpoint-url").fill(`${fixtureOrigin}/ogc/features`);
    await page.locator("#endpoint-protocol").selectOption("ogc-features");
    await page.locator("#load-endpoint-button").click();
    await expect(page.locator("#evidence-source")).toContainText("ogc-features · operations-areas");
    await expect(page.locator("#map-overlay")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#status-feature-count")).toHaveText("3 accepted");
    await expect(page.locator("#workflow-code")).toContainText('"protocol": "ogc-features"');

    const runtimeReady = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true);
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: SAMPLE_ID,
      browserName,
      sampleReadyDurationMs,
      runtimeReady,
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#endpoint-form", "#map", "#feature-list"],
    });

    await expect(page.getByRole("application", { name: "Interactive map of queried features" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Explore the map" })).toBeVisible();
    const mobileMap = await page.locator("#map").boundingBox();
    expect(mobileMap?.height).toBeGreaterThanOrEqual(844 * 0.4);
    expect(await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth })))
      .toEqual({ documentWidth: 390, viewportWidth: 390 });

    await page.evaluate(async () => await window.__HONUA_QUICKSTART_DISPOSE__?.());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.disposed)).toBe(true);
    const cleanup = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    expect(cleanup?.cleanupBudgetMet).toBe(true);
    expect(cleanup?.cleanupDurationMs).toBeLessThanOrEqual(1_000);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    expect(externalRequests).toEqual([]);
    expect(failedRequiredRequests).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.evaluate(async () => await window.__HONUA_QUICKSTART_DISPOSE__?.());
    await fixtureServer.close();
    fixtureClosed = true;
    await attestClosedFixture(testInfo, SAMPLE_ID, "examples/maplibre-quickstart/mock-server.mjs");
    await finalizeSampleConsole({ testInfo, sampleId: SAMPLE_ID, page, context, pageErrors, consoleErrors });
    expect(fixtureClosed).toBe(true);
    expect(externalRequests).toEqual([]);
    expect(failedRequiredRequests).toEqual([]);
  }
});
