import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { currentDocsVersions } from "../../scripts/docs-versions.mjs";
import {
  assertPublishVersion,
  assertRegistryFreshness,
  compareVersions,
  MANIFEST_URL,
  verifyHosted,
  verifyRegistry,
} from "../../scripts/check-docs-release.mjs";

const manifest = { latestRelease: "0.1.9-beta.0", versions: [{ version: "0.1.9-beta.0" }] };
const publish = { refType: "tag", refName: "js-sdk-v0.1.9-beta.0", packageVersion: "0.1.9-beta.0" };

test("publishing refuses a lagging manifest, wrong tag, or conflicting recovery version", () => {
  assert.doesNotThrow(() => assertPublishVersion(manifest, publish));
  assert.throws(() => assertPublishVersion({ ...manifest, latestRelease: "0.1.7-beta.0" }, publish), /Cannot publish/);
  assert.throws(() => assertPublishVersion({ ...manifest, versions: [] }, publish), /Cannot publish/);
  assert.throws(() => assertPublishVersion(manifest, { ...publish, refName: "mcp-server-v0.1.9-beta.0" }), /release tag/);
  assert.throws(() => assertPublishVersion(manifest, { ...publish, releaseVersion: "0.1.7-beta.0" }), /disagrees/);
  assert.doesNotThrow(() => assertPublishVersion(manifest, { ...publish, refType: "branch", releaseVersion: "0.1.9-beta.0" }));
});

test("prerelease ordering follows SemVer, including numeric identifiers and stable precedence", () => {
  const ordered = ["0.1.9-alpha", "0.1.9-alpha.1", "0.1.9-alpha.beta", "0.1.9-beta.2", "0.1.9-beta.10", "0.1.9", "0.1.10-beta.0", "1.0.0-beta.0"];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(compareVersions("0.1.9-beta.0+build.1", "0.1.9-beta.0"), 0);
  assert.throws(() => compareVersions("0.1.9-beta.01", "0.1.9"), /Invalid/);
});

test("registry guard checks all published prereleases even if npm latest dist-tag lags", () => {
  const packument = { "dist-tags": { latest: "0.1.7-beta.0" }, versions: { "0.1.7-beta.0": {}, "0.1.9-beta.0": {} } };
  assert.doesNotThrow(() => assertRegistryFreshness(manifest, "@honua/sdk-js", packument));
  packument.versions["0.1.10-beta.0"] = {};
  assert.throws(() => assertRegistryFreshness(manifest, "@honua/sdk-js", packument), /npm publishes 0.1.10-beta.0/);
  assert.throws(() => assertRegistryFreshness(manifest, "@honua/sdk-js", {}), /no versions/);
});

test("network guards check both packages and fail closed on HTTP and malformed responses", async () => {
  const urls = [];
  await verifyRegistry(manifest, async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ versions: { "0.1.9-beta.0": {} } }) };
  });
  assert.deepEqual(urls.map((url) => decodeURIComponent(url.split("/").at(-1))), ["@honua/sdk-js", "@honua/sdk-esri-compat"]);
  await assert.rejects(verifyRegistry(manifest, async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(verifyRegistry(manifest, async () => ({ ok: true, json: async () => ({}) })), /no versions/);
  await assert.rejects(verifyRegistry(manifest, async (url) => ({ ok: true, json: async () => ({ versions: {
    [url.includes("esri-compat") ? "0.1.10-beta.0" : "0.1.9-beta.0"]: {},
  } }) })), /sdk-esri-compat: npm publishes/);
});

test("hosted verification catches stale versions, entries, and deployment revisions", async () => {
  let hosted = { ...manifest, development: { sourceRevision: "a".repeat(40) } };
  const fetchImpl = async (url) => ({ ok: true, json: async () => url === MANIFEST_URL ? hosted : { versions: { "0.1.9-beta.0": {} } } });
  await verifyHosted(manifest, { fetchImpl, sourceRevision: "a".repeat(40) });
  await assert.rejects(verifyHosted(manifest, { fetchImpl, sourceRevision: "b".repeat(40) }), /source revision/);
  hosted = { ...hosted, versions: [] };
  await assert.rejects(verifyHosted(manifest, { fetchImpl }), /release entries/);
  hosted = { ...hosted, latestRelease: "0.1.7-beta.0" };
  await assert.rejects(verifyHosted(manifest, { fetchImpl }), /latestRelease/);
});

test("current manifest skips the unpublished cut and preserves the previous real release", () => {
  const current = currentDocsVersions();
  const release = current.versions.find((entry) => entry.version === "0.1.9-beta.0");
  assert.equal(release.tag, "js-sdk-v0.1.9-beta.0");
  assert.equal(release.releaseUrl, "https://github.com/honua-io/honua-sdk-js/compare/js-sdk-v0.1.7-beta.0...js-sdk-v0.1.9-beta.0");
  assert.equal(release.npmUrl, "https://www.npmjs.com/package/@honua/sdk-js/v/0.1.9-beta.0");
  assert.equal(release.channel, "beta");
  assert.equal(release.docs.kind, "source-fallback");
  assert.ok(current.versions.some((entry) => entry.version === "0.1.7-beta.0" && entry.status === "archived"));
  assert.ok(!current.versions.some((entry) => entry.version === "0.1.8-beta.0"));
});

test("release workflow gates before npm setup, install, and publish", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/publish-js-sdk.yml", import.meta.url), "utf8");
  const guard = workflow.indexOf("run: node scripts/check-docs-release.mjs publish");
  assert.ok(guard > 0);
  assert.ok(guard < workflow.indexOf("- name: Prepare a hash-pinned npm"));
  assert.ok(guard < workflow.indexOf("run: npm ci"));
});
