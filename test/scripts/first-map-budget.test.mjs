import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFirstMapBuildResolution } from "../../scripts/lib/first-map-build-resolution.mjs";
import { evaluateFirstMapBudget, firstMapVerdict } from "../../scripts/lib/first-map-budget.mjs";

test("the canonical byte ceilings include the boundary and reject either overage", () => {
  assert.equal(evaluateFirstMapBudget({ javascriptBytes: 2_010_000, javascriptGzipBytes: 534_000 }), "passed");
  assert.equal(evaluateFirstMapBudget({ javascriptBytes: 2_010_001, javascriptGzipBytes: 534_000 }), "failed");
  assert.equal(evaluateFirstMapBudget({ javascriptBytes: 2_010_000, javascriptGzipBytes: 534_001 }), "failed");
});

test("a successful build under a raised Vite ceiling cannot emit a passing receipt", () => {
  assert.deepEqual(firstMapVerdict({ buildStatus: "passed", peerIdentityStatus: "passed",
    measurement: { javascriptBytes: 2_037_902, javascriptGzipBytes: 547_069 } }),
  { budgetStatus: "failed", status: "failed" });
});

test("missing, empty, nonfinite and fractional measurements fail closed", () => {
  for (const value of [undefined, 0, -1, NaN, Infinity, 1.5, "1"]) {
    assert.equal(evaluateFirstMapBudget({ javascriptBytes: value, javascriptGzipBytes: 1 }), "failed");
    assert.equal(evaluateFirstMapBudget({ javascriptBytes: 1, javascriptGzipBytes: value }), "failed");
  }
});

test("passing bytes cannot hide a failed build or mixed peer graph", () => {
  const measurement = { javascriptBytes: 1_979_893, javascriptGzipBytes: 523_377 };
  for (const [buildStatus, peerIdentityStatus] of [["failed", "passed"], ["passed", "failed"]]) {
    assert.equal(firstMapVerdict({ buildStatus, peerIdentityStatus, measurement }).status, "failed");
  }
  assert.equal(firstMapVerdict({ buildStatus: "passed", peerIdentityStatus: "passed", measurement }).status, "passed");
});

async function withResolutionFile(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "honua-first-map-resolution-test-"));
  try { await run(path.join(directory, "resolution.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("early build failure retains its original diagnostic in a serializable failed receipt", async () => {
  await withResolutionFile(async (file) => {
    const { unavailable, resolution } = await readFirstMapBuildResolution(file, "Cannot resolve public SDK export");
    assert.equal(resolution, undefined);
    assert.equal(unavailable.diagnostic, "Cannot resolve public SDK export");
    assert.match(unavailable.resolutionDiagnostic, /ENOENT/);
    const receipt = JSON.parse(JSON.stringify({ ...unavailable, peerIdentityStatus: "unverified",
      ...firstMapVerdict(unavailable) }));
    assert.equal(receipt.buildStatus, "failed");
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.budgetStatus, "failed");
    assert.equal(receipt.measurement, null);
    assert.equal(receipt.peerIdentityStatus, "unverified");
  });
});

test("emitted inventory survives a later budget failure for real byte measurement", async () => {
  await withResolutionFile(async (file) => {
    const inventory = { mode: "packed", bundle: [{ kind: "chunk", fileName: "app.js" }] };
    await writeFile(file, JSON.stringify(inventory));
    const result = await readFirstMapBuildResolution(file, "First Map JavaScript bundle exceeds ceiling");
    assert.deepEqual(result, { resolution: inventory });
  });
});

test("successful build inventory is returned without a diagnostic failure", async () => {
  await withResolutionFile(async (file) => {
    const inventory = { mode: "packed", bundle: [] };
    await writeFile(file, JSON.stringify(inventory));
    assert.deepEqual(await readFirstMapBuildResolution(file), { resolution: inventory });
  });
});

test("missing inventory without a recorded build failure still refuses admission", async () => {
  await withResolutionFile(async (file) => {
    await assert.rejects(readFirstMapBuildResolution(file), { code: "ENOENT" });
  });
});

test("invalid inventory cannot mask the original build failure or become a passing measurement", async () => {
  await withResolutionFile(async (file) => {
    await writeFile(file, "{invalid");
    const result = await readFirstMapBuildResolution(file, "Build failed before valid output");
    assert.equal(result.unavailable.diagnostic, "Build failed before valid output");
    assert.equal(firstMapVerdict(result.unavailable).status, "failed");
    await assert.rejects(readFirstMapBuildResolution(file), SyntaxError);
  });
});
