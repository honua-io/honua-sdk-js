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

process.stdout.write("browserBundleSmoke=ok\n");
