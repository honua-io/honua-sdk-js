// Release-matrix browser receipt coverage (honua-io/honua-sdk-js#766).
//
// Two concerns are pinned here:
//   1. Receipt parsing/sealing: only outcomes a Playwright report actually
//      contains can be transcribed, and the receipt's shape, engine set, and
//      seven-day window are enforced.
//   2. Staleness gating: a failing (or lapsed) matrix receipt makes the First
//      Map golden qualification stale in the exact code path `npm run
//      samples:verify` uses, while an ABSENT receipt keeps the lane un-gated.
//
// Fixtures live under this test's temporary directories, never under
// samples/evidence: nothing here may look like real browser evidence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  buildReleaseMatrixReceipt,
  RELEASE_MATRIX_ENGINES,
  RELEASE_MATRIX_MAX_WINDOW_MS,
  RELEASE_MATRIX_SAMPLE_IDS,
  RELEASE_MATRIX_STATE,
  readReleaseMatrixReceipt,
  releaseMatrixEnginesFromPlaywrightReport,
  releaseMatrixEvidenceProjection,
  releaseMatrixGateOutcome,
  releaseMatrixReceiptRelativePath,
  releaseMatrixReceiptRelaxed,
  releaseMatrixRunIdentity,
  releaseMatrixState,
} from "../../scripts/lib/release-matrix-receipt.mjs";
import { validateCatalog } from "../../scripts/sample-contract.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const projectRoot = path.resolve(import.meta.dirname, "../..");
const sampleId = "maplibre-quickstart";
const revision = "a".repeat(40);
const digest = "b".repeat(64);
const reportDigest = "c".repeat(64);

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

  // The projection is what samples/dist/golden-journey-visual-evidence.v1.json
  // publishes, so it must satisfy that artifact's versioned schema.
  const visualSchema = JSON.parse(
    await readFile(
      path.join(projectRoot, "samples/contract/v2/schemas/golden-journey-visual-evidence.schema.json"),
      "utf8",
    ),
  );
  // strict: false matches how scripts/sample-contract.mjs compiles this schema
  // (its screenshot prefixItems intentionally layer allOf overlays).
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(visualSchema, "golden-journey-visual-evidence");
  const validate = ajv.getSchema("golden-journey-visual-evidence#/$defs/releaseMatrixEvidence");
  assert.ok(validate, "the visual evidence schema must define the release-matrix link");
  assert.ok(validate(projection), JSON.stringify(validate.errors));
  assert.equal(validate({ ...projection, unexpected: true }), false);
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

// Fault injection through the exact path `npm run samples:verify` runs
// (scripts/sample-contract.mjs check -> validateCatalog): an injected failing
// receipt has to turn the First Map golden qualification red, and removing it
// has to restore a green run without any other edit.
test("a failing release-matrix receipt turns golden qualification validation red", async () => {
  const catalog = JSON.parse(await readFile(path.join(projectRoot, "samples/catalog.v2.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "honua-release-matrix-evidence-"));
  const receiptRoot = path.join(directory, "evidence");
  try {
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
    const injected = path.join(receiptRoot, sampleId, "release-matrix.v1.json");
    const options = { receiptRoot, verifyCheckout: false };

    // No receipt at all: the lane is not established and validation passes.
    await validateCatalog(catalog, packageJson, options);

    await writeFile(
      injected,
      `${JSON.stringify(await receipt({ engines: engines({ webkit: { status: "failed" } }) }), null, 2)}\n`,
    );
    await assert.rejects(
      validateCatalog(catalog, packageJson, options),
      /release-matrix browser evidence reports a failing engine \(webkit:failed\)/u,
    );

    // A lapsed but previously green receipt is stale in strict lanes.
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
    await assert.rejects(validateCatalog(catalog, packageJson, options), /release-matrix browser evidence expired at/u);
    await validateCatalog(catalog, packageJson, { ...options, relaxDerivedArtifacts: true });

    // A green three-engine run restores qualification with no other edit.
    await writeFile(injected, `${JSON.stringify(await receipt(), null, 2)}\n`);
    await validateCatalog(catalog, packageJson, options);

    // The receipt is a declared sidecar for the First Map candidate only.
    assert.deepEqual(RELEASE_MATRIX_SAMPLE_IDS, [sampleId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
