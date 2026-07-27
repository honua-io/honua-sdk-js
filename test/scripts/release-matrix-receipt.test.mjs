// Release-matrix browser receipt coverage (honua-io/honua-sdk-js#766).
//
// Two concerns are pinned here:
//   1. Receipt parsing/sealing: only outcomes a Playwright report actually
//      contains can be transcribed, and the receipt's shape, engine set, and
//      seven-day window are enforced.
//   2. Staleness gating: a failing (or lapsed) matrix receipt makes the First
//      Map golden qualification stale in the exact code path `npm run
//      samples:verify` uses, while a receipt that has never been sealed keeps
//      the lane un-gated.
//   3. Anti-laundering: once samples/contract/v2/release-matrix-lanes.v1.json
//      records establishment, DELETING the sealed sidecar is an error rather
//      than a relaxation back to "not established".
//
// Fixtures live under this test's temporary directories or test/fixtures, never
// under samples/evidence: nothing here may look like real browser evidence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  buildReleaseMatrixReceipt,
  readReleaseMatrixLaneRegistry,
  readReleaseMatrixReceipt,
  recordedReleaseMatrixLaneRegistry,
  RELEASE_MATRIX_ENGINES,
  RELEASE_MATRIX_LANES_PATH,
  RELEASE_MATRIX_MAX_WINDOW_MS,
  RELEASE_MATRIX_SAMPLE_IDS,
  RELEASE_MATRIX_STATE,
  releaseMatrixEnginesFromPlaywrightReport,
  releaseMatrixEvidenceProjection,
  releaseMatrixGateOutcome,
  releaseMatrixLaneEstablished,
  releaseMatrixReceiptRelativePath,
  releaseMatrixReceiptRelaxed,
  releaseMatrixRunIdentity,
  releaseMatrixState,
  validateReleaseMatrixLaneRegistry,
} from "../../scripts/lib/release-matrix-receipt.mjs";
import {
  collectQualificationEvidence,
  collectReleaseMatrixLanes,
  releaseMatrixCatalogSection,
  validateCatalog,
} from "../../scripts/sample-contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const sampleId = "maplibre-quickstart";
const revision = "a".repeat(40);
const digest = "b".repeat(64);
const reportDigest = "c".repeat(64);

// HONUA_DERIVED_ARTIFACTS_RELAX is job-wide in ci.yml's JS SDK job, so any test
// that reads it implicitly behaves differently locally and in CI. Every
// gate-severity scenario below therefore FORCES the value it means to exercise
// and restores the ambient one, which makes this file's result identical with
// and without the variable set in the environment.
async function withDerivedArtifactsRelax(enabled, run) {
  const previous = process.env.HONUA_DERIVED_ARTIFACTS_RELAX;
  if (enabled) process.env.HONUA_DERIVED_ARTIFACTS_RELAX = "1";
  else delete process.env.HONUA_DERIVED_ARTIFACTS_RELAX;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HONUA_DERIVED_ARTIFACTS_RELAX;
    else process.env.HONUA_DERIVED_ARTIFACTS_RELAX = previous;
  }
}

const runIdentity = {
  repository: "honua-io/honua-sdk-js",
  workflow: "First Map Release Smoke",
  runId: "42",
  runAttempt: 1,
  event: "release",
  ref: "refs/tags/v0.1.2",
  commit: "d".repeat(40),
};

function engines(overrides = {}) {
  return RELEASE_MATRIX_ENGINES.map((engine) => {
    const override = overrides[engine.name] ?? {};
    const status = override.status ?? "passed";
    return {
      name: engine.name,
      browserName: engine.browserName,
      headless: engine.headless,
      status,
      tests: override.tests ?? 1,
      failed: override.failed ?? (status === "passed" ? 0 : 1),
      durationMs: override.durationMs ?? 1234.5,
    };
  });
}

async function receipt(options = {}) {
  return buildReleaseMatrixReceipt({
    projectRoot,
    sampleId: options.sampleId ?? sampleId,
    sourceRevision: revision,
    sourceDigest: digest,
    matrixEnvValue: "true",
    playwrightVersion: "1.56.0",
    command: ["npm", "run", "test:playwright:quickstart"],
    run: { ...runIdentity },
    engines: options.engines ?? engines(),
    report: { bytes: 4096, sha256: reportDigest },
    observedAt: options.observedAt ?? new Date().toISOString(),
  });
}

function playwrightReport(overrides = {}) {
  const statuses = overrides.statuses ?? {};
  return {
    config: {
      configFile: "playwright.first-map.config.mjs",
      rootDir: "test/playwright",
      projects: (overrides.projects ?? RELEASE_MATRIX_ENGINES.map((engine) => engine.name)).map((name) => ({
        name,
      })),
    },
    suites: [
      {
        title: "quickstart-map.spec.mjs",
        file: "quickstart-map.spec.mjs",
        specs: (overrides.projects ?? RELEASE_MATRIX_ENGINES.map((engine) => engine.name)).map((name) => ({
          title: "First Map proves the canonical fixture journey in source or packed mode",
          file: "quickstart-map.spec.mjs",
          tests: [
            {
              projectName: name,
              expectedStatus: "passed",
              results: (statuses[name] ?? ["passed"]).map((status, retry) => ({
                status,
                duration: 100,
                retry,
              })),
            },
          ],
        })),
      },
    ],
    errors: [],
  };
}

test("a sealed receipt records every declared engine inside the seven-day window", async () => {
  const sealed = await receipt();
  assert.equal(sealed.format, "honua.sdk.sample-release-matrix-receipt.v1");
  assert.equal(sealed.lane, "release-matrix-browser");
  assert.equal(sealed.status, "passed");
  assert.equal(sealed.sdkMode, "source");
  assert.equal(sealed.matrix.envName, "HONUA_FIRST_MAP_RELEASE_MATRIX");
  assert.equal(sealed.matrix.envValue, "true");
  assert.equal(sealed.matrix.playwrightConfig, "playwright.first-map.config.mjs");
  assert.deepEqual(
    sealed.matrix.engines.map((engine) => engine.name),
    ["chromium", "firefox", "webkit"],
  );
  assert.equal(
    sealed.matrix.engines.find((engine) => engine.name === "firefox").headless,
    false,
    "release-matrix Firefox runs headed so it has a compositor for WebGL",
  );
  assert.equal(
    Date.parse(sealed.expiresAt) - Date.parse(sealed.observedAt),
    RELEASE_MATRIX_MAX_WINDOW_MS,
  );
  assert.equal(sealed.$schema, "../../contract/v2/schemas/sample-release-matrix-receipt.schema.json");
  assert.equal(sealed.producer.path, "scripts/seal-release-matrix-receipt.mjs");
  assert.equal(releaseMatrixReceiptRelativePath(sampleId), `samples/evidence/${sampleId}/release-matrix.v1.json`);
});

test("a failing engine seals a failing receipt rather than being dropped", async () => {
  const sealed = await receipt({ engines: engines({ webkit: { status: "timedOut" } }) });
  assert.equal(sealed.status, "failed");
  assert.equal(sealed.matrix.engines.find((engine) => engine.name === "webkit").status, "timedOut");
});

test("receipt sealing requires the release-matrix environment", async () => {
  await assert.rejects(
    buildReleaseMatrixReceipt({
      projectRoot,
      sampleId,
      sourceRevision: revision,
      sourceDigest: digest,
      matrixEnvValue: "",
      playwrightVersion: "1.56.0",
      command: ["npm", "run", "test:playwright:quickstart"],
      run: { ...runIdentity },
      engines: engines(),
      report: { bytes: 4096, sha256: reportDigest },
    }),
    /HONUA_FIRST_MAP_RELEASE_MATRIX=true/u,
  );
});

test("receipt validation rejects contradictions, drift, and impossible windows", async () => {
  const base = await receipt();
  const mutate = async (mutation, pattern) => {
    const candidate = structuredClone(base);
    mutation(candidate);
    const directory = await mkdtemp(path.join(os.tmpdir(), "honua-release-matrix-"));
    try {
      await cp(path.join(projectRoot, "samples/evidence", sampleId, "receipts"), path.join(directory, sampleId, "receipts"), {
        recursive: true,
      });
      await writeFile(
        path.join(directory, sampleId, "release-matrix.v1.json"),
        `${JSON.stringify(candidate, null, 2)}\n`,
      );
      await assert.rejects(readReleaseMatrixReceipt({ sampleId, projectRoot, receiptRoot: directory }), pattern);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  await mutate((candidate) => {
    candidate.status = "passed";
    candidate.matrix.engines[1].status = "failed";
    candidate.matrix.engines[1].failed = 1;
  }, /status contradicts its per-engine outcomes/u);
  await mutate((candidate) => {
    candidate.matrix.engines[1].failed = 0;
    candidate.matrix.engines[1].status = "failed";
    candidate.status = "failed";
  }, /contradicts its failure count/u);
  await mutate((candidate) => {
    candidate.matrix.engines.reverse();
  }, /chromium, firefox, and webkit in that order/u);
  await mutate((candidate) => {
    candidate.matrix.engines[1].headless = true;
  }, /does not match the declared release-matrix projects/u);
  await mutate((candidate) => {
    candidate.expiresAt = new Date(Date.parse(candidate.observedAt) + RELEASE_MATRIX_MAX_WINDOW_MS + 1000).toISOString();
  }, /seven-day freshness policy/u);
  await mutate((candidate) => {
    candidate.observedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    candidate.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  }, /more than five minutes in the future/u);
  await mutate((candidate) => {
    candidate.matrix.engines.pop();
  }, /schema validation failed/u);
  await mutate((candidate) => {
    candidate.run.runId = "not-a-run";
  }, /schema validation failed/u);
  await mutate((candidate) => {
    candidate.unexpected = true;
  }, /schema validation failed/u);
  await mutate((candidate) => {
    candidate.sampleId = "service-explorer";
  }, /sample binding mismatch/u);
});

test("engines are transcribed from the Playwright report, never assumed", () => {
  const passing = releaseMatrixEnginesFromPlaywrightReport(playwrightReport(), {
    playwrightFile: "test/playwright/quickstart-map.spec.mjs",
  });
  assert.deepEqual(
    passing.map((engine) => [engine.name, engine.status, engine.failed]),
    [
      ["chromium", "passed", 0],
      ["firefox", "passed", 0],
      ["webkit", "passed", 0],
    ],
  );

  const failing = releaseMatrixEnginesFromPlaywrightReport(
    playwrightReport({ statuses: { firefox: ["failed"] } }),
  );
  assert.equal(failing.find((engine) => engine.name === "firefox").status, "failed");
  assert.equal(failing.find((engine) => engine.name === "firefox").failed, 1);

  // A retried test that ends green is green; the last attempt is the outcome
  // the run reported.
  const retried = releaseMatrixEnginesFromPlaywrightReport(
    playwrightReport({ statuses: { webkit: ["failed", "passed"] } }),
  );
  assert.equal(retried.find((engine) => engine.name === "webkit").status, "passed");

  assert.throws(
    () => releaseMatrixEnginesFromPlaywrightReport(playwrightReport({ projects: ["chromium", "firefox"] })),
    /chromium, firefox, and webkit projects/u,
  );
  const foreignConfig = playwrightReport();
  foreignConfig.config.configFile = "playwright.config.mjs";
  assert.throws(
    () => releaseMatrixEnginesFromPlaywrightReport(foreignConfig),
    /was not produced by playwright.first-map.config.mjs/u,
  );
  assert.throws(
    () =>
      releaseMatrixEnginesFromPlaywrightReport(playwrightReport(), {
        playwrightFile: "test/playwright/other-sample.spec.mjs",
      }),
    /outside the declared sample spec/u,
  );
});

test("run identity must come from a real workflow run", () => {
  assert.deepEqual(
    releaseMatrixRunIdentity({
      GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
      GITHUB_WORKFLOW: "First Map Release Smoke",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "release",
      GITHUB_REF: "refs/tags/v0.1.2",
      GITHUB_SHA: "d".repeat(40),
    }),
    runIdentity,
  );
  assert.throws(() => releaseMatrixRunIdentity({}), /GitHub workflow run identity/u);
});

test("gate severity is graduated: absent notes, failed errors, lapsed errors only in strict lanes", async () => {
  const fresh = { receipt: await receipt(), path: releaseMatrixReceiptRelativePath(sampleId), sha256: digest, bytes: 1 };
  const failed = {
    receipt: await receipt({ engines: engines({ firefox: { status: "failed" } }) }),
    path: releaseMatrixReceiptRelativePath(sampleId),
    sha256: digest,
    bytes: 1,
  };
  const lapsedObservedAt = new Date(Date.now() - RELEASE_MATRIX_MAX_WINDOW_MS - 60_000).toISOString();
  const lapsed = {
    receipt: await receipt({ observedAt: lapsedObservedAt }),
    path: releaseMatrixReceiptRelativePath(sampleId),
    sha256: digest,
    bytes: 1,
  };

  assert.equal(releaseMatrixState(fresh).state, RELEASE_MATRIX_STATE.current);
  assert.equal(releaseMatrixState(failed).state, RELEASE_MATRIX_STATE.failed);
  assert.equal(releaseMatrixState(lapsed).state, RELEASE_MATRIX_STATE.stale);
  assert.equal(releaseMatrixState(undefined).state, RELEASE_MATRIX_STATE.notEstablished);

  assert.equal(releaseMatrixGateOutcome(fresh, { sampleId }).severity, "ok");

  // Missing receipt: never red. Merging the gate cannot break CI before the
  // first release-matrix run has sealed anything.
  const absent = releaseMatrixGateOutcome(undefined, { sampleId });
  assert.equal(absent.severity, "note");
  assert.match(absent.message, /not established yet/u);

  assert.equal(releaseMatrixGateOutcome(failed, { sampleId }).severity, "error");
  assert.equal(releaseMatrixGateOutcome(failed, { sampleId, derivedArtifactsRelaxed: true }).severity, "error");
  assert.equal(releaseMatrixGateOutcome(failed, { sampleId, relaxed: true }).severity, "warning");
  assert.match(releaseMatrixGateOutcome(failed, { sampleId }).message, /failing engine \(firefox:failed\)/u);

  assert.equal(releaseMatrixGateOutcome(lapsed, { sampleId }).severity, "error");
  assert.equal(releaseMatrixGateOutcome(lapsed, { sampleId, derivedArtifactsRelaxed: true }).severity, "warning");
  assert.equal(releaseMatrixGateOutcome(lapsed, { sampleId, relaxed: true }).severity, "warning");

  assert.equal(releaseMatrixReceiptRelaxed({}), false);
  assert.equal(releaseMatrixReceiptRelaxed({ HONUA_RELEASE_MATRIX_RECEIPT_RELAX: "1" }), true);

  // Deleting the sidecar after establishment is not a relaxation: it carries the
  // same severity as a failing engine, including where shared derived-artifact
  // freshness is already relaxed.
  assert.equal(releaseMatrixState(undefined, { established: true }).state, RELEASE_MATRIX_STATE.missing);
  const laundered = releaseMatrixGateOutcome(undefined, { sampleId, established: true });
  assert.equal(laundered.severity, "error");
  assert.match(laundered.message, /established the release-matrix browser lane, but/u);
  assert.match(laundered.message, /deleting sealed cross-browser evidence/u);
  assert.equal(
    releaseMatrixGateOutcome(undefined, { sampleId, established: true, derivedArtifactsRelaxed: true }).severity,
    "error",
  );
  assert.equal(
    releaseMatrixGateOutcome(undefined, { sampleId, established: true, relaxed: true }).severity,
    "warning",
  );
});

test("lane establishment is recorded idempotently in reviewed contract source", async () => {
  const sealed = await receipt();
  const first = recordedReleaseMatrixLaneRegistry(undefined, sealed);
  assert.equal(first.changed, true);
  assert.equal(first.registry.format, "honua.sdk.sample-release-matrix-lanes.v1");
  assert.equal(first.registry.$schema, "schemas/sample-release-matrix-lanes.schema.json");
  assert.deepEqual(first.registry.lanes[0], {
    sampleId,
    lane: "release-matrix-browser",
    receiptPath: releaseMatrixReceiptRelativePath(sampleId),
    establishedAt: sealed.observedAt,
    establishedBy: {
      repository: "honua-io/honua-sdk-js",
      workflow: "First Map Release Smoke",
      runId: "42",
      runAttempt: 1,
      commit: "d".repeat(40),
    },
  });
  await validateReleaseMatrixLaneRegistry(first.registry, { projectRoot });

  // A later release smoke must not rewrite establishment: the registry is inside
  // the evidence-neutral digest, so churn there would invalidate sealed receipts
  // on every regeneration.
  const later = await receipt({ observedAt: new Date(Date.now() - 1000).toISOString() });
  const second = recordedReleaseMatrixLaneRegistry(first.registry, later);
  assert.equal(second.changed, false);
  assert.deepEqual(second.registry, first.registry);

  assert.throws(
    () => recordedReleaseMatrixLaneRegistry(undefined, { ...sealed, sampleId: "service-explorer" }),
    /requires a sample that declares the lane/u,
  );
  assert.throws(
    () => recordedReleaseMatrixLaneRegistry(undefined, { ...sealed, format: "other" }),
    /requires a release-matrix receipt/u,
  );
});

test("the lane registry is schema-bound and rejects orphan or drifted entries", async () => {
  // The canonical registry is absent on trunk today; absence must read as
  // "no lane established", never as an error.
  assert.equal(await readReleaseMatrixLaneRegistry({ projectRoot }), undefined);
  assert.equal(releaseMatrixLaneEstablished(undefined, sampleId), false);
  assert.equal(RELEASE_MATRIX_LANES_PATH, "samples/contract/v2/release-matrix-lanes.v1.json");

  const established = await readReleaseMatrixLaneRegistry({
    projectRoot,
    registryPath: "test/fixtures/release-matrix/established-lanes.v1.json",
  });
  assert.equal(releaseMatrixLaneEstablished(established, sampleId), true);

  const base = established.registry;
  const rejects = async (mutation, pattern) => {
    const candidate = structuredClone(base);
    mutation(candidate);
    await assert.rejects(validateReleaseMatrixLaneRegistry(candidate, { projectRoot }), pattern);
  };
  await rejects((candidate) => {
    candidate.lanes[0].sampleId = "service-explorer";
  }, /names a sample that does not declare the lane/u);
  await rejects((candidate) => {
    candidate.lanes[0].receiptPath = "samples/evidence/service-explorer/release-matrix.v1.json";
  }, /schema validation failed|receipt path drift/u);
  await rejects((candidate) => {
    candidate.lanes[0].establishedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }, /more than five minutes in the future/u);
  await rejects((candidate) => {
    candidate.lanes.push({ ...candidate.lanes[0] });
  }, /unique and sorted/u);
  await rejects((candidate) => {
    candidate.lanes[0].unexpected = true;
  }, /schema validation failed/u);
  await rejects((candidate) => {
    candidate.format = "honua.sdk.sample-release-matrix-lanes.v2";
  }, /schema validation failed/u);
});

test("the published projection is clock-free and binds the receipt bytes", async () => {
  const record = {
    receipt: await receipt(),
    path: releaseMatrixReceiptRelativePath(sampleId),
    sha256: digest,
    bytes: 1,
  };
  const projection = releaseMatrixEvidenceProjection(record);
  assert.equal(projection.lane, "release-matrix-browser");
  assert.equal(projection.status, "passed");
  assert.equal(projection.receiptPath, record.path);
  assert.equal(projection.receiptSha256, digest);
  assert.equal(projection.source.evidenceNeutralSha256, record.receipt.sourceDigest);
  assert.equal(projection.run.runId, "42");
  assert.equal(projection.engines.length, 3);
  assert.ok(!("state" in projection), "a derived freshness verdict would make generated bytes clock-dependent");
  assert.equal(releaseMatrixEvidenceProjection(undefined), undefined);

  // The qualification record projects this link through the generated catalog
  // (docs/generated/sample-catalog.md), NOT through
  // samples/dist/golden-journey-visual-evidence.v1.json: that artifact's schema
  // is content-addressed by the committed consumer handoff, so extending it is a
  // versioned contract change the derived-artifact automation has to carry.
  const section = releaseMatrixCatalogSection([
    { sampleId, established: true, receiptPath: record.path, projection },
  ]);
  const rendered = section.join("\n");
  assert.match(rendered, /## Release-matrix browser evidence/u);
  assert.match(rendered, /chromium: passed/u);
  assert.match(rendered, /firefox: passed/u);
  assert.match(rendered, /webkit: passed/u);
  assert.match(rendered, /samples\/evidence\/maplibre-quickstart\/release-matrix\.v1\.json/u);
  assert.match(rendered, /release-matrix-lanes\.v1\.json/u);

  // An established lane whose receipt was deleted is rendered as missing rather
  // than vanishing from the record.
  const missing = releaseMatrixCatalogSection([
    { sampleId, established: true, receiptPath: record.path, projection: undefined },
  ]).join("\n");
  assert.match(missing, /\| missing \| receipt missing \|/u);

  // Nothing to say before the first sealed run: the generated catalog stays
  // byte-identical, which is why this branch adds no derived-artifact drift.
  assert.deepEqual(releaseMatrixCatalogSection([]), []);
  assert.deepEqual(releaseMatrixCatalogSection(undefined), []);

  // The visual-evidence artifact must NOT carry the link, or its digest-bound
  // schema would need a coordinated version bump.
  const visualSchema = JSON.parse(
    await readFile(
      path.join(projectRoot, "samples/contract/v2/schemas/golden-journey-visual-evidence.schema.json"),
      "utf8",
    ),
  );
  assert.ok(
    !("releaseMatrix" in visualSchema.$defs.qualifiedJourney.properties),
    "extending the content-addressed visual-evidence schema requires a version bump plus regeneration",
  );
});

test("the generated catalog is the only projection that carries the lane", async () => {
  // collectReleaseMatrixLanes is what feeds the generated catalog. With no
  // receipt and no establishment it yields nothing, so docs/generated stays
  // byte-identical until the first release smoke lands.
  const catalog = JSON.parse(await readFile(path.join(projectRoot, "samples/catalog.v2.json"), "utf8"));
  assert.deepEqual(await collectReleaseMatrixLanes(catalog), []);

  const established = await collectReleaseMatrixLanes(catalog, {
    releaseMatrixLaneRegistryPath: "test/fixtures/release-matrix/established-lanes.v1.json",
  });
  assert.equal(established.length, 1);
  assert.equal(established[0].sampleId, sampleId);
  assert.equal(established[0].established, true);
  // Established with no receipt on disk: surfaced, not silently dropped.
  assert.equal(established[0].projection, undefined);
});

test("the seal CLI refuses to run outside the release matrix", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "honua-release-matrix-cli-"));
  try {
    const reportPath = path.join(directory, "playwright-report.json");
    await writeFile(reportPath, `${JSON.stringify(playwrightReport(), null, 2)}\n`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts/seal-release-matrix-receipt.mjs"),
        "--sample",
        sampleId,
        "--report",
        path.relative(projectRoot, reportPath),
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, HONUA_FIRST_MAP_RELEASE_MATRIX: "" },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HONUA_FIRST_MAP_RELEASE_MATRIX=true/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function goldenEvidenceCopy(catalog, label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  const receiptRoot = path.join(directory, "evidence");
  // Copy exactly the catalog-qualified golden samples rather than the whole
  // evidence root: the strict inventory requires that exact set, and sibling
  // suites create and remove their own adversary sample directories
  // concurrently, which would race a whole-tree copy.
  for (const journey of catalog.goldenJourneys.filter((candidate) => candidate.status === "qualified")) {
    await cp(
      path.join(projectRoot, "samples/evidence", journey.candidateSampleId),
      path.join(receiptRoot, journey.candidateSampleId),
      { recursive: true },
    );
  }
  return { directory, receiptRoot };
}

// Fault injection through the exact path `npm run samples:verify` runs
// (scripts/sample-contract.mjs check -> validateCatalog): an injected failing
// receipt has to turn the First Map golden qualification red, and removing it
// has to restore a green run without any other edit.
//
// Parameterized over HONUA_DERIVED_ARTIFACTS_RELAX because ci.yml sets it for
// the whole JS SDK job: a present failing receipt must be red in BOTH lanes, and
// only a lapsed (decayed) one may soften where that variable is set.
for (const derivedRelax of [false, true]) {
  test(`a failing release-matrix receipt turns golden qualification validation red (derived relax: ${derivedRelax})`, async () => {
    const catalog = JSON.parse(await readFile(path.join(projectRoot, "samples/catalog.v2.json"), "utf8"));
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    const { directory, receiptRoot } = await goldenEvidenceCopy(catalog, "honua-release-matrix-evidence-");
    const injected = path.join(receiptRoot, sampleId, "release-matrix.v1.json");
    const options = { receiptRoot, verifyCheckout: false };
    const validate = () => withDerivedArtifactsRelax(derivedRelax, () => validateCatalog(catalog, packageJson, options));
    try {
      // No receipt at all: the lane is not established and validation passes.
      await validate();

      // A PRESENT failing receipt is affirmative evidence of a failing engine.
      // Establishment is irrelevant here, and derived-artifact relaxation must
      // never soften it -- only the publication automation may, and that switch
      // is not set in either lane exercised here.
      await writeFile(
        injected,
        `${JSON.stringify(await receipt({ engines: engines({ webkit: { status: "failed" } }) }), null, 2)}\n`,
      );
      await assert.rejects(validate(), /release-matrix browser evidence reports a failing engine \(webkit:failed\)/u);

      // A present but structurally invalid receipt is rejected before any
      // severity policy applies, in both lanes.
      const contradictory = await receipt();
      contradictory.matrix.engines[1].status = "failed";
      contradictory.matrix.engines[1].failed = 1;
      await writeFile(injected, `${JSON.stringify(contradictory, null, 2)}\n`);
      await assert.rejects(validate(), /status contradicts its per-engine outcomes/u);

      // Decay is the one state the derived-artifact relaxation may soften: a
      // lapsed release cadence must not block feature work that cannot fix it,
      // while strict lanes (publish, docs-site, trunk's post-regeneration
      // dispatch, local runs) still fail.
      await writeFile(
        injected,
        `${JSON.stringify(
          await receipt({
            observedAt: new Date(Date.now() - RELEASE_MATRIX_MAX_WINDOW_MS - 60_000).toISOString(),
          }),
          null,
          2,
        )}\n`,
      );
      if (derivedRelax) await validate();
      else await assert.rejects(validate(), /release-matrix browser evidence expired at/u);

      // A green three-engine run restores qualification with no other edit.
      await writeFile(injected, `${JSON.stringify(await receipt(), null, 2)}\n`);
      await validate();

      // The receipt is a declared sidecar for the First Map candidate only.
      assert.deepEqual(RELEASE_MATRIX_SAMPLE_IDS, [sampleId]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// Anti-laundering fault injection: with establishment recorded in reviewed
// contract source, deleting the sealed sidecar must NOT fall back to the
// harmless "not established" note in any enforced lane -- including the publish
// lane, which runs samples:generate/samples:verify strictly.
for (const derivedRelax of [false, true]) {
  test(`deleting an established release-matrix receipt turns golden qualification validation red (derived relax: ${derivedRelax})`, async () => {
    const catalog = JSON.parse(await readFile(path.join(projectRoot, "samples/catalog.v2.json"), "utf8"));
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    const { directory, receiptRoot } = await goldenEvidenceCopy(catalog, "honua-release-matrix-laundering-");
    try {
      const injected = path.join(receiptRoot, sampleId, "release-matrix.v1.json");
      const established = {
        receiptRoot,
        verifyCheckout: false,
        releaseMatrixLaneRegistryPath: "test/fixtures/release-matrix/established-lanes.v1.json",
      };
      const validate = (options) =>
        withDerivedArtifactsRelax(derivedRelax, () => validateCatalog(catalog, packageJson, options));

      // Established lane, sealed green receipt present: qualified.
      await writeFile(injected, `${JSON.stringify(await receipt(), null, 2)}\n`);
      await validate(established);

      // Seal a failure, then try to launder it away by deleting the receipt.
      await writeFile(
        injected,
        `${JSON.stringify(await receipt({ engines: engines({ firefox: { status: "failed" } }) }), null, 2)}\n`,
      );
      await assert.rejects(validate(established), /failing engine \(firefox:failed\)/u);
      await rm(injected);
      await assert.rejects(
        validate(established),
        /established the release-matrix browser lane, but samples\/evidence\/maplibre-quickstart\/release-matrix\.v1\.json is missing/u,
      );
      // Still red where derived-artifact freshness is relaxed (feature PRs, trunk
      // push) -- only the publication automation downgrades it.
      await assert.rejects(
        validate({ ...established, relaxDerivedArtifacts: true }),
        /is missing; deleting sealed cross-browser evidence/u,
      );

      // The generator side stays hard even under the publication relaxation: that
      // switch exists so a FAILING receipt can be committed, never so a projection
      // can be published for an established lane with its evidence removed.
      await assert.rejects(
        withDerivedArtifactsRelax(derivedRelax, () =>
          collectQualificationEvidence(catalog, {
            receiptRoot,
            verifyCheckout: false,
            releaseMatrixLaneRegistryPath: established.releaseMatrixLaneRegistryPath,
          }),
        ),
        /is missing; deleting sealed cross-browser evidence/u,
      );

      // Without the establishment record the same deletion is only a note, which
      // is exactly today's pre-first-receipt trunk state.
      await validate({ receiptRoot, verifyCheckout: false });

      // Reseal green: qualified again, no manual edit.
      await writeFile(injected, `${JSON.stringify(await receipt(), null, 2)}\n`);
      await validate(established);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
