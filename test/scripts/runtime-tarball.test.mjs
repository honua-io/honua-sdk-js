import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluateRuntimeTarball } from "../../scripts/lib/runtime-tarball.mjs";

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
