import { expect, test } from "@playwright/test";

import { startIncidentDashboardFixtureServer } from "../../examples/realtime-incident-dashboard/mock-server.mjs";

test.setTimeout(90_000);

test("realtime incident dashboard keeps map, queue, filters, and detail linked", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const expectedConflictConsole = [];
  const externalRequests = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource:.*409 \(Conflict\)/.test(message.text())) {
      expectedConflictConsole.push(message.text());
      return;
    }
    consoleErrors.push(message.text());
  });

  const fixtureServer = await startIncidentDashboardFixtureServer();
  const fixtureOrigin = new URL(fixtureServer.url).origin;
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (/^https?:$/.test(requestUrl.protocol) && requestUrl.origin !== fixtureOrigin) externalRequests.push(request.url());
  });

  try {
    const navigation = await page.goto(fixtureServer.url);
    expect(navigation?.headers()["content-security-policy"]).toContain("connect-src 'self'");

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.ready === true))
      .toBe(true);

    await expect(page.locator("#connection-status")).toHaveText("Live");
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");
    await expect(page.locator("#data-lane")).toHaveText("Isolated fixture lab");
    await expect(page.locator("#execution-disclosure")).toContainText("fixture evidence");
    await expect(page.locator("#summary-active")).toHaveText("6");
    await expect(page.locator("#summary-critical")).toHaveText("1");
    await expect(page.locator("#projection-visible-count")).toHaveText("6");
    await expect(page.locator("#detail-title")).toHaveText("Isolated demo coordination record");
    await expect(page.locator("#edit-profile")).toHaveText("Isolated + resettable");
    await expect(page.getByRole("button", { name: "Stage Edit" })).toBeEnabled();

    await page.getByRole("button", { name: "Replay Duplicate" }).click();
    await expect(page.locator("#stream-ignored")).toHaveText("1");
    await expect(page.locator("#stream-reconciliation")).toContainText("Duplicate");
    await page.getByRole("button", { name: "Deliver Out of Order" }).click();
    await expect(page.locator("#stream-ignored")).toHaveText("2");
    await expect(page.locator("#stream-reconciliation")).toContainText("Reordered");
    await page.getByRole("button", { name: "Inject Stale Cursor" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Stale");
    await expect(page.locator("#live-authority")).toHaveText("Read-only");
    await expect(page.locator("#stream-reconciliation")).toContainText(/replacement snapshot required/i);
    await expect(page.getByRole("button", { name: "Stage Edit" })).toBeDisabled();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Stale");
    await expect(page.locator("#live-authority")).toHaveText("Read-only");
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Live");
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");
    await expect(page.locator("#stream-reconciliation")).toContainText(/replacement snapshot applied/i);
    await expect(page.getByRole("button", { name: "Stage Edit" })).toBeEnabled();

    await page.locator("#edit-status").selectOption("monitoring");
    await page.locator("#edit-assigned").fill("Exercise Lead");
    await page.getByRole("button", { name: "Stage Edit" }).click();
    await expect(page.locator("#edit-outcome")).toContainText("Staged against revision 1");
    await page.getByRole("button", { name: "Simulate Conflict" }).click();
    await page.getByRole("button", { name: "Submit Staged Edit" }).click();
    await expect(page.locator("#edit-outcome")).toContainText("Conflict:");
    await page.getByRole("button", { name: "Stage Edit" }).click();
    await page.getByRole("button", { name: "Submit Staged Edit" }).click();
    await expect(page.locator("#edit-outcome")).toContainText("Applied:");
    await expect(page.locator("#detail-status")).toHaveText("Monitoring");
    await page.getByRole("button", { name: "Repeat Same Request" }).click();
    await expect(page.locator("#edit-outcome")).toContainText("Duplicate:");
    await page.getByRole("button", { name: "Reset Demo Record" }).click();
    await expect(page.locator("#edit-outcome")).toContainText("Reset:");
    await expect(page.locator("#detail-status")).toHaveText("Assigned");

    await page.getByRole("button", { name: "Stage Edit" }).click();
    const mutationRoutes = new Set([
      "fixture-action-concurrent-edit",
      "fixture-action-edit",
      "fixture-action-reset-edit",
    ]);
    const mutationRequestCount = async () => {
      const evidence = await (await fetch(fixtureServer.requestLogUrl)).json();
      return evidence.requests.filter((request) => mutationRoutes.has(request.routeId)).length;
    };
    const beforeReconnectDenials = await mutationRequestCount();
    await page.evaluate(() =>
      Promise.all([
        window.__HONUA_INCIDENT_RUNTIME__?.reconnect(),
        window.__HONUA_INCIDENT_RUNTIME__?.submitEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.repeatEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.simulateConflict(),
        window.__HONUA_INCIDENT_RUNTIME__?.resetEdit(),
      ]),
    );
    await expect(page.locator("#connection-status")).toHaveText("Reconnecting");
    await expect(page.locator("#live-authority")).toHaveText("Read-only");
    await expect(page.locator("#edit-outcome")).toContainText(/not authoritative/i);
    expect(await mutationRequestCount()).toBe(beforeReconnectDenials);
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");

    await page.getByRole("button", { name: "Mark Stale" }).click();
    const beforeStaleDenials = await mutationRequestCount();
    await page.evaluate(() =>
      Promise.all([
        window.__HONUA_INCIDENT_RUNTIME__?.submitEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.repeatEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.simulateConflict(),
        window.__HONUA_INCIDENT_RUNTIME__?.resetEdit(),
      ]),
    );
    await expect(page.locator("#connection-status")).toHaveText("Stale");
    await expect(page.locator("#edit-outcome")).toContainText(/not authoritative/i);
    expect(await mutationRequestCount()).toBe(beforeStaleDenials);
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");

    await page.getByRole("button", { name: "Step Event" }).click();
    await expect(page.locator("#last-scenario-step")).toHaveText("Escalate outage");
    await expect(page.locator("#summary-critical")).toHaveText("2");
    await expect(page.locator("#incident-list")).toContainText("Kakaako grid outage");

    await page.getByRole("button", { name: "Step Event" }).click();
    await expect(page.locator("#last-scenario-step")).toHaveText("Create brush response");
    await expect(page.locator("#incident-list")).toContainText("Diamond Head brush response");

    await page.getByRole("button", { name: "Step Event" }).click();
    await page.locator("#status-filter").selectOption("resolved");
    await expect(page.locator("#projection-visible-count")).toHaveText("1");
    await expect(page.locator("#incident-list")).toContainText("Ala Moana signal failure");

    await page.locator("#status-filter").selectOption("");
    await page.getByRole("button", { name: "Open Airport logistics delay" }).click();
    await expect(page.locator("#detail-title")).toHaveText("Airport logistics delay");

    await page.evaluate(() => {
      return Promise.all([
        window.__HONUA_INCIDENT_RUNTIME__?.step(),
        window.__HONUA_INCIDENT_RUNTIME__?.step(),
      ]);
    });
    await expect(page.locator("#detail-title")).toHaveText("No selected incident");
    await expect(page.locator("#stream-tombstones")).toHaveText("1");

    await expect(
      page.getByRole("button", { name: "Open Harbor fuel sheen, Critical severity, Monitoring status", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("#incident-list")).toContainText("Critical severity");

    await page.getByRole("button", { name: "Mark Stale" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Stale");
    await expect(page.locator("#live-authority")).toHaveText("Read-only");
    await expect(page.getByRole("button", { name: "Open Harbor fuel sheen" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Stage Edit" })).toBeDisabled();

    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Reconnecting");
    await expect(page.locator("#stream-reconnect")).toContainText(/attempt 1/i);
    await expect(page.locator("#stream-backoff")).toHaveText("0 ms");

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Live");
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");
    await expect(page.locator("#stream-reconnect")).toContainText(/resumed/i);
    await expect(page.getByRole("button", { name: "Open Harbor fuel sheen" })).toBeEnabled();

    const recordCount = await page.locator("#stream-records").textContent();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator("#stream-records")).toHaveText(recordCount ?? "");
    await expect(page.locator("#event-log")).toContainText("Snapshot");

    await expect.poll(async () => page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.visibleIncidentCount)).toBe(6);

    const evidence = await (await fetch(fixtureServer.requestLogUrl)).json();
    const routeIds = evidence.requests.map((request) => request.routeId);
    expect(routeIds).toEqual(
      expect.arrayContaining([
        "incident-stream",
        "fixture-action-duplicate-event",
        "fixture-action-reorder-event",
        "fixture-action-stale-cursor",
        "fixture-action-concurrent-edit",
        "fixture-action-edit",
        "fixture-action-reset-edit",
        "fixture-action-step",
        "fixture-action-reconnect",
        "fixture-action-resume",
        "fixture-action-refresh",
      ]),
    );
    const streamRequest = evidence.requests.find((request) => request.routeId === "incident-stream");
    expect(streamRequest?.queryNames).toContain("run");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#data-lane")).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(expectedConflictConsole).toHaveLength(1);
    expect(externalRequests).toEqual([]);

    const lastStepBeforeDispose = await page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.lastStep);
    const runBeforeDispose = await (await fetch(fixtureServer.runUrl)).json();
    expect(runBeforeDispose.state.subscriberCount).toBe(1);
    await page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.dispose());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.disposed)).toBe(true);
    await expect
      .poll(async () => (await (await fetch(fixtureServer.runUrl)).json()).state.subscriberCount)
      .toBe(0);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    await page.getByRole("button", { name: "Step Event" }).click();
    const runtimeAfterDispose = await page.evaluate(async () => ({
      lastStep: window.__HONUA_INCIDENT_RUNTIME__?.lastStep,
      runtimeStep: await window.__HONUA_INCIDENT_RUNTIME__?.step(),
    }));
    expect(runtimeAfterDispose).toEqual({ lastStep: lastStepBeforeDispose, runtimeStep: null });
    const runAfterDispose = await (await fetch(fixtureServer.runUrl)).json();
    expect(runAfterDispose.state).toMatchObject({
      subscriberCount: 0,
      sequence: runBeforeDispose.state.sequence,
      stepIndex: runBeforeDispose.state.stepIndex,
      idempotencyKeyCount: runBeforeDispose.state.idempotencyKeyCount,
    });
    const evidenceAfterDispose = await (await fetch(fixtureServer.requestLogUrl)).json();
    expect(evidenceAfterDispose.requests.filter((request) => request.routeId === "fixture-action-step")).toHaveLength(
      routeIds.filter((routeId) => routeId === "fixture-action-step").length,
    );
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(expectedConflictConsole).toHaveLength(1);
  } finally {
    await fixtureServer.close();
  }
});
