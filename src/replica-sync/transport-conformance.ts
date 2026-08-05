/**
 * One conformance suite every {@link ReplicaSyncTransport} must pass.
 *
 * `FixtureReplicaSyncTransport` defines the reference semantics and
 * `GeoServicesReplicaSyncTransport` speaks to a real server; the suite is what
 * proves the two agree on vocabulary rather than merely on type shape. It is
 * written as plain async functions rather than against a test framework so the
 * identical cases can run under vitest, inside a live evidence lane, or from a
 * downstream package verifying its own transport.
 *
 * The cases assert only what a transport can honestly guarantee: identity,
 * typed refusals, and the composition points other contracts depend on. They
 * deliberately do **not** assert seeded values, counts, or ordering, because
 * those are properties of a deployment's data, not of the contract.
 *
 * @experimental
 * @module
 */

import { isHonuaReplicaSyncError, isReplicaSyncCapabilityRefusal } from "./errors.js";
import type { ReplicaSyncTransport, SyncConflictDetail, SyncConflictId, SyncConflictSummary } from "./types.js";

export const HONUA_REPLICA_SYNC_TRANSPORT_CONFORMANCE_KIND = "honua.replica-sync-transport-conformance" as const;
export const HONUA_REPLICA_SYNC_TRANSPORT_CONFORMANCE_VERSION = "1.0" as const;

export interface ReplicaSyncTransportConformanceOptions {
  /** The transport under test. Called once per case; may return a fresh instance. */
  readonly createTransport: () => ReplicaSyncTransport | Promise<ReplicaSyncTransport>;
  /** Optional teardown for the transport a case finished with. */
  readonly disposeTransport?: (transport: ReplicaSyncTransport) => void | Promise<void>;
  /** A dataset the deployment offers disconnected sync for. */
  readonly datasetId: string;
  /**
   * A dataset the deployment does **not** offer disconnected sync for. When
   * omitted the capability-refusal case is reported as skipped rather than
   * silently passing.
   */
  readonly unsupportedDatasetId?: string;
  /** Human label recorded on the report (for example `geoservices`). */
  readonly label?: string;
  /** Run a subset by name. Unknown names fail the report rather than passing silently. */
  readonly only?: readonly string[];
}

export interface ReplicaSyncTransportConformanceCaseResultV1 {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
}

export interface ReplicaSyncTransportConformanceReportV1 {
  readonly kind: typeof HONUA_REPLICA_SYNC_TRANSPORT_CONFORMANCE_KIND;
  readonly version: typeof HONUA_REPLICA_SYNC_TRANSPORT_CONFORMANCE_VERSION;
  readonly label?: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cases: readonly ReplicaSyncTransportConformanceCaseResultV1[];
}

/** Signalled by a case that cannot reach a verdict on this deployment. */
class ConformanceSkip extends Error {}

function skip(reason: string): never {
  throw new ConformanceSkip(reason);
}

type ConformanceCase = (
  transport: ReplicaSyncTransport,
  options: ReplicaSyncTransportConformanceOptions,
) => Promise<void>;

/** Names of every case in the suite, in execution order. */
export const REPLICA_SYNC_TRANSPORT_CONFORMANCE_CASES: readonly string[] = [
  "capabilities-are-explicit",
  "unsupported-sync-is-a-typed-refusal",
  "replica-listing-is-well-formed",
  "replica-listing-paginates-with-a-cursor",
  "unknown-replica-is-replica-not-found",
  "conflict-listing-is-well-formed",
  "conflict-detail-carries-three-way-state",
  "unknown-conflict-is-conflict-not-found",
  "conflict-detail-round-trips-its-summary",
  "resolution-options-are-declared",
  "batch-resolution-reports-per-conflict-failures",
];

const CASES: Readonly<Record<string, ConformanceCase>> = {
  "capabilities-are-explicit": async (transport, options) => {
    const capabilities = await transport.capabilities(options.datasetId);
    assert(capabilities.sync === true, "a supported dataset must report sync: true");
    assert(typeof capabilities.createReplica === "boolean", "createReplica must be a boolean");
    assert(typeof capabilities.synchronizeReplica === "boolean", "synchronizeReplica must be a boolean");
    assert(typeof capabilities.conflictReview === "boolean", "conflictReview must be a boolean");
    assert(typeof capabilities.conflictResolution === "boolean", "conflictResolution must be a boolean");
    assert(capabilities.directions.length > 0, "at least one sync direction must be advertised");
    assert(capabilities.conflictPolicies.length > 0, "at least one conflict policy must be advertised");
  },

  "unsupported-sync-is-a-typed-refusal": async (transport, options) => {
    const datasetId = options.unsupportedDatasetId;
    if (datasetId === undefined) skip("no unsupportedDatasetId was supplied");
    // A dataset without disconnected sync must be refused, never answered with
    // an empty or all-false capability record that reads as "supported but idle".
    let caught: unknown;
    try {
      await transport.capabilities(datasetId);
    } catch (error) {
      caught = error;
    }
    assert(caught !== undefined, "capabilities() must refuse an unsupported dataset");
    assert(
      isReplicaSyncCapabilityRefusal(caught),
      "the refusal must be a typed capability refusal naming the missing capability",
    );
  },

  "replica-listing-is-well-formed": async (transport, options) => {
    const page = await transport.listReplicas({ datasetId: options.datasetId });
    for (const replica of page.items) {
      assert(typeof replica.id === "string" && replica.id.length > 0, "replica.id must be a non-empty string");
      assert(replica.datasetId === options.datasetId, "replica.datasetId must match the requested dataset");
      assert(typeof replica.createdAt === "string", "replica.createdAt must be an ISO timestamp");
      assert(!Number.isNaN(Date.parse(replica.createdAt)), "replica.createdAt must parse as a date");
      assert(typeof replica.status.inProgress === "boolean", "status.inProgress must be a boolean");
      assert(
        Number.isInteger(replica.status.openConflicts) && replica.status.openConflicts >= 0,
        "status.openConflicts must be a non-negative integer",
      );
      // A generation cursor is opaque, but it must be a string when present so
      // it composes with the offline replay projection's ServerGenerationCursor.
      assert(
        replica.status.serverGen === undefined || typeof replica.status.serverGen === "string",
        "status.serverGen must be an opaque string cursor when present",
      );
    }
  },

  "replica-listing-paginates-with-a-cursor": async (transport, options) => {
    const all = await transport.listReplicas({ datasetId: options.datasetId });
    if (all.items.length < 2) skip("the deployment has fewer than two replicas");
    const first = await transport.listReplicas({ datasetId: options.datasetId, limit: 1 });
    assert(first.items.length === 1, "a limit of 1 must return exactly one replica");
    assert(first.cursor !== undefined, "a truncated page must carry a continuation cursor");
    const second = await transport.listReplicas({ datasetId: options.datasetId, limit: 1, cursor: first.cursor });
    assert(second.items[0]?.id !== first.items[0]?.id, "the continuation must not repeat the first page");
  },

  "unknown-replica-is-replica-not-found": async (transport) => {
    let caught: unknown;
    try {
      await transport.getReplica(ABSENT_ID);
    } catch (error) {
      caught = error;
    }
    assert(caught !== undefined, "an unknown replica must be refused, not answered");
    assert(
      isHonuaReplicaSyncError(caught) && caught.code === "replica-not-found",
      'an unknown replica must raise code "replica-not-found"',
    );
  },

  "conflict-listing-is-well-formed": async (transport, options) => {
    const page = await conflictPage(transport, options);
    if (page === undefined) skip("conflict review is not available on this deployment");
    for (const conflict of page) {
      assertSummary(conflict, options.datasetId);
    }
  },

  "conflict-detail-carries-three-way-state": async (transport, options) => {
    const detail = await firstConflictDetail(transport, options);
    if (detail === undefined) skip("no conflict is available to inspect");
    // The three-way comparison is the whole point of the review contract; a
    // transport that cannot produce all three sides cannot back a reviewer UI.
    assert(typeof detail.base.operation === "string", "base.operation must be present");
    assert(typeof detail.clientState.operation === "string", "clientState.operation must be present");
    assert(typeof detail.serverState.operation === "string", "serverState.operation must be present");
    assert(Array.isArray(detail.fieldConflicts), "fieldConflicts must be an array");
    assert(
      detail.fieldConflictCount === detail.fieldConflicts.length,
      "fieldConflictCount must agree with the fieldConflicts array",
    );
    assert(
      detail.serverGen === undefined || typeof detail.serverGen === "string",
      "serverGen must be an opaque string cursor when present",
    );
    assert(
      detail.hasGeometryConflict === (detail.geometryConflict !== undefined),
      "hasGeometryConflict must agree with the presence of geometryConflict",
    );
  },

  "unknown-conflict-is-conflict-not-found": async (transport, options) => {
    const page = await conflictPage(transport, options);
    if (page === undefined) skip("conflict review is not available on this deployment");
    let caught: unknown;
    try {
      await transport.getConflict(ABSENT_ID);
    } catch (error) {
      caught = error;
    }
    assert(caught !== undefined, "an unknown conflict must be refused, not answered");
    assert(
      isHonuaReplicaSyncError(caught) && caught.code === "conflict-not-found",
      'an unknown conflict must raise code "conflict-not-found"',
    );
  },

  "conflict-detail-round-trips-its-summary": async (transport, options) => {
    const page = await conflictPage(transport, options);
    if (page === undefined || page.length === 0) skip("no conflict is available to inspect");
    const summary = page[0]!;
    const detail = await transport.getConflict(summary.id);
    // A detail read must describe the same event the listing announced, or a
    // reviewer's list selection silently opens a different conflict.
    assert(detail.id === summary.id, "detail.id must match the summary");
    assert(detail.replicaId === summary.replicaId, "detail.replicaId must match the summary");
    assert(detail.featureId === summary.featureId, "detail.featureId must match the summary");
    assert(detail.kind === summary.kind, "detail.kind must match the summary");
    assert(detail.datasetId === summary.datasetId, "detail.datasetId must match the summary");
  },

  "resolution-options-are-declared": async (transport, options) => {
    const detail = await firstConflictDetail(transport, options);
    if (detail === undefined) skip("no conflict is available to inspect");
    assert(detail.resolutionOptions.length > 0, "a reviewable conflict must declare its resolution options");
    for (const option of detail.resolutionOptions) {
      assert(typeof option.available === "boolean", "every resolution option must declare availability");
      // An unavailable option without a reason is indistinguishable from a bug.
      assert(
        option.available || (typeof option.reason === "string" && option.reason.length > 0),
        "an unavailable resolution option must state why",
      );
    }
  },

  "batch-resolution-reports-per-conflict-failures": async (transport, options) => {
    const page = await conflictPage(transport, options);
    if (page === undefined) skip("conflict review is not available on this deployment");
    // A batch must partition into records and failures rather than throwing on
    // the first bad member, so a reviewer sees which resolutions landed.
    const result = await transport.resolveConflicts([{ conflictId: ABSENT_ID, choice: "accept-server" }]);
    assert(Array.isArray(result.records), "records must be an array");
    assert(result.records.length === 0, "an unresolvable batch must produce no records");
    assert(result.failures.length === 1, "an unresolvable batch member must be reported as a failure");
    assert(result.failures[0]?.conflictId === ABSENT_ID, "the failure must name the conflict it belongs to");
    assert(
      typeof result.failures[0]?.reason === "string" && result.failures[0].reason.length > 0,
      "a batch failure must carry a reason",
    );
  },
};

/**
 * An identifier no deployment issues. Both the fixture and the server mint
 * opaque ids (GUID hex on the server); this value is shaped so it cannot
 * collide while still being a legal path segment.
 */
const ABSENT_ID = "honua-conformance-absent-00000000000000000000000000000000";

export async function runReplicaSyncTransportConformance(
  options: ReplicaSyncTransportConformanceOptions,
): Promise<ReplicaSyncTransportConformanceReportV1> {
  const selected = options.only ?? REPLICA_SYNC_TRANSPORT_CONFORMANCE_CASES;
  const cases: ReplicaSyncTransportConformanceCaseResultV1[] = [];

  for (const name of selected) {
    const body = CASES[name];
    if (!body) {
      cases.push({ name, status: "failed", detail: "unknown conformance case" });
      continue;
    }
    let transport: ReplicaSyncTransport | undefined;
    try {
      transport = await options.createTransport();
      await body(transport, options);
      cases.push({ name, status: "passed" });
    } catch (error) {
      cases.push(
        error instanceof ConformanceSkip
          ? { name, status: "skipped", detail: error.message }
          : { name, status: "failed", detail: describe(error) },
      );
    } finally {
      if (transport && options.disposeTransport) {
        try {
          await options.disposeTransport(transport);
        } catch {
          // Teardown failures must not rewrite a case's own verdict.
        }
      }
    }
  }

  const failed = cases.filter((entry) => entry.status === "failed").length;
  const skipped = cases.filter((entry) => entry.status === "skipped").length;
  return {
    kind: HONUA_REPLICA_SYNC_TRANSPORT_CONFORMANCE_KIND,
    version: HONUA_REPLICA_SYNC_TRANSPORT_CONFORMANCE_VERSION,
    ...(options.label ? { label: options.label } : {}),
    total: cases.length,
    passed: cases.length - failed - skipped,
    failed,
    skipped,
    cases,
  };
}

async function conflictPage(
  transport: ReplicaSyncTransport,
  options: ReplicaSyncTransportConformanceOptions,
): Promise<ReadonlyArray<SyncConflictSummary> | undefined> {
  try {
    const page = await transport.listConflicts({ datasetId: options.datasetId });
    return page.items;
  } catch (error) {
    if (isHonuaReplicaSyncError(error) && error.code === "unsupported-conflict-review") return undefined;
    throw error;
  }
}

async function firstConflictDetail(
  transport: ReplicaSyncTransport,
  options: ReplicaSyncTransportConformanceOptions,
): Promise<SyncConflictDetail | undefined> {
  const page = await conflictPage(transport, options);
  const summary: SyncConflictSummary | undefined = page?.[0];
  if (summary === undefined) return undefined;
  const conflictId: SyncConflictId = summary.id;
  return transport.getConflict(conflictId);
}

function assertSummary(conflict: SyncConflictSummary, datasetId: string): void {
  assert(typeof conflict.id === "string" && conflict.id.length > 0, "conflict.id must be a non-empty string");
  assert(typeof conflict.replicaId === "string", "conflict.replicaId must be a string");
  assert(conflict.datasetId === datasetId, "conflict.datasetId must match the requested dataset");
  // The shared FeatureId alias is what lets a conflict feed a temporal timeline.
  assert(typeof conflict.featureId === "string" && conflict.featureId.length > 0, "conflict.featureId must be present");
  assert(
    conflict.kind === "replica-sync" || conflict.kind === "version-reconcile",
    "conflict.kind must be one of the two declared conflict models",
  );
  assert(!Number.isNaN(Date.parse(conflict.detectedAt)), "conflict.detectedAt must parse as a date");
  assert(
    Number.isInteger(conflict.fieldConflictCount) && conflict.fieldConflictCount >= 0,
    "fieldConflictCount must be a non-negative integer",
  );
  assert(typeof conflict.hasGeometryConflict === "boolean", "hasGeometryConflict must be a boolean");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
