#!/usr/bin/env node
/**
 * Retained fixture and scheduled-live evidence producer for issue #818.
 *
 * Fixture mode executes the complete versioned corpus through the installed
 * `@honua/sdk-js/realtime` entrypoint. Live mode first probes honua-server's
 * advertised transports, then executes only those transports and records
 * `unsupported`, `degraded`, and `failed` separately from `executed`.
 *
 * Live mode does not observe passively. A deployment that nobody happens to be
 * editing produces no mutation, so the lane drives one itself through
 * honua-server's controlled-conformance surface (honua-server#3038): lease a
 * run, insert exactly one owned record *before* any transport opens, `touch`
 * that record once per transport, and release in a `finally` block. The single
 * shared insert is what makes cross-transport reconciliation possible at all —
 * transports can only be opened sequentially, and an insert per transport would
 * give each one a different object id and diverge by construction.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ConformanceRunRefusal,
  createConformanceRunClient,
  isConformanceAvailabilityRefusal,
  readConformanceCapability,
} from "./realtime-conformance-run-client.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_PATH = "test/fixtures/realtime/cross-transport-conformance.v1.json";
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const evidenceAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(evidenceAjv);
const validateEvidenceSchema = evidenceAjv.compile(
  JSON.parse(readProjectBytes("schemas/realtime-conformance-evidence.v1.json").toString("utf8")),
);

export const REALTIME_CONFORMANCE_EVIDENCE_FORMAT = "honua.sdk.realtime-conformance-evidence.v1";
export const REALTIME_CONFORMANCE_EVIDENCE_SCHEMA = "schemas/realtime-conformance-evidence.v1.json";
export const REALTIME_LIVE_ENABLE_ENV = "HONUA_REALTIME_LIVE_CONFORMANCE_ENABLED";
/**
 * Second, separate opt-in. Observing a deployment is read-only; driving a
 * controlled mutation writes to it. Enabling the live lane must never imply
 * consent to write, so the two switches stay independent.
 */
export const REALTIME_CONFORMANCE_MUTATE_ENV = "HONUA_REALTIME_LIVE_CONFORMANCE_MUTATE";
export const REALTIME_CONFORMANCE_LABEL_ENV = "HONUA_REALTIME_LIVE_CONFORMANCE_LABEL";
export const REALTIME_CONFORMANCE_TTL_ENV = "HONUA_REALTIME_LIVE_CONFORMANCE_TTL_SECONDS";
export const REALTIME_CONFORMANCE_DEFAULT_LABEL = "honua-sdk-js-realtime-conformance";
export const REALTIME_TRANSPORTS = Object.freeze(["sse", "websocket", "odata"]);
export const REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES = 1_048_576;
export const REALTIME_SSE_EVENT_MAX_BYTES = 262_144;
export const REALTIME_SSE_BUFFER_MAX_BYTES = 262_144;
export const REALTIME_LIVE_SEMANTIC_LIMITS = Object.freeze({
  maxEvents: 64,
  maxFeaturesPerEvent: 10_000,
  maxRecords: 10_000,
  maxDepth: 16,
  maxNodes: 500_000,
  maxObjectKeys: 512,
  maxArrayItems: 100_000,
  maxStringBytes: 65_536,
  maxGeometryPositions: 25_000,
  maxHistoryBytes: 16_777_216,
});

const DEFAULT_LIVE_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const IMMUTABLE_SERVER_REVISION = /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/u;

class LiveDegradedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveDegradedError";
    this.code = code;
  }
}

class LiveSemanticError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveSemanticError";
    this.code = code;
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readProjectBytes(relativePath, projectRoot = PROJECT_ROOT) {
  return fs.readFileSync(path.join(projectRoot, relativePath));
}

function packageIdentity(projectRoot = PROJECT_ROOT) {
  const packageJson = JSON.parse(readProjectBytes("package.json", projectRoot).toString("utf8"));
  return { package: packageJson.name, version: packageJson.version };
}

/**
 * GitHub Actions renders an unset `workflow_dispatch` input or an undefined
 * repository variable as the empty string, so a scheduled run arrives with
 * `HONUA_REALTIME_LIVE_SERVER_REVISION=""` rather than with the variable
 * absent. An empty value means *absent*, never *present and invalid*: the
 * distinction matters because `??` treats `""` as supplied, which turned a
 * missing optional input into a hard throw, `Number("")` into layer `0`, and a
 * missing source id into the empty string. Normalizing once at the boundary
 * keeps every downstream `env.X ?? default` honest instead of asking each
 * call site to re-derive the same rule.
 */
export function normalizeLiveEnv(env = process.env) {
  const normalized = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim().length === 0) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function realtimeSourceRevision(env = process.env, projectRoot = PROJECT_ROOT) {
  const supplied = env.HONUA_SAMPLE_SOURCE_REVISION ?? env.GITHUB_SHA;
  if (/^[a-f0-9]{40}$/u.test(supplied ?? "")) return supplied;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    if (/^[a-f0-9]{40}$/u.test(revision)) return revision;
  } catch {
    // The caller receives a precise revision error below.
  }
  throw new Error("Realtime conformance evidence requires a full 40-character SDK revision.");
}

export function isRealtimeLiveEnabled(env = process.env) {
  return /^(?:1|true)$/iu.test(env[REALTIME_LIVE_ENABLE_ENV] ?? "");
}

/**
 * Whether the operator has consented to this lane writing to the reviewed
 * deployment through its dedicated controlled-conformance source.
 */
export function isRealtimeConformanceMutationEnabled(env = process.env) {
  return /^(?:1|true)$/iu.test(env[REALTIME_CONFORMANCE_MUTATE_ENV] ?? "");
}

export async function collectFixtureRealtimeConformanceEvidence(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const corpusBytes = options.corpusBytes ?? readProjectBytes(CORPUS_PATH, projectRoot);
  const corpus = options.corpus ?? JSON.parse(corpusBytes.toString("utf8"));
  const sdk = options.sdk ?? (await import("@honua/sdk-js/realtime"));
  const runMatrix =
    options.runMatrix ??
    (
      await import(
        new URL("../dist/test/helpers/realtime-cross-transport-matrix.js", import.meta.url).href
      )
    ).runRealtimeCrossTransportMatrix;
  const matrix = await runMatrix({ sdk, corpus });
  invariant(matrix.scenarioCount === corpus.scenarios.length, "Fixture evidence did not execute the full corpus.");
  invariant(matrix.transportCount === 3, "Fixture evidence did not execute all three transports.");
  invariant(
    matrix.persistedReplay?.sameScopeCompatible === true &&
      matrix.persistedReplay.cursorReplayed === true &&
      matrix.persistedReplay.watermarkReplayed === true &&
      matrix.persistedReplay.checkpointLoads >= 2 &&
      matrix.persistedReplay.connectionAttempts >= 2 &&
      matrix.persistedReplay.resumedSequence === corpus.positions.snapshot.sequence &&
      matrix.persistedReplay.acceptedSequence === corpus.positions.delta.sequence,
    "Fixture evidence did not prove same-scope persisted checkpoint replay.",
  );

  const transports = REALTIME_TRANSPORTS.map((id) => {
    const scenarios = matrix.scenarios.map((scenario) => {
      const result = scenario.transports.find((transport) => transport.transport === id);
      invariant(result?.result === "passed", `${id}/${scenario.id} did not pass fixture conformance.`);
      return { id: scenario.id, result: "passed" };
    });
    return {
      id,
      freshness: id === "odata" ? "poll" : "push",
      advertised: true,
      status: "executed",
      scenarioCounts: { total: scenarios.length, passed: scenarios.length, failed: 0 },
      scenarios,
      diagnostics: [],
    };
  });
  return validateRealtimeConformanceEvidence(
    assembleEvidence({
      lane: "fixture",
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      sdk: {
        ...packageIdentity(projectRoot),
        revision:
          options.sourceRevision ??
          realtimeSourceRevision(normalizeLiveEnv(options.env ?? process.env), projectRoot),
      },
      server: {
        version: "fixture-v1",
        revision: `sha256:${sha256(corpusBytes)}`,
        revisionSource: "fixture",
        capabilities: { sse: true, websocket: true, odata: true },
      },
      corpusBytes,
      scenarioCount: matrix.scenarioCount,
      executionCount: matrix.executionCount,
      transports,
    }),
  );
}

export async function collectLiveRealtimeConformanceEvidence(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const env = normalizeLiveEnv(options.env ?? process.env);
  const corpusBytes = options.corpusBytes ?? readProjectBytes(CORPUS_PATH, projectRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sdkIdentity = {
    ...packageIdentity(projectRoot),
    revision: options.sourceRevision ?? realtimeSourceRevision(env, projectRoot),
  };
  if (!(options.enabled ?? isRealtimeLiveEnabled(env))) {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      nonExecutedTransport(id, false, "degraded", "live-lane-disabled", `${REALTIME_LIVE_ENABLE_ENV} is not true.`),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: null,
          revision: null,
          capabilities: { sse: false, websocket: false, odata: false },
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
        conformance: conformanceNotAttempted("live-lane-disabled", `${REALTIME_LIVE_ENABLE_ENV} is not true.`),
      }),
    );
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  invariant(typeof fetchFn === "function", "Live realtime conformance requires fetch.");
  const baseUrl = sanitizeBaseUrl(
    options.baseUrl ?? env.HONUA_REALTIME_LIVE_BASE_URL ?? env.HONUA_BENCH_LIVE_BASE_URL ?? "https://demo.honua.io",
  );
  const apiKey = options.apiKey ?? env.HONUA_REALTIME_LIVE_API_KEY ?? env.HONUA_BENCH_LIVE_API_KEY;
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS, "live timeout");
  const capabilitiesUrl = `${baseUrl}/api/v1/streaming/features/capabilities`;
  let capabilityResponse;
  try {
    capabilityResponse = await requestJson(capabilitiesUrl, fetchFn, headers, timeoutMs);
  } catch (error) {
    const unavailable = classifyCapabilityProbeFailure(error);
    const transports = REALTIME_TRANSPORTS.map((id) =>
      nonExecutedTransport(id, false, unavailable.status, unavailable.code, unavailable.message),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: null,
          revision: null,
          capabilities: { sse: false, websocket: false, odata: false },
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
        conformance: conformanceNotAttempted(unavailable.code, unavailable.message),
      }),
    );
  }

  let descriptors;
  try {
    descriptors = normalizeLiveCapabilities(capabilityResponse.body, baseUrl);
  } catch {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      nonExecutedTransport(
        id,
        false,
        "failed",
        "capability-contract-invalid",
        "Realtime capability response failed contract validation.",
      ),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: null,
          revision: null,
          capabilities: { sse: false, websocket: false, odata: false },
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
        conformance: conformanceNotAttempted(
          "capability-contract-invalid",
          "Realtime capability response failed contract validation.",
        ),
      }),
    );
  }
  const capabilities = Object.fromEntries(
    REALTIME_TRANSPORTS.map((id) => [id, descriptors[id].advertised]),
  );
  const configuredServerRevision = immutableServerRevisionOrNull(
    options.serverRevision ?? env.HONUA_REALTIME_LIVE_SERVER_REVISION,
  );
  const configuredServerVersion = textOrNull(
    options.serverVersion ?? env.HONUA_REALTIME_LIVE_SERVER_VERSION,
  );
  const probedIdentity =
    descriptors.serverRevision !== null && descriptors.serverVersion !== null
      ? { version: null, revision: null, probe: null }
      : await probeServerIdentity(baseUrl, fetchFn, headers, timeoutMs);
  const observedServerRevision = descriptors.serverRevision ?? probedIdentity.revision;
  const serverRevision = observedServerRevision;
  const serverVersion = descriptors.serverVersion ?? probedIdentity.version ?? configuredServerVersion;
  // Which document bound the retained evidence to a deployment is part of the
  // evidence, not an implementation detail: a reader must be able to tell a
  // capability-advertised revision from a manifest-probed one.
  const serverRevisionSource =
    descriptors.serverRevision !== null
      ? "capabilities"
      : probedIdentity.revision !== null
        ? "manifest"
        : null;
  if (
    configuredServerRevision !== null &&
    observedServerRevision !== null &&
    configuredServerRevision !== observedServerRevision
  ) {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      descriptors[id].advertised
        ? nonExecutedTransport(
            id,
            true,
            "failed",
            "server-revision-mismatch",
            "Advertised realtime transport belongs to a different immutable server revision.",
          )
        : nonExecutedTransport(
            id,
            false,
            "unsupported",
            "transport-not-advertised",
            `honua-server did not advertise ${id}.`,
          ),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: serverVersion,
          revision: observedServerRevision,
          revisionSource: serverRevisionSource,
          capabilities,
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
        conformance: conformanceNotAttempted(
          "server-revision-mismatch",
          "Advertised realtime transport belongs to a different immutable server revision.",
        ),
      }),
    );
  }
  if (
    serverRevision === null &&
    REALTIME_TRANSPORTS.some((id) => descriptors[id].advertised)
  ) {
    const revisionMissingMessage = `Advertised realtime transport cannot be certified without an exact server revision (capabilities: no immutable revision; ${
      probedIdentity.probe ?? "manifest not probed"
    }).`;
    const transports = REALTIME_TRANSPORTS.map((id) =>
      descriptors[id].advertised
        ? nonExecutedTransport(id, true, "failed", "server-revision-missing", revisionMissingMessage)
        : nonExecutedTransport(
            id,
            false,
            "unsupported",
            "transport-not-advertised",
            `honua-server did not advertise ${id}.`,
          ),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: { version: serverVersion, revision: null, revisionSource: null, capabilities },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
        conformance: conformanceNotAttempted("server-revision-missing", revisionMissingMessage),
      }),
    );
  }
  const sdk = options.sdk ?? (await import("@honua/sdk-js/realtime"));
  // The controlled run owns the source it mutates. When one is leased its
  // dedicated service/layer replaces the configured observation target: an
  // insert into the conformance source is only observable on a subscription
  // scoped to that source.
  const run = await leaseConformanceRun({
    baseUrl,
    fetchFn,
    headers,
    timeoutMs,
    env,
    mutateEnabled: options.mutateEnabled,
    capabilityBody: capabilityResponse.body,
    serverRevision,
  });
  const context = liveResumeContext(
    run.lease?.serviceId ?? options.sourceId ?? env.HONUA_REALTIME_LIVE_SOURCE_ID ?? "maui-parcels",
  );
  const request = {
    sourceId: context.sourceId,
    layerId:
      run.lease?.layerId ??
      nonNegativeInteger(options.layerId ?? Number(env.HONUA_REALTIME_LIVE_LAYER_ID ?? "1"), "live layer id"),
    mode: "snapshot-then-delta",
  };
  const executionOptions = {
    sdk,
    fetchFn,
    headers,
    timeoutMs,
    context,
    request,
    eventSourceFactory: options.eventSourceFactory,
    webSocketFactory: options.webSocketFactory,
    conformanceRecord: run.record,
    // A leased controlled run still proves the full snapshot-plus-mutation
    // contract. Baseline-only is the read-only observation used when the lane
    // has no authority to mutate the reviewed deployment.
    baselineOnly: options.baselineOnly === true && run.record === undefined,
  };
  const executions = [];
  try {
    for (const id of REALTIME_TRANSPORTS) {
      const descriptor = descriptors[id];
      if (!descriptor.advertised) {
        executions.push({
          transport: nonExecutedTransport(
            id,
            false,
            "unsupported",
            "transport-not-advertised",
            `honua-server did not advertise ${id}.`,
          ),
        });
        continue;
      }
      if (!descriptor.url) {
        executions.push({
          transport: nonExecutedTransport(
            id,
            true,
            "failed",
            "advertised-transport-missing-endpoint",
            `honua-server advertised ${id} without a usable endpoint.`,
          ),
        });
        continue;
      }
      executions.push(
        await executeAdvertisedTransport(id, descriptor, {
          ...executionOptions,
          // One `touch` per transport, driven only once that transport's own
          // baseline has landed. `touch` republishes the record without
          // changing it, so every transport reduces to the same final state.
          driveMutation: run.touch,
        }),
      );
    }
  } finally {
    await run.release();
  }
  const conformance = run.outcome();
  // A driven mutation that cannot be trusted is not evidence, so a failed run
  // takes every otherwise-executed transport down with it.
  const transports =
    conformance.status === "failed"
      ? failExecutedTransports(
          reconcileExecutedTransportStates(executions),
          conformance.reason.code,
          conformance.reason.message,
        )
      : reconcileExecutedTransportStates(executions);
  const attemptedScenarios = transports.flatMap((transport) => transport.scenarios);
  const executionCount = attemptedScenarios.length;
  const scenarioCount = new Set(attemptedScenarios.map((scenario) => scenario.id)).size;
  return validateRealtimeConformanceEvidence(
    assembleEvidence({
      lane: "live",
      generatedAt,
      sdk: sdkIdentity,
      server: {
        version: serverVersion,
        revision: serverRevision,
        revisionSource: serverRevisionSource,
        capabilities,
      },
      corpusBytes,
      scenarioCount,
      executionCount,
      transports,
      conformance,
    }),
  );
}

/**
 * Lease a controlled-conformance run and insert the single record every
 * transport will observe, or explain in named terms why no run was driven.
 *
 * The returned handle is always usable: when no run could be leased, `touch`
 * and `release` are no-ops and the lane observes exactly as it did before this
 * surface existed, reporting `skipped` or `degraded` rather than a fake pass.
 */
async function leaseConformanceRun(settings) {
  const { env, serverRevision } = settings;
  const label = textOrNull(env[REALTIME_CONFORMANCE_LABEL_ENV]) ?? REALTIME_CONFORMANCE_DEFAULT_LABEL;
  const ttlSeconds = conformanceTtlSeconds(env);
  const inert = (outcome) => ({
    lease: undefined,
    record: undefined,
    touch: undefined,
    release: () => Promise.resolve(),
    outcome: () => outcome,
  });
  if (!(settings.mutateEnabled ?? isRealtimeConformanceMutationEnabled(env))) {
    return inert(
      conformanceNotAttempted(
        "controlled-mutation-not-opted-in",
        `${REALTIME_CONFORMANCE_MUTATE_ENV} is not true, so this lane observed without driving a mutation.`,
      ),
    );
  }

  let capability;
  try {
    capability = readConformanceCapability(settings.capabilityBody);
  } catch (error) {
    return inert(conformanceOutcome("failed", refusalCode(error), refusalReason(error)));
  }
  if (!capability.present) {
    return inert(
      conformanceNotAttempted(
        "conformance-not-advertised",
        "The reviewed deployment publishes no controlled-conformance contract.",
      ),
    );
  }
  if (!capability.enabled) {
    return inert(
      conformanceNotAttempted(
        "conformance-disabled",
        "The reviewed deployment provisions no controlled-conformance source.",
      ),
    );
  }

  const client = createConformanceRunClient({
    baseUrl: settings.baseUrl,
    fetchFn: settings.fetchFn,
    headers: settings.headers,
    timeoutMs: settings.timeoutMs,
  });
  let lease;
  let inserted;
  try {
    lease = await client.open({
      clientLabel: label,
      // Binding the lease to the revision this lane already certified makes it
      // impossible for a redeploy mid-run to yield evidence about an image the
      // observation never saw.
      ...(serverRevision === null ? {} : { expectedDeploymentRevision: serverRevision }),
      ...(capability.serviceId === null ? {} : { expectedServiceId: capability.serviceId }),
      ...(ttlSeconds === null ? {} : { ttlSeconds }),
    });
    if (serverRevision !== null && immutableServerRevisionOrNull(lease.deploymentRevision) !== serverRevision) {
      throw new ConformanceRunRefusal(
        "conformance-revision-unbound",
        "The controlled-conformance lease is bound to a different immutable deployment revision than the observed transports.",
      );
    }
    // Exactly one insert, before any transport opens, so every transport's
    // baseline already contains the record and its later `touch` is the only
    // mutation any of them observes.
    inserted = await client.mutate({ operation: "insert", label });
  } catch (error) {
    const outcome = conformanceOutcome(
      isConformanceAvailabilityRefusal(error) ? "degraded" : "failed",
      refusalCode(error),
      refusalReason(error),
      { lease },
    );
    if (!lease) return inert(outcome);
    // A lease was taken before the failure, so it still has to be released.
    const cleanup = await releaseQuietly(client);
    return inert({ ...outcome, baseline: cleanup ?? null });
  }

  const mutations = { insert: 1, touch: 0 };
  let cleanup;
  let failure;
  return {
    lease,
    record: {
      runMarker: lease.runMarker,
      runIdField: lease.runIdField,
      objectId: inserted.objectId,
    },
    touch: async () => {
      await client.mutate({ operation: "touch", objectId: inserted.objectId });
      mutations.touch += 1;
    },
    release: async () => {
      cleanup = await releaseQuietly(client);
      if (cleanup === undefined) {
        failure = {
          code: "conformance-cleanup-failed",
          message: "The controlled-conformance run could not be released, so its records may still be present.",
        };
      } else if (!cleanup.digestVerified) {
        failure = {
          code: "conformance-baseline-not-restored",
          message:
            "The controlled-conformance source's baseline digest did not reverse to the value observed at lease time.",
        };
      } else if (mutations.touch === 0) {
        // The run leased and inserted cleanly but never got to publish an
        // observable mutation. Each transport already carries the precise
        // reason it refused; the run only records that it drove none.
        failure = {
          code: "conformance-mutation-not-driven",
          message:
            "No advertised transport accepted the controlled-conformance baseline, so the run published no observable mutation.",
        };
      }
    },
    outcome: () => ({
      ...(failure
        ? conformanceOutcome("failed", failure.code, failure.message, { lease })
        : conformanceOutcome("executed", null, null, { lease })),
      mutations: { ...mutations },
      baseline: cleanup ?? null,
    }),
  };
}

/**
 * Release a run without letting the release itself throw. Cleanup runs in a
 * `finally` block: a refusal there must be recorded, never allowed to replace
 * the observation's own result.
 */
async function releaseQuietly(client) {
  try {
    return await client.release();
  } catch {
    return undefined;
  }
}

function conformanceTtlSeconds(env) {
  const raw = Number(env[REALTIME_CONFORMANCE_TTL_ENV] ?? "");
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

function refusalCode(error) {
  return error instanceof ConformanceRunRefusal ? error.code : "conformance-client-failed";
}

function refusalReason(error) {
  return error instanceof ConformanceRunRefusal
    ? error.reason
    : "The controlled-conformance client failed before it could reach a conclusion.";
}

function conformanceOutcome(status, code, message, detail = {}) {
  return {
    status,
    reason: status === "executed" ? null : { code, message },
    runId: detail.lease?.runId ?? null,
    serviceId: detail.lease?.serviceId ?? null,
    layerId: detail.lease?.layerId ?? null,
    deploymentRevision: detail.lease?.deploymentRevision ?? null,
    mutations: { insert: 0, touch: 0 },
    baseline: null,
  };
}

function conformanceNotAttempted(code, message) {
  return conformanceOutcome("skipped", code, message);
}

/**
 * Downgrade every executed transport when a run-scoped fact invalidates the
 * whole observation — the same shape `reconcileExecutedTransportStates` uses
 * for divergence, applied to failures that are only knowable after cleanup.
 */
function failExecutedTransports(transports, code, message) {
  return transports.map((transport) =>
    transport.status === "executed"
      ? {
          ...transport,
          status: "failed",
          scenarioCounts: { total: 1, passed: 0, failed: 1 },
          scenarios: [
            { id: transport.baselineState ? "baseline-completion" : "snapshot-delta-contract", result: "failed" },
          ],
          diagnostics: [{ code, message, scenario: "snapshot-delta-contract" }],
        }
      : transport,
  );
}

async function probeServerIdentity(baseUrl, fetchFn, headers, timeoutMs) {
  try {
    const response = await requestJson(
      `${baseUrl}/api/v1/capabilities/manifest`,
      fetchFn,
      headers,
      timeoutMs,
    );
    const server = isRecord(response.body?.server) ? response.body.server : {};
    const revision = immutableServerRevisionOrNull(pickImmutableRevision(server));
    return {
      version: textOrNull(server.serverVersion ?? server.version),
      revision,
      // A reachable manifest that carries no immutable revision is a different
      // deployment fact from an unreachable one, and only the retained
      // diagnostic can tell an operator which one to go fix.
      probe: revision === null ? "manifest-revision-absent" : "manifest",
    };
  } catch (error) {
    // Older deployments may not expose the public manifest. A null immutable
    // revision prevents advertised transports from being certified. The reason
    // is reduced to a bare status so no server-controlled prose reaches a
    // retained document.
    return {
      version: null,
      revision: null,
      probe: `manifest-unreachable${httpStatusDetail(error)}`,
    };
  }
}

class HttpStatusError extends Error {
  constructor(status) {
    super(`HTTP ${String(status)}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function classifyCapabilityProbeFailure(error) {
  if (error instanceof HttpStatusError) {
    if (error.status === 404 || error.status === 405) {
      return {
        status: "unsupported",
        code: "capability-endpoint-unavailable",
        message: "Realtime capability endpoint is not available on this server.",
      };
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return {
        status: "degraded",
        code: "capability-probe-degraded",
        message: "Realtime capability endpoint was temporarily unavailable.",
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        status: "failed",
        code: "capability-access-failed",
        message: "Realtime capability endpoint denied the conformance probe.",
      };
    }
    return {
      status: "failed",
      code: "capability-probe-http-failed",
      message: "Realtime capability endpoint rejected the conformance probe.",
    };
  }
  if (error instanceof LiveDegradedError) {
    return {
      status: "degraded",
      code: error.code,
      message: "Realtime capability probe was temporarily unavailable.",
    };
  }
  if (error instanceof LiveSemanticError) {
    return {
      status: "failed",
      code: error.code,
      message:
        error.code === "capability-json-invalid"
          ? "Realtime capability endpoint returned invalid JSON."
          : "Realtime capability response failed semantic validation.",
    };
  }
  return {
    status: "degraded",
    code: "capability-probe-degraded",
    message: "Realtime capability probe was unavailable because of a network failure.",
  };
}

async function requestJson(url, fetchFn, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("realtime capability timeout"), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new HttpStatusError(response.status);
    try {
      const text = await readBoundedResponseText(
        response,
        REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES,
        "capability-response-too-large",
        "Realtime capability response exceeded its byte ceiling.",
        controller.signal,
      );
      return { body: JSON.parse(text) };
    } catch (error) {
      if (error instanceof LiveSemanticError) throw error;
      throw new LiveSemanticError(
        "capability-json-invalid",
        "Realtime capability endpoint returned invalid JSON.",
      );
    }
  } catch (error) {
    if (controller.signal.aborted) throw new LiveDegradedError("capability-timeout", "Realtime capability probe timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response, maxBytes, code, message, signal) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await cancelReadableStream(response.body);
      throw new LiveSemanticError(code, message);
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  const abortReader = () => void cancelReader(reader);
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader(reader);
        throw new LiveSemanticError(code, message);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

async function cancelReadableStream(stream) {
  if (!stream) return;
  try {
    await stream.cancel();
  } catch {
    // The semantic size failure remains the source of truth.
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The semantic size failure remains the source of truth.
  }
}

function classifyLiveTransportFailure(error) {
  if (error instanceof ConformanceRunRefusal) {
    return isConformanceAvailabilityRefusal(error)
      ? {
          status: "degraded",
          code: error.code,
          message: "The controlled-conformance mutation surface was unavailable during observation.",
        }
      : {
          status: "failed",
          code: error.code,
          message: "The controlled-conformance mutation this transport depends on was refused.",
        };
  }
  const externalCode =
    typeof error?.code === "string" &&
    ["cursor-expired", "delivery-failed", "resume-unsupported", "transport-gap"].includes(error.code)
      ? error.code
      : error?.sdkCode === "realtime.protocol.terminal"
        ? "invalid-event"
        : undefined;
  const code =
    error instanceof LiveDegradedError || error instanceof LiveSemanticError
      ? error.code
      : (externalCode ?? "live-semantic-failure");
  const degraded =
    error instanceof LiveDegradedError ||
    code === "transport-gap" ||
    code === "cursor-expired";
  // Diagnostic text stays a fixed string so server-controlled prose can never
  // reach a retained document. An HTTP status is the one detail that both
  // matters to whoever must fix the deployment and cannot carry a secret, so
  // it is appended as a bare integer and nothing else.
  const detail = httpStatusDetail(error);
  return degraded
    ? {
        status: "degraded",
        code,
        message: `Advertised realtime transport was temporarily unavailable during observation.${detail}`,
      }
    : {
        status: "failed",
        code,
        message: `Advertised realtime transport failed the live conformance contract.${detail}`,
      };
}

function httpStatusDetail(error) {
  for (let node = error, depth = 0; isRecord(node) && depth < 8; node = node.cause, depth += 1) {
    const status = node.status ?? node.httpStatus ?? node.statusCode;
    if (Number.isSafeInteger(status) && status >= 100 && status <= 599) {
      return ` (HTTP ${String(status)})`;
    }
  }
  return "";
}

export function normalizeLiveCapabilities(payload, baseUrl) {
  invariant(isRecord(payload), "Realtime capability response must be an object.");
  const body = isRecord(payload.data) ? payload.data : payload;
  invariant(!Array.isArray(body), "Realtime capability response must be an object.");
  invariant(
    !Object.hasOwn(body, "enabled") || typeof body.enabled === "boolean",
    "Realtime capability enabled must be boolean.",
  );
  invariant(
    !Object.hasOwn(body, "transports") || Array.isArray(body.transports),
    "Realtime capability transports must be an array.",
  );
  invariant(
    typeof body.enabled === "boolean" || Array.isArray(body.transports),
    "Realtime capability response must explicitly declare enabled or transports.",
  );
  const hasExplicitTransports = Array.isArray(body.transports);
  const entries = hasExplicitTransports ? body.transports : [];
  const descriptors = {
    sse: {
      // `enabled: true` is the legacy SSE-only shape. Once the server emits a
      // transport list, that list is the authority and omission means
      // unsupported even if the legacy flag remains true.
      advertised: !hasExplicitTransports && body.enabled === true,
      url: body.streamUrl ?? body.sseUrl ?? null,
      entityIdField: null,
      pollIntervalMs: null,
    },
    websocket: {
      advertised: false,
      url: body.webSocketUrl ?? body.websocketUrl ?? null,
      entityIdField: null,
      pollIntervalMs: null,
    },
    odata: {
      advertised: false,
      url: body.odataDeltaUrl ?? null,
      entityIdField: textOrNull(body.odataEntityIdField),
      pollIntervalMs: body.odataPollIntervalMs ?? null,
    },
  };
  for (const entry of entries) {
    invariant(
      typeof entry === "string" || (isRecord(entry) && !Array.isArray(entry)),
      "Realtime capability transport entries must be strings or objects.",
    );
    if (isRecord(entry) && !Array.isArray(entry)) {
      const identifier = entry.id ?? entry.kind ?? entry.transport;
      invariant(
        typeof identifier === "string" && identifier.trim().length > 0,
        "Realtime capability transport id must be a non-empty string.",
      );
      invariant(
        !Object.hasOwn(entry, "enabled") || typeof entry.enabled === "boolean",
        "Realtime capability transport enabled must be boolean.",
      );
      invariant(
        !Object.hasOwn(entry, "url") || (typeof entry.url === "string" && entry.url.length > 0),
        "Realtime capability transport URL must be a non-empty string.",
      );
    }
    const normalized =
      typeof entry === "string"
        ? {
            id: normalizeTransportId(entry),
            enabled: true,
            url: null,
            entityIdField: null,
            pollIntervalMs: null,
          }
        : isRecord(entry)
          ? {
              id: normalizeTransportId(entry.id ?? entry.kind ?? entry.transport),
              enabled: entry.enabled !== false,
              url: typeof entry.url === "string" ? entry.url : null,
              entityIdField: textOrNull(entry.entityIdField),
              pollIntervalMs: entry.pollIntervalMs ?? null,
            }
          : undefined;
    if (!normalized?.id || !normalized.enabled || body.enabled === false) continue;
    descriptors[normalized.id].advertised = true;
    if (normalized.url) descriptors[normalized.id].url = normalized.url;
    if (normalized.entityIdField) descriptors[normalized.id].entityIdField = normalized.entityIdField;
    if (normalized.pollIntervalMs !== null) {
      descriptors[normalized.id].pollIntervalMs = normalized.pollIntervalMs;
    }
  }
  if (descriptors.sse.advertised && !descriptors.sse.url) {
    descriptors.sse.url = `${baseUrl}/api/v1/streaming/features`;
  }
  if (descriptors.websocket.advertised && !descriptors.websocket.url) {
    const webSocketUrl = new URL(`${baseUrl}/api/v1/streaming/features`);
    webSocketUrl.protocol = webSocketUrl.protocol === "https:" ? "wss:" : "ws:";
    descriptors.websocket.url = webSocketUrl.toString();
  }
  for (const id of REALTIME_TRANSPORTS) {
    if (!descriptors[id].advertised) {
      descriptors[id].url = null;
      continue;
    }
    if (descriptors[id].url) descriptors[id].url = sanitizeTransportUrl(descriptors[id].url, baseUrl, id);
  }
  return {
    ...descriptors,
    serverVersion: textOrNull(body.serverVersion ?? body.version),
    serverRevision: immutableServerRevisionOrNull(pickImmutableRevision(body)),
  };
}

/**
 * `deploymentRevision` is the field name honua-server#3038 actually shipped on
 * both `/api/v1/streaming/features/capabilities` and
 * `/api/v1/capabilities/manifest`, alongside a `deploymentRevisionSource` of
 * `commit-sha` or `image-digest`. It leads the chain because it is the
 * reviewed contract; the remaining names stay accepted so a deployment that
 * predates that contract is still bindable rather than uncertifiable.
 */
function pickImmutableRevision(document) {
  return (
    document.deploymentRevision ??
    document.serverRevision ??
    document.gitRevision ??
    document.commitSha ??
    document.imageDigest ??
    document.revision
  );
}

function normalizeTransportId(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replaceAll("_", "-");
  if (normalized === "sse" || normalized === "server-sent-events") return "sse";
  if (normalized === "websocket" || normalized === "web-socket" || normalized === "ws") return "websocket";
  if (normalized === "odata" || normalized === "odata-delta" || normalized === "polling") return "odata";
  return undefined;
}

async function executeAdvertisedTransport(id, descriptor, options) {
  const scenario = options.baselineOnly ? "baseline-completion" : "snapshot-delta-contract";
  try {
    const observation =
      id === "sse"
        ? await executeLiveSse(descriptor.url, options)
        : id === "websocket"
          ? await executeLiveWebSocket(descriptor.url, options)
          : await executeLiveOdata(descriptor.url, descriptor, options);
    return {
      transport: {
        id,
        freshness: id === "odata" ? "poll" : "push",
        advertised: true,
        status: "executed",
        ...(options.baselineOnly
          ? {
              baselineState: {
                eventCount: observation.acceptedEventCount,
                historySha256: observation.historySha256,
                finalStateSha256: observation.finalStateSha256,
              },
            }
          : {
              acceptedState: {
                eventCount: observation.acceptedEventCount,
                historySha256: observation.historySha256,
                finalStateSha256: observation.finalStateSha256,
              },
            }),
        scenarioCounts: { total: 1, passed: 1, failed: 0 },
        scenarios: [{ id: scenario, result: "passed" }],
        diagnostics: [
          {
            code: options.baselineOnly ? "baseline-completed" : "contract-events-accepted",
            message: options.baselineOnly
              ? `Advertised transport completed a baseline with ${String(observation.acceptedEventCount)} accepted event, normalized history ${observation.historySha256}, final state ${observation.finalStateSha256}, and redacted checkpoint telemetry.`
              : `${String(observation.acceptedEventCount)} snapshot-plus-mutation contract events accepted with normalized state-transition history ${observation.historySha256}, final state ${observation.finalStateSha256}, and redacted checkpoint telemetry.`,
            scenario,
          },
        ],
      },
    };
  } catch (error) {
    const failure = classifyLiveTransportFailure(error);
    return {
      transport: {
        id,
        freshness: id === "odata" ? "poll" : "push",
        advertised: true,
        status: failure.status,
        scenarioCounts: { total: 1, passed: 0, failed: 1 },
        scenarios: [{ id: scenario, result: "failed" }],
        diagnostics: [
          {
            code: failure.code,
            message: failure.message,
            scenario,
          },
        ],
      },
    };
  }
}

function reconcileExecutedTransportStates(executions) {
  const executed = executions.filter(({ transport }) => transport.status === "executed");
  const stateOf = ({ transport }) => transport.acceptedState ?? transport.baselineState;
  if (
    executed.length <= 1 ||
    executed.every(
      (execution) =>
        stateOf(execution)?.eventCount === stateOf(executed[0])?.eventCount &&
        stateOf(execution)?.historySha256 === stateOf(executed[0])?.historySha256 &&
        stateOf(execution)?.finalStateSha256 === stateOf(executed[0])?.finalStateSha256,
    )
  ) {
    return executions.map(({ transport }) => transport);
  }
  return executions.map(({ transport }) =>
    transport.status === "executed"
      ? {
          ...transport,
          status: "failed",
          scenarioCounts: { total: 1, passed: 0, failed: 1 },
          scenarios: [{ id: "snapshot-delta-contract", result: "failed" }],
          diagnostics: [
            {
              code: "cross-transport-state-divergence",
              message: transport.baselineState
                ? "Advertised realtime transports accepted different baseline histories or normalized states."
                : "Advertised realtime transports accepted different snapshot-plus-mutation histories or normalized final states.",
              scenario: transport.baselineState ? "baseline-completion" : "snapshot-delta-contract",
            },
          ],
        }
      : transport,
  );
}

async function executeLiveSse(url, options) {
  const eventSourceFactory =
    options.eventSourceFactory ??
    ((sourceUrl) => new FetchEventSource(sourceUrl, options.fetchFn, options.headers));
  return observeLiveTransport(
    (runtime) =>
      options.sdk.createResumableServerSentEventsTransport(
        {
          url,
          ...options.sdk.honuaServerRealtimePreset(),
          eventSourceFactory,
        },
        liveResumableOptions(options, runtime),
      ),
    options,
  );
}

async function executeLiveWebSocket(url, options) {
  let webSocketFactory = options.webSocketFactory;
  if (!webSocketFactory) {
    try {
      const ws = await import("ws");
      webSocketFactory = (socketUrl, protocols) =>
        new ws.WebSocket(socketUrl, protocols ?? [], { headers: options.headers });
    } catch {
      throw new LiveSemanticError(
        "websocket-client-unavailable",
        "The scheduled Node runtime could not load its evidence-only WebSocket client.",
      );
    }
  }
  return observeLiveTransport(
    (runtime) =>
      options.sdk.createResumableWebSocketTransport(
        {
          url,
          ...options.sdk.honuaServerRealtimePreset(),
          webSocketFactory,
        },
        liveResumableOptions(options, runtime),
      ),
    options,
  );
}

async function executeLiveOdata(url, descriptor, options) {
  const idField = descriptor.entityIdField ?? "Id";
  const fetchImpl = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(options.headers)) headers.set(name, value);
    return options.fetchFn(input, { ...init, headers, redirect: "error" });
  };
  const raw = options.sdk.createOdataDeltaTransport({
    url,
    pollIntervalMs: positiveInteger(descriptor.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "OData poll interval"),
    entityId(entity) {
      const id = entity?.[idField];
      if (typeof id !== "string" && typeof id !== "number") {
        throw new LiveSemanticError("odata-entity-id-missing", `OData delta entity is missing ${idField}.`);
      }
      return id;
    },
    toFeature(entity) {
      return entity;
    },
    fetchImpl,
  });
  return observeLiveTransport(
    (runtime) =>
      options.sdk.createResumableRealtimeTransport(raw, liveResumableOptions(options, runtime)),
    options,
  );
}

function liveResumableOptions(options, runtime) {
  return {
    context: options.context,
    reconnect: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 100 },
    checkpointStore: runtime.checkpointStore,
    onTelemetry: runtime.onTelemetry,
  };
}

async function observeLiveTransport(buildTransport, options) {
  const controller = new AbortController();
  const checkpointStore = createMemoryCheckpointStore();
  const telemetry = [];
  const accepted = [];
  const dataReady = deferred();
  let completed = 0;
  let terminalError;
  const checkDataReady = () => {
    if (
      (options.baselineOnly ? accepted.some((event) => event.type === "snapshot") : hasSnapshotThenMutation(accepted)) &&
      telemetry.some((event) => event.acceptedEventCount >= accepted.length && event.checkpoint)
    ) {
      dataReady.resolve();
    }
  };
  // The mutation is driven from the observation itself rather than after a
  // sleep: a baseline in hand is proof the subscription is registered, so the
  // event it publishes cannot be missed and cannot land inside the baseline.
  let mutationDriven = false;
  const driveMutationOnce = () => {
    if (mutationDriven || !options.driveMutation) return;
    mutationDriven = true;
    void Promise.resolve()
      .then(() => options.driveMutation())
      .catch((error) => dataReady.reject(error));
  };
  const transport = await buildTransport({
    checkpointStore: checkpointStore.store,
    onTelemetry: (event) => {
      telemetry.push(event);
      checkDataReady();
    },
  });
  const observer = {
    next(event) {
      if (isDataEvent(event)) accepted.push(event);
      if (event?.type === "snapshot") {
        // Check the baseline before spending a mutation on it: a record with no
        // geometry cannot survive the delta envelope, and the named reason is
        // only recoverable while the baseline is still the failure in hand.
        try {
          assertConformanceRecordGeometry(event, options.conformanceRecord);
        } catch (error) {
          dataReady.reject(error);
          return;
        }
        driveMutationOnce();
      }
      checkDataReady();
    },
    error(error) {
      terminalError = error;
      dataReady.reject(error);
    },
    complete() {
      completed += 1;
      if (!(options.baselineOnly ? accepted.some((event) => event.type === "snapshot") : hasSnapshotThenMutation(accepted))) {
        dataReady.reject(
          new LiveSemanticError(
            "transport-completed-before-history",
            options.baselineOnly
              ? "Live transport completed before a baseline was accepted."
              : "Live transport completed before snapshot-plus-delta history was accepted.",
          ),
        );
      }
    },
  };
  const handle = transport.subscribe({ ...options.request, signal: controller.signal }, observer);
  try {
    try {
      await withTimeout(
        dataReady.promise,
        options.timeoutMs,
        options.baselineOnly
          ? "No baseline was observed within the bounded live window."
          : "No snapshot-plus-delta contract history was observed within the bounded live window.",
      );
    } catch (error) {
      if (accepted.length === 0 && isLiveAvailabilityFailure(error)) {
        if (error instanceof LiveDegradedError) throw error;
        throw new LiveDegradedError(
          "transport-unavailable",
          "Advertised realtime transport was unavailable during the bounded observation.",
        );
      }
      if (
        !(options.baselineOnly ? accepted.some((event) => event.type === "snapshot") : hasSnapshotThenMutation(accepted)) &&
        isContractHistoryMissing(error)
      ) {
        throw new LiveSemanticError(
          options.baselineOnly ? "baseline-missing" : "contract-history-missing",
          options.baselineOnly
            ? "The advertised transport produced no accepted baseline within the bounded observation."
            : "The advertised transport produced no accepted snapshot-plus-delta history within the bounded observation.",
        );
      }
      throw error;
    }
  } finally {
    controller.abort("live evidence complete");
    handle.close();
    handle.close();
    await Promise.resolve();
  }
  if (terminalError) throw terminalError;
  if (completed !== 1) {
    throw new LiveSemanticError(
      "terminal-disposal-drift",
      `Repeated live disposal completed the observer ${String(completed)} times instead of once.`,
    );
  }
  const checkpoint = checkpointStore.checkpoints.at(-1);
  const checkpointSamples = telemetry.flatMap((event) => (event.checkpoint ? [event.checkpoint] : []));
  if (!checkpoint || checkpointSamples.length === 0) {
    throw new LiveSemanticError("checkpoint-evidence-missing", "Live transport produced no durable/redacted checkpoint evidence.");
  }
  assertCheckpointTelemetryRedacted(checkpointStore.checkpoints, checkpointSamples);
  const normalizedHistory = verifyNormalizedLiveHistory(options.sdk, accepted);
  return {
    acceptedEventCount: accepted.length,
    ...normalizedHistory,
  };
}

/**
 * Prove the controlled record this run inserted is present in the transport's
 * baseline and carries a geometry.
 *
 * This is a load-bearing precondition, not a nicety. honua-server's batched
 * baseline always writes `geometry`, even when null, but its delta envelope
 * drops a null one — and the SDK's honua-server decoder rejects an
 * insert/update whose after-image has no geometry member. A conformance source
 * provisioned without geometry therefore fails every transport with an opaque
 * `invalid-event`. Naming the cause here turns an unexplained protocol failure
 * into a deployment fix.
 */
function assertConformanceRecordGeometry(snapshot, record) {
  if (!record) return;
  const features = Array.isArray(snapshot.features) ? snapshot.features : [];
  for (const patch of features) {
    const feature = isRecord(patch) ? patch.feature : undefined;
    const properties = isRecord(feature) ? feature.properties : undefined;
    if (!isRecord(properties) || properties[record.runIdField] !== record.runMarker) continue;
    if (feature.geometry === null || feature.geometry === undefined) {
      throw new LiveSemanticError(
        "conformance-record-geometry-missing",
        "The controlled-conformance record carries no geometry, so honua-server omits the member from its delta envelope and the SDK rejects the mutation after-image.",
      );
    }
    return;
  }
  throw new LiveSemanticError(
    "conformance-record-not-observed",
    "The advertised transport's baseline did not carry the controlled-conformance record this run inserted before the subscription opened.",
  );
}

function assertCheckpointTelemetryRedacted(checkpoints, checkpointSamples) {
  for (const sample of checkpointSamples) {
    const checkpoint = checkpoints.find(
      (candidate) =>
        candidate.savedAt === sample.savedAt &&
        candidate.resume.sequence === sample.resume?.sequence,
    );
    if (!checkpoint) {
      throw new LiveSemanticError(
        "checkpoint-telemetry-leak",
        "Live checkpoint telemetry could not be bound to a durable checkpoint.",
      );
    }
    for (const field of ["cursor", "watermark", "deltaToken"]) {
      const raw = checkpoint.resume[field];
      const redacted = sample.resume?.[field];
      if (raw === undefined) {
        if (redacted !== undefined) {
          throw new LiveSemanticError(
            "checkpoint-telemetry-leak",
            "Live checkpoint telemetry invented a redacted resume position.",
          );
        }
        continue;
      }
      if (typeof raw !== "string") {
        throw new LiveSemanticError(
          "checkpoint-telemetry-leak",
          "Live durable checkpoint retained an invalid resume-position type.",
        );
      }
      const expected = `sha256:${sha256(`honua-realtime-checkpoint-redaction:v1:${field}:${raw}`)}`;
      if (redacted !== expected) {
        throw new LiveSemanticError(
          "checkpoint-telemetry-leak",
          "Live checkpoint telemetry retained an invalidly hashed or raw resume position.",
        );
      }
    }
  }
}

function isLiveAvailabilityFailure(error) {
  if (error instanceof LiveDegradedError) return true;
  if (error?.code === "transport-gap" || error?.code === "cursor-expired") return true;
  return (
    error?.code === "delivery-failed" &&
    /reconnect attempts exhausted.*(?:closed unexpectedly|transport gap)/iu.test(errorMessage(error))
  );
}

function isContractHistoryMissing(error) {
  if (error instanceof LiveDegradedError) return true;
  if (error instanceof LiveSemanticError && error.code === "transport-completed-before-history") return true;
  return (
    error?.code === "delivery-failed" &&
    /snapshot-required|replacement snapshot|snapshot baseline|reconnect attempts exhausted.*closed unexpectedly/i.test(
      errorMessage(error),
    )
  );
}

function createMemoryCheckpointStore() {
  const checkpoints = [];
  return {
    checkpoints,
    store: {
      load: () => Promise.resolve(undefined),
      save(checkpoint) {
        checkpoints.push(checkpoint);
        return Promise.resolve();
      },
    },
  };
}

function liveResumeContext(sourceId) {
  return {
    kind: "honua.realtime-resume-context",
    version: 1,
    sourceId,
    queryFingerprint: "sha256:scheduled-live-realtime-conformance-v1",
    sourceVersion: "scheduled-live",
    schemaVersion: "scheduled-live-v1",
    authorizationScopeFingerprint: "sha256:scheduled-live-observer",
  };
}

function createRawSseEventByteTracker() {
  // Count the bytes as received, before TextDecoder or newline normalization.
  // The event delimiter is not part of the event body, while line endings
  // between non-empty lines are. A line ending remains pending until the next
  // byte proves whether it is an interior line ending or the start of the
  // blank-line delimiter.
  let eventBytes = 0;
  let lineHasBytes = false;
  let pendingLineEndingBytes = 0;
  let pendingCarriageReturn = false;

  const addEventBytes = (count) => {
    eventBytes += count;
    if (eventBytes > REALTIME_SSE_EVENT_MAX_BYTES) {
      throw new LiveSemanticError(
        "sse-event-too-large",
        "Advertised SSE endpoint emitted an event beyond its byte ceiling.",
      );
    }
    if (eventBytes > REALTIME_SSE_BUFFER_MAX_BYTES) {
      throw new LiveSemanticError(
        "sse-buffer-too-large",
        "Advertised SSE endpoint exceeded its pending-event buffer ceiling.",
      );
    }
  };

  const consumeContentByte = () => {
    if (pendingLineEndingBytes > 0) {
      addEventBytes(pendingLineEndingBytes);
      pendingLineEndingBytes = 0;
    }
    addEventBytes(1);
    lineHasBytes = true;
  };

  const consumeLineEnding = (byteLength) => {
    if (lineHasBytes) {
      lineHasBytes = false;
      pendingLineEndingBytes = byteLength;
      return;
    }
    // A blank line dispatches the event. Neither the final content-line
    // terminator nor the blank-line terminator belongs to the event payload.
    eventBytes = 0;
    pendingLineEndingBytes = 0;
  };

  const consumeByte = (byte) => {
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (byte === 0x0a) {
        consumeLineEnding(2);
        return;
      }
      consumeLineEnding(1);
    }
    if (byte === 0x0d) pendingCarriageReturn = true;
    else if (byte === 0x0a) consumeLineEnding(1);
    else consumeContentByte();
  };

  return {
    push(bytes) {
      for (const byte of bytes) consumeByte(byte);
    },
    finish() {
      if (!pendingCarriageReturn) return;
      pendingCarriageReturn = false;
      consumeLineEnding(1);
    },
  };
}

class FetchEventSource {
  constructor(url, fetchFn, headers) {
    this.url = url;
    this.fetchFn = fetchFn;
    this.headers = headers;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.controller = new AbortController();
    this.reader = null;
    queueMicrotask(() => void this.start());
  }

  addEventListener() {}

  removeEventListener() {}

  close() {
    this.readyState = 2;
    if (!this.controller.signal.aborted) this.controller.abort("SSE evidence source closed");
    if (this.reader) void cancelReader(this.reader);
  }

  async start() {
    let reader;
    try {
      const response = await this.fetchFn(this.url, {
        headers: { accept: "text/event-stream", ...this.headers },
        redirect: "error",
        signal: this.controller.signal,
      });
      if (!response.ok) throw new HttpStatusError(response.status);
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
        throw new LiveSemanticError("sse-media-type-mismatch", "Advertised SSE endpoint did not return text/event-stream.");
      }
      if (!response.body) throw new LiveSemanticError("sse-body-missing", "Advertised SSE endpoint returned no body.");
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      reader = response.body.getReader();
      this.reader = reader;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const rawByteTracker = createRawSseEventByteTracker();
      let buffer = "";
      let undecidedLineEnding = "";
      const emitCompleteBlocks = () => {
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (encoder.encode(block).byteLength > REALTIME_SSE_EVENT_MAX_BYTES) {
            throw new LiveSemanticError(
              "sse-event-too-large",
              "Advertised SSE endpoint emitted an event beyond its byte ceiling.",
            );
          }
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) this.onmessage?.({ data });
        }
        return blocks.length;
      };
      while (!this.controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (value) rawByteTracker.push(value);
        if (done) rawByteTracker.finish();
        undecidedLineEnding += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const trailingCarriageReturn = !done && undecidedLineEnding.endsWith("\r");
        const decided = trailingCarriageReturn ? undecidedLineEnding.slice(0, -1) : undecidedLineEnding;
        undecidedLineEnding = trailingCarriageReturn ? "\r" : "";
        buffer += decided.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        emitCompleteBlocks();
        if (done) {
          break;
        }
      }
      if (!this.controller.signal.aborted) {
        this.readyState = 2;
        this.onerror?.(new Event("error"));
      }
    } catch (error) {
      if (reader) await cancelReader(reader);
      if (this.controller.signal.aborted) return;
      this.readyState = 2;
      if (error instanceof LiveSemanticError) {
        this.onmessage?.({
          data: JSON.stringify({
            type: "error",
            terminal: true,
            code: "invalid-event",
            error: {},
          }),
        });
        return;
      }
      this.onerror?.(Object.assign(new Event("error"), { cause: error }));
    } finally {
      if (reader) {
        if (this.controller.signal.aborted) await cancelReader(reader);
        try {
          reader.releaseLock();
        } catch {
          // A released/cancelled reader has no remaining resource to clean.
        }
        if (this.reader === reader) this.reader = null;
      }
    }
  }
}

function nonExecutedTransport(id, advertised, status, code, message) {
  return {
    id,
    freshness: id === "odata" ? "poll" : "push",
    advertised,
    status,
    scenarioCounts: { total: 0, passed: 0, failed: 0 },
    scenarios: [],
    diagnostics: [{ code, message, scenario: null }],
  };
}

function assembleEvidence(options) {
  const counts = Object.fromEntries(
    ["executed", "unsupported", "degraded", "failed"].map((status) => [
      status,
      options.transports.filter((transport) => transport.status === status).length,
    ]),
  );
  const status = derivedEvidenceStatus(counts);
  return {
    format: REALTIME_CONFORMANCE_EVIDENCE_FORMAT,
    schemaVersion: 1,
    lane: options.lane,
    generatedAt: options.generatedAt,
    sdk: options.sdk,
    server: {
      version: options.server.version,
      revision: options.server.revision,
      revisionSource: options.server.revisionSource ?? null,
      capabilities: options.server.capabilities,
    },
    corpus: {
      kind: "honua.realtime-cross-transport-conformance",
      version: 1,
      sha256: sha256(options.corpusBytes),
    },
    summary: {
      status,
      transportCount: 3,
      scenarioCount: options.scenarioCount,
      executionCount: options.executionCount,
      ...counts,
    },
    ...(options.conformance === undefined ? {} : { conformance: options.conformance }),
    transports: options.transports,
  };
}

function derivedEvidenceStatus(counts) {
  if (counts.failed > 0) return "failed";
  if (counts.degraded > 0) return "degraded";
  if (counts.executed > 0) return "executed";
  return "unsupported";
}

export function validateRealtimeConformanceEvidence(evidence) {
  invariant(
    validateEvidenceSchema(evidence),
    `Realtime evidence violates ${REALTIME_CONFORMANCE_EVIDENCE_SCHEMA}: ${evidenceAjv.errorsText(
      validateEvidenceSchema.errors,
      { separator: "; " },
    )}`,
  );
  invariant(evidence?.format === REALTIME_CONFORMANCE_EVIDENCE_FORMAT, "Realtime evidence format drift.");
  invariant(evidence.schemaVersion === 1, "Realtime evidence schema version drift.");
  invariant(evidence.lane === "fixture" || evidence.lane === "live", "Realtime evidence lane is invalid.");
  invariant(!Number.isNaN(Date.parse(evidence.generatedAt)), "Realtime evidence timestamp is invalid.");
  invariant(evidence.sdk?.package === "@honua/sdk-js", "Realtime evidence package identity drift.");
  invariant(/^[a-f0-9]{40}$/u.test(evidence.sdk?.revision ?? ""), "Realtime evidence SDK revision is invalid.");
  invariant(/^[a-f0-9]{64}$/u.test(evidence.corpus?.sha256 ?? ""), "Realtime evidence corpus digest is invalid.");
  invariant(Array.isArray(evidence.transports) && evidence.transports.length === 3, "Realtime evidence needs three transports.");
  invariant(
    JSON.stringify(evidence.transports.map((transport) => transport.id)) === JSON.stringify(REALTIME_TRANSPORTS),
    "Realtime evidence transport identities/order drifted.",
  );
  const statusCounts = { executed: 0, unsupported: 0, degraded: 0, failed: 0 };
  for (const transport of evidence.transports) {
    invariant(
      evidence.server.capabilities[transport.id] === transport.advertised,
      `${transport.id} advertisement contradicts server capabilities.`,
    );
    invariant(Object.hasOwn(statusCounts, transport.status), `${transport.id} has an invalid status.`);
    statusCounts[transport.status] += 1;
    invariant(
      transport.freshness === (transport.id === "odata" ? "poll" : "push"),
      `${transport.id} freshness is untruthful.`,
    );
    invariant(
      transport.scenarioCounts.total === transport.scenarios.length,
      `${transport.id} scenario totals drifted.`,
    );
    const passed = transport.scenarios.filter((scenario) => scenario.result === "passed").length;
    const failed = transport.scenarios.filter((scenario) => scenario.result === "failed").length;
    invariant(
      transport.scenarioCounts.passed === passed && transport.scenarioCounts.failed === failed,
      `${transport.id} scenario result counts drifted.`,
    );
    invariant(
      transport.scenarioCounts.total === passed + failed,
      `${transport.id} scenario counts do not partition the total.`,
    );
    if (!transport.advertised) {
      invariant(transport.scenarios.length === 0, `${transport.id} executed scenarios without advertisement.`);
      invariant(transport.status !== "executed", `${transport.id} executed without advertisement.`);
    }
    if (transport.status === "executed") {
      invariant(transport.advertised, `${transport.id} execution lacks advertisement.`);
      invariant(
        transport.scenarios.length > 0 && failed === 0 && passed === transport.scenarios.length,
        `${transport.id} executed status contradicts its scenario results.`,
      );
      if (evidence.lane === "live") {
        const baselineOnly = transport.scenarios.every(({ id }) => id === "baseline-completion");
        const state = baselineOnly ? transport.baselineState : transport.acceptedState;
        invariant(
          baselineOnly ? transport.acceptedState === undefined : transport.baselineState === undefined,
          `${transport.id} live execution mixes baseline and full-history evidence.`,
        );
        invariant(state?.eventCount >= (baselineOnly ? 1 : 2), `${transport.id} live execution has too few events.`);
        invariant(
          /^sha256:[a-f0-9]{64}$/u.test(state?.historySha256 ?? "") &&
            /^sha256:[a-f0-9]{64}$/u.test(state?.finalStateSha256 ?? ""),
          `${transport.id} live execution lacks a bounded state fingerprint.`,
        );
      }
    } else if (transport.status === "unsupported") {
      invariant(
        !transport.advertised && transport.scenarios.length === 0,
        `${transport.id} unsupported status contradicts advertisement or execution.`,
      );
    } else if (transport.scenarios.length > 0) {
      invariant(
        transport.advertised && failed > 0,
        `${transport.id} ${transport.status} status contradicts its scenario results.`,
      );
    }
    if (transport.status !== "executed") {
      invariant(transport.diagnostics.length > 0, `${transport.id} non-execution lacks diagnostics.`);
    }
    if (evidence.lane === "fixture") {
      invariant(transport.acceptedState === undefined, `${transport.id} fixture evidence invented a live state.`);
    }
  }
  for (const [status, count] of Object.entries(statusCounts)) {
    invariant(evidence.summary[status] === count, `Realtime evidence ${status} count drifted.`);
  }
  invariant(
    evidence.summary.status === derivedEvidenceStatus(statusCounts),
    "Realtime evidence summary status contradicts transport outcomes.",
  );
  if (statusCounts.executed > 0) {
    invariant(
      immutableServerRevisionOrNull(evidence.server?.revision) !== null,
      "Executed realtime evidence requires an immutable server revision.",
    );
    invariant(
      evidence.server?.revisionSource !== null && evidence.server?.revisionSource !== undefined,
      "Executed realtime evidence requires the document that bound its server revision.",
    );
  }
  // A revision and its provenance stand or fall together: naming a source
  // without a revision, or a revision no document accounted for, would let a
  // reader believe the deployment binding was checked when it was not.
  invariant(
    (evidence.server?.revision === null) === (evidence.server?.revisionSource === null),
    "Realtime evidence server revision and revision source disagree.",
  );
  invariant(
    !(evidence.server?.revisionSource === "fixture" && evidence.lane !== "fixture"),
    "Live realtime evidence claimed a fixture revision source.",
  );
  if (evidence.lane === "live") {
    const executedStates = evidence.transports.filter((transport) => transport.status === "executed").map((transport) => {
      const state = transport.acceptedState ?? transport.baselineState;
      return `${String(state.eventCount)}:${state.historySha256}:${state.finalStateSha256}`;
    });
    invariant(
      new Set(executedStates).size <= 1,
      "Executed realtime transports accepted divergent histories or final states.",
    );
  }
  validateConformanceRun(evidence);
  const scenarioIds = new Set(evidence.transports.flatMap((transport) => transport.scenarios.map((scenario) => scenario.id)));
  const executionCount = evidence.transports.reduce(
    (total, transport) => total + transport.scenarioCounts.total,
    0,
  );
  invariant(evidence.summary.scenarioCount === scenarioIds.size, "Realtime evidence scenario count drifted.");
  invariant(evidence.summary.executionCount === executionCount, "Realtime evidence execution count drifted.");
  const serialized = JSON.stringify(evidence);
  invariant(!/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/u.test(serialized), "Realtime evidence retained a bearer token.");
  invariant(
    !/"(?:cursor|watermark|deltaToken)"\s*:/u.test(serialized),
    "Realtime evidence retained a raw resume-position field.",
  );
  // The per-run ownership token is a credential. It is issued once, is held
  // only in the run client's closure, and must never reach a retained
  // document — screened here as well as structurally, because a screening that
  // depends solely on nobody making a mistake is not a screening.
  invariant(
    !/"runToken"\s*:/u.test(serialized) && !/x-honua-conformance-run-token/iu.test(serialized),
    "Realtime evidence retained a controlled-conformance run token.",
  );
  return evidence;
}

/**
 * Enforce the controlled-conformance block's own truthfulness: an executed run
 * must name the run it drove, must have applied the shared insert and at least
 * one per-transport `touch`, and must have reversed the source's baseline
 * digest. Anything else must carry a named refusal reason.
 */
function validateConformanceRun(evidence) {
  const conformance = evidence.conformance;
  if (evidence.lane === "fixture") {
    invariant(conformance === undefined, "Fixture realtime evidence invented a controlled-conformance run.");
    return;
  }
  invariant(isRecord(conformance), "Live realtime evidence must report a controlled-conformance outcome.");
  invariant(
    ["executed", "skipped", "degraded", "failed"].includes(conformance.status),
    "Controlled-conformance status is invalid.",
  );
  if (conformance.status === "executed") {
    invariant(conformance.reason === null, "An executed controlled-conformance run cannot carry a refusal reason.");
    invariant(
      typeof conformance.runId === "string" && conformance.runId.length > 0,
      "An executed controlled-conformance run must name its run id.",
    );
    invariant(
      immutableServerRevisionOrNull(conformance.deploymentRevision) !== null,
      "An executed controlled-conformance run must be bound to an immutable deployment revision.",
    );
    invariant(
      conformance.mutations?.insert === 1 && conformance.mutations.touch >= 1,
      "An executed controlled-conformance run must apply one shared insert and at least one per-transport touch.",
    );
    invariant(
      isRecord(conformance.baseline) &&
        conformance.baseline.digestVerified === true &&
        conformance.baseline.leaseDigest === conformance.baseline.cleanupDigest,
      "An executed controlled-conformance run must reverse the source's baseline digest.",
    );
    return;
  }
  invariant(
    isRecord(conformance.reason) &&
      typeof conformance.reason.code === "string" &&
      conformance.reason.code.length > 0 &&
      typeof conformance.reason.message === "string" &&
      conformance.reason.message.length > 0,
    `A ${conformance.status} controlled-conformance run must record why it did not execute.`,
  );
  invariant(
    conformance.mutations?.insert === 0 || conformance.status === "failed",
    "A skipped or degraded controlled-conformance run cannot report applied mutations.",
  );
}

export function summarizeRealtimeConformanceEvidence(evidence) {
  validateRealtimeConformanceEvidence(evidence);
  const conformance = evidence.conformance;
  return [
    `lane=${evidence.lane} status=${evidence.summary.status} revision=${evidence.sdk.revision}`,
    `server: version=${evidence.server.version ?? "unknown"} revision=${
      evidence.server.revision ?? "unbound"
    } (${evidence.server.revisionSource ?? "no source"})`,
    ...(conformance
      ? [
          `controlled-run: ${conformance.status}${
            conformance.reason ? ` (${conformance.reason.code}: ${conformance.reason.message})` : ""
          }${
            conformance.status === "executed"
              ? ` runId=${conformance.runId} insert=${String(conformance.mutations.insert)} touch=${String(
                  conformance.mutations.touch,
                )} baseline-restored=${String(conformance.baseline.digestVerified)}`
              : ""
          }`,
        ]
      : []),
    ...evidence.transports.map(
      (transport) =>
        `${transport.id}: ${transport.status} (${String(transport.scenarioCounts.passed)}/${String(
          transport.scenarioCounts.total,
        )} scenarios, freshness=${transport.freshness})${
          transport.diagnostics[0]
            ? ` — ${transport.diagnostics[0].code}: ${transport.diagnostics[0].message}`
            : ""
        }`,
    ),
  ];
}

function sanitizeBaseUrl(value) {
  const url = new URL(value);
  invariant(url.protocol === "https:" || isLoopback(url), "Live realtime base URL must use HTTPS.");
  invariant(!url.username && !url.password && !url.search && !url.hash, "Live realtime base URL cannot carry secrets.");
  return url.toString().replace(/\/$/u, "");
}

function sanitizeTransportUrl(value, baseUrl, id) {
  const url = new URL(value, `${baseUrl}/`);
  const base = new URL(baseUrl);
  invariant(sameServerAuthority(url, base), `${id} capability URL must remain on the reviewed server origin.`);
  invariant(!url.username && !url.password && !url.hash, `${id} capability URL cannot carry credentials.`);
  if (id === "websocket") {
    invariant(
      url.protocol === "wss:" || (isLoopbackHost(base) && url.protocol === "ws:"),
      "WebSocket capability must use WSS.",
    );
  } else {
    invariant(url.protocol === "https:" || isLoopback(url), `${id} capability URL must use HTTPS.`);
  }
  return url.toString();
}

function isLoopback(url) {
  return (
    url.protocol === "http:" &&
    isLoopbackHost(url)
  );
}

function isLoopbackHost(url) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function sameServerAuthority(transportUrl, baseUrl) {
  if (transportUrl.hostname !== baseUrl.hostname) return false;
  const transportPort =
    transportUrl.port || (transportUrl.protocol === "https:" || transportUrl.protocol === "wss:" ? "443" : "80");
  const basePort = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
  return transportPort === basePort;
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer.`);
  return value;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function immutableServerRevisionOrNull(value) {
  if (value === undefined || value === null) return null;
  // A blank string is an unset input, not a malformed revision. Rejecting it
  // here is what took the whole scheduled lane down before any evidence was
  // written; a server that publishes `""` is likewise revision-less rather
  // than in violation, and still fails closed via `server-revision-missing`.
  if (typeof value === "string" && value.trim().length === 0) return null;
  invariant(typeof value === "string", "Realtime server revision must be a string when provided.");
  const revision = value.trim();
  invariant(
    IMMUTABLE_SERVER_REVISION.test(revision),
    "Realtime server revision must be a full commit SHA or sha256 image digest.",
  );
  return revision;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isDataEvent(event) {
  return ["snapshot", "upsert", "delete", "delta"].includes(event?.type);
}

function hasSnapshotThenMutation(events) {
  let snapshotAccepted = false;
  for (const event of events) {
    if (event.type === "snapshot") {
      snapshotAccepted = true;
      continue;
    }
    if (snapshotAccepted && eventCarriesMutation(event)) return true;
  }
  return false;
}

function eventCarriesMutation(event) {
  if (event.type === "upsert" || event.type === "delete") return true;
  return event.type === "delta" && ((event.upserts?.length ?? 0) > 0 || (event.deletes?.length ?? 0) > 0);
}

function verifyNormalizedLiveHistory(sdk, events) {
  if (events.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxEvents) {
    throw liveSemanticBoundaryError();
  }
  let reduced = sdk.emptyRealtimeFeatureState();
  let independent = { records: new Map(), tombstones: new Map() };
  const eventBudget = createLiveSemanticBudget();
  const history = createHash("sha256");
  let historyBytes = 0;
  for (const [index, event] of events.entries()) {
    const semanticEvent = normalizeLiveSemanticEvent(event, eventBudget);
    reduced = sdk.reduceRealtimeFeatureState(reduced, event);
    const actual = normalizedLiveFeatureState(reduced, createLiveSemanticBudget());
    independent = reduceNormalizedLiveEvent(independent, semanticEvent);
    const expected = normalizedIndependentLiveState(independent);
    const actualJson = canonicalJson(actual);
    const expectedJson = canonicalJson(expected);
    if (actualJson !== expectedJson) {
      throw new LiveSemanticError(
        "normalized-final-state-mismatch",
        "Accepted live history did not reconcile at every independently normalized state transition.",
      );
    }
    const transition = canonicalJson({
      ordinal: index,
      event: semanticEvent,
      state: actual,
    });
    historyBytes += Buffer.byteLength(transition, "utf8");
    if (historyBytes > REALTIME_LIVE_SEMANTIC_LIMITS.maxHistoryBytes) {
      throw liveSemanticBoundaryError();
    }
    history.update(`${String(Buffer.byteLength(transition, "utf8"))}:`);
    history.update(transition);
  }
  const finalState = normalizedIndependentLiveState(independent);
  invariant(finalState !== undefined, "Accepted live history cannot be empty.");
  return {
    historySha256: `sha256:${history.digest("hex")}`,
    finalStateSha256: `sha256:${sha256(canonicalJson(finalState))}`,
  };
}

function normalizedLiveFeatureState(state, budget) {
  const records = new Map();
  for (const record of Object.values(state.records)) {
    const normalized = normalizeLiveSemanticUpsert(record, budget);
    addUniqueLiveSemanticIdentity(records, normalized.id, normalized);
  }
  const tombstones = new Map();
  for (const tombstone of Object.values(state.tombstones)) {
    const normalized = normalizeLiveSemanticDelete(tombstone, budget);
    addUniqueLiveSemanticIdentity(tombstones, normalized.id, normalized);
  }
  if (
    records.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords ||
    tombstones.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords
  ) {
    throw liveSemanticBoundaryError();
  }
  return {
    records: [...records.entries()].sort(([left], [right]) => left.localeCompare(right)),
    tombstones: [...tombstones.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
}

function normalizeLiveSemanticEvent(event, budget) {
  if (!isRecord(event)) throw liveSemanticBoundaryError();
  const upserts =
    event.type === "snapshot"
      ? normalizeLiveSemanticPatchList(event.features, normalizeLiveSemanticUpsert, budget)
      : event.type === "upsert"
        ? [normalizeLiveSemanticUpsert(event.feature, budget)]
        : event.type === "delta"
          ? normalizeLiveSemanticPatchList(event.upserts ?? [], normalizeLiveSemanticUpsert, budget)
          : [];
  const deletes =
    event.type === "delete"
      ? [normalizeLiveSemanticDelete(event, budget)]
      : event.type === "delta"
        ? normalizeLiveSemanticPatchList(event.deletes ?? [], normalizeLiveSemanticDelete, budget)
        : [];
  if (!["snapshot", "upsert", "delete", "delta"].includes(event.type)) throw liveSemanticBoundaryError();
  const identities = new Set();
  for (const patch of [...upserts, ...deletes]) {
    if (identities.has(patch.id)) throw liveSemanticBoundaryError();
    identities.add(patch.id);
  }
  return {
    kind: event.type === "snapshot" ? "snapshot" : "mutation",
    ...(event.type === "snapshot" ? { replace: event.replace !== false } : {}),
    upserts: upserts.sort((left, right) => left.id.localeCompare(right.id)),
    deletes: deletes.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function normalizeLiveSemanticPatchList(value, normalize, budget) {
  if (!Array.isArray(value) || value.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxFeaturesPerEvent) {
    throw liveSemanticBoundaryError();
  }
  return value.map((patch) => normalize(patch, budget));
}

function normalizeLiveSemanticUpsert(patch, budget) {
  if (!isRecord(patch) || !Object.hasOwn(patch, "feature")) throw liveSemanticBoundaryError();
  const id = normalizeLiveSemanticFeatureId(patch.id);
  return {
    id,
    feature: normalizeLiveSemanticFeature(patch.feature, id, budget),
  };
}

function normalizeLiveSemanticDelete(patch, budget) {
  if (!isRecord(patch)) throw liveSemanticBoundaryError();
  return {
    id: normalizeLiveSemanticFeatureId(patch.id),
  };
}

function normalizeLiveSemanticFeature(feature, patchId, budget) {
  if (!isRecord(feature) || Array.isArray(feature)) throw liveSemanticBoundaryError();
  if (feature.type === "Feature") {
    if (!Object.hasOwn(feature, "geometry") || !Object.hasOwn(feature, "properties")) {
      throw liveSemanticBoundaryError();
    }
    if (Object.hasOwn(feature, "id") && normalizeLiveSemanticFeatureId(feature.id) !== patchId) {
      throw liveSemanticBoundaryError();
    }
    const properties = feature.properties === null ? {} : feature.properties;
    if (!isRecord(properties) || Array.isArray(properties)) throw liveSemanticBoundaryError();
    const metadata = Object.fromEntries(
      Object.entries(feature).filter(([key]) => !["type", "id", "geometry", "properties"].includes(key)),
    );
    return {
      geometry: normalizeLiveSemanticGeometry(feature.geometry, budget),
      properties: boundedLiveSemanticJson(properties, budget, 0),
      metadata: boundedLiveSemanticJson(metadata, budget, 0),
    };
  }
  const geometryEntries = Object.entries(feature).filter(([key]) => key.toLowerCase() === "geometry");
  if (geometryEntries.length > 1) throw liveSemanticBoundaryError();
  const geometryKey = geometryEntries[0]?.[0];
  const properties = Object.fromEntries(
    Object.entries(feature).filter(
      ([key]) =>
        key !== geometryKey &&
        key !== "@removed" &&
        key !== "@odata.removed" &&
        !key.toLowerCase().startsWith("@odata."),
    ),
  );
  return {
    geometry: normalizeLiveSemanticGeometry(geometryKey === undefined ? null : feature[geometryKey], budget),
    properties: boundedLiveSemanticJson(properties, budget, 0),
    metadata: {},
  };
}

function normalizeLiveSemanticGeometry(value, budget) {
  if (value !== null && (!isRecord(value) || Array.isArray(value))) throw liveSemanticBoundaryError();
  const normalized = boundedLiveSemanticJson(value, budget, 0);
  if (normalized !== null) assertLiveSemanticGeometry(normalized, budget);
  return normalized;
}

function assertLiveSemanticGeometry(value, budget) {
  if (!isRecord(value) || Array.isArray(value) || typeof value.type !== "string") {
    throw liveSemanticBoundaryError();
  }
  switch (value.type) {
    case "Point":
      assertLiveSemanticPosition(value.coordinates, budget);
      return;
    case "MultiPoint":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticPosition, 1);
      return;
    case "LineString":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticPosition, 2);
      return;
    case "MultiLineString":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticLineString, 1);
      return;
    case "Polygon":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticLinearRing, 1);
      return;
    case "MultiPolygon":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticPolygon, 1);
      return;
    case "GeometryCollection":
      if (Object.hasOwn(value, "coordinates")) throw liveSemanticBoundaryError();
      assertLiveSemanticCoordinateList(value.geometries, budget, assertLiveSemanticGeometry, 0);
      return;
    default:
      throw liveSemanticBoundaryError();
  }
}

function assertLiveSemanticLineString(value, budget) {
  assertLiveSemanticCoordinateList(value, budget, assertLiveSemanticPosition, 2);
}

function assertLiveSemanticLinearRing(value, budget) {
  assertLiveSemanticCoordinateList(value, budget, assertLiveSemanticPosition, 4);
  if (!sameLiveSemanticPosition(value[0], value.at(-1))) throw liveSemanticBoundaryError();
}

function assertLiveSemanticPolygon(value, budget) {
  assertLiveSemanticCoordinateList(value, budget, assertLiveSemanticLinearRing, 1);
}

function assertLiveSemanticCoordinateList(value, budget, validate, minimumLength) {
  if (!Array.isArray(value) || value.length < minimumLength) throw liveSemanticBoundaryError();
  for (const entry of value) validate(entry, budget);
}

function assertLiveSemanticPosition(value, budget) {
  if (!Array.isArray(value) || value.length < 2 || !value.every((entry) => typeof entry === "number")) {
    throw liveSemanticBoundaryError();
  }
  budget.geometryPositions += 1;
  if (budget.geometryPositions > REALTIME_LIVE_SEMANTIC_LIMITS.maxGeometryPositions) {
    throw liveSemanticBoundaryError();
  }
}

function sameLiveSemanticPosition(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((entry, index) => Object.is(entry, right[index]))
  );
}

function normalizeLiveSemanticFeatureId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return `integer:${String(value)}`;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1_024) {
    throw liveSemanticBoundaryError();
  }
  if (/^(?:0|-?[1-9][0-9]*)$/u.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && String(numeric) === value) return `integer:${value}`;
  }
  return `string:${value}`;
}

function createLiveSemanticBudget() {
  return { nodes: 0, geometryPositions: 0 };
}

function boundedLiveSemanticJson(value, budget, depth) {
  budget.nodes += 1;
  if (budget.nodes > REALTIME_LIVE_SEMANTIC_LIMITS.maxNodes || depth > REALTIME_LIVE_SEMANTIC_LIMITS.maxDepth) {
    throw liveSemanticBoundaryError();
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw liveSemanticBoundaryError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > REALTIME_LIVE_SEMANTIC_LIMITS.maxStringBytes) {
      throw liveSemanticBoundaryError();
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxArrayItems) throw liveSemanticBoundaryError();
    return value.map((entry) => boundedLiveSemanticJson(entry, budget, depth + 1));
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw liveSemanticBoundaryError();
  const keys = Object.keys(value);
  if (keys.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxObjectKeys) throw liveSemanticBoundaryError();
  return Object.fromEntries(
    keys
      .sort()
      .map((key) => [
        boundedLiveSemanticJson(key, budget, depth + 1),
        boundedLiveSemanticJson(value[key], budget, depth + 1),
      ]),
  );
}

function reduceNormalizedLiveEvent(state, event) {
  const records = new Map(state.records);
  const tombstones = new Map(state.tombstones);
  if (event.kind === "snapshot" && event.replace) {
    records.clear();
    tombstones.clear();
  }
  for (const patch of event.upserts) {
    records.set(patch.id, patch);
    tombstones.delete(patch.id);
  }
  for (const patch of event.deletes) {
    records.delete(patch.id);
    tombstones.set(patch.id, patch);
  }
  if (
    records.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords ||
    tombstones.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords
  ) {
    throw liveSemanticBoundaryError();
  }
  return { records, tombstones };
}

function normalizedIndependentLiveState(state) {
  return {
    records: [...state.records.entries()].sort(([left], [right]) => left.localeCompare(right)),
    tombstones: [...state.tombstones.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
}

function addUniqueLiveSemanticIdentity(target, id, value) {
  if (target.has(id)) throw liveSemanticBoundaryError();
  target.set(id, value);
}

function liveSemanticBoundaryError() {
  return new LiveSemanticError(
    "semantic-normalization-invalid",
    "Accepted live data exceeded or violated the bounded transport-neutral semantic feature contract.",
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LiveDegradedError("observation-timeout", message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseArgs(argv) {
  const options = {
    lane: "fixture",
    output: "test-results/realtime-conformance-evidence.json",
    strict: false,
    allowDegraded: false,
    baselineOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--lane") options.lane = argv[++index] ?? "";
    else if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--allow-degraded") options.allowDegraded = true;
    else if (argument === "--baseline-only") options.baselineOnly = true;
    else throw new Error(`Unknown realtime conformance argument: ${argument}`);
  }
  invariant(options.lane === "fixture" || options.lane === "live", "--lane must be fixture or live.");
  invariant(options.output.length > 0, "--output must not be empty.");
  return options;
}

function safeOutputPath(value) {
  const output = path.resolve(PROJECT_ROOT, value);
  invariant(output.startsWith(`${PROJECT_ROOT}${path.sep}`), "Realtime evidence output must stay inside the repository.");
  return output;
}

/**
 * A collector that throws used to exit with a stderr line and nothing else, so
 * the one lane whose whole purpose is retained machine-readable proof retained
 * nothing at all on its worst day. A crash is itself a conformance result:
 * classify all three transports `failed` with the collector diagnostic and
 * write the document, so an operator reads the reason out of the artifact
 * rather than out of expiring workflow logs.
 */
export function collectorFailureRealtimeConformanceEvidence(lane, error, options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const message = `Realtime conformance collector failed before it could classify any transport: ${errorMessage(error)}`;
  return validateRealtimeConformanceEvidence(
    assembleEvidence({
      lane,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      sdk: {
        ...packageIdentity(projectRoot),
        // The revision reader can be the thing that threw; a zeroed revision
        // keeps the document schema-valid while remaining obviously not a
        // real commit, and `failed` prevents it being read as certification.
        revision: safeSdkRevision(options.env ?? process.env, projectRoot),
      },
      server: {
        version: null,
        revision: null,
        revisionSource: null,
        capabilities: { sse: false, websocket: false, odata: false },
      },
      corpusBytes: safeCorpusBytes(projectRoot),
      scenarioCount: 0,
      executionCount: 0,
      transports: REALTIME_TRANSPORTS.map((id) =>
        nonExecutedTransport(id, false, "failed", "collector-failed", message),
      ),
      conformance: conformanceNotAttempted("collector-failed", message),
    }),
  );
}

function safeSdkRevision(env, projectRoot) {
  try {
    return realtimeSourceRevision(normalizeLiveEnv(env), projectRoot);
  } catch {
    return "0".repeat(40);
  }
}

function safeCorpusBytes(projectRoot) {
  try {
    return readProjectBytes(CORPUS_PATH, projectRoot);
  } catch {
    return new Uint8Array(0);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let evidence;
  let collectorFailed = false;
  try {
    evidence =
      options.lane === "fixture"
        ? await collectFixtureRealtimeConformanceEvidence()
        : await collectLiveRealtimeConformanceEvidence({ baselineOnly: options.baselineOnly });
  } catch (error) {
    collectorFailed = true;
    process.stderr.write(`Realtime conformance evidence failed: ${errorMessage(error)}\n`);
    evidence = collectorFailureRealtimeConformanceEvidence(options.lane, error);
  }
  const output = safeOutputPath(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  for (const line of summarizeRealtimeConformanceEvidence(evidence)) process.stdout.write(`${line}\n`);
  // A collector failure is non-negotiable: `--allow-degraded` may forgive an
  // unreachable server, but never a lane that could not run.
  if (collectorFailed) {
    process.exitCode = 1;
    return;
  }
  if (!options.strict) return;
  if (evidence.summary.status === "failed") process.exitCode = 1;
  else if (evidence.summary.status === "degraded" && !options.allowDegraded) process.exitCode = 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // Reached only if evidence retention itself fails (unwritable output).
    process.stderr.write(`Realtime conformance evidence could not be retained: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
