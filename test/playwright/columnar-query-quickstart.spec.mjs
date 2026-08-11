import { expect, test } from "@playwright/test";
import { createServer } from "vite";

test.setTimeout(60_000);

test("maps the exact bounded Arrow fixture and proves cancellation and resource ceilings", async ({ browser }) => {
  const server = await createServer({
    configFile: "examples/columnar-query-quickstart/vite.config.ts",
    logLevel: "error",
  });
  await server.listen();
  const sampleUrl = server.resolvedUrls?.local[0];
  if (!sampleUrl) throw new Error("Columnar quickstart Vite server did not expose a local URL.");

  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const sampleOrigin = new URL(sampleUrl).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== sampleOrigin) {
      externalRequests.push(url.href);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    await page.goto(sampleUrl);
    await expect
      .poll(() => page.evaluate(() => window.__HONUA_COLUMNAR_QUERY_QUICKSTART__?.ready))
      .toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: /One query/u })).toBeVisible();
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);
    await expect(page.locator(".result-label")).toHaveText("Honolulu Harbor");
    await expect(page.locator("#result-coordinate")).toHaveText("-157.8583, 21.3069");
    await expect(page.locator("#map-state")).toHaveAttribute("data-state", "ready");

    const firstRun = await page.evaluate(() => {
      const runtime = window.__HONUA_COLUMNAR_QUERY_QUICKSTART__;
      return {
        evidence: runtime?.lastEvidence,
        plan: runtime?.lastPlan,
        request: runtime?.lastRequest,
        rows: runtime?.lastRows,
      };
    });
    expect(firstRun.evidence).toMatchObject({
      rows: 1,
      batches: 1,
      transferBytes: 1336,
      ceilings: { maxRows: 25, maxBatches: 2, maxTransferBytes: 16_384, maxBackingBytes: 65_536 },
    });
    expect(firstRun.evidence.peakBackingBytes).toBeGreaterThan(0);
    expect(firstRun.evidence.peakBackingBytes).toBeLessThanOrEqual(65_536);
    expect(firstRun.plan).toMatchObject({
      execution: "server-pushdown",
      pushdown: ["columns", "filter", "bbox", "limit", "orderBy"],
    });
    expect(firstRun.request).toMatchObject({ method: "GET" });
    expect(firstRun.request.url).toContain("f=arrow");
    expect(firstRun.rows).toEqual([
      { featureId: 1, name: "Honolulu Harbor", coordinate: [-157.8583, 21.3069], timestamp: "1704164645000" },
    ]);

    const cancelled = await page.evaluate(async () => {
      const runtime = window.__HONUA_COLUMNAR_QUERY_QUICKSTART__;
      if (!runtime) throw new Error("Columnar quickstart runtime is unavailable.");
      const pending = runtime.run();
      setTimeout(() => runtime.cancel(), 10);
      return pending;
    });
    expect(cancelled).toEqual({ status: "cancelled", rows: 0 });
    await expect(page.locator("#map-state")).toHaveAttribute("data-state", "cancelled");
    expect(await page.evaluate(() => window.__HONUA_COLUMNAR_QUERY_QUICKSTART__?.cancelledRuns)).toBe(1);

    const recovered = await page.evaluate(() => window.__HONUA_COLUMNAR_QUERY_QUICKSTART__?.run());
    expect(recovered).toEqual({ status: "ready", rows: 1 });
    await expect(page.locator("#map-state")).toHaveAttribute("data-state", "ready");
    expect(await page.evaluate(() => window.__HONUA_COLUMNAR_QUERY_QUICKSTART__?.completedRuns)).toBe(2);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#map")).toBeVisible();
    await expect(page.locator(".evidence-panel")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the complete Overture project" })).toBeVisible();
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
    await server.close();
  }
});
