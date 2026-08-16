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
