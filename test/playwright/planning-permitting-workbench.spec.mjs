import { expect, test } from "@playwright/test";

import { startPlanningWorkbenchFixtureServer } from "../../examples/planning-permitting-workbench/mock-server.mjs";

let fixture;

test.beforeAll(async () => {
  fixture = await startPlanningWorkbenchFixtureServer();
});

test.afterAll(async () => {
  await fixture?.close();
});

test("packed planning journey preserves public SDK semantics, recovery, accessibility, and mobile layout", async ({
  page,
}) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto(fixture.url);
  await expect(page.getByText("createHonua().connect → Source")).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");

  const address = page.getByLabel("Maui address or parcel");
  await address.focus();
  await expect(address).toBeFocused();
  await address.press("ControlOrMeta+A");
  await address.fill("300 Hana Hwy");
  await address.press("Enter");
  await expect(page.getByText(/Source.query selected feature 5001/)).toBeVisible();
  await expect(page.getByText("3-7-010-031", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Run bounded analysis" }).click();
  await expect(page.getByText("exact-client-geometry")).toBeVisible();
  await expect(page.getByText(/GeoServices envelope query capped at 25/)).toBeVisible();
  await expect(page.getByText(/not a current regulatory determination/)).toBeVisible();

  for (const [name, scenario, status] of [
    ["Success + attachment", "success", "succeeded"],
    ["Invalid domain", "invalid-domain", "validation-failed"],
    ["Version conflict", "conflict", "failed"],
    ["Attachment failure", "attachment-failure", "partial"],
    ["Unsupported edits", "unsupported", "unsupported"],
  ]) {
    await page.getByRole("button", { name }).click();
    await expect(page.locator(`#outcomes li[data-scenario="${scenario}"][data-status="${status}"]`)).toBeVisible();
  }

  const recover = page.getByRole("button", { name: "Recover with valid submission" });
  await expect(recover).toBeVisible();
  await recover.click();
  await expect(page.locator('#outcomes li[data-scenario="success"][data-status="succeeded"]')).toHaveCount(2);
  await expect(recover).toBeHidden();
  await page.getByRole("button", { name: "Generate review artifact" }).click();
  await expect(page.getByLabel("Planning review JSON")).toContainText("honua.planning-permitting-review");
  await expect(page.getByLabel("Source and packed semantic contract")).toContainText("search-analyze-edit-export");

  const semantic = await page.evaluate(() => window.__HONUA_PLANNING_EVIDENCE__?.semantic);
  expect(semantic).toEqual({
    workflow: "search-analyze-edit-export",
    publicSurfaces: ["kernel-query", "geocoding", "geometry", "edit-session", "attachments"],
    failureScenarios: ["invalid-domain", "conflict", "attachment-failure", "unsupported"],
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Planning & Permitting" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Generate review artifact" }).focus();
  await expect(page.getByRole("button", { name: "Generate review artifact" })).toBeFocused();

  const requestEvidence = await (await fetch(`${fixture.url}/__fixture__/requests`)).json();
  expect(requestEvidence.requests.map((request) => request.pathname)).toEqual(
    expect.arrayContaining([
      "/rest/services/Maui/GeocodeServer/findAddressCandidates",
      "/rest/services/Maui/Planning/FeatureServer/0/query",
      "/rest/services/Maui/Planning/FeatureServer/0/applyEdits",
    ]),
  );
  expect(browserErrors).toEqual([]);
});
