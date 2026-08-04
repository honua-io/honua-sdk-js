import type { QueryTileKey, QueryTileKeyInput } from "../contract/tiles.js";
import type { Capability, DegradedReason } from "../contract/types.js";
import type { QueryPlanCacheOptions } from "../query-planner/types.js";
import {
  HONUA_OFFLINE_REGION_READ_KIND,
  HONUA_OFFLINE_REGION_READ_VERSION,
  type OfflineRegionReadCacheDecisionV1,
  type OfflineRegionReadGateOptions,
  type OfflineRegionReadGateV1,
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
import {
  type OfflineRegionResourceSelector,
  type OfflineRegionTileSelectorOptions,
  isWgs84LonLatCrs,
  normalizeOfflineRegionTileKey,
  offlineRegionAssetSelector,
  offlineRegionMetadataSelector,
  offlineRegionResourceId,
  offlineRegionTileEnvelope,
  offlineRegionTileSelector,
} from "./selection.js";
import { HonuaOfflineRegionError, type OfflineRegionManifestV1, type OfflineRegionResourceKind } from "./types.js";

/**
 * Serving tiles, assets, and metadata documents from a persisted region.
 *
 * These are the read kinds the region model has always stored but nothing could
 * read back: raster and vector tiles, style/glyph/sprite and attachment assets,
 * and descriptor or discovery documents. They pass the same gate a feature read
 * does — region identity, authorization scope, versions, extent, expiry,
 * content-addressed lookup, integrity — and they answer with opaque bytes and
 * their declared media type. The SDK never re-encodes a tile or an asset, and
 * never synthesizes one it does not hold.
 *
 * @experimental
 */

const JSON_MEDIA_TYPES = new Set([
  "application/json",
  "application/geo+json",
  "application/schema+json",
  "application/vnd.mapbox-vector-tile+json",
  "text/json",
]);

/** Options shared by every non-feature read. */
export interface ReadOfflineRegionResourceOptions extends OfflineRegionStoreReadOptions {
  readonly kind: OfflineRegionResourceKind;
  readonly selector?: OfflineRegionResourceSelector;
  /** Canonical capability the cached bytes stand in for, reported on `degraded`. */
  readonly capability?: Capability;
}

/** One opaque payload served from a persisted region. */
export interface OfflineRegionResourceReadV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_READ_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_READ_VERSION;
  readonly regionId: `sha256:${string}`;
  readonly resourceKind: OfflineRegionResourceKind;
  readonly resourceId: string;
  /** Caller-owned bytes exactly as they were persisted; never re-encoded. */
  readonly bytes: Uint8Array;
  readonly contentType?: string;
  readonly cache: OfflineRegionReadCacheDecisionV1;
  readonly provenance: OfflineRegionReadProvenanceV1;
  readonly attribution: Readonly<Record<string, string>>;
  /**
   * Same never-silently-live discipline a `Result` carries, in the same
   * vocabulary. A binary read has no `Result` to stamp, so the degradation
   * travels here.
   */
  readonly degraded: readonly DegradedReason[];
  readonly planCache: QueryPlanCacheOptions;
}

/** A metadata document, plus its parsed form when it declares a JSON media type. */
export interface OfflineRegionMetadataReadV1 extends OfflineRegionResourceReadV1 {
  readonly resourceKind: "metadata";
  /** Present only for a JSON media type; a non-JSON document stays bytes. */
  readonly document?: unknown;
}

/** A tile payload, plus the canonical coordinate that addressed it. */
export interface OfflineRegionTileReadV1 extends OfflineRegionResourceReadV1 {
  readonly resourceKind: "tile";
  readonly tile: QueryTileKey;
}

export interface ReadOfflineRegionTileOptions extends OfflineRegionStoreReadOptions, OfflineRegionTileSelectorOptions {
  readonly tile: QueryTileKeyInput;
}

export interface ReadOfflineRegionAssetOptions extends OfflineRegionStoreReadOptions {
  /** Stable asset key: a style id, glyph range, sprite name, or attachment id. */
  readonly asset: string;
  /** Canonical capability the cached bytes stand in for. Defaults to `render`. */
  readonly capability?: Capability;
}

export interface ReadOfflineRegionMetadataOptions extends OfflineRegionStoreReadOptions {
  /** Stable document name: a descriptor id, `landing-page`, `collections`, and so on. */
  readonly document: string;
}

/**
 * Resolve the content-addressed identity of one resource without reading it.
 *
 * This is what a host's own {@link OfflineRegionResourceMatcher} calls: the host
 * parses its request URL into a tile key, asset key, or document name, asks for
 * the identity, and hands it to the existing storage-backed fetch handler. The
 * region is still verified, scoped, and expiry-checked here, so a matcher can
 * never produce an identity for a region the caller may not read.
 */
export async function resolveOfflineRegionResourceId(
  inputManifest: OfflineRegionManifestV1,
  options: OfflineRegionReadGateOptions & {
    readonly kind: OfflineRegionResourceKind;
    readonly selector?: OfflineRegionResourceSelector;
  },
): Promise<string> {
  const gate = await openOfflineRegionRead(inputManifest, options);
  return offlineRegionResourceId({
    kind: options.kind,
    selection: gate.selection,
    queryFingerprint: gate.queryFingerprint,
    ...(options.selector !== undefined ? { selector: options.selector } : {}),
  });
}

/**
 * Read one stored resource of any kind from a persisted region.
 *
 * This is the primitive the tile, asset, and metadata reads are written in terms
 * of; use it directly for the `attribution` kind or for a caller-defined selector.
 */
export async function readOfflineRegionResource(
  inputManifest: OfflineRegionManifestV1,
  options: ReadOfflineRegionResourceOptions,
): Promise<OfflineRegionResourceReadV1> {
  const gate = await openOfflineRegionRead(inputManifest, options);
  return completeResourceRead(gate, options, options.kind, options.capability ?? "query");
}

/**
 * Read one tile from a persisted region.
 *
 * Two coverage facts are knowable before any lookup and are reported as such: a
 * zoom outside the region's own `minZoom`/`maxZoom`, and — when the region's CRS
 * is provably WGS84 lon/lat — a tile whose envelope does not meet the region's
 * bounds. Both are `out-of-region`, which is a truer answer than the cache miss
 * that would otherwise follow, and neither touches storage.
 */
export async function readOfflineRegionTile(
  inputManifest: OfflineRegionManifestV1,
  options: ReadOfflineRegionTileOptions,
): Promise<OfflineRegionTileReadV1> {
  const gate = await openOfflineRegionRead(inputManifest, options);
  const tile = normalizeOfflineRegionTileKey(options.tile, options);
  assertTileWithinRegion(gate, tile);
  const selector = offlineRegionTileSelector(tile, {
    ...(options.tileMatrixSetId !== undefined ? { tileMatrixSetId: options.tileMatrixSetId } : {}),
  });
  const read = await completeResourceRead(gate, { ...options, selector }, "tile", "tiles");
  return deepFreezeRead({ ...read, resourceKind: "tile" as const, tile });
}

/** Read one opaque asset — a style document, glyph range, sprite sheet, or attachment. */
export async function readOfflineRegionAsset(
  inputManifest: OfflineRegionManifestV1,
  options: ReadOfflineRegionAssetOptions,
): Promise<OfflineRegionResourceReadV1> {
  const gate = await openOfflineRegionRead(inputManifest, options);
  const selector = offlineRegionAssetSelector(options.asset);
  return completeResourceRead(gate, { ...options, selector }, "asset", options.capability ?? "render");
}

/**
 * Read one metadata document — a source descriptor or a discovery response.
 *
 * A document whose stored media type declares JSON is parsed as well as returned;
 * bytes that verified against their digest but cannot be parsed as the media type
 * they declare are an integrity failure, not a document.
 */
export async function readOfflineRegionMetadata(
  inputManifest: OfflineRegionManifestV1,
  options: ReadOfflineRegionMetadataOptions,
): Promise<OfflineRegionMetadataReadV1> {
  const gate = await openOfflineRegionRead(inputManifest, options);
  const selector = offlineRegionMetadataSelector(options.document);
  const read = await completeResourceRead(gate, { ...options, selector }, "metadata", "query");
  const document = isJsonMediaType(read.contentType) ? parseJsonDocument(read.bytes, read.resourceId) : undefined;
  return deepFreezeRead({
    ...read,
    resourceKind: "metadata" as const,
    ...(document === undefined ? {} : { document }),
  });
}

async function completeResourceRead(
  gate: OfflineRegionReadGateV1,
  options: {
    readonly store: OfflineRegionStoreReadOptions["store"];
    readonly selector?: OfflineRegionResourceSelector;
    readonly signal?: AbortSignal;
  },
  kind: OfflineRegionResourceKind,
  capability: Capability,
): Promise<OfflineRegionResourceReadV1> {
  const { resource, bytes } = await readGatedOfflineRegionResource(gate, {
    store: options.store,
    kind,
    ...(options.selector !== undefined ? { selector: options.selector } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return deepFreezeRead({
    kind: HONUA_OFFLINE_REGION_READ_KIND,
    version: HONUA_OFFLINE_REGION_READ_VERSION,
    regionId: gate.manifest.id,
    resourceKind: kind,
    resourceId: resource.id,
    bytes,
    ...(resource.contentType ? { contentType: resource.contentType } : {}),
    // A single opaque payload is either present in full or absent: there is no
    // partial tile, so completeness is never inferred from byte counts.
    cache: createOfflineRegionReadCacheDecision(gate, [resource], "complete"),
    provenance: createOfflineRegionReadProvenance(gate),
    attribution: pickOfflineRegionAttribution(gate.manifest, [resource]),
    degraded: [offlineRegionCachedSnapshotDegradation(gate, capability)],
    planCache: createOfflineRegionQueryPlanCache(gate.manifest, {
      now: gate.now,
      staleAfterMs: gate.staleAfterMs,
    }),
  });
}

function assertTileWithinRegion(gate: OfflineRegionReadGateV1, tile: QueryTileKey): void {
  const manifest = gate.manifest;
  if (manifest.minZoom !== undefined && tile.z < manifest.minZoom) {
    throw new HonuaOfflineRegionError(
      "out-of-region",
      `Requested zoom ${tile.z} is below this offline region's minimum zoom ${manifest.minZoom}.`,
      { path: "tile.z" },
    );
  }
  if (manifest.maxZoom !== undefined && tile.z > manifest.maxZoom) {
    throw new HonuaOfflineRegionError(
      "out-of-region",
      `Requested zoom ${tile.z} is above this offline region's maximum zoom ${manifest.maxZoom}.`,
      { path: "tile.z" },
    );
  }
  // A CRS the SDK cannot prove is WGS84 lon/lat gets no geometric claim at all;
  // identity still gates the read, so an uncovered tile is simply a miss.
  if (!isWgs84LonLatCrs(manifest.bounds.crs)) return;
  const envelope = offlineRegionTileEnvelope(tile);
  const disjoint =
    envelope.maxX <= manifest.bounds.minX ||
    envelope.minX >= manifest.bounds.maxX ||
    envelope.maxY <= manifest.bounds.minY ||
    envelope.minY >= manifest.bounds.maxY;
  if (disjoint) {
    throw new HonuaOfflineRegionError(
      "out-of-region",
      `Requested tile ${tile.z}/${tile.x}/${tile.y} lies outside this offline region's bounds.`,
      { path: "tile" },
    );
  }
}

function isJsonMediaType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return JSON_MEDIA_TYPES.has(essence) || essence.endsWith("+json");
}

function parseJsonDocument(bytes: Uint8Array, resourceId: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new HonuaOfflineRegionError(
      "integrity-mismatch",
      `Stored metadata document "${resourceId}" is not valid JSON for its declared media type.`,
      { cause, resourceId },
    );
  }
}
