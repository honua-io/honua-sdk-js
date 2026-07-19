import { expect, test } from "@playwright/test";

import { startServiceExplorerFixtureServer } from "../../examples/service-explorer/mock-server.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

test.setTimeout(90_000);

test("service explorer follows inspected truth through a bounded accepted query", async ({ browser, browserName }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const fixtureServer = await startServiceExplorerFixtureServer();

  try {
    await page.goto(fixtureServer.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.state)).toMatch(/ready|partial/);

    await expect(page.locator("#endpoint-input")).toHaveValue(`${fixtureServer.url}/fixtures/ogc`);
    await expect(page.locator("#requested-protocol")).toHaveText("ogc-features");
    await expect(page.locator("#resolved-protocol")).toHaveText("ogc-features");
    await expect(page.locator("#detection-confidence")).toHaveText("not-reported");
    await expect(page.locator("#metadata-cache")).toContainText("feature data not-loaded");
    await expect(page.locator('.source-card[data-selected="true"]')).toContainText("places");
    await expect(page.locator("#capability-list")).toContainText("claimed");
    await expect(page.locator("#schema-summary")).toContainText("conformance");

    await expect(page.locator("#run-query-button")).toBeEnabled();
    await expect(page.locator("#query-code")).toHaveText("planner.accepted");
    await expect(page.locator("#prepare-render-button")).toBeDisabled();
    await expect(page.locator("#render-code")).not.toHaveText("planner.accepted");
    await expect(page.locator("#plan-pushdown")).toHaveText("full");
    await expect(page.locator("#plan-fidelity")).toHaveText("exact");
    await expect(page.locator("#plan-residual")).toHaveText("none");
    await expect(page.locator("#typescript-code")).toContainText("executeQueryPlan(queryPlan, source, { signal })");

    await expect(page.getByTestId("honua-sample-mode")).toHaveText(/source|packed/);
    await expect(page.getByTestId("honua-sample-evidence")).toContainText("Evidence");
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: "service-explorer",
      browserName,
      sampleReadyDurationMs: await page.evaluate(() => performance.now()),
      runtimeReady: await page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready === true),
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#endpoint-input", "#run-query-button", "#map", "#typescript-code"],
    });

    // Nested source-card content remains an operable selection target.
    const interactionsBeforeSourceSelection = await page.evaluate(
      () => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount ?? 0,
    );
    await page.locator('.source-card[data-selected="true"] strong').click();
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount))
      .toBe(interactionsBeforeSourceSelection + 1);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.state))
      .toMatch(/ready|partial/);

    await page.locator("#run-query-button").click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.resultCount)).toBe(3);
    await expect(page.locator("#result-body")).toContainText("Honolulu");
    await expect(page.locator("#result-body")).toContainText("Hanauma Bay");
    await expect(page.locator("#map-status")).toHaveText("exact result projected");
    await expect(page.locator("#result-count")).toHaveText("3");

    // Accepted operations have their own visible cancel path; cancellation
    // leaves no late result or map mutation behind.
    await page.locator("#endpoint-input").fill(`${fixtureServer.url}/fixtures/slow-query-ogc`);
    await page.locator("#inspect-button").click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#run-query-button")).toBeEnabled();
    await page.locator("#run-query-button").click();
    await expect(page.locator("#cancel-button")).toBeEnabled();
    await page.locator("#cancel-button").click();
    await expect(page.locator("#map-status")).toContainText("operation.cancelled");
    await expect(page.locator("#result-body")).toHaveText("No query has run for this inspection.");
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.resultCount)).toBe(0);

    // Identity-bearing URL input is rejected before I/O and removed from the
    // renderer immediately; credential-like material must not survive in DOM.
    await page.locator("#endpoint-input").fill(`${fixtureServer.url}/fixtures/ogc?token=TOP-SECRET`);
    await page.locator("#inspect-button").click();
    await expect(page.locator("#input-message")).toContainText("input.identity-bearing-endpoint");
    await expect(page.locator("#endpoint-input")).toHaveValue("[invalid endpoint]");
    await expect(page.locator("#result-body")).toHaveText("No query has run for this inspection.");
    await expect(page.locator("#map-status")).toHaveText("waiting for an accepted operation");
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.resultCount)).toBe(0);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(false);
    expect(await page.locator("body").textContent()).not.toContain("TOP-SECRET");

    // A slow discovery request remains explicitly cancellable.
    await page.locator("#endpoint-input").fill(`${fixtureServer.url}/fixtures/slow-ogc`);
    await page.locator("#source-input").fill("");
    await page.locator("#inspect-button").click();
    await expect(page.locator("#cancel-button")).toBeEnabled();
    await page.locator("#cancel-button").click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.state)).toBe("cancelled");

    // Restore the golden path for shared responsive/a11y evidence and teardown.
    await page.locator("#endpoint-input").fill(`${fixtureServer.url}/fixtures/ogc`);
    await page.locator("#source-input").fill("places");
    await page.locator("#inspect-button").click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);

    const interactionsBeforeDispose = await page.evaluate(
      () => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount,
    );
    await page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_DISPOSE__?.());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.disposed)).toBe(true);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    expect(await page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount)).toBe(
      interactionsBeforeDispose,
    );
  } finally {
    try {
      await fixtureServer.close();
      await attestClosedFixture(testInfo, "service-explorer", "startServiceExplorerFixtureServer");
    } finally {
      await finalizeSampleConsole({
        testInfo,
        sampleId: "service-explorer",
        page,
        context,
        pageErrors,
        consoleErrors,
      });
    }
  }
});
