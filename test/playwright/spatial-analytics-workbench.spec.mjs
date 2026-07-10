import { expect, test } from "@playwright/test";

import { startSpatialAnalyticsWorkbenchFixtureServer } from "../../examples/spatial-analytics-workbench/mock-server.mjs";

test.setTimeout(90_000);

test("one accepted plan drives linked map, table, chart, evidence, and output", async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);

    await expect(page.locator("#data-mode")).toHaveText("Fixture replay");
    await expect(page.locator("#plan-state")).toHaveText("Estimate");
    await expect(page.locator("#execution-truth")).toContainText("No result rows were read");
    await expect(page.locator("#plan-steps")).toContainText("remote · queryAggregate");
    await expect(page.locator("#plan-json")).toContainText("geoservices-rest-query-v1");
    await expect(page.locator("#result-count")).toHaveText("0");

    await page.getByRole("button", { name: "Accept plan" }).click();
    await expect(page.locator("#plan-state")).toHaveText("Accepted");
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.locator("#evidence-state")).toHaveText("Fixture Replay");
    await expect(page.locator("#execution-truth")).toContainText("committed response fixture");
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-count")).toHaveText("3");
    await expect(page.locator("#result-table")).toContainText("Iwilei electrical substation");
    await expect(page.locator("#risk-chart")).toContainText("Critical");
    await expect(page.locator("#artifact-json")).toContainText("honua.linked-analysis-output.v1");
    await expect(page.locator("#lineage")).toContainText("plan:sha256:");

    await page.locator('#risk-chart button[data-risk="high"]').click();
    await expect(page.locator("#plan-state")).toHaveText("Estimate");
    await expect(page.locator("#risk-filter")).toHaveValue("high");
    await expect(page.locator('#risk-chart button[data-risk="high"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#result-count")).toHaveText("0");
    await expect(page.locator("#materialized-layer")).toHaveText("none");
    await expect(page.locator("#result-table")).not.toContainText("Kakaako mixed-use parcel cluster");
    await page.getByRole("button", { name: "Accept plan" }).click();
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.locator("#result-count")).toHaveText("1");
    await expect(page.locator("#result-table")).toContainText("Kakaako mixed-use parcel cluster");
    await page.getByRole("button", { name: "Open Kakaako mixed-use parcel cluster" }).last().click();
    await expect(page.locator("#feature-detail")).toContainText("Kakaako mixed-use parcel cluster");
    await expect(page.locator('#result-table button[aria-pressed="true"]')).toHaveText(
      "Open Kakaako mixed-use parcel cluster",
    );
    await expect(page.locator('.map-marker[aria-pressed="true"]')).toHaveAttribute(
      "aria-label",
      "Open Kakaako mixed-use parcel cluster",
    );
    await page.locator("#risk-filter").selectOption("critical");
    await expect(page.locator("#feature-detail")).toContainText("No selected result");
    await expect(page.locator("#result-count")).toHaveText("0");
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const exported = window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.exportWorkspace();
          return exported ? JSON.parse(exported).selectedFeatures.length : -1;
        }),
      )
      .toBe(0);
    await page.locator("#risk-filter").selectOption("high");

    await page.locator("#execution-lane").selectOption("bounded-local");
    await expect(page.locator("#plan-steps")).toContainText("remote · queryAll");
    await expect(page.locator("#plan-steps")).toContainText("client · aggregate");
    await page.getByRole("button", { name: "Accept plan" }).click();
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.locator("#evidence-state")).toHaveText("Executed Local");
    await expect(page.locator("#execution-truth")).toContainText("row and byte ceilings");

    await page.locator("#execution-lane").selectOption("unsafe-rejected");
    await expect(page.locator("#plan-state")).toHaveText("Rejected");
    await expect(page.locator("#plan-steps")).toContainText("unsafe-materialization");
    await expect(page.getByRole("button", { name: "Accept plan" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Execute accepted plan" })).toBeDisabled();

    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.locator("#workspace-export")).toContainText("honua.saved-workspace");
    await expect(page.locator("#workspace-export")).not.toContainText("executionPlanFingerprint");
    expect(JSON.parse((await page.locator("#workspace-export").textContent()) ?? "{}").analysisOutputs).toEqual([]);

    await testInfo.attach("linked-analysis-workbench", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const stateBeforeDispose = await page.locator("#plan-state").textContent();
    await page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.dispose());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.disposed)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Explain" }).click();
    await expect(page.locator("#plan-state")).toHaveText(stateBeforeDispose ?? "");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.explain()))
      .toBe("disposed");
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("live OGC mode is a structured compiler skip, never simulated execution", async ({ page }) => {
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(`${server.url}/?mode=live&protocol=ogc-features&baseUrl=https://example.test/ogc&serviceId=incidents&layerId=0`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);
    await expect(page.locator("#data-mode")).toHaveText("Configured live");
    await expect(page.locator("#plan-state")).toHaveText("Skipped");
    await expect(page.locator("#execution-truth")).toContainText("#389 follow-on");
    await expect(page.locator("#evidence-provenance")).toContainText("skipped");
    await expect(page.locator("#evidence-provenance")).toContainText("not observed");
    await expect(page.getByRole("button", { name: "Execute accepted plan" })).toBeDisabled();
    await expect(page.locator("#result-count")).toHaveText("0");
  } finally {
    await server.close();
  }
});

test("a failed live execution is visible and retryable without claiming observation", async ({ page }) => {
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  let requestCount = 0;
  await page.route("https://example.test/**", async (route) => {
    requestCount += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
  });
  try {
    await page.goto(
      `${server.url}/?mode=live&baseUrl=https://example.test&serviceId=incidents&layerId=0&sourceVersion=v1&schemaVersion=v1`,
    );
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);
    await expect(page.locator("#evidence-provenance")).toContainText("pending");
    await expect(page.locator("#evidence-provenance")).toContainText("not observed");
    await page.getByRole("button", { name: "Accept plan" }).click();
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.getByRole("alert")).toContainText("Execution failed");
    await expect(page.getByRole("button", { name: "Retry accepted plan" })).toBeEnabled();
    await expect(page.locator("#evidence-provenance")).toContainText("pending");
    await expect(page.locator("#evidence-provenance")).toContainText("not observed");

    await page.getByRole("button", { name: "Retry accepted plan" }).click();
    await expect.poll(() => requestCount).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("alert")).toContainText("Execution failed");
  } finally {
    await server.close();
  }
});

for (const mutation of ["AOI", "risk filter", "execution policy", "new acceptance"]) {
  test(`a deferred ${mutation} change prevents the old accepted plan from committing`, async ({ page }) => {
    const server = await startSpatialAnalyticsWorkbenchFixtureServer();
    let requestCount = 0;
    let releaseRequest = () => {};
    const release = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    await page.route("https://deferred.test/**", async (route) => {
      requestCount += 1;
      await release;
      await route
        .fulfill({ status: 200, contentType: "application/json", body: '{"features":[],"exceededTransferLimit":false}' })
        .catch(() => undefined);
    });
    try {
      await page.goto(
        `${server.url}/?mode=live&baseUrl=https://deferred.test&serviceId=incidents&layerId=0&sourceVersion=v1&schemaVersion=v1`,
      );
      await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);
      await page.getByRole("button", { name: "Accept plan" }).click();
      await page.getByRole("button", { name: "Execute accepted plan" }).click();
      await expect.poll(() => requestCount).toBe(1);

      if (mutation === "AOI") await page.locator("#aoi-select").selectOption("honolulu-harbor");
      if (mutation === "risk filter") await page.locator("#risk-filter").selectOption("high");
      if (mutation === "execution policy") await page.locator("#execution-lane").selectOption("bounded-local");
      if (mutation === "new acceptance") {
        await page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.accept());
      }
      releaseRequest();

      await expect(page.locator("#result-count")).toHaveText("0");
      await expect(page.locator("#materialized-layer")).toHaveText("none");
      await expect(page.locator("#evidence-provenance")).toContainText("pending");
      await expect(page.locator("#evidence-provenance")).toContainText("not observed");
      await expect(page.locator("#evidence-state")).not.toHaveText("Executed Remote");
    } finally {
      releaseRequest();
      await server.close();
    }
  });
}

test("loading the indexed fixture invalidates a deferred live execution and keeps its evidence isolated", async ({ page }) => {
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  let requestCount = 0;
  let releaseRequest = () => {};
  let settleRequest = () => {};
  const release = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const settled = new Promise((resolve) => {
    settleRequest = resolve;
  });
  await page.route("https://fixture-race.test/**", async (route) => {
    requestCount += 1;
    await release;
    await route
      .fulfill({ status: 200, contentType: "application/json", body: '{"features":[],"exceededTransferLimit":false}' })
      .catch(() => undefined);
    settleRequest();
  });
  try {
    await page.goto(
      `${server.url}/?mode=live&baseUrl=https://fixture-race.test&serviceId=incidents&layerId=0&sourceVersion=v1&schemaVersion=v1`,
    );
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);
    await page.getByRole("button", { name: "Accept plan" }).click();
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect.poll(() => requestCount).toBe(1);

    await page.getByRole("button", { name: "Load fixture only" }).click();
    await expect(page.locator("#result-count")).toHaveText("2");
    await expect(page.locator("#materialized-layer")).toContainText("indexed-aggregation");
    await expect(page.locator("#aggregation-widgets")).not.toContainText("No analysis output yet");
    await expect(page.locator("#evidence-state")).toHaveText("Estimate");
    await expect(page.locator("#execution-truth")).toContainText("has not been requested or observed");
    await expect(page.locator("#artifact-json")).toHaveText("No output artifact until an accepted plan executes.");

    releaseRequest();
    await settled;
    await expect(page.locator("#result-count")).toHaveText("2");
    await expect(page.locator("#evidence-state")).toHaveText("Estimate");
    await expect(page.locator("#artifact-json")).toHaveText("No output artifact until an accepted plan executes.");
  } finally {
    releaseRequest();
    await server.close();
  }
});

test("workbench remains keyboard-operable and responsive at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(server.url);
    await page.keyboard.press("Tab");
    await expect(page.locator(".skip-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#workbench-main")).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByLabel("Area of interest")).toBeVisible();
    await expect(page.getByLabel("Execution policy")).toBeVisible();
    await expect(page.getByRole("region", { name: "Schematic AOI map with linked analysis features" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept plan" })).toBeVisible();
  } finally {
    await server.close();
  }
});
