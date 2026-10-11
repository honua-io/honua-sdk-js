import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNpmSync } from "../../scripts/lib/npm-cli.mjs";
import { evaluateRuntimeTarball, missingBrowserArtifactFiles } from "../../scripts/lib/runtime-tarball.mjs";

const policy = { metadata: ["package.json", "LICENSE"], ceiling: { compressedBytes: 100, unpackedBytes: 200 } };
const packed = { size: 90, unpackedSize: 180, files: ["package.json", "LICENSE", "dist/src/index.js", "dist/src/index.d.ts",
  "dist/browser/honua-sdk.min.js", "dist/browser/honua-sdk.esm.js"].map((path) => ({ path, size: 30 })) };

test("published metadata retains support-manifest references and CDN integrity", () => {
  const read = (relative) => JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"));
  const metadata = read("config/runtime-tarball-budget.v1.json").metadata;
  const registryPath = read("config/support-manifest.v1.json").rasterSourceRegistry;
  const schemaPath = path.posix.join(path.posix.dirname(registryPath), read(registryPath).$schema);
  for (const required of [registryPath, schemaPath, "dist/browser/honua-sdk.browser-artifacts.v1.json"]) {
    assert.ok(metadata.includes(required), `packed metadata must retain ${required}`);
  }
});

test("runtime budget accepts the complete runtime and records byte ownership", () => {
  const verdict = evaluateRuntimeTarball(packed, policy);
  assert.equal(verdict.status, "passed");
  assert.equal(Object.values(verdict.owners).reduce((sum, bytes) => sum + bytes, 0), packed.unpackedSize);
});

for (const path of ["samples/dist/catalog.json", "support/projections/evidence.json", "dist/src/migration/cli.js", "dist/browser/honua-sdk.min.js.map", "dist/src/test-fixture.json"]) {
  test(`runtime budget rejects leaked ${path} even below byte ceilings`, () => {
    const verdict = evaluateRuntimeTarball({ ...packed, files: [...packed.files, { path, size: 1 }] }, policy);
    assert.equal(verdict.status, "failed");
    assert.deepEqual(verdict.forbidden, [path]);
  });
}

test("runtime budget refuses missing licenses, runtime declarations and CDN bundles", () => {
  for (const path of ["LICENSE", "dist/src/index.d.ts", "dist/browser/honua-sdk.esm.js"]) {
    const verdict = evaluateRuntimeTarball({ ...packed, files: packed.files.filter((file) => file.path !== path) }, policy);
    assert.equal(verdict.status, "failed");
    assert.ok(verdict.missing.includes(path));
  }
});

test("compressed and unpacked ceilings independently reject regressions and invalid measurements", () => {
  for (const patch of [{ size: 101 }, { unpackedSize: 201 }, { size: 0 }, { unpackedSize: NaN }]) {
    assert.equal(evaluateRuntimeTarball({ ...packed, ...patch }, policy).status, "failed");
  }
});

test("packed browser inventory rejects excluded debug maps without requiring provenance sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "honua-browser-inventory-"));
  try {
    mkdirSync(path.join(root, "dist/browser"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "browser-inventory-fixture", version: "1.0.0", files: ["dist/browser/*.js", "dist/browser/manifest.json"] }));
    for (const file of ["esm.js", "min.js", "esm.js.map"]) writeFileSync(path.join(root, "dist/browser", file), "fixture");
    const manifest = { build: { inputs: [{ path: "src/not-published.ts" }] }, files: [{ path: "dist/browser/esm.js" }, { path: "dist/browser/min.js" }] };
    writeFileSync(path.join(root, "dist/browser/manifest.json"), JSON.stringify(manifest));
    const result = runNpmSync(["pack", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const [archive] = JSON.parse(result.stdout);
    const extracted = spawnSync("tar", ["-xOf", path.join(root, archive.filename), "package/dist/browser/manifest.json"], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    const shippedManifest = JSON.parse(extracted.stdout);
    assert.deepEqual(missingBrowserArtifactFiles(archive, shippedManifest), []);
    assert.deepEqual(missingBrowserArtifactFiles(archive, { ...manifest, files: [...manifest.files, { path: "dist/browser/esm.js.map" }] }), ["dist/browser/esm.js.map"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
