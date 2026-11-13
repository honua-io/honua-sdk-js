import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REGISTRY,
  attestationsUrl,
  parseVerifyPublishedReleaseArgs,
  planPublishedArtifactTarget,
  verifyPublishedRelease,
} from "../../scripts/verify-published-release.mjs";
import {
  NOW,
  OWN_TAG_COMMIT,
  REPOSITORY,
  SEALED_TAG,
  failedCheck,
  fakeRegistry,
  manifest,
} from "./verify-published-release-fixture.mjs";

const MCP_VERSION = "0.3.2";
const MCP_TAG = `mcp-server-v${MCP_VERSION}`;

function planMcp(overrides = {}) {
  return planPublishedArtifactTarget({
    manifest,
    artifactId: "mcp-server",
    tag: MCP_TAG,
    commit: OWN_TAG_COMMIT,
    readPackageVersion: () => MCP_VERSION,
    ...overrides,
  });
}

async function verifyAlreadyPublished(mutate = () => {}) {
  const { targets, errors } = planMcp();
  return await verifyPublishedRelease({
    targets,
    sealedTag: MCP_TAG,
    sealedCommit: OWN_TAG_COMMIT,
    repository: REPOSITORY,
    fetchImpl: fakeRegistry(targets, mutate),
    planningErrors: errors,
    now: NOW,
    selection: "exact-version",
  });
}

test("a single own-tag artifact is planned against its own tag, ref and commit", () => {
  const { targets, errors } = planMcp();
  assert.deepEqual(errors, []);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].npmName, "@honua/mcp-server");
  assert.equal(targets[0].tag, MCP_TAG);
  assert.equal(targets[0].commit, OWN_TAG_COMMIT);
  assert.equal(targets[0].expectedRef, `refs/tags/${MCP_TAG}`);
  assert.equal(targets[0].workflow, ".github/workflows/publish-mcp-server.yml");
});

test("single-artifact planning refuses unknown, sealed and mismatched artifacts", () => {
  assert.match(planMcp({ artifactId: "nope" }).errors.join("\n"), /no artifact "nope"/u);
  assert.match(
    planMcp({ artifactId: "sdk-js", tag: SEALED_TAG }).errors.join("\n"),
    /bound to the sealed js-sdk cut/u,
  );
  assert.match(planMcp({ tag: "mcp-server-v0.3.1" }).errors.join("\n"), /is at 0\.3\.2/u);
  assert.match(planMcp({ commit: "abc" }).errors.join("\n"), /full 40-character commit/u);
  assert.match(planMcp({ readPackageVersion: () => "" }).errors.join("\n"), /carries no version/u);
  for (const plan of [planMcp({ artifactId: "nope" }), planMcp({ tag: "mcp-server-v0.3.1" })]) {
    assert.deepEqual(plan.targets, []);
  }
});

test("an already-published version from the same tag and commit verifies", async () => {
  const receipt = await verifyAlreadyPublished();
  assert.equal(receipt.status, "verified");
  assert.deepEqual(
    receipt.artifacts.map((artifact) => `${artifact.npmName}@${artifact.version}`),
    [`@honua/mcp-server@${MCP_VERSION}`],
  );
});

test("an already-published version built from another commit does not verify", async () => {
  const receipt = await verifyAlreadyPublished((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/mcp-server", MCP_VERSION);
    const target = {
      npmName: "@honua/mcp-server",
      version: MCP_VERSION,
      tag: MCP_TAG,
      commit: "3".repeat(40),
      workflow: ".github/workflows/publish-mcp-server.yml",
    };
    registry.attestations.get(url).attestations[0] = registry.envelope(
      registry.provenanceStatement(target, registry.tarballFor("@honua/mcp-server", MCP_VERSION)),
    );
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/mcp-server", "source-revision").detail, /3{40}/u);
});

test("an already-published version whose bytes do not match its integrity does not verify", async () => {
  const receipt = await verifyAlreadyPublished((registry) => {
    for (const url of registry.tarballs.keys()) registry.tarballs.set(url, Buffer.from("tampered"));
  });
  assert.equal(receipt.status, "failed");
  assert.equal(failedCheck(receipt, "@honua/mcp-server", "dist-integrity").status, "fail");
});

test("the CLI accepts a single artifact to verify", () => {
  const options = parseVerifyPublishedReleaseArgs(["--artifact", "mcp-server", "--tag", MCP_TAG, "--commit", OWN_TAG_COMMIT]);
  assert.equal(options.artifact, "mcp-server");
  assert.equal(options.tag, MCP_TAG);
});
