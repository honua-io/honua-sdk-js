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
// Establishment registry. It deliberately lives under samples/contract -- INSIDE
// the evidence-neutral source digest -- while the receipt itself lives under
// samples/evidence, which is outside it. That asymmetry is the anti-laundering
// property: deleting a failing or lapsed sidecar cannot relax the lane back to
// "not established", because the requirement is recorded in reviewed contract
// source that the digest and code review both cover.
export const RELEASE_MATRIX_LANES_FORMAT = "honua.sdk.sample-release-matrix-lanes.v1";
export const RELEASE_MATRIX_LANES_PATH = "samples/contract/v2/release-matrix-lanes.v1.json";
export const RELEASE_MATRIX_LANES_SCHEMA_PATH =
  "samples/contract/v2/schemas/sample-release-matrix-lanes.schema.json";
export const RELEASE_MATRIX_LANES_MAX_BYTES = 64 * 1024;

const RELEASE_MATRIX_STATES = Object.freeze({
  notEstablished: "not-established",
  current: "current",
  stale: "stale",
  failed: "failed",
  // Established by the registry, but the sealed sidecar is gone. Deleting
  // evidence is never a way back to qualified.
  missing: "missing",
});

export const RELEASE_MATRIX_STATE = RELEASE_MATRIX_STATES;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const compiledSchemas = new Map();

async function releaseMatrixSchemaValidator(schemaPath, label, projectRoot = PROJECT_ROOT) {
  const cached = compiledSchemas.get(schemaPath);
  if (cached) return cached;
  const bytes = await readCanonicalBoundedFile(projectRoot, schemaPath, {
    label,
    maxBytes: 256 * 1024,
  });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(bytes.toString("utf8")));
  compiledSchemas.set(schemaPath, validate);
  return validate;
}

function releaseMatrixReceiptSchemaValidator(projectRoot = PROJECT_ROOT) {
  return releaseMatrixSchemaValidator(RELEASE_MATRIX_RECEIPT_SCHEMA_PATH, "release-matrix receipt schema", projectRoot);
}

function releaseMatrixLanesSchemaValidator(projectRoot = PROJECT_ROOT) {
  return releaseMatrixSchemaValidator(RELEASE_MATRIX_LANES_SCHEMA_PATH, "release-matrix lanes schema", projectRoot);
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

export async function validateReleaseMatrixLaneRegistry(registry, options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  invariant(
    registry && typeof registry === "object" && !Array.isArray(registry),
    "release-matrix lane registry must be an object",
  );
  const validate = await releaseMatrixLanesSchemaValidator(projectRoot);
  if (!validate(registry)) {
    const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`release-matrix lane registry schema validation failed: ${detail}`);
  }
  const sampleIds = registry.lanes.map((lane) => lane.sampleId);
  invariant(
    JSON.stringify(sampleIds) === JSON.stringify([...new Set(sampleIds)].sort()),
    "release-matrix lane registry entries must be unique and sorted by sample id",
  );
  for (const lane of registry.lanes) {
    invariant(
      RELEASE_MATRIX_SAMPLE_IDS.includes(lane.sampleId),
      `${lane.sampleId}: release-matrix lane registry names a sample that does not declare the lane`,
    );
    invariant(
      lane.receiptPath === releaseMatrixReceiptRelativePath(lane.sampleId),
      `${lane.sampleId}: release-matrix lane registry receipt path drift`,
    );
    const establishedAt = Date.parse(lane.establishedAt);
    const now = Date.parse(options.now ?? new Date().toISOString());
    invariant(Number.isFinite(establishedAt), `${lane.sampleId}: release-matrix lane establishment time is invalid`);
    invariant(
      establishedAt <= now + RELEASE_MATRIX_MAX_FUTURE_SKEW_MS,
      `${lane.sampleId}: release-matrix lane establishment is more than five minutes in the future`,
    );
  }
  return registry;
}

/**
 * Reads the committed establishment registry. An ABSENT file means no lane has
 * ever been established, which is the pre-first-receipt state and stays a
 * harmless note. A present file is authoritative: every sample it names must
 * carry its sealed sidecar from then on.
 */
export async function readReleaseMatrixLaneRegistry(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const relative = options.registryPath ?? RELEASE_MATRIX_LANES_PATH;
  const absolute = path.join(projectRoot, relative);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "release-matrix lane registry must be a regular non-symlink file",
  );
  const bytes = await readCanonicalBoundedFile(projectRoot, relative, {
    label: "release-matrix lane registry",
    maxBytes: RELEASE_MATRIX_LANES_MAX_BYTES,
  });
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("release-matrix lane registry is not valid JSON");
  }
  await validateReleaseMatrixLaneRegistry(parsed, { projectRoot, now: options.now });
  return {
    registry: parsed,
    path: relative,
    lanes: new Map(parsed.lanes.map((lane) => [lane.sampleId, lane])),
  };
}

export function releaseMatrixLaneEstablished(laneRegistry, sampleId) {
  return Boolean(laneRegistry?.lanes?.has(sampleId));
}

export function releaseMatrixMissingReceiptMessage(sampleId) {
  return (
    `${sampleId}: ${RELEASE_MATRIX_LANES_PATH} established the release-matrix browser lane, but ` +
    `${releaseMatrixReceiptRelativePath(sampleId)} is missing; deleting sealed cross-browser evidence ` +
    "cannot restore the golden qualification -- reseal it with first-map-release-smoke.yml"
  );
}

/**
 * Idempotently records a lane's establishment from its sealed receipt. Called by
 * `node scripts/sample-contract.mjs record-release-matrix-lane`, which the
 * regeneration workflow runs alongside the catalog live-expiry refresh so the
 * registry lands in the SAME automation commit chain that publishes the receipt.
 * `establishedAt` is pinned to the first receipt's observation, so re-running it
 * for an already-established lane produces no bytes and therefore no
 * source-digest churn.
 */
export function recordedReleaseMatrixLaneRegistry(registry, receipt) {
  invariant(
    receipt?.format === RELEASE_MATRIX_RECEIPT_FORMAT && receipt.lane === RELEASE_MATRIX_LANE,
    "release-matrix lane establishment requires a release-matrix receipt",
  );
  invariant(
    RELEASE_MATRIX_SAMPLE_IDS.includes(receipt.sampleId),
    `${receipt.sampleId}: release-matrix lane establishment requires a sample that declares the lane`,
  );
  const base =
    registry ?? {
      $schema: path.posix.relative(path.posix.dirname(RELEASE_MATRIX_LANES_PATH), RELEASE_MATRIX_LANES_SCHEMA_PATH),
      format: RELEASE_MATRIX_LANES_FORMAT,
      schemaVersion: 1,
      lanes: [],
    };
  invariant(base.format === RELEASE_MATRIX_LANES_FORMAT && base.schemaVersion === 1, "release-matrix lane registry format must be v1");
  if (base.lanes.some((lane) => lane.sampleId === receipt.sampleId)) {
    return { registry: base, changed: false };
  }
  const lanes = [
    ...base.lanes,
    {
      sampleId: receipt.sampleId,
      lane: RELEASE_MATRIX_LANE,
      receiptPath: releaseMatrixReceiptRelativePath(receipt.sampleId),
      establishedAt: receipt.observedAt,
      establishedBy: {
        repository: receipt.run.repository,
        workflow: receipt.run.workflow,
        runId: receipt.run.runId,
        runAttempt: receipt.run.runAttempt,
        commit: receipt.run.commit,
      },
    },
  ].sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  return { registry: { ...base, lanes }, changed: true };
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
 * - `not-established`: the lane is absent from the establishment registry and no
 *   receipt has ever been sealed for this sample.
 * - `missing`: the registry established the lane, but its sealed receipt is gone.
 *   Deleting evidence is not a route back to qualified.
 * - `failed`: the last observed matrix run had a failing engine.
 * - `stale`: the last observed matrix run passed but its seven-day window lapsed.
 * - `current`: all three engines passed inside the freshness window.
 */
export function releaseMatrixState(record, options = {}) {
  if (!record) {
    return {
      state: options.established === true ? RELEASE_MATRIX_STATES.missing : RELEASE_MATRIX_STATES.notEstablished,
      failedEngines: [],
    };
  }
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
 *   enforced the moment the automation records its establishment.
 * - `missing` (established, sidecar deleted) carries exactly the same severity as
 *   `failed`. The establishment record lives in reviewed contract source inside
 *   the evidence-neutral digest, so removing the sealed receipt cannot launder a
 *   failing or lapsed lane back to a harmless note.
 * - `failed` is an error everywhere except the persistence automation
 *   (HONUA_RELEASE_MATRIX_RECEIPT_RELAX), which must be able to commit the
 *   failing receipt itself.
 * - `stale` (passed, but the seven-day window lapsed) is an error in strict
 *   lanes -- trunk's post-regeneration dispatch, docs-site, the publish path,
 *   and local runs -- and a warning wherever shared derived-artifact freshness
 *   is already relaxed (HONUA_DERIVED_ARTIFACTS_RELAX: feature PRs and the
 *   trunk push run), so a lapsed release cadence never blocks feature work it
 *   cannot fix. Dispatching first-map-release-smoke.yml reseals it.
 *
 * Two invariants the table below makes structural, because both have already
 * been reached for accidentally:
 *
 *   1. HONUA_DERIVED_ARTIFACTS_RELAX may soften DECAY only. `failed` and
 *      `missing` are affirmative findings about the tree in front of us -- a
 *      real failing engine, or sealed evidence that was deleted -- and neither
 *      branch is allowed to consult it. Only the publication automation's
 *      HONUA_RELEASE_MATRIX_RECEIPT_RELAX downgrades those, because that channel
 *      is what COMMITS the failing receipt.
 *   2. Establishment governs ABSENCE only. It selects between `not-established`
 *      and `missing` inside releaseMatrixState and never appears here, so it can
 *      never soften a receipt that is present and failing.
 *
 * A structurally invalid receipt never reaches this function at all:
 * readReleaseMatrixReceipt throws on it, unconditionally, in every lane.
 */
const RELEASE_MATRIX_SEVERITY = Object.freeze({
  // state: (switches) => severity. `decayRelaxed` is deliberately absent from
  // every branch except `stale`.
  [RELEASE_MATRIX_STATES.current]: () => "ok",
  [RELEASE_MATRIX_STATES.notEstablished]: () => "note",
  [RELEASE_MATRIX_STATES.missing]: ({ publicationRelaxed }) => (publicationRelaxed ? "warning" : "error"),
  [RELEASE_MATRIX_STATES.failed]: ({ publicationRelaxed }) => (publicationRelaxed ? "warning" : "error"),
  [RELEASE_MATRIX_STATES.stale]: ({ publicationRelaxed, decayRelaxed }) =>
    publicationRelaxed || decayRelaxed ? "warning" : "error",
});

export function releaseMatrixGateOutcome(record, options = {}) {
  const sampleId = options.sampleId ?? record?.receipt?.sampleId ?? "sample";
  const { state, failedEngines, expiresAt } = releaseMatrixState(record, options);
  const severity = RELEASE_MATRIX_SEVERITY[state]({
    publicationRelaxed: options.relaxed === true,
    decayRelaxed: options.derivedArtifactsRelaxed === true,
  });
  const messages = {
    [RELEASE_MATRIX_STATES.current]: undefined,
    [RELEASE_MATRIX_STATES.notEstablished]:
      `${sampleId}: release-matrix browser evidence is not established yet; ` +
      `${releaseMatrixReceiptRelativePath(sampleId)} is sealed by the First Map release smoke ` +
      `and becomes a required qualification input once ${RELEASE_MATRIX_LANES_PATH} records the lane`,
    [RELEASE_MATRIX_STATES.missing]: releaseMatrixMissingReceiptMessage(sampleId),
    [RELEASE_MATRIX_STATES.failed]:
      `${sampleId}: release-matrix browser evidence reports a failing engine (${failedEngines.join(", ")}); ` +
      "the golden qualification is stale until a green three-engine release smoke reseals " +
      `${releaseMatrixReceiptRelativePath(sampleId)}`,
    [RELEASE_MATRIX_STATES.stale]:
      `${sampleId}: release-matrix browser evidence expired at ${expiresAt}; ` +
      "the golden qualification is stale until first-map-release-smoke.yml reseals " +
      `${releaseMatrixReceiptRelativePath(sampleId)}`,
  };
  return { state, severity, message: messages[state] };
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
