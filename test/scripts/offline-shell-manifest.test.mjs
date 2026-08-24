import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXAMPLE_DIRECTORY,
  MANIFEST_PATH,
  formatDriftReport,
  loadShellManifest,
  recomputeShellManifest,
  resolveShellResourceFile,
  serializeShellManifest,
  sha256Integrity,
} from "../../scripts/offline-shell-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX_HTML = "<!doctype html><title>Offline reference</title>\n";
const APP_MJS = "export const app = true;\n";
const DIST_MODULE = "export const distModule = true;\n";

function createFixtureProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-shell-manifest-"));
  fs.mkdirSync(path.join(projectRoot, EXAMPLE_DIRECTORY), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "dist/src/offline"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, EXAMPLE_DIRECTORY, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(projectRoot, EXAMPLE_DIRECTORY, "app.mjs"), APP_MJS);
  fs.writeFileSync(path.join(projectRoot, "dist/src/offline/index.js"), DIST_MODULE);
  return projectRoot;
}

function fixtureManifest(projectRoot) {
  const base = {
    format: "honua.offline-shell-manifest.v1",
    deploymentId: "offline-region-reference-fixture-v1",
    resources: [
      { url: "./", byteLength: 0, integrity: `sha256:${"0".repeat(64)}`, mediaType: "text/html" },
      { url: "./app.mjs", byteLength: 0, integrity: `sha256:${"0".repeat(64)}`, mediaType: "application/javascript" },
      { url: "./index.html", byteLength: 0, integrity: `sha256:${"0".repeat(64)}`, mediaType: "text/html" },
      {
        url: "/dist/src/offline/index.js",
        byteLength: 0,
        integrity: `sha256:${"0".repeat(64)}`,
        mediaType: "application/javascript",
      },
    ],
  };
  return recomputeShellManifest(base, { projectRoot }).manifest;
}

test("pins each manifest URL to the file the fixture server actually serves", () => {
  assert.equal(resolveShellResourceFile("./"), `${EXAMPLE_DIRECTORY}/index.html`);
  assert.equal(resolveShellResourceFile("./index.html"), `${EXAMPLE_DIRECTORY}/index.html`);
  assert.equal(resolveShellResourceFile("./app.mjs"), `${EXAMPLE_DIRECTORY}/app.mjs`);
  assert.equal(resolveShellResourceFile("/dist/src/core/errors.js"), "dist/src/core/errors.js");
  for (const rejected of ["", "../secrets.json", "/etc/passwd", "https://example.com/app.mjs", "./app.mjs?v=2"]) {
    assert.throws(() => resolveShellResourceFile(rejected), /Application shell resource URL/);
  }
});

test("encodes integrity exactly as the service worker recomputes it", () => {
  // sha256("") — prefix, lowercase hex, and zero padding all mirrored from
  // service-worker.mjs's sha256Integrity().
  assert.equal(
    sha256Integrity(Buffer.alloc(0)),
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const worker = fs.readFileSync(path.join(ROOT, EXAMPLE_DIRECTORY, "service-worker.mjs"), "utf8");
  assert.match(worker, /`sha256:\$\{\[\.\.\.new Uint8Array\(digest\)\]\.map\(\(byte\) => byte\.toString\(16\)/);
  assert.match(worker, /\/\^sha256:\[0-9a-f\]\{64\}\$\//);
});

test("verify mode reports no drift and serializes identically for a current manifest", () => {
  const projectRoot = createFixtureProject();
  try {
    const manifest = fixtureManifest(projectRoot);
    const { drift, totalBytes, manifest: recomputed } = recomputeShellManifest(manifest, { projectRoot });
    assert.deepEqual(drift, []);
    assert.equal(totalBytes, INDEX_HTML.length * 2 + APP_MJS.length + DIST_MODULE.length);
    assert.equal(serializeShellManifest(recomputed), serializeShellManifest(manifest));
    assert.equal(recomputed.resources[0].integrity, sha256Integrity(Buffer.from(INDEX_HTML)));
    assert.equal(recomputed.resources[3].mediaType, "application/javascript");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("verify mode names every drifted pin with its old and new value", () => {
  const projectRoot = createFixtureProject();
  try {
    const manifest = fixtureManifest(projectRoot);
    const stalePin = manifest.resources.find((resource) => resource.url === "/dist/src/offline/index.js");
    const staleIntegrity = `sha256:${"a".repeat(64)}`;
    stalePin.byteLength = 14213;
    stalePin.integrity = staleIntegrity;
    const { drift } = recomputeShellManifest(manifest, { projectRoot });
    assert.deepEqual(
      drift.map(({ url, field, pinned, actual }) => ({ url, field, pinned, actual })),
      [
        {
          url: "/dist/src/offline/index.js",
          field: "byteLength",
          pinned: 14213,
          actual: DIST_MODULE.length,
        },
        {
          url: "/dist/src/offline/index.js",
          field: "integrity",
          pinned: staleIntegrity,
          actual: sha256Integrity(Buffer.from(DIST_MODULE)),
        },
      ],
    );
    const report = formatDriftReport(drift);
    assert.match(report, /2 drifted values/);
    assert.match(report, /\/dist\/src\/offline\/index\.js \(dist\/src\/offline\/index\.js\)/);
    assert.match(report, new RegExp(`byteLength: 14213 -> ${DIST_MODULE.length}`));
    assert.match(report, /offline:shell-manifest:generate/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects a manifest the service worker itself would refuse", () => {
  const projectRoot = createFixtureProject();
  try {
    const manifest = fixtureManifest(projectRoot);
    assert.throws(() => recomputeShellManifest({ ...manifest, format: "other" }, { projectRoot }), /format must be/);
    assert.throws(() => recomputeShellManifest({ ...manifest, deploymentId: "" }, { projectRoot }), /deploymentId/);
    assert.throws(() => recomputeShellManifest({ ...manifest, resources: [] }, { projectRoot }), /no resources/);
    assert.throws(
      () =>
        recomputeShellManifest({ ...manifest, resources: [manifest.resources[0], manifest.resources[0]] }, {
          projectRoot,
        }),
      /Duplicate application shell URL/,
    );
    // The worker resolves every entry against the manifest URL before its own
    // duplicate check, so equivalent spellings are one URL there. Catching it
    // on raw strings alone would call this manifest current and fail later, in
    // the browser suite, as an unexplained `shellReady === false`.
    assert.throws(
      () =>
        recomputeShellManifest(
          { ...manifest, resources: [manifest.resources[1], { ...manifest.resources[1], url: "app.mjs" }] },
          { projectRoot },
        ),
      /Duplicate application shell URL: app\.mjs \(resolves to /,
    );
    assert.throws(
      () =>
        recomputeShellManifest(
          { ...manifest, resources: [{ ...manifest.resources[0], url: "./missing.mjs" }] },
          { projectRoot },
        ),
      /does not exist/,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// The #1280 regression, reproduced as a fixture (honua-io/honua-sdk-js#1286
// REQ-006). Adding 13 error codes to src/core/error-classifications.ts changed
// the compiled dist/src/core/error-classifications.js, the committed shell
// manifest still pinned the old length and digest, and the only symptom was 16
// offline browser tests reporting `shellReady:false` roughly 40 minutes into
// the run. This asserts the two behaviours that turn that into a named, early
// failure: `check` rejects the stale pin and names the exact compiled asset,
// and `write` refreshes it to the real bytes.
test("a changed error-classifications build names its own stale pin before any browser runs", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-shell-manifest-1280-"));
  const compiledPath = "dist/src/core/error-classifications.js";
  try {
    fs.mkdirSync(path.join(projectRoot, EXAMPLE_DIRECTORY), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "dist/src/core"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, EXAMPLE_DIRECTORY, "index.html"), INDEX_HTML);
    const before = "export const CLASSIFICATIONS = ['a'];\n";
    fs.writeFileSync(path.join(projectRoot, compiledPath), before);

    const manifest = recomputeShellManifest(
      {
        format: "honua.offline-shell-manifest.v1",
        deploymentId: "offline-region-reference-fixture-v1",
        resources: [
          { url: "./", byteLength: 0, integrity: `sha256:${"0".repeat(64)}`, mediaType: "text/html" },
          {
            url: `/${compiledPath}`,
            byteLength: 0,
            integrity: `sha256:${"0".repeat(64)}`,
            mediaType: "application/javascript",
          },
        ],
      },
      { projectRoot },
    ).manifest;
    assert.deepEqual(recomputeShellManifest(manifest, { projectRoot }).drift, []);

    // The source change lands; the committed manifest does not.
    const after = "export const CLASSIFICATIONS = ['a','b','c','d','e','f','g','h','i','j','k','l','m'];\n";
    fs.writeFileSync(path.join(projectRoot, compiledPath), after);

    const { drift, manifest: refreshed } = recomputeShellManifest(manifest, { projectRoot });
    assert.deepEqual(
      drift.map((entry) => `${entry.file}:${entry.field}`),
      [`${compiledPath}:byteLength`, `${compiledPath}:integrity`],
    );
    const report = formatDriftReport(drift);
    assert.match(report, new RegExp(compiledPath.replaceAll("/", "\\/").replaceAll(".", "\\.")));
    assert.match(report, new RegExp(`byteLength: ${before.length} -> ${after.length}`));

    // Normalization refreshes the pin to the exact compiled asset, and the
    // refreshed manifest is then current.
    const pin = refreshed.resources.find((resource) => resource.url === `/${compiledPath}`);
    assert.equal(pin.byteLength, after.length);
    assert.equal(pin.integrity, sha256Integrity(Buffer.from(after)));
    assert.deepEqual(recomputeShellManifest(refreshed, { projectRoot }).drift, []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// The committed shell manifest must keep pinning the compiled asset that caused
// #1280; dropping it from the shell would make the regression above unobservable.
test("the committed shell manifest pins the compiled error classifications", () => {
  const manifest = loadShellManifest();
  assert.ok(
    manifest.resources.some((resource) => resource.url === "/dist/src/core/error-classifications.js"),
    "the offline shell must keep pinning dist/src/core/error-classifications.js",
  );
});

const distBuilt = fs.existsSync(path.join(ROOT, "dist"));

test("the committed manifest is current against the built shell", { skip: !distBuilt }, () => {
  const { drift, manifest } = recomputeShellManifest(loadShellManifest());
  assert.deepEqual(drift, [], drift.length === 0 ? "" : formatDriftReport(drift));
  assert.equal(serializeShellManifest(manifest), fs.readFileSync(path.join(ROOT, MANIFEST_PATH), "utf8"));
  const stdout = execFileSync(process.execPath, ["scripts/offline-shell-manifest.mjs", "check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(stdout, /resources pinned, \d+ bytes, no drift/);
});
