import type { DegradedReason, Query, Result } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type { QueryPlanCacheOptions } from "../query-planner/types.js";
import { sha256 } from "./digest.js";
import { verifyOfflineRegionManifest } from "./region.js";
import {
  OFFLINE_REGION_PROTOCOL,
  type OfflineRegionResourceSelector,
  type OfflineRegionSelectionIdentityV1,
  canonicalizeOfflineRegionQuery,
  compareOfflineRegionBounds,
  offlineRegionAuthorizationScopeDigest,
  offlineRegionQueryFingerprint,
  offlineRegionResourceId,
} from "./selection.js";
import { type OfflineRegionFeatureBatchV1, decodeOfflineRegionFeatureBatch } from "./snapshot.js";
import {
  HonuaOfflineRegionError,
  type OfflineRegionBounds,
  type OfflineRegionManifestV1,
  type OfflineRegionObservation,
  type OfflineRegionResourceV1,
  type OfflineRegionStore,
  type OfflineRegionValidator,
} from "./types.js";

/**
 * Answering a protocol-neutral `Query` from a persisted region.
 *
 * The read path is deliberately narrow. It replays the snapshot a selection
 * captured and refines only the pagination window, because that is the one
 * refinement a stored batch can honour exactly. Everything else fails closed: a
 * construct the region cannot answer raises `HonuaCapabilityNotSupportedError`,
 * and a selection the region does not cover raises a typed cache miss. Nothing
 * here reaches the network, revalidates, or widens a query, and no result is ever
 * presented as live.
 *
 * @experimental
 */

export const HONUA_OFFLINE_REGION_READ_KIND = "honua.offline-region-read" as const;
export const HONUA_OFFLINE_REGION_READ_VERSION = "1.0" as const;

/** Default age at which a region's observation is reported stale. */
export const DEFAULT_OFFLINE_REGION_READ_STALE_AFTER_MS = 15 * 60 * 1000;

export interface ReadOfflineRegionQueryOptions<T = Record<string, unknown>> {
  readonly store: OfflineRegionStore;
  /**
   * The caller's current authorization-scope partition input. Its digest must
   * equal the region's, so a scope change can never serve another principal's
   * cached bytes.
   */
  readonly authorizationScopeFingerprint: string;
  /** Protocol-neutral query intent. Omitted means the snapshot's own selection. */
  readonly query?: Query<T>;
  /** Extent the caller is asking about. Must equal the region's own extent. */
  readonly bounds?: OfflineRegionBounds;
  /** Versions the caller expects. A drift fails closed instead of serving stale schema. */
  readonly expect?: {
    readonly sourceVersion?: string;
    readonly schemaVersion?: string;
    readonly planVersion?: string;
  };
  /** Discriminator when a selection stores several feature batches. */
  readonly selector?: OfflineRegionResourceSelector;
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
  readonly signal?: AbortSignal;
}

export type OfflineRegionReadFreshness = "fresh" | "stale";

/**
 * What the persistent cache did, and why.
 *
 * `regionId` is the region manifest's own content digest, so a result served
 * from storage is traceable to the exact snapshot identity that produced it.
 */
export interface OfflineRegionReadCacheDecisionV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_READ_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_READ_VERSION;
  readonly policy: "prefer-cache";
  readonly action: "reuse";
  readonly state: "offline";
  readonly freshness: OfflineRegionReadFreshness;
  readonly completeness: "complete" | "partial";
  readonly reason: "offline-entry" | "stale-entry";
  /** Region manifest identity. Binds this answer to one snapshot. */
  readonly regionId: `sha256:${string}`;
  readonly queryFingerprint: `sha256:${string}`;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly observedAt: string;
  readonly ageMs: number;
  readonly staleAfterMs: number;
  /** Exactly which stored resources answered this read. */
  readonly resources: readonly {
    readonly id: string;
    readonly kind: OfflineRegionResourceV1["kind"];
    readonly byteLength: number;
    readonly integrity: `sha256:${string}`;
  }[];
}

/** Credential-free provenance travelling with a result served from storage. */
export interface OfflineRegionReadProvenanceV1 {
  readonly sourceId: string;
  readonly endpoint: string;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planVersion: string;
  readonly observation: OfflineRegionObservation;
  readonly validator?: OfflineRegionValidator;
}

export interface OfflineRegionQueryReadV1<T = Record<string, unknown>> {
  readonly kind: typeof HONUA_OFFLINE_REGION_READ_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_READ_VERSION;
  readonly regionId: `sha256:${string}`;
  readonly result: Result<T>;
  readonly cache: OfflineRegionReadCacheDecisionV1;
  readonly provenance: OfflineRegionReadProvenanceV1;
  /** Attribution for the resources that answered the read. */
  readonly attribution: Readonly<Record<string, string>>;
  /**
   * Cache input for `explainQuery()`, so the query plan reports this read.
   * A fresh region carries its manifest identity as the plan's validator; a stale
   * one deliberately carries none, because a region can be reported stale but
   * never revalidated without the network the caller does not have.
   */
  readonly planCache: QueryPlanCacheOptions;
}

/**
 * Answer `query` from a persisted region, or fail closed.
 *
 * Order matters: the region's identity, then the caller's authorization scope,
 * then version expectations, then the extent, then the query's constructs, then
 * expiry — each failing with the narrowest true reason before any bytes are read.
 */
export async function readOfflineRegionQuery<T = Record<string, unknown>>(
  inputManifest: OfflineRegionManifestV1,
  options: ReadOfflineRegionQueryOptions<T>,
): Promise<OfflineRegionQueryReadV1<T>> {
  throwIfAborted(options.signal);
  const manifest = await verifyOfflineRegionManifest(inputManifest);
  const sourceId = manifest.source.id;

  const authorizationScopeDigest = await offlineRegionAuthorizationScopeDigest(options.authorizationScopeFingerprint);
  if (authorizationScopeDigest !== manifest.source.authorizationScopeDigest) {
    // The single most important invariant: a scope change never reads another
    // principal's cached bytes, and the failure names no scope material.
    throw new HonuaOfflineRegionError(
      "scope-mismatch",
      "Offline region belongs to a different authorization scope than this read.",
      { path: "authorizationScopeFingerprint" },
    );
  }

  assertExpectedVersion(options.expect?.sourceVersion, manifest.source.sourceVersion, "sourceVersion");
  assertExpectedVersion(options.expect?.schemaVersion, manifest.source.schemaVersion, "schemaVersion");
  assertExpectedVersion(options.expect?.planVersion, manifest.source.planVersion, "planVersion");

  if (options.bounds !== undefined) {
    const relation = compareOfflineRegionBounds(options.bounds, manifest.bounds);
    if (relation === "outside") {
      throw new HonuaOfflineRegionError(
        "out-of-region",
        "Requested extent is not covered by this offline region's bounds.",
        { path: "bounds" },
      );
    }
    if (relation === "contained") {
      // Narrowing to a sub-extent means evaluating a spatial predicate over the
      // stored batch. Returning the wider snapshot instead would silently widen
      // the caller's question, so the read refuses rather than approximates.
      throw new HonuaCapabilityNotSupportedError("querySubExtent", OFFLINE_REGION_PROTOCOL, sourceId);
    }
  }

  const scope = canonicalizeOfflineRegionQuery(options.query, sourceId);
  const queryFingerprint = await offlineRegionQueryFingerprint(scope.canonical);

  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw invalid("now must produce a valid Date.", "now");
  if (manifest.expiresAt !== undefined && Date.parse(manifest.expiresAt) <= nowMs) {
    throw new HonuaOfflineRegionError("expired", `Offline region "${manifest.id}" has expired.`, { path: "expiresAt" });
  }

  const selection: OfflineRegionSelectionIdentityV1 = {
    sourceId,
    endpoint: manifest.source.endpoint,
    authorizationScopeDigest,
    sourceVersion: manifest.source.sourceVersion,
    schemaVersion: manifest.source.schemaVersion,
    planVersion: manifest.source.planVersion,
    bounds: manifest.bounds,
    ...(manifest.minZoom !== undefined ? { minZoom: manifest.minZoom } : {}),
    ...(manifest.maxZoom !== undefined ? { maxZoom: manifest.maxZoom } : {}),
  };
  const resourceId = await offlineRegionResourceId({
    kind: "features",
    selection,
    queryFingerprint,
    ...(options.selector !== undefined ? { selector: options.selector } : {}),
  });

  throwIfAborted(options.signal);
  let read: Awaited<ReturnType<OfflineRegionStore["readResource"]>>;
  try {
    read = await options.store.readResource(manifest.id, resourceId);
  } catch (cause) {
    if (cause instanceof HonuaOfflineRegionError) throw cause;
    throw new HonuaOfflineRegionError("store-failed", "Failed to read the offline region resource.", { cause });
  }
  if (!read) {
    throw new HonuaOfflineRegionError(
      "cache-miss",
      "This offline region holds no stored answer for the requested selection.",
      { resourceId },
    );
  }
  if (read.regionId !== manifest.id || read.resource.id !== resourceId) {
    throw new HonuaOfflineRegionError("store-failed", "Offline region store returned a foreign resource.", {
      resourceId,
    });
  }
  if (read.resource.kind !== "features") {
    throw new HonuaOfflineRegionError("cache-miss", "Stored resource for this selection is not a feature batch.", {
      resourceId,
    });
  }

  const bytes = read.bytes;
  if (bytes.byteLength !== read.resource.byteLength || (await sha256(bytes)) !== read.resource.integrity) {
    throw new HonuaOfflineRegionError("integrity-mismatch", `Stored resource "${resourceId}" failed verification.`, {
      resourceId,
    });
  }
  const batch = decodeOfflineRegionFeatureBatch<T>(bytes);
  const window = resolveWindow(batch, scope.pagination, resourceId);

  const observedAtMs = Date.parse(manifest.source.observation.observedAt);
  const ageMs = Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : 0;
  const staleAfterMs = normalizeStaleAfterMs(options.staleAfterMs);
  const freshness: OfflineRegionReadFreshness = ageMs >= staleAfterMs ? "stale" : "fresh";
  const attribution = pickAttribution(manifest, read.resource);

  const result: Result<T> = {
    features: window.features,
    exceededTransferLimit: window.exceededTransferLimit,
    ...(batch.totalCount === undefined ? {} : { totalCount: batch.totalCount }),
    ...(batch.fields === undefined ? {} : { fields: batch.fields }),
    degraded: [cachedSnapshotDegradation(manifest, sourceId, freshness, ageMs)],
  };

  const cache: OfflineRegionReadCacheDecisionV1 = {
    kind: HONUA_OFFLINE_REGION_READ_KIND,
    version: HONUA_OFFLINE_REGION_READ_VERSION,
    policy: "prefer-cache",
    action: "reuse",
    state: "offline",
    freshness,
    completeness: batch.exceededTransferLimit ? "partial" : "complete",
    reason: freshness === "stale" ? "stale-entry" : "offline-entry",
    regionId: manifest.id,
    queryFingerprint,
    authorizationScopeDigest,
    observedAt: manifest.source.observation.observedAt,
    ageMs,
    staleAfterMs,
    resources: [
      {
        id: read.resource.id,
        kind: read.resource.kind,
        byteLength: read.resource.byteLength,
        integrity: read.resource.integrity,
      },
    ],
  };

  return deepFreeze({
    kind: HONUA_OFFLINE_REGION_READ_KIND,
    version: HONUA_OFFLINE_REGION_READ_VERSION,
    regionId: manifest.id,
    result,
    cache,
    provenance: {
      sourceId,
      endpoint: manifest.source.endpoint,
      authorizationScopeDigest,
      sourceVersion: manifest.source.sourceVersion,
      schemaVersion: manifest.source.schemaVersion,
      planVersion: manifest.source.planVersion,
      observation: manifest.source.observation,
      ...(manifest.source.validator ? { validator: manifest.source.validator } : {}),
    },
    attribution,
    planCache: createOfflineRegionQueryPlanCache(manifest, { now, staleAfterMs }),
  });
}

/**
 * Cache input binding a query plan to a persisted region.
 *
 * A fresh region carries its manifest identity as a `fingerprint` validator, so
 * the plan's own fingerprint changes when the region does. A stale region carries
 * freshness only: reporting a validator would claim a revalidation the offline
 * read will never perform.
 */
export function createOfflineRegionQueryPlanCache(
  manifest: OfflineRegionManifestV1,
  options: { readonly now?: Date; readonly staleAfterMs?: number } = {},
): QueryPlanCacheOptions {
  const nowMs = (options.now ?? new Date()).getTime();
  const observedAtMs = Date.parse(manifest.source?.observation?.observedAt ?? "");
  const staleAfterMs = normalizeStaleAfterMs(options.staleAfterMs);
  const ageMs = Number.isFinite(observedAtMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - observedAtMs) : 0;
  if (ageMs >= staleAfterMs) return { policy: "prefer-cache", freshness: "stale" };
  return {
    policy: "prefer-cache",
    freshness: "fresh",
    validator: { kind: "fingerprint", fingerprint: manifest.id },
  };
}

interface ResolvedWindow<T> {
  readonly features: readonly HonuaTypedFeature<T>[];
  readonly exceededTransferLimit: boolean;
}

/**
 * Slice the stored batch to the requested window, or refuse.
 *
 * A stored batch covers `[offset, offset + features.length)` and, when it did not
 * exceed its transfer limit, everything after that too — because nothing else
 * matched. A request outside that coverage is a miss, never a short answer.
 */
function resolveWindow<T>(
  batch: OfflineRegionFeatureBatchV1<T>,
  requested: { readonly offset: number; readonly limit?: number },
  resourceId: string,
): ResolvedWindow<T> {
  const storedStart = batch.pagination.offset;
  const storedEnd = storedStart + batch.features.length;
  const requestedStart = requested.offset;
  const requestedEnd = requested.limit === undefined ? Number.POSITIVE_INFINITY : requestedStart + requested.limit;
  const coveredEnd = batch.exceededTransferLimit ? storedEnd : Number.POSITIVE_INFINITY;
  if (requestedStart < storedStart || requestedEnd > coveredEnd) {
    throw new HonuaOfflineRegionError(
      "cache-miss",
      "Requested page is outside the window this offline region captured.",
      { resourceId },
    );
  }
  const sliceStart = Math.min(requestedStart - storedStart, batch.features.length);
  const sliceEnd =
    requested.limit === undefined
      ? batch.features.length
      : Math.min(sliceStart + requested.limit, batch.features.length);
  const features = batch.features.slice(sliceStart, sliceEnd);
  const moreInBatch = sliceEnd < batch.features.length;
  return { features, exceededTransferLimit: moreInBatch || batch.exceededTransferLimit };
}

/**
 * Every offline answer is a snapshot, so every offline answer says so.
 *
 * A caller that checks `Result.degraded` before treating numbers as authoritative
 * learns that this result was observed at a past instant rather than read live.
 */
function cachedSnapshotDegradation(
  manifest: OfflineRegionManifestV1,
  sourceId: string,
  freshness: OfflineRegionReadFreshness,
  ageMs: number,
): DegradedReason {
  return {
    capability: "query",
    reason: `Served from persisted offline region ${manifest.id} observed at ${manifest.source.observation.observedAt} (${freshness}, ${ageMs}ms old). This is a cached snapshot, not a live read.`,
    sourceId,
  };
}

function pickAttribution(
  manifest: OfflineRegionManifestV1,
  resource: OfflineRegionResourceV1,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of resource.attributionIds) {
    const text = manifest.attribution[id];
    if (typeof text === "string") out[id] = text;
  }
  return out;
}

function assertExpectedVersion(expected: string | undefined, actual: string, path: string): void {
  if (expected === undefined || expected === actual) return;
  throw new HonuaOfflineRegionError(
    "out-of-region",
    `Offline region was captured at a different ${path} than this read expects.`,
    { path },
  );
}

function normalizeStaleAfterMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OFFLINE_REGION_READ_STALE_AFTER_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid("staleAfterMs must be a non-negative safe integer.", "staleAfterMs");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new HonuaOfflineRegionError("aborted", "Offline region read was aborted.", { cause: signal.reason });
  }
}

function invalid(message: string, path: string): HonuaOfflineRegionError {
  return new HonuaOfflineRegionError("invalid-manifest", message, { path });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
