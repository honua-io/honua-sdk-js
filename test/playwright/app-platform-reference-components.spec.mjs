import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

test.setTimeout(90_000);

test("reference workbench production components register and expose their keyboard contract", async ({ page }) => {
  const server = await startWebComponentsFixtureServer({ build: process.env.HONUA_SKIP_FIXTURE_BUILD !== "true" });
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_WEB_COMPONENTS_DEMO__?.ready === true)).toBe(true);
    await expect
      .poll(async () => page.evaluate(() => customElements.get("honua-feature-inspection") !== undefined))
      .toBe(true);

    await page.evaluate(() => {
      const inspection = document.createElement("honua-feature-inspection");
      inspection.id = "reference-feature-inspection";
      inspection.setAttribute("label", "Incident inspection");
      document.body.append(inspection);
    });

    const inspection = page.locator("#reference-feature-inspection");
    await expect(inspection.locator("section[aria-label='Incident inspection']")).toHaveAttribute("aria-busy", "false");
    const search = inspection.locator("input[type='search']");
    await expect(search).toHaveAttribute("role", "combobox");
    await expect(inspection).toHaveScreenshot("feature-inspection.png", {
      animations: "disabled",
      caret: "hide",
    });
    await inspection.getByRole("button", { name: "Search" }).press("/");
    await expect(search).toBeFocused();

    await expect
      .poll(() =>
        page.evaluate(() =>
          ["honua-feature-editor", "honua-feature-table"].every((tag) => customElements.get(tag) !== undefined),
        ),
      )
      .toBe(true);
  } finally {
    await server.close();
  }
});
