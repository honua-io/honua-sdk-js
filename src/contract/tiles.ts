/**
 * Dynamic vector/query tile contract primitives.
 *
 * The runtime helpers in `src/runtime/query-tiles.ts` use these types to
 * describe query-backed vector tile sources without tying the contract to
 * MapLibre. The descriptor is intentionally serializable except for the
 * optional feature identity hook.
 *
 * @module
 */

import type { HonuaTypedFeature } from "../core/types.js";
import {
  analyticsSourceId,
  buildAnalyticsSourceCacheKey,
  isAnalyticsSourceDescriptor,
  normalizeAnalyticsSourceDescriptor,
} from "./analytics-sources.js";
import type { AnalyticsSourceDescriptor } from "./analytics-sources.js";
import type { FeatureId, Protocol, Query, Result, Source, SourceDescriptor, SourceId } from "./types.js";

export type QueryTileFormat = "mvt" | "geojson";
export type QueryTileScheme = "xyz" | "tms";
export type QueryTileFallbackMode = "disabled" | "query-bbox" | "geojson-source";
export type QueryTileServerRouteKind = "tilejson" | "tile" | "feature-detail";
export type QueryTileServerDegradationSeverity = "info" | "warning" | "error";
export type QueryTileServerDegradationCode =
  | "empty-tile"
  | "geometry-simplified"
  | "max-features-exceeded"
  | "partial-results"
  | "fallback-query"
  | "stale-cache"
  | "unsupported-sr"
  | "authorization-filtered";
export type QueryTileServerErrorCode =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "not-acceptable"
  | "unsupported-sr"
  | "tile-out-of-range"
  | "max-features-exceeded"
  | "timeout"
  | "rate-limited"
  | "server-error"
  | "unavailable";

export const QUERY_TILE_SERVER_CONTRACT_VERSION = 1;
export const QUERY_TILE_SERVER_ROUTE_PREFIX = "query-tiles";
export const QUERY_TILE_SERVER_SOURCE_ROUTE_TEMPLATE = "sources/{sourceId}";
export const QUERY_TILE_SERVER_TILEJSON_ROUTE_TEMPLATE = `${QUERY_TILE_SERVER_SOURCE_ROUTE_TEMPLATE}/tilejson.json`;
export const QUERY_TILE_SERVER_TILE_ROUTE_TEMPLATE = `${QUERY_TILE_SERVER_SOURCE_ROUTE_TEMPLATE}/tiles/{z}/{x}/{y}.{format}`;
export const QUERY_TILE_SERVER_FEATURE_DETAIL_ROUTE_TEMPLATE = `${QUERY_TILE_SERVER_SOURCE_ROUTE_TEMPLATE}/features/{featureId}`;

export const QUERY_TILE_SERVER_RESPONSE_HEADERS = {
  cacheControl: "Cache-Control",
  etag: "ETag",
  lastModified: "Last-Modified",
  vary: "Vary",
  sourceVersion: "X-Honua-Source-Version",
  featureCount: "X-Honua-Feature-Count",
  maxFeatures: "X-Honua-Max-Features",
  degraded: "X-Honua-Degraded",
} as const;

/** Slippy-map tile coordinate in XYZ order. */
export interface QueryTileKey {
  z: number;
  x: number;
  y: number;
}

/** Accepts XYZ field names plus OGC-style tile matrix aliases. */
export interface QueryTileKeyInput {
  z?: number | string;
  x?: number | string;
  y?: number | string;
  tileMatrix?: number | string;
  tileCol?: number | string;
  tileRow?: number | string;
}

/** Tile endpoint hints. `urlTemplate` wins over `tilejsonUrl` and `baseUrl`. */
export interface QueryTileEndpointDescriptor {
  /** URL template containing `{z}`, `{x}`, and `{y}` placeholders. */
  urlTemplate?: string;
  /** Server-hosted TileJSON URL, if discovery is already available. */
  tilejsonUrl?: string;
  /**
   * Query-tile service root used when constructing a URL template. The
   * canonical server route under this root is
   * `sources/{sourceId}/tiles/{z}/{x}/{y}.mvt`.
   */
  baseUrl?: string;
  /** Relative tile path under `baseUrl`. Defaults to the canonical source tile route. */
  path?: string;
}

/** SQL/query projection that must participate in cache identity. */
export interface QueryTileProjectionDescriptor {
  /** Fields needed by styling and interactions. */
  fields?: readonly string[];
  /** Whether tile payloads should include feature geometry. Defaults to true. */
  returnGeometry?: boolean;
  /** Optional server simplification tolerance hint. */
  simplifyTolerance?: number;
}

/** Caller-controlled cache dimensions beyond the tile coordinate. */
export interface QueryTileCacheIdentityDescriptor {
  /** Server-side source data version, etag, cursor, or materialized view id. */
  sourceVersion?: string;
  /** Authorization partition, role set, tenant id, or other non-secret auth scope id. */
  authorizationScope?: string;
  /** Style-relevant filters that alter which features are rendered. */
  styleFilters?: unknown;
  /** Extra stable dimensions owned by an adapter. */
  extra?: Readonly<Record<string, unknown>>;
}

export interface QueryTileCachePolicy {
  /** Maximum cached tile payloads. Defaults are runtime-controller specific. */
  maxEntries?: number;
  /** Time-to-live in milliseconds. Omit for no TTL. */
  ttlMs?: number;
  /** Cache key dimensions that are not already present on the descriptor. */
  key?: QueryTileCacheIdentityDescriptor;
}

export interface QueryTileFallbackPolicy {
  mode: QueryTileFallbackMode;
  reason?: string;
}

export interface QueryTileSpatialReferenceDescriptor {
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
  authority?: string;
}

export type QueryTileSpatialReference = number | string | QueryTileSpatialReferenceDescriptor;

export interface QueryTileExtentDescriptor {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: QueryTileSpatialReference;
}

export interface QueryTileServerRequestParameters {
  where?: string;
  outFields?: string | readonly string[];
  returnGeometry?: boolean;
  outSr?: string | number;
  tileMatrixSet?: string;
  extent?: readonly [number, number, number, number] | QueryTileExtentDescriptor;
  extentSr?: string | number;
  projection?: string | readonly string[];
  projectionReturnGeometry?: boolean;
  simplifyTolerance?: number;
  maxFeatures?: number;
  cacheKey?: string;
  cacheBust?: string;
}

export interface QueryTileServerRouteOptions<T = Record<string, unknown>> {
  baseUrl?: string;
  routePrefix?: string;
  sourceId: SourceId;
  tileKey?: QueryTileKeyInput;
  featureId?: FeatureId;
  format?: QueryTileFormat;
  query?: Omit<Query<T>, "signal">;
  projection?: QueryTileProjectionDescriptor;
  params?: QueryTileServerRequestParameters;
  extraParams?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface QueryTileServerCacheValidators {
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  expires?: string;
  vary?: string;
  sourceVersion?: string;
}

export interface QueryTileServerCachePolicyDescriptor {
  validators: readonly ("etag" | "last-modified")[];
  cacheControl?: string;
  vary?: readonly string[];
  sourceVersion?: string;
}

export interface QueryTileServerLimitDescriptor {
  maxFeaturesPerTile?: number;
  maxFeaturesPerDetail?: number;
  defaultSimplifyTolerance?: number;
  maxSimplifyTolerance?: number;
}

export interface QueryTileServerFeatureIdentityDescriptor {
  sourceId: SourceId;
  idProperty: string | readonly string[];
  sourceLayer?: string;
  sourceIdProperty?: string;
  sourceLayerProperty?: string;
  promoteId?: string | Readonly<Record<string, string>>;
  detailUrlTemplate?: string;
}

export interface QueryTileServerDegradation {
  code: QueryTileServerDegradationCode;
  severity: QueryTileServerDegradationSeverity;
  message: string;
  sourceId?: SourceId;
  tileKey?: QueryTileKey;
  maxFeatures?: number;
  returnedFeatures?: number;
  omittedFeatures?: number;
  simplifyTolerance?: number;
  retryAfterMs?: number;
  details?: Readonly<Record<string, unknown>>;
}

export interface QueryTileServerTileJsonMetadata {
  contractVersion: number;
  sourceId: SourceId;
  tileMatrixSet: string;
  format: QueryTileFormat;
  spatialReference: QueryTileSpatialReference;
  extent?: QueryTileExtentDescriptor;
  requestParameters?: QueryTileServerRequestParameters;
  featureIdentity: QueryTileServerFeatureIdentityDescriptor;
  detailUrlTemplate: string;
  cache?: QueryTileServerCachePolicyDescriptor;
  limits?: QueryTileServerLimitDescriptor;
  degraded?: readonly QueryTileServerDegradation[];
}

export interface QueryTileFeatureDetailResponse<T = Record<string, unknown>> {
  contractVersion: number;
  identity: QueryTileFeatureIdentityTarget;
  found: boolean;
  feature: HonuaTypedFeature<T> | null;
  cache?: QueryTileServerCacheValidators;
  degraded?: readonly QueryTileServerDegradation[];
}

export interface QueryTileServerError {
  code: QueryTileServerErrorCode;
  message: string;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  degraded?: readonly QueryTileServerDegradation[];
  details?: Readonly<Record<string, unknown>>;
}

export interface QueryTileServerErrorResponse {
  contractVersion: number;
  error: QueryTileServerError;
}

export interface QueryTileServerContractFixture<T = Record<string, unknown>> {
  schemaVersion: number;
  routePrefix: string;
  routes: Readonly<Record<QueryTileServerRouteKind, string>>;
  requestParameters: QueryTileServerRequestParameters;
  tilejsonResponse: QueryTileJson;
  detailResponse: QueryTileFeatureDetailResponse<T>;
  errorResponse: QueryTileServerErrorResponse;
}

export interface QueryTileFeatureIdentityTarget {
  sourceId: SourceId;
  id: FeatureId;
  sourceLayer?: string;
  properties?: Readonly<Record<string, unknown>>;
  feature?: unknown;
}

export interface QueryTileFeatureIdentityContext {
  descriptor: QueryTileSourceDescriptor;
  sourceId: SourceId;
  sourceLayer?: string;
  properties: Readonly<Record<string, unknown>>;
}

export type QueryTileFeatureIdentityMapper = (
  feature: unknown,
  context: QueryTileFeatureIdentityContext,
) => QueryTileFeatureIdentityTarget | undefined;

export interface QueryTileFeatureIdentityDescriptor {
  /**
   * Property name(s) that carry canonical feature id. The first non-nullish
   * value wins. When omitted, MapLibre `feature.id`, `id`, `OBJECTID`,
   * `objectId`, and `fid` are tried in that order.
   */
  idProperty?: string | readonly string[];
  /** Optional property that overrides the descriptor's canonical source id. */
  sourceIdProperty?: string;
  /** Optional property that carries the vector source-layer id. */
  sourceLayerProperty?: string;
  /** MapLibre `promoteId` value to expose on the generated source spec. */
  promoteId?: string | Readonly<Record<string, string>>;
  /** Last-mile hook for protocols whose tile feature shape is not property based. */
  mapFeature?: QueryTileFeatureIdentityMapper;
}

export interface QueryTileSourceDescriptor<T = Record<string, unknown>> {
  kind: "query-vector-tile";
  /** Runtime / MapLibre source id for this dynamic tiled source. */
  id: SourceId;
  /** Canonical source id used by selection, detail lookup, and feature state. */
  sourceId: SourceId;
  /** Optional canonical source descriptor this tiled source is derived from. */
  source?: SourceDescriptor;
  /** Optional warehouse/indexed analytics descriptor this tiled source is derived from. */
  analyticsSource?: AnalyticsSourceDescriptor;
  /** Protocol override when `source` is not provided. */
  protocol?: Protocol;
  endpoint?: QueryTileEndpointDescriptor;
  /** Server-generated TileJSON metadata, if already available. */
  tilejson?: QueryTileJson;
  tileMatrixSet?: string;
  format?: QueryTileFormat;
  scheme?: QueryTileScheme;
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  bounds?: readonly [number, number, number, number];
  query?: Omit<Query<T>, "signal">;
  projection?: QueryTileProjectionDescriptor;
  cache?: QueryTileCachePolicy;
  featureIdentity?: QueryTileFeatureIdentityDescriptor;
  fallback?: QueryTileFallbackPolicy;
  attribution?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface QueryTileJsonVectorLayer {
  id: string;
  fields?: Readonly<Record<string, string>>;
  description?: string;
  minzoom?: number;
  maxzoom?: number;
}

/** Minimal TileJSON v3 shape used by MapLibre vector sources. */
export interface QueryTileJson {
  tilejson: "3.0.0";
  tiles: readonly string[];
  vector_layers?: readonly QueryTileJsonVectorLayer[];
  name?: string;
  description?: string;
  attribution?: string;
  scheme?: QueryTileScheme;
  minzoom?: number;
  maxzoom?: number;
  bounds?: readonly [number, number, number, number];
  center?: readonly [number, number, number];
  "honua:queryTiles"?: QueryTileServerTileJsonMetadata;
}

export interface DefineQueryTileSourceOptions<T = Record<string, unknown>>
  extends Omit<QueryTileSourceDescriptor<T>, "kind" | "sourceId" | "source" | "analyticsSource" | "protocol"> {
  /** Source id, source descriptor, or live Source handle to tile. */
  source: SourceId | SourceDescriptor | AnalyticsSourceDescriptor | Source<T>;
  /** Override the canonical source id inferred from `source`. */
  sourceId?: SourceId;
  /** Protocol override when `source` is a bare source id. */
  protocol?: Protocol;
}

export interface QueryTileCacheKeyOptions {
  cache?: QueryTileCacheIdentityDescriptor;
  prefix?: string;
}

export interface QueryTileFeatureDetailOptions<T = Record<string, unknown>> {
  source: Source<T>;
  target: QueryTileFeatureIdentityTarget;
  /**
   * Canonical id field used to build the detail query. When omitted, the
   * descriptor's string `featureIdentity.idProperty` is used.
   */
  idField?: string;
  descriptor?: QueryTileSourceDescriptor<T>;
  baseQuery?: Omit<Query<T>, "signal">;
  outFields?: readonly string[];
  returnGeometry?: boolean;
  signal?: AbortSignal;
  where?: string | ((target: QueryTileFeatureIdentityTarget) => string);
}

/** Build a canonical query-tile server path for TileJSON, MVT tiles, or detail lookup. */
export function buildQueryTileServerPath<T = Record<string, unknown>>(
  kind: QueryTileServerRouteKind,
  options: QueryTileServerRouteOptions<T>,
): string {
  const prefix = normalizeRoutePrefix(options.routePrefix ?? QUERY_TILE_SERVER_ROUTE_PREFIX);
  const sourcePath = QUERY_TILE_SERVER_SOURCE_ROUTE_TEMPLATE.replace("{sourceId}", encodePathSegment(options.sourceId));
  const parts = [prefix, sourcePath];

  if (kind === "tilejson") {
    parts.push("tilejson.json");
  } else if (kind === "tile") {
    const tile = options.tileKey ? normalizeQueryTileKey(options.tileKey) : undefined;
    parts.push(
      "tiles",
      tile ? String(tile.z) : "{z}",
      tile ? String(tile.x) : "{x}",
      `${tile ? String(tile.y) : "{y}"}.${options.format ?? "mvt"}`,
    );
  } else {
    parts.push("features", options.featureId === undefined ? "{featureId}" : encodePathSegment(options.featureId));
  }

  return `/${parts.filter((part) => part.length > 0).join("/")}`;
}

/** Build a canonical query-tile server URL and serialize supported query parameters. */
export function buildQueryTileServerUrl<T = Record<string, unknown>>(
  kind: QueryTileServerRouteKind,
  options: QueryTileServerRouteOptions<T> & { baseUrl: string },
): string {
  const url = joinRouteUrl(options.baseUrl, buildQueryTileServerPath(kind, options));
  return appendServerParams(url, queryTileServerRequestParamsFromOptions(options), options.extraParams);
}

/** Project a descriptor's query/projection/cache-relevant dimensions into server query params. */
export function queryTileServerRequestParamsFromDescriptor<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  options: Pick<QueryTileServerRouteOptions<T>, "params" | "query" | "projection"> = {},
): QueryTileServerRequestParameters {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  return queryTileServerRequestParamsFromOptions({
    query: options.query ?? normalized.query,
    projection: options.projection ?? normalized.projection,
    params: {
      tileMatrixSet: normalized.tileMatrixSet,
      ...options.params,
    },
  });
}

/** Validate and return TileJSON that follows the dynamic query tile contract. */
export function parseQueryTileJson(value: unknown): QueryTileJson {
  const record = expectRecord(value, "TileJSON response");
  if (record.tilejson !== "3.0.0") {
    throw new Error('query tile TileJSON response must include tilejson: "3.0.0"');
  }
  if (!Array.isArray(record.tiles) || record.tiles.some((tile) => typeof tile !== "string" || tile.length === 0)) {
    throw new Error("query tile TileJSON response must include non-empty tiles[] strings");
  }
  if (record.vector_layers !== undefined) {
    if (!Array.isArray(record.vector_layers)) {
      throw new Error("query tile TileJSON vector_layers must be an array when present");
    }
    for (const layer of record.vector_layers) {
      const layerRecord = expectRecord(layer, "query tile vector layer");
      if (typeof layerRecord.id !== "string" || layerRecord.id.length === 0) {
        throw new Error("query tile vector layer id is required");
      }
    }
  }
  const metadata = record["honua:queryTiles"];
  if (metadata !== undefined) {
    validateQueryTileServerMetadata(metadata);
  }
  return record as unknown as QueryTileJson;
}

/** Validate and return the canonical feature-detail lookup response. */
export function parseQueryTileFeatureDetailResponse<T = Record<string, unknown>>(
  value: unknown,
): QueryTileFeatureDetailResponse<T> {
  const record = expectRecord(value, "query tile feature detail response");
  if (typeof record.contractVersion !== "number") {
    throw new Error("query tile feature detail response contractVersion is required");
  }
  const identity = expectRecord(record.identity, "query tile feature detail identity");
  if (typeof identity.sourceId !== "string" || identity.sourceId.length === 0) {
    throw new Error("query tile feature detail identity.sourceId is required");
  }
  if (!isFeatureId(identity.id)) {
    throw new Error("query tile feature detail identity.id is required");
  }
  if (typeof record.found !== "boolean") {
    throw new Error("query tile feature detail response found flag is required");
  }
  if (record.feature !== null && (record.feature === undefined || typeof record.feature !== "object")) {
    throw new Error("query tile feature detail response feature must be an object or null");
  }
  validateDegradations(record.degraded);
  return record as unknown as QueryTileFeatureDetailResponse<T>;
}

/** Validate and return the canonical query-tile server error envelope. */
export function parseQueryTileServerErrorResponse(value: unknown): QueryTileServerErrorResponse {
  const record = expectRecord(value, "query tile server error response");
  if (typeof record.contractVersion !== "number") {
    throw new Error("query tile server error response contractVersion is required");
  }
  const error = expectRecord(record.error, "query tile server error");
  if (typeof error.code !== "string" || error.code.length === 0) {
    throw new Error("query tile server error code is required");
  }
  if (typeof error.message !== "string" || error.message.length === 0) {
    throw new Error("query tile server error message is required");
  }
  if (error.status !== undefined && typeof error.status !== "number") {
    throw new Error("query tile server error status must be a number when present");
  }
  validateDegradations(error.degraded);
  return record as unknown as QueryTileServerErrorResponse;
}

/** Build a normalized descriptor from a source id, descriptor, or Source handle. */
export function defineQueryTileSource<T = Record<string, unknown>>(
  options: DefineQueryTileSourceOptions<T>,
): QueryTileSourceDescriptor<T> {
  const sourceDescriptor = resolveSourceDescriptor(options.source);
  const analyticsSource = resolveAnalyticsSourceDescriptor(options.source);
  const sourceId =
    options.sourceId ??
    sourceDescriptor?.id ??
    (analyticsSource ? analyticsSourceId(analyticsSource) : String(options.source));
  const protocol = options.protocol ?? sourceDescriptor?.protocol;
  return normalizeQueryTileSourceDescriptor({
    ...options,
    kind: "query-vector-tile",
    id: options.id,
    sourceId,
    source: sourceDescriptor,
    analyticsSource,
    protocol,
  });
}

/** Normalize defaults and validate the descriptor's stable identity fields. */
export function normalizeQueryTileSourceDescriptor<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
): QueryTileSourceDescriptor<T> {
  if (!descriptor.id || typeof descriptor.id !== "string") {
    throw new Error("QueryTileSourceDescriptor.id is required");
  }
  if (!descriptor.sourceId || typeof descriptor.sourceId !== "string") {
    throw new Error("QueryTileSourceDescriptor.sourceId is required");
  }
  const protocol = descriptor.protocol ?? descriptor.source?.protocol;
  const analyticsSource = descriptor.analyticsSource
    ? normalizeAnalyticsSourceDescriptor(descriptor.analyticsSource)
    : undefined;
  return {
    ...descriptor,
    kind: "query-vector-tile",
    protocol,
    ...(analyticsSource ? { analyticsSource } : {}),
    format: descriptor.format ?? "mvt",
    scheme: descriptor.scheme ?? "xyz",
    tileMatrixSet: descriptor.tileMatrixSet ?? descriptor.source?.locator.tileMatrixSetId,
    attribution: descriptor.attribution ?? descriptor.source?.attribution,
  };
}

/** Normalize XYZ / OGC tile aliases into a canonical, wrapped XYZ key. */
export function normalizeQueryTileKey(input: QueryTileKeyInput): QueryTileKey {
  const z = parseInteger(input.z ?? input.tileMatrix, "z");
  const x = parseInteger(input.x ?? input.tileCol, "x");
  const y = parseInteger(input.y ?? input.tileRow, "y");
  if (z < 0) throw new Error("tile z must be >= 0");
  const tileCount = 2 ** z;
  const wrappedX = ((x % tileCount) + tileCount) % tileCount;
  const clampedY = Math.min(tileCount - 1, Math.max(0, y));
  return { z, x: wrappedX, y: clampedY };
}

export function queryTileKeyString(input: QueryTileKeyInput): string {
  const key = normalizeQueryTileKey(input);
  return `${key.z}/${key.x}/${key.y}`;
}

/**
 * Build a stable cache key. The key includes tile coordinate, source id,
 * protocol, tile matrix set, query, projection, style filters, source
 * version, and authorization scope.
 */
export function buildQueryTileCacheKey<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  tileKey: QueryTileKeyInput,
  options: QueryTileCacheKeyOptions = {},
): string {
  const normalizedDescriptor = normalizeQueryTileSourceDescriptor(descriptor);
  const key = normalizeQueryTileKey(tileKey);
  const cacheIdentity = {
    ...(normalizedDescriptor.cache?.key ?? {}),
    ...(options.cache ?? {}),
  };
  const payload = {
    v: 1,
    kind: normalizedDescriptor.kind,
    descriptorId: normalizedDescriptor.id,
    sourceId: normalizedDescriptor.sourceId,
    protocol: normalizedDescriptor.protocol,
    analyticsSource: normalizedDescriptor.analyticsSource
      ? buildAnalyticsSourceCacheKey(normalizedDescriptor.analyticsSource, {
          cache: {
            sourceVersion: cacheIdentity.sourceVersion,
            authorizationScope: cacheIdentity.authorizationScope,
            filters: normalizedDescriptor.query?.where,
            indexResolution:
              typeof cacheIdentity.extra?.indexResolution === "number"
                ? cacheIdentity.extra.indexResolution
                : undefined,
            projection: normalizeProjection(normalizedDescriptor.projection),
            styleProjection: cacheIdentity.styleFilters,
            extra: cacheIdentity.extra,
          },
          operation: "tiles",
        })
      : undefined,
    tileMatrixSet: normalizedDescriptor.tileMatrixSet,
    format: normalizedDescriptor.format,
    tile: key,
    query: normalizeSerializableQuery(normalizedDescriptor.query),
    projection: normalizeProjection(normalizedDescriptor.projection),
    styleFilters: cacheIdentity.styleFilters,
    sourceVersion: cacheIdentity.sourceVersion,
    authorizationScope: cacheIdentity.authorizationScope,
    extra: cacheIdentity.extra,
  };
  return `${options.prefix ?? "honua-query-tile"}:${stableJson(payload)}`;
}

/** Map a rendered tile feature back to canonical source + feature identity. */
export function mapQueryTileFeatureIdentity<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  feature: unknown,
): QueryTileFeatureIdentityTarget | undefined {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const properties = featureProperties(feature);
  const sourceLayer =
    readStringProperty(properties, normalized.featureIdentity?.sourceLayerProperty) ?? featureSourceLayer(feature);
  const context: QueryTileFeatureIdentityContext = {
    descriptor: normalized,
    sourceId: normalized.sourceId,
    sourceLayer,
    properties,
  };

  const mapped = normalized.featureIdentity?.mapFeature?.(feature, context);
  if (mapped) return mapped;

  const sourceId = readStringProperty(properties, normalized.featureIdentity?.sourceIdProperty) ?? normalized.sourceId;
  const id = readFeatureId(feature, properties, normalized.featureIdentity, sourceLayer);
  if (id === undefined) return undefined;
  return {
    sourceId,
    id,
    ...(sourceLayer ? { sourceLayer } : {}),
    properties,
    feature,
  };
}

/** Build the canonical Source.query() request for selected-tile-feature detail. */
export function buildQueryTileFeatureDetailQuery<T = Record<string, unknown>>(
  options: QueryTileFeatureDetailOptions<T>,
): Query<T> {
  const idField =
    options.idField ??
    firstString(options.descriptor?.featureIdentity?.idProperty) ??
    firstString(options.descriptor?.featureIdentity?.promoteId);
  const detailWhere =
    typeof options.where === "function"
      ? options.where(options.target)
      : (options.where ?? (idField ? `${idField} = ${sqlLiteral(options.target.id)}` : undefined));
  if (!detailWhere) {
    throw new Error("query tile feature detail requires idField, descriptor.featureIdentity.idProperty, or where");
  }
  const base = options.baseQuery ?? {};
  return {
    ...base,
    where: combineWhere(base.where, detailWhere),
    outFields: options.outFields ?? base.outFields,
    returnGeometry: options.returnGeometry ?? base.returnGeometry ?? true,
    pagination: { ...(base.pagination ?? {}), limit: 1 },
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** Load a selected tile feature through the canonical Source detail path. */
export async function loadQueryTileFeatureDetail<T = Record<string, unknown>>(
  options: QueryTileFeatureDetailOptions<T>,
): Promise<HonuaTypedFeature<T> | undefined> {
  const result: Result<T> = await options.source.query(buildQueryTileFeatureDetailQuery(options));
  return result.features[0];
}

/** Stable JSON for cache keys and diagnostics snapshots. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function resolveSourceDescriptor<T>(
  source: SourceId | SourceDescriptor | AnalyticsSourceDescriptor | Source<T>,
): SourceDescriptor | undefined {
  if (typeof source === "string") return undefined;
  if (isAnalyticsSourceDescriptor(source)) return undefined;
  const maybeSource = source as Partial<Source<T>>;
  if (maybeSource.descriptor) return maybeSource.descriptor;
  const maybeDescriptor = source as Partial<SourceDescriptor>;
  if (typeof maybeDescriptor.id === "string" && typeof maybeDescriptor.protocol === "string") {
    return maybeDescriptor as SourceDescriptor;
  }
  return undefined;
}

function resolveAnalyticsSourceDescriptor(source: unknown): AnalyticsSourceDescriptor | undefined {
  return isAnalyticsSourceDescriptor(source) ? normalizeAnalyticsSourceDescriptor(source) : undefined;
}

function queryTileServerRequestParamsFromOptions<T = Record<string, unknown>>(
  options: Pick<QueryTileServerRouteOptions<T>, "query" | "projection" | "params">,
): QueryTileServerRequestParameters {
  return {
    where: options.query?.where,
    outFields: options.query?.outFields,
    returnGeometry: options.query?.returnGeometry,
    outSr: options.query?.outSr,
    projection: options.projection?.fields,
    projectionReturnGeometry: options.projection?.returnGeometry,
    simplifyTolerance: options.projection?.simplifyTolerance,
    ...(options.params ?? {}),
  };
}

function normalizeRoutePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function encodePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function joinRouteUrl(baseUrl: string, path: string): string {
  const [basePath, query = ""] = baseUrl.split("?", 2);
  const joined = `${basePath.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return query ? `${joined}?${query}` : joined;
}

function appendServerParams(
  url: string,
  params: QueryTileServerRequestParameters,
  extraParams: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...(extraParams ?? {}) })) {
    const serialized = serverParamValue(value);
    if (serialized === undefined) continue;
    searchParams.set(key, serialized);
  }
  const query = searchParams.toString();
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function serverParamValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") return stableJson(value);
  return String(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateQueryTileServerMetadata(value: unknown): void {
  const metadata = expectRecord(value, "query tile TileJSON honua:queryTiles metadata");
  if (typeof metadata.contractVersion !== "number") {
    throw new Error("query tile TileJSON metadata contractVersion is required");
  }
  if (typeof metadata.sourceId !== "string" || metadata.sourceId.length === 0) {
    throw new Error("query tile TileJSON metadata sourceId is required");
  }
  if (typeof metadata.tileMatrixSet !== "string" || metadata.tileMatrixSet.length === 0) {
    throw new Error("query tile TileJSON metadata tileMatrixSet is required");
  }
  if (metadata.format !== "mvt" && metadata.format !== "geojson") {
    throw new Error("query tile TileJSON metadata format must be mvt or geojson");
  }
  if (metadata.spatialReference === undefined) {
    throw new Error("query tile TileJSON metadata spatialReference is required");
  }
  const identity = expectRecord(metadata.featureIdentity, "query tile TileJSON featureIdentity");
  if (typeof identity.sourceId !== "string" || identity.sourceId.length === 0) {
    throw new Error("query tile TileJSON featureIdentity.sourceId is required");
  }
  if (typeof identity.idProperty !== "string" && !Array.isArray(identity.idProperty)) {
    throw new Error("query tile TileJSON featureIdentity.idProperty is required");
  }
  if (typeof metadata.detailUrlTemplate !== "string" || metadata.detailUrlTemplate.length === 0) {
    throw new Error("query tile TileJSON metadata detailUrlTemplate is required");
  }
  validateDegradations(metadata.degraded);
}

function validateDegradations(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("query tile degraded must be an array when present");
  for (const item of value) {
    const degradation = expectRecord(item, "query tile degradation");
    if (typeof degradation.code !== "string" || degradation.code.length === 0) {
      throw new Error("query tile degradation code is required");
    }
    if (!["info", "warning", "error"].includes(String(degradation.severity))) {
      throw new Error("query tile degradation severity must be info, warning, or error");
    }
    if (typeof degradation.message !== "string" || degradation.message.length === 0) {
      throw new Error("query tile degradation message is required");
    }
  }
}

function normalizeSerializableQuery<T>(query: Omit<Query<T>, "signal"> | undefined): unknown {
  if (!query) return undefined;
  return sortJson(query);
}

function normalizeProjection(projection: QueryTileProjectionDescriptor | undefined): unknown {
  if (!projection) return undefined;
  return {
    ...projection,
    fields: projection.fields ? [...projection.fields] : undefined,
  };
}

function parseInteger(value: number | string | undefined, label: string): number {
  if (value === undefined || value === null || value === "") {
    throw new Error(`tile ${label} is required`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed)) {
    throw new Error(`tile ${label} must be an integer`);
  }
  return parsed;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const next = input[key];
    if (typeof next === "undefined" || typeof next === "function" || typeof next === "symbol") continue;
    out[key] = sortJson(next);
  }
  return out;
}

function featureProperties(feature: unknown): Readonly<Record<string, unknown>> {
  if (!feature || typeof feature !== "object") return {};
  const properties = (feature as { properties?: unknown }).properties;
  if (properties && typeof properties === "object") return properties as Readonly<Record<string, unknown>>;
  const attributes = (feature as { attributes?: unknown }).attributes;
  if (attributes && typeof attributes === "object") return attributes as Readonly<Record<string, unknown>>;
  return {};
}

function featureSourceLayer(feature: unknown): string | undefined {
  if (!feature || typeof feature !== "object") return undefined;
  const direct = (feature as { sourceLayer?: unknown }).sourceLayer;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const layer = (feature as { layer?: { "source-layer"?: unknown; sourceLayer?: unknown } }).layer;
  const sourceLayer = layer?.sourceLayer ?? layer?.["source-layer"];
  return typeof sourceLayer === "string" && sourceLayer.length > 0 ? sourceLayer : undefined;
}

function readFeatureId(
  feature: unknown,
  properties: Readonly<Record<string, unknown>>,
  identity: QueryTileFeatureIdentityDescriptor | undefined,
  sourceLayer: string | undefined,
): FeatureId | undefined {
  const explicitId = readFeatureIdProperty(properties, identity?.idProperty);
  if (explicitId !== undefined) return explicitId;

  const promoted = promoteIdProperty(identity?.promoteId, sourceLayer);
  const promotedId = readFeatureIdProperty(properties, promoted);
  if (promotedId !== undefined) return promotedId;

  if (feature && typeof feature === "object") {
    const featureId = (feature as { id?: unknown }).id;
    if (isFeatureId(featureId)) return featureId;
  }
  return readFeatureIdProperty(properties, ["id", "OBJECTID", "objectId", "fid"]);
}

function promoteIdProperty(
  promoteId: string | Readonly<Record<string, string>> | undefined,
  sourceLayer: string | undefined,
): string | undefined {
  if (typeof promoteId === "string") return promoteId;
  if (promoteId && sourceLayer) return promoteId[sourceLayer];
  return undefined;
}

function readFeatureIdProperty(
  properties: Readonly<Record<string, unknown>>,
  property: string | readonly string[] | undefined,
): FeatureId | undefined {
  const keys = typeof property === "string" ? [property] : (property ?? []);
  for (const key of keys) {
    const value = properties[key];
    if (isFeatureId(value)) return value;
  }
  return undefined;
}

function readStringProperty(
  properties: Readonly<Record<string, unknown>>,
  property: string | undefined,
): string | undefined {
  if (!property) return undefined;
  const value = properties[property];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function firstString(
  value: string | readonly string[] | Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item) => typeof item === "string" && item.length > 0);
  return undefined;
}

function sqlLiteral(value: FeatureId): string {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

function combineWhere(base: string | undefined, detail: string): string {
  if (!base || base.trim().length === 0) return detail;
  return `(${base}) AND (${detail})`;
}
