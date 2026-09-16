#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const OGC_PROCESSES_QUALIFICATION_FORMAT = "honua.sdk.ogc-processes-candidate-qualification.v1";
const PROCESS_ID = "geometry.buffer";
const FIXTURE = Object.freeze({
  id: "geometry-buffer-point-4326-v1",
  inputs: {
    wkb: "AQEAAABQ/Bhz15pewNDVVuwv40JA",
    srid: 4326,
    distance: 0.00025,
    geodesic: false,
  },
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireValue(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

export function qualificationEnabled(env = process.env) {
  return env.HONUA_OGC_PROCESSES_QUALIFICATION_ENABLED === "true";
}

export function assertCandidateEvidenceRedacted(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["x-api-key", "authorization", "bearer ", "quickstart-admin-password"]) {
    if (serialized.includes(forbidden)) throw new Error(`qualification evidence contains forbidden credential material: ${forbidden}`);
  }
}

/**
 * Structural, credential-free projection of a thrown error.
 *
 * `HonuaHttpError` carries the transport code on `statusCode`, while
 * `HonuaJobFailedError` carries a `JobStatus` *string* on `status`. Reading only
 * a numeric `status` recorded `null` for both, which is exactly the evidence a
 * reader needs to tell a governed validation rejection from an auth failure.
 * Never records `message`, which can quote request material.
 */
function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    statusCode: typeof error?.statusCode === "number" ? error.statusCode : null,
    jobStatus: typeof error?.status === "string" ? error.status : null,
    errorCode: typeof error?.errorCode === "string" ? error.errorCode : null,
  };
}

/** HTTP codes that mean "the server read the request and refused it as invalid". */
const GOVERNED_INPUT_REJECTION_STATUS_CODES = Object.freeze([400, 422]);

/**
 * Decide whether a thrown error is the *intended* governed-input rejection.
 *
 * Only two shapes prove the candidate validated the malformed WKB:
 *
 * - `HonuaHttpError` with a 400/422 — the server parsed the request and refused
 *   it synchronously; and
 * - `HonuaJobFailedError` whose terminal `status` is `failed` — the server
 *   accepted the job and failed it on the input.
 *
 * Everything else means the execution failed for an unrelated reason and the
 * candidate never demonstrated validation: a local
 * `HonuaCapabilityNotSupportedError` raised before any request, a 401/403 that
 * proves only that the credential is wrong, a 5xx that is a defect rather than
 * a refusal, a `HonuaJobPollTimeoutError` that never observed a terminal, or a
 * transport timeout. Accepting those would let the lane emit `result: "passed"`
 * for a candidate that never validated anything, so they are refused.
 */
export function classifyGovernedInputRejection(error) {
  const projection = safeError(error);
  if (projection.name === "HonuaHttpError" && GOVERNED_INPUT_REJECTION_STATUS_CODES.includes(projection.statusCode)) {
    return { accepted: true, kind: "request-rejected", error: projection };
  }
  if (projection.name === "HonuaJobFailedError" && projection.jobStatus === "failed") {
    return { accepted: true, kind: "job-failed", error: projection };
  }
  return { accepted: false, kind: "unrelated-failure", error: projection };
}

/**
 * Audit every `Prefer` header the SDK sent. Core defines only
 * `respond-async`; the non-standard `respond-sync` token (#1390) must never
 * reach the wire, and no other preference may be invented either.
 */
export function auditPreferHeaders(requests) {
  const values = [...new Set(requests.map((entry) => entry.prefer).filter((value) => value !== null && value !== undefined))];
  for (const value of values) {
    if (/respond-sync/i.test(value)) throw new Error(`the SDK sent the non-standard Prefer: ${value}`);
    if (value.trim().toLowerCase() !== "respond-async") throw new Error(`the SDK sent an unexpected Prefer: ${value}`);
  }
  return { preferValues: values, respondSyncSent: false };
}

const JOB_STATUS_RANK = Object.freeze({ accepted: 0, running: 1, successful: 2, failed: 2, dismissed: 2 });

/**
 * Collapse the job statuses the server reported, in order, and refuse an
 * illegal lifecycle: an unknown status, a regression (running -> accepted), or
 * any change after a terminal status was observed.
 */
export function assertLegalJobTransitions(statuses) {
  const collapsed = [];
  for (const status of statuses) {
    if (!(status in JOB_STATUS_RANK)) throw new Error(`the candidate reported an unknown job status: ${status}`);
    const previous = collapsed.at(-1);
    if (previous === status) continue;
    if (previous !== undefined) {
      if (JOB_STATUS_RANK[previous] === 2) throw new Error(`job status changed after terminal ${previous}: ${status}`);
      if (JOB_STATUS_RANK[status] < JOB_STATUS_RANK[previous]) throw new Error(`job status regressed: ${previous} -> ${status}`);
    }
    collapsed.push(status);
  }
  if (collapsed.length === 0) throw new Error("no job status was observed");
  return collapsed;
}

/** Decode the fixture's little/big-endian 2D WKB point. */
export function decodeWkbPoint(base64) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== 21) throw new Error(`fixture WKB is not a 2D point (${bytes.length} bytes)`);
  const little = bytes[0] === 1;
  const type = little ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
  if (type !== 1) throw new Error(`fixture WKB geometry type ${type} is not Point`);
  return little ? [bytes.readDoubleLE(5), bytes.readDoubleLE(13)] : [bytes.readDoubleBE(5), bytes.readDoubleBE(13)];
}

/**
 * Independent oracle over a buffer result: the output must be a GeoJSON
 * polygon whose every vertex sits at the requested planar distance from the
 * input point. A presence-only check would accept any non-empty output.
 */
export function assertBufferResult(output, { center, distance, tolerance = 0.02 }) {
  let value = output;
  if (value && typeof value === "object" && !("type" in value) && "value" in value) value = value.value;
  if (value?.type === "FeatureCollection") {
    if (value.features?.length !== 1) throw new Error(`buffer result carries ${value.features?.length ?? 0} features, expected 1`);
    value = value.features[0];
  }
  const geometry = value?.type === "Feature" ? value.geometry : value;
  if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") {
    throw new Error(`buffer result geometry is ${geometry?.type ?? "missing"}, expected Polygon`);
  }
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  const vertices = rings.flat();
  if (vertices.length < 4) throw new Error("buffer result polygon has fewer than four vertices");
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const [x, y] of vertices) {
    const radius = Math.hypot(x - center[0], y - center[1]);
    min = Math.min(min, radius);
    max = Math.max(max, radius);
  }
  if (Math.abs(min - distance) > distance * tolerance || Math.abs(max - distance) > distance * tolerance) {
    throw new Error(`buffer result vertices lie ${min}..${max} from the input point, expected ${distance}`);
  }
  return { geometryType: geometry.type, vertexCount: vertices.length, minRadius: min, maxRadius: max, expectedRadius: distance };
}

/**
 * Run one execution the SDK must refuse before the named request is issued.
 * `forbidden(request)` names the requests that would prove the gate leaked;
 * with no predicate the refusal must be issued with zero requests at all.
 */
async function expectLocalRefusal(requests, attempt, forbidden) {
  const start = requests.length;
  try {
    await attempt();
  } catch (error) {
    if (error?.name !== "HonuaCapabilityNotSupportedError") throw error;
    const issued = requests.slice(start);
    const leaked = forbidden ? issued.filter(forbidden) : issued;
    if (leaked.length > 0) {
      throw new Error(`capability refusal leaked ${leaked.map((entry) => `${entry.method} ${entry.path}`).join(", ")}`);
    }
    return {
      outcome: "refused-locally",
      capability: error.capability ?? null,
      construct: error.context?.construct ?? null,
      missingClass: error.context?.missingClass ?? null,
      requests: issued.map(({ method, path, status }) => ({ method, path, status })),
    };
  }
  throw new Error("an undeclared execution mode was not refused");
}

const isPost = (entry) => entry.method === "POST";

/**
 * Exercise the candidate's declared cancellation behaviour on a job of its own.
 *
 * Declared `dismiss`: the DELETE must actually take, and the dismissed job must
 * then refuse to yield results. A job that reached its own terminal before the
 * DELETE landed is a real race the client is documented to resolve in the
 * server's favour, so it is recorded as `terminal-race` and never reported as a
 * dismissal proof.
 *
 * Undeclared `dismiss`: `cancel()` must refuse locally, before any DELETE. This
 * has to run on a live job -- `IJobRun.cancel()` short-circuits on an
 * already-terminal run and would return its status without ever reaching the
 * capability check, turning the negative into a silent no-op.
 */
async function probeCancellation(processes, modes, requests) {
  const run = await processes.execute({
    processId: PROCESS_ID,
    mode: "async",
    inputs: FIXTURE.inputs,
    jobControlOptions: modes,
  });
  if (!modes.includes("dismiss")) {
    const refusal = await expectLocalRefusal(requests, () => run.cancel(), (entry) => entry.method === "DELETE");
    return { declared: false, outcome: "refused", status: "unsupported", refusal, deleteIssued: false };
  }
  const status = await run.cancel();
  if (status !== "dismissed") {
    return { declared: true, outcome: "terminal-race", status, resultsRejected: null };
  }
  try {
    await run.results();
  } catch (error) {
    if (error?.name !== "HonuaJobFailedError" || error?.status !== "dismissed") throw error;
    return { declared: true, outcome: "dismissed", status, resultsRejected: true, error: safeError(error) };
  }
  throw new Error("a dismissed job returned results");
}

const JOB_STATUS_PATH = /\/jobs\/[^/]+$/;

/**
 * Prove every execution gate against the candidate's own declarations.
 *
 * `live` probes use only what the candidate advertised: a process whose
 * description declares no `sync-execute` must refuse a synchronous request,
 * both on a handle that has already read the declaration and under
 * `capabilityPolicy: "strict"`, which reads conformance and the description
 * itself and must still send no execution. `derived` probes remove one
 * construct from the candidate's real declaration (the Core class, or the
 * `async-execute` option) to prove the other gates are wired; they are labelled
 * so that no reader mistakes them for something the candidate withheld.
 */
async function probeExecutionGates({ client, freshClient, processes, listing, conformance, modes, requests }) {
  const gates = [];
  const asyncOnly = listing.processes.find(
    (entry) => entry.jobControlOptions?.includes("async-execute") && !entry.jobControlOptions.includes("sync-execute"),
  );
  if (asyncOnly) {
    const description = await processes.describe(asyncOnly.id);
    const declared = [...(description.jobControlOptions ?? [])];
    if (declared.includes("sync-execute")) throw new Error(`${asyncOnly.id} summary and description disagree on sync-execute`);
    gates.push({
      id: "sync-execute-undeclared",
      declaration: "live",
      processId: asyncOnly.id,
      jobControlOptions: declared,
      ...(await expectLocalRefusal(requests, () => processes.execute({ processId: asyncOnly.id, mode: "sync", inputs: {} }))),
    });
    // A fresh client: the shared one caches metadata, and strict must be seen reading
    // the conformance declaration and the description for itself.
    const strict = freshClient().ogcProcesses({ capabilityPolicy: "strict", pollBudget: { pollIntervalMs: 250, deadlineMs: 120_000 } });
    const strictRefusal = await expectLocalRefusal(requests, () => strict.execute({ processId: asyncOnly.id, mode: "sync", inputs: {} }), isPost);
    for (const suffix of ["/conformance", `/processes/${asyncOnly.id}`]) {
      if (!strictRefusal.requests.some((entry) => entry.method === "GET" && entry.path.endsWith(suffix) && entry.status === 200)) {
        throw new Error(`strict policy refused without reading ${suffix} itself`);
      }
    }
    gates.push({ id: "sync-execute-undeclared-strict", declaration: "live", processId: asyncOnly.id, jobControlOptions: declared, ...strictRefusal });
  } else {
    gates.push({ id: "sync-execute-undeclared", declaration: "live", outcome: "not-applicable", reason: "every published process declares sync-execute" });
  }

  const withoutCore = {
    conformsTo: (conformance.conformsTo ?? []).filter((uri) => !/processes-1\/1\.0\/conf\/core\/?$/.test(uri)),
  };
  const coreless = client.ogcProcesses({ conformance: withoutCore });
  gates.push({
    id: "core-class-undeclared",
    declaration: "derived",
    removed: "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
    ...(await expectLocalRefusal(requests, () =>
      coreless.execute({ processId: PROCESS_ID, mode: "async", inputs: FIXTURE.inputs, jobControlOptions: modes }),
    )),
  });

  const withoutAsync = modes.filter((mode) => mode !== "async-execute");
  gates.push({
    id: "async-execute-undeclared",
    declaration: "derived",
    removed: "async-execute",
    jobControlOptions: withoutAsync,
    ...(await expectLocalRefusal(requests, () =>
      processes.execute({ processId: PROCESS_ID, mode: "async", inputs: FIXTURE.inputs, jobControlOptions: withoutAsync }),
    )),
  });
  return gates;
}

/** Unauthenticated execution must be refused by the server, not merely by the client. */
async function probeGovernance({ sdk, baseUrl, fetchFn, modes, requests }) {
  const anonymous = new sdk.HonuaClient({ baseUrl, fetchFn, timeoutMs: 30_000 });
  const start = requests.length;
  try {
    const run = await anonymous
      .ogcProcesses({ pollBudget: { pollIntervalMs: 250, deadlineMs: 120_000 } })
      .execute({ processId: PROCESS_ID, mode: modes.includes("sync-execute") ? "sync" : "async", inputs: FIXTURE.inputs, jobControlOptions: modes });
    await run.results();
  } catch (error) {
    const projection = safeError(error);
    const issued = requests.slice(start);
    const post = issued.find(isPost);
    if (!post || (post.status !== 401 && post.status !== 403)) {
      throw new Error(`unauthenticated execution was not refused by the candidate: ${projection.name} (POST ${post?.status ?? "not sent"})`);
    }
    return { outcome: "refused", serverStatus: post.status, error: projection, requests: issued };
  }
  throw new Error("an unauthenticated client executed a governed process");
}

export async function collectOgcProcessesCandidateQualification(options) {
  const { sdk, baseUrl, apiKey, identities, fetchFn = fetch, observedAt = new Date().toISOString() } = options;
  const requests = [];
  const jobStatuses = new Map();
  const auditedFetch = async (input, init) => {
    const response = await fetchFn(input, init);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const pathname = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
    requests.push({ method, path: pathname, status: response.status, prefer: headers.get("Prefer") });
    if (response.ok && (response.headers.get("content-type") ?? "").includes("json") && (JOB_STATUS_PATH.test(pathname) || method === "POST")) {
      const body = await response.clone().json().catch(() => undefined);
      if (typeof body?.jobID === "string" && typeof body?.status === "string") {
        jobStatuses.set(body.jobID, [...(jobStatuses.get(body.jobID) ?? []), body.status]);
      }
    }
    return response;
  };
  const freshClient = () => new sdk.HonuaClient({ baseUrl, apiKey, fetchFn: auditedFetch, timeoutMs: 30_000 });
  const client = freshClient();
  const discovery = client.ogcProcesses();
  const landing = await discovery.landing();
  const conformance = await discovery.conformance();
  const processes = client.ogcProcesses({
    conformance,
    capabilityPolicy: "advertised",
    pollBudget: { pollIntervalMs: 250, deadlineMs: 120_000 },
  });
  const listing = await processes.list();
  const summary = listing.processes.find((entry) => entry.id === PROCESS_ID);
  if (!summary) throw new Error(`${PROCESS_ID} is not published by the candidate`);
  const description = await processes.describe(PROCESS_ID);
  const modes = [...(description.jobControlOptions ?? [])];
  // Without a declared execution mode there is nothing to qualify: every
  // execution below would refuse locally and, before the classification added
  // here, would still have been recorded as an honest "unsupported" alongside
  // result: "passed".
  if (!modes.includes("sync-execute") && !modes.includes("async-execute")) {
    throw new Error(`${PROCESS_ID} declares no executable jobControlOptions; there is nothing to qualify`);
  }
  for (const required of ["wkb", "srid", "distance"]) {
    if (!description.inputs?.[required]) throw new Error(`${PROCESS_ID} does not describe required input ${required}`);
  }
  if (!description.outputs || Object.keys(description.outputs).length === 0) {
    throw new Error(`${PROCESS_ID} describes no outputs`);
  }
  const oracle = { center: decodeWkbPoint(FIXTURE.inputs.wkb), distance: FIXTURE.inputs.distance };
  const verifyOutputs = (result) => {
    const names = Object.keys(result.outputs ?? {});
    const declared = Object.keys(description.outputs);
    for (const name of names) {
      if (!declared.includes(name)) throw new Error(`result output ${name} is not described by ${PROCESS_ID}`);
    }
    if (names.length !== 1) throw new Error(`expected exactly one buffer output, got ${names.join(",") || "none"}`);
    return { outputNames: names, oracle: assertBufferResult(result.outputs[names[0]], oracle) };
  };

  const executions = {};
  if (modes.includes("sync-execute")) {
    const start = requests.length;
    const run = await processes.execute({ processId: PROCESS_ID, mode: "sync", inputs: FIXTURE.inputs, jobControlOptions: modes });
    const result = await run.results();
    executions.sync = { status: run.status, ...verifyOutputs(result), requests: requests.slice(start) };
    if (run.status !== "successful") throw new Error(`synchronous execution settled at ${run.status}`);
  } else {
    executions.sync = { status: "unsupported", declared: false };
  }

  if (modes.includes("async-execute")) {
    const start = requests.length;
    // Result validation and the cancellation probe get their own executions.
    // Dismissal drives a job to the terminal `dismissed` state, and
    // `IJobRun.results()` rejects with HonuaJobFailedError on any non-success
    // terminal -- so awaiting results on the run we just cancelled failed the
    // lane precisely when the candidate demonstrated dismissal correctly.
    const run = await processes.execute({ processId: PROCESS_ID, mode: "async", inputs: FIXTURE.inputs, jobControlOptions: modes });
    const result = await run.results();
    if (run.status !== "successful") throw new Error(`asynchronous execution settled at ${run.status}`);
    const transitions = assertLegalJobTransitions(jobStatuses.get(run.id) ?? []);
    if (transitions.at(-1) !== "successful") throw new Error(`the candidate never reported the job successful: ${transitions.join(" -> ")}`);
    const executionRequests = requests.slice(start);
    const cancellation = await probeCancellation(processes, modes, requests);
    executions.async = {
      status: run.status,
      transitions,
      ...verifyOutputs(result),
      resultsRetrievedFromLink: executionRequests.some((entry) => entry.method === "GET" && /\/jobs\/[^/]+\/results$/.test(entry.path)),
      cancellation,
      requests: executionRequests,
    };
  } else {
    executions.async = { status: "unsupported", declared: false };
  }

  const gates = await probeExecutionGates({ client, freshClient, processes, listing, conformance, modes, requests });
  const governance = await probeGovernance({ sdk, baseUrl, fetchFn: auditedFetch, modes, requests });

  const failureStart = requests.length;
  let failure;
  try {
    const run = await processes.execute({
      processId: PROCESS_ID,
      mode: modes.includes("async-execute") ? "async" : "sync",
      inputs: { ...FIXTURE.inputs, wkb: "not-base64" },
      jobControlOptions: modes,
    });
    await run.results();
    throw new Error("invalid governed input unexpectedly succeeded");
  } catch (error) {
    if (error instanceof Error && error.message === "invalid governed input unexpectedly succeeded") throw error;
    // Any thrown error used to be recorded as `outcome: "rejected"` while the
    // evidence still reported `result: "passed"`. An auth failure, a 5xx, a
    // poll timeout or a local capability refusal would each have produced green
    // release evidence for a candidate that never validated the governed input,
    // so only the two shapes that actually prove validation are accepted.
    const classification = classifyGovernedInputRejection(error);
    if (!classification.accepted) {
      const { name, statusCode, jobStatus } = classification.error;
      throw new Error(
        `invalid governed input did not produce a validation rejection: ${name}` +
          `${statusCode === null ? "" : ` (HTTP ${statusCode})`}` +
          `${jobStatus === null ? "" : ` (job ${jobStatus})`}` +
          "; the candidate never demonstrated governed-input validation",
      );
    }
    failure = {
      outcome: "rejected",
      kind: classification.kind,
      error: classification.error,
      requests: requests.slice(failureStart),
    };
  }

  const unknownStart = requests.length;
  let unknownProcess;
  try {
    await processes.describe("honua-sdk-1328-no-such-process");
    throw new Error("an unpublished process was described");
  } catch (error) {
    const projection = safeError(error);
    if (projection.statusCode !== 404) throw error;
    unknownProcess = { outcome: "not-found", error: projection, requests: requests.slice(unknownStart) };
  }

  const evidence = {
    format: OGC_PROCESSES_QUALIFICATION_FORMAT,
    schemaVersion: 1,
    observedAt,
    candidate: identities,
    fixture: { id: FIXTURE.id, sha256: sha256(JSON.stringify(FIXTURE)), processId: PROCESS_ID },
    discovery: {
      landingLinkCount: landing.links?.length ?? 0,
      conformanceClasses: [...(conformance.conformsTo ?? [])],
      processCount: listing.processes.length,
      jobControlOptions: modes,
      dismissDeclared: modes.includes("dismiss") || (conformance.conformsTo ?? []).some((uri) => /processes-1\/1\.0\/conf\/dismiss\/?$/.test(uri)),
      inputNames: Object.keys(description.inputs ?? {}).sort(),
      outputNames: Object.keys(description.outputs ?? {}).sort(),
    },
    executions,
    gates,
    governance,
    failure,
    unknownProcess,
    wire: { requestCount: requests.length, ...auditPreferHeaders(requests) },
    result: "passed",
  };
  assertCandidateEvidenceRedacted(evidence);
  return evidence;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

async function main(argv) {
  if (!qualificationEnabled()) throw new Error("set HONUA_OGC_PROCESSES_QUALIFICATION_ENABLED=true to run the live candidate lane");
  const sdkRoot = path.resolve(requireValue(option(argv, "--sdk-package-root"), "--sdk-package-root"));
  const output = path.resolve(option(argv, "--output") ?? "test-results/ogc-processes-candidate-qualification.json");
  const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/src/index.js")));
  const identities = {
    sdk: {
      package: "@honua/sdk-js",
      version: requireValue(process.env.HONUA_SDK_PACKAGE_VERSION, "HONUA_SDK_PACKAGE_VERSION"),
      integrity: requireValue(process.env.HONUA_SDK_PACKAGE_INTEGRITY, "HONUA_SDK_PACKAGE_INTEGRITY"),
      sourceSha: requireValue(process.env.HONUA_SDK_SOURCE_SHA, "HONUA_SDK_SOURCE_SHA"),
    },
    server: {
      sourceSha: requireValue(process.env.HONUA_SERVER_SOURCE_SHA, "HONUA_SERVER_SOURCE_SHA"),
      imageDigest: requireValue(process.env.HONUA_SERVER_IMAGE_DIGEST, "HONUA_SERVER_IMAGE_DIGEST"),
    },
    manifestRevision: requireValue(process.env.HONUA_MANIFEST_REVISION, "HONUA_MANIFEST_REVISION"),
    evidenceUri: requireValue(process.env.HONUA_EVIDENCE_URI, "HONUA_EVIDENCE_URI"),
  };
  const evidence = await collectOgcProcessesCandidateQualification({
    sdk,
    baseUrl: requireValue(process.env.HONUA_INTEGRATION_BASE_URL, "HONUA_INTEGRATION_BASE_URL"),
    apiKey: requireValue(process.env.HONUA_API_KEY, "HONUA_API_KEY"),
    identities,
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`OGC Processes candidate qualification passed; evidence=${path.relative(process.cwd(), output)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
