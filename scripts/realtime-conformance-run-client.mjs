/**
 * Client for honua-server's controlled-conformance mutation surface
 * (honua-server#3038, PR #3154).
 *
 * The scheduled live lane cannot prove a snapshot-plus-mutation contract by
 * watching a production deployment and hoping somebody edits a feature. It has
 * to *cause* the mutation. This module is the narrow, bounded, reversible way
 * to do that: lease a run, apply mutations only through the leased run's
 * ownership token, and release in a `finally` block.
 *
 * Three disciplines are structural rather than documented:
 *
 * - **The run token never leaves this module.** It is captured in a closure and
 *   is not a property of the returned client, so no caller can serialize it
 *   into retained evidence even by accident. Only the run id, the run marker,
 *   and the baseline digests are observable.
 * - **Every refusal is named.** The server's fail-closed matrix (403 disabled /
 *   503 unresolvable / 409 exhausted-or-mismatched / 404 unknown-or-foreign) is
 *   mapped onto stable codes and the server's own refusal detail is preserved
 *   verbatim, so evidence records why a lane did not execute instead of
 *   inventing a pass.
 * - **Only the run id is interpolated into a URL, and only after validation.**
 *   Every route is a compile-time constant resolved against the already
 *   sanitized reviewed origin, so a hostile lease response cannot redirect a
 *   mutation or a release at another host.
 *
 * @module
 */

/** Header carrying the per-run ownership token issued by the lease response. */
export const REALTIME_CONFORMANCE_RUN_TOKEN_HEADER = "X-Honua-Conformance-Run-Token";

/** Mutation operations the controlled workflow accepts. */
export const REALTIME_CONFORMANCE_OPERATIONS = Object.freeze(["insert", "update", "touch", "delete"]);

/** Route prefix for the controlled-conformance surface. */
export const REALTIME_CONFORMANCE_RUNS_PATH = "/api/v1/streaming/conformance/runs";

/**
 * Byte ceiling for a controlled-conformance response body. The documents are
 * small, fixed-shape records; anything larger is a contract violation rather
 * than a large legitimate payload.
 */
export const REALTIME_CONFORMANCE_RESPONSE_MAX_BYTES = 65_536;

/** Run id forms the server accepts on the route (`Guid` compact or dashed). */
const RUN_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

/** A run marker is `honua-conformance:<32 hex>:<unix seconds>`. */
const RUN_MARKER_PATTERN = /^honua-conformance:[0-9a-f]{32}:[0-9]{1,19}$/iu;

/** Baseline digests are sha256 content digests over the unowned baseline. */
const BASELINE_DIGEST_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/u;

/**
 * A named, fail-closed refusal of a controlled-conformance request. `reason`
 * is the server's own detail, preserved verbatim so evidence never paraphrases
 * a deployment's explanation of why it refused.
 */
export class ConformanceRunRefusal extends Error {
  constructor(code, reason, status = null) {
    super(reason);
    this.name = "ConformanceRunRefusal";
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Classify a refusal as an availability problem rather than a contract
 * violation. Availability keeps the lane honest as `degraded`; everything else
 * is either an explicit `skipped` (the deployment provisions no conformance
 * source) or a `failed` contract outcome.
 */
export function isConformanceAvailabilityRefusal(error) {
  return (
    error instanceof ConformanceRunRefusal &&
    (error.code === "conformance-transport-degraded" || error.code === "conformance-source-unavailable")
  );
}

/**
 * Read the credential-free `conformance` block honua-server publishes on
 * `/api/v1/streaming/features/capabilities`.
 *
 * A deployment that knows the contract but provisions no source answers
 * `{"enabled": false}`; one that predates the contract omits the block
 * entirely. Those are different facts and the lane reports them differently,
 * so they are never collapsed into a single "unavailable".
 */
export function readConformanceCapability(payload) {
  if (!isRecord(payload)) return { present: false, enabled: false };
  const body = isRecord(payload.data) ? payload.data : payload;
  const block = body.conformance;
  if (!isRecord(block) || Array.isArray(block)) return { present: false, enabled: false };
  if (typeof block.enabled !== "boolean") {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance capability block did not declare a boolean enabled flag.",
    );
  }
  return {
    present: true,
    enabled: block.enabled,
    serviceId: textOrNull(block.serviceId),
    layerId: safeIntegerOrNull(block.layerId),
    runIdField: textOrNull(block.runIdField),
    maxMutationsPerRun: safeIntegerOrNull(block.maxMutationsPerRun),
    maxRecordsPerRun: safeIntegerOrNull(block.maxRecordsPerRun),
    operations: Array.isArray(block.operations)
      ? block.operations.filter((entry) => REALTIME_CONFORMANCE_OPERATIONS.includes(entry))
      : null,
  };
}

/**
 * Build a controlled-conformance run client bound to one reviewed origin.
 *
 * The returned object owns the whole lifecycle and nothing else: `open` leases,
 * `mutate` applies one bounded operation, and `release` deletes every record
 * the run owns and reports whether the source's immutable baseline digest
 * reversed to exactly what the lease observed.
 */
export function createConformanceRunClient(options) {
  const baseUrl = trimTrailingSlash(String(options.baseUrl));
  const fetchFn = options.fetchFn;
  const headers = options.headers ?? {};
  const timeoutMs = options.timeoutMs;
  if (typeof fetchFn !== "function") {
    throw new TypeError("A controlled-conformance run client requires fetch.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("A controlled-conformance run client requires a positive timeout.");
  }

  // Deliberately closure-scoped: the token is issued once, is never a property
  // of the client, and therefore cannot be serialized into retained evidence.
  let runToken;
  let lease;
  let released;
  const applied = [];

  const requireLease = () => {
    if (!lease) {
      throw new ConformanceRunRefusal(
        "conformance-run-not-leased",
        "No controlled-conformance run has been leased.",
      );
    }
    return lease;
  };

  return {
    /** Summary of the leased run, or `undefined` before {@link open}. Never carries the token. */
    get lease() {
      return lease;
    },

    /** Operations applied so far, in order. */
    get appliedOperations() {
      return [...applied];
    },

    /**
     * Lease an isolated run bound to this deployment's immutable revision and
     * dedicated conformance source.
     */
    async open(request = {}) {
      if (lease) {
        throw new ConformanceRunRefusal(
          "conformance-run-already-leased",
          "This controlled-conformance client already holds a run lease.",
        );
      }
      const body = {
        ...(request.clientLabel === undefined ? {} : { clientLabel: request.clientLabel }),
        ...(request.expectedDeploymentRevision === undefined
          ? {}
          : { expectedDeploymentRevision: request.expectedDeploymentRevision }),
        ...(request.expectedServiceId === undefined ? {} : { expectedServiceId: request.expectedServiceId }),
        ...(request.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
      };
      const document = await send({
        method: "POST",
        url: `${baseUrl}${REALTIME_CONFORMANCE_RUNS_PATH}`,
        body,
        fetchFn,
        headers,
        timeoutMs,
        // A 404 on the lease route means the deployment does not map the
        // surface at all, which is a different fact from a 404 on a run route.
        missingRouteCode: "conformance-endpoint-unavailable",
      });
      lease = projectLease(document);
      runToken = readRunToken(document);
      released = undefined;
      return lease;
    },

    /**
     * Apply one bounded mutation. `touch` rewrites a record with its current
     * values: the state is unchanged but the canonical edit pipeline still
     * publishes an event, which is what lets transports opened at different
     * times observe an identical baseline and an identical mutation.
     */
    async mutate(request) {
      const current = requireLease();
      if (!REALTIME_CONFORMANCE_OPERATIONS.includes(request?.operation)) {
        throw new ConformanceRunRefusal(
          "conformance-request-invalid",
          "A controlled-conformance mutation requires a known operation.",
        );
      }
      if (request.operation !== "insert" && !Number.isSafeInteger(request.objectId)) {
        throw new ConformanceRunRefusal(
          "conformance-request-invalid",
          `The ${request.operation} operation requires the objectId of a record this run owns.`,
        );
      }
      const document = await send({
        method: "POST",
        url: `${baseUrl}${REALTIME_CONFORMANCE_RUNS_PATH}/${encodeURIComponent(current.runId)}/mutations`,
        body: {
          operation: request.operation,
          ...(request.objectId === undefined ? {} : { objectId: request.objectId }),
          ...(request.label === undefined ? {} : { label: request.label }),
        },
        fetchFn,
        headers: { ...headers, [REALTIME_CONFORMANCE_RUN_TOKEN_HEADER]: runToken },
        timeoutMs,
      });
      const mutation = projectMutation(document, current);
      applied.push(mutation.operation);
      return mutation;
    },

    /**
     * Release the run and delete every record it owns.
     *
     * Idempotent by design so it is safe in a `finally` block: a second call
     * returns the first call's outcome instead of re-issuing the delete. The
     * returned `digestVerified` is the whole point of the call — equal lease
     * and cleanup digests prove the run left the source exactly as it found it.
     */
    async release() {
      if (released) return released;
      const current = requireLease();
      const document = await send({
        method: "DELETE",
        url: `${baseUrl}${REALTIME_CONFORMANCE_RUNS_PATH}/${encodeURIComponent(current.runId)}`,
        fetchFn,
        headers: { ...headers, [REALTIME_CONFORMANCE_RUN_TOKEN_HEADER]: runToken },
        timeoutMs,
      });
      released = projectCleanup(document, current);
      runToken = undefined;
      return released;
    },
  };
}

async function send(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("controlled-conformance timeout"), options.timeoutMs);
  let response;
  try {
    response = await options.fetchFn(options.url, {
      method: options.method,
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    throw controller.signal.aborted
      ? new ConformanceRunRefusal(
          "conformance-transport-degraded",
          "The controlled-conformance request timed out.",
        )
      : new ConformanceRunRefusal(
          "conformance-transport-degraded",
          `The controlled-conformance request failed to reach the reviewed deployment: ${errorMessage(error)}`,
        );
  } finally {
    clearTimeout(timer);
  }
  const text = await readBoundedBody(response);
  if (!response.ok) throw refusalForStatus(response.status, text, options.missingRouteCode);
  const document = parseJsonBody(text);
  const data = isRecord(document) && isRecord(document.data) ? document.data : document;
  if (!isRecord(data) || Array.isArray(data)) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance response did not carry a JSON object.",
    );
  }
  return data;
}

async function readBoundedBody(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > REALTIME_CONFORMANCE_RESPONSE_MAX_BYTES) {
      throw new ConformanceRunRefusal(
        "conformance-response-invalid",
        "The controlled-conformance response exceeded its byte ceiling.",
      );
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > REALTIME_CONFORMANCE_RESPONSE_MAX_BYTES) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance response exceeded its byte ceiling.",
    );
  }
  return text;
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance response was not valid JSON.",
    );
  }
}

/**
 * Map the server's fail-closed status matrix onto named refusals, keeping the
 * server's own `detail` verbatim.
 *
 * `404` is deliberately ambiguous on the run routes: honua-server answers the
 * same status for an unknown run and for a record owned by a different run so
 * the surface cannot be used to confirm that another run's records exist. The
 * client preserves that ambiguity instead of guessing which one happened.
 */
function refusalForStatus(status, text, missingRouteCode) {
  const detail = problemDetail(text);
  if (status === 403) {
    return new ConformanceRunRefusal(
      "conformance-disabled",
      detail ?? "The reviewed deployment provisions no controlled-conformance source.",
      status,
    );
  }
  if (status === 503) {
    return new ConformanceRunRefusal(
      "conformance-source-unavailable",
      detail ??
        "The configured controlled-conformance source did not resolve, or the deployment reports no immutable revision.",
      status,
    );
  }
  if (status === 409) {
    return new ConformanceRunRefusal(
      "conformance-lease-unavailable",
      detail ??
        "Every controlled-conformance lease is held, a budget is exhausted, or the expected revision/source does not match.",
      status,
    );
  }
  if (status === 404 || status === 405) {
    return new ConformanceRunRefusal(
      missingRouteCode ?? "conformance-run-not-found",
      detail ??
        (missingRouteCode
          ? "The reviewed deployment does not serve the controlled-conformance surface."
          : "No live conformance run matches that identifier and token, or the record is not owned by this run."),
      status,
    );
  }
  if (status === 401) {
    return new ConformanceRunRefusal(
      "conformance-access-denied",
      detail ?? "The reviewed deployment denied the controlled-conformance credential.",
      status,
    );
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ConformanceRunRefusal(
      "conformance-transport-degraded",
      detail ?? "The controlled-conformance surface was temporarily unavailable.",
      status,
    );
  }
  return new ConformanceRunRefusal(
    "conformance-request-invalid",
    detail ?? "The reviewed deployment rejected the controlled-conformance request.",
    status,
  );
}

/**
 * Extract the refusal detail from an RFC 7807 problem document or the
 * `ApiResponse` envelope, without ever surfacing an unbounded server string.
 */
function problemDetail(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(document)) return null;
  const candidate = document.detail ?? document.title ?? document.message ?? document.error;
  const detail = textOrNull(candidate);
  if (detail === null) return null;
  return detail.length > 512 ? `${detail.slice(0, 512)}…` : detail;
}

function projectLease(document) {
  const runId = textOrNull(document.runId);
  if (runId === null || !RUN_ID_PATTERN.test(runId)) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance lease returned no usable run identifier.",
    );
  }
  const runMarker = textOrNull(document.runMarker);
  if (runMarker === null || !RUN_MARKER_PATTERN.test(runMarker)) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance lease returned no usable ownership marker.",
    );
  }
  const serviceId = textOrNull(document.serviceId);
  const runIdField = textOrNull(document.runIdField);
  const layerId = safeIntegerOrNull(document.layerId);
  if (serviceId === null || runIdField === null || layerId === null) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance lease did not name the dedicated source it mutates.",
    );
  }
  const baselineDigest = textOrNull(document.baselineDigest);
  if (baselineDigest === null || !BASELINE_DIGEST_PATTERN.test(baselineDigest)) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance lease returned no baseline digest to reverse against.",
    );
  }
  const deploymentRevision = textOrNull(document.deploymentRevision);
  if (deploymentRevision === null) {
    throw new ConformanceRunRefusal(
      "conformance-revision-unbound",
      "The controlled-conformance lease is not bound to an immutable deployment revision.",
    );
  }
  return Object.freeze({
    runId,
    runMarker,
    serviceId,
    layerId,
    runIdField,
    deploymentRevision,
    baselineDigest,
    baselineRecordCount: safeIntegerOrNull(document.baselineRecordCount) ?? 0,
    remainingMutations: safeIntegerOrNull(document.remainingMutations) ?? 0,
    maxRecords: safeIntegerOrNull(document.maxRecords) ?? 0,
    expiresAt: textOrNull(document.expiresAt),
  });
}

function readRunToken(document) {
  const token = textOrNull(document.runToken);
  if (token === null) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance lease returned no per-run ownership token.",
    );
  }
  return token;
}

function projectMutation(document, lease) {
  const operation = textOrNull(document.operation);
  const objectId = safeIntegerOrNull(document.objectId);
  if (operation === null || !REALTIME_CONFORMANCE_OPERATIONS.includes(operation) || objectId === null) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance mutation response did not name the operation it applied.",
    );
  }
  const runMarker = textOrNull(document.runMarker);
  if (runMarker !== null && runMarker !== lease.runMarker) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance mutation reported an ownership marker from another run.",
    );
  }
  return Object.freeze({
    operation,
    objectId,
    runMarker: runMarker ?? lease.runMarker,
    mutationOrdinal: safeIntegerOrNull(document.mutationOrdinal) ?? 0,
    remainingMutations: safeIntegerOrNull(document.remainingMutations) ?? 0,
    ownedRecords: safeIntegerOrNull(document.ownedRecords) ?? 0,
  });
}

function projectCleanup(document, lease) {
  const cleanupDigest = textOrNull(document.baselineDigest);
  if (cleanupDigest === null || !BASELINE_DIGEST_PATTERN.test(cleanupDigest)) {
    throw new ConformanceRunRefusal(
      "conformance-response-invalid",
      "The controlled-conformance cleanup returned no baseline digest to compare.",
    );
  }
  return Object.freeze({
    runId: lease.runId,
    deletedRecords: safeIntegerOrNull(document.deletedRecords) ?? 0,
    leaseDigest: lease.baselineDigest,
    cleanupDigest,
    baselineRecordCount: safeIntegerOrNull(document.baselineRecordCount) ?? 0,
    baselineRestored: document.baselineRestored === true,
    // Equal digests are the tamper-evident proof that the run mutated only
    // records it owned and removed every one of them.
    digestVerified: cleanupDigest === lease.baselineDigest,
  });
}

function trimTrailingSlash(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeIntegerOrNull(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
