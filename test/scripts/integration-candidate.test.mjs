import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  bindNightlyCandidateIdentity, producerRunIdentity, resolveIntegrationCandidate, verifyIntegrationImage,
} from "../../scripts/lib/integration-candidate.mjs";
import { buildFragment } from "../../scripts/protocol-certification-fragment.mjs";

const env = {
  HONUA_CANDIDATE_IMAGE: `ghcr.io/honua-io/honua-server@sha256:${"a".repeat(64)}`,
  HONUA_CANDIDATE_SOURCE_SHA: "b".repeat(40),
  HONUA_CANDIDATE_CUT_INPUT: "2026-10-13T00:00:00Z",
  HONUA_NIGHTLY_DISPATCH_ID: "nightly-certification-123-2",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
  GITHUB_SHA: "c".repeat(40), GITHUB_REF: `refs/tags/nightly-candidate/${"c".repeat(40)}`,
  GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "3",
};
env.GITHUB_WORKFLOW_REF = `${env.GITHUB_REPOSITORY}/.github/workflows/integration.yml@${env.GITHUB_REF}`;
const candidate = resolveIntegrationCandidate(env);
const identity = {
  clientVersion: "0.2.0", deploymentTarget: "local-docker", sourceSha: env.HONUA_CANDIDATE_SOURCE_SHA,
  producerSourceSha: env.GITHUB_SHA, imageDigest: `sha256:${"a".repeat(64)}`,
  fixtureRevision: "0.2.0-alpha.1", cutAt: env.HONUA_CANDIDATE_CUT_INPUT,
  evidenceUri: "https://github.com/honua-io/honua-sdk-js/actions/runs/456",
  requestContext: { baseUrl: "http://localhost:8080", serviceId: "places", layerId: 1000 },
};
const executing = { ...env, HONUA_INTEGRATION_BASE_URL: "http://localhost:8080" };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

test("ordinary default and external runs retain their existing identity", () => {
  assert.equal(resolveIntegrationCandidate({}), null);
  assert.equal(resolveIntegrationCandidate({ HONUA_INTEGRATION_BASE_URL: "https://existing.test", HONUA_CANDIDATE_CUT_INPUT: env.HONUA_CANDIDATE_CUT_INPUT }), null);
  assert.equal(bindNightlyCandidateIdentity(identity, {}), identity);
  assert.equal(producerRunIdentity({}), undefined);
  assert.deepEqual(resolveIntegrationCandidate({ ...env, HONUA_NIGHTLY_DISPATCH_ID: "" }), candidate);
});

test("explicit candidates require the complete immutable tuple and refuse mixed modes", () => {
  assert.throws(() => resolveIntegrationCandidate({
    GITHUB_EVENT_NAME: "workflow_dispatch", HONUA_CANDIDATE_CUT_INPUT: env.HONUA_CANDIDATE_CUT_INPUT,
  }), /candidate image must be an immutable Honua server digest/);
  for (const key of ["HONUA_CANDIDATE_IMAGE", "HONUA_CANDIDATE_SOURCE_SHA", "HONUA_CANDIDATE_CUT_INPUT"]) {
    assert.throws(() => resolveIntegrationCandidate({ ...env, [key]: "" }));
  }
  for (const changes of [
    { HONUA_CANDIDATE_IMAGE: "ghcr.io/honua-io/honua-server:nightly" },
    { HONUA_CANDIDATE_SOURCE_SHA: "trunk" },
    { HONUA_CANDIDATE_CUT_INPUT: "2026-02-31T00:00:00Z" },
    { HONUA_CANDIDATE_CUT_INPUT: "2026-10-13T00:00:00Z\nINJECT=true" },
    { HONUA_INTEGRATION_BASE_URL: "https://existing.test" },
    { HONUA_LICENSED_CERTIFICATION: "true" }, { GITHUB_EVENT_NAME: "push" },
  ]) assert.throws(() => resolveIntegrationCandidate({ ...env, ...changes }));
});

test("nightly receipts require exact executing workflow and positive safe run identity", () => {
  assert.deepEqual(producerRunIdentity(env), {
    repository: "honua-io/honua-sdk-js", workflow: "integration.yml", run_id: 456,
    run_attempt: 3, dispatch_id: "nightly-certification-123-2",
  });
  for (const changes of [
    { GITHUB_REPOSITORY: "other/repository" }, { GITHUB_WORKFLOW_REF: "other.yml" },
    { GITHUB_SHA: "trunk" }, { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "trunk" }, { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ID: "9007199254740992" },
    { GITHUB_RUN_ATTEMPT: "" }, { HONUA_NIGHTLY_DISPATCH_ID: "injected\nvalue" },
  ]) assert.throws(() => producerRunIdentity({ ...env, ...changes }));
});

test("pulled image must match both the selected digest and OCI source revision", () => {
  const inspect = [{ RepoDigests: [env.HONUA_CANDIDATE_IMAGE], Id: `sha256:${"d".repeat(64)}`,
    Config: { Labels: { "org.opencontainers.image.revision": env.HONUA_CANDIDATE_SOURCE_SHA } } }];
  assert.deepEqual(verifyIntegrationImage(inspect, candidate), {
    image: env.HONUA_CANDIDATE_IMAGE, sourceSha: env.HONUA_CANDIDATE_SOURCE_SHA, imageId: inspect[0].Id,
  });
  assert.throws(() => verifyIntegrationImage([], candidate));
  assert.throws(() => verifyIntegrationImage([{ ...inspect[0], RepoDigests: [] }], candidate));
  assert.throws(() => verifyIntegrationImage([{ ...inspect[0], Config: { Labels: { "org.opencontainers.image.revision": "e".repeat(40) } } }], candidate));
});

test("final evidence cannot override actual producer, server, image, cut or owned endpoint", () => {
  assert.deepEqual(bindNightlyCandidateIdentity(identity, executing).producerRun, producerRunIdentity(env));
  for (const changes of [ { producerSourceSha: "d".repeat(40) }, { sourceSha: "d".repeat(40) },
    { imageDigest: `sha256:${"d".repeat(64)}` }, { cutAt: "2026-10-14T00:00:00Z" }, { requestContext: { baseUrl: "https://other.test" } } ]) {
    assert.throws(() => bindNightlyCandidateIdentity({ ...identity, ...changes }, executing));
  }
  for (const changes of [{ HONUA_CERTIFICATION_EXTERNAL: "true" }, { HONUA_INTEGRATION_BASE_URL: "https://other.test" }]) {
    assert.throws(() => bindNightlyCandidateIdentity(identity, { ...executing, ...changes }));
  }
});

test("producer run is inside the receipt digest and never turns missing observations into passes", () => {
  const fragment = buildFragment({ identity: bindNightlyCandidateIdentity(identity, executing),
    now: "2026-10-13T00:01:00Z", reports: [{ testResults: [{ name: "features",
      assertionResults: [{ title: "metadata [cert:featureserver/metadata#positive] [cert:featureserver/metadata#metadata] [cert:featureserver/metadata#media-schema]", status: "passed" }] }] }] });
  const observed = fragment.observations.find((row) => row.surface === "featureserver" && row.operation === "metadata");
  assert.equal(observed.result, "pass");
  assert.deepEqual(observed.evidence_receipt.identity.producer_run, producerRunIdentity(env));
  assert.equal(observed.evidence_digest, `sha256:${createHash("sha256").update(canonical(observed.evidence_receipt)).digest("hex")}`);
  const changed = structuredClone(observed.evidence_receipt);
  changed.identity.producer_run.run_attempt += 1;
  assert.notEqual(observed.evidence_digest, `sha256:${createHash("sha256").update(canonical(changed)).digest("hex")}`);
  assert.ok(fragment.observations.filter((row) => row !== observed).every((row) => row.result === "skip" && row.evidence_receipt === null));
});

test("actual workflow resolver writes only admitted values before image verification and startup", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/integration.yml", import.meta.url), "utf8");
  const resolveAt = workflow.indexOf("- name: Resolve explicit nightly candidate");
  assert.ok(workflow.indexOf("- name: Setup Node.js") < resolveAt);
  const verifyAt = workflow.indexOf("- name: Verify selected candidate image identity");
  assert.ok(resolveAt < verifyAt && verifyAt < workflow.indexOf("- name: Start self-contained Honua Server"));
  const block = workflow.slice(resolveAt).split("        run: |\n")[1].split("\n\n")[0];
  const script = block.split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "honua-candidate-control-"));
  try {
    mkdirSync(join(directory, "scripts/lib"), { recursive: true });
    copyFileSync(new URL("../../scripts/lib/integration-candidate.mjs", import.meta.url), join(directory, "scripts/lib/integration-candidate.mjs"));
    const scriptPath = join(directory, "resolve.sh");
    writeFileSync(scriptPath, script);
    const outputs = { GITHUB_ENV: join(directory, "env"), GITHUB_OUTPUT: join(directory, "output") };
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", scriptPath], { cwd: directory, env: { PATH: process.env.PATH, ...env, ...outputs }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(outputs.GITHUB_ENV, "utf8"), Object.entries(candidate).map(([key, value]) => `${key}=${value}\n`).join(""));
    assert.equal(readFileSync(outputs.GITHUB_OUTPUT, "utf8"), "selected=true\n");
    const rejected = { GITHUB_ENV: join(directory, "rejected-env"), GITHUB_OUTPUT: join(directory, "rejected-output") };
    const invalid = spawnSync("bash", ["--noprofile", "--norc", "-e", scriptPath], { cwd: directory, env: { PATH: process.env.PATH, ...env, ...rejected, HONUA_CANDIDATE_SOURCE_SHA: "trunk" }, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.equal(existsSync(rejected.GITHUB_ENV), false);
    assert.equal(existsSync(rejected.GITHUB_OUTPUT), false);
    const loneCut = spawnSync("bash", ["--noprofile", "--norc", "-e", scriptPath], {
      cwd: directory, env: { PATH: process.env.PATH, ...rejected, GITHUB_EVENT_NAME: "workflow_dispatch",
        HONUA_CANDIDATE_CUT_INPUT: env.HONUA_CANDIDATE_CUT_INPUT }, encoding: "utf8",
    });
    assert.notEqual(loneCut.status, 0);
    assert.match(loneCut.stderr, /candidate image must be an immutable Honua server digest/);
    assert.equal(existsSync(rejected.GITHUB_ENV), false);
    assert.equal(existsSync(rejected.GITHUB_OUTPUT), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
