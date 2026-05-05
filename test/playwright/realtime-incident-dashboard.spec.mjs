import { expect, test } from "@playwright/test";

import { startIncidentDashboardFixtureServer } from "../../examples/realtime-incident-dashboard/mock-server.mjs";

test.setTimeout(90_000);

test("realtime incident dashboard keeps map, queue, filters, and detail linked", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startIncidentDashboardFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.ready === true))
      .toBe(true);

    await expect(page.locator("#connection-status")).toHaveText("Live");
    await expect(page.locator("#summary-active")).toHaveText("5");
    await expect(page.locator("#summary-critical")).toHaveText("1");
    await expect(page.locator("#projection-visible-count")).toHaveText("5");
    await expect(page.locator("#detail-title")).toHaveText("Harbor fuel sheen");

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

    await page.getByRole("button", { name: "Mark Stale" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Stale");

    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Reconnecting");

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator("#connection-status")).toHaveText("Live");

    const recordCount = await page.locator("#stream-records").textContent();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator("#stream-records")).toHaveText(recordCount ?? "");
    await expect(page.locator("#event-log")).toContainText("Snapshot");

    await expect.poll(async () => page.evaluate(() => window.__HONUA_INCIDENT_RUNTIME__?.visibleIncidentCount)).toBe(5);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
