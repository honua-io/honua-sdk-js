import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildReceipt, withInstalledCandidate } from "../../scripts/installed-package-certification.mjs";

const candidate = { release: "2026.1", package: { coordinate: "@honua/sdk-js", version: "0.1.9-beta.0" },
  server: { digest: `sha256:${"3".repeat(64)}` }, install: { localLinks: false }, defaultBlocker: "honua-sdk-js#1113" };
const denominator = { rows: [
  { id: "a", counts: true, family: "protocol-operation", operation: "query", capabilityKey: "serve.query" },
  { id: "terminal-journey:admin:b", counts: true, family: "terminal-journey", operation: "admin", capabilityKey: "admin" },
  { id: "d", counts: true, family: "protocol-operation", operation: "metadata" },
  { id: "c", counts: false, family: "sdk-operation", operation: "preview", capabilityKey: "preview" },
] };

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item) ?? "null").join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("materializes every counting row without silent skips", () => {
  const receipt = buildReceipt({ candidate, denominator, observations: [{ id: "a", verdict: "pass" }], generatedAt: "2026-09-01T00:00:00Z" });
  assert.deepEqual(receipt.summary, { total: 3, pass: 1, fail: 0, blocked: 2 });
  assert.equal(receipt.operations[1].blockedBy, "honua-sdk-js#1424");
  assert.equal(receipt.verdict, "not-certified");
});

test("rejects unknown verdicts", () => {
  assert.throws(() => buildReceipt({ candidate, denominator, observations: [{ id: "a", verdict: "skip" }] }), /invalid verdict skip/);
});

test("rejects duplicate observation IDs", () => {
  assert.throws(() => buildReceipt({ candidate, denominator, observations: [
    { id: "a", verdict: "fail" }, { id: "a", verdict: "pass" },
  ] }), /duplicate observation id a/);
});

test("receipt digest is reproducible from the serialized receipt", () => {
  const receipt = buildReceipt({ candidate, denominator, observations: [
    { id: "a", verdict: "pass" }, { id: "d", verdict: "pass" },
  ], generatedAt: "2026-09-01T00:00:00Z" });
  const { receiptDigest, ...serializedReceipt } = JSON.parse(JSON.stringify(receipt));
  assert.equal(receiptDigest, digest(canonical(serializedReceipt)));
});

test("rejects server image and digest drift before installing", async () => {
  await assert.rejects(() => withInstalledCandidate({
    package: { coordinate: "@honua/sdk-js", version: "0.1.9-beta.0" },
    server: { image: "ghcr.io/honua-io/honua-server@sha256:1", digest: "sha256:2" },
  }, async () => {}), /server image digest mismatch: sha256:1 vs sha256:2/);
});
