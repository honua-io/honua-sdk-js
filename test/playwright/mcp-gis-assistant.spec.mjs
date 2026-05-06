import { expect, test } from "@playwright/test";

import { startMcpGisAssistantFixtureServer } from "../../examples/mcp-gis-assistant/mock-server.mjs";

test.setTimeout(90_000);

test("MCP GIS Assistant discovers metadata, reviews a filter, and applies bounded results", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startMcpGisAssistantFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_MCP_GIS_ASSISTANT__?.ready === true)).toBe(true);

    await expect(page.locator("#assistant-answer")).toContainText("Honolulu Operations");
    await expect(page.locator("#tool-calls")).toContainText("list_services");
    await expect(page.locator("#diagnostics")).toContainText("Cloud credentials missing");
    await expect(page.locator("#feature-count")).toHaveText("3");

    await page.getByRole("button", { name: "Draft Filter" }).click();
    await expect(page.locator("#draft-review")).toContainText("status = 'open' AND priority = 'critical'");
    await expect(page.locator("#bounded-summary")).toHaveText("2/2 returned");
    await expect(page.locator("#feature-count")).toHaveText("3");

    await page.getByRole("button", { name: "Apply Filter" }).click();
    await expect(page.locator("#feature-count")).toHaveText("2");
    await expect(page.locator("#feature-table")).toContainText("Harbor debris response");
    await expect(page.locator("#feature-table")).toContainText("Kakaako grid outage");

    await page.getByRole("button", { name: "Capabilities" }).click();
    await expect(page.locator("#assistant-answer")).toContainText("Realtime is unsupported");
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
