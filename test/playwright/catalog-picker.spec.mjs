import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let script;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import {HonuaCatalogPicker} from "./src/controls/catalog-picker.ts";
        import {defineHonuaCatalogPicker} from "./src/controls/catalog-picker-element.ts";
        defineHonuaCatalogPicker(); window.HonuaCatalogPicker = HonuaCatalogPicker;`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  script = bundle.outputFiles[0].text;
});

async function mount(page) {
  await page.setContent('<main style="font:16px system-ui;padding:16px"><h2>Choose analysis data</h2><honua-catalog-picker></honua-catalog-picker></main>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    window.requests = [];
    window.removed = 0;
    const control = document.querySelector("honua-catalog-picker");
    control.picker = new window.HonuaCatalogPicker({
      collectionId: "datasets",
      client: { searchOgcRecords: async options => {
        window.requests.push(options.q);
        if (options.q === "empty") return { features: [] };
        if (options.q === "error") throw new Error("private-token-value");
        return { features: [{ id: options.q, properties: { title: options.q, description: "Choose this dataset" } }] };
      } },
      resolve: async record => {
        if (record.id === "unsupported") return undefined;
        const source = { descriptor: { id: record.id } };
        return { record, source, dataset: { id: record.id }, layer: { sourceId: record.id, layerIds: [record.id], remove: () => { window.removed++; } } };
      },
    });
    control.addEventListener("honua-catalog-select", event => {
      window.selection = event.detail;
      window.tableSource = event.detail.source;
      window.chartSource = event.detail.source;
    });
  });
}

async function search(page, value) {
  await page.getByRole("searchbox", { name: "Search datasets" }).fill(value);
  await page.getByRole("searchbox").press("Enter");
}

test("keyboard search and selection share one source with map, table and chart", async ({ page }) => {
  await mount(page);
  await search(page, "Parcels");
  const result = page.getByRole("button", { name: "Parcels Choose this dataset" });
  await result.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Dataset selected.");
  await expect(result).toBeFocused();
  expect(await page.evaluate(() => ({
    same: window.selection.source === window.tableSource && window.tableSource === window.chartSource,
    map: window.selection.layer.sourceId, dataset: window.selection.dataset.id,
  }))).toEqual({ same: true, map: "Parcels", dataset: "Parcels" });
  await search(page, "Roads");
  await page.getByRole("button", { name: "Roads Choose this dataset" }).click();
  expect(await page.evaluate(() => window.removed)).toBe(1);
});

test("empty, unsupported, and error states are safe and recoverable", async ({ page }) => {
  await mount(page);
  await search(page, "empty");
  await expect(page.getByRole("status")).toContainText("No datasets found");
  await search(page, "unsupported");
  await page.getByRole("button", { name: "unsupported Choose this dataset" }).click();
  await expect(page.getByRole("status")).toContainText("cannot be opened");
  await search(page, "error");
  await expect(page.getByRole("status")).toContainText("request failed");
  await expect(page.locator("body")).not.toContainText("private-token-value");
  await search(page, '<img src=x onerror="window.injected=true">');
  await expect(page.getByRole("button", { name: /<img/ })).toBeVisible();
  expect(await page.evaluate(() => Boolean(window.injected))).toBe(false);
  expect(await page.locator("honua-catalog-picker").evaluate(el => el.shadowRoot.querySelectorAll("img").length)).toBe(0);
});

test("narrow enlarged text remains within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await mount(page);
  await page.locator("main").evaluate(el => { el.style.fontSize = "32px"; });
  await search(page, "A very long catalog dataset title with a useful description");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: /A very long catalog/ })).toBeVisible();
});
