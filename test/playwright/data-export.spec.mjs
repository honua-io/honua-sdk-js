import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let script;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: 'import {defineHonuaDataExport} from "./src/controls/data-export-element.ts"; defineHonuaDataExport();', resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  script = bundle.outputFiles[0].text;
});
async function mount(page) {
  await page.setContent('<main style="font:16px system-ui;padding:16px"><h2>Export results</h2><honua-data-export></honua-data-export></main>');
  await page.addScriptTag({ content: script });
}
async function setRows(page, rows) {
  await page.locator("honua-data-export").evaluate((element, data) => {
    element.fields = ["name"];
    element.rows = data;
  }, rows);
}
const rows = [{ id: 17, attributes: { name: "Filtered parcel", hidden: "Not selected" }, geometry: { type: "Point", coordinates: [-157, 21] } }];

test("downloads the filtered snapshot using native keyboard buttons", async ({ page }) => {
  await mount(page);
  await expect(page.getByRole("button", { name: "Download CSV", exact: true })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("No rows");
  await setRows(page, rows);
  const csv = page.getByRole("button", { name: "Download CSV", exact: true });
  await csv.focus();
  const pendingCsv = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await pendingCsv;
  expect(download.suggestedFilename()).toBe("data.csv");
  expect(await readFile(await download.path(), "utf8")).toBe('"name"\r\n"Filtered parcel"\r\n');
  await expect(page.getByRole("status")).toHaveText("Downloaded 1 filtered row.");
  const pendingGeoJson = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GeoJSON" }).focus();
  await page.keyboard.press("Space");
  const geojson = JSON.parse(await readFile(await (await pendingGeoJson).path(), "utf8"));
  expect(geojson.features[0]).toEqual({ type: "Feature", id: 17, properties: { name: "Filtered parcel" }, geometry: rows[0].geometry });
  await setRows(page, [{ attributes: { name: "New filter" }, geometry: null }]);
  const pendingUpdated = page.waitForEvent("download");
  await csv.click();
  expect(await readFile(await (await pendingUpdated).path(), "utf8")).toContain("New filter");
});

test("unsafe exports emit a fixed error and no download", async ({ page }) => {
  await mount(page);
  await setRows(page, [{ attributes: { name: "https://example.com/?token=private-value" } }]);
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.locator("honua-data-export").evaluate((element) => {
    element.addEventListener("honua-data-export-error", (event) => { element.dataset.error = event.detail.message; });
  });
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Export could not be created");
  expect(await page.locator("honua-data-export").getAttribute("data-error")).not.toContain("private-value");
  expect(downloads).toEqual([]);
});

test("narrow, enlarged text layout stays within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await mount(page);
  await setRows(page, rows);
  await page.locator("main").evaluate((element) => { element.style.fontSize = "32px"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Download GeoJSON" })).toBeInViewport();
});
