import { expect, test } from "@playwright/test";

import { startGeoprocessingJobRunnerFixtureServer } from "../../examples/geoprocessing-job-runner/mock-server.mjs";

test.setTimeout(90_000);

test("result-first buffer walkthrough is semantic, responsive, deterministic, and clean", async ({ page }, testInfo) => {
  const diagnosticStarted = performance.now();
  const lifecycle = [];
  const requestIds = new WeakMap();
  let nextRequestId = 0;
  let droppedEvents = 0;
  const record = (event) => {
    if (lifecycle.length >= 256) { droppedEvents += 1; return; }
    lifecycle.push({ elapsedMs: performance.now() - diagnosticStarted, ...event });
  };
  const requestIdentity = (request) => {
    let requestId = requestIds.get(request);
    if (requestId === undefined) { requestId = ++nextRequestId; requestIds.set(request, requestId); }
    return { requestId, method: request.method().slice(0, 16), path: new URL(request.url()).pathname.slice(0, 256) };
  };
  page.on("request", (request) => record({ event: "request", ...requestIdentity(request) }));
  page.on("response", (response) => record({ event: "response", ...requestIdentity(response.request()), status: response.status() }));
  page.on("requestfinished", (request) => record({ event: "finished", ...requestIdentity(request) }));
  page.on("requestfailed", (request) => record({ event: "failed", ...requestIdentity(request), errorText: request.failure()?.errorText?.slice(0, 256) ?? null, canceled: null }));
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
    record({ event: "milestone", name: "navigation-start" });
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

    record({ event: "milestone", name: "replay-click-start" });
    await page.getByRole("button", { name: "Replay buffer job" }).click();
    record({ event: "milestone", name: "replay-click-complete" });
    await expect(page.locator("#job-state")).toHaveText("Running");
    record({ event: "milestone", name: "running-observed" });
    await expect(page.getByRole("button", { name: "Cancel job" })).toBeVisible();
    record({ event: "milestone", name: "cancel-click-start" });
    await page.getByRole("button", { name: "Cancel job" }).click();
    record({ event: "milestone", name: "cancel-click-complete" });
    await expect(page.locator("#job-state")).toHaveText("Dismissed");
    record({ event: "milestone", name: "dismissed-observed" });
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
  } catch (error) {
    const diagnostic = {
      schema: "honua.gp-browser-request-diagnostic/v1",
      scope: "Failure-only local fixture request lifecycle; no response bodies or credentials",
      clock: "Host monotonic milliseconds from test setup; not browser request timing",
      canceledScope: "Unavailable from Playwright Request.failure; null is not false",
      retry: testInfo.retry,
      limits: { events: 256, fixtureRequests: 128, stringCharacters: 256, bytes: 65536 },
      droppedEvents,
      lifecycle,
      fixtureRequests: server.requests.slice(0, 128).map(({ method, path }, index) => ({ index, method: method.slice(0, 16), path: path.slice(0, 256) })),
      droppedFixtureRequests: Math.max(0, server.requests.length - 128),
    };
    let serialized = JSON.stringify(diagnostic);
    while (Buffer.byteLength(serialized) > 65536 && lifecycle.length) {
      lifecycle.pop(); diagnostic.droppedEvents += 1; serialized = JSON.stringify(diagnostic);
    }
    while (Buffer.byteLength(serialized) > 65536 && diagnostic.fixtureRequests.length) {
      diagnostic.fixtureRequests.pop(); diagnostic.droppedFixtureRequests += 1; serialized = JSON.stringify(diagnostic);
    }
    console.log(`GP_REQUEST_DIAGNOSTIC ${serialized}`);
    throw error;
  } finally {
    await server.close();
  }
});
