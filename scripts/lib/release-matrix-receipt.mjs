// Release-matrix browser receipt (honua-io/honua-sdk-js#766, split from #687).
//
// The First Map release smoke (.github/workflows/first-map-release-smoke.yml)
// runs the quickstart Playwright spec across Chromium, Firefox (headed under
// xvfb) and WebKit with HONUA_FIRST_MAP_RELEASE_MATRIX=true. Before this
// receipt existed the only durable output was an ephemeral 30-day Playwright
// JSON artifact, so samples/evidence/maplibre-quickstart/receipts/browser.v1.json
// kept claiming a Chromium-only pass while a Firefox or WebKit regression left
// no persisted trace and never made the golden qualification stale.
//
// This module owns the receipt's shape, its staleness policy, and the gate
// severity that scripts/sample-contract.mjs applies. It is deliberately a
// SEPARATE receipt type from honua.sdk.sample-gate-receipt.v1 because gate
// receipts are `status: "passed"`-only by construction (they exist to prove a
// gate held). A cross-engine matrix must be able to publish a FAILURE, since
// the failure is the signal that turns the golden qualification red.
//
// Integrity model (NFR-001): the receipt binds the same evidence-neutral
// whole-tree digest that scripts/sample-gate-receipt.mjs computes
// (evidenceNeutralSourceDigest / verifyEvidenceNeutralCheckout), names the
// producing workflow run, and content-binds the raw Playwright JSON report by
// digest. Nothing here fabricates an outcome: the seal step
// (scripts/seal-release-matrix-receipt.mjs) can only transcribe what the report
// says, and a receipt that is absent means "no matrix run has been observed
// yet", never "the matrix passed".

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readCanonicalBoundedFile } from "../sample-gate-receipt.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const RELEASE_MATRIX_RECEIPT_FORMAT = "honua.sdk.sample-release-matrix-receipt.v1";
export const RELEASE_MATRIX_RECEIPT_SCHEMA_PATH =
  "samples/contract/v2/schemas/sample-release-matrix-receipt.schema.json";
export const RELEASE_MATRIX_RECEIPT_FILE_NAME = "release-matrix.v1.json";
export const RELEASE_MATRIX_LANE = "release-matrix-browser";
export const RELEASE_MATRIX_ENV_NAME = "HONUA_FIRST_MAP_RELEASE_MATRIX";
export const RELEASE_MATRIX_ENV_VALUE = "true";
export const RELEASE_MATRIX_PLAYWRIGHT_CONFIG = "playwright.first-map.config.mjs";
export const RELEASE_MATRIX_REPORT_KIND = "playwright-release-matrix-report";
export const RELEASE_MATRIX_PRODUCER_PATH = "scripts/seal-release-matrix-receipt.mjs";
export const RELEASE_MATRIX_ARTIFACT_NAME = "honua-sdk-first-map-release-matrix";
// The release smoke covers exactly the First Map golden journey today, so only
// its candidate sample declares the lane. Any other sample carrying a
// release-matrix sidecar is an orphan and fails the evidence-root inventory.
export const RELEASE_MATRIX_SAMPLE_IDS = Object.freeze(["maplibre-quickstart"]);
// Kept in lockstep with playwright.first-map.config.mjs's release-matrix
// projects. Firefox is the headed one: true headless Firefox has no compositor
// and can never create a WebGL context (#687).
export const RELEASE_MATRIX_ENGINES = Object.freeze([
  Object.freeze({ name: "chromium", browserName: "chromium", headless: true }),
  Object.freeze({ name: "firefox", browserName: "firefox", headless: false }),
  Object.freeze({ name: "webkit", browserName: "webkit", headless: true }),
]);
// Mirrors the gate-receipt freshness policy exactly (scripts/sample-gate-receipt.mjs):
// seven days, anchored on observedAt. No new cadence is introduced.
export const RELEASE_MATRIX_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RELEASE_MATRIX_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const RELEASE_MATRIX_RECEIPT_MAX_BYTES = 64 * 1024;
export const RELEASE_MATRIX_RELAX_ENV_NAME = "HONUA_RELEASE_MATRIX_RECEIPT_RELAX";

const RELEASE_MATRIX_STATES = Object.freeze({
  notEstablished: "not-established",
  current: "current",
  stale: "stale",
  failed: "failed",
});

export const RELEASE_MATRIX_STATE = RELEASE_MATRIX_STATES;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let compiledSchema;

async function releaseMatrixReceiptSchemaValidator(projectRoot = PROJECT_ROOT) {
  if (compiledSchema) return compiledSchema;
  const bytes = await readCanonicalBoundedFile(projectRoot, RELEASE_MATRIX_RECEIPT_SCHEMA_PATH, {
    label: "release-matrix receipt schema",
    maxBytes: 256 * 1024,
  });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  compiledSchema = ajv.compile(JSON.parse(bytes.toString("utf8")));
  return compiledSchema;
}

/**
 * Canonical, committed location of a sample's release-matrix receipt. It is a
 * sidecar next to the per-gate `receipts/` tree rather than inside it, because
 * `validateQualificationReceiptSet` requires that directory to hold exactly the
 * quality profile's gate receipts and nothing else.
 */
export function releaseMatrixReceiptRelativePath(sampleId) {
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sampleId ?? ""), "release-matrix receipt sample id is invalid");
  return `samples/evidence/${sampleId}/${RELEASE_MATRIX_RECEIPT_FILE_NAME}`;
}

/**
 * True when the release-matrix lane's outcome must be reported but not enforced.
 * Set only by the persistence automation (regenerate-derived-artifacts.yml and
 * the strict CI it dispatches for its own artifacts PR): that workflow is the
 * channel that COMMITS a failing receipt, so it cannot be blocked by the very
 * evidence it is publishing. Every other lane keeps the gate enforced.
 */
export function releaseMatrixReceiptRelaxed(env = process.env) {
  return /^(1|true|yes|on)$/i.test(env[RELEASE_MATRIX_RELAX_ENV_NAME] ?? "");
}

export async function validateReleaseMatrixReceiptStructure(receipt, options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  invariant(
    receipt && typeof receipt === "object" && !Array.isArray(receipt),
    "release-matrix receipt must be an object",
  );
  const validate = await releaseMatrixReceiptSchemaValidator(projectRoot);
  if (!validate(receipt)) {
    const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`release-matrix receipt schema validation failed: ${detail}`);
  }
  if (options.sampleId) {
    invariant(receipt.sampleId === options.sampleId, "release-matrix receipt sample binding mismatch");
  }
  invariant(
    JSON.stringify(receipt.matrix.engines.map((engine) => engine.name)) ===
      JSON.stringify(RELEASE_MATRIX_ENGINES.map((engine) => engine.name)),
    "release-matrix receipt must record chromium, firefox, and webkit in that order",
  );
  for (const [index, engine] of receipt.matrix.engines.entries()) {
    const expected = RELEASE_MATRIX_ENGINES[index];
    invariant(
      engine.browserName === expected.browserName && engine.headless === expected.headless,
      `release-matrix receipt ${engine.name} engine does not match the declared release-matrix projects`,
    );
    invariant(
      (engine.status === "passed") === (engine.failed === 0),
      `release-matrix receipt ${engine.name} engine status contradicts its failure count`,
    );
    invariant(engine.failed <= engine.tests, `release-matrix receipt ${engine.name} engine failure count exceeds its test count`);
  }
  const failedEngines = receipt.matrix.engines.filter((engine) => engine.status !== "passed");
  invariant(
    (receipt.status === "passed") === (failedEngines.length === 0),
    "release-matrix receipt status contradicts its per-engine outcomes",
  );
  const observedAt = Date.parse(receipt.observedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  invariant(Number.isFinite(observedAt) && Number.isFinite(expiresAt), "release-matrix receipt timestamps are invalid");
  invariant(expiresAt > observedAt, "release-matrix receipt expiry must follow observation");
  invariant(
    expiresAt - observedAt <= RELEASE_MATRIX_MAX_WINDOW_MS,
    "release-matrix receipt exceeds seven-day freshness policy",
  );
  const now = Date.parse(options.now ?? new Date().toISOString());
  invariant(Number.isFinite(now), "release-matrix receipt validation time is invalid");
  invariant(
    observedAt <= now + RELEASE_MATRIX_MAX_FUTURE_SKEW_MS,
    "release-matrix receipt observation is more than five minutes in the future",
  );
  invariant(
    receipt.command.argv.length >= 1 && receipt.command.argv[0] === "npm",
    "release-matrix receipt command must be the declared npm Playwright command",
  );
  return receipt;
}

/**
 * Reads the committed receipt when one exists. A missing file is NOT an error:
 * until the first release-matrix run seals a receipt the lane is simply not
 * established, and `samples:verify` must not turn red for evidence that has
 * never been produced (see releaseMatrixGateOutcome).
 */
export async function readReleaseMatrixReceipt(options = {}) {
  const sampleId = options.sampleId;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const receiptRoot = options.receiptRoot ?? path.join(projectRoot, "samples/evidence");
  const absolute = path.join(receiptRoot, sampleId, RELEASE_MATRIX_RECEIPT_FILE_NAME);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `${sampleId}: release-matrix receipt must be a regular non-symlink file`,
  );
  const bytes = await readCanonicalBoundedFile(receiptRoot, `${sampleId}/${RELEASE_MATRIX_RECEIPT_FILE_NAME}`, {
    label: `${sampleId} release-matrix receipt`,
    maxBytes: RELEASE_MATRIX_RECEIPT_MAX_BYTES,
  });
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${sampleId}: release-matrix receipt is not valid JSON`);
  }
  await validateReleaseMatrixReceiptStructure(parsed, {
    sampleId,
    projectRoot,
    now: options.now,
  });
  return {
    receipt: parsed,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    path: releaseMatrixReceiptRelativePath(sampleId),
  };
}

/**
 * Classifies a (possibly absent) receipt without deciding severity.
 *
 * - `not-established`: no receipt has ever been sealed for this sample.
 * - `failed`: the last observed matrix run had a failing engine.
 * - `stale`: the last observed matrix run passed but its seven-day window lapsed.
 * - `current`: all three engines passed inside the freshness window.
 */
export function releaseMatrixState(record, options = {}) {
  if (!record) return { state: RELEASE_MATRIX_STATES.notEstablished, failedEngines: [] };
  const receipt = record.receipt ?? record;
  const now = Date.parse(options.now ?? new Date().toISOString());
  invariant(Number.isFinite(now), "release-matrix state evaluation time is invalid");
  const failedEngines = receipt.matrix.engines
    .filter((engine) => engine.status !== "passed")
    .map((engine) => `${engine.name}:${engine.status}`);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (receipt.status !== "passed" || failedEngines.length > 0) {
    return { state: RELEASE_MATRIX_STATES.failed, failedEngines, expiresAt: receipt.expiresAt };
  }
  if (now >= expiresAt) {
    return { state: RELEASE_MATRIX_STATES.stale, failedEngines, expiresAt: receipt.expiresAt };
  }
  return { state: RELEASE_MATRIX_STATES.current, failedEngines, expiresAt: receipt.expiresAt };
}

/**
 * Severity policy (REQ-003). One graduated policy, three switches:
 *
 * - `not-established` is never an error. Merging this feature cannot turn CI
 *   red before any release-matrix run has sealed a receipt; the lane becomes
 *   enforced the moment the first receipt exists.
 * - `failed` is an error everywhere except the persistence automation
 *   (HONUA_RELEASE_MATRIX_RECEIPT_RELAX), which must be able to commit the
 *   failing receipt itself.
 * - `stale` (passed, but the seven-day window lapsed) is an error in strict
 *   lanes -- trunk's post-regeneration dispatch, docs-site, the publish path,
 *   and local runs -- and a warning wherever shared derived-artifact freshness
 *   is already relaxed (HONUA_DERIVED_ARTIFACTS_RELAX: feature PRs and the
 *   trunk push run), so a lapsed release cadence never blocks feature work it
 *   cannot fix. Dispatching first-map-release-smoke.yml reseals it.
 */
export function releaseMatrixGateOutcome(record, options = {}) {
  const sampleId = options.sampleId ?? record?.receipt?.sampleId ?? "sample";
  const { state, failedEngines, expiresAt } = releaseMatrixState(record, options);
  const relaxed = options.relaxed === true;
  const derivedArtifactsRelaxed = options.derivedArtifactsRelaxed === true;
  if (state === RELEASE_MATRIX_STATES.current) {
    return { state, severity: "ok", message: undefined };
  }
  if (state === RELEASE_MATRIX_STATES.notEstablished) {
    return {
      state,
      severity: "note",
      message:
        `${sampleId}: release-matrix browser evidence is not established yet; ` +
        `${releaseMatrixReceiptRelativePath(sampleId)} is sealed by the First Map release smoke ` +
        "and becomes a required qualification input once it exists",
    };
  }
  if (state === RELEASE_MATRIX_STATES.failed) {
    return {
      state,
      severity: relaxed ? "warning" : "error",
      message:
        `${sampleId}: release-matrix browser evidence reports a failing engine (${failedEngines.join(", ")}); ` +
        "the golden qualification is stale until a green three-engine release smoke reseals " +
        `${releaseMatrixReceiptRelativePath(sampleId)}`,
    };
  }
  return {
    state,
    severity: relaxed || derivedArtifactsRelaxed ? "warning" : "error",
    message:
      `${sampleId}: release-matrix browser evidence expired at ${expiresAt}; ` +
      "the golden qualification is stale until first-map-release-smoke.yml reseals " +
      `${releaseMatrixReceiptRelativePath(sampleId)}`,
  };
}

/**
 * Projection published into samples/dist/golden-journey-visual-evidence.v1.json
 * (REQ-004). Emitted only when a receipt exists, so the committed projection
 * stays byte-identical until the first matrix run lands.
 *
 * Deliberately clock-free: it publishes the sealed outcome and window, never a
 * derived `current`/`stale` verdict, so generated bytes stay reproducible as the
 * window lapses. Freshness is the gate's concern (releaseMatrixGateOutcome).
 */
export function releaseMatrixEvidenceProjection(record) {
  if (!record) return undefined;
  const receipt = record.receipt;
  return {
    lane: RELEASE_MATRIX_LANE,
    status: receipt.status,
    receiptPath: record.path,
    receiptSha256: record.sha256,
    envName: receipt.matrix.envName,
    playwrightConfig: receipt.matrix.playwrightConfig,
    playwrightVersion: receipt.matrix.playwrightVersion,
    observedAt: receipt.observedAt,
    expiresAt: receipt.expiresAt,
    source: {
      revision: receipt.sourceRevision,
      evidenceNeutralSha256: receipt.sourceDigest,
    },
    run: {
      repository: receipt.run.repository,
      workflow: receipt.run.workflow,
      runId: receipt.run.runId,
      runAttempt: receipt.run.runAttempt,
      event: receipt.run.event,
      commit: receipt.run.commit,
    },
    engines: receipt.matrix.engines.map((engine) => ({
      name: engine.name,
      browserName: engine.browserName,
      headless: engine.headless,
      status: engine.status,
    })),
    report: {
      kind: receipt.report.kind,
      bytes: receipt.report.bytes,
      sha256: receipt.report.sha256,
      workflowArtifactName: receipt.report.workflowArtifactName,
    },
  };
}

function playwrightEngineExecutions(report) {
  const executions = [];
  const visit = (suite, inheritedFile) => {
    const suiteFile = suite.file ?? inheritedFile;
    for (const child of suite.suites ?? []) visit(child, suiteFile);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          executions.push({
            file: spec.file ?? suiteFile,
            title: spec.title,
            projectName: test.projectName ?? "",
            status: result.status,
            durationMs: typeof result.duration === "number" ? result.duration : 0,
            retry: result.retry ?? 0,
          });
        }
      }
    }
  };
  for (const suite of report.suites ?? []) visit(suite);
  return executions;
}

/**
 * Transcribes per-engine outcomes from a Playwright JSON report. Every declared
 * release-matrix project must appear; a missing project is a failure of the
 * matrix itself, never an implicit pass.
 */
export function releaseMatrixEnginesFromPlaywrightReport(report, options = {}) {
  invariant(
    report && typeof report === "object" && report.config && Array.isArray(report.suites),
    "release-matrix report is not a Playwright JSON report",
  );
  invariant(
    typeof report.config.configFile === "string" &&
      path.posix.basename(report.config.configFile.replaceAll("\\", "/")) === RELEASE_MATRIX_PLAYWRIGHT_CONFIG,
    `release-matrix report was not produced by ${RELEASE_MATRIX_PLAYWRIGHT_CONFIG}`,
  );
  const reportProjects = (report.config.projects ?? []).map((project) => project.name).sort();
  invariant(
    JSON.stringify(reportProjects) === JSON.stringify(RELEASE_MATRIX_ENGINES.map((engine) => engine.name).sort()),
    "release-matrix report does not declare exactly the chromium, firefox, and webkit projects",
  );
  const expectedFile = options.playwrightFile
    ? path.posix.relative("test/playwright", options.playwrightFile)
    : undefined;
  const executions = playwrightEngineExecutions(report);
  invariant(executions.length > 0, "release-matrix report contains no test executions");
  if (expectedFile) {
    invariant(
      executions.every((execution) => execution.file === expectedFile),
      "release-matrix report contains executions outside the declared sample spec",
    );
  }
  return RELEASE_MATRIX_ENGINES.map((engine) => {
    const matches = executions.filter((execution) => execution.projectName === engine.name);
    invariant(matches.length > 0, `release-matrix report has no ${engine.name} execution`);
    // Playwright retries produce several results for one test; the last attempt
    // is the outcome the run reported, and any non-passed final attempt keeps
    // the engine failed.
    const finalAttempts = new Map();
    for (const match of matches) {
      const key = `${match.file} ${match.title}`;
      const previous = finalAttempts.get(key);
      if (!previous || match.retry >= previous.retry) finalAttempts.set(key, match);
    }
    const attempts = [...finalAttempts.values()];
    const failures = attempts.filter((attempt) => attempt.status !== "passed");
    const status = failures.length === 0 ? "passed" : failures[0].status;
    return {
      name: engine.name,
      browserName: engine.browserName,
      headless: engine.headless,
      status,
      tests: attempts.length,
      failed: failures.length,
      durationMs: Number(matches.reduce((total, match) => total + match.durationMs, 0).toFixed(3)),
    };
  });
}

export function releaseMatrixRunIdentity(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? "", 10);
  const workflow = env.GITHUB_WORKFLOW;
  const event = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF;
  const commit = env.GITHUB_SHA;
  invariant(
    repository && runId && workflow && event && ref && commit && Number.isSafeInteger(runAttempt),
    "release-matrix receipt requires a GitHub workflow run identity (GITHUB_REPOSITORY, GITHUB_RUN_ID, " +
      "GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA)",
  );
  return { repository, workflow, runId, runAttempt, event, ref, commit };
}

/**
 * Assembles the receipt. Callers supply the verified source binding and the raw
 * report digest; this function never inspects the working tree itself, so the
 * whole-tree verification stays in one place
 * (scripts/seal-release-matrix-receipt.mjs).
 */
export async function buildReleaseMatrixReceipt(options) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const observedAtMs = Date.parse(observedAt);
  invariant(Number.isFinite(observedAtMs), "release-matrix receipt observedAt is invalid");
  const engines = options.engines;
  invariant(Array.isArray(engines) && engines.length === RELEASE_MATRIX_ENGINES.length, "release-matrix engines are invalid");
  const producerBytes = await readCanonicalBoundedFile(projectRoot, RELEASE_MATRIX_PRODUCER_PATH, {
    label: "release-matrix receipt producer",
    maxBytes: 1024 * 1024,
  });
  invariant(
    options.matrixEnvValue === RELEASE_MATRIX_ENV_VALUE,
    `release-matrix receipt requires ${RELEASE_MATRIX_ENV_NAME}=${RELEASE_MATRIX_ENV_VALUE}`,
  );
  const receipt = {
    $schema: path.posix.relative(
      path.posix.dirname(releaseMatrixReceiptRelativePath(options.sampleId)),
      RELEASE_MATRIX_RECEIPT_SCHEMA_PATH,
    ),
    format: RELEASE_MATRIX_RECEIPT_FORMAT,
    schemaVersion: 1,
    sampleId: options.sampleId,
    lane: RELEASE_MATRIX_LANE,
    status: engines.every((engine) => engine.status === "passed") ? "passed" : "failed",
    sdkMode: "source",
    sourceRevision: options.sourceRevision,
    sourceDigest: options.sourceDigest,
    matrix: {
      envName: RELEASE_MATRIX_ENV_NAME,
      envValue: RELEASE_MATRIX_ENV_VALUE,
      playwrightConfig: RELEASE_MATRIX_PLAYWRIGHT_CONFIG,
      playwrightVersion: options.playwrightVersion,
      engines: engines.map((engine) => ({ ...engine })),
    },
    command: { argv: [...options.command] },
    run: { ...options.run },
    report: {
      kind: RELEASE_MATRIX_REPORT_KIND,
      bytes: options.report.bytes,
      sha256: options.report.sha256,
      workflowArtifactName: options.report.workflowArtifactName ?? RELEASE_MATRIX_ARTIFACT_NAME,
    },
    producer: {
      id: "honua-sdk-release-matrix-receipt",
      version: 1,
      path: RELEASE_MATRIX_PRODUCER_PATH,
      sha256: sha256(producerBytes),
    },
    observedAt,
    expiresAt: new Date(observedAtMs + RELEASE_MATRIX_MAX_WINDOW_MS).toISOString(),
  };
  await validateReleaseMatrixReceiptStructure(receipt, {
    sampleId: options.sampleId,
    projectRoot,
    now: observedAt,
  });
  return receipt;
}
