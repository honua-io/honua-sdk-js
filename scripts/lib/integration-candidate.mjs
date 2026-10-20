import assert from "node:assert/strict";

const sha = /^[0-9a-f]{40}$/;
const image = /^ghcr\.io\/honua-io\/honua-server@sha256:[0-9a-f]{64}$/;
const dispatch = /^nightly-certification-[1-9][0-9]*-[1-9][0-9]*$/;

function utc(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value ?? "")) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Resolve only explicit self-contained dispatch inputs; ordinary and external runs keep their existing pins. */
export function resolveIntegrationCandidate(env) {
  const selected = [env.HONUA_CANDIDATE_IMAGE, env.HONUA_CANDIDATE_SOURCE_SHA, env.HONUA_NIGHTLY_DISPATCH_ID];
  const selfContainedCut = !env.HONUA_INTEGRATION_BASE_URL && env.HONUA_CANDIDATE_CUT_INPUT;
  if (!selected.some(Boolean) && !selfContainedCut) return null;
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "candidate overrides require workflow_dispatch");
  assert.ok(!env.HONUA_INTEGRATION_BASE_URL, "candidate overrides cannot mix with an external base URL");
  assert.notEqual(env.HONUA_LICENSED_CERTIFICATION, "true", "candidate overrides cannot mix with licensed certification");
  assert.match(env.HONUA_CANDIDATE_IMAGE ?? "", image, "candidate image must be an immutable Honua server digest");
  assert.match(env.HONUA_CANDIDATE_SOURCE_SHA ?? "", sha, "candidate source must be a full lowercase SHA");
  assert.ok(utc(env.HONUA_CANDIDATE_CUT_INPUT), "candidate cut must be a valid UTC timestamp");
  if (env.HONUA_NIGHTLY_DISPATCH_ID) producerRunIdentity(env);
  return {
    HONUA_INTEGRATION_SERVER_IMAGE: env.HONUA_CANDIDATE_IMAGE,
    HONUA_INTEGRATION_SERVER_COMMIT: env.HONUA_CANDIDATE_SOURCE_SHA,
    HONUA_CANDIDATE_CUT_AT: env.HONUA_CANDIDATE_CUT_INPUT,
  };
}

/** The receiver authenticates these values against its actual dispatched GitHub run. */
export function producerRunIdentity(env) {
  if (!env.HONUA_NIGHTLY_DISPATCH_ID) return undefined;
  assert.match(env.HONUA_NIGHTLY_DISPATCH_ID, dispatch, "invalid nightly dispatch identity");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "nightly evidence requires workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, "honua-io/honua-sdk-js", "wrong producer repository");
  assert.match(env.GITHUB_SHA ?? "", sha, "missing producer source SHA");
  assert.match(env.GITHUB_REF ?? "", /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/, "invalid workflow ref");
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${env.GITHUB_REPOSITORY}/.github/workflows/integration.yml@${env.GITHUB_REF}`, "wrong producer workflow");
  const integer = (value) => {
    assert.match(value ?? "", /^[1-9][0-9]*$/, "missing positive run identity");
    const result = Number(value);
    assert.ok(Number.isSafeInteger(result), "run identity exceeds safe integer range");
    return result;
  };
  return {
    repository: env.GITHUB_REPOSITORY,
    workflow: "integration.yml",
    run_id: integer(env.GITHUB_RUN_ID),
    run_attempt: integer(env.GITHUB_RUN_ATTEMPT),
    dispatch_id: env.HONUA_NIGHTLY_DISPATCH_ID,
  };
}

export function bindNightlyCandidateIdentity(identity, env) {
  const run = producerRunIdentity(env);
  if (!run) return identity;
  assert.notEqual(env.HONUA_CERTIFICATION_EXTERNAL, "true", "nightly candidate cannot use external certification");
  assert.equal(env.HONUA_INTEGRATION_BASE_URL, "http://localhost:8080", "nightly candidate must use the owned self-contained endpoint");
  assert.equal(identity.requestContext?.baseUrl, "http://localhost:8080", "receipt endpoint differs from owned candidate");
  const candidate = resolveIntegrationCandidate({ ...env, HONUA_INTEGRATION_BASE_URL: "" });
  assert.equal(identity.producerSourceSha, env.GITHUB_SHA, "receipt producer source differs from executing source");
  assert.equal(identity.sourceSha, candidate.HONUA_INTEGRATION_SERVER_COMMIT, "receipt server source differs from selected candidate");
  assert.equal(identity.imageDigest, candidate.HONUA_INTEGRATION_SERVER_IMAGE.split("@")[1], "receipt image differs from selected candidate");
  assert.equal(identity.cutAt, candidate.HONUA_CANDIDATE_CUT_AT, "receipt cut differs from selected candidate");
  return { ...identity, producerRun: run };
}

/** Prove the image Docker actually pulled has the selected digest and source revision. */
export function verifyIntegrationImage(inspect, candidate) {
  assert.equal(inspect.length, 1, "expected one inspected candidate image");
  assert.ok(inspect[0].RepoDigests?.includes(candidate.HONUA_INTEGRATION_SERVER_IMAGE), "pulled candidate digest mismatch");
  assert.equal(inspect[0].Config?.Labels?.["org.opencontainers.image.revision"],
    candidate.HONUA_INTEGRATION_SERVER_COMMIT, "pulled candidate source mismatch");
  assert.match(inspect[0].Id ?? "", /^sha256:[0-9a-f]{64}$/, "missing pulled image ID");
  return { image: candidate.HONUA_INTEGRATION_SERVER_IMAGE, sourceSha: candidate.HONUA_INTEGRATION_SERVER_COMMIT,
    imageId: inspect[0].Id };
}
