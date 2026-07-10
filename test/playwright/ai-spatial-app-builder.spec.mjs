import { expect, test } from "@playwright/test";

import { startAiSpatialAppBuilderFixtureServer } from "../../examples/ai-spatial-app-builder/mock-server.mjs";

test.setTimeout(90_000);

async function withServer(run) {
  const server = await startAiSpatialAppBuilderFixtureServer();
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

test("safe-agent journey requires validation and approval before one bounded read", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await withServer(async (url) => {
    await page.goto(url);
    await expect(page.locator("#effect-count")).toHaveText("0");
    await expect(page.locator("#live-status")).toHaveText("skipped");
    await expect(page.getByRole("button", { name: "Execute approved read" })).toBeDisabled();

    await page.getByRole("button", { name: "Validate against policy" }).click();
    await expect(page.locator("#plan-state")).toContainText("Validated");
    await expect(page.locator("#plan-details")).toContainText("parcels-snapshot-2026-07-10");
    await expect(page.locator("#plan-details")).toContainText("parcels:read");
    await expect(page.locator("#plan-details")).toContainText("Request / row / byte estimate");
    await expect(page.locator("#plan-details")).toContainText("Approved byte ceiling");
    await expect(page.locator("#plan-details")).toContainText("Fidelity / cache");
    await expect(page.locator("#plan-details")).toContainText("exact / bypass");
    await expect(page.locator("#plan-details")).toContainText("fixture-replay");
    await expect(page.locator("#effect-count")).toHaveText("0");

    await page.getByRole("button", { name: "Approve 5-row read" }).click();
    await expect(page.locator("#approval-state")).toContainText("128000 bytes");
    await expect(page.locator("#effect-count")).toHaveText("0");
    await page.getByRole("button", { name: "Execute approved read" }).click();
    await expect(page.locator("#effect-count")).toHaveText("1");
    await expect(page.locator("#row-count")).toHaveText("5");
    await expect(page.locator("#receipt-integrity")).toHaveText("true");
    await expect(page.locator("#receipt-json")).toContainText("honua.agent-execution-receipt");
    await expect(page.locator("#receipt-json")).toContainText("fixture-replay");
    await expect(page.locator("#receipt-json")).toContainText('"approvedMaxBytes": 128000');
    await expect(page.locator("#receipt-json")).toContainText('"resultBytes"');
    await page.evaluate(() => window.__HONUA_SAFE_AGENT__?.dispose());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SAFE_AGENT__?.disposed)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SAFE_AGENT__?.state)).toBe("cancelled");
    await expect(page.locator("#state-value")).toHaveText("executed");
    await page.getByRole("button", { name: "Reset fixture" }).click();
    await expect(page.locator("#state-value")).toHaveText("executed");
    expect(errors).toEqual([]);
  });
});

test("narrow and refusal paths remain explicit and effect-free", async ({ page }) => {
  await withServer(async (url) => {
    await page.goto(url);
    await page.getByRole("button", { name: "Validate against policy" }).click();
    await page.getByRole("button", { name: "Narrow to 2 rows" }).click();
    await page.getByRole("button", { name: "Execute approved read" }).click();
    await expect(page.locator("#row-count")).toHaveText("2");

    await page.getByRole("button", { name: "Mutation", exact: true }).click();
    await expect(page.locator("#plan-state")).toContainText("Refused");
    await expect(page.locator("#plan-details")).toContainText("Mutation requires a separate host capability");
    await expect(page.locator("#effect-count")).toHaveText("0");
    await expect(page.getByRole("button", { name: "Execute approved read" })).toBeDisabled();
  });
});

test("keyboard workflow and mobile layout expose status without console errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await withServer(async (url) => {
    await page.goto(url);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to workflow" })).toBeFocused();
    await page.getByRole("link", { name: "Skip to workflow" }).press("Enter");
    await expect(page.locator("#workflow")).toBeInViewport();
    await expect(page.getByRole("heading", { name: "Agent proposal" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("No source or tool effect");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
    expect(errors).toEqual([]);
  });
});
