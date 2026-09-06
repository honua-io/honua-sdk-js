#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_ROOT = path.resolve(EXAMPLE_ROOT, "../..");
const LOCKFILE_PATH = path.join(EXAMPLE_ROOT, "package-lock.json");
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Temporary, Kepler-example-only exception for upstream advisories that have
// no fixed release. A short lifetime forces a fresh dependency review rather
// than allowing this policy to become a permanent audit bypass.
//
// Renewed 2026-08-23. The review that renews it, in full, so the next reviewer
// can tell what was checked rather than trusting that something was:
//
//   - Both advisories are still unfixed at every published version. The GitHub
//     Advisory API reports `first_patched_version: null` with a vulnerable
//     range of `<= 2.0.2` for each, and 2.0.2 is the latest image-size on npm.
//     There is no version to upgrade to; this is not a deferred upgrade.
//   - The reviewed edge is unchanged and is already current.
//     `texture-compressor@1.0.2` -- the latest release -- still declares
//     `image-size: ^0.7.4`, resolving to 0.7.5 in the lock. Bumping
//     texture-compressor would not move image-size.
//   - Both advisories are denial-of-service through infinite loops in the JXL,
//     HEIF, and ICNS parsers. This example never decodes those formats;
//     image-size arrives only through @loaders.gl/textures -> texture-compressor
//     and is not reachable from any Kepler sample path.
//
// Renew only after repeating those three checks. If a patched image-size is
// ever published, take the upgrade and delete this exception instead.
export const IMAGE_SIZE_EXCEPTION = Object.freeze({
  reviewedOn: "2026-09-02",
  expiresOn: "2026-09-16",
  packageName: "image-size",
  packageVersion: "0.7.5",
  advisories: Object.freeze({
    "GHSA-5p2g-fcmc-qvqq": Object.freeze({
      source: 1138809,
      title: "image-size: JXL and HEIF parsers allow denial of service through infinite loops",
      url: "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
    }),
    "GHSA-w3rx-r6r6-pgpr": Object.freeze({
      source: 1138808,
      title: "image-size: ICNS parser allows denial of service through an infinite loop",
      url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
    }),
  }),
});

const EXPECTED_VULNERABILITIES = Object.freeze({
  "@deck.gl/geo-layers": {
    direct: false,
    via: ["@loaders.gl/3d-tiles"],
    effects: ["@kepler.gl/deckgl-layers"],
    range: ">=8.6.6",
    fixAvailable: true,
    nodes: { "node_modules/@deck.gl/geo-layers": "8.9.36" },
  },
  "@deck.gl/mesh-layers": {
    direct: false,
    via: ["@loaders.gl/gltf"],
    effects: [],
    range: ">=8.6.6",
    fixAvailable: true,
    nodes: { "node_modules/@deck.gl/mesh-layers": "8.9.36" },
  },
  "@kepler.gl/actions": {
    direct: true,
    via: ["@kepler.gl/layers", "@kepler.gl/processors"],
    effects: [],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/@kepler.gl/actions": "3.2.6" },
  },
  "@kepler.gl/components": {
    direct: true,
    via: [
      "@kepler.gl/actions",
      "@kepler.gl/layers",
      "@kepler.gl/processors",
      "@kepler.gl/reducers",
      "@kepler.gl/schemas",
    ],
    effects: [],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/@kepler.gl/components": "3.2.6" },
  },
  "@kepler.gl/deckgl-layers": {
    direct: false,
    via: ["@deck.gl/geo-layers"],
    effects: [],
    range: "*",
    fixAvailable: true,
    nodes: { "node_modules/@kepler.gl/deckgl-layers": "3.2.6" },
  },
  "@kepler.gl/layers": {
    direct: false,
    via: ["@deck.gl/geo-layers", "@deck.gl/mesh-layers", "@kepler.gl/deckgl-layers", "@loaders.gl/gltf"],
    effects: ["@kepler.gl/actions", "@kepler.gl/components", "@kepler.gl/reducers", "@kepler.gl/schemas"],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/@kepler.gl/layers": "3.2.6" },
  },
  "@kepler.gl/processors": {
    direct: true,
    via: ["@kepler.gl/schemas"],
    effects: ["@kepler.gl/tasks"],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/@kepler.gl/processors": "3.2.6" },
  },
  "@kepler.gl/reducers": {
    direct: true,
    via: [
      "@kepler.gl/actions",
      "@kepler.gl/deckgl-layers",
      "@kepler.gl/layers",
      "@kepler.gl/processors",
      "@kepler.gl/schemas",
      "@kepler.gl/tasks",
    ],
    effects: [],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/@kepler.gl/reducers": "3.2.6" },
  },
  "@kepler.gl/schemas": {
    direct: false,
    via: ["@kepler.gl/layers"],
    effects: ["@kepler.gl/processors"],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/@kepler.gl/schemas": "3.2.6" },
  },
  "@kepler.gl/tasks": {
    direct: false,
    via: ["@kepler.gl/processors"],
    effects: [],
    range: "*",
    fixAvailable: true,
    nodes: { "node_modules/@kepler.gl/tasks": "3.2.6" },
  },
  "@loaders.gl/3d-tiles": {
    direct: false,
    via: ["@loaders.gl/gltf"],
    effects: ["@deck.gl/geo-layers"],
    range: ">=3.1.0-alpha.1",
    fixAvailable: true,
    nodes: { "node_modules/@loaders.gl/3d-tiles": "3.4.15" },
  },
  "@loaders.gl/gltf": {
    direct: false,
    via: ["@loaders.gl/textures"],
    effects: ["@deck.gl/mesh-layers", "@kepler.gl/layers", "@loaders.gl/3d-tiles"],
    range: ">=3.1.0-alpha.1",
    fixAvailable: false,
    nodes: {
      "node_modules/@deck.gl/mesh-layers/node_modules/@loaders.gl/gltf": "3.4.15",
      "node_modules/@loaders.gl/3d-tiles/node_modules/@loaders.gl/gltf": "3.4.15",
      "node_modules/@loaders.gl/gltf": "4.4.1",
    },
  },
  "@loaders.gl/textures": {
    direct: false,
    via: ["texture-compressor"],
    effects: ["@loaders.gl/gltf"],
    range: "*",
    fixAvailable: false,
    nodes: {
      "node_modules/@deck.gl/mesh-layers/node_modules/@loaders.gl/textures": "3.4.15",
      "node_modules/@loaders.gl/3d-tiles/node_modules/@loaders.gl/textures": "3.4.15",
      "node_modules/@loaders.gl/textures": "4.4.1",
    },
  },
  "image-size": {
    direct: false,
    via: null,
    effects: ["texture-compressor"],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/image-size": "0.7.5" },
  },
  "texture-compressor": {
    direct: false,
    via: ["image-size"],
    effects: ["@loaders.gl/textures"],
    range: "*",
    fixAvailable: false,
    nodes: { "node_modules/texture-compressor": "1.0.2" },
  },
});

const VULNERABILITY_KEYS = Object.freeze([
  "effects",
  "fixAvailable",
  "isDirect",
  "name",
  "nodes",
  "range",
  "severity",
  "via",
]);
const ADVISORY_KEYS = Object.freeze([
  "cwe",
  "cvss",
  "dependency",
  "name",
  "range",
  "severity",
  "source",
  "title",
  "url",
]);

function policyError(message) {
  return new Error(`Kepler audit policy: ${message}`);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw policyError(`${label} must be an object`);
  }
}

function assertExactStringSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) {
    throw policyError(`${label} must be an array of strings`);
  }
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    new Set(actualSorted).size !== actualSorted.length ||
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw policyError(
      `${label} drifted: expected [${expectedSorted.join(", ")}], received [${actualSorted.join(", ")}]`,
    );
  }
}

function parseUtcDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw policyError(`${label} must be an explicit YYYY-MM-DD date`);
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw policyError(`${label} is not a valid UTC date`);
  }
  return milliseconds;
}

function assertExceptionIsCurrent(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw policyError("current time must be a valid Date");
  }
  const reviewedAt = parseUtcDate(IMAGE_SIZE_EXCEPTION.reviewedOn, "reviewedOn");
  const expiresAt = parseUtcDate(IMAGE_SIZE_EXCEPTION.expiresOn, "expiresOn");
  const lifetimeDays = (expiresAt - reviewedAt) / MILLISECONDS_PER_DAY;
  if (lifetimeDays <= 0 || lifetimeDays > 31) {
    throw policyError(`exception lifetime must be between 1 and 31 days, received ${lifetimeDays}`);
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today > expiresAt) {
    throw policyError(`exception expired after ${IMAGE_SIZE_EXCEPTION.expiresOn}`);
  }
}

function assertAdvisories(vulnerability) {
  if (!Array.isArray(vulnerability.via) || vulnerability.via.length !== 2) {
    throw policyError("image-size must contain exactly two advisory objects");
  }
  const observedIds = [];
  for (const advisory of vulnerability.via) {
    assertPlainObject(advisory, "image-size advisory");
    assertExactStringSet(Object.keys(advisory), ADVISORY_KEYS, "image-size advisory keys");
    const id = typeof advisory.url === "string" ? advisory.url.slice(advisory.url.lastIndexOf("/") + 1) : "";
    const expected = IMAGE_SIZE_EXCEPTION.advisories[id];
    if (!expected) throw policyError(`unexpected image-size advisory ${id || "<missing URL>"}`);
    observedIds.push(id);
    if (
      advisory.source !== expected.source ||
      advisory.name !== IMAGE_SIZE_EXCEPTION.packageName ||
      advisory.dependency !== IMAGE_SIZE_EXCEPTION.packageName ||
      advisory.title !== expected.title ||
      advisory.url !== expected.url ||
      advisory.severity !== "high" ||
      advisory.range !== "<=2.0.2"
    ) {
      throw policyError(`${id} metadata drifted`);
    }
    assertExactStringSet(advisory.cwe, ["CWE-835"], `${id} CWE list`);
    assertPlainObject(advisory.cvss, `${id} CVSS`);
    assertExactStringSet(Object.keys(advisory.cvss), ["score", "vectorString"], `${id} CVSS keys`);
    if (advisory.cvss.score !== 7.5 || advisory.cvss.vectorString !== "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H") {
      throw policyError(`${id} CVSS metadata drifted`);
    }
  }
  assertExactStringSet(observedIds, Object.keys(IMAGE_SIZE_EXCEPTION.advisories), "image-size advisory IDs");
}

function assertMetadata(report, expectedCount) {
  assertPlainObject(report.metadata, "audit metadata");
  assertPlainObject(report.metadata.vulnerabilities, "audit vulnerability metadata");
  const counts = report.metadata.vulnerabilities;
  for (const severity of ["info", "low", "moderate", "critical"]) {
    if (counts[severity] !== 0) throw policyError(`unexpected ${severity} vulnerability count ${counts[severity]}`);
  }
  if (counts.high !== expectedCount || counts.total !== expectedCount) {
    throw policyError(
      `audit counts drifted: expected ${expectedCount} high/total, received ${counts.high}/${counts.total}`,
    );
  }
}

function assertLockfileChain(lockfile) {
  assertPlainObject(lockfile, "Kepler package lock");
  if (lockfile.lockfileVersion !== 3)
    throw policyError(`expected lockfileVersion 3, received ${lockfile.lockfileVersion}`);
  assertPlainObject(lockfile.packages, "Kepler package lock packages");
  const rootDependencies = lockfile.packages[""]?.dependencies;
  for (const packageName of [
    "@kepler.gl/actions",
    "@kepler.gl/components",
    "@kepler.gl/processors",
    "@kepler.gl/reducers",
  ]) {
    if (rootDependencies?.[packageName] !== "3.2.6") {
      throw policyError(`expected direct ${packageName}@3.2.6 in the Kepler lock`);
    }
  }
  for (const [packageName, expected] of Object.entries(EXPECTED_VULNERABILITIES)) {
    for (const [nodePath, version] of Object.entries(expected.nodes)) {
      if (lockfile.packages[nodePath]?.version !== version) {
        throw policyError(`${packageName} lock version/path drifted at ${nodePath}: expected ${version}`);
      }
    }
  }
  if (lockfile.packages["node_modules/texture-compressor"]?.dependencies?.["image-size"] !== "^0.7.4") {
    throw policyError("texture-compressor no longer has the reviewed image-size dependency edge");
  }
  for (const nodePath of Object.keys(EXPECTED_VULNERABILITIES["@loaders.gl/textures"].nodes)) {
    if (lockfile.packages[nodePath]?.dependencies?.["texture-compressor"] !== "^1.0.2") {
      throw policyError(`reviewed texture-compressor edge drifted at ${nodePath}`);
    }
  }
}

export function validateKeplerAudit(report, lockfile, now = new Date()) {
  assertPlainObject(report, "npm audit report");
  if (report.auditReportVersion !== 2) {
    throw policyError(`expected auditReportVersion 2, received ${report.auditReportVersion}`);
  }
  assertPlainObject(report.vulnerabilities, "npm audit vulnerabilities");
  const names = Object.keys(report.vulnerabilities);
  if (names.length === 0) {
    assertMetadata(report, 0);
    return { status: "clean", advisories: [], expiresOn: null };
  }

  assertExceptionIsCurrent(now);
  assertExactStringSet(names, Object.keys(EXPECTED_VULNERABILITIES), "vulnerability package names");
  assertMetadata(report, names.length);
  assertLockfileChain(lockfile);

  for (const [packageName, expected] of Object.entries(EXPECTED_VULNERABILITIES)) {
    const actual = report.vulnerabilities[packageName];
    assertPlainObject(actual, `${packageName} vulnerability`);
    assertExactStringSet(Object.keys(actual), VULNERABILITY_KEYS, `${packageName} vulnerability keys`);
    if (
      actual.name !== packageName ||
      actual.severity !== "high" ||
      actual.isDirect !== expected.direct ||
      actual.range !== expected.range ||
      actual.fixAvailable !== expected.fixAvailable
    ) {
      throw policyError(`${packageName} vulnerability metadata drifted`);
    }
    assertExactStringSet(actual.effects, expected.effects, `${packageName} effects`);
    assertExactStringSet(actual.nodes, Object.keys(expected.nodes), `${packageName} node paths`);
    if (packageName === IMAGE_SIZE_EXCEPTION.packageName) {
      if (actual.fixAvailable !== false) throw policyError("image-size fixAvailable must remain false");
      assertAdvisories(actual);
    } else {
      assertExactStringSet(actual.via, expected.via, `${packageName} dependency causes`);
    }
  }

  return {
    status: "accepted-temporary-exception",
    advisories: Object.keys(IMAGE_SIZE_EXCEPTION.advisories).sort(),
    expiresOn: IMAGE_SIZE_EXCEPTION.expiresOn,
  };
}

function runAudit() {
  const result = spawnSync("npm", ["audit", "--prefix", "examples/kepler-analytics", "--json"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error) throw policyError(`could not execute npm audit: ${result.error.message}`);
  if (result.signal) throw policyError(`npm audit terminated by signal ${result.signal}`);
  if (!result.stdout?.trim()) throw policyError(`npm audit returned no JSON: ${result.stderr?.trim() || "no stderr"}`);

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw policyError(`npm audit returned invalid JSON: ${error.message}`);
  }
  const lockfile = JSON.parse(fs.readFileSync(LOCKFILE_PATH, "utf8"));
  const validation = validateKeplerAudit(report, lockfile);
  const expectedExitCode = validation.status === "clean" ? 0 : 1;
  if (result.status !== expectedExitCode) {
    throw policyError(`npm audit exit code drifted: expected ${expectedExitCode}, received ${result.status}`);
  }
  return validation;
}

function main() {
  try {
    const validation = runAudit();
    if (validation.status === "clean") {
      console.log("Kepler example npm audit is clean.");
    } else {
      console.log(
        `Kepler example audit accepted only ${validation.advisories.join(", ")} for image-size@${IMAGE_SIZE_EXCEPTION.packageVersion}; exception expires ${validation.expiresOn}.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) main();
