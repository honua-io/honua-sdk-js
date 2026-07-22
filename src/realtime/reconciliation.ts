/**
 * Renderer-neutral reconciliation of accepted realtime deltas (issue #559).
 *
 * `reducer.ts` already folds `snapshot`/`upsert`/`delete`/`delta` events into
 * one authoritative `RealtimeFeatureState` (`records`/`tombstones`, keyed by
 * {@link realtimeFeatureKey}) — that state is the accepted realtime store this
 * module builds on. This module adds the piece #556/#557 deliberately left
 * open: turning a `(previous, next, trigger)` state transition into an
 * explicit, identity-stable **patch** (create/update/delete) or **rebuild**
 * (replacement snapshot, schema change, or policy-driven queue overflow)
 * decision, plus the derived-state reconciliation that keeps caches,
 * selection, filters, and viewport deterministic across it:
 *
 * - {@link diffRealtimeFeatureState} — pure REQ-001 identity/patch-rebuild
 *   classification for one event or explicit reset trigger.
 * - {@link createRealtimeReconciler} — stateful REQ-004 policy: bounds the
 *   pending-patch queue and switches `mode` to `"rebuild"` once a single
 *   event or the accumulated queue crosses an explicit threshold, so a
 *   renderer never has to apply an unbounded patch backlog.
 * - {@link realtimeReconciliationVersion} — the resume-position fields a
 *   derived cache should record so it can state exactly which cursor/sequence
 *   it reflects (the accepted store in `store.ts`/`reducer.ts` remains the
 *   sole authority; nothing here re-derives truth from a cache).
 * - {@link createRealtimeReconciledCache} — a REQ-002 generic, renderer-neutral
 *   feature cache driven by reconciliation results; adapt its snapshot into a
 *   `Result<T>`-shaped or `HonuaQueryCache`-backed cache as needed.
 * - {@link reconcileRealtimeKeyedState} / {@link reconcileRealtimeViewport} —
 *   REQ-003 deterministic preservation of any identity-keyed UI state
 *   (selection, an active client-side filter's matched-feature set) and of an
 *   opaque viewport value, both with a structured invalidation reason instead
 *   of a silent reset.
 *
 * `@honua/sdk-js/map`'s `realtime-reconciliation-adapter.ts` is the only
 * place a `RealtimeReconciliationResult` is projected onto MapLibre
 * (`setFeatureState` for `"patch"`, a caller-supplied rebuild callback for
 * `"rebuild"`) — this module never imports `maplibre-gl` and has no
 * renderer-specific dependency (REQ-005). deck.gl/Cesium adapters and the
 * transport implementations that feed `previous`/`next` state are out of
 * scope for #559.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import { type HonuaErrorOptions, HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";
import { realtimeFeatureKey } from "./reducer.js";
import type {
  RealtimeDeletePatch,
  RealtimeFeatureEvent,
  RealtimeFeaturePatch,
  RealtimeFeatureRecord,
  RealtimeFeatureState,
  RealtimeFeatureTombstone,
} from "./types.js";

// ── Errors ───────────────────────────────────────────────────────

/** Error codes raised by the reconciliation core (and, by reuse, its MapLibre adapter). @experimental */
export type RealtimeReconciliationErrorCode = "disposed" | "invalid-option";

/** A stable, machine-readable reconciliation failure. @experimental */
export class HonuaRealtimeReconciliationError extends HonuaSdkError {
  public constructor(
    public readonly code: RealtimeReconciliationErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(REALTIME_RECONCILIATION_ERROR_CODES[code], message, {
      ...options,
      context: mergeHonuaErrorContext(detail, options.context),
    });
    this.name = "HonuaRealtimeReconciliationError";
  }
}

const REALTIME_RECONCILIATION_ERROR_CODES = {
  disposed: "realtime.reconciliation.disposed",
  "invalid-option": "realtime.reconciliation.invalid-option",
} as const satisfies Record<RealtimeReconciliationErrorCode, `realtime.reconciliation.${string}`>;

// ── Identity + patch/rebuild classification (REQ-001) ──────────────

/** Identity-level change classification. @experimental */
export type RealtimeReconciliationChangeKind = "create" | "update" | "delete";

/** One identity-stable change, keyed exactly like the accepted store ({@link realtimeFeatureKey}). @experimental */
export interface RealtimeReconciliationChange<TFeature = unknown> {
  readonly kind: RealtimeReconciliationChangeKind;
  readonly key: string;
  readonly id: FeatureId;
  readonly sourceId?: SourceId;
  /** Present for `"create"`/`"update"`; the accepted store's record (carries `cursor`/`sequence`/`receivedAt`). */
  readonly record?: RealtimeFeatureRecord<TFeature>;
  /** Present for `"delete"`; the accepted store's tombstone, when the reducer still retains it. */
  readonly tombstone?: RealtimeFeatureTombstone;
}

/** Why a reconciliation declared a full reset instead of an incremental patch. @experimental */
export type RealtimeReconciliationResetReasonCode =
  | "replacement-snapshot"
  | "schema-changed"
  | "source-changed"
  | "authorization-scope-changed"
  | "manual";

/**
 * What drove one `(previous, next)` transition: an accepted `RealtimeFeatureEvent`
 * (the common case — `snapshot`/`upsert`/`delete`/`delta`/`heartbeat`/`status`/`error`),
 * or an explicit reset the caller derived from outside the event stream (a
 * `schema-version-changed` / `source-version-changed` / `authorization-scope-changed`
 * checkpoint incompatibility from `resumable.ts`'s `evaluateRealtimeCheckpoint`, or a
 * caller-initiated manual reset). @experimental
 */
export type RealtimeReconciliationTrigger<TFeature = unknown> =
  | { readonly kind: "event"; readonly event: RealtimeFeatureEvent<TFeature> }
  | { readonly kind: "reset"; readonly reason: RealtimeReconciliationResetReasonCode; readonly detail?: string };

/** Pure REQ-001 output: the identity changes for one transition, and whether it was a reset. @experimental */
export interface RealtimeReconciliationDiff<TFeature = unknown> {
  readonly changes: readonly RealtimeReconciliationChange<TFeature>[];
  readonly reset: boolean;
  readonly resetReason?: RealtimeReconciliationResetReasonCode;
  readonly resetDetail?: string;
}

/**
 * Classify one `(previous, next)` accepted-store transition into identity-stable
 * create/update/delete changes, or an explicit reset (replacement snapshot,
 * schema change, source-version change, authorization-scope change, or a
 * caller-initiated manual reset). Pure and side-effect free — `next` must
 * already be the reducer's output for `trigger` (`reduceRealtimeFeatureState`
 * when `trigger.kind === "event"`); this function never re-derives store state.
 *
 * @experimental
 */
export function diffRealtimeFeatureState<TFeature>(
  previous: RealtimeFeatureState<TFeature>,
  next: RealtimeFeatureState<TFeature>,
  trigger: RealtimeReconciliationTrigger<TFeature>,
): RealtimeReconciliationDiff<TFeature> {
  if (trigger.kind === "reset") {
    return Object.freeze({
      changes: recordsAsCreateChanges(next),
      reset: true,
      resetReason: trigger.reason,
      ...(trigger.detail !== undefined ? { resetDetail: trigger.detail } : {}),
    });
  }
  const event = trigger.event;
  switch (event.type) {
    case "snapshot": {
      if (event.replace ?? true) {
        return Object.freeze({
          changes: recordsAsCreateChanges(next),
          reset: true,
          resetReason: "replacement-snapshot",
        });
      }
      return Object.freeze({
        changes: event.features.map((feature) => classifyUpsert(previous, next, feature)),
        reset: false,
      });
    }
    case "upsert":
      return Object.freeze({ changes: [classifyUpsert(previous, next, event.feature)], reset: false });
    case "delete":
      return Object.freeze({ changes: [classifyDelete(next, event)], reset: false });
    case "delta":
      return Object.freeze({
        changes: [
          ...(event.upserts ?? []).map((feature) => classifyUpsert(previous, next, feature)),
          ...(event.deletes ?? []).map((tombstone) => classifyDelete(next, tombstone)),
        ],
        reset: false,
      });
    case "heartbeat":
    case "status":
    case "error":
      return Object.freeze({ changes: [], reset: false });
  }
}

function classifyUpsert<TFeature>(
  previous: RealtimeFeatureState<TFeature>,
  next: RealtimeFeatureState<TFeature>,
  patch: RealtimeFeaturePatch<TFeature>,
): RealtimeReconciliationChange<TFeature> {
  const key = realtimeFeatureKey(patch.sourceId, patch.id);
  const existed = Boolean(previous.records[key]);
  const record = next.records[key];
  return Object.freeze({
    kind: existed ? "update" : "create",
    key,
    id: patch.id,
    ...(patch.sourceId !== undefined ? { sourceId: patch.sourceId } : {}),
    ...(record ? { record } : {}),
  });
}

function classifyDelete<TFeature>(
  next: RealtimeFeatureState<TFeature>,
  input: Pick<RealtimeDeletePatch, "id" | "sourceId">,
): RealtimeReconciliationChange<TFeature> {
  const key = realtimeFeatureKey(input.sourceId, input.id);
  const tombstone = next.tombstones[key];
  return Object.freeze({
    kind: "delete",
    key,
    id: input.id,
    ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    ...(tombstone ? { tombstone } : {}),
  });
}

function recordsAsCreateChanges<TFeature>(
  next: RealtimeFeatureState<TFeature>,
): readonly RealtimeReconciliationChange<TFeature>[] {
  return Object.freeze(
    Object.values(next.records).map((record) =>
      Object.freeze({
        kind: "create" as const,
        key: record.key,
        id: record.id,
        ...(record.sourceId !== undefined ? { sourceId: record.sourceId } : {}),
        record,
      }),
    ),
  );
}

// ── Cache version (derived caches record what they reflect) ────────

/** The resume-position fields a derived cache should record alongside its data. @experimental */
export interface RealtimeReconciliationVersion {
  readonly cursor?: string;
  readonly watermark?: string;
  readonly timestamp?: string;
  readonly sequence?: number;
  readonly deltaToken?: string;
}

/** Project the accepted store's current resume position — what a derived cache built from `state` reflects. @experimental */
export function realtimeReconciliationVersion<TFeature>(
  state: RealtimeFeatureState<TFeature>,
): RealtimeReconciliationVersion {
  return Object.freeze({
    ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
    ...(state.watermark !== undefined ? { watermark: state.watermark } : {}),
    ...(state.timestamp !== undefined ? { timestamp: state.timestamp } : {}),
    ...(state.lastSequence !== undefined ? { sequence: state.lastSequence } : {}),
    ...(state.deltaToken !== undefined ? { deltaToken: state.deltaToken } : {}),
  });
}

// ── Bounded patch queue / rebuild policy (REQ-004) ──────────────────

/** `"patch"` applies `changes` incrementally; `"rebuild"` requires a full re-materialization. @experimental */
export type RealtimeReconciliationMode = "patch" | "rebuild";

/** Why {@link RealtimeReconciliationResult.mode} is `"rebuild"` even when `reset` is `false`. @experimental */
export type RealtimeReconciliationRebuildReason = "reset" | "event-exceeds-patch-bound" | "queue-threshold-exceeded";

/** Result of one {@link RealtimeReconciler.reconcile} call. @experimental */
export interface RealtimeReconciliationResult<TFeature = unknown> {
  readonly mode: RealtimeReconciliationMode;
  readonly rebuildReason?: RealtimeReconciliationRebuildReason;
  /**
   * For `"patch"`, the transition's incremental changes. For `"rebuild"`,
   * always the full accepted store as `"create"` changes (plus the triggering
   * event's `"delete"` changes on a non-reset rebuild), so a derived cache can
   * re-materialize wholesale from the result alone without dropping live
   * features that were not part of the triggering event.
   */
  readonly changes: readonly RealtimeReconciliationChange<TFeature>[];
  readonly version: RealtimeReconciliationVersion;
  readonly reset: boolean;
  readonly resetReason?: RealtimeReconciliationResetReasonCode;
  /** Patches accumulated since the last rebuild, including this result. Always `0` immediately after a rebuild. @experimental */
  readonly pendingPatchCount: number;
}

/** Options for {@link createRealtimeReconciler}. @experimental */
export interface RealtimeReconcilerOptions {
  /** A single event/trigger producing more identity changes than this forces an immediate rebuild. @default 500 */
  readonly maxChangesPerEvent?: number;
  /** Cumulative pending patches (since the last rebuild) that force the next reconciliation to rebuild. @default 2000 */
  readonly rebuildThreshold?: number;
}

/** Stateful REQ-004 policy wrapper around {@link diffRealtimeFeatureState}. @experimental */
export interface RealtimeReconciler<TFeature = unknown> {
  readonly disposed: boolean;
  /** Patches accumulated since the last rebuild. */
  readonly pendingPatchCount: number;
  /**
   * Reconcile one accepted transition. Throws {@link HonuaRealtimeReconciliationError}
   * (`"disposed"`) once {@link RealtimeReconciler.dispose} has been called —
   * a disposed reconciler must never hand a caller another patch.
   */
  reconcile(
    previous: RealtimeFeatureState<TFeature>,
    next: RealtimeFeatureState<TFeature>,
    trigger: RealtimeReconciliationTrigger<TFeature>,
  ): RealtimeReconciliationResult<TFeature>;
  /** Stop accepting reconciliations. Idempotent. */
  dispose(): void;
}

/**
 * Create a bounded, renderer-neutral reconciliation policy: identity changes
 * classify through {@link diffRealtimeFeatureState}; a single oversized event,
 * or an accumulated pending-patch count over `rebuildThreshold`, switches
 * `mode` to `"rebuild"` by explicit policy rather than growing an unbounded
 * patch queue.
 *
 * @experimental
 */
export function createRealtimeReconciler<TFeature = unknown>(
  options: RealtimeReconcilerOptions = {},
): RealtimeReconciler<TFeature> {
  const maxChangesPerEvent = positiveInteger(options.maxChangesPerEvent, 500, "maxChangesPerEvent");
  const rebuildThreshold = positiveInteger(options.rebuildThreshold, 2000, "rebuildThreshold");
  let pending = 0;
  let disposed = false;

  return {
    get disposed() {
      return disposed;
    },
    get pendingPatchCount() {
      return pending;
    },
    reconcile(previous, next, trigger) {
      if (disposed) {
        throw new HonuaRealtimeReconciliationError("disposed", "Cannot reconcile with a disposed realtime reconciler.");
      }
      const diff = diffRealtimeFeatureState(previous, next, trigger);
      const version = realtimeReconciliationVersion(next);
      if (diff.reset) {
        pending = 0;
        return freezeResult({
          mode: "rebuild",
          rebuildReason: "reset",
          changes: diff.changes,
          version,
          reset: true,
          ...(diff.resetReason !== undefined ? { resetReason: diff.resetReason } : {}),
          pendingPatchCount: 0,
        });
      }
      if (diff.changes.length > maxChangesPerEvent) {
        pending = 0;
        return freezeResult({
          mode: "rebuild",
          rebuildReason: "event-exceeds-patch-bound",
          changes: nonResetRebuildChanges(next, diff.changes),
          version,
          reset: false,
          pendingPatchCount: 0,
        });
      }
      pending += diff.changes.length;
      if (pending > rebuildThreshold) {
        pending = 0;
        return freezeResult({
          mode: "rebuild",
          rebuildReason: "queue-threshold-exceeded",
          changes: nonResetRebuildChanges(next, diff.changes),
          version,
          reset: false,
          pendingPatchCount: 0,
        });
      }
      return freezeResult({
        mode: "patch",
        changes: diff.changes,
        version,
        reset: false,
        pendingPatchCount: pending,
      });
    },
    dispose() {
      disposed = true;
      pending = 0;
    },
  };
}

// A rebuild consumer (createRealtimeReconciledCache.apply, a mounted source's
// re-materialization path) treats `changes` as the complete replacement state,
// so a non-reset rebuild must carry the full accepted store — the triggering
// event's diff alone would drop every live feature outside that one event. The
// event's deletes ride along so identity-keyed state (selection, filter
// membership) can still invalidate exactly what this transition removed.
function nonResetRebuildChanges<TFeature>(
  next: RealtimeFeatureState<TFeature>,
  eventChanges: readonly RealtimeReconciliationChange<TFeature>[],
): readonly RealtimeReconciliationChange<TFeature>[] {
  return Object.freeze([...recordsAsCreateChanges(next), ...eventChanges.filter((change) => change.kind === "delete")]);
}

function freezeResult<TFeature>(
  result: Omit<RealtimeReconciliationResult<TFeature>, "changes"> & {
    changes: readonly RealtimeReconciliationChange<TFeature>[];
  },
): RealtimeReconciliationResult<TFeature> {
  return Object.freeze({ ...result, changes: Object.freeze([...result.changes]) });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HonuaRealtimeReconciliationError("invalid-option", `${name} must be a positive safe integer.`, {
      [name]: value,
    });
  }
  return value;
}

// ── Generic query/result cache reconciliation (REQ-002) ─────────────

/** Snapshot returned by {@link RealtimeReconciledCache.snapshot} / `.apply`. @experimental */
export interface RealtimeReconciledCacheSnapshot<TFeature = unknown> {
  /** Insertion-ordered (creation order; unaffected by updates) live features. */
  readonly features: readonly TFeature[];
  /** The cursor/sequence this snapshot reflects — see {@link realtimeReconciliationVersion}. */
  readonly version: RealtimeReconciliationVersion;
}

/** A renderer-neutral, identity-keyed feature cache kept in sync by reconciliation results. @experimental */
export interface RealtimeReconciledCache<TFeature = unknown> {
  readonly disposed: boolean;
  snapshot(): RealtimeReconciledCacheSnapshot<TFeature>;
  /**
   * Apply one {@link RealtimeReconciliationResult}: `"rebuild"` replaces the
   * cache wholesale (creates only — the caller's rebuild path already
   * re-materializes from the authoritative store); `"patch"` applies each
   * change in place. Throws {@link HonuaRealtimeReconciliationError}
   * (`"disposed"`) once disposed.
   */
  apply(result: RealtimeReconciliationResult<TFeature>): RealtimeReconciledCacheSnapshot<TFeature>;
  /** Discard cached data. Idempotent. */
  dispose(): void;
}

/**
 * Create a generic, renderer-neutral cache of live features keyed exactly
 * like the accepted realtime store. Adapt {@link RealtimeReconciledCache.snapshot}
 * into a `Result<T>`-shaped or `HonuaQueryCache`-backed cache entry as needed —
 * this module intentionally does not import either.
 *
 * @experimental
 */
export function createRealtimeReconciledCache<TFeature = unknown>(): RealtimeReconciledCache<TFeature> {
  let order: string[] = [];
  let byKey = new Map<string, TFeature>();
  let version: RealtimeReconciliationVersion = Object.freeze({});
  let disposed = false;

  const snapshotOf = (): RealtimeReconciledCacheSnapshot<TFeature> =>
    Object.freeze({
      features: Object.freeze(order.map((key) => byKey.get(key) as TFeature)),
      version,
    });

  return {
    get disposed() {
      return disposed;
    },
    snapshot: snapshotOf,
    apply(result) {
      if (disposed) {
        throw new HonuaRealtimeReconciliationError("disposed", "Cannot apply to a disposed realtime reconciled cache.");
      }
      if (result.mode === "rebuild") {
        const nextOrder: string[] = [];
        const nextByKey = new Map<string, TFeature>();
        for (const change of result.changes) {
          if (change.kind === "delete" || !change.record) continue;
          nextOrder.push(change.key);
          nextByKey.set(change.key, change.record.feature);
        }
        order = nextOrder;
        byKey = nextByKey;
      } else {
        for (const change of result.changes) {
          if (change.kind === "delete") {
            if (byKey.delete(change.key)) order = order.filter((key) => key !== change.key);
          } else if (change.record) {
            if (!byKey.has(change.key)) order.push(change.key);
            byKey.set(change.key, change.record.feature);
          }
        }
      }
      version = result.version;
      return snapshotOf();
    },
    dispose() {
      disposed = true;
      order = [];
      byKey = new Map();
    },
  };
}

// ── Selection / filter / viewport preservation (REQ-003) ────────────

/** Why an identity-keyed entry (selection, active filter membership) was invalidated instead of preserved. @experimental */
export type RealtimeReconciliationInvalidationReason = "feature-deleted" | "reset" | "schema-changed";

/** One structured invalidation of a previously identity-keyed entry. @experimental */
export interface RealtimeReconciliationInvalidation {
  readonly key: string;
  readonly reason: RealtimeReconciliationInvalidationReason;
}

/** Result of {@link reconcileRealtimeKeyedState}. @experimental */
export interface RealtimeKeyedStateReconciliation {
  readonly next: ReadonlySet<string>;
  readonly invalidations: readonly RealtimeReconciliationInvalidation[];
}

/**
 * Deterministically preserve or invalidate an identity-keyed set of feature
 * keys (a selection, or the matched-key set of an active client-side filter)
 * across one reconciliation result:
 *
 * - `result.reset` (replacement snapshot, schema/source/scope change, or
 *   manual reset): every key is invalidated with reason `"reset"` (or
 *   `"schema-changed"` when that was the reset reason) and `next` is empty —
 *   a rebuild replaces identity wholesale, so no prior key is safe to assume
 *   still exists.
 * - Otherwise: a key backed by a feature the delta deleted is invalidated
 *   with reason `"feature-deleted"`; every other key is preserved unchanged.
 *
 * Reused for both selection and filter membership — both are "a set of
 * feature keys that must stay valid or be explicitly dropped."
 *
 * @experimental
 */
export function reconcileRealtimeKeyedState(
  keys: ReadonlySet<string>,
  result: Pick<RealtimeReconciliationResult<unknown>, "changes" | "reset" | "resetReason">,
): RealtimeKeyedStateReconciliation {
  if (result.reset) {
    const reason: RealtimeReconciliationInvalidationReason =
      result.resetReason === "schema-changed" ? "schema-changed" : "reset";
    return Object.freeze({
      next: Object.freeze(new Set<string>()),
      invalidations: Object.freeze([...keys].map((key) => Object.freeze({ key, reason }))),
    });
  }
  const deletedKeys = new Set<string>();
  for (const change of result.changes) {
    if (change.kind === "delete") deletedKeys.add(change.key);
  }
  if (deletedKeys.size === 0) {
    return Object.freeze({ next: keys, invalidations: Object.freeze([]) });
  }
  const next = new Set<string>();
  const invalidations: RealtimeReconciliationInvalidation[] = [];
  for (const key of keys) {
    if (deletedKeys.has(key)) invalidations.push(Object.freeze({ key, reason: "feature-deleted" }));
    else next.add(key);
  }
  return Object.freeze({ next: Object.freeze(next), invalidations: Object.freeze(invalidations) });
}

/** Result of {@link reconcileRealtimeViewport}. @experimental */
export interface RealtimeViewportReconciliation<TViewport> {
  /** Always the input `viewport`; this module never mutates or resets camera state itself. */
  readonly viewport: TViewport;
  readonly invalidated: boolean;
  readonly reason?: RealtimeReconciliationInvalidationReason;
}

/**
 * Preserve an opaque viewport value across a reconciliation result. The
 * viewport itself is always passed through unchanged (this module never
 * moves a camera); `invalidated` is `true` only on `result.reset`, so a
 * caller can decide whether to refit bounds — deterministic, and never a
 * silent no-op on a schema/replacement-snapshot reset.
 *
 * @experimental
 */
export function reconcileRealtimeViewport<TViewport>(
  viewport: TViewport,
  result: Pick<RealtimeReconciliationResult<unknown>, "reset" | "resetReason">,
): RealtimeViewportReconciliation<TViewport> {
  if (!result.reset) return Object.freeze({ viewport, invalidated: false });
  return Object.freeze({
    viewport,
    invalidated: true,
    reason: result.resetReason === "schema-changed" ? "schema-changed" : "reset",
  });
}
