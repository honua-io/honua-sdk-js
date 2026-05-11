import { expect, test } from "@playwright/test";

import { startAppBootstrapFixtureServer } from "../../examples/app-bootstrap-basic/mock-server.mjs";

test.setTimeout(90_000);

test("app bootstrap renders inline and hosted packages and reports an auth error state", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startAppBootstrapFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_APP_BOOTSTRAP_DEMO__?.ready)).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_APP_BOOTSTRAP_DEMO__?.mapNonBlank())).toBe(true);
    await expect(page.locator("#events")).toContainText("runtime-ready");

    await page.goto(`${server.url}?mode=url`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_APP_BOOTSTRAP_DEMO__?.ready)).toBe(true);
    await expect(page.locator("#summary")).toHaveText("2 layers ready");

    await page.goto(`${server.url}?mode=error`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_APP_BOOTSTRAP_DEMO__?.status)).toBe("error");
    await expect(page.locator("#summary")).toContainText("HTTP 401");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
