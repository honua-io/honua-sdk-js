import { expect, test } from "@playwright/test";

import { startStacBrowserFixtureServer } from "../../examples/stac-imagery-browser/mock-server.mjs";

test.setTimeout(90_000);

test("STAC Walkthrough proves Maui search, pagination, signing, rendering, and cancellation", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));

  const server = await startStacBrowserFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_STAC_BROWSER__?.ready === true)).toBe(true);

    await expect(page.getByRole("heading", { name: "Find the clearest recent view of Maui." })).toBeVisible();
    await expect(page.locator("#method-state")).toHaveText("POST Item Search");
    await expect(page.locator("#page-state")).toContainText("2 loaded / ready for next page");
    await expect(page.locator("#result-list")).toContainText("West Maui cloud break");
    await expect(page.locator("#item-metadata")).toContainText("None required");
    await expect(page.locator("#asset-preview")).toBeVisible();
    await expect(page.locator("#asset-preview")).toHaveAttribute("src", /^blob:/);
    await expect(page.locator("#network-log")).toContainText("POST  /v1/search");
    await expect(page.locator("#network-log")).toContainText("SIGN");

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.loadNext());
    await expect(page.locator("#page-state")).toContainText("3 loaded / ready for next page");
    await expect(page.locator("#result-list")).toContainText("Haleakala east slope");
    expect(
      await page.evaluate(() =>
        window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => ({ method: entry.method, pathname: new URL(entry.url).pathname })),
      ),
    ).toEqual([
      { method: "POST", pathname: "/v1/search" },
      { method: "POST", pathname: "/v1/search" },
    ]);
    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.loadNext());
    await expect(page.locator("#page-state")).toContainText("3 loaded / complete");

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.search("GET"));
    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.loadNext());
    expect(
      await page.evaluate(() =>
        window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => entry.method),
      ),
    ).toEqual(["GET", "GET"]);

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.search("POST"));
    const overlap = await page.evaluate(async () => {
      const image = document.querySelector("#asset-preview");
      const oldPreview = image?.getAttribute("src");
      const oldPage = window.__HONUA_STAC_BROWSER__?.loadNext();
      const newSearch = window.__HONUA_STAC_BROWSER__?.search("GET");
      const previewCleared = image?.hidden === true && !image.hasAttribute("src");
      await newSearch;
      await oldPage;
      return {
        previewCleared,
        oldPreview,
        newPreview: image?.getAttribute("src"),
        loadedCount: window.__HONUA_STAC_BROWSER__?.loadedCount,
        status: window.__HONUA_STAC_BROWSER__?.paginationStatus,
        selectedItemId: window.__HONUA_STAC_BROWSER__?.selectedItemId,
        searchMethods: window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => entry.method),
      };
    });
    expect(overlap).toMatchObject({
      previewCleared: true,
      loadedCount: 2,
      status: "ready for next page",
      selectedItemId: "S2B_MAUI_20260502_WEST",
      searchMethods: ["GET"],
    });
    expect(overlap.newPreview).toMatch(/^blob:/);
    expect(overlap.newPreview).not.toBe(overlap.oldPreview);

    await page.evaluate(async () => {
      await window.__HONUA_STAC_BROWSER__?.search("POST");
      const pending = window.__HONUA_STAC_BROWSER__?.loadNext();
      await new Promise((resolve) => setTimeout(resolve, 10));
      window.__HONUA_STAC_BROWSER__?.cancelPagination();
      await pending;
    });
    await expect(page.locator("#page-state")).toContainText("cancelled");
    expect(await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.trace.some((entry) => entry.stage === "cancel"))).toBe(
      true,
    );

    const signedBefore = await page.evaluate(
      () => window.__HONUA_STAC_BROWSER__?.trace.filter((entry) => entry.stage === "sign").length,
    );
    await page.evaluate(() =>
      window.__HONUA_STAC_BROWSER__?.selectAsset("S2B_MAUI_20260502_WEST", "metadata"),
    );
    await expect(page.locator("#handoff-state")).toContainText("no executable SDK handoff");
    expect(
      await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.trace.filter((entry) => entry.stage === "sign").length),
    ).toBe(signedBefore);

    await expect(page.getByRole("link", { name: "Open the complete project" })).toHaveAttribute(
      "href",
      "https://github.com/honua-io/honua-sdk-js/tree/trunk/examples/stac-imagery-browser",
    );
    await expect(page.locator(".code-panel pre")).toContainText("createDynamicStacClient");
    await expect(page.locator("#handoff-list")).toContainText("@honua/sdk-js/raster");
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await server.close();
  }
});
