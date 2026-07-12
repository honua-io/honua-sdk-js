import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDocsVersions,
  currentDocsVersions,
  expandDocsVersionTokens,
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
  assert.equal(result.current, "1.2.0-beta.1");
  assert.deepEqual(
    result.versions.map(({ version, status, tag, docs }) => ({ version, status, tag, kind: docs.kind })),
    [
      {
        version: "1.2.0-beta.1",
        status: "current-prerelease",
        tag: "js-sdk-v1.2.0-beta.1",
        kind: "hosted",
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
  assert.match(expanded, /Current 1\.2\.0-beta\.1/);
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

test("committed version manifest is the exact deterministic projection", () => {
  const committed = fs.readFileSync(path.join(ROOT, "docs", "versions.json"), "utf8");
  assert.equal(committed, serializeDocsVersions(currentDocsVersions()));
});
