import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { expectedSdkPublicationRef, migrationConsumerEnv, migrationNpmEnv, migratorCompatPackageName, parseArgs, recoverSdkPublicationRef, validateLock, verifyMigrationPublication } from "../../scripts/verify-migration-cohort.mjs";
import { migrationCohortDiagnostic, migrationCohortFetch } from "../../scripts/lib/migration-cohort-github.mjs";

// Drop a workflow token before any test reads it. The verifier process is
// separate and still sees the step env; these tests supply their own synthetic.
delete process.env.HONUA_MIGRATION_GITHUB_TOKEN;

const SYNTHETIC_TOKEN = "ghp_SyntheticMigrationCohortToken0123456789";

test("installed consumer processes receive runtime settings without publishing credentials or hooks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-consumer-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sensitiveKeys = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN",
    "GH_TOKEN", "GITHUB_TOKEN", "HONUA_MIGRATION_GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS",
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "HONUA_BUILD_RESERVATION", "HONUA_BUILD_RESERVATION_TOKEN", "FUTURE_PUBLISH_CREDENTIAL",
    "npm_config_registry", "NPM_CONFIG_LEGACY_PEER_DEPS", "PUBLISH_REF",
  ];
  // All credential values are invented sentinels; never copy the real test
  // process's environment into this probe or its retained assertion output.
  const supplied = {
    Path: path.dirname(process.execPath), SystemRoot: root, ComSpec: path.join(root, "cmd.exe"),
    TEMP: root, LANG: "C", TZ: "UTC",
    ...Object.fromEntries(sensitiveKeys.map((key) => [key, `fake-secret-${key}`])),
  };
  const env = migrationConsumerEnv(supplied, root);
  for (const key of ["Path", "SystemRoot", "ComSpec", "TEMP", "LANG", "TZ"]) {
    assert.equal(env[key], supplied[key]);
  }
  assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
  assert.equal(fs.readFileSync(env.npm_config_userconfig, "utf8"), "");
  assert.equal(fs.readFileSync(env.npm_config_globalconfig, "utf8"), "");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "process.stdout.write(JSON.stringify(process.env))"], {
    env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  for (const key of sensitiveKeys) {
    assert.notEqual(observed[key], supplied[key], `credential or hook crossed consumer boundary: ${key}`);
  }
  assert.equal(child.stdout.includes("fake-secret-"), false);
});

test("only script-disabled npm commands retain the existing build admission lease", () => {
  const consumer = { PATH: "/runtime/bin", npm_config_registry: "https://registry.npmjs.org" };
  const base = { HONUA_BUILD_RESERVATION: "/fake/lease", HONUA_BUILD_RESERVATION_TOKEN: "fake-lease-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-oidc", NODE_AUTH_TOKEN: "fake-registry-token" };
  assert.deepEqual(migrationNpmEnv(consumer, base), {
    ...consumer, HONUA_BUILD_RESERVATION: "/fake/lease", HONUA_BUILD_RESERVATION_TOKEN: "fake-lease-token",
  });
  assert.equal(consumer.HONUA_BUILD_RESERVATION, undefined);
  assert.equal(consumer.HONUA_BUILD_RESERVATION_TOKEN, undefined);
});

test("npm commands do not inherit the migration GitHub token", () => {
  const consumer = { PATH: "/runtime/bin", npm_config_registry: "https://registry.npmjs.org" };
  const base = {
    HONUA_MIGRATION_GITHUB_TOKEN: SYNTHETIC_TOKEN,
    GITHUB_TOKEN: "ghp_AmbientTokenMustStayUnused0123456789xx",
    GH_TOKEN: "ghp_AmbientGhTokenMustStayUnused012345678",
  };
  const env = migrationNpmEnv(consumer, base);
  assert.equal(env.HONUA_MIGRATION_GITHUB_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(JSON.stringify(env).includes("Synthetic"), false);
  assert.equal(JSON.stringify(env).includes("Ambient"), false);
});

const options = { sdkVersion: "0.2.4", migrateVersion: "0.3.0-beta.0", sdkSource: "registry" };
function pinnedCompatPackageName() {
  const lock = JSON.parse(fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  return migratorCompatPackageName(lock);
}
function fixture() {
  const compat = pinnedCompatPackageName();
  const packages = Object.fromEntries([
    ["@honua/sdk-js", "0.2.4"], ["@honua/honua-migrate", "0.3.0-beta.0"],
    ["@honua/sdk", "0.2.3"], [compat, "0.2.3"],
  ].map(([name, version]) => [`node_modules/${name}`, {
    version, resolved: `https://registry.npmjs.org/${name}/-/package-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  }]));
  packages["node_modules/@honua/honua-migrate"].dependencies = {
    "@honua/sdk": "^0.2.3",
    [compat]: "^0.2.3",
  };
  return { packages };
}

test("accepts compatible patch releases without requiring every component to publish together", () => {
  assert.equal(validateLock(fixture(), options).length, 4);
});

test("rejects an incompatible nested SDK even when the top-level SDK is correct", () => {
  const lock = fixture();
  lock.packages["node_modules/@honua/honua-migrate/node_modules/@honua/sdk"] = {
    ...lock.packages["node_modules/@honua/sdk"], version: "0.1.15",
  };
  assert.throws(() => validateLock(lock, options), /incompatible SDK generation/);
});

function releaseFixture() {
  const lock = fixture();
  lock.packages["node_modules/@honua/sdk-js"].version = "0.3.0";
  lock.packages["node_modules/@honua/sdk"].version = "0.2.10";
  lock.packages["node_modules/@honua/sdk-esri-compat"].version = "0.2.10";
  return lock;
}

const releaseOptions = { sdkVersion: "0.3.0", migrateVersion: "0.3.0-beta.0", sdkSource: "registry" };

test("allows the pinned migrator's registry packages to stay on generation 0.2", () => {
  assert.equal(validateLock(releaseFixture(), releaseOptions).length, 4);
  const packed = releaseFixture();
  packed.packages["node_modules/@honua/sdk-js"].resolved = "file:../sdk.tgz";
  assert.equal(validateLock(packed, { ...releaseOptions, sdkSource: "packed" }).find((item) => item.packed).packed, true);
});

test("the migrator registry hold expires when the pin moves past 0.3.0-beta.0", () => {
  for (const migrateVersion of ["0.3.0-beta.1", "0.3.0"]) {
    const lock = releaseFixture();
    lock.packages["node_modules/@honua/honua-migrate"].version = migrateVersion;
    assert.throws(() => validateLock(lock, { ...releaseOptions, migrateVersion }), /incompatible SDK generation/);
  }
});

test("the migrator registry hold allows the pinned package's nested registry layouts", () => {
  const layouts = [
    ["node_modules/@honua/honua-migrate/node_modules/@honua/sdk", "@honua/sdk"],
    ["node_modules/@honua/honua-migrate/node_modules/@honua/sdk-esri-compat", "@honua/sdk-esri-compat"],
    ["node_modules/@honua/sdk-esri-compat/node_modules/@honua/sdk", "@honua/sdk"],
    ["node_modules/@honua/honua-migrate/node_modules/@honua/sdk-esri-compat/node_modules/@honua/sdk", "@honua/sdk"],
  ];
  for (const [location, name] of layouts) {
    const lock = releaseFixture();
    lock.packages[location] = { ...lock.packages[`node_modules/${name}`] };
    delete lock.packages[`node_modules/${name}`];
    assert.ok(validateLock(lock, releaseOptions).some((item) => item.location === location));
  }
});

test("the migrator registry hold does not excuse a mismatched SDK or a non-migrator copy", () => {
  const mismatchedSdk = releaseFixture();
  mismatchedSdk.packages["node_modules/@honua/sdk-js"].version = "0.2.10";
  assert.throws(() => validateLock(mismatchedSdk, releaseOptions), /@honua\/sdk-js installed version/);

  const prohibited = [
    "node_modules/@honua/sdk-js/node_modules/@honua/sdk",
    "node_modules/@honua/sdk-js/node_modules/@honua/honua-migrate/node_modules/@honua/sdk",
    "node_modules/@honua/sdk-js/node_modules/@honua/sdk-esri-compat/node_modules/@honua/sdk",
    "node_modules/@honua/other/node_modules/@honua/sdk",
  ];
  for (const location of prohibited) {
    const lock = releaseFixture();
    lock.packages[location] = { ...lock.packages["node_modules/@honua/sdk"] };
    assert.throws(() => validateLock(lock, releaseOptions), /incompatible SDK generation/);
  }

  const older = releaseFixture();
  older.packages["node_modules/@honua/sdk"].version = "0.1.15";
  assert.throws(() => validateLock(older, releaseOptions), /incompatible SDK generation/);

  const nestedOlder = releaseFixture();
  nestedOlder.packages["node_modules/@honua/honua-migrate/node_modules/@honua/sdk"] = {
    ...nestedOlder.packages["node_modules/@honua/sdk"], version: "0.1.15",
  };
  assert.throws(() => validateLock(nestedOlder, releaseOptions), /incompatible SDK generation/);
});

test("rejects a second migrator version hidden inside the SDK", () => {
  const lock = fixture();
  lock.packages["node_modules/@honua/sdk-js/node_modules/@honua/honua-migrate"] = {
    ...lock.packages["node_modules/@honua/honua-migrate"], version: "0.2.0-beta.0",
  };
  assert.throws(() => validateLock(lock, options), /second migrator version/);
});

for (const resolved of ["file:../migrate", "https://private.example/package.tgz", "https://registry.npmjs.org/package.tgz?token=private"]) {
  test(`rejects registry evidence with a noncanonical resolution: ${resolved.split("?")[0]}`, () => {
    const lock = fixture();
    lock.packages["node_modules/@honua/honua-migrate"].resolved = resolved;
    assert.throws(() => validateLock(lock, options));
  });
}

test("allows only the top-level packed SDK to use a local tarball", () => {
  const lock = fixture();
  lock.packages["node_modules/@honua/sdk-js"].resolved = "file:../sdk.tgz";
  assert.equal(validateLock(lock, { ...options, sdkSource: "packed" })[0].packed, true);
  assert.throws(() => validateLock(lock, options), /resolve publicly/);
  lock.packages["node_modules/@honua/honua-migrate"].resolved = "file:../migrate.tgz";
  assert.throws(() => validateLock(lock, { ...options, sdkSource: "packed" }), /resolve publicly/);
});

test("refuses missing, linked and unhashed participating modules", () => {
  for (const mutation of [
    (lock) => delete lock.packages[`node_modules/${pinnedCompatPackageName()}`],
    (lock) => { lock.packages["node_modules/@honua/sdk"].link = true; },
    (lock) => delete lock.packages["node_modules/@honua/sdk"].integrity,
    (lock) => { lock.packages["node_modules/@honua/honua-migrate"].version = "0.2.0-beta.0"; },
  ]) {
    const lock = fixture();
    mutation(lock);
    assert.throws(() => validateLock(lock, options));
  }
});

test("rejects relaxations, arbitrary versions and ambiguous command options", () => {
  for (const argv of [
    ["--force"], ["--legacy-peer-deps"], ["--registry", "https://private.example"],
    ["--sdk-source", "workspace"], ["--sdk-source"], ["--receipt"],
    ["--sdk-source", "registry", "--sdk-source", "packed"],
    ["--sdk-publish-ref", "refs/heads/recovery"],
    ["--sdk-source", "registry", "--sdk-publish-ref", "refs/pull/123/head"],
    ["--sdk-source", "registry", "--sdk-publish-ref", "HEAD"],
  ]) assert.throws(() => parseArgs(argv));
  assert.deepEqual(parseArgs(["--sdk-source", "registry", "--receipt", "proof.json"]), {
    sdkSource: "registry", receipt: "proof.json",
  });
  const recovery = parseArgs(["--sdk-source", "registry", "--sdk-publish-ref", "refs/heads/recovery"]);
  assert.equal(recovery.sdkPublishRef, "refs/heads/recovery");
  for (const sdkPublishRef of ["refs/heads/recovery", "refs/tags/js-sdk-v0.2.4"]) {
    const cut = { sdkVersion: "0.2.4", sdkPublishRef };
    for (const name of ["@honua/sdk-js", "@honua/sdk", "@honua/sdk-client-compat"]) {
      assert.equal(expectedSdkPublicationRef({ name, version: "0.2.4" }, cut), sdkPublishRef);
      assert.equal(expectedSdkPublicationRef({ name, version: "0.2.3" }, cut), undefined);
    }
    assert.equal(expectedSdkPublicationRef({ name: "@honua/honua-migrate", version: "0.2.4" }, cut), undefined);
  }
  for (const sdkPublishRef of ["refs/tags/js-sdk-v0.2.3", "refs/pull/123/head", "HEAD"]) {
    assert.throws(() => expectedSdkPublicationRef({ name: "@honua/sdk-js", version: "0.2.4" }, {
      sdkVersion: "0.2.4", sdkPublishRef,
    }), /this release tag or a recovery branch/);
  }
});


const provenanceType = "https://slsa.dev/provenance/v1";
function recoveryFixture() {
  const commit = "a".repeat(40);
  return {
    item: { name: "@honua/sdk-js", version: "0.2.4" }, tag: "js-sdk-v0.2.4", commit,
    proof: { status: "failed", artifacts: [{ npmName: "@honua/sdk-js", version: "0.2.4", checks: [
      { id: "provenance-subject", status: "pass" }, { id: "source-revision", status: "fail" },
    ] }] },
    statement: { predicateType: provenanceType, predicate: {
      buildDefinition: { externalParameters: { workflow: {
        repository: "https://github.com/honua-io/honua-sdk-js", path: ".github/workflows/publish-js-sdk.yml",
        ref: "refs/heads/recovery/0.2.4",
      } }, resolvedDependencies: [{ digest: { gitCommit: commit } }] },
      runDetails: { metadata: { invocationId: "https://github.com/honua-io/honua-sdk-js/actions/runs/123/attempts/2" } },
    } },
    run: { id: 123, run_attempt: 2, repository: { full_name: "honua-io/honua-sdk-js" },
      head_repository: { full_name: "honua-io/honua-sdk-js" }, path: ".github/workflows/publish-js-sdk.yml",
      event: "workflow_dispatch", status: "completed", conclusion: "failure", head_sha: commit,
      head_branch: "recovery/0.2.4" },
    jobs: [{ id: 456, run_id: 123, run_attempt: 2, name: "publish-js-packages", status: "completed", conclusion: "success",
      steps: [
        { name: "Validate publish ref and version", status: "completed", conclusion: "success" },
        { name: "Publish split packages", status: "completed", conclusion: "success" },
        { name: "Publish summary", status: "completed", conclusion: "skipped" },
      ] }],
    requests: [],
  };
}
async function resolveRecovery(fixture) {
  return recoverSdkPublicationRef({ ...fixture, fetchJson: async (url) => {
    fixture.requests.push(url);
    if (url === "https://registry.npmjs.org/-/npm/v1/attestations/@honua%2Fsdk-js@0.2.4") {
      return { attestations: [{ predicateType: provenanceType,
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(fixture.statement)).toString("base64") } } }] };
    }
    if (url === "https://api.github.com/repos/honua-io/honua-sdk-js/actions/runs/123/attempts/2") return fixture.run;
    if (url === "https://api.github.com/repos/honua-io/honua-sdk-js/actions/runs/123/attempts/2/jobs?per_page=100&page=1") {
      return { jobs: fixture.jobs };
    }
    throw new Error(`unexpected recovery request ${url}`);
  } });
}

test("scheduled recovery authenticates the exact successful publisher even if later registry propagation failed", async () => {
  const fixture = recoveryFixture();
  assert.deepEqual(await resolveRecovery(fixture), {
    expectedRef: "refs/heads/recovery/0.2.4", tag: fixture.tag, commit: fixture.commit,
    invocation: fixture.statement.predicate.runDetails.metadata.invocationId, runId: "123", attempt: "2",
    runConclusion: "failure", publisherJobId: 456,
    authenticatedRun: fixture.run, authenticatedPublisherJob: fixture.jobs[0],
  });
  assert.equal(fixture.requests.length, 3);
});

test("normal tag success, migrator and unrelated registry failures never invoke recovery discovery", async () => {
  for (const mutate of [
    (f) => { f.proof.status = "verified"; },
    (f) => { f.item.name = "@honua/honua-migrate"; },
    (f) => { f.proof.artifacts[0].checks.push({ id: "dist-integrity", status: "fail" }); },
    (f) => { f.proof.artifacts[0].checks[1].id = "provenance-builder"; },
  ]) {
    const fixture = recoveryFixture(); mutate(fixture);
    assert.equal(await resolveRecovery(fixture), undefined);
    assert.deepEqual(fixture.requests, []);
  }
});

const recoveryRefusals = {
  "wrong package version": (f) => { f.item.version = "0.2.5"; },
  "wrong release tag": (f) => { f.tag = "js-sdk-v0.2.5"; },
  "wrong provenance repository": (f) => { f.statement.predicate.buildDefinition.externalParameters.workflow.repository += "-fork"; },
  "wrong provenance workflow": (f) => { f.statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/ci.yml"; },
  "unapproved pull-request ref": (f) => { f.statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/pull/1/head"; },
  "wrong provenance source": (f) => { f.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); },
  "foreign invocation": (f) => { f.statement.predicate.runDetails.metadata.invocationId = "https://github.com/foreign/repo/actions/runs/123/attempts/2"; },
  "missing exact attempt": (f) => { f.statement.predicate.runDetails.metadata.invocationId = "https://github.com/honua-io/honua-sdk-js/actions/runs/123"; },
  "wrong run": (f) => { f.run.id = 124; },
  "wrong attempt": (f) => { f.run.run_attempt = 1; },
  "wrong run repository": (f) => { f.run.repository.full_name += "-fork"; },
  "fork head": (f) => { f.run.head_repository.full_name += "-fork"; },
  "wrong run workflow": (f) => { f.run.path = ".github/workflows/ci.yml"; },
  "untrusted run event": (f) => { f.run.event = "pull_request"; },
  "unfinished run": (f) => { f.run.status = "in_progress"; },
  "wrong run source": (f) => { f.run.head_sha = "b".repeat(40); },
  "wrong run branch": (f) => { f.run.head_branch = "other"; },
  "missing publisher": (f) => { f.jobs = []; },
  "ambiguous publisher": (f) => { f.jobs.push(structuredClone(f.jobs[0])); },
  "wrong publisher attempt": (f) => { f.jobs[0].run_attempt = 1; },
  "failed publisher": (f) => { f.jobs[0].conclusion = "failure"; },
  "missing ref guard": (f) => { f.jobs[0].steps.shift(); },
  "skipped ref guard": (f) => { f.jobs[0].steps[0].conclusion = "skipped"; },
  "skipped publication": (f) => { f.jobs[0].steps[1].conclusion = "skipped"; },
  "dry-run publication": (f) => { f.jobs[0].steps[2].conclusion = "success"; },
};
for (const [name, mutate] of Object.entries(recoveryRefusals)) {
  test(`scheduled recovery refuses ${name}`, async () => {
    const fixture = recoveryFixture(); mutate(fixture);
    await assert.rejects(resolveRecovery(fixture));
  });
}

test("scheduled recovery refuses unavailable authenticated run evidence", async () => {
  const fixture = recoveryFixture();
  await assert.rejects(recoverSdkPublicationRef({ ...fixture,
    fetchJson: async () => { throw new Error("HTTP 404"); },
  }), /HTTP 404/);
});

function publicationFixture() {
  const fixture = recoveryFixture();
  const bytes = Buffer.from("authored SDK package bytes for recovery verification");
  const subject = [{ name: "pkg:npm/%40honua/sdk-js@0.2.4",
    digest: { sha512: createHash("sha512").update(bytes).digest("hex") } }];
  fixture.statement._type = "https://in-toto.io/Statement/v1";
  fixture.statement.subject = subject;
  const publish = { _type: "https://in-toto.io/Statement/v1", subject,
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" };
  const envelope = (statement) => ({ predicateType: statement.predicateType,
    bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } });
  fixture.fetches = new Map();
  fixture.corruptTarball = false;
  fixture.fetch = async (url) => {
    fixture.fetches.set(url, (fixture.fetches.get(url) ?? 0) + 1);
    if (url === "https://api.github.com/repos/honua-io/honua-sdk-js/commits/js-sdk-v0.2.4") return Response.json({ sha: fixture.commit });
    if (url === "https://registry.npmjs.org/@honua%2Fsdk-js") return Response.json({
      versions: { "0.2.4": { dist: { tarball: "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.2.4.tgz",
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } } },
    });
    if (url === "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.2.4.tgz") {
      return new Response(fixture.corruptTarball ? "different package bytes" : bytes);
    }
    if (url === "https://registry.npmjs.org/-/npm/v1/attestations/@honua%2Fsdk-js@0.2.4") {
      assert.equal(fixture.fetches.get(url), 1, "recovery must re-verify the originally authenticated registry response");
      return Response.json({ attestations: [envelope(fixture.statement), envelope(publish)] });
    }
    if (url === "https://api.github.com/repos/honua-io/honua-sdk-js/actions/runs/123/attempts/2") return Response.json(fixture.run);
    if (url === "https://api.github.com/repos/honua-io/honua-sdk-js/actions/runs/123/attempts/2/jobs?per_page=100&page=1") {
      return Response.json({ jobs: fixture.jobs });
    }
    throw new Error(`unexpected publication request ${url}`);
  };
  return fixture;
}

test("recovery re-runs the unchanged registry verifier against identical bytes and retains the initial refusal", async () => {
  const fixture = publicationFixture();
  const proof = await verifyMigrationPublication(fixture.item, { sdkVersion: "0.2.4" }, fixture.fetch);
  assert.equal(proof.status, "verified", JSON.stringify(proof.failures));
  assert.equal(proof.artifacts[0].sourceRef, "refs/heads/recovery/0.2.4");
  assert.equal(proof.artifacts[0].sourceRevision, fixture.commit);
  assert.equal(proof.recoveryPublication.initialTagVerification.status, "failed");
  assert.equal(proof.recoveryPublication.authenticatedPublisherJob.id, 456);
  assert.ok([...fixture.fetches.values()].every((count) => count === 1));
});

test("normal tag publication passes without querying historical publisher runs", async () => {
  const fixture = publicationFixture();
  fixture.statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/js-sdk-v0.2.4";
  const proof = await verifyMigrationPublication(fixture.item, { sdkVersion: "0.2.4" }, fixture.fetch);
  assert.equal(proof.status, "verified", JSON.stringify(proof.failures));
  assert.equal(proof.recoveryPublication, undefined);
  assert.ok([...fixture.fetches.keys()].every((url) => !url.includes("/actions/")));
});

test("explicit current publisher ref works before its workflow has completed", async () => {
  const fixture = publicationFixture(); fixture.run.status = "in_progress";
  const proof = await verifyMigrationPublication(fixture.item, {
    sdkVersion: "0.2.4", sdkPublishRef: "refs/heads/recovery/0.2.4",
  }, fixture.fetch);
  assert.equal(proof.status, "verified", JSON.stringify(proof.failures));
  assert.ok([...fixture.fetches.keys()].every((url) => !url.includes("/actions/")));
});

test("a valid recovery run cannot authorize corrupted installed package bytes", async () => {
  const fixture = publicationFixture(); fixture.corruptTarball = true;
  const proof = await verifyMigrationPublication(fixture.item, { sdkVersion: "0.2.4" }, fixture.fetch);
  assert.equal(proof.status, "failed");
  assert.equal(proof.recoveryPublication, undefined);
  assert.ok(proof.artifacts[0].checks.some((check) => check.id === "dist-integrity" && check.status === "fail"));
  assert.ok([...fixture.fetches.keys()].every((url) => !url.includes("/actions/")));
});

const TOKEN_ENV = "HONUA_MIGRATION_GITHUB_TOKEN";

async function withMigrationToken(token, run) {
  const previous = process.env[TOKEN_ENV];
  if (token === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = token;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previous;
  }
}

function authorizationOf(init) {
  return new Headers(init?.headers).get("authorization");
}

function observeFetch(inner) {
  const observed = [];
  const fetchImpl = async (url, init) => {
    observed.push({
      url: String(url),
      authorization: authorizationOf(init),
      redirect: init?.redirect ?? null,
    });
    return inner(url, init);
  };
  return { observed, fetchImpl };
}

test("a synthetic token authorizes tag resolution and recovery reads only", async () => {
  await withMigrationToken(SYNTHETIC_TOKEN, async () => {
    const fixture = publicationFixture();
    const { observed, fetchImpl } = observeFetch(fixture.fetch);
    const proof = await verifyMigrationPublication(fixture.item, { sdkVersion: "0.2.4" }, fetchImpl);
    assert.equal(proof.status, "verified", JSON.stringify(proof.failures));
    const github = observed.filter((entry) => entry.url.startsWith("https://api.github.com/"));
    assert.ok(github.some((entry) => entry.url.endsWith("/commits/js-sdk-v0.2.4")));
    assert.ok(github.some((entry) => entry.url.endsWith("/actions/runs/123/attempts/2")));
    assert.ok(github.some((entry) => entry.url.includes("/attempts/2/jobs?")));
    for (const entry of github) {
      assert.equal(entry.authorization, `Bearer ${SYNTHETIC_TOKEN}`);
      assert.equal(entry.redirect, "manual");
    }
    const elsewhere = observed.filter((entry) => !entry.url.startsWith("https://api.github.com/"));
    assert.ok(elsewhere.some((entry) => entry.url.startsWith("https://registry.npmjs.org/")));
    assert.ok(elsewhere.some((entry) => entry.url.includes("/attestations/")));
    for (const entry of elsewhere) assert.equal(entry.authorization, null);
    assert.equal(JSON.stringify(proof).includes(SYNTHETIC_TOKEN), false);
    assert.equal(JSON.stringify(observed).includes("authorization"), true);
  });
});

test("anonymous execution does not send a token, including an ambient GITHUB_TOKEN", async () => {
  const ambient = "ghp_AmbientTokenMustStayUnused0123456789xx";
  const savedGithub = process.env.GITHUB_TOKEN;
  const savedGh = process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = ambient;
  process.env.GH_TOKEN = "ghp_AmbientGhTokenMustStayUnused012345678";
  try {
    await withMigrationToken(undefined, async () => {
      const fixture = publicationFixture();
      const { observed, fetchImpl } = observeFetch(fixture.fetch);
      const proof = await verifyMigrationPublication(fixture.item, { sdkVersion: "0.2.4" }, fetchImpl);
      assert.equal(proof.status, "verified", JSON.stringify(proof.failures));
      assert.ok(observed.some((entry) => entry.url.includes("/commits/")));
      assert.ok(observed.some((entry) => entry.url.includes("/actions/runs/")));
      for (const entry of observed) assert.equal(entry.authorization, null);
      assert.equal(JSON.stringify(observed).includes(ambient), false);
      assert.equal(JSON.stringify(proof).includes(ambient), false);
    });
  } finally {
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithub;
    if (savedGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGh;
  }
});

test("non-GitHub origins never receive the migration token, even from caller headers", async () => {
  await withMigrationToken(SYNTHETIC_TOKEN, async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), authorization: authorizationOf(init) });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    for (const url of [
      "https://registry.npmjs.org/@honua%2Fsdk-js",
      "https://registry.npmjs.org/-/npm/v1/attestations/@honua%2Fsdk-js@0.2.4",
      "https://example.test/arbitrary",
      "http://api.github.com/repos/honua-io/honua-sdk-js/commits/js-sdk-v0.2.4",
      "https://api.github.com.evil.test/repos/honua-io/honua-sdk-js/commits/js-sdk-v0.2.4",
      "https://user:pass@api.github.com/repos/honua-io/honua-sdk-js/commits/js-sdk-v0.2.4",
    ]) {
      await migrationCohortFetch(url, { headers: { authorization: `Bearer ${SYNTHETIC_TOKEN}` } }, { fetchImpl });
    }
    assert.equal(calls.length, 6);
    for (const call of calls) assert.equal(call.authorization, null);
    assert.equal(JSON.stringify(calls).includes(SYNTHETIC_TOKEN), false);
  });
});

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
        }),
      });
    });
  });
}

test("redirects stay on the trusted origin and use real fetch forwarding", async (t) => {
  const seen = [];
  let untrustedOrigin = "";
  const trusted = await listen((request, response) => {
    seen.push({ host: "trusted", url: request.url, authorization: request.headers.authorization ?? null });
    if (request.url === "/same") {
      response.writeHead(302, { location: "/landed" }).end();
      return;
    }
    if (request.url === "/absolute") {
      response.writeHead(302, { location: `${trusted.origin}/landed` }).end();
      return;
    }
    if (request.url === "/away") {
      response.writeHead(302, { location: `${untrustedOrigin}/steal` }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end('{"sha":"abc"}');
  });
  const untrusted = await listen((request, response) => {
    seen.push({ host: "untrusted", url: request.url, authorization: request.headers.authorization ?? null });
    response.writeHead(200, { "content-type": "application/json" }).end('{"stolen":true}');
  });
  untrustedOrigin = untrusted.origin;
  t.after(() => trusted.close());
  t.after(() => untrusted.close());

  // Actual fetch follows the cross-origin redirect. A mock that returns one
  // response and never contacts the next host would hide that.
  seen.length = 0;
  const followed = await fetch(`${trusted.origin}/away`, {
    redirect: "follow",
    headers: { authorization: `Bearer ${SYNTHETIC_TOKEN}` },
  });
  assert.equal(followed.status, 200);
  assert.ok(seen.some((hit) => hit.host === "untrusted" && hit.url === "/steal"));

  seen.length = 0;
  const same = await migrationCohortFetch(`${trusted.origin}/same`, {}, {
    apiOrigin: trusted.origin,
    token: SYNTHETIC_TOKEN,
  });
  assert.equal(same.status, 200);
  assert.deepEqual(seen.map((hit) => hit.authorization), [
    `Bearer ${SYNTHETIC_TOKEN}`,
    `Bearer ${SYNTHETIC_TOKEN}`,
  ]);

  seen.length = 0;
  const absolute = await migrationCohortFetch(`${trusted.origin}/absolute`, {}, {
    apiOrigin: trusted.origin,
    token: SYNTHETIC_TOKEN,
  });
  assert.equal(absolute.status, 200);
  assert.equal(seen.filter((hit) => hit.host === "untrusted").length, 0);
  assert.deepEqual(seen.map((hit) => hit.authorization), [
    `Bearer ${SYNTHETIC_TOKEN}`,
    `Bearer ${SYNTHETIC_TOKEN}`,
  ]);

  seen.length = 0;
  const away = await migrationCohortFetch(`${trusted.origin}/away`, {}, {
    apiOrigin: trusted.origin,
    token: SYNTHETIC_TOKEN,
  });
  assert.equal(away.ok, false);
  assert.equal(seen.some((hit) => hit.host === "untrusted"), false);
  assert.equal(seen.some((hit) => hit.authorization === `Bearer ${SYNTHETIC_TOKEN}`), true);
  assert.equal(JSON.stringify(seen).includes(SYNTHETIC_TOKEN) || seen.length > 0, true);
  const awayText = JSON.stringify(seen);
  assert.equal(awayText.includes(`${untrusted.origin}`), false);
});

for (const status of [401, 403, 503, 504]) {
  test(`HTTP ${status} on tag resolution fails closed without a retry`, async () => {
    await withMigrationToken(SYNTHETIC_TOKEN, async () => {
      let calls = 0;
      const fetchImpl = async (url, init) => {
        calls += 1;
        assert.equal(new URL(url).origin, "https://api.github.com");
        assert.equal(authorizationOf(init), `Bearer ${SYNTHETIC_TOKEN}`);
        return new Response("unavailable", { status });
      };
      await assert.rejects(
        () => verifyMigrationPublication({ name: "@honua/sdk-js", version: "0.2.4" }, { sdkVersion: "0.2.4" }, fetchImpl),
        (error) => {
          assert.match(error.message, new RegExp(`HTTP ${status}`));
          assert.equal(error.message.includes(SYNTHETIC_TOKEN), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    });
  });
}

test("HTTP 503 on publication recovery fails closed without a retry", async () => {
  await withMigrationToken(SYNTHETIC_TOKEN, async () => {
    const fixture = publicationFixture();
    let recoveryCalls = 0;
    const inner = fixture.fetch;
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/actions/runs/")) {
        recoveryCalls += 1;
        assert.equal(authorizationOf(init), `Bearer ${SYNTHETIC_TOKEN}`);
        return new Response("unavailable", { status: 503 });
      }
      return inner(url, init);
    };
    await assert.rejects(
      () => verifyMigrationPublication(fixture.item, { sdkVersion: "0.2.4" }, fetchImpl),
      (error) => {
        assert.match(error.message, /HTTP 503/);
        assert.equal(error.message.includes(SYNTHETIC_TOKEN), false);
        return true;
      },
    );
    assert.equal(recoveryCalls, 1);
  });
});

test("receipts and thrown diagnostics omit the synthetic token", async () => {
  await withMigrationToken(SYNTHETIC_TOKEN, async () => {
    const receipt = {};
    receipt.error = migrationCohortDiagnostic(new Error(`cannot resolve tag: HTTP 504 ${SYNTHETIC_TOKEN}`));
    assert.equal(receipt.error, "cannot resolve tag: HTTP 504 [redacted]");
    await assert.rejects(
      () => migrationCohortFetch("https://api.github.com/repos/honua-io/honua-sdk-js/commits/js-sdk-v0.2.4", {}, {
        fetchImpl: () => {
          throw new Error(`connect ${SYNTHETIC_TOKEN}`);
        },
      }),
      (error) => {
        assert.equal(error.message, "connect [redacted]");
        return true;
      },
    );
  });
});
