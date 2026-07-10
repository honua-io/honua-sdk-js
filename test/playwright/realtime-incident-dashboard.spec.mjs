import { expect, test } from "@playwright/test";

import { startIncidentDashboardFixtureServer } from "../../examples/realtime-incident-dashboard/mock-server.mjs";

test.setTimeout(90_000);

test("realtime incident dashboard keeps map, queue, filters, and detail linked", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const fixtureServer = await startIncidentDashboardFixtureServer();

  try {
    await page.goto(fixtureServer.url);

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
    await page.getByRole("button", { name: "Inject Stale Cursor" }).click();
    await expect(page.locator("#stream-ignored")).toHaveText("2");
    await expect(page.locator("#stream-reconciliation")).toContainText(/stale/i);

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
      window.__HONUA_INCIDENT_RUNTIME__?.step();
      window.__HONUA_INCIDENT_RUNTIME__?.step();
    });
    await expect(page.locator("#detail-title")).toHaveText("No selected incident");
    await expect(page.locator("#stream-tombstones")).toHaveText("1");

    await expect(page.getByRole("button", { name: "Open Harbor fuel sheen" })).toBeEnabled();

    await page.getByRole("button", { name: "Mark Stale" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Stale");
    await expect(page.locator("#live-authority")).toHaveText("Read-only");
    await expect(page.getByRole("button", { name: "Open Harbor fuel sheen" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Stage Edit" })).toBeDisabled();

    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Reconnecting");
    await expect(page.locator("#stream-reconnect")).toContainText(/attempt 1/i);
    await expect(page.locator("#stream-backoff")).toHaveText("750 ms");

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

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#data-lane")).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
