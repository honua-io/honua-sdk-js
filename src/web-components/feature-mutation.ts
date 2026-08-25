import type { CanonicalFeature, FeatureId, Protocol, SourceId } from "../contract/types.js";

/** Stable discriminator for application-layer feature mutation receipts. */
export const HONUA_FEATURE_MUTATION_RECEIPT_KIND = "honua.feature-mutation-receipt" as const;
export const HONUA_FEATURE_MUTATION_RECEIPT_VERSION = 1 as const;

/** Shared state owners that must reconsider their state after an accepted edit. */
export type HonuaFeatureMutationInvalidationTarget =
  | "query"
  | "feature"
  | "map"
  | "table"
  | "details"
  | "counts"
  | "selection"
  | "tiles"
  | "offline";

export type HonuaFeatureMutationOperation = "create" | "update" | "delete";

/**
 * Payload-free identity and invalidation evidence emitted for an accepted edit.
 *
 * The receipt deliberately carries no authorization material or attachment
 * bytes. Hosts can use `mutationId` to deduplicate a realtime echo and the
 * `invalidates` list to patch or refresh every shared application owner through
 * one bounded reconciliation pass.
 */
export interface HonuaFeatureMutationReceipt<T = Record<string, unknown>> {
  readonly kind: typeof HONUA_FEATURE_MUTATION_RECEIPT_KIND;
  readonly version: typeof HONUA_FEATURE_MUTATION_RECEIPT_VERSION;
  readonly mutationId: string;
  readonly acceptedAt: string;
  readonly sourceId: SourceId;
  readonly protocol: Protocol;
  readonly operation: HonuaFeatureMutationOperation;
  readonly status: "accepted" | "partially-accepted";
  readonly featureId?: FeatureId;
  /** Accepted create/update value. Omitted for deletes. */
  readonly feature?: CanonicalFeature<T>;
  readonly attachmentMutations: number;
  readonly optimistic: {
    readonly applied: boolean;
    readonly rolledBack: boolean;
  };
  readonly invalidates: readonly HonuaFeatureMutationInvalidationTarget[];
  readonly selection: "select" | "clear";
}

export interface CreateHonuaFeatureMutationReceiptInput<T = Record<string, unknown>> {
  readonly mutationId: string;
  readonly acceptedAt: string;
  readonly sourceId: SourceId;
  readonly protocol: Protocol;
  readonly operation: HonuaFeatureMutationOperation;
  readonly status: HonuaFeatureMutationReceipt<T>["status"];
  readonly featureId?: FeatureId;
  readonly feature?: CanonicalFeature<T>;
  readonly attachmentMutations?: number;
  readonly optimistic?: HonuaFeatureMutationReceipt<T>["optimistic"];
}

const INVALIDATION_TARGETS: readonly HonuaFeatureMutationInvalidationTarget[] = Object.freeze([
  "query",
  "feature",
  "map",
  "table",
  "details",
  "counts",
  "selection",
  "tiles",
  "offline",
]);

/** Create an immutable, credential-free application reconciliation receipt. */
export function createHonuaFeatureMutationReceipt<T>(
  input: CreateHonuaFeatureMutationReceiptInput<T>,
): HonuaFeatureMutationReceipt<T> {
  const feature = input.feature === undefined ? undefined : cloneFeature(input.feature);
  return Object.freeze({
    kind: HONUA_FEATURE_MUTATION_RECEIPT_KIND,
    version: HONUA_FEATURE_MUTATION_RECEIPT_VERSION,
    mutationId: requiredText(input.mutationId, "mutationId"),
    acceptedAt: requiredText(input.acceptedAt, "acceptedAt"),
    sourceId: input.sourceId,
    protocol: input.protocol,
    operation: input.operation,
    status: input.status,
    ...(input.featureId !== undefined ? { featureId: input.featureId } : {}),
    ...(feature !== undefined ? { feature } : {}),
    attachmentMutations: input.attachmentMutations ?? 0,
    optimistic: Object.freeze(input.optimistic ?? { applied: false, rolledBack: false }),
    invalidates: INVALIDATION_TARGETS,
    selection: input.operation === "delete" ? "clear" : "select",
  });
}

/** One application state owner participating in mutation reconciliation. */
export interface HonuaFeatureMutationParticipant<T = Record<string, unknown>> {
  readonly target: HonuaFeatureMutationInvalidationTarget;
  apply(receipt: HonuaFeatureMutationReceipt<T>, signal?: AbortSignal): void | Promise<void>;
}

export interface HonuaFeatureMutationReconciliationFailure {
  readonly target: HonuaFeatureMutationInvalidationTarget;
  readonly error: unknown;
}

export interface HonuaFeatureMutationReconciliationResult {
  readonly mutationId: string;
  readonly status: "applied" | "duplicate" | "partial";
  readonly applied: readonly HonuaFeatureMutationInvalidationTarget[];
  readonly failures: readonly HonuaFeatureMutationReconciliationFailure[];
}

export interface HonuaFeatureMutationReconciler<T = Record<string, unknown>> {
  reconcile(
    receipt: HonuaFeatureMutationReceipt<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HonuaFeatureMutationReconciliationResult>;
  clear(mutationId?: string): void;
}

/**
 * Coordinate map/table/details/count/selection invalidation without creating a
 * second application cache. Successful mutation ids are remembered so a
 * realtime echo can be fed through the same path without applying twice.
 */
export function createHonuaFeatureMutationReconciler<T>(
  participants: readonly HonuaFeatureMutationParticipant<T>[],
): HonuaFeatureMutationReconciler<T> {
  const byTarget = new Map(participants.map((participant) => [participant.target, participant] as const));
  const completed = new Set<string>();
  const appliedByMutation = new Map<string, Set<HonuaFeatureMutationInvalidationTarget>>();
  // Deduplication is only as good as the moment it is read. `completed` is
  // written after the last participant resolves and `appliedByMutation` after
  // each one, so a local receipt and its realtime echo entering `reconcile()`
  // together both saw an empty ledger and both applied every participant --
  // the double-apply the ledger exists to prevent. Runs for one mutation id
  // are chained instead, so the second one reads a settled ledger.
  const inFlight = new Map<string, Promise<HonuaFeatureMutationReconciliationResult>>();

  async function reconcileOnce(
    receipt: HonuaFeatureMutationReceipt<T>,
    options: { readonly signal?: AbortSignal },
  ): Promise<HonuaFeatureMutationReconciliationResult> {
    if (completed.has(receipt.mutationId)) {
      return Object.freeze({ mutationId: receipt.mutationId, status: "duplicate", applied: [], failures: [] });
    }
    throwIfAborted(options.signal);
    const previous = appliedByMutation.get(receipt.mutationId) ?? new Set<HonuaFeatureMutationInvalidationTarget>();
    const applied: HonuaFeatureMutationInvalidationTarget[] = [];
    const failures: HonuaFeatureMutationReconciliationFailure[] = [];
    for (const target of receipt.invalidates) {
      const participant = byTarget.get(target);
      if (!participant || previous.has(target)) continue;
      throwIfAborted(options.signal);
      try {
        await participant.apply(receipt, options.signal);
        previous.add(target);
        applied.push(target);
      } catch (error) {
        failures.push({ target, error });
      }
    }
    if (failures.length === 0) {
      completed.add(receipt.mutationId);
      appliedByMutation.delete(receipt.mutationId);
    } else {
      appliedByMutation.set(receipt.mutationId, previous);
    }
    return Object.freeze({
      mutationId: receipt.mutationId,
      status: failures.length === 0 ? "applied" : "partial",
      applied: Object.freeze(applied),
      failures: Object.freeze(failures),
    });
  }

  return {
    async reconcile(receipt, options = {}) {
      const pending = inFlight.get(receipt.mutationId);
      const run = (async () => {
        // A predecessor that rejected -- an aborted caller, say -- still
        // settled the ledger it wrote, and must not reject this caller too.
        if (pending) await pending.catch(() => undefined);
        // Resumes rather than repeats: a fully applied predecessor is reported
        // as `duplicate` here, a partial one leaves its outstanding targets in
        // `appliedByMutation` for this pass to finish.
        return reconcileOnce(receipt, options);
      })();
      inFlight.set(receipt.mutationId, run);
      try {
        return await run;
      } finally {
        if (inFlight.get(receipt.mutationId) === run) inFlight.delete(receipt.mutationId);
      }
    },
    clear(mutationId) {
      if (mutationId === undefined) {
        completed.clear();
        appliedByMutation.clear();
      } else {
        completed.delete(mutationId);
        appliedByMutation.delete(mutationId);
      }
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function cloneFeature<T>(feature: CanonicalFeature<T>): CanonicalFeature<T> {
  return {
    ...(feature.id !== undefined ? { id: feature.id } : {}),
    attributes: { ...(feature.attributes as Record<string, unknown>) } as T,
    ...(feature.geometry !== undefined ? { geometry: feature.geometry === null ? null : { ...feature.geometry } } : {}),
  };
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return normalized;
}
