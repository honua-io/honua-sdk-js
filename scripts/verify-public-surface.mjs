#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROJECT_ROOT,
  entrypointsInTier,
  loadPublicSurface,
  packageSubpath,
  sourceFileForExport,
} from "./lib/public-surface.mjs";

const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const surface = loadPublicSurface();
const failures = [];

function fail(message) {
  failures.push(message);
}

function compareOrdered(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} mismatch\n    expected: ${expected.join(", ")}\n    actual:   ${actual.join(", ")}`);
  }
}

function tableSubpaths(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    fail(`INSTALL.md is missing "## ${heading}"`);
    return [];
  }
  const found = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s+/.test(lines[index])) break;
    const match = /^\|\s*`(@honua\/sdk-js(?:\/[^`]+)?)`/.exec(lines[index]);
    if (match) found.push(packageSubpath(match[1]));
  }
  return found;
}

function versionLine(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Unsupported semver: ${version}`);
  return match.slice(1).map(Number);
}

function reachedRemovalVersion(current, removeIn) {
  const [currentMajor, currentMinor] = versionLine(current);
  const [removeMajor, removeMinor] = versionLine(removeIn);
  return currentMajor > removeMajor || (currentMajor === removeMajor && currentMinor >= removeMinor);
}

const manifestSubpaths = surface.entrypoints.map((entrypoint) => entrypoint.subpath);
const exportedSubpaths = Object.keys(packageJson.exports ?? {});
compareOrdered(
  "config/public-surface.json vs package.json exports",
  [...manifestSubpaths].sort(),
  [...exportedSubpaths].sort(),
);
if (!packageJson.files?.includes("config/public-surface.json")) {
  fail("package.json files must publish config/public-surface.json for downstream docs/sample projection");
}

if (new Set(manifestSubpaths).size !== manifestSubpaths.length) {
  fail("config/public-surface.json contains duplicate subpaths");
}

const allowedTiers = new Set(["stable", "experimental", "deprecated"]);
for (const entrypoint of surface.entrypoints) {
  if (!allowedTiers.has(entrypoint.tier)) fail(`${entrypoint.subpath} has unknown tier "${entrypoint.tier}"`);
}

const stable = entrypointsInTier(surface, "stable");
const experimental = entrypointsInTier(surface, "experimental");
const deprecated = entrypointsInTier(surface, "deprecated");

if (stable.length !== surface.ceilings.stableEntrypoints) {
  fail(
    `stable entrypoint count ${stable.length} exceeds or disagrees with reviewed ceiling ${surface.ceilings.stableEntrypoints}`,
  );
}

const install = fs.readFileSync(path.join(PROJECT_ROOT, "INSTALL.md"), "utf8");
compareOrdered(
  "INSTALL.md stable table",
  tableSubpaths(install, "Stable subpath entrypoints"),
  stable.map((entrypoint) => entrypoint.subpath),
);
compareOrdered(
  "INSTALL.md experimental table",
  tableSubpaths(install, "Experimental subpath entrypoints"),
  experimental.map((entrypoint) => entrypoint.subpath),
);
compareOrdered(
  "INSTALL.md deprecated table",
  tableSubpaths(install, "Deprecated compatibility entrypoints"),
  deprecated.map((entrypoint) => entrypoint.subpath),
);

for (const entrypoint of stable) {
  const source = fs.readFileSync(sourceFileForExport(packageJson, entrypoint.subpath), "utf8");
  const packageDocumentation = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
  if (/^\s*\*\s*@experimental\b/m.test(packageDocumentation)) {
    fail(`${entrypoint.subpath} is stable in the manifest but its package documentation says @experimental`);
  }
}

for (const entrypoint of experimental) {
  const source = fs.readFileSync(sourceFileForExport(packageJson, entrypoint.subpath), "utf8");
  const packageDocumentation = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
  if (!/^\s*\*\s*@experimental\b/m.test(packageDocumentation)) {
    fail(`${entrypoint.subpath} is experimental in the manifest but its package documentation lacks @experimental`);
  }
}

for (const entrypoint of deprecated) {
  if (!entrypoint.replacement || !entrypoint.introducedIn || !entrypoint.removeIn) {
    fail(`${entrypoint.subpath} must declare replacement, introducedIn, and removeIn`);
    continue;
  }
  const source = fs.readFileSync(sourceFileForExport(packageJson, entrypoint.subpath), "utf8");
  for (const required of ["@deprecated", entrypoint.replacement, entrypoint.removeIn]) {
    if (!source.includes(required)) fail(`${entrypoint.subpath} shim does not mention "${required}"`);
  }
  if (reachedRemovalVersion(packageJson.version, entrypoint.removeIn)) {
    fail(`${entrypoint.subpath} expired in ${entrypoint.removeIn}; remove the shim before releasing ${packageJson.version}`);
  }
}

const reportFile = path.join(PROJECT_ROOT, "api-report", "stable-api.json");
if (fs.existsSync(reportFile)) {
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const reported = report.stableEntrypoints.map((entrypoint) => packageSubpath(entrypoint.subpath));
  compareOrdered(
    "api-report/stable-api.json entrypoints",
    reported,
    stable.map((entrypoint) => entrypoint.subpath),
  );
  const root = report.stableEntrypoints.find((entrypoint) => entrypoint.subpath === "@honua/sdk-js");
  if (root && root.exportCount > surface.ceilings.rootTypeExports) {
    fail(`root type exports ${root.exportCount} exceed reviewed ceiling ${surface.ceilings.rootTypeExports}`);
  }
}

const builtRoot = path.join(PROJECT_ROOT, packageJson.exports["."].default);
const builtTargets = [...stable, ...experimental].map((entrypoint) => ({
  entrypoint,
  target: path.join(PROJECT_ROOT, packageJson.exports[entrypoint.subpath].default),
}));
let builtImportCount = 0;
if (fs.existsSync(builtRoot) && builtTargets.every(({ target }) => fs.existsSync(target))) {
  for (const { entrypoint, target } of builtTargets) {
    try {
      const imported = await import(pathToFileURL(target).href);
      if (entrypoint.subpath === "." && Object.keys(imported).length > surface.ceilings.rootRuntimeExports) {
        fail(
          `root runtime exports ${Object.keys(imported).length} exceed reviewed ceiling ${surface.ceilings.rootRuntimeExports}`,
        );
      }
      builtImportCount += 1;
    } catch (error) {
      fail(
        `${entrypoint.subpath} built-entrypoint import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

const budgets = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "bundle-budgets.json"), "utf8"));
if (budgets.entrypoints?.["."]?.gzip !== surface.ceilings.rootGzipBytes) {
  fail(
    `root gzip ceiling ${surface.ceilings.rootGzipBytes} disagrees with bundle-budgets.json (${budgets.entrypoints?.["."]?.gzip ?? "missing"})`,
  );
}

const readme = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf8");
if (!readme.includes(`The ${stable.length}-entrypoint stable tier`)) {
  fail(`README.md must state "The ${stable.length}-entrypoint stable tier"`);
}
if (!readme.includes(`${experimental.length} experimental subpaths`)) {
  fail(`README.md must state "${experimental.length} experimental subpaths"`);
}
if (!readme.includes(`${deprecated.length} deprecated compatibility subpaths`)) {
  fail(`README.md must state "${deprecated.length} deprecated compatibility subpaths"`);
}

if (failures.length > 0) {
  process.stderr.write("Public-surface verification FAILED:\n");
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `publicSurface=ok stable=${stable.length} experimental=${experimental.length} deprecated=${deprecated.length} total=${surface.entrypoints.length} imports=${builtImportCount || "skipped"}\n`,
);
