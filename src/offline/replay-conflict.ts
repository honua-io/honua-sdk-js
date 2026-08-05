/**
 * Projection from a durable offline replay conflict onto the shipped
 * sync-conflict contracts.
 *
 * `replayOfflineEditPass` records a conflicted acknowledgement as an opaque
 * `conflictId` plus an optional server generation on the queued edit. The SDK
 * separately ships a product-level conflict vocabulary — `SyncConflictDetail`,
 * `SyncConflictId`, `SyncConflictKind`, `ServerGenerationCursor` — for conflict
 * review. Without a projection an application holds two disjoint vocabularies
 * for the same event and has to invent the mapping itself.
 *
 * This module is that mapping, and nothing more:
 *
 * - **Pure.** No I/O, no clock, no mutation. One frozen record in, one frozen
 *   record out. The durable queue stays the source of truth.
 * - **Type-only coupling.** The contract types are imported with `import type`,
 *   so `dist/src/offline/**` gains no runtime edge into `src/replica-sync` and
 *   neither module imports the other's implementation.
 * - **Fail-closed.** An input this build cannot map yields a typed refusal
 *   naming the reason. It never yields a guessed contract object.
 * - **No invented server semantics.** Members of `SyncConflictDetail` that only
 *   a live server can observe or adjudicate — the common base, the server's
 *   side, the field-level diff, the resolution options — are enumerated as
 *   explicitly unavailable rather than filled with a plausible value.
 *
 * What this does *not* do is claim a hosted guarantee. The replay transport is
 * application-owned and end-to-end exactly-once delivery remains a server
 * property; this slice only makes the two vocabularies agree.
 *
 * @experimental
 * @module
 */

import type {
  ConflictFeatureState,
  FeatureId,
  ReplicaId,
  ServerGenerationCursor,
  SyncConflictDetail,
  SyncConflictOperation,
} from "../replica-sync/types.js";
import { HonuaOfflineEditQueueError, type OfflineEditOperation, type OfflineQueuedEdit } from "./edit-queue.js";

/** Stable discriminator and version for offline replay conflict projections. */
export const HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND = "honua.offline-replay-sync-conflict" as const;
export const HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION = "1.0" as const;

/**
 * The replica identity a conflict is attributed to.
 *
 * `SyncConflictSummary` requires a replica and a dataset; the durable edit
 * queue partitions by an authorization-scope digest and a source id and knows
 * neither. Rather than derive a replica identity the SDK cannot observe, the
 * binding is an explicit caller input — the application registered the replica,
 * so the application is the only honest source for it.
 */
export interface OfflineReplaySyncConflictBinding {
  readonly replicaId: ReplicaId;
  readonly datasetId: string;
}

export interface ProjectOfflineReplaySyncConflictInput {
  /** A durable queued edit, treated as untrusted persisted data. */
  readonly edit: OfflineQueuedEdit;
  readonly replica: OfflineReplaySyncConflictBinding;
}

/**
 * The members of `SyncConflictDetail` an offline replay can fill without a
 * server, structurally assignable into the shipped contract once the
 * server-owned members arrive.
 *
 * `clientState` is deliberately payload-free: it carries the operation, the
 * delete marker, and the local authoring time, and never the edit's attributes
 * or geometry. Every other projection in `src/offline` is payload-free for the
 * same reason, and widening the vocabulary must not widen what is exposed.
 */
export type OfflineReplayProjectedSyncConflict = Pick<
  SyncConflictDetail,
  | "id"
  | "replicaId"
  | "datasetId"
  | "sourceId"
  | "featureId"
  | "kind"
  | "status"
  | "clientOperation"
  | "detectedAt"
  | "clientState"
  | "serverGen"
>;

/** A `SyncConflictDetail` member this projection declines to fill. */
export type OfflineReplaySyncConflictUnavailableMember =
  | "base"
  | "serverState"
  | "serverOperation"
  | "fieldConflicts"
  | "fieldConflictCount"
  | "hasGeometryConflict"
  | "geometryConflict"
  | "resolutionOptions"
  | "resolution"
  | "serverGen"
  | "layerId"
  | "client"
  | "device"
  | "metadata"
  | "clientState.attributes"
  | "clientState.geometry";

export type OfflineReplaySyncConflictUnavailableReason =
  /** Only a live server observes the value or adjudicates the choice. */
  | "server-owned"
  /** The durable queue record does not carry it; inventing it would be a claim. */
  | "not-recorded"
  /** Withheld on purpose so the projection stays payload-free. */
  | "payload-free";

export interface OfflineReplaySyncConflictUnavailableV1 {
  readonly member: OfflineReplaySyncConflictUnavailableMember;
  readonly reason: OfflineReplaySyncConflictUnavailableReason;
}

/** Why a well-formed input still has no conflict this build will publish. */
export type OfflineReplaySyncConflictRefusalReason =
  /** The queued edit is not in the `conflicted` state, so there is no conflict. */
  | "not-conflicted"
  /** `conflicted` without a durable conflict outcome: a record this build will not trust. */
  | "missing-conflict-record"
  /** The edit carries no feature id, and `SyncConflictSummary.featureId` is required. */
  | "unidentified-feature"
  /** The persisted record is not a readable `OfflineQueuedEdit`. */
  | "unreadable-edit";

export interface OfflineReplaySyncConflictProjectedV1 {
  readonly kind: typeof HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND;
  readonly version: typeof HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION;
  readonly outcome: "projected";
  readonly editId: `sha256:${string}`;
  readonly conflict: OfflineReplayProjectedSyncConflict;
  /** Ordered, stable, and complete: every contract member left unfilled. */
  readonly unavailable: readonly OfflineReplaySyncConflictUnavailableV1[];
}

export interface OfflineReplaySyncConflictRefusedV1 {
  readonly kind: typeof HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND;
  readonly version: typeof HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION;
  readonly outcome: "refused";
  readonly reason: OfflineReplaySyncConflictRefusalReason;
  /** Dotted path on the input that could not be mapped. */
  readonly path: string;
  /** Absent only when the record's own identity is unreadable. */
  readonly editId?: `sha256:${string}`;
}

export type OfflineReplaySyncConflictProjectionV1 =
  | OfflineReplaySyncConflictProjectedV1
  | OfflineReplaySyncConflictRefusedV1;

/** What became of one replay-side field. */
export type OfflineReplaySyncConflictFieldDisposition =
  /** Copied verbatim into every listed target. */
  | "carried"
  /** Every listed target is computed from it. */
  | "derived"
  /** Withheld so the projection stays payload-free. */
  | "omitted-payload-free"
  /** Local queue bookkeeping with no counterpart in the conflict contract. */
  | "omitted-local-only";

export interface OfflineReplaySyncConflictFieldMappingV1 {
  /** Dotted path on the durable queued edit. */
  readonly source: string;
  /** Dotted paths on the projection; empty for an omission. */
  readonly targets: readonly string[];
  readonly disposition: OfflineReplaySyncConflictFieldDisposition;
}

/**
 * The losslessness ledger: every field of a durable queued edit, and where it
 * lands or why it does not.
 *
 * A conflicted acknowledgement's own members reach the projection through this
 * table: `conflictId` and `serverGeneration` are recorded by `markConflicted`
 * as `conflict.conflictId` and `conflict.serverGeneration`, and `editId`,
 * `requestFingerprint`, and `idempotencyKey` are identity checks the replay
 * pass has already matched against the queued edit before any transition.
 */
export const OFFLINE_REPLAY_SYNC_CONFLICT_FIELD_MAP: readonly OfflineReplaySyncConflictFieldMappingV1[] = deepFreeze([
  { source: "version", targets: [], disposition: "omitted-local-only" },
  { source: "id", targets: ["editId"], disposition: "carried" },
  { source: "requestFingerprint", targets: [], disposition: "omitted-local-only" },
  { source: "authorizationScopeDigest", targets: [], disposition: "omitted-local-only" },
  { source: "sourceId", targets: ["conflict.sourceId"], disposition: "carried" },
  { source: "idempotencyKey", targets: [], disposition: "omitted-local-only" },
  {
    source: "edit.operation",
    targets: ["conflict.clientOperation", "conflict.clientState.operation", "conflict.clientState.deleted"],
    disposition: "derived",
  },
  { source: "edit.featureId", targets: ["conflict.featureId"], disposition: "carried" },
  { source: "edit.attributes", targets: [], disposition: "omitted-payload-free" },
  { source: "edit.geometry", targets: [], disposition: "omitted-payload-free" },
  { source: "dependencyIds", targets: [], disposition: "omitted-local-only" },
  { source: "state", targets: ["conflict.status"], disposition: "derived" },
  { source: "createdAt", targets: ["conflict.clientState.editedAt"], disposition: "carried" },
  { source: "updatedAt", targets: [], disposition: "omitted-local-only" },
  { source: "attemptCount", targets: [], disposition: "omitted-local-only" },
  { source: "lease", targets: [], disposition: "omitted-local-only" },
  { source: "retry", targets: [], disposition: "omitted-local-only" },
  { source: "applied", targets: [], disposition: "omitted-local-only" },
  { source: "conflict.conflictId", targets: ["conflict.id"], disposition: "carried" },
  { source: "conflict.detectedAt", targets: ["conflict.detectedAt"], disposition: "carried" },
  { source: "conflict.serverGeneration", targets: ["conflict.serverGen"], disposition: "carried" },
  { source: "cancellation", targets: [], disposition: "omitted-local-only" },
  { source: "audit", targets: [], disposition: "omitted-local-only" },
]);

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_STRING_BYTES = 1024;
const encoder = new TextEncoder();
const INPUT_KEYS = new Set(["edit", "replica"]);
const BINDING_KEYS = new Set(["replicaId", "datasetId"]);
const QUEUED_EDIT_KEYS = new Set([
  "version",
  "id",
  "requestFingerprint",
  "authorizationScopeDigest",
  "sourceId",
  "idempotencyKey",
  "edit",
  "dependencyIds",
  "state",
  "createdAt",
  "updatedAt",
  "attemptCount",
  "lease",
  "retry",
  "applied",
  "conflict",
  "cancellation",
  "audit",
]);
const FEATURE_EDIT_KEYS = new Set(["operation", "featureId", "attributes", "geometry"]);
const CONFLICT_OUTCOME_KEYS = new Set(["conflictId", "detectedAt", "serverGeneration"]);
const EDIT_STATES = new Set(["pending", "leased", "retryable", "applied", "conflicted", "cancelled"]);

/**
 * An offline `add` is the disconnected form of a server `create`; `update` and
 * `delete` keep their names. The queue's spelling and the conflict contract's
 * spelling are both closed unions, so the map is total in both directions.
 */
const CLIENT_OPERATIONS: Readonly<Record<OfflineEditOperation, SyncConflictOperation>> = Object.freeze({
  add: "create",
  update: "update",
  delete: "delete",
});

/**
 * Every member left unfilled, in a stable order. `serverGen` is included only
 * when the acknowledgement carried no cursor: its presence in this list is how
 * an application learns the conflict cannot yet be ordered against replica sync
 * state, instead of discovering an absent optional member by accident.
 */
const UNFILLED_MEMBERS: readonly OfflineReplaySyncConflictUnavailableV1[] = deepFreeze([
  { member: "base", reason: "server-owned" },
  { member: "serverState", reason: "server-owned" },
  { member: "serverOperation", reason: "server-owned" },
  { member: "fieldConflicts", reason: "server-owned" },
  { member: "fieldConflictCount", reason: "server-owned" },
  { member: "hasGeometryConflict", reason: "server-owned" },
  { member: "geometryConflict", reason: "server-owned" },
  { member: "resolutionOptions", reason: "server-owned" },
  { member: "resolution", reason: "server-owned" },
  { member: "layerId", reason: "not-recorded" },
  { member: "client", reason: "not-recorded" },
  { member: "device", reason: "not-recorded" },
  { member: "metadata", reason: "not-recorded" },
  { member: "clientState.attributes", reason: "payload-free" },
  { member: "clientState.geometry", reason: "payload-free" },
]);

const UNAVAILABLE_WITHOUT_SERVER_GENERATION: readonly OfflineReplaySyncConflictUnavailableV1[] = deepFreeze([
  ...UNFILLED_MEMBERS,
  { member: "serverGen", reason: "not-recorded" },
]);

interface ReadableConflictedEdit {
  readonly editId: `sha256:${string}`;
  readonly sourceId: string;
  readonly operation: OfflineEditOperation;
  readonly featureId: FeatureId;
  readonly createdAt: string;
  readonly conflictId: string;
  readonly detectedAt: string;
  readonly serverGeneration?: ServerGenerationCursor;
}

type ReadResult =
  | { readonly ok: true; readonly value: ReadableConflictedEdit }
  | {
      readonly ok: false;
      readonly reason: OfflineReplaySyncConflictRefusalReason;
      readonly path: string;
      readonly editId?: `sha256:${string}`;
    };

/**
 * Project one durable conflicted queued edit onto the shipped sync-conflict
 * vocabulary.
 *
 * Two failure modes are kept apart on purpose. The caller's own argument — the
 * replica binding — is a programming input, so a malformed one throws. The
 * queued edit is persisted, possibly corrupt data, so an unmappable one is
 * returned as a typed refusal that the caller can render beside the conflicts
 * that did project. Neither path ever returns a partially guessed conflict.
 */
export function projectOfflineReplaySyncConflict(
  input: ProjectOfflineReplaySyncConflictInput,
): OfflineReplaySyncConflictProjectionV1 {
  const record = argumentRecord(input, "input");
  allowedArgumentKeys(record, INPUT_KEYS, "input");
  const replica = normalizeOfflineReplaySyncConflictBinding(record.replica, "input.replica");

  const read = readConflictedEdit(record.edit, "input.edit");
  if (!read.ok) {
    return deepFreeze({
      kind: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
      version: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
      outcome: "refused",
      reason: read.reason,
      path: read.path,
      ...(read.editId === undefined ? {} : { editId: read.editId }),
    });
  }

  const value = read.value;
  const clientOperation = CLIENT_OPERATIONS[value.operation];
  const clientState: ConflictFeatureState = {
    operation: clientOperation,
    editedAt: value.createdAt,
    ...(clientOperation === "delete" ? { deleted: true } : {}),
  };

  return deepFreeze({
    kind: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
    version: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
    outcome: "projected",
    editId: value.editId,
    conflict: {
      id: value.conflictId,
      replicaId: replica.replicaId,
      datasetId: replica.datasetId,
      sourceId: value.sourceId,
      featureId: value.featureId,
      // A replay conflict is always the disconnected-replica model, never a
      // named-version reconcile/post conflict; review UI routes on this.
      kind: "replica-sync",
      // The durable record holds no resolution, so the conflict is awaiting
      // review. Recording a resolution back against the queued edit is a
      // separate slice; until it exists, no other status is derivable.
      status: "pending",
      clientOperation,
      detectedAt: value.detectedAt,
      clientState,
      ...(value.serverGeneration === undefined ? {} : { serverGen: value.serverGeneration }),
    },
    unavailable: value.serverGeneration === undefined ? UNAVAILABLE_WITHOUT_SERVER_GENERATION : UNFILLED_MEMBERS,
  });
}

/**
 * Validate a caller-supplied replica binding. Shared with the replay pass so
 * one malformed binding is rejected identically wherever it is supplied.
 *
 * @internal
 */
export function normalizeOfflineReplaySyncConflictBinding(
  value: unknown,
  path: string,
): OfflineReplaySyncConflictBinding {
  const record = argumentRecord(value, path);
  allowedArgumentKeys(record, BINDING_KEYS, path);
  return Object.freeze({
    replicaId: argumentString(record.replicaId, `${path}.replicaId`),
    datasetId: argumentString(record.datasetId, `${path}.datasetId`),
  });
}

function readConflictedEdit(value: unknown, path: string): ReadResult {
  if (!isPlainRecord(value)) return { ok: false, reason: "unreadable-edit", path };
  const record = value as Record<string, unknown>;
  const editId = optionalDigest(record.id);
  if (editId === undefined) return { ok: false, reason: "unreadable-edit", path: `${path}.id` };
  for (const key of Object.keys(record)) {
    if (!QUEUED_EDIT_KEYS.has(key)) return { ok: false, reason: "unreadable-edit", path: `${path}.${key}`, editId };
  }

  const state = record.state;
  if (typeof state !== "string" || !EDIT_STATES.has(state)) {
    return { ok: false, reason: "unreadable-edit", path: `${path}.state`, editId };
  }
  if (state !== "conflicted") {
    // A non-conflicted record carrying a conflict outcome contradicts itself;
    // the queue's own record validator rejects the same combination.
    if (record.conflict !== undefined) {
      return { ok: false, reason: "unreadable-edit", path: `${path}.conflict`, editId };
    }
    return { ok: false, reason: "not-conflicted", path: `${path}.state`, editId };
  }
  if (record.conflict === undefined) {
    return { ok: false, reason: "missing-conflict-record", path: `${path}.conflict`, editId };
  }

  const sourceId = optionalString(record.sourceId);
  if (sourceId === undefined) return { ok: false, reason: "unreadable-edit", path: `${path}.sourceId`, editId };
  const createdAt = optionalTimestamp(record.createdAt);
  if (createdAt === undefined) return { ok: false, reason: "unreadable-edit", path: `${path}.createdAt`, editId };

  if (!isPlainRecord(record.edit)) return { ok: false, reason: "unreadable-edit", path: `${path}.edit`, editId };
  const edit = record.edit as Record<string, unknown>;
  for (const key of Object.keys(edit)) {
    if (!FEATURE_EDIT_KEYS.has(key)) {
      return { ok: false, reason: "unreadable-edit", path: `${path}.edit.${key}`, editId };
    }
  }
  const operation = edit.operation;
  if (typeof operation !== "string" || !Object.hasOwn(CLIENT_OPERATIONS, operation)) {
    return { ok: false, reason: "unreadable-edit", path: `${path}.edit.operation`, editId };
  }

  if (!isPlainRecord(record.conflict)) {
    return { ok: false, reason: "unreadable-edit", path: `${path}.conflict`, editId };
  }
  const conflict = record.conflict as Record<string, unknown>;
  for (const key of Object.keys(conflict)) {
    if (!CONFLICT_OUTCOME_KEYS.has(key)) {
      return { ok: false, reason: "unreadable-edit", path: `${path}.conflict.${key}`, editId };
    }
  }
  const conflictId = optionalString(conflict.conflictId);
  if (conflictId === undefined) {
    return { ok: false, reason: "unreadable-edit", path: `${path}.conflict.conflictId`, editId };
  }
  const detectedAt = optionalTimestamp(conflict.detectedAt);
  if (detectedAt === undefined) {
    return { ok: false, reason: "unreadable-edit", path: `${path}.conflict.detectedAt`, editId };
  }
  let serverGeneration: string | undefined;
  if (conflict.serverGeneration !== undefined) {
    serverGeneration = optionalString(conflict.serverGeneration);
    if (serverGeneration === undefined) {
      return { ok: false, reason: "unreadable-edit", path: `${path}.conflict.serverGeneration`, editId };
    }
  }

  // Checked last: a feature-less local create is a well-formed conflict this
  // build simply cannot name in a contract whose `featureId` is required.
  const featureId = readFeatureId(edit.featureId);
  if (featureId === undefined) {
    return { ok: false, reason: "unidentified-feature", path: `${path}.edit.featureId`, editId };
  }

  return {
    ok: true,
    value: {
      editId,
      sourceId,
      operation: operation as OfflineEditOperation,
      featureId,
      createdAt,
      conflictId,
      detectedAt,
      ...(serverGeneration === undefined ? {} : { serverGeneration }),
    },
  };
}

function readFeatureId(value: unknown): FeatureId | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return optionalString(value);
}

function isPlainRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const [, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return false;
  }
  return true;
}

function optionalString(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_BYTES ||
    value.trim() !== value ||
    encoder.encode(value).byteLength > MAX_STRING_BYTES
  ) {
    return undefined;
  }
  return value;
}

function optionalDigest(value: unknown): `sha256:${string}` | undefined {
  const result = optionalString(value);
  return result !== undefined && DIGEST_PATTERN.test(result) ? (result as `sha256:${string}`) : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
  const result = optionalString(value);
  if (result === undefined) return undefined;
  const time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result) return undefined;
  return result;
}

function argumentRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) invalid(`${path} must be a plain data object.`, path);
  return value as Record<string, unknown>;
}

function allowedArgumentKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`${path}.${key} is not allowed.`, `${path}.${key}`);
  }
}

function argumentString(value: unknown, path: string): string {
  const result = optionalString(value);
  if (result === undefined) {
    invalid(`${path} must be a normalized non-empty string of at most 1024 UTF-8 bytes.`, path);
  }
  return result;
}

function invalid(message: string, path: string): never {
  throw new HonuaOfflineEditQueueError("invalid-edit", message, { path });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
