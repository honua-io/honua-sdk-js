import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { readInstalledCandidateInput } from "../../scripts/installed-candidate-input.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const legacy = JSON.parse(await readFile(path.join(root, "config/installed-package-certification.v1.json"), "utf8"));
const artifacts = JSON.parse(await readFile(path.join(root, "config/release-artifacts.v1.json"), "utf8"));

async function fixture(run, change = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "honua-release-input-"));
  const manifest = { platformRelease: "2026.1-rc.3", components: { "honua-server": {
    image: "ghcr.io/honua-io/honua-server:nightly-fixture", digest: `sha256:${"a".repeat(64)}`, sha: "b".repeat(40),
  } }, clientArtifacts: Object.fromEntries(artifacts.included.map((artifact, index) => [artifact.id, {
    ecosystem: "npm", package: artifact.npmName, version: "0.1.14", filename: `${artifact.id}-0.1.14.tgz`,
    integrity: `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`,
    sourceSha: artifact.sourceBinding === "sealed-js-sdk-tag" ? "1".repeat(40) : String(index + 1).repeat(40),
    repository: artifacts.repository, publicationState: "published",
  }])) };
  change(manifest);
  const manifestBytes = stringify(manifest);
  const matrixBytes = "platformRelease: 2026.1-rc.3\n";
  await writeFile(path.join(directory, "platform-manifest.yaml"), manifestBytes);
  await writeFile(path.join(directory, "compatibility-matrix.yaml"), matrixBytes);
  const env = { HONUA_INSTALLED_CANDIDATE_MODE: "release-snapshot", HONUA_RELEASE_INPUT_DIRECTORY: directory,
    HONUA_RELEASE_REVIEWED_SHA: "c".repeat(40), HONUA_RELEASE_CANDIDATE_SHA: "d".repeat(40),
    HONUA_RELEASE_MANIFEST_SHA256: digest(manifestBytes), HONUA_RELEASE_MATRIX_SHA256: digest(matrixBytes) };
  try { return await run({ directory, env, manifest }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("default remains the exact legacy regression candidate", async () => {
  assert.deepEqual(await readInstalledCandidateInput({ env: {} }), legacy);
});

test("explicit snapshot input requires both immutable source revisions and adopted byte hashes", async () => {
  await assert.rejects(readInstalledCandidateInput({ env: { HONUA_INSTALLED_CANDIDATE_MODE: "release-snapshot" } }), /immutable release commit/);
  await fixture(async ({ env }) => {
    delete env.HONUA_RELEASE_MATRIX_SHA256;
    await assert.rejects(readInstalledCandidateInput({ env }), /bind the upstream-adopted bytes/);
  });
});

test("all eight published npm identities and the server come from the same adopted manifest", async () => {
  await fixture(async ({ env }) => {
    const candidate = await readInstalledCandidateInput({ env });
    assert.equal(candidate.packages.length, 8);
    assert.deepEqual(candidate.packages.map((entry) => entry.coordinate), artifacts.included.map((entry) => entry.npmName));
    assert.equal(candidate.package.version, "0.1.14");
    assert.equal(candidate.server.image, `ghcr.io/honua-io/honua-server@sha256:${"a".repeat(64)}`);
    assert.equal(candidate.releaseInput.candidateRevision, "d".repeat(40));
    assert.equal(candidate.releaseInput.manifest.digest, `sha256:${env.HONUA_RELEASE_MANIFEST_SHA256}`);
    assert.equal(candidate.releaseInput.matrix.digest, `sha256:${env.HONUA_RELEASE_MATRIX_SHA256}`);
    assert.equal(candidate.consumerDependencies["maplibre-gl"], legacy.consumerDependencies["maplibre-gl"]);
  });
});

test("post-admission manifest or matrix changes cannot retain their candidate binding", async () => {
  for (const name of ["platform-manifest.yaml", "compatibility-matrix.yaml"]) {
    await fixture(async ({ directory, env }) => {
      await writeFile(path.join(directory, name), "changed: true\n");
      await assert.rejects(readInstalledCandidateInput({ env }), /differs from upstream-adopted bytes/);
    });
  }
});

test("missing, duplicate, unpublished or unbound npm identities fail without legacy substitution", async () => {
  const cases = [
    [(manifest) => { delete manifest.clientArtifacts.sdk; }, /exactly one npm artifact/],
    [(manifest) => { manifest.clientArtifacts.duplicate = manifest.clientArtifacts["sdk-js"]; }, /exactly one npm artifact/],
    [(manifest) => { manifest.clientArtifacts["sdk-js"].required = false; }, /cannot be optional/],
    [(manifest) => { manifest.clientArtifacts["sdk-js"].publicationState = "missing"; }, /not published/],
    [(manifest) => { delete manifest.clientArtifacts["sdk-js"].sourceSha; }, /missing package source revision/],
    [(manifest) => { manifest.clientArtifacts["sdk-js"].repository = "other/repository"; }, /unexpected publication repository/],
  ];
  for (const [change, expected] of cases) {
    await fixture(async ({ env }) => assert.rejects(readInstalledCandidateInput({ env }), expected), change);
  }
});

test("snapshot release identity cannot fall back to the legacy release", async () => {
  for (const value of [undefined, "", "   "]) {
    await fixture(async ({ env }) => assert.rejects(readInstalledCandidateInput({ env }), /nonempty platformRelease/),
      (manifest) => { manifest.platformRelease = value; });
  }
});

test("server identity drift and unsafe tarball filenames are refused", async () => {
  await fixture(async ({ env }) => assert.rejects(readInstalledCandidateInput({ env }), /server image digest drift/),
    (manifest) => { manifest.components["honua-server"].image += `@sha256:${"e".repeat(64)}`; });
  await fixture(async ({ env }) => assert.rejects(readInstalledCandidateInput({ env }), /exact npm tarball filename/),
    (manifest) => { manifest.clientArtifacts["sdk-js"].filename = "../other.tgz"; });
});

test("split packages cannot silently come from a different coordinated cut", async () => {
  await fixture(async ({ env }) => assert.rejects(readInstalledCandidateInput({ env }), /coordinated SDK version/),
    (manifest) => { manifest.clientArtifacts.sdk.version = "0.1.13"; });
  await fixture(async ({ env }) => assert.rejects(readInstalledCandidateInput({ env }), /sealed SDK source/),
    (manifest) => { manifest.clientArtifacts.sdk.sourceSha = "e".repeat(40); });
});

test("an unknown mode never silently selects the old candidate", async () => {
  await assert.rejects(readInstalledCandidateInput({ env: { HONUA_INSTALLED_CANDIDATE_MODE: "latest" } }), /unknown installed candidate input mode/);
});

test("the legacy config is not rewritten by snapshot selection", async () => {
  const before = await readFile(path.join(root, "config/installed-package-certification.v1.json"), "utf8");
  await fixture(async ({ env }) => readInstalledCandidateInput({ env }));
  assert.equal(await readFile(path.join(root, "config/installed-package-certification.v1.json"), "utf8"), before);
});

test("workflow preserves the scheduled legacy regression and gates immutable selection before producers", async () => {
  const workflow = parse(await readFile(path.join(root, ".github/workflows/installed-package-certification.yml"), "utf8"));
  assert.equal(workflow.on.schedule[0].cron, "30 8 * * *");
  assert.equal(workflow.on.workflow_dispatch.inputs.candidate_mode.default, "legacy-regression");
  const steps = workflow.jobs.certify.steps;
  const admission = steps.findIndex((step) => step.id === "release_input");
  assert.match(steps[admission].uses, /^honua-io\/honua-release\/\.github\/actions\/candidate-input@[a-f0-9]{40}$/,
    "candidate admission must use the merged immutable upstream implementation");
  const verifier = steps.findIndex((step) => step.name === "Verify the selected release npm artifacts with the upstream verifier");
  const denominator = steps.findIndex((step) => step.name === "Validate the complete SDK package denominator before execution");
  const firstMap = steps.findIndex((step) => step.id === "quickstart");
  assert.ok(admission < verifier && verifier < denominator && denominator < firstMap);
  assert.match(steps[verifier].run, /pip install -r \.tmp\/honua-release-input\/tools\/requirements-nightly\.txt/);
  assert.match(steps[verifier].run, /verify_client_artifacts\.py[\s\S]*--ecosystem npm/);
  assert.ok(steps.findIndex((step) => step.name === "Remove receipts retained from previous candidates") < admission);
});


test("snapshot input cannot label a local tarball and removes a previous receipt before refusal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "honua-mixed-candidate-"));
  const output = path.join(directory, "receipt.json");
  try {
    await writeFile(output, JSON.stringify({ stale: true }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/installed-quickstart-budget.mjs"),
      "--local-tarball", "--output", output], { cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HONUA_INSTALLED_CANDIDATE_MODE: "release-snapshot" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release-snapshot cannot be combined with --local-tarball/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
