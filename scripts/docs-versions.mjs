#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "docs", "versions.json");
const REPOSITORY = "honua-io/honua-sdk-js";
const SITE_URL = "https://honua-io.github.io/honua-sdk-js/";
const RELEASE_URL_PREFIX = `https://github.com/${REPOSITORY}/`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function releaseTag(version, releaseUrl) {
  let parsed;
  try {
    parsed = new URL(releaseUrl);
  } catch {
    throw new Error(`CHANGELOG release ${version} has an invalid URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.startsWith(`/${REPOSITORY}/`)
  ) {
    throw new Error(`CHANGELOG release ${version} must use a canonical ${RELEASE_URL_PREFIX} URL`);
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const compare = new RegExp(
    `^/${REPOSITORY}/compare/js-sdk-v[^/]+\\.\\.\\.(js-sdk-vv?${escaped})$`,
  ).exec(parsed.pathname);
  const direct = new RegExp(`^/${REPOSITORY}/releases/tag/(js-sdk-vv?${escaped})$`).exec(parsed.pathname);
  const match = compare ?? direct;
  if (!match) throw new Error(`CHANGELOG release ${version} does not identify its js-sdk tag`);
  return match[1];
}

function channel(version) {
  const prerelease = version.split("-", 2)[1];
  return prerelease ? prerelease.split(".", 1)[0] : "stable";
}

export function parseChangelogReleases(changelog) {
  const releases = [];
  const seen = new Set();
  const heading = /^## \[([^\]]+)\]\(([^)]+)\)(?: \([^)]*\))?$/gm;
  for (const match of changelog.matchAll(heading)) {
    const version = match[1];
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Invalid CHANGELOG release version: ${version}`);
    }
    if (seen.has(version)) throw new Error(`Duplicate CHANGELOG release version: ${version}`);
    seen.add(version);
    releases.push({ version, releaseUrl: match[2], tag: releaseTag(version, match[2]) });
  }
  if (releases.length === 0) throw new Error("CHANGELOG contains no released SDK versions");
  return releases;
}

export function buildDocsVersions({ packageJson, releaseManifest, changelog, unpublishedReleases = {} }) {
  const current = packageJson.version;
  if (releaseManifest["."] !== current) {
    throw new Error(`Package version ${current} disagrees with release manifest ${releaseManifest["."] ?? "<missing>"}`);
  }
  const changelogReleases = parseChangelogReleases(changelog);
  for (const [version, reason] of Object.entries(unpublishedReleases)) {
    if (version === current || !changelogReleases.some((entry) => entry.version === version) ||
        typeof reason !== "string" || !reason.trim()) {
      throw new Error(`Invalid unpublished documentation release: ${version}`);
    }
  }
  const releases = changelogReleases.filter((entry) => !Object.hasOwn(unpublishedReleases, entry.version));
  // Release Please can record a cut that never acquired a tag or npm artifact.
  // Preserve its changelog, but compare the next release from the prior real tag.
  for (const release of releases) {
    const originalIndex = changelogReleases.indexOf(release);
    if (Object.hasOwn(unpublishedReleases, changelogReleases[originalIndex + 1]?.version)) {
      const previous = releases[releases.indexOf(release) + 1];
      if (!previous) throw new Error(`No published predecessor for ${release.version}`);
      release.releaseUrl = `${RELEASE_URL_PREFIX}compare/${previous.tag}...${release.tag}`;
    }
  }
  if (releases[0]?.version !== current) {
    throw new Error(`Current package version ${current} must be the first released CHANGELOG entry`);
  }
  return {
    format: "honua.sdk.docs-versions.v1",
    schemaVersion: 1,
    package: "@honua/sdk-js",
    development: {
      label: "trunk development",
      sourceRef: "trunk",
      packageBaseline: current,
      docs: {
        kind: "hosted-development",
        guides: `${SITE_URL}guides/`,
        api: `${SITE_URL}api/`,
      },
    },
    latestRelease: current,
    supportPolicy: {
      supportedPrior:
        channel(current) === "stable"
          ? { status: "not-yet-designated", reason: "A prior supported line is designated when the next stable line ships." }
          : { status: "not-applicable", reason: "The SDK has no GA stable release line yet." },
    },
    compatibility: {
      node: packageJson.engines?.node ?? null,
      peers: packageJson.peerDependencies ?? {},
    },
    versions: releases.map((release, index) => ({
      version: release.version,
      channel: channel(release.version),
      status: index === 0 ? (channel(release.version) === "stable" ? "latest-stable" : "latest-prerelease") : "archived",
      tag: release.tag,
      releaseUrl: release.releaseUrl,
      npmUrl: `https://www.npmjs.com/package/@honua/sdk-js/v/${release.version}`,
      docs: {
        kind: "source-fallback",
        sourceBase: `https://github.com/${REPOSITORY}/blob/${release.tag}`,
        reason: "Immutable hosted TypeDoc was not published for this release; use tagged source and release notes.",
      },
    })),
  };
}

export function serializeDocsVersions(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function docsVersionTableMarkdown(manifest) {
  const rows = manifest.versions.map((entry) => {
    const destination =
      `[Tagged README fallback](${entry.docs.sourceBase}/README.md) · [release notes](${entry.releaseUrl})`;
    return `| \`${entry.version}\` | ${entry.status} | ${entry.channel} | ${destination} |`;
  });
  return ["| Version | Status | Channel | Documentation |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function expandDocsVersionTokens(markdown, manifest) {
  return markdown
    .replaceAll(
      "{{SDK_DOCS_CURRENT_VERSION}}",
      `${manifest.development.label} (package baseline ${manifest.development.packageBaseline})`,
    )
    .replaceAll("{{SDK_DOCS_VERSION_TABLE}}", docsVersionTableMarkdown(manifest));
}

export function missingReleaseTags(manifest, tagRefs) {
  const available = new Set(tagRefs);
  return manifest.versions.map((entry) => entry.tag).filter((tag) => !available.has(`refs/tags/${tag}`));
}

export function currentDocsVersions() {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const install = fs.readFileSync(path.join(ROOT, "INSTALL.md"), "utf8");
  for (const [name, text] of [
    ["README.md", readme],
    ["INSTALL.md", install],
  ]) {
    if (!text.includes("docs/documentation-versions.md")) {
      throw new Error(`${name} does not link the canonical documentation version policy`);
    }
  }
  const packageJson = readJson(path.join(ROOT, "package.json"));
  for (const fixture of fs
    .readdirSync(path.join(ROOT, "samples", "contract", "v1", "fixtures"))
    .filter((name) => name.startsWith("sample-evidence.") && name.endsWith(".json"))) {
    const evidence = readJson(path.join(ROOT, "samples", "contract", "v1", "fixtures", fixture));
    if (evidence.sdk?.package !== "@honua/sdk-js" || evidence.sdk?.version !== packageJson.version) {
      throw new Error(`samples/contract/v1/fixtures/${fixture} disagrees with package version ${packageJson.version}`);
    }
  }
  return buildDocsVersions({
    packageJson,
    releaseManifest: readJson(path.join(ROOT, ".release-please-manifest.json")),
    changelog: fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"),
    unpublishedReleases: readJson(path.join(ROOT, "config", "docs-unpublished-releases.json")),
  });
}

async function main() {
  const mode = process.argv[2] ?? "check";
  const expected = serializeDocsVersions(currentDocsVersions());
  if (mode === "write") {
    fs.writeFileSync(OUTPUT, expected);
    process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)}\n`);
    return;
  }
  if (mode === "verify-tags") {
    const { execFileSync } = await import("node:child_process");
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (!/^(?:git@github\.com:|https:\/\/github\.com\/)(?:honua-io\/honua-sdk-js)(?:\.git)?$/.test(remote)) {
      throw new Error(`origin is not the authoritative ${REPOSITORY} repository`);
    }
    const attempts = Number(process.env.HONUA_DOCS_TAG_VERIFY_ATTEMPTS ?? "1");
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 12) {
      throw new Error("HONUA_DOCS_TAG_VERIFY_ATTEMPTS must be an integer from 1 through 12");
    }
    let refs = [];
    let missing = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      refs = execFileSync("git", ["ls-remote", "--tags", "--refs", "origin"], {
        cwd: ROOT,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/\s+/, 2)[1]);
      missing = missingReleaseTags(currentDocsVersions(), refs);
      if (missing.length === 0 || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (missing.length > 0) throw new Error(`Documentation releases reference missing tags: ${missing.join(", ")}`);
    process.stdout.write(`docs version tags: ${refs.length} authoritative tags checked\n`);
    return;
  }
  if (mode !== "check") throw new Error(`Usage: node scripts/docs-versions.mjs [check|write|verify-tags]`);
  const manifest = currentDocsVersions();
  process.stdout.write(`docs versions: ${manifest.versions.length} releases, latest ${manifest.latestRelease}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
