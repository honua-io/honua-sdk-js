import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { startIncidentDashboardFixtureServer } from "../../examples/realtime-incident-dashboard/mock-server.mjs";

const expectedSdkMode = process.env.HONUA_SAMPLE_SDK_MODE ?? "source";
const expectedEntrypoints = [
  "@honua/sdk-js/contract",
  "@honua/sdk-js/exploration",
  "@honua/sdk-js/honua",
  "@honua/sdk-js/interactions",
  "@honua/sdk-js/realtime",
  "@honua/sdk-js/style",
];

test.setTimeout(90_000);

async function assertSdkResolution() {
  const resolutionPath = path.resolve(
    import.meta.dirname,
    "../../examples/realtime-incident-dashboard/dist/honua-sample-sdk-resolution.json",
  );
  const resolution = JSON.parse(await readFile(resolutionPath, "utf8"));
  expect(resolution).toMatchObject({
    format: "honua.sdk.sample-resolution.v1",
    mode: expectedSdkMode,
    package: { name: "@honua/sdk-js" },
  });
  expect(resolution.entrypoints.map((entry) => entry.specifier).sort()).toEqual([...expectedEntrypoints].sort());
  expect(resolution.bundle.length).toBeGreaterThan(1);

  if (expectedSdkMode !== "packed") {
    expect(resolution.entrypoints.every((entry) => entry.hashSubject === "repository-source-entrypoint-file")).toBe(
      true,
    );
    return;
  }

  const configuredRoot = process.env.HONUA_SAMPLE_SDK_DIR;
  expect(configuredRoot, "packed Chromium requires the extracted SDK root").toBeTruthy();
  const sdkRoot = await realpath(configuredRoot);
  const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
  expect(manifest.name).toBe("@honua/sdk-js");
  for (const entry of resolution.entrypoints) {
    const exportKey = entry.specifier === "@honua/sdk-js" ? "." : `./${entry.specifier.slice("@honua/sdk-js/".length)}`;
    const declaration = manifest.exports[exportKey];
    const target = typeof declaration === "string" ? declaration : declaration?.default;
    expect(target).toBe(entry.exportTarget);
    const absolute = await realpath(path.resolve(sdkRoot, target));
    expect(absolute.startsWith(`${sdkRoot}${path.sep}`)).toBe(true);
    const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
    expect(digest).toBe(entry.sha256);
    expect(entry.hashSubject).toBe("packed-published-entrypoint-file");
  }
}

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
    await assertSdkResolution();
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
    await expect(page.locator("#edit-guard-reason")).toHaveAttribute("role", "status");
    await expect(page.locator("#edit-guard-reason")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(".edit-actions")).toHaveAttribute("role", "group");
    await expect(page.locator(".edit-actions")).toHaveAttribute("aria-describedby", "edit-guard-reason");
    await expect(page.locator("#edit-status")).toHaveAttribute("aria-describedby", "edit-guard-reason");
    await expect(page.locator("#edit-assigned")).toHaveAttribute("aria-describedby", "edit-guard-reason");

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

    const editStatus = page.locator("#edit-status");
    const editAssigned = page.locator("#edit-assigned");
    const stageEdit = page.getByRole("button", { name: "Stage Edit" });
    const submitEdit = page.getByRole("button", { name: "Submit Staged Edit" });
    const repeatEdit = page.getByRole("button", { name: "Repeat Same Request" });
    const simulateConflict = page.getByRole("button", { name: "Simulate Conflict" });
    const resetEdit = page.getByRole("button", { name: "Reset Demo Record" });

    await editStatus.selectOption("monitoring");
    await editStatus.focus();
    await page.keyboard.press("Tab");
    await expect(editAssigned).toBeFocused();
    await editAssigned.fill("Exercise Lead");
    await page.keyboard.press("Tab");
    await expect(stageEdit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#edit-outcome")).toContainText("Staged against revision 1");
    await simulateConflict.press("Enter");
    await expect(page.locator("#edit-outcome")).toContainText("Concurrent update published");
    // #edit-outcome is written synchronously by the control, but the panel is
    // re-rendered by the realtime event that control published, and that render
    // arrives on its own schedule. Wait for it to reach the panel -- on the
    // thing that makes the next step meaningful, not on a timer: the live
    // record has moved past the staged revision, which is exactly why
    // submitting must now conflict (honua-io/honua-sdk-js#1333).
    await expect(page.locator("#edit-revision")).not.toHaveText("1");
    await expect(submitEdit).toBeEnabled();
    // `locator.press` rather than `focus()` + `keyboard.press`. The panel
    // rewrites every control's `disabled` flag on each re-render, and disabling
    // a focused control blurs it in a way re-enabling does not undo -- so a
    // render landing in the gap between a separate focus() and keypress sent
    // Space to the document and left this outcome line unchanged for the full
    // 10s timeout. This keeps the keyboard semantics the test is here to cover
    // while closing the gap and re-checking the control is actionable first.
    await submitEdit.press("Space");
    await expect(page.locator("#edit-outcome")).toContainText("Conflict:");
    await stageEdit.press("Enter");
    await expect(page.locator("#edit-outcome")).toContainText("Staged against revision");
    await submitEdit.press("Enter");
    await expect(page.locator("#edit-outcome")).toContainText("Applied:");
    await expect(page.locator("#detail-status")).toHaveText("Monitoring");
    await repeatEdit.press("Space");
    await expect(page.locator("#edit-outcome")).toContainText("Duplicate:");
    await resetEdit.press("Enter");
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
        window.__HONUA_INCIDENT_RUNTIME__?.stageEdit(),
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
    const airportIncident = page.getByRole("button", { name: "Open Airport logistics delay" });
    await airportIncident.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#detail-title")).toHaveText("Airport logistics delay");
    await expect(page.locator("#edit-guard-reason")).toContainText(/not part of the isolated resettable/i);
    await expect(editStatus).toBeDisabled();
    await expect(editAssigned).toBeDisabled();
    await expect(stageEdit).toBeDisabled();
    const beforeOutsideSandboxDenials = await mutationRequestCount();
    await page.evaluate(() =>
      Promise.all([
        window.__HONUA_INCIDENT_RUNTIME__?.stageEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.submitEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.repeatEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.simulateConflict(),
        window.__HONUA_INCIDENT_RUNTIME__?.resetEdit(),
      ]),
    );
    await expect(page.locator("#edit-outcome")).toContainText(/not part of the isolated resettable/i);
    expect(await mutationRequestCount()).toBe(beforeOutsideSandboxDenials);

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

    await page.goto(fixtureServer.unauthorizedUrl);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.ready === true))
      .toBe(true);
    await expect(page.locator("#connection-status")).toHaveText("Live");
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");
    await expect(page.locator("#edit-profile")).toHaveText("Unauthorized");
    await expect(page.locator("#edit-guard-reason")).toContainText(/not authorized/i);
    await expect(page.locator("#edit-status")).toBeDisabled();
    await expect(page.locator("#edit-assigned")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Stage Edit" })).toBeDisabled();
    const beforeUnauthorizedDenials = await mutationRequestCount();
    await page.evaluate(() =>
      Promise.all([
        window.__HONUA_INCIDENT_RUNTIME__?.stageEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.submitEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.repeatEdit(),
        window.__HONUA_INCIDENT_RUNTIME__?.simulateConflict(),
        window.__HONUA_INCIDENT_RUNTIME__?.resetEdit(),
      ]),
    );
    await expect(page.locator("#edit-outcome")).toContainText(/not authorized/i);
    expect(await mutationRequestCount()).toBe(beforeUnauthorizedDenials);

    const unauthorizedCursor = await page.locator("#stream-cursor").textContent();
    await page.getByRole("button", { name: "Step Event" }).click();
    await expect.poll(async () => page.locator("#stream-cursor").textContent()).not.toBe(unauthorizedCursor);
    await expect(page.locator("#connection-status")).toHaveText("Live");
    await expect(page.locator("#live-authority")).toHaveText("Authoritative");
    await expect(page.locator("#edit-profile")).toHaveText("Unauthorized");
    await expect.poll(async () => (await (await fetch(fixtureServer.runUrl)).json()).state.subscriberCount).toBe(1);
    await page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.dispose());
    await expect.poll(async () => (await (await fetch(fixtureServer.runUrl)).json()).state.subscriberCount).toBe(0);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(expectedConflictConsole).toHaveLength(1);
    expect(externalRequests).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
