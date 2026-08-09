import { expect, test } from "@playwright/test";

import { startGeoprocessingJobRunnerFixtureServer } from "../../examples/geoprocessing-job-runner/mock-server.mjs";

test.setTimeout(90_000);

test("result-first buffer walkthrough is semantic, responsive, deterministic, and clean", async ({ page }, testInfo) => {
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });

  const server = await startGeoprocessingJobRunnerFixtureServer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const startedAt = Date.now();
    await page.goto(server.url);
    await expect.poll(() => page.evaluate(() => window.__HONUA_GEOPROCESSING_JOB_RUNNER__?.ready)).toBe(true);
    await expect(page.locator("#buffer-polygon")).toHaveAttribute("data-rendered", "true", { timeout: 3_000 });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(3_000);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run a buffer job and collect the result");
    await expect(page.getByText("Pinned fixture · not a live service")).toBeVisible();
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-state")).toHaveText("Rendered and verified");
    await expect(page.getByRole("button", { name: "Replay buffer job" })).toBeVisible();
    await expect(page.getByLabel("Map legend")).toContainText("Input · Honolulu Hale");
    await expect(page.getByLabel("Map legend")).toContainText("Output · 350 m buffer");
    await expect(page.getByRole("table", { name: "Accessible input and output geometry summary" })).toContainText("Polygon, 33 ring positions");
    await expect(page.locator("#result-digest")).toHaveText(server.fixture.resultGeometrySha256);
    await expect(page.locator("#status-timeline li")).toHaveCount(4);
    await expect(page.getByText("/ogc/processes/processes/geometry.buffer/execution", { exact: true })).toBeVisible();

    const desktopBounds = await page.locator(".map-card").boundingBox();
    expect(desktopBounds).not.toBeNull();
    expect(desktopBounds.width).toBeGreaterThanOrEqual(1440 * 0.55);
    expect((desktopBounds.width * desktopBounds.height) / (1440 * 900)).toBeGreaterThanOrEqual(0.55);
    await page.screenshot({ path: testInfo.outputPath("geoprocessing-job-runner-desktop.png"), fullPage: false });

    expect(server.requests.slice(0, 4).map(({ method, path }) => ({ method, path }))).toEqual(server.fixture.exchanges.map(({ method, path }) => ({ method, path })));
    expect(server.requests[0]).toMatchObject({ body: { inputs: server.fixture.inputs, response: "document" }, prefer: "respond-async" });

    await page.getByRole("button", { name: "Replay buffer job" }).click();
    await expect(page.getByRole("button", { name: "Cancel job" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel job" }).click();
    await expect(page.locator("#job-state")).toHaveText("Dismissed");
    await expect(page.getByRole("button", { name: "Restart buffer job" })).toBeVisible();
    expect(server.requests.some(({ method, path }) => method === "DELETE" && path.endsWith("/honolulu-hale-buffer-001"))).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBounds = await page.locator(".map-card").boundingBox();
    expect(mobileBounds).not.toBeNull();
    expect(mobileBounds.height).toBeGreaterThanOrEqual(844 * 0.4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("geoprocessing-job-runner-mobile.png"), fullPage: false });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(badResponses).toEqual([]);
    expect(await page.locator("body").innerText()).not.toMatch(/undefined|null|loading error/i);
  } finally {
    await server.close();
  }
});
