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
import type { FeatureId, Protocol, Query, Result, Source, SourceDescriptor, SourceId } from "./types.js";

export type QueryTileFormat = "mvt" | "geojson";
export type QueryTileScheme = "xyz" | "tms";
export type QueryTileFallbackMode = "disabled" | "query-bbox" | "geojson-source";

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
  /** Query-tile service root used when constructing a URL template. */
  baseUrl?: string;
  /** Relative tile path under `baseUrl`. Defaults to `tiles/{z}/{x}/{y}.mvt`. */
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
}

export interface DefineQueryTileSourceOptions<T = Record<string, unknown>>
  extends Omit<QueryTileSourceDescriptor<T>, "kind" | "sourceId" | "source" | "protocol"> {
  /** Source id, source descriptor, or live Source handle to tile. */
  source: SourceId | SourceDescriptor | Source<T>;
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

/** Build a normalized descriptor from a source id, descriptor, or Source handle. */
export function defineQueryTileSource<T = Record<string, unknown>>(
  options: DefineQueryTileSourceOptions<T>,
): QueryTileSourceDescriptor<T> {
  const sourceDescriptor = resolveSourceDescriptor(options.source);
  const sourceId = options.sourceId ?? sourceDescriptor?.id ?? String(options.source);
  const protocol = options.protocol ?? sourceDescriptor?.protocol;
  return normalizeQueryTileSourceDescriptor({
    ...options,
    kind: "query-vector-tile",
    id: options.id,
    sourceId,
    source: sourceDescriptor,
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
  return {
    ...descriptor,
    kind: "query-vector-tile",
    protocol,
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

function resolveSourceDescriptor<T>(source: SourceId | SourceDescriptor | Source<T>): SourceDescriptor | undefined {
  if (typeof source === "string") return undefined;
  const maybeSource = source as Partial<Source<T>>;
  if (maybeSource.descriptor) return maybeSource.descriptor;
  const maybeDescriptor = source as Partial<SourceDescriptor>;
  if (typeof maybeDescriptor.id === "string" && typeof maybeDescriptor.protocol === "string") {
    return maybeDescriptor as SourceDescriptor;
  }
  return undefined;
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
