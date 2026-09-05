#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentDocsVersions } from "./docs-versions.mjs";

export const MANIFEST_URL = "https://honua-io.github.io/honua-sdk-js/versions.json";
const PACKAGES = ["@honua/sdk-js", "@honua/sdk-esri-compat"];

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function assertPublishVersion(manifest, { refType, refName, releaseVersion, packageVersion }) {
  const version = refType === "tag" ? /^js-sdk-v(.+)$/.exec(refName ?? "")?.[1] : releaseVersion || packageVersion;
  if (!version) throw new Error(`Expected a js-sdk-v* release tag, got ${refName}`);
  parseVersion(version);
  if (manifest.latestRelease !== version || manifest.versions[0]?.version !== version) {
    throw new Error(`Cannot publish ${version}: documentation manifest latestRelease is ${manifest.latestRelease}`);
  }
  if (packageVersion !== version || (releaseVersion && releaseVersion !== version)) {
    throw new Error(`Publish version ${version} disagrees with package or release_version`);
  }
}

export function assertRegistryFreshness(manifest, packageName, packument) {
  if (!packument?.versions || !Object.keys(packument.versions).length) {
    throw new Error(`${packageName}: npm response has no versions`);
  }
  const newer = Object.keys(packument.versions)
    .filter((version) => parseVersion(version).prerelease.length && compareVersions(version, manifest.latestRelease) > 0)
    .sort(compareVersions).at(-1);
  if (newer) throw new Error(`${packageName}: npm publishes ${newer}; documentation manifest says ${manifest.latestRelease}`);
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export async function verifyRegistry(manifest, fetchImpl = fetch) {
  for (const name of PACKAGES) {
    assertRegistryFreshness(manifest, name, await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`, fetchImpl));
  }
}

export async function verifyHosted(manifest, { fetchImpl = fetch, sourceRevision } = {}) {
  const hosted = await fetchJson(MANIFEST_URL, fetchImpl);
  assert.equal(hosted.latestRelease, manifest.latestRelease, "Hosted versions.json latestRelease is stale");
  assert.deepEqual(hosted.versions, manifest.versions, "Hosted versions.json release entries are stale");
  if (sourceRevision) assert.equal(hosted.development?.sourceRevision, sourceRevision, "Hosted source revision is stale");
  await verifyRegistry(hosted, fetchImpl);
}

async function main() {
  const mode = process.argv[2];
  const manifest = currentDocsVersions();
  if (mode === "publish") {
    assertPublishVersion(manifest, {
      refType: process.env.GITHUB_REF_TYPE,
      refName: process.env.GITHUB_REF_NAME,
      releaseVersion: process.env.RELEASE_VERSION,
      packageVersion: manifest.development.packageBaseline,
    });
  } else if (mode === "registry") {
    await verifyRegistry(manifest);
  } else if (mode === "hosted") {
    const attempts = Number(process.env.HONUA_DOCS_DEPLOY_VERIFY_ATTEMPTS ?? "1");
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 12) throw new Error("Invalid deployment verify attempts");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await verifyHosted(manifest, { sourceRevision: process.env.HONUA_DOCS_EXPECT_SOURCE_REVISION });
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        process.stderr.write(`Waiting for Pages: ${error.message}\n`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  } else {
    throw new Error("Usage: node scripts/check-docs-release.mjs [publish|registry|hosted]");
  }
  process.stdout.write(`docs release ${mode}: latestRelease ${manifest.latestRelease}${mode === "hosted" ? ` at ${MANIFEST_URL}` : ""}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
