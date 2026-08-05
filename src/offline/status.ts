import type { OfflineEditQueueStateCounts, OfflineQueuedEdit, OfflineQueuedEditState } from "./edit-queue.js";
import {
  type OfflineReplaySyncConflictBinding,
  type OfflineReplaySyncConflictProjectionV1,
  normalizeOfflineReplaySyncConflictBinding,
  projectOfflineReplaySyncConflict,
} from "./replay-conflict.js";
import {
  HONUA_OFFLINE_REGION_DIAGNOSTIC_KIND,
  HONUA_OFFLINE_REGION_DIAGNOSTIC_VERSION,
  HonuaOfflineRegionError,
  type OfflineRegionDiagnosticV1,
} from "./types.js";

/** Stable discriminator and version for composed local-first status snapshots. */
export const HONUA_LOCAL_FIRST_STATUS_KIND = "honua.local-first-status" as const;
export const HONUA_LOCAL_FIRST_STATUS_VERSION = "1.0" as const;

/** Conservative ceilings applied before any input array is copied or sorted. */
export const DEFAULT_LOCAL_FIRST_MAX_REGIONS = 1_000;
export const DEFAULT_LOCAL_FIRST_MAX_EDITS = 10_000;
export const DEFAULT_LOCAL_FIRST_MAX_LISTED_EDIT_IDS = 100;

/**
 * Reachability of the data endpoint, decided by the host. The SDK never reads
 * `navigator.onLine`: link state is not origin reachability, so an `online`
 * state the SDK cannot verify would be a claim rather than an observation.
 */
export type LocalFirstConnectivity = "online" | "offline";

/** The seven states an application renders for a local-first workflow. */
export type LocalFirstState = "online" | "offline" | "stale" | "partial" | "pending" | "conflicted" | "expired";

/** Stable machine explanation of the headline state. */
export type LocalFirstStateReason =
  | "conflicted-edits"
  | "expired-regions"
  | "missing-regions"
  | "partial-regions"
  | "undelivered-edits"
  | "stale-regions"
  | "disconnected"
  | "connected";

export type LocalFirstReadAvailability = "live" | "cached" | "unavailable";
export type LocalFirstFreshness = "fresh" | "stale" | "expired";
export type LocalFirstCompleteness = "complete" | "partial" | "missing";
export type LocalFirstWriteState = "idle" | "pending" | "conflicted";
export type LocalFirstWriteCoverage = "complete" | "sampled";

type DiagnosticCacheReason = OfflineRegionDiagnosticV1["cache"]["reason"];

/** Secret-safe projection of one region diagnostic. */
export interface LocalFirstRegionSummary {
  readonly regionId: string;
  readonly sourceId: string;
  /** Safe to expose; the originating scope fingerprint is never persisted or returned. */
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly state: "offline" | "missing";
  readonly freshness: LocalFirstFreshness;
  readonly completeness: LocalFirstCompleteness;
  readonly reason: DiagnosticCacheReason;
  readonly readable: boolean;
  readonly observedAt: string;
  readonly ageMs: number;
  readonly expiresAt?: string;
  readonly pinned: boolean;
}

export interface LocalFirstReads {
  readonly availability: LocalFirstReadAvailability;
  /** Worst-case across stored regions; `fresh` when nothing is stored. */
  readonly freshness: LocalFirstFreshness;
  /** Worst-case across every supplied region; `missing` when none were supplied. */
  readonly completeness: LocalFirstCompleteness;
  readonly regionCount: number;
  readonly storedRegionCount: number;
  readonly readableRegionCount: number;
  readonly oldestObservedAt?: string;
  readonly earliestExpiresAt?: string;
  readonly regions: readonly LocalFirstRegionSummary[];
}

export interface LocalFirstWrites {
  readonly state: LocalFirstWriteState;
  /**
   * `complete` when authoritative queue totals were supplied; `sampled` when
   * the counts were derived from a bounded `edits` list, which `list` caps at
   * 100 records without a cursor.
   */
  readonly coverage: LocalFirstWriteCoverage;
  readonly counts: OfflineEditQueueStateCounts;
  /** `pending`, `leased`, and `retryable` work: local, durable, unacknowledged. */
  readonly undeliveredCount: number;
  readonly conflictedCount: number;
  /** Bounded, code-unit ordered; `conflictedCount` remains the complete total. */
  readonly conflictedEditIds: readonly `sha256:${string}`[];
  readonly conflictedEditIdsTruncated: boolean;
  /**
   * The same conflicted edits, projected onto the shipped sync-conflict
   * contracts — one entry per `conflictedEditIds` id, in the same order. Empty
   * unless `options.replica` supplied a replica binding, because a conflict
   * cannot be attributed to a replica the SDK never saw. An entry may be a
   * typed refusal; `conflictedEditIdsTruncated` still governs completeness.
   */
  readonly syncConflicts: readonly OfflineReplaySyncConflictProjectionV1[];
  readonly nextRetryAt?: string;
  readonly oldestUndeliveredAt?: string;
}

/** Versioned, immutable, payload-free explanation of one local-first workflow. */
export interface LocalFirstStatusV1 {
  readonly kind: typeof HONUA_LOCAL_FIRST_STATUS_KIND;
  readonly version: typeof HONUA_LOCAL_FIRST_STATUS_VERSION;
  readonly generatedAt: string;
  readonly state: LocalFirstState;
  readonly reason: LocalFirstStateReason;
  readonly connectivity: LocalFirstConnectivity;
  readonly reads: LocalFirstReads;
  readonly writes: LocalFirstWrites;
}

/** Caller limits can tighten, but never raise, the SDK's conservative ceilings. */
export interface LocalFirstStatusLimits {
  readonly maxRegions?: number;
  readonly maxEdits?: number;
  readonly maxListedEditIds?: number;
}

export interface CreateLocalFirstStatusOptions {
  /** Host-owned reachability decision; the SDK never infers it. */
  readonly connectivity: LocalFirstConnectivity;
  /** Explicit clock input so a persisted status stays reproducible. */
  readonly now: Date;
  readonly regions?: readonly OfflineRegionDiagnosticV1[];
  /**
   * Bounded detail sample used for conflicted identities and timing. `list`
   * caps at 100 records with no cursor, so supply `editCounts` whenever a
   * partition can hold more work than the sample can show.
   */
  readonly edits?: readonly OfflineQueuedEdit[];
  /** Authoritative partition totals from `OfflineEditQueue.countByState`. */
  readonly editCounts?: OfflineEditQueueStateCounts;
  /**
   * Replica identity used to project conflicted edits onto the shipped
   * sync-conflict contracts. Omit it and `writes.syncConflicts` stays empty;
   * nothing else about the status changes either way.
   */
  readonly replica?: OfflineReplaySyncConflictBinding;
  readonly limits?: LocalFirstStatusLimits;
}

interface NormalizedLocalFirstLimits {
  readonly maxRegions: number;
  readonly maxEdits: number;
  readonly maxListedEditIds: number;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPTION_KEYS = new Set(["connectivity", "now", "regions", "edits", "editCounts", "replica", "limits"]);
const LIMIT_KEYS = new Set(["maxRegions", "maxEdits", "maxListedEditIds"]);
const DIAGNOSTIC_KEYS = new Set([
  "kind",
  "version",
  "generatedAt",
  "regionId",
  "inventoryRevision",
  "cache",
  "provenance",
  "contents",
  "admission",
  "storage",
]);
const DIAGNOSTIC_CACHE_KEYS = new Set([
  "state",
  "freshness",
  "completeness",
  "reason",
  "readable",
  "observedAt",
  "ageMs",
  "staleAfterMs",
  "expectedLogicalBytes",
  "storedLogicalBytes",
  "lastAccessedAt",
  "expiresAt",
  "pinned",
]);
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
  "conflictResolution",
  "cancellation",
  "audit",
]);
const RETRY_KEYS = new Set(["retryAt", "reasonCode"]);
const CACHE_STATES = new Set(["offline", "missing"]);
const FRESHNESS_VALUES = new Set(["fresh", "stale", "expired"]);
const COMPLETENESS_VALUES = new Set(["complete", "partial", "missing"]);
const CACHE_REASONS = new Set(["offline-entry", "stale-entry", "expired-entry", "partial-entry", "cache-miss"]);
const EDIT_STATES: readonly OfflineQueuedEditState[] = [
  "pending",
  "leased",
  "retryable",
  "applied",
  "conflicted",
  "cancelled",
];
const UNDELIVERED_EDIT_STATES = new Set<OfflineQueuedEditState>(["pending", "leased", "retryable"]);
const FRESHNESS_RANK: Readonly<Record<LocalFirstFreshness, number>> = { fresh: 0, stale: 1, expired: 2 };
const COMPLETENESS_RANK: Readonly<Record<LocalFirstCompleteness, number>> = { complete: 0, partial: 1, missing: 2 };

/**
 * Compose one local-first status from region diagnostics, durable queue state,
 * and a host-supplied connectivity signal.
 *
 * The headline `state` is decided by a total precedence over cache and queue
 * facets, with connectivity supplying only the base case:
 *
 * `conflicted` > `expired` > `partial` > `pending` > `stale` > `offline` > `online`
 *
 * Data problems therefore outrank undelivered work, which outranks mere
 * staleness, which outranks being disconnected. Reads no payload bytes,
 * performs no network or storage I/O, and mutates nothing.
 */
export function createLocalFirstStatus(options: CreateLocalFirstStatusOptions): LocalFirstStatusV1 {
  const record = plainRecord(options, "options");
  allowedKeys(record, OPTION_KEYS, "options");
  const limits = normalizeLimits(record.limits);
  const connectivity = record.connectivity;
  if (connectivity !== "online" && connectivity !== "offline") {
    invalid("options.connectivity must be online or offline.", "options.connectivity");
  }
  const nowMs = record.now instanceof Date ? record.now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) invalid("options.now must be a valid Date.", "options.now");

  const replica =
    record.replica === undefined
      ? undefined
      : normalizeOfflineReplaySyncConflictBinding(record.replica, "options.replica");

  // Only an absent key defaults; an explicit null must not read as "none".
  const reads = summarizeReads(record.regions === undefined ? [] : record.regions, connectivity, limits);
  const writes = summarizeWrites(record.edits === undefined ? [] : record.edits, record.editCounts, limits, replica);
  const { state, reason } = resolveHeadline(reads, writes, connectivity);

  return deepFreeze({
    kind: HONUA_LOCAL_FIRST_STATUS_KIND,
    version: HONUA_LOCAL_FIRST_STATUS_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    state,
    reason,
    connectivity,
    reads,
    writes,
  });
}

function resolveHeadline(
  reads: LocalFirstReads,
  writes: LocalFirstWrites,
  connectivity: LocalFirstConnectivity,
): { readonly state: LocalFirstState; readonly reason: LocalFirstStateReason } {
  if (writes.conflictedCount > 0) return { state: "conflicted", reason: "conflicted-edits" };
  if (reads.freshness === "expired") return { state: "expired", reason: "expired-regions" };
  if (reads.regionCount > 0 && reads.completeness !== "complete") {
    return { state: "partial", reason: reads.completeness === "missing" ? "missing-regions" : "partial-regions" };
  }
  if (writes.undeliveredCount > 0) return { state: "pending", reason: "undelivered-edits" };
  if (reads.freshness === "stale") return { state: "stale", reason: "stale-regions" };
  if (connectivity === "offline") return { state: "offline", reason: "disconnected" };
  return { state: "online", reason: "connected" };
}

function summarizeReads(
  value: unknown,
  connectivity: LocalFirstConnectivity,
  limits: NormalizedLocalFirstLimits,
): LocalFirstReads {
  const input = denseArray(value, "options.regions", limits.maxRegions);
  const seen = new Set<string>();
  const regions: LocalFirstRegionSummary[] = [];
  let storedRegionCount = 0;
  let readableRegionCount = 0;
  let freshness: LocalFirstFreshness = "fresh";
  let completeness: LocalFirstCompleteness | undefined;
  let oldestObservedAt: string | undefined;
  let earliestExpiresAt: string | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const summary = captureRegionSummary(input[index], `options.regions[${index}]`);
    if (seen.has(summary.regionId)) {
      invalid(`Duplicate region diagnostic "${summary.regionId}".`, `options.regions[${index}].regionId`);
    }
    seen.add(summary.regionId);
    regions.push(summary);
    if (summary.state === "offline") {
      storedRegionCount += 1;
      // Freshness describes data that is actually held; a cache miss has no
      // stored observation to age, so it must not colour the aggregate.
      if (FRESHNESS_RANK[summary.freshness] > FRESHNESS_RANK[freshness]) freshness = summary.freshness;
    }
    if (summary.readable) readableRegionCount += 1;
    if (completeness === undefined || COMPLETENESS_RANK[summary.completeness] > COMPLETENESS_RANK[completeness]) {
      completeness = summary.completeness;
    }
    if (oldestObservedAt === undefined || isEarlier(summary.observedAt, oldestObservedAt)) {
      oldestObservedAt = summary.observedAt;
    }
    if (
      summary.expiresAt !== undefined &&
      (earliestExpiresAt === undefined || isEarlier(summary.expiresAt, earliestExpiresAt))
    ) {
      earliestExpiresAt = summary.expiresAt;
    }
  }

  regions.sort((left, right) => compareCodeUnits(left.regionId, right.regionId));
  const availability: LocalFirstReadAvailability =
    connectivity === "online" ? "live" : readableRegionCount > 0 ? "cached" : "unavailable";

  return {
    availability,
    freshness,
    completeness: completeness ?? "missing",
    regionCount: regions.length,
    storedRegionCount,
    readableRegionCount,
    ...(oldestObservedAt === undefined ? {} : { oldestObservedAt }),
    ...(earliestExpiresAt === undefined ? {} : { earliestExpiresAt }),
    regions,
  };
}

function captureRegionSummary(value: unknown, path: string): LocalFirstRegionSummary {
  const record = plainRecord(value, path);
  allowedKeys(record, DIAGNOSTIC_KEYS, path);
  if (record.kind !== HONUA_OFFLINE_REGION_DIAGNOSTIC_KIND) invalid(`${path}.kind is unsupported.`, `${path}.kind`);
  if (record.version !== HONUA_OFFLINE_REGION_DIAGNOSTIC_VERSION) {
    invalid(`${path}.version is unsupported.`, `${path}.version`);
  }
  // Present but never descended into: this projection reads no payload,
  // admission arithmetic, storage estimate, or attribution text.
  plainRecord(record.contents, `${path}.contents`);
  plainRecord(record.admission, `${path}.admission`);
  if (record.storage !== undefined) plainRecord(record.storage, `${path}.storage`);

  const cache = plainRecord(record.cache, `${path}.cache`);
  allowedKeys(cache, DIAGNOSTIC_CACHE_KEYS, `${path}.cache`);
  const provenance = plainRecord(record.provenance, `${path}.provenance`);

  const state = memberOf(cache.state, CACHE_STATES, `${path}.cache.state`) as "offline" | "missing";
  const freshness = memberOf(cache.freshness, FRESHNESS_VALUES, `${path}.cache.freshness`) as LocalFirstFreshness;
  const completeness = memberOf(
    cache.completeness,
    COMPLETENESS_VALUES,
    `${path}.cache.completeness`,
  ) as LocalFirstCompleteness;
  const reason = memberOf(cache.reason, CACHE_REASONS, `${path}.cache.reason`) as DiagnosticCacheReason;
  const readable = requiredBoolean(cache.readable, `${path}.cache.readable`);
  assertCacheFacetsAgree({ state, freshness, completeness, reason, readable }, `${path}.cache`);

  return {
    regionId: requiredString(record.regionId, `${path}.regionId`),
    sourceId: requiredString(provenance.sourceId, `${path}.provenance.sourceId`),
    authorizationScopeDigest: requiredDigest(
      provenance.authorizationScopeDigest,
      `${path}.provenance.authorizationScopeDigest`,
    ),
    state,
    freshness,
    completeness,
    reason,
    readable,
    observedAt: normalizedTimestamp(cache.observedAt, `${path}.cache.observedAt`),
    ageMs: nonNegativeInteger(cache.ageMs, `${path}.cache.ageMs`),
    ...(cache.expiresAt === undefined
      ? {}
      : { expiresAt: normalizedTimestamp(cache.expiresAt, `${path}.cache.expiresAt`) }),
    pinned: requiredBoolean(cache.pinned, `${path}.cache.pinned`),
  };
}

/**
 * `createOfflineRegionDiagnostic` derives every cache facet from one stored
 * entry, so the facets are not independent. Checking each literal in isolation
 * would accept impossible combinations - a `missing` entry claiming to be
 * `complete` and `readable` - and an impossible input would then resolve to a
 * confidently wrong headline. Reject the combination instead.
 */
function assertCacheFacetsAgree(
  facets: {
    readonly state: "offline" | "missing";
    readonly freshness: LocalFirstFreshness;
    readonly completeness: LocalFirstCompleteness;
    readonly reason: DiagnosticCacheReason;
    readonly readable: boolean;
  },
  path: string,
): void {
  const stored = facets.state === "offline";
  if (stored !== (facets.completeness !== "missing")) {
    invalid(`${path}.completeness does not agree with ${path}.state.`, `${path}.completeness`);
  }
  const readable = stored && facets.completeness === "complete" && facets.freshness !== "expired";
  if (facets.readable !== readable) {
    invalid(`${path}.readable does not agree with the reported cache facets.`, `${path}.readable`);
  }
  const reason: DiagnosticCacheReason = !stored
    ? "cache-miss"
    : facets.freshness === "expired"
      ? "expired-entry"
      : facets.completeness === "partial"
        ? "partial-entry"
        : facets.freshness === "stale"
          ? "stale-entry"
          : "offline-entry";
  if (facets.reason !== reason) {
    invalid(`${path}.reason does not agree with the reported cache facets.`, `${path}.reason`);
  }
}

function summarizeWrites(
  value: unknown,
  countsValue: unknown,
  limits: NormalizedLocalFirstLimits,
  replica: OfflineReplaySyncConflictBinding | undefined,
): LocalFirstWrites {
  const input = denseArray(value, "options.edits", limits.maxEdits);
  const counts: Record<OfflineQueuedEditState, number> = {
    pending: 0,
    leased: 0,
    retryable: 0,
    applied: 0,
    conflicted: 0,
    cancelled: 0,
  };
  const seen = new Set<string>();
  const conflictedEditIds: `sha256:${string}`[] = [];
  const projections = new Map<string, OfflineReplaySyncConflictProjectionV1>();
  let nextRetryAt: string | undefined;
  let oldestUndeliveredAt: string | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const path = `options.edits[${index}]`;
    const record = plainRecord(input[index], path);
    allowedKeys(record, QUEUED_EDIT_KEYS, path);
    const id = requiredDigest(record.id, `${path}.id`);
    if (seen.has(id)) invalid(`Duplicate queued edit "${id}".`, `${path}.id`);
    seen.add(id);
    const state = memberOfList(record.state, EDIT_STATES, `${path}.state`);
    counts[state] += 1;
    const createdAt = normalizedTimestamp(record.createdAt, `${path}.createdAt`);

    if (state === "conflicted") {
      conflictedEditIds.push(id);
      // Projected from the same record this summary already validated, so the
      // conflict vocabulary and the conflicted-edit count can never disagree.
      if (replica !== undefined) {
        projections.set(
          id,
          projectOfflineReplaySyncConflict({ edit: record as unknown as OfflineQueuedEdit, replica }),
        );
      }
    }
    if (UNDELIVERED_EDIT_STATES.has(state)) {
      if (oldestUndeliveredAt === undefined || isEarlier(createdAt, oldestUndeliveredAt)) {
        oldestUndeliveredAt = createdAt;
      }
    }
    if (record.retry !== undefined) {
      const retry = plainRecord(record.retry, `${path}.retry`);
      allowedKeys(retry, RETRY_KEYS, `${path}.retry`);
      const retryAt = normalizedTimestamp(retry.retryAt, `${path}.retry.retryAt`);
      if (state === "retryable" && (nextRetryAt === undefined || isEarlier(retryAt, nextRetryAt))) {
        nextRetryAt = retryAt;
      }
    }
  }

  conflictedEditIds.sort(compareCodeUnits);
  // Authoritative totals win. A bounded sample can only ever be a lower bound,
  // and reporting it as the total would let later undelivered work read as idle.
  const authoritative = captureEditCounts(countsValue, counts);
  const totals = authoritative ?? counts;
  const conflictedCount = totals.conflicted;
  const listedConflictedEditIds = conflictedEditIds.slice(0, limits.maxListedEditIds);
  return {
    state: conflictedCount > 0 ? "conflicted" : undeliveredTotal(totals) > 0 ? "pending" : "idle",
    coverage: authoritative ? "complete" : "sampled",
    counts: { ...totals },
    undeliveredCount: undeliveredTotal(totals),
    conflictedCount,
    conflictedEditIds: listedConflictedEditIds,
    conflictedEditIdsTruncated: conflictedCount > Math.min(conflictedEditIds.length, limits.maxListedEditIds),
    syncConflicts: listedConflictedEditIds.map((id) => projections.get(id)).filter(isProjection),
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    ...(oldestUndeliveredAt === undefined ? {} : { oldestUndeliveredAt }),
  };
}

function isProjection(
  value: OfflineReplaySyncConflictProjectionV1 | undefined,
): value is OfflineReplaySyncConflictProjectionV1 {
  return value !== undefined;
}

function undeliveredTotal(counts: Record<OfflineQueuedEditState, number>): number {
  let total = 0;
  for (const state of EDIT_STATES) if (UNDELIVERED_EDIT_STATES.has(state)) total += counts[state];
  return total;
}

function captureEditCounts(
  value: unknown,
  sampled: Record<OfflineQueuedEditState, number>,
): Record<OfflineQueuedEditState, number> | undefined {
  if (value === undefined) return undefined;
  const record = plainRecord(value, "options.editCounts");
  allowedKeys(record, new Set<string>(EDIT_STATES), "options.editCounts");
  const totals = { ...sampled };
  for (const state of EDIT_STATES) {
    const total = nonNegativeInteger(record[state], `options.editCounts.${state}`);
    // A sample that exceeds its own total means the two inputs disagree; refuse
    // rather than publish a status that cannot be true.
    if (total < sampled[state]) {
      invalid(`options.editCounts.${state} is smaller than the supplied sample.`, `options.editCounts.${state}`);
    }
    totals[state] = total;
  }
  return totals;
}

function normalizeLimits(value: unknown): NormalizedLocalFirstLimits {
  if (value === undefined) {
    return {
      maxRegions: DEFAULT_LOCAL_FIRST_MAX_REGIONS,
      maxEdits: DEFAULT_LOCAL_FIRST_MAX_EDITS,
      maxListedEditIds: DEFAULT_LOCAL_FIRST_MAX_LISTED_EDIT_IDS,
    };
  }
  const record = plainRecord(value, "options.limits");
  allowedKeys(record, LIMIT_KEYS, "options.limits");
  return {
    maxRegions: tightened(record.maxRegions, DEFAULT_LOCAL_FIRST_MAX_REGIONS, "options.limits.maxRegions"),
    maxEdits: tightened(record.maxEdits, DEFAULT_LOCAL_FIRST_MAX_EDITS, "options.limits.maxEdits"),
    maxListedEditIds: tightened(
      record.maxListedEditIds,
      DEFAULT_LOCAL_FIRST_MAX_LISTED_EDIT_IDS,
      "options.limits.maxListedEditIds",
    ),
  };
}

function tightened(value: unknown, ceiling: number, path: string): number {
  return Math.min(value === undefined ? ceiling : nonNegativeInteger(value, path), ceiling);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be a plain object.`, path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object.`, path);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${path} must not contain symbol properties.`, path);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid(`${path}.${key} must be a data property.`, `${path}.${key}`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key in record) {
    if (Object.hasOwn(record, key) && !allowed.has(key)) invalid(`${path}.${key} is not supported.`, `${path}.${key}`);
  }
}

function denseArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`, path);
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    invalid(`${path} must be a plain array.`, path);
  }
  if (value.length > maximum) {
    throw new HonuaOfflineRegionError(
      "resource-limit-exceeded",
      `${path} contains ${value.length} entries; maximum is ${maximum}.`,
      { path },
    );
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      invalid(`${path} must not contain named properties.`, `${path}.${key}`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${path} must not contain sparse entries.`, `${path}[${index}]`);
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) {
      invalid(`${path}[${index}] must be a data property.`, `${path}[${index}]`);
    }
  }
  return value;
}

function memberOf(value: unknown, allowed: ReadonlySet<string>, path: string): string {
  if (typeof value !== "string" || !allowed.has(value)) invalid(`${path} is invalid.`, path);
  return value;
}

function memberOfList(
  value: unknown,
  allowed: readonly OfflineQueuedEditState[],
  path: string,
): OfflineQueuedEditState {
  if (typeof value !== "string" || !allowed.includes(value as OfflineQueuedEditState)) {
    invalid(`${path} is invalid.`, path);
  }
  return value as OfflineQueuedEditState;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid(`${path} must be a normalized non-empty string.`, path);
  }
  return value;
}

function requiredDigest(value: unknown, path: string): `sha256:${string}` {
  const result = requiredString(value, path);
  if (!DIGEST_PATTERN.test(result)) invalid(`${path} must be a lowercase SHA-256 digest.`, path);
  return result as `sha256:${string}`;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(`${path} must be a boolean.`, path);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative safe integer.`, path);
  }
  return value;
}

function normalizedTimestamp(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    invalid(`${path} must be a normalized ISO-8601 timestamp.`, path);
  }
  return raw;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Chronological comparison; normalized ISO strings still differ lexically for expanded years. */
function isEarlier(candidate: string, current: string): boolean {
  return Date.parse(candidate) < Date.parse(current);
}

function invalid(message: string, path?: string): never {
  throw new HonuaOfflineRegionError("invalid-manifest", message, { path });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
