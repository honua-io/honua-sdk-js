import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { startCatalogComponentsServer } from "../fixtures/catalog-components/server.mjs";

test("catalog search stays keyboard accessible at 390px under restrictive response CSP", async ({ page }) => {
  const server = await startCatalogComponentsServer();
  const violations = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("recordViolation", value => violations.push(value));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", event => window.recordViolation({directive:event.violatedDirective, blocked:event.blockedURI, source:event.sourceFile, line:event.lineNumber})));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto(server.url);
    expect(response.headers()["content-security-policy"]).not.toContain("unsafe-inline");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    const search = page.locator("honua-catalog-search");
    await expect(search.locator("article")).toHaveCount(2);
    const endpoints = page.locator("honua-service-endpoints");
    await expect(endpoints.getByRole("link")).toHaveCount(2);
    await endpoints.getByRole("button").first().focus();
    await page.keyboard.press("Enter");
    await expect(endpoints.getByRole("status")).toContainText(/Copied|Copy is unavailable/);
    const apps = page.locator("honua-apps-using");
    await expect(apps.locator("article")).toHaveCount(1);
    await apps.getByRole("button", { name: "Next", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(apps.getByRole("button", { name: "Previous", exact: true })).toBeFocused();
    await expect(apps.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await search.getByRole("searchbox").focus();
    await page.keyboard.type("flood");
    await page.keyboard.press("Enter");
    await expect(search.getByRole("status")).toContainText("items");
    await expect(search.getByRole("searchbox")).toBeFocused();
    await search.getByRole("searchbox").fill("");
    await page.keyboard.press("Enter");
    await search.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(search.getByRole("combobox", { name: "Kind", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("catalog-search-390.png"), fullPage: true });
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test("catalog search passes axe including contrast in light and dark themes", async ({ browser }) => {
  const server = await startCatalogComponentsServer();
  // Axe creates inline styles while inspecting shadow stylesheets; CSP has its own unmodified context above.
  const context = await browser.newContext({ bypassCSP: true });
  try {
    const page = await context.newPage();
    for (const [width, colorScheme] of [[390, "light"], [1440, "dark"]]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      await page.goto(server.url);
      await expect(page.locator("honua-catalog-search article")).toHaveCount(2);
      await page.locator("honua-catalog-search summary").click();
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`catalog-search-${width}-${colorScheme}.png`), fullPage: true });
    }
  } finally {
    await context.close();
    await server.close();
  }
});
