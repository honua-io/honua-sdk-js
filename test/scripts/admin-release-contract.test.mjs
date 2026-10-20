import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertReleaseAdminContract } from "../../scripts/lib/admin-release-contract.mjs";

const client = {
  paths: {
    "/connections": { post: { operationId: "createConnection" } },
    "/connections/{id}": { get: { operationId: "getConnection" } },
  },
};
const release = {
  paths: { ...client.paths, "/packages": { post: { operationId: "publishMapPackage" } } },
};
function verify(document, overrides = {}, text = JSON.stringify(document)) {
  assertReleaseAdminContract({
    releaseManifestServerSha: "87966c3f7b6c840ffc4d4da0b451714ab717b18a",
    releaseManifestSpecSha256: createHash("sha256").update(JSON.stringify(document)).digest("hex"),
    releaseManifestOperationCount: 3,
    releaseManifestStatus: "compatible",
    ...overrides,
  }, client, text);
}

test("accepts a release with all required routes and an additive operation", () => {
  assert.doesNotThrow(() => verify(release));
});
test("rejects replaced operations even when the release count is unchanged", () => {
  const changed = structuredClone(release);
  changed.paths["/connections"].post.operationId = "unrelatedOperation";
  assert.throws(() => verify(changed), /createConnection requires POST \/connections, received missing/);
});
test("rejects method and path drift despite preserving operation IDs and count", () => {
  const method = structuredClone(release);
  method.paths["/connections"] = { put: method.paths["/connections"].post };
  assert.throws(() => verify(method), /requires POST \/connections, received PUT \/connections/);
  const path = structuredClone(release);
  path.paths["/moved"] = path.paths["/connections"];
  delete path.paths["/connections"];
  assert.throws(() => verify(path), /requires POST \/connections, received POST \/moved/);
});
test("rejects schema byte drift even with an identical route inventory", () => {
  const changed = { ...release, components: { schemas: { NewSchema: { type: "string" } } } };
  assert.throws(() => verify(release, {}, JSON.stringify(changed)), /OpenAPI digest mismatch/);
});
test("rejects stale counts and missing immutable pins", () => {
  assert.throws(() => verify(release, { releaseManifestOperationCount: 396 }), /expected 396, received 3/);
  assert.throws(() => verify(release, { releaseManifestSpecSha256: undefined }), /pinned OpenAPI SHA-256/);
  assert.throws(() => verify(release, { releaseManifestServerSha: "trunk" }), /immutable server SHA/);
  assert.throws(() => verify(release, { releaseManifestStatus: "blocked" }), /requires releaseManifestStatus=compatible/);
});
test("rejects ambiguous or absent operation inventories", () => {
  const duplicate = structuredClone(release);
  duplicate.paths["/packages"].post.operationId = "createConnection";
  assert.throws(() => verify(duplicate), /duplicate operationId/);
  delete duplicate.paths["/packages"].post.operationId;
  assert.throws(() => verify(duplicate), /missing or duplicate operationId/);
  assert.throws(() => verify({ paths: {} }), /inventory is empty/);
});
