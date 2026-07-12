#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "docs", "versions.json");
const REPOSITORY = "honua-io/honua-sdk-js";
const SITE_URL = "https://honua-io.github.io/honua-sdk-js/";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function releaseTag(version, releaseUrl) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\.\\.\\.)(js-sdk-vv?${escaped})(?:$|[?#])`).exec(releaseUrl);
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

export function buildDocsVersions({ packageJson, releaseManifest, changelog }) {
  const current = packageJson.version;
  if (releaseManifest["."] !== current) {
    throw new Error(`Package version ${current} disagrees with release manifest ${releaseManifest["."] ?? "<missing>"}`);
  }
  const releases = parseChangelogReleases(changelog);
  if (releases[0]?.version !== current) {
    throw new Error(`Current package version ${current} must be the first released CHANGELOG entry`);
  }
  return {
    format: "honua.sdk.docs-versions.v1",
    schemaVersion: 1,
    package: "@honua/sdk-js",
    current,
    compatibility: {
      node: packageJson.engines?.node ?? null,
      peers: packageJson.peerDependencies ?? {},
    },
    versions: releases.map((release, index) => ({
      version: release.version,
      channel: channel(release.version),
      status: index === 0 ? (channel(release.version) === "stable" ? "current" : "current-prerelease") : "archived",
      tag: release.tag,
      releaseUrl: release.releaseUrl,
      npmUrl: `https://www.npmjs.com/package/@honua/sdk-js/v/${release.version}`,
      docs:
        index === 0
          ? {
              kind: "hosted",
              guides: `${SITE_URL}guides/`,
              api: `${SITE_URL}api/`,
            }
          : {
              kind: "source-fallback",
              sourceBase: `https://github.com/${REPOSITORY}/blob/${release.tag}`,
              reason: "Immutable hosted TypeDoc was not published for this archived prerelease; use tagged source and release notes.",
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
      entry.docs.kind === "hosted"
        ? `[Hosted guides](${entry.docs.guides}) · [API](${entry.docs.api})`
        : `[Tagged README fallback](${entry.docs.sourceBase}/README.md) · [release notes](${entry.releaseUrl})`;
    return `| \`${entry.version}\` | ${entry.status} | ${entry.channel} | ${destination} |`;
  });
  return ["| Version | Status | Channel | Documentation |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function expandDocsVersionTokens(markdown, manifest) {
  return markdown
    .replaceAll("{{SDK_DOCS_CURRENT_VERSION}}", manifest.current)
    .replaceAll("{{SDK_DOCS_VERSION_TABLE}}", docsVersionTableMarkdown(manifest));
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
  });
}

function main() {
  const mode = process.argv[2] ?? "check";
  const expected = serializeDocsVersions(currentDocsVersions());
  if (mode === "write") {
    fs.writeFileSync(OUTPUT, expected);
    process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)}\n`);
    return;
  }
  if (mode !== "check") throw new Error(`Usage: node scripts/docs-versions.mjs [check|write]`);
  if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, "utf8") !== expected) {
    throw new Error("docs/versions.json is stale; run `npm run docs:versions:write`");
  }
  process.stdout.write(`docs versions: ${currentDocsVersions().versions.length} releases, current ${currentDocsVersions().current}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
