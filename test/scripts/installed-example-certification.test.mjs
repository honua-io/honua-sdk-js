import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { certifyInstalledExamples } from "../../scripts/installed-example-certification.mjs";

const stale = { schema: "honua.sdk-installed-example-certification-receipt/v1", generatedAt: "2026-09-01T23:39:42.869Z",
  summary: { total: 397, pass: 120, fail: 0, blocked: 0 }, verdict: "passed", verdicts: [] };

const withStaleReceipt = async (run) => {
  const dir = await mkdtemp(path.join(tmpdir(), "honua-example-cert-"));
  const output = path.join(dir, "installed-example-certification.json");
  await writeFile(output, `${JSON.stringify(stale, null, 2)}\n`);
  try { return await run(output); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("a rejected candidate replaces the previous receipt instead of leaving it to be uploaded", async () => {
  await withStaleReceipt(async (output) => {
    const receipt = await certifyInstalledExamples({ output, admit: async () => {
      throw new Error("node_modules/@honua/honua-migrate/node_modules/@honua/sdk: nested candidate version mismatch");
    } });
    assert.equal(receipt.verdict, "failed");
    assert.equal(receipt.admission.status, "failed");
    assert.match(receipt.admission.diagnostic, /nested candidate version mismatch/);
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.equal(written.receiptDigest, receipt.receiptDigest);
    assert.notEqual(written.generatedAt, stale.generatedAt);
    assert.deepEqual(written.verdicts, []);
  });
});

test("the previous receipt is gone before admission, so an aborted run cannot upload it", async () => {
  await withStaleReceipt(async (output) => {
    let survived;
    await certifyInstalledExamples({ output, admit: async () => {
      survived = existsSync(output);
      throw new Error("package provenance failed");
    } });
    assert.equal(survived, false);
  });
});

test("a failure after admission is recorded too, rather than crashing with no receipt", async () => {
  await withStaleReceipt(async (output) => {
    const receipt = await certifyInstalledExamples({ output, admit: async (candidate, callback) =>
      callback({ installed: { resolved: "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.1.9-beta.0.tgz" },
        packageRoot: path.join(path.dirname(output), "missing-package-root") }) });
    assert.equal(receipt.verdict, "failed");
    assert.match(receipt.admission.diagnostic, /missing-package-root/);
    assert.equal(JSON.parse(await readFile(output, "utf8")).receiptDigest, receipt.receiptDigest);
  });
});
