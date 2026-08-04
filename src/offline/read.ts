import type { Query, Result } from "../contract/types.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type { QueryPlanCacheOptions } from "../query-planner/types.js";
import {
  HONUA_OFFLINE_REGION_READ_KIND,
  HONUA_OFFLINE_REGION_READ_VERSION,
  type OfflineRegionReadCacheDecisionV1,
  type OfflineRegionReadGateOptions,
  type OfflineRegionReadProvenanceV1,
  type OfflineRegionStoreReadOptions,
  createOfflineRegionQueryPlanCache,
  createOfflineRegionReadCacheDecision,
  createOfflineRegionReadProvenance,
  deepFreezeRead,
  offlineRegionCachedSnapshotDegradation,
  openOfflineRegionRead,
  pickOfflineRegionAttribution,
  readGatedOfflineRegionResource,
} from "./read-gate.js";
import type { OfflineRegionResourceSelector } from "./selection.js";
import { type OfflineRegionFeatureBatchV1, decodeOfflineRegionFeatureBatch } from "./snapshot.js";
import { HonuaOfflineRegionError, type OfflineRegionManifestV1 } from "./types.js";

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

export interface ReadOfflineRegionQueryOptions<T = Record<string, unknown>>
  extends Omit<OfflineRegionStoreReadOptions, "query"> {
  /** Protocol-neutral query intent. Omitted means the snapshot's own selection. */
  readonly query?: Query<T>;
  /** Discriminator when a selection stores several feature batches. */
  readonly selector?: OfflineRegionResourceSelector;
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
  const gate = await openOfflineRegionRead(inputManifest, options as OfflineRegionReadGateOptions);
  const { resource, bytes } = await readGatedOfflineRegionResource(gate, {
    store: options.store,
    kind: "features",
    ...(options.selector !== undefined ? { selector: options.selector } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const batch = decodeOfflineRegionFeatureBatch<T>(bytes);
  const window = resolveWindow(batch, gate.pagination, resource.id);

  const result: Result<T> = {
    features: window.features,
    exceededTransferLimit: window.exceededTransferLimit,
    ...(batch.totalCount === undefined ? {} : { totalCount: batch.totalCount }),
    ...(batch.fields === undefined ? {} : { fields: batch.fields }),
    degraded: [offlineRegionCachedSnapshotDegradation(gate, "query")],
  };

  return deepFreezeRead({
    kind: HONUA_OFFLINE_REGION_READ_KIND,
    version: HONUA_OFFLINE_REGION_READ_VERSION,
    regionId: gate.manifest.id,
    result,
    cache: createOfflineRegionReadCacheDecision(gate, [resource], batch.exceededTransferLimit ? "partial" : "complete"),
    provenance: createOfflineRegionReadProvenance(gate),
    attribution: pickOfflineRegionAttribution(gate.manifest, [resource]),
    planCache: createOfflineRegionQueryPlanCache(gate.manifest, {
      now: gate.now,
      staleAfterMs: gate.staleAfterMs,
    }),
  });
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
