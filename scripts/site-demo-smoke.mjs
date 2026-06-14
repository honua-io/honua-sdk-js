#!/usr/bin/env node
// =============================================================================
//  site-demo-smoke.mjs - drive the honua-site demo pages in a real browser and
//  report whether each one actually works against the live demo.honua.io server.
//
//  Tests the DEMOS THEMSELVES (page loads, controls init, no JS errors, no
//  broken server calls) - the companion to demo-health.html (which probes the
//  server). Reuses the Playwright + Chromium already installed in this repo.
//
//  PREREQ: serve honua-site on the CORS-allowed origin first:
//     python -m http.server 8123 --bind 127.0.0.1 --directory <path-to>/honua-site
//
//  USAGE (from honua-sdk-js):
//     node scripts/site-demo-smoke.mjs                 # headed, watch it drive all demos
//     HEADLESS=1 node scripts/site-demo-smoke.mjs      # quiet, just the report (CI)
//     node scripts/site-demo-smoke.mjs demo-editing    # run one demo by id
//     PAUSE=1 node scripts/site-demo-smoke.mjs demo     # open Playwright Inspector to take over
//
//  Env: SITE_BASE (default http://localhost:8123), SHOT_DIR (screenshot dir).
// =============================================================================
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";

// Resolve Playwright from local node_modules, the npx cache, or the global root,
// so this runs even when the repo hasn't been `npm install`ed.
function loadChromium() {
  const heredir = path.dirname(fileURLToPath(import.meta.url));
  const bases = [path.join(heredir, "..")];
  const npxCache = path.join(process.env.LOCALAPPDATA || process.env.HOME || "", "npm-cache", "_npx");
  if (existsSync(npxCache)) for (const d of readdirSync(npxCache)) bases.push(path.join(npxCache, d));
  try { bases.push(execSync("npm root -g", { encoding: "utf8" }).trim().replace(/[\/\\]node_modules$/, "")); } catch (_) {}
  for (const base of bases) {
    const req = createRequire(path.join(base, "noop.cjs"));
    for (const pkg of ["@playwright/test", "playwright", "playwright-core"]) {
      try {
        const pw = req(pkg);
        if (pw?.chromium) return pw.chromium;
      } catch (_) {}
    }
  }
  console.error("Could not resolve Playwright. Run once:  npx playwright install chromium");
  process.exit(2);
}
const chromium = loadChromium();

const BASE = (process.env.SITE_BASE || "http://localhost:8123").replace(/\/+$/, "");
const HEADLESS = process.env.HEADLESS === "1";
const PAUSE = process.env.PAUSE === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = process.env.SHOT_DIR || path.join(here, "..", ".demo-smoke");

// id -> page file + a key selector that proves the demo rendered.
const DEMOS = [
  { id: "demos",              file: "demos.html",                ready: "a[href*='demo'], main" },
  { id: "demo",               file: "demo.html",                 ready: "canvas" },
  { id: "demo-analyst-workbench", file: "demo-analyst-workbench.html", ready: "canvas" },
  { id: "demo-two-protocols", file: "demo-two-protocols.html",   ready: "canvas, pre, table" },
  { id: "demo-public-safety", file: "demo-public-safety.html",   ready: "canvas" },
  { id: "demo-esri-leaflet",  file: "demo-esri-leaflet.html",    ready: ".leaflet-container, canvas" },
  { id: "demo-editing",       file: "demo-editing.html",         ready: "canvas" },
  { id: "demo-imagery-terrain", file: "demo-imagery-terrain.html", ready: "canvas" },
  { id: "demo-maui-3d",       file: "demo-maui-3d.html",         ready: "canvas" },
  { id: "demo-sdk-controls",  file: "demo-sdk-controls.html",    ready: "canvas, honua-legend, honua-basemap-switcher" },
];

const only = process.argv[2];
const targets = only ? DEMOS.filter((d) => d.id === only) : DEMOS;
if (only && targets.length === 0) {
  console.error(`No demo with id "${only}". Known: ${DEMOS.map((d) => d.id).join(", ")}`);
  process.exit(2);
}

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];

const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 150 });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

for (const d of targets) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];

  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 400) badResponses.push(`${s} ${r.url().replace(/\?.*$/, "")}`);
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText || "";
    // ERR_ABORTED is almost always a tile/range fetch cancelled when the page is
    // torn down or the map stops needing it - not a real failure. Ignore it.
    if (err.includes("ERR_ABORTED")) return;
    badResponses.push(`FAILED ${err} ${r.url().replace(/\?.*$/, "")}`);
  });

  const url = `${BASE}/${d.file}`;
  let readyFound = false;
  let navOk = true;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // let map/controls + first data calls settle
    try { await page.waitForSelector(d.ready, { timeout: 8000, state: "attached" }); readyFound = true; } catch (_) {}
    // let map tiles finish so we don't tear down mid-fetch (avoids false ERR_ABORTED)
    try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch (_) {}
    await page.waitForTimeout(3500);
  } catch (e) {
    navOk = false;
    pageErrors.push(`nav: ${String(e.message || e).slice(0, 200)}`);
  }

  const shot = path.join(SHOT_DIR, `${d.id}.png`);
  try { await page.screenshot({ path: shot, fullPage: false }); } catch (_) {}

  // classify (parse the host exactly; substring matching would accept spoofed hosts)
  const serverBad = badResponses.filter((b) => {
    const m = b.match(/https?:\/\/[^\s]+/);
    try { return m ? new URL(m[0]).hostname === "demo.honua.io" : false; } catch (_) { return false; }
  });
  let status = "ok";
  if (!navOk || pageErrors.length) status = "bad";
  else if (!readyFound || consoleErrors.length || serverBad.length) status = "warn";

  results.push({ id: d.id, status, readyFound, pageErrors, consoleErrors, badResponses, shot });

  if (PAUSE) {
    console.log(`\n[PAUSE] ${d.id} loaded at ${url} - interact in the browser; resume from the Inspector.`);
    await page.pause();
  }
  await page.close();
}

await browser.close();

// ---- report ----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const icon = { ok: "OK  ", warn: "WARN", bad: "BAD " };
let ok = 0, warn = 0, bad = 0;
console.log(`\nhonua-site demo smoke - ${BASE}  (screenshots: ${SHOT_DIR})\n`);
for (const r of results) {
  r.status === "ok" ? ok++ : r.status === "warn" ? warn++ : bad++;
  console.log(`${icon[r.status]}  ${pad(r.id, 26)} ${r.readyFound ? "rendered" : "no-ready-selector"}`);
  for (const e of r.pageErrors) console.log(`        js-error:   ${e}`);
  for (const e of r.consoleErrors.slice(0, 3)) console.log(`        console:    ${e}`);
  for (const e of [...new Set(r.badResponses)].slice(0, 5)) console.log(`        http:       ${e}`);
}
console.log(`\n${ok} ok · ${warn} warn · ${bad} bad  (of ${results.length})`);
process.exit(bad > 0 ? 1 : 0);
