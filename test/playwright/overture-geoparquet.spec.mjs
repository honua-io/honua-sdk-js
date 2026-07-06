import { expect, test } from "@playwright/test";

import { startOvertureFixtureServer } from "../../examples/overture-geoparquet/mock-server.mjs";

// DuckDB-WASM instantiation + the first query can take a while on a cold start.
test.setTimeout(120_000);

test("Overture GeoParquet Explorer queries a committed extract via DuckDB-WASM", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const server = await startOvertureFixtureServer();
  try {
    await page.goto(server.url);

    // Wait for DuckDB-WASM to boot and profile the fixture.
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_OVERTURE__?.ready === true), { timeout: 90_000 })
      .toBe(true);

    await expect(page.locator("#engine-state")).toContainText("DuckDB-WASM ready");
    await expect(page.locator("#schema-state")).toContainText("id");
    await expect(page.locator("#rows-state")).toContainText("8");

    // Initial query renders all 8 places with preserved GERS ids.
    await expect(page.locator("#result-body tr")).toHaveCount(8);
    await expect(page.locator("#result-body")).toContainText("08f2a3c1d4e5f601");
    await expect(page.locator("#result-summary")).toContainText("GERS ids preserved");

    // A category filter compiles to a WHERE clause and narrows the result.
    await page.selectOption("#category", "beach");
    await page.getByRole("button", { name: "Run Query" }).click();
    await expect(page.locator("#result-body tr")).toHaveCount(2);
    await expect(page.locator("#result-body")).toContainText("Waikiki Beach");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
