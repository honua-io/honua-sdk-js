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
async function probeCancellation(processes, modes) {
  const run = await processes.execute({
    processId: PROCESS_ID,
    mode: "async",
    inputs: FIXTURE.inputs,
    jobControlOptions: modes,
  });
  if (!modes.includes("dismiss")) {
    try {
      await run.cancel();
      throw new Error("cancel unexpectedly succeeded without a dismiss declaration");
    } catch (error) {
      if (error?.name !== "HonuaCapabilityNotSupportedError") throw error;
      return { declared: false, outcome: "refused", status: "unsupported", error: safeError(error) };
    }
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

export async function collectOgcProcessesCandidateQualification(options) {
  const { sdk, baseUrl, apiKey, identities, fetchFn = fetch, observedAt = new Date().toISOString() } = options;
  const requests = [];
  const auditedFetch = async (input, init) => {
    const response = await fetchFn(input, init);
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      path: new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname,
      status: response.status,
      prefer: headers.get("Prefer"),
    });
    return response;
  };
  const client = new sdk.HonuaClient({ baseUrl, apiKey, fetchFn: auditedFetch, timeoutMs: 30_000 });
  const discovery = client.ogcProcesses();
  const landing = await discovery.landing();
  const conformance = await discovery.conformance();
  const processes = client.ogcProcesses({
    conformance,
    capabilityPolicy: "advertised",
    pollBudget: { pollIntervalMs: 50, deadlineMs: 30_000 },
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

  const executions = {};
  if (modes.includes("sync-execute")) {
    const start = requests.length;
    const run = await processes.execute({ processId: PROCESS_ID, mode: "sync", inputs: FIXTURE.inputs, jobControlOptions: modes });
    const result = await run.results();
    executions.sync = { status: run.status, outputNames: Object.keys(result.outputs), requests: requests.slice(start) };
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
    const cancellation = await probeCancellation(processes, modes);
    executions.async = {
      status: run.status,
      outputNames: Object.keys(result.outputs),
      cancellation,
      requests: requests.slice(start),
    };
  } else {
    executions.async = { status: "unsupported", declared: false };
  }

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
      inputNames: Object.keys(description.inputs ?? {}).sort(),
      outputNames: Object.keys(description.outputs ?? {}).sort(),
    },
    executions,
    failure,
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
