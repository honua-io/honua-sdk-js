import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../fixtures/web-components-host/mock-server.mjs";

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

async function populateInspection(page, presentation) {
  await page.evaluate((mode) => {
    const target = { sourceId: "incidents", id: 1 };
    const pageOf = (items) => ({ items, offset: 0, limit: 1, total: 2,
      hasPrevious: false, hasNext: true, truncated: false });
    const state = {
      status: "ready", origin: "map", activeIndex: 0,
      candidates: [{ target }, { target: { sourceId: "incidents", id: 2 } }],
      feature: { target, title: "Harbor incident", description: "Open response",
        fields: [{ name: "status", label: "Status", value: "open", text: "open" }],
        links: [{ label: "Incident report", href: "https://example.test/report", external: true }],
        attributes: { status: "open" } },
      attachments: pageOf([{ id: 1, parentId: 1, name: "Response photo", href: "https://example.test/photo" }]),
      relationships: [{ id: 3, label: "Assigned units", fields: [],
        page: pageOf([{ attributes: { name: "Engine 5" } }]) }],
      diagnostics: [{ code: "unsafe-link", message: "Unsafe link withheld." }],
      search: { status: "ready", query: "harbor", diagnostics: [], results: [
        { id: "incidents:1", target, title: "Harbor incident", subtitle: "Incidents",
          feature: { attributes: { name: "Harbor incident" } } },
      ] },
    };
    const inspection = document.createElement("honua-feature-inspection");
    inspection.id = "accessibility-inspection";
    inspection.setAttribute("presentation", mode);
    inspection.inspection = {
      snapshot: () => state,
      subscribe: (listener) => { listener(state); return { remove() {} }; },
    };
    document.body.append(inspection);
  }, presentation);
}

for (const presentation of ["panel", "popup"]) {
  test(`populated inspection ${presentation} passes automated accessibility checks`, async ({ page }, testInfo) => {
    const server = await startWebComponentsFixtureServer({ build: process.env.HONUA_SKIP_FIXTURE_BUILD !== "true" });
    try {
      await page.goto(server.url);
      await expect.poll(() => page.evaluate(() => customElements.get("honua-feature-inspection") !== undefined)).toBe(true);
      await populateInspection(page, presentation);
      const inspection = page.locator("#accessibility-inspection");
      await expect(inspection.getByRole("heading", { name: "Harbor incident" })).toBeVisible();
      await expect(inspection.getByRole("option")).toHaveCount(1);
      await expect(inspection.getByRole("button", { name: "Next attachments" })).toBeEnabled();
      await expect(inspection.getByRole("button", { name: "Next related" })).toBeEnabled();
      const results = await new AxeBuilder({ page }).include("#accessibility-inspection").analyze();
      await testInfo.attach("inspection-axe", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
      expect(results.violations).toEqual([]);
    } finally {
      await server.close();
    }
  });
}
