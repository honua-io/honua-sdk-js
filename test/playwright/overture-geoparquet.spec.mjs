import { expect, test } from "@playwright/test";

import { startOvertureFixtureServer } from "../../examples/overture-geoparquet/mock-server.mjs";
import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

test.setTimeout(120_000);

test("Overture columnar lab stays bounded, offline, accessible, and responsive", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const server = await startOvertureFixtureServer();
  const fixtureOrigin = new URL(server.url).origin;
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== fixtureOrigin) externalRequests.push(request.url());
  });

  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.ready === true), { timeout: 90_000 })
      .toBe(true);

    await expect(page.locator("#engine-state")).toHaveText("Bounded query complete");
    await expect(page.locator("#lane-badge")).toHaveText("Deterministic fixture");
    await expect(page.locator("#metric-projection")).toContainText("bbox");
    await expect(page.locator("#metric-files")).toHaveText("1 / 1 via STAC bbox");
    await expect(page.locator("#metric-memory-policy")).toHaveText("256 MiB");
    await expect(page.locator("#evidence-ranges")).toContainText("1,939 bytes / 1 range");
    await expect(page.locator("#evidence-rows")).toHaveText("8 / 8");
    await expect(page.locator("#result-body tr")).toHaveCount(8);
    await expect(page.locator("#result-summary")).toContainText("GERS ids preserved");
    await expect(page.locator("#result-points circle")).toHaveCount(8);
    expect(externalRequests).toEqual([]);

    const fixtureExecution = await page.evaluate(() => window.__HONUA_OVERTURE__?.lastEvidence);
    expect(fixtureExecution).toBeDefined();
    expect(fixtureExecution.timing.totalMs).toBeLessThan(15_000);
    expect(fixtureExecution.estimatedResultBytes).toBeLessThan(32_768);
    expect(() =>
      validateEvidenceEnvelope({
        format: "honua.sdk.sample-evidence.v1",
        schemaVersion: 1,
        sampleId: "overture-geoparquet",
        lane: "fixture",
        status: "executed",
        reason: null,
        observedAt: fixtureExecution.range.observedAt,
        authMode: "none",
        sdk: { package: "@honua/sdk-js", version: "0.1.0-beta.0", gitCommit: null },
        source: {
          provider: "repository-fixture",
          identity: fixtureExecution.plan.selectedObjects[0].objectKey,
          endpoint: null,
          deploymentVersion: "fixture-places-v1",
          dataVersion: "fixture-v1",
        },
        provenance: {
          sourceId: "fixture:overture-places",
          observedAt: fixtureExecution.range.observedAt,
          validAt: null,
          state: "replayed",
          attribution: "Synthetic Overture-shaped fixture",
        },
        semantics: {
          operation: "bounded-aoi-columnar-query",
          outcome: "bounded-progressive-result",
          itemCount: fixtureExecution.rowsReturned,
          assertions: ["zero-cross-origin-requests", "memory-ceiling-enforced", "unsafe-aoi-rejected"],
        },
        timing: {
          totalMs: fixtureExecution.timing.totalMs,
          firstSuccessfulInteractionMs: fixtureExecution.timing.sdkPlanMs,
        },
        degradation: { state: "none", reasons: [] },
        artifacts: [],
      }),
    ).not.toThrow();

    await page.selectOption("#category", "beach");
    await page.getByRole("button", { name: "Plan + run" }).click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
    await expect(page.locator("#result-body tr")).toHaveCount(2);
    await expect(page.locator("#result-body")).toContainText("Waikiki Beach");

    await page.getByRole("button", { name: "Plan + run" }).click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("completed");
    await expect(page.locator("#cache-badge")).toHaveText("Result cache hit");

    await page.locator("#aoi").fill("-180,-90,180,90");
    await page.getByRole("button", { name: "Plan + run" }).click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("rejected");
    await expect(page.locator("#query-message")).toContainText("safety budget");
    await expect(page.locator("#result-body tr")).toHaveCount(2);

    await page.locator("#aoi").fill("-158.30,21.20,-157.65,21.60");
    await page.evaluate(() => {
      const pending = window.__HONUA_OVERTURE__?.runQuery("fixture");
      window.__HONUA_OVERTURE__?.cancel();
      return pending;
    });
    await expect.poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.status)).toBe("cancelled");
    await expect(page.locator("#query-message")).toContainText(/cancel/i);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Overture columnar lab" })).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);

    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
