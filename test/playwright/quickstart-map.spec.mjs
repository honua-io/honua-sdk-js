import { expect, test } from "@playwright/test";

import {
  FIRST_MAP_FIXTURE_METADATA,
  startQuickstartFixtureServer,
} from "../../examples/maplibre-quickstart/mock-server.mjs";
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
    if (message.type() === "error") {
      const sourceUrl = message.location().url;
      consoleErrors.push(sourceUrl ? `${message.text()} (${sourceUrl})` : message.text());
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === fixtureOrigin && response.status() >= 400) {
      failedRequiredRequests.push(`${response.status()} ${url.pathname}`);
    }
  });

  const fixtureServer = await startQuickstartFixtureServer();
  const fixtureOrigin = new URL(fixtureServer.url).origin;
  const publishedAppPath = "/sdk/maplibre-quickstart/app";
  const publishedAppUrl = `${fixtureOrigin}${publishedAppPath}/`;
  let fixtureClosed = false;
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (/^https?:$/.test(requestUrl.protocol) && requestUrl.origin !== fixtureOrigin) {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    if (
      requestUrl.origin === fixtureOrigin &&
      (requestUrl.pathname === publishedAppPath || requestUrl.pathname.startsWith(`${publishedAppPath}/`))
    ) {
      const fixtureUrl = new URL(requestUrl);
      fixtureUrl.pathname = requestUrl.pathname.slice(publishedAppPath.length) || "/";
      await route.continue({ url: fixtureUrl.href });
      return;
    }
    await route.continue();
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    const navigation = await page.goto(publishedAppUrl);
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
    await expect(page.locator("#status-feature-count")).toHaveText("48 accepted");
    await expect(page.locator("#status-geometry-types")).toHaveText("polygon");
    await expect(page.locator("#evidence-auth")).toHaveText("anonymous public");
    await expect(page.locator("#evidence-freshness")).toContainText("SDK observation available");
    await expect(page.locator("#evidence-data-version")).toContainText("48 accepted feature(s)");
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
    expect(runtime?.sourceAttribution).toBe("Source: U.S. Census Bureau, 2025 TIGER/Line Shapefiles.");
    expect(runtime?.cacheStatus).toMatch(/^(bypass|hit|miss|refreshed)$/);

    await expect(page.getByTestId("first-map-result-legend")).toContainText("48 mapped features");
    await expect(page.locator("#result-provenance")).toHaveText(
      `${publishedAppUrl}rest/services/natural-earth/FeatureServer/0`,
    );
    await expect(page.locator("#selected-feature-title")).toHaveText("Census Tract 301");
    await expect(page.locator("#selected-feature-subtitle")).toHaveText("GEOID 15009030100");
    await expect(page.locator(`[data-feature-id="${FIRST_MAP_FIXTURE_METADATA.selectedRecordId}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

    const clickedFeature = await page.evaluate(() => {
      const map = window.__HONUA_QUICKSTART_MAP__;
      const layers = window.__HONUA_QUICKSTART_RUNTIME__?.layerIds;
      if (!map || !layers?.length) throw new Error("First Map click regression requires the mounted map layers.");
      const rect = map.getCanvas().getBoundingClientRect();
      for (let y = 12; y < rect.height - 12; y += 8) {
        for (let x = 12; x < rect.width - 12; x += 8) {
          const target = document.elementFromPoint(rect.left + x, rect.top + y);
          if (!(target instanceof Element) || !target.closest("#map")) continue;
          const [feature] = map.queryRenderedFeatures([x, y], { layers });
          if (!feature) continue;
          const lngLat = map.unproject([x, y]);
          return {
            clientX: rect.left + x,
            clientY: rect.top + y,
            lng: lngLat.lng,
            lat: lngLat.lat,
            featureId: String(feature.id ?? feature.properties?.OBJECTID ?? ""),
          };
        }
      }
      throw new Error("No unobscured rendered First Map feature was available for the click regression.");
    });
    await page.mouse.click(clickedFeature.clientX, clickedFeature.clientY);
    await expect(page.locator(".maplibregl-popup")).toBeVisible();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId)).toBe(
      clickedFeature.featureId,
    );
    const clickAnchorDistance = await page.evaluate(({ clientX, clientY, lng, lat }) => {
      const map = window.__HONUA_QUICKSTART_MAP__;
      const tip = document.querySelector(".maplibregl-popup-tip");
      if (!map || !(tip instanceof HTMLElement)) throw new Error("First Map popup tip was not rendered.");
      const projected = map.project([lng, lat]);
      const canvas = map.getCanvas().getBoundingClientRect();
      if (Math.hypot(canvas.left + projected.x - clientX, canvas.top + projected.y - clientY) > 1) {
        throw new Error("Map click coordinate no longer projects to the captured event point.");
      }
      const rect = tip.getBoundingClientRect();
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      return Math.hypot(dx, dy);
    }, clickedFeature);
    expect(clickAnchorDistance).toBeLessThanOrEqual(8);

    await expect(page.locator("#linked-visible-count")).toHaveText("48");
    await expect(page.locator("#attribute-filter optgroup")).toHaveCount(1);
    await expect(page.locator("#attribute-filter optgroup")).toHaveAttribute("label", "Census tract");
    await page.locator("#attribute-filter").selectOption({ label: "Census Tract 302.01" });
    await expect(page.locator("#linked-visible-count")).toHaveText("1");
    await expect(page.locator("#map-visible-count")).toHaveText("1 visible");
    await expect(page.locator("#feature-list")).toContainText("Census Tract 302.01");
    await expect(page.locator("#feature-list")).not.toContainText("Census Tract 301");
    await expect(page.locator("#linked-query-projection")).toContainText('"scope": "mounted bounded result"');
    await expect(page.locator("#linked-query-projection")).toContainText('"field": "NAMELSAD"');
    const filterTiming = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    expect(filterTiming?.interactionBudgetMet).toBe(true);
    expect(filterTiming?.interactionDurationMs).toBeLessThanOrEqual(100);
    await page.locator("#clear-filter-button").click();
    await expect(page.locator("#linked-visible-count")).toHaveText("48");

    const inspect = page.getByRole("button", { name: "Inspect Census Tract 302.01" });
    await inspect.focus();
    await expect(inspect).toBeFocused();
    await inspect.press("Enter");
    await expect(page.locator("#selected-feature-title")).toHaveText("Census Tract 302.01");
    await expect(page.locator("#result-interaction")).toHaveText("Selected Census Tract 302.01");
    await expect(inspect).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".maplibregl-popup")).toContainText("Census Tract 302.01");
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

    await expect(page.locator("#endpoint-url")).toHaveValue(
      `${publishedAppUrl}rest/services/natural-earth/FeatureServer/0/`,
    );
    await page.locator("#endpoint-protocol").selectOption("ogc-features");
    await expect(page.locator("#endpoint-url")).toHaveValue(
      `${publishedAppUrl}ogc/features/collections/maui-census-tracts-2025`,
    );
    await page.locator("#load-endpoint-button").click();
    await expect(page.locator("#evidence-source")).toHaveText(/ogc-features.*maui-census-tracts-2025/);
    await expect(page.locator("#map-overlay")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#status-feature-count")).toHaveText("48 accepted");
    await expect(page.locator("#workflow-code")).toContainText('"protocol": "ogc-features"');

    await page.locator("#endpoint-protocol").selectOption("geoservices-feature-service");
    await expect(page.locator("#endpoint-url")).toHaveValue(
      `${publishedAppUrl}rest/services/natural-earth/FeatureServer/0`,
    );
    await page.locator("#load-endpoint-button").click();
    await expect(page.locator("#evidence-source")).toHaveText(/geoservices-feature-service.*0/);
    await expect(page.locator("#map-overlay")).toHaveAttribute("data-state", "ready");

    const customEndpoint = `${publishedAppUrl}custom/FeatureServer/0`;
    await page.locator("#endpoint-url").fill(customEndpoint);
    await page.locator("#endpoint-protocol").selectOption("ogc-features");
    await expect(page.locator("#endpoint-url")).toHaveValue(customEndpoint);

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
