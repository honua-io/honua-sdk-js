import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { checkServerImagePin, generatedServerImage, parseDigestRef } from "../../scripts/check-server-image-pin.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/server-image-pin/customer-install-manifest.json", import.meta.url), "utf8"),
);
const DIGEST = "sha256:069f196bfa5c7201223d4d89868934242c4ace8805a6e48c122a88d84fa6eb1a";
const OTHER = `sha256:${"a".repeat(64)}`;
const pin = { repository: "honua-io/honua-release", ref: "1005313e839be6f3248cd946e228d1cd303ce28d", path: "customer-install-manifest.json" };
const generated = (image) => `export const ADMIN_LOCAL_SERVER_IMAGE = ${JSON.stringify(image)} as const;\n`;
const run = (serverImage, generatedImage = serverImage, releaseManifest = fixture, releaseManifestPin = pin) =>
  checkServerImagePin({ source: { serverImage, releaseManifestPin }, generatedText: generated(generatedImage), releaseManifest });

test("the installer pin matches the release server image", () => {
  assert.match(run(`ghcr.io/honua-io/honua-server@${DIGEST}`), /matches honua-io\/honua-release@1005313e/);
});

test("an informational tag beside the same digest still matches", () => {
  assert.doesNotThrow(() => run(`ghcr.io/honua-io/honua-server:nightly-87966c3@${DIGEST}`));
});

test("a different digest in the config fails with a clear message", () => {
  assert.throws(() => run(`ghcr.io/honua-io/honua-server@${OTHER}`, `ghcr.io/honua-io/honua-server@${DIGEST}`),
    /config\/admin-client\.v1\.json serverImage is .*but the release installs ghcr\.io\/honua-io\/honua-server@sha256:069f/);
});

test("a stale generated constant fails even when the config matches", () => {
  assert.throws(() => run(`ghcr.io/honua-io/honua-server@${DIGEST}`, `ghcr.io/honua-io/honua-server@${OTHER}`),
    /ADMIN_LOCAL_SERVER_IMAGE is .*but the release installs/);
});

test("a different repository fails", () => {
  assert.throws(() => run(`ghcr.io/example/honua-server@${DIGEST}`), /does not match the release manifest/);
});

test("a floating tag or a release manifest without a digest fails closed", () => {
  assert.throws(() => run("ghcr.io/honua-io/honua-server:2026.1-rc"), /not a digest-pinned image reference/);
  assert.throws(() => run(`ghcr.io/honua-io/honua-server@${DIGEST}`, undefined, { server: { image: "ghcr.io/honua-io/honua-server:2026.1-rc" } }),
    /server\.image is not a digest-pinned/);
  assert.throws(() => run(`ghcr.io/honua-io/honua-server@${DIGEST}`, undefined, {}), /server\.image is not a digest-pinned/);
});

test("the release pin must be an immutable honua-release commit", () => {
  const image = `ghcr.io/honua-io/honua-server@${DIGEST}`;
  assert.throws(() => run(image, image, fixture, { ...pin, ref: "trunk" }), /immutable 40-character commit SHA/);
  assert.throws(() => run(image, image, fixture, null), /missing releaseManifestPin/);
});

test("parsing helpers", () => {
  assert.deepEqual(parseDigestRef(`ghcr.io/honua-io/honua-server:2026.1-rc@${DIGEST}`, "x"),
    { repository: "ghcr.io/honua-io/honua-server", digest: DIGEST });
  assert.throws(() => generatedServerImage("export const OTHER = 1;"), /does not export ADMIN_LOCAL_SERVER_IMAGE/);
});
