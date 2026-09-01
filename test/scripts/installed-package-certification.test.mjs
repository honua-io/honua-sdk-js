import assert from "node:assert/strict";
import test from "node:test";
import { buildReceipt } from "../../scripts/installed-package-certification.mjs";

const candidate = { release: "2026.1", package: { coordinate: "@honua/sdk-js", version: "0.1.9-beta.0" },
  server: { digest: `sha256:${"3".repeat(64)}` }, install: { localLinks: false }, defaultBlocker: "honua-sdk-js#1113" };
const denominator = { rows: [
  { id: "a", counts: true, family: "protocol-operation", operation: "query", capabilityKey: "serve.query" },
  { id: "terminal-journey:admin:b", counts: true, family: "terminal-journey", operation: "admin", capabilityKey: "admin" },
  { id: "c", counts: false, family: "sdk-operation", operation: "preview", capabilityKey: "preview" },
] };

test("materializes every counting row without silent skips", () => {
  const receipt = buildReceipt({ candidate, denominator, observations: [{ id: "a", verdict: "pass" }], generatedAt: "2026-09-01T00:00:00Z" });
  assert.deepEqual(receipt.summary, { total: 2, pass: 1, fail: 0, blocked: 1 });
  assert.equal(receipt.operations[1].blockedBy, "honua-sdk-js#1424");
  assert.equal(receipt.verdict, "not-certified");
});

test("rejects unknown verdicts", () => {
  assert.throws(() => buildReceipt({ candidate, denominator, observations: [{ id: "a", verdict: "skip" }] }), /invalid verdict skip/);
});
