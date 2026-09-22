import assert from "node:assert/strict";
import test from "node:test";

import { canonical, sha256 } from "../../scripts/installed-certification-identity.mjs";
import { OGC_PROCESSES_DENOMINATOR_ROWS, joinInstalledPackageReceipt, renderMarkdown } from "../../scripts/qualify-ogc-processes-candidate.mjs";

const pkg = { coordinate: "@honua/sdk-js", version: "0.1.9-beta.0", integrity: `sha512-${"a".repeat(86)}==` };
const denominator = {
  rows: OGC_PROCESSES_DENOMINATOR_ROWS.map(({ id }) => ({ id, tier: id.includes("execution") ? "experimental" : "supported", counts: !id.includes("execution") })),
};
function installedReceipt(overrides = {}) {
  const body = {
    schema: "honua.sdk-installed-package-certification-receipt/v1",
    package: pkg,
    server: { digest: `sha256:${"2".repeat(64)}` },
    binding: { candidateDigest: `sha256:${"c".repeat(64)}` },
    verdict: "not-certified",
    summary: { total: 5, pass: 0, fail: 0, blocked: 5 },
    operations: denominator.rows.filter((row) => row.counts).map((row) => ({ id: row.id, verdict: "blocked", blockedBy: "honua-sdk-js#39" })),
    ...overrides,
  };
  return { ...body, receiptDigest: sha256(canonical(body)) };
}
const join = (receipt, qualification = { result: "passed" }) =>
  joinInstalledPackageReceipt({ installedReceipt: receipt, installedReceiptPath: "test-results/installed-package-certification.json", installedPackage: pkg, denominator, qualification });

test("joins by digest and records #39 verdicts beside this receipt without promoting them", () => {
  const receipt = installedReceipt();
  const joined = join(receipt);
  assert.equal(joined.receiptDigest, receipt.receiptDigest);
  assert.equal(joined.rows.length, OGC_PROCESSES_DENOMINATOR_ROWS.length);
  for (const row of joined.rows) {
    assert.equal(row.installedReceiptVerdict, row.counts ? "blocked" : "not-counted");
    assert.equal(row.thisReceipt, "observed-passing");
  }
  assert.match(joined.promotion, /^none/);
  assert.equal(join(receipt, { result: "failed" }).rows[0].thisReceipt, "not-observed");
});

test("refuses a #39 receipt for different package bytes or with a forged digest", () => {
  assert.throws(() => join(installedReceipt({ package: { ...pkg, integrity: `sha512-${"b".repeat(86)}==` } })), /different package bytes/);
  assert.throws(() => join({ ...installedReceipt(), verdict: "certified" }), /digest does not match/);
});

test("renders a failed receipt without a qualification", () => {
  const markdown = renderMarkdown({
    status: "failed",
    generatedAt: "2026-09-16T00:00:00Z",
    harnessSourceSha: "0".repeat(40),
    sdk: { ...pkg, sourceRevision: "1".repeat(40), provenance: "verified" },
    server: { image: "ghcr.io/honua-io/honua-server@sha256:x", revision: "2".repeat(40), runningImageMatches: false },
    diagnostic: "boom",
  });
  assert.match(markdown, /Status: \*\*failed\*\*/);
  assert.match(markdown, /## Diagnostic/);
  assert.doesNotMatch(markdown, /## Result/);
});
