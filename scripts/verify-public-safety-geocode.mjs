#!/usr/bin/env node
// Functional check: does public-safety's dispatch search actually return live
// results from the maui-place-names FeatureServer (not the GNIS fixture)?
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";

function loadChromium() {
  const heredir = path.dirname(fileURLToPath(import.meta.url));
  const bases = [path.join(heredir, "..")];
  const npxCache = path.join(process.env.LOCALAPPDATA || process.env.HOME || "", "npm-cache", "_npx");
  if (existsSync(npxCache)) for (const d of readdirSync(npxCache)) bases.push(path.join(npxCache, d));
  try { bases.push(execSync("npm root -g", { encoding: "utf8" }).trim().replace(/[\/\\]node_modules$/, "")); } catch (_) {}
  for (const base of bases) {
    const req = createRequire(path.join(base, "noop.cjs"));
    for (const pkg of ["@playwright/test", "playwright", "playwright-core"]) {
      try { const pw = req(pkg); if (pw?.chromium) return pw.chromium; } catch (_) {}
    }
  }
  console.error("Could not resolve Playwright."); process.exit(2);
}

const BASE = process.env.SITE_BASE || "http://localhost:8123";
const QUERY = process.argv[2] || "Lahaina";
const chromium = loadChromium();
const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
const placeNamesCalls = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("response", (r) => { if (r.url().includes("maui-place-names") && r.url().includes("/query")) placeNamesCalls.push(r.status()); });

await page.goto(`${BASE}/demo-public-safety.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#ps-geocode-input", { timeout: 15000 });
await page.waitForTimeout(2500); // let probeGeocoding resolve the layer

const chip = (await page.textContent("#ps-geocode-chip").catch(() => "")) || "";
const note = (await page.textContent("#ps-geocode-note").catch(() => "")) || "";

await page.fill("#ps-geocode-input", QUERY);
await page.click("#ps-geocode-form button[type=submit]").catch(async () => { await page.press("#ps-geocode-input", "Enter"); });

let rows = [];
try {
  await page.waitForSelector("#ps-geocode-results li", { timeout: 12000 });
  rows = await page.$$eval("#ps-geocode-results li", (lis) => lis.map((li) => li.textContent.trim().replace(/\s+/g, " ")));
} catch (_) {}

await browser.close();

const live = placeNamesCalls.length > 0 && placeNamesCalls.every((s) => s === 200);
console.log(`chip : ${chip.trim()}`);
console.log(`note : ${note.trim()}`);
console.log(`place-names /query responses: [${placeNamesCalls.join(", ") || "none"}]`);
console.log(`results for "${QUERY}" (${rows.length}):`);
rows.slice(0, 6).forEach((r) => console.log("  - " + r));
if (errors.length) { console.log("console errors:"); errors.slice(0, 4).forEach((e) => console.log("  ! " + e)); }

const ok = live && rows.length > 0 && rows.some((r) => /locator/i.test(r));
console.log(`\n${ok ? "PASS" : "FAIL"}: live place-names search ${ok ? "returned results" : "did NOT confirm live results"}`);
process.exit(ok ? 0 : 1);
