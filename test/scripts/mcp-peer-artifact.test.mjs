import assert from "node:assert/strict";
import test from "node:test";
import { peerReceiptFromTarball, verifyMcpPeerArtifact, verifyRecordedMcpPeer } from "../../scripts/lib/mcp-peer-artifact.mjs";
import { mcpArtifact } from "./mcp-peer-artifact-fixture.mjs";

function fixture(peer = "^0.1.17 || ^0.2.0") {
  const artifact = mcpArtifact("0.1.19", peer);
  return { artifact, manifest: { ...artifact.manifest, integrity: artifact.integrity, tarball: artifact.tarball } };
}

test("peer derives from integrity-verified actual package JSON and agrees with registry", async () => {
  const { artifact, manifest } = fixture();
  const receipt = await verifyMcpPeerArtifact(manifest, { fetchFn: async (url, options) => {
    assert.equal(url, artifact.tarball);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response(artifact.bytes);
  } });
  assert.equal(receipt.sdkPeerRange, "^0.1.17 || ^0.2.0");
  assert.equal(receipt.packageJsonSha256, artifact.packageJsonSha256);
  assert.equal(verifyRecordedMcpPeer(receipt, { pin: receipt.pin, integrity: receipt.integrity }), receipt.sdkPeerRange);
});

test("tampered tarball, wrong package identity and mismatched registry peer refuse", () => {
  const { artifact, manifest } = fixture();
  assert.throws(() => peerReceiptFromTarball(manifest, Buffer.from("tampered")), /do not match/);
  assert.throws(() => peerReceiptFromTarball({ ...manifest, version: "0.1.20" }, artifact.bytes), /identity mismatch/);
  assert.throws(() => peerReceiptFromTarball({ ...manifest, name: "@honua/unrelated" }, artifact.bytes), /identity mismatch/);
  assert.throws(() => peerReceiptFromTarball({ ...manifest, peerDependencies: { "@honua/sdk-js": "*" } }, artifact.bytes), /registry peer differs/);
  const missing = fixture(null);
  assert.throws(() => peerReceiptFromTarball(missing.manifest, missing.artifact.bytes), /must declare/);
});

test("foreign-origin URLs, embedded credentials, redirects and oversized responses refuse", async () => {
  const { manifest } = fixture();
  for (const tarball of ["https://evil.invalid/a.tgz", "https://x@registry.npmjs.org/a.tgz", `${manifest.tarball}?token=x`]) {
    await assert.rejects(verifyMcpPeerArtifact({ ...manifest, tarball }, { fetchFn: () => assert.fail("must reject before fetch") }), /public npm registry/);
  }
  await assert.rejects(verifyMcpPeerArtifact(manifest, { fetchFn: async () => new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }) }), /HTTP 302/);
  await assert.rejects(verifyMcpPeerArtifact(manifest, { fetchFn: async () => new Response("small", { headers: { "content-length": String(33 * 1024 * 1024) } }) }), /byte limit/);
});

test("offline receipt refuses another pin, integrity, or missing package metadata", () => {
  const { artifact, manifest } = fixture();
  const receipt = peerReceiptFromTarball(manifest, artifact.bytes);
  const expected = { pin: receipt.pin, integrity: receipt.integrity };
  assert.throws(() => verifyRecordedMcpPeer(receipt, { ...expected, pin: "@honua/mcp-server@0.1.20" }), /exact generated pin/);
  assert.throws(() => verifyRecordedMcpPeer(receipt, { ...expected, integrity: `sha512-${"B".repeat(86)}==` }), /exact generated pin/);
  assert.throws(() => verifyRecordedMcpPeer({ ...receipt, packageJsonSha256: "missing" }, expected), /verified package metadata/);
});
