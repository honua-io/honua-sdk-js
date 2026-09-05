import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDocsVersions,
  expandDocsVersionTokens,
  missingReleaseTags,
  parseChangelogReleases,
  serializeDocsVersions,
} from "../../scripts/docs-versions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const packageJson = {
  version: "1.2.0-beta.1",
  engines: { node: ">=20" },
  peerDependencies: { "maplibre-gl": "^5" },
};
const releaseManifest = { ".": "1.2.0-beta.1" };
const changelog = `# Changelog

## [1.2.0-beta.1](https://github.com/honua-io/honua-sdk-js/compare/js-sdk-v1.1.0...js-sdk-v1.2.0-beta.1) (2026-01-02)
## [1.1.0](https://github.com/honua-io/honua-sdk-js/compare/js-sdk-v1.0.0...js-sdk-v1.1.0) (2026-01-01)
## [0.0.5-alpha.0](https://github.com/honua-io/honua-sdk-js/compare/js-sdk-vv0.0.4-alpha.0...js-sdk-vv0.0.5-alpha.0) (2025-01-01)
## [0.0.1-alpha.0] - Unreleased
`;

test("builds current and archived documentation destinations from release metadata", () => {
  const result = buildDocsVersions({ packageJson, releaseManifest, changelog });
  assert.equal(result.latestRelease, "1.2.0-beta.1");
  assert.equal(result.development.packageBaseline, "1.2.0-beta.1");
  assert.equal(result.supportPolicy.supportedPrior.status, "not-applicable");
  assert.deepEqual(
    result.versions.map(({ version, status, tag, docs }) => ({ version, status, tag, kind: docs.kind })),
    [
      {
        version: "1.2.0-beta.1",
        status: "latest-prerelease",
        tag: "js-sdk-v1.2.0-beta.1",
        kind: "source-fallback",
      },
      { version: "1.1.0", status: "archived", tag: "js-sdk-v1.1.0", kind: "source-fallback" },
      {
        version: "0.0.5-alpha.0",
        status: "archived",
        tag: "js-sdk-vv0.0.5-alpha.0",
        kind: "source-fallback",
      },
    ],
  );
  assert.equal(result.compatibility.node, ">=20");
  assert.equal(result.compatibility.peers["maplibre-gl"], "^5");
});

test("expands current version and release table for hosted and agent docs", () => {
  const manifest = buildDocsVersions({ packageJson, releaseManifest, changelog });
  const expanded = expandDocsVersionTokens(
    "Current {{SDK_DOCS_CURRENT_VERSION}}\n\n{{SDK_DOCS_VERSION_TABLE}}",
    manifest,
  );
  assert.match(expanded, /Current trunk development \(package baseline 1\.2\.0-beta\.1\)/);
  assert.match(expanded, /\| `1\.1\.0` \| archived \| stable \|/);
  assert.match(expanded, /blob\/js-sdk-v1\.1\.0\/README\.md/);
  assert.doesNotMatch(expanded, /\{\{SDK_DOCS_/);
});

test("rejects release metadata drift and malformed or duplicate releases", () => {
  assert.throws(
    () => buildDocsVersions({ packageJson, releaseManifest: { ".": "1.1.0" }, changelog }),
    /disagrees with release manifest/,
  );
  assert.throws(
    () => buildDocsVersions({ packageJson, releaseManifest, changelog: changelog.replace("1.2.0-beta.1", "garbage") }),
    /Invalid CHANGELOG release version/,
  );
  assert.throws(
    () => parseChangelogReleases(`${changelog}\n${changelog.split("\n")[2]}\n`),
    /Duplicate CHANGELOG release/,
  );
});

test("rejects noncanonical or executable release destinations", () => {
  for (const hostile of [
    "javascript:evil...js-sdk-v1.2.0-beta.1",
    "https://example.com/honua-io/honua-sdk-js/compare/js-sdk-v1.1.0...js-sdk-v1.2.0-beta.1",
    "https://github.com/honua-io/honua-sdk-js/compare/js-sdk-v1.1.0...js-sdk-v1.2.0-beta.1?q=\"onload=evil",
  ]) {
    assert.throws(
      () => parseChangelogReleases(changelog.replace(/https:\/\/github[^)]+/, hostile)),
      /canonical|identify/,
    );
  }
});

test("release projection updates without a committed generated manifest", () => {
  const bumpedVersion = "1.3.0-beta.0";
  const bumped = buildDocsVersions({
    packageJson: { ...packageJson, version: bumpedVersion },
    releaseManifest: { ".": bumpedVersion },
    changelog: changelog.replace(
      "# Changelog",
      `# Changelog\n\n## [${bumpedVersion}](https://github.com/honua-io/honua-sdk-js/compare/js-sdk-v1.2.0-beta.1...js-sdk-v${bumpedVersion}) (2026-02-01)`,
    ),
  });
  assert.equal(bumped.latestRelease, bumpedVersion);
  assert.equal(bumped.versions[0].tag, `js-sdk-v${bumpedVersion}`);
  assert.doesNotThrow(() => JSON.parse(serializeDocsVersions(bumped)));

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "release-please-config.json"), "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "samples/catalog.v2.json"), "utf8"));
  const sdkVersionFiles = config.packages["."]["extra-files"].filter(
    (entry) => entry.type === "json" && entry.jsonpath === "$.sdk.version",
  );
  assert.deepEqual(
    sdkVersionFiles.map((entry) => entry.path).sort(),
    [
      "config/sdk-coverage.v1.json",
      "examples/ai-spatial-app-builder/evidence/live-skipped.v1.json",
      "examples/realtime-incident-dashboard/evidence/live-skipped.v1.json",
      "examples/spatial-analytics-workbench/evidence/live-skipped.v1.json",
      "samples/contract/v1/fixtures/sample-evidence.fixture.json",
      "samples/contract/v1/fixtures/sample-evidence.live.json",
      "samples/contract/v1/fixtures/sample-evidence.skipped.json",
      "samples/evidence/imagery-cog-quickstart/live.v1.json",
      "samples/evidence/maplibre-quickstart/live.v1.json",
      "samples/evidence/migration-workbench/live.v1.json",
      "samples/evidence/service-explorer/live.v1.json",
      "support/projections/sdk-support.v1.json",
    ],
  );

  const managedEvidencePaths = new Set(sdkVersionFiles.map((entry) => entry.path));
  const catalogEvidencePaths = catalog.samples.flatMap((sample) =>
    sample.evidence?.live?.evidencePath ? [sample.evidence.live.evidencePath] : [],
  );
  assert.ok(catalogEvidencePaths.length > 0);
  for (const evidencePath of catalogEvidencePaths) {
    assert.ok(managedEvidencePaths.has(evidencePath), `${evidencePath} must be release-managed`);
  }

  const benchmarkVersionFile = config.packages["."]["extra-files"].find(
    (entry) => entry.path === "bench/cross-sdk/corpus.json",
  );
  assert.deepEqual(benchmarkVersionFile, {
    type: "json",
    path: "bench/cross-sdk/corpus.json",
    jsonpath: "$.references[0].package.version",
  });

  const supportVersionFiles = config.packages["."]["extra-files"].filter((entry) =>
    ["README.md", "support/projections/sdk-support.v1.json"].includes(entry.path),
  );
  assert.deepEqual(supportVersionFiles, [
    { type: "generic", path: "README.md" },
    {
      type: "json",
      path: "support/projections/sdk-support.v1.json",
      jsonpath: "$.sdk.version",
    },
  ]);

  const coverageVersionFile = config.packages["."]["extra-files"].find(
    (entry) => entry.path === "config/sdk-coverage.v1.json",
  );
  assert.deepEqual(coverageVersionFile, {
    type: "json",
    path: "config/sdk-coverage.v1.json",
    jsonpath: "$.sdk.version",
  });

  const currentPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const benchmarkCorpus = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/cross-sdk/corpus.json"), "utf8"));
  assert.equal(benchmarkCorpus.references[0].id, "honua-sdk-js");
  assert.equal(benchmarkCorpus.references[0].package.version, currentPackage.version);
});

test("authoritative tag validation rejects a fabricated release", () => {
  const manifest = buildDocsVersions({ packageJson, releaseManifest, changelog });
  const refs = manifest.versions.slice(1).map((entry) => `refs/tags/${entry.tag}`);
  assert.deepEqual(missingReleaseTags(manifest, refs), ["js-sdk-v1.2.0-beta.1"]);
  assert.deepEqual(
    missingReleaseTags(
      manifest,
      manifest.versions.map((entry) => `refs/tags/${entry.tag}`),
    ),
    [],
  );
});

test("unpublished cuts cannot hide the current release or unknown history", () => {
  for (const unpublishedReleases of [
    { "1.2.0-beta.1": "Never published" },
    { "9.9.9": "Unknown release" },
    { "1.1.0": "" },
  ]) {
    assert.throws(
      () => buildDocsVersions({ packageJson, releaseManifest, changelog, unpublishedReleases }),
      /Invalid unpublished documentation release/,
    );
  }
  const result = buildDocsVersions({ packageJson, releaseManifest, changelog, unpublishedReleases: { "1.1.0": "Never published" } });
  assert.equal(result.versions.length, 2);
  assert.equal(result.versions[0].releaseUrl, "https://github.com/honua-io/honua-sdk-js/compare/js-sdk-vv0.0.5-alpha.0...js-sdk-v1.2.0-beta.1");
});
