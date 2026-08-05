/**
 * Replica conflict policy and reviewed conflict resolution for the durable
 * offline edit queue.
 *
 * The queue can record that a replay attempt conflicted. What it could not do
 * until now is say *what should happen next*. A replica is registered with a
 * {@link ReplicaConflictPolicy}, and a reviewer closes an individual conflict
 * with a {@link ConflictResolutionChoice}; both vocabularies ship in
 * `@honua/sdk-js/replica-sync`, and neither reached the queue. This module is
 * that reach, under two rules:
 *
 * - **Nothing is downgraded in silence.** A policy whose outcome the SDK cannot
 *   compute from queue-side state alone is refused by name
 *   ({@link HonuaOfflineConflictAdjudicationError}) rather than quietly
 *   behaving like the one policy the SDK can always honour. Parking a
 *   `client-wins` replica's conflicts for manual review *looks* like working
 *   software and is a different product than the one the application asked for.
 * - **Nothing is claimed of a server.** A resolution recorded here is durable
 *   *local* state: it is stamped `unacknowledged-by-server`, and this build has
 *   no code path that produces any other value. Delivering a resolution to a
 *   server, and reading its answer back, is server work that has not landed.
 *
 * Like every other offline↔replica-sync seam, the coupling is type-only: the
 * emitted JavaScript here imports `./edit-queue.js` and nothing from
 * `src/replica-sync`.
 *
 * @experimental
 * @module
 */

import { type HonuaErrorCode, HonuaSdkError } from "../core/error-envelope.js";
import type {
  ConflictResolutionChoice,
  ReplicaConflictPolicy,
  SyncConflictId,
  SyncConflictResolution,
} from "../replica-sync/types.js";
import {
  HonuaOfflineEditQueueError,
  type OfflineEditConflictResolutionAcknowledgement,
  type OfflineEditConflictResolutionChoice,
  type OfflineEditConflictResolutionDisposition,
  type OfflineEditQueue,
  type OfflineEditQueuePartition,
} from "./edit-queue.js";

/** Stable discriminator and version for offline conflict-resolution receipts. */
export const HONUA_OFFLINE_CONFLICT_RESOLUTION_KIND = "honua.offline-conflict-resolution" as const;
export const HONUA_OFFLINE_CONFLICT_RESOLUTION_VERSION = "1.0" as const;

/**
 * Both refusals are capability statements — the SDK cannot adjudicate, rather
 * than the caller having malformed its request — so they share the envelope
 * code the replica-sync capability errors already use.
 */
const ADJUDICATION_ERROR_CODE: HonuaErrorCode = "offline.replica-sync.capability";

/** Whether the SDK can carry out a policy without a server. */
export type OfflineReplayConflictPolicyDisposition = "locally-honoured" | "server-adjudicated";

/** What a replay pass does with a conflicted edit under a policy. */
export type OfflineReplayConflictPolicyAction =
  /** Leave the edit `conflicted` for a reviewer; the SDK decides nothing. */
  | "retain-for-review"
  /** Close the conflict against the local edit and abandon it. */
  | "discard-local-edit"
  /** Refuse the pass before it starts. */
  | "refuse";

/**
 * Why a policy falls where it does. Machine-readable on purpose: the prose
 * lives in `docs/offline-regions.md`, which is drift-gated against this table.
 */
export type OfflineReplayConflictPolicyReason =
  /** The complete effect on the queue follows from queue-side state alone. */
  | "queue-side-outcome"
  /** The server already refused this edit; only the server can let it win. */
  | "needs-server-override"
  /** Choosing a winner needs the server's edit time, which the SDK never sees. */
  | "needs-remote-edit-time";

export interface OfflineReplayConflictPolicyRuleV1 {
  readonly policy: ReplicaConflictPolicy;
  readonly disposition: OfflineReplayConflictPolicyDisposition;
  readonly action: OfflineReplayConflictPolicyAction;
  readonly reason: OfflineReplayConflictPolicyReason;
  /** The resolution a pass records automatically, when the action records one. */
  readonly choice?: OfflineEditConflictResolutionChoice;
}

/**
 * The classification, keyed by policy so it is exhaustive at compile time: a
 * new member of the shipped `ReplicaConflictPolicy` union fails the build here
 * rather than falling through to a default the SDK never reasoned about.
 *
 * The rule that decides the two arms is one question — *can the complete effect
 * on the durable edit queue be computed from queue-side state alone?*
 *
 * - `manual` retains the edit for a reviewer. That is the whole of the policy,
 *   and it needs nothing remote.
 * - `server-wins` means the server's committed row stands, so the queued edit
 *   lost and is abandoned. Abandoning an edit needs no remote value. What the
 *   SDK does *not* do under this policy is adopt the server's content into
 *   local state — that needs the remote row, and the queue does not own local
 *   read state at all. The scope is stated rather than glossed.
 * - `client-wins` means the local edit should win, but the server has already
 *   refused it. Making it win requires an override the mutation transport does
 *   not define. Requeuing it locally would be a retry wearing the policy's
 *   name, so the policy is refused instead.
 * - `last-writer-wins` needs both writers' edit times. A conflicted
 *   acknowledgement carries an opaque `ServerGenerationCursor` — an ordering
 *   token, not a comparable clock — so the SDK cannot tell who wrote last.
 */
export const OFFLINE_REPLAY_CONFLICT_POLICIES: Readonly<
  Record<ReplicaConflictPolicy, OfflineReplayConflictPolicyRuleV1>
> = deepFreeze({
  manual: {
    policy: "manual",
    disposition: "locally-honoured",
    action: "retain-for-review",
    reason: "queue-side-outcome",
  },
  "server-wins": {
    policy: "server-wins",
    disposition: "locally-honoured",
    action: "discard-local-edit",
    reason: "queue-side-outcome",
    choice: "accept-server",
  },
  "client-wins": {
    policy: "client-wins",
    disposition: "server-adjudicated",
    action: "refuse",
    reason: "needs-server-override",
  },
  "last-writer-wins": {
    policy: "last-writer-wins",
    disposition: "server-adjudicated",
    action: "refuse",
    reason: "needs-remote-edit-time",
  },
});

/** The rule for a policy, or `undefined` for a value this build does not know. */
export function classifyOfflineReplayConflictPolicy(policy: string): OfflineReplayConflictPolicyRuleV1 | undefined {
  return Object.hasOwn(OFFLINE_REPLAY_CONFLICT_POLICIES, policy)
    ? OFFLINE_REPLAY_CONFLICT_POLICIES[policy as ReplicaConflictPolicy]
    : undefined;
}

/** Why an adjudication was refused. */
export type OfflineConflictAdjudicationCode =
  /** The replica's conflict policy needs a server to decide the outcome. */
  | "server-adjudicated-policy"
  /** The reviewer's resolution needs a server to commit the outcome. */
  | "server-adjudicated-resolution";

/**
 * A conflict outcome the SDK will not decide locally.
 *
 * It names its subject — the {@link ReplicaConflictPolicy} or the
 * {@link ConflictResolutionChoice} — so a caller can report exactly what was
 * asked for and refused, rather than inferring it from a message.
 */
export class HonuaOfflineConflictAdjudicationError extends HonuaSdkError {
  public readonly name = "HonuaOfflineConflictAdjudicationError";
  public readonly code: OfflineConflictAdjudicationCode;
  /** Present for `server-adjudicated-policy`. */
  public readonly policy?: ReplicaConflictPolicy;
  /** Present for `server-adjudicated-resolution`. */
  public readonly choice?: ConflictResolutionChoice;
  public readonly path?: string;

  public constructor(
    code: OfflineConflictAdjudicationCode,
    message: string,
    options: {
      readonly policy?: ReplicaConflictPolicy;
      readonly choice?: ConflictResolutionChoice;
      readonly path?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(ADJUDICATION_ERROR_CODE, message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      context: { reasonCode: code },
    });
    this.code = code;
    this.policy = options.policy;
    this.choice = options.choice;
    this.path = options.path;
  }
}

export function isHonuaOfflineConflictAdjudicationError(
  error: unknown,
): error is HonuaOfflineConflictAdjudicationError {
  return error instanceof HonuaOfflineConflictAdjudicationError;
}

/**
 * Resolve a declared policy to the rule a replay pass will follow, refusing a
 * policy the SDK cannot honour.
 *
 * The refusal happens before any edit is claimed, so a pass either honours the
 * policy it was given for every conflict it meets or does nothing at all. A
 * value outside the shipped union is a malformed caller argument, not a
 * server-adjudicated policy, and is reported as one.
 *
 * @internal
 */
export function requireHonourableOfflineReplayConflictPolicy(
  policy: unknown,
  path: string,
): OfflineReplayConflictPolicyRuleV1 {
  if (typeof policy !== "string") {
    throw new HonuaOfflineEditQueueError("invalid-edit", `${path} must be a ReplicaConflictPolicy.`, { path });
  }
  const rule = classifyOfflineReplayConflictPolicy(policy);
  if (!rule) {
    throw new HonuaOfflineEditQueueError("invalid-edit", `${path} is not a ReplicaConflictPolicy this build knows.`, {
      path,
    });
  }
  if (rule.disposition === "server-adjudicated") {
    throw new HonuaOfflineConflictAdjudicationError(
      "server-adjudicated-policy",
      `The "${rule.policy}" replica conflict policy needs server adjudication, so an offline replay pass cannot honour it. Resolve conflicts through the replica-sync review surface instead.`,
      { policy: rule.policy, path },
    );
  }
  return rule;
}

export interface RecordOfflineConflictResolutionOptions extends OfflineEditQueuePartition {
  /** The conflicted queued edit whose conflict is being closed. */
  readonly editId: `sha256:${string}`;
  /**
   * The reviewer's decision, in the shipped contract's own shape — the value a
   * conflict-review surface already produces. Nothing has to be re-typed
   * between the two vocabularies.
   */
  readonly resolution: SyncConflictResolution;
}

/**
 * Versioned, payload-free account of one recorded resolution.
 *
 * `acknowledgement` is the load-bearing member: the resolution is durable local
 * state, and the queue remains the source of truth for what has and has not
 * been delivered.
 */
export interface OfflineConflictResolutionReceiptV1 {
  readonly kind: typeof HONUA_OFFLINE_CONFLICT_RESOLUTION_KIND;
  readonly version: typeof HONUA_OFFLINE_CONFLICT_RESOLUTION_VERSION;
  readonly editId: `sha256:${string}`;
  readonly conflictId: SyncConflictId;
  readonly choice: OfflineEditConflictResolutionChoice;
  readonly disposition: OfflineEditConflictResolutionDisposition;
  readonly acknowledgement: OfflineEditConflictResolutionAcknowledgement;
  readonly resolvedAt: string;
  /** The queue state the edit now holds: `pending` if requeued, else `cancelled`. */
  readonly state: "pending" | "cancelled";
}

const RESOLUTION_KEYS = new Set(["conflictId", "choice", "mergedAttributes", "mergedGeometry", "note", "resolvedBy"]);
const OPTION_KEYS = new Set(["authorizationScopeDigest", "sourceId", "editId", "resolution"]);
const ACTOR_KEYS = new Set(["id", "displayName", "kind"]);
const LOCAL_CHOICES = new Set<string>(["accept-client", "accept-server", "discard"]);
const CONTRACT_CHOICES = new Set<string>([...LOCAL_CHOICES, "merge"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Record a reviewer's {@link SyncConflictResolution} against the durable queued
 * edit that raised the conflict.
 *
 * The edit transitions per the choice — `accept-client` requeues it as
 * `pending` for another delivery attempt, `accept-server` and `discard` abandon
 * it as `cancelled` — the closure lands in the edit's audit history, and the
 * conflict leaves the record, so no later replay pass and no later status
 * snapshot re-surfaces it.
 *
 * Two inputs are refused rather than approximated:
 *
 * - **`merge`**, and any resolution carrying `mergedAttributes` or
 *   `mergedGeometry`. A merged value would have to replace the queued edit's
 *   payload, and the edit's id is a digest of that payload bound to an
 *   idempotency key the transport may already have seen. Rewriting it locally
 *   would forge a different write under an identity that was promised for
 *   another one.
 * - **`resolvedBy` beyond its id.** A `SyncActor`'s display name and kind are
 *   presentation, and the queue persists identities, not profiles.
 */
export async function recordOfflineConflictResolution(
  queue: OfflineEditQueue,
  options: RecordOfflineConflictResolutionOptions,
): Promise<OfflineConflictResolutionReceiptV1> {
  if (!queue || typeof queue.resolveConflict !== "function") {
    invalid("queue must implement OfflineEditQueue.", "queue");
  }
  const record = argumentRecord(options, "options");
  allowedArgumentKeys(record, OPTION_KEYS, "options");
  const authorizationScopeDigest = argumentDigest(record.authorizationScopeDigest, "options.authorizationScopeDigest");
  const sourceId = argumentString(record.sourceId, "options.sourceId");
  const editId = argumentDigest(record.editId, "options.editId");
  const resolution = captureResolution(record.resolution, "options.resolution");

  const updated = await queue.resolveConflict(
    editId,
    { authorizationScopeDigest, sourceId },
    {
      conflictId: resolution.conflictId,
      choice: resolution.choice,
      ...(resolution.resolvedBy === undefined ? {} : { resolvedBy: resolution.resolvedBy }),
      ...(resolution.note === undefined ? {} : { note: resolution.note }),
    },
  );
  const recorded = updated.conflictResolution;
  if (!recorded || (updated.state !== "pending" && updated.state !== "cancelled")) {
    // A queue implementation that accepted the transition without recording it
    // has not done what this receipt would claim, so nothing is claimed.
    throw new HonuaOfflineEditQueueError(
      "invalid-transition",
      "The queue did not record the resolution against the edit.",
      { editId },
    );
  }
  return Object.freeze({
    kind: HONUA_OFFLINE_CONFLICT_RESOLUTION_KIND,
    version: HONUA_OFFLINE_CONFLICT_RESOLUTION_VERSION,
    editId,
    conflictId: recorded.conflictId,
    choice: recorded.choice,
    disposition: recorded.disposition,
    acknowledgement: recorded.acknowledgement,
    resolvedAt: recorded.resolvedAt,
    state: updated.state,
  });
}

interface CapturedResolution {
  readonly conflictId: string;
  readonly choice: OfflineEditConflictResolutionChoice;
  readonly resolvedBy?: string;
  readonly note?: string;
}

function captureResolution(value: unknown, path: string): CapturedResolution {
  const record = argumentRecord(value, path);
  allowedArgumentKeys(record, RESOLUTION_KEYS, path);
  const conflictId = argumentString(record.conflictId, `${path}.conflictId`);
  const choice = record.choice;
  if (typeof choice !== "string" || !CONTRACT_CHOICES.has(choice)) {
    invalid(`${path}.choice must be a ConflictResolutionChoice.`, `${path}.choice`);
  }
  if (record.mergedAttributes !== undefined || record.mergedGeometry !== undefined || choice === "merge") {
    throw new HonuaOfflineConflictAdjudicationError(
      "server-adjudicated-resolution",
      'A "merge" resolution needs server adjudication: merged content would replace the queued edit\'s payload, ' +
        "and the edit's identity is a digest of that payload bound to an idempotency key. Submit the merge through " +
        "the replica-sync review surface instead.",
      { choice: "merge", path: `${path}.choice` },
    );
  }
  const resolvedBy =
    record.resolvedBy === undefined ? undefined : captureActorId(record.resolvedBy, `${path}.resolvedBy`);
  const note = record.note === undefined ? undefined : argumentString(record.note, `${path}.note`);
  return Object.freeze({
    conflictId,
    choice: choice as OfflineEditConflictResolutionChoice,
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    ...(note === undefined ? {} : { note }),
  });
}

function captureActorId(value: unknown, path: string): string {
  const record = argumentRecord(value, path);
  allowedArgumentKeys(record, ACTOR_KEYS, path);
  return argumentString(record.id, `${path}.id`);
}

function argumentRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be a plain data object.`, path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must use a safe prototype.`, path);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${path} cannot contain symbol keys.`, path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) invalid(`${path}.${key} must be a data property.`, `${path}.${key}`);
    record[key] = descriptor.value;
  }
  return record;
}

function allowedArgumentKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`${path}.${key} is not allowed.`, `${path}.${key}`);
  }
}

function argumentString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > 1024) {
    invalid(`${path} must be a normalized non-empty string of at most 1024 characters.`, path);
  }
  return value;
}

function argumentDigest(value: unknown, path: string): `sha256:${string}` {
  const result = argumentString(value, path);
  if (!DIGEST_PATTERN.test(result)) invalid(`${path} must be a lowercase SHA-256 digest.`, path);
  return result as `sha256:${string}`;
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
