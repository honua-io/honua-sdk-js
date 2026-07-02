#!/usr/bin/env node

/**
 * Smoke-verify the prebuilt browser bundles that back the advertised CDN /
 * build-less usage (package.json `browser`/`unpkg`/`jsdelivr` and the
 * `./browser` export, plus the README jsdelivr/unpkg/esm.sh docs).
 *
 * The published root package historically shipped without `dist/browser/*`
 * because `build:browser` was never invoked in CI or the publish pipeline, so
 * the `./browser` subpath export and every CDN path silently broke on install.
 * This guard fails loudly when the bundles are missing or do not expose the
 * documented entry points, so the regression cannot ship again.
 *
 * Run `npm run build:browser` first (CI does so before this check).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const BROWSER_DIR = path.join(PROJECT_ROOT, "dist", "browser");

const IIFE_BUNDLE = path.join(BROWSER_DIR, "honua-sdk.min.js");
const ESM_BUNDLE = path.join(BROWSER_DIR, "honua-sdk.esm.js");
const GLOBAL_NAME = "HonuaSDK";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write('Run "npm run build:browser" to produce the browser bundles before publishing.\n');
  process.exit(1);
}

for (const bundle of [IIFE_BUNDLE, ESM_BUNDLE]) {
  if (!fs.existsSync(bundle)) {
    fail(`Missing browser bundle: ${path.relative(PROJECT_ROOT, bundle)}`);
  }
  const { size } = fs.statSync(bundle);
  if (size === 0) {
    fail(`Browser bundle is empty: ${path.relative(PROJECT_ROOT, bundle)}`);
  }
}

const iifeSource = fs.readFileSync(IIFE_BUNDLE, "utf8");
if (!iifeSource.includes(GLOBAL_NAME)) {
  fail(`IIFE bundle ${path.relative(PROJECT_ROOT, IIFE_BUNDLE)} does not define the "${GLOBAL_NAME}" global.`);
}

const esmSource = fs.readFileSync(ESM_BUNDLE, "utf8");
if (!/\bexport\s*[{*]/.test(esmSource)) {
  fail(`ESM bundle ${path.relative(PROJECT_ROOT, ESM_BUNDLE)} does not expose any named export.`);
}

// "Consume the published artifact" smoke: the ESM bundle must expose the primary
// public entry point (`HonuaClient`) so build-less / CDN consumers can actually
// `import { HonuaClient }` from it, not just any anonymous export.
if (!/\bHonuaClient\b/.test(esmSource)) {
  fail(`ESM bundle ${path.relative(PROJECT_ROOT, ESM_BUNDLE)} does not export the public "HonuaClient" entry point.`);
}

// The bundle only ships to consumers if package.json both (a) advertises the
// browser entry points and (b) includes dist/browser in the published `files`.
// Historically the advertised CDN paths pointed at files that were never built
// or never packed. Assert every advertised path resolves to a real file and
// that the publish `files` allowlist actually ships dist/browser, so the
// regression ("published @honua/sdk-js ships without the browser bundle it
// advertises") cannot recur.
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

const advertisedEntryPoints = [
  ["browser", packageJson.browser],
  ["unpkg", packageJson.unpkg],
  ["jsdelivr", packageJson.jsdelivr],
  ["exports['./browser'].default", packageJson.exports?.["./browser"]?.default],
  ["exports['./browser'].types", packageJson.exports?.["./browser"]?.types],
];

for (const [field, target] of advertisedEntryPoints) {
  if (!target) {
    fail(`package.json does not advertise a browser entry point for "${field}".`);
  }
  const resolved = path.resolve(PROJECT_ROOT, target);
  if (!fs.existsSync(resolved)) {
    fail(`package.json "${field}" points at "${target}", which does not exist. Run "npm run build:browser".`);
  }
}

const publishedFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
const shipsBrowserDir = publishedFiles.some((entry) => {
  const normalized = String(entry).replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "dist/browser" || normalized === "dist" || normalized.startsWith("dist/browser/");
});
if (!shipsBrowserDir) {
  fail('package.json "files" does not include "dist/browser"; the published package would omit the browser bundle.');
}

process.stdout.write("browserBundleSmoke=ok\n");
