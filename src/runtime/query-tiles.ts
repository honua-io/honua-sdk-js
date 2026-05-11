/**
 * Runtime helpers for query-backed vector tile sources.
 *
 * This module is MapLibre-shaped but does not import `maplibre-gl`.
 * Callers can use the pure source-spec helpers, or the request controller
 * when they need explicit viewport/tile lifecycle management outside
 * MapLibre's built-in source loader.
 *
 * @module
 */

import { assessAnalyticsSourcePushdown } from "../contract/analytics-sources.js";
import {
  type QueryTileCacheKeyOptions,
  type QueryTileCachePolicy,
  type QueryTileEndpointDescriptor,
  type QueryTileFeatureDetailResponse,
  type QueryTileFeatureIdentityDescriptor,
  type QueryTileFeatureIdentityTarget,
  type QueryTileJson,
  type QueryTileKey,
  type QueryTileKeyInput,
  type QueryTileServerCacheValidators,
  type QueryTileServerDegradation,
  type QueryTileServerErrorResponse,
  type QueryTileServerRequestParameters,
  type QueryTileSourceDescriptor,
  buildQueryTileCacheKey,
  buildQueryTileServerPath,
  normalizeQueryTileKey,
  normalizeQueryTileSourceDescriptor,
  parseQueryTileFeatureDetailResponse,
  parseQueryTileJson,
  parseQueryTileServerErrorResponse,
  queryTileKeyString,
  queryTileServerRequestParamsFromDescriptor,
  stableJson,
} from "../contract/tiles.js";
import type { Capability, Protocol } from "../contract/types.js";

export interface MapLibreQueryTileSourceSpec {
  type: "vector";
  tiles?: string[];
  url?: string;
  scheme?: "xyz" | "tms";
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  bounds?: readonly [number, number, number, number];
  attribution?: string;
  promoteId?: string | Readonly<Record<string, string>>;
  volatile?: boolean;
}

export interface QueryTileUrlTemplateOptions {
  endpoint?: QueryTileEndpointDescriptor;
  cache?: QueryTileCacheKeyOptions["cache"];
  includeCacheKey?: boolean;
  extraParams?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface QueryTileSourceSpecOptions extends QueryTileUrlTemplateOptions {
  useTileJsonUrl?: boolean;
  volatile?: boolean;
}

export type QueryTileServerFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface QueryTileServerFetchOptions {
  fetch?: QueryTileServerFetch;
  headers?: HeadersInit;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  validators?: QueryTileServerCacheValidators;
}

export interface FetchQueryTileJsonOptions extends QueryTileUrlTemplateOptions, QueryTileServerFetchOptions {
  url?: string;
  routePrefix?: string;
  params?: QueryTileServerRequestParameters;
}

export interface FetchQueryTileFeatureDetailOptions extends QueryTileServerFetchOptions {
  url?: string;
  routePrefix?: string;
  params?: QueryTileServerRequestParameters;
  extraParams?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface QueryTileJsonFetchResult {
  url: string;
  status: number;
  notModified: boolean;
  validators: QueryTileServerCacheValidators;
  tilejson?: QueryTileJson;
  degraded?: readonly QueryTileServerDegradation[];
}

export interface QueryTileFeatureDetailFetchResult<T = Record<string, unknown>> {
  url: string;
  status: number;
  notModified: boolean;
  validators: QueryTileServerCacheValidators;
  detail?: QueryTileFeatureDetailResponse<T>;
  degraded?: readonly QueryTileServerDegradation[];
}

export class QueryTileServerResponseError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly response: QueryTileServerErrorResponse | undefined;
  public readonly body: unknown;
  public readonly validators: QueryTileServerCacheValidators;

  public constructor(options: {
    status: number;
    url: string;
    message: string;
    response?: QueryTileServerErrorResponse;
    body?: unknown;
    validators?: QueryTileServerCacheValidators;
  }) {
    super(options.message);
    this.name = "QueryTileServerResponseError";
    this.status = options.status;
    this.url = options.url;
    this.response = options.response;
    this.body = options.body;
    this.validators = options.validators ?? {};
  }
}

export interface QueryTileViewport {
  /** `[west, south, east, north]` in WGS84 degrees. */
  bounds: readonly [number, number, number, number];
  zoom: number;
  minzoom?: number;
  maxzoom?: number;
  maxTiles?: number;
}

export type QueryTileDiagnosticSeverity = "info" | "warning" | "error";

export type QueryTileDiagnosticCode =
  | "tile-pushdown-supported"
  | "tile-pushdown-unavailable"
  | "fallback-enabled"
  | "fallback-disabled"
  | "unsupported-protocol"
  | "analytics-tile-pushdown-supported"
  | "analytics-tile-pushdown-unavailable"
  | "client-materialization-disabled"
  | "missing-tile-endpoint"
  | "missing-cache-scope"
  | "unbounded-cache";

export interface QueryTileDiagnostic {
  severity: QueryTileDiagnosticSeverity;
  code: QueryTileDiagnosticCode;
  message: string;
  sourceId: string;
  descriptorId: string;
  protocol?: Protocol;
  capability?: Capability;
}

export interface QueryTileRequest {
  descriptor: QueryTileSourceDescriptor;
  tileKey: QueryTileKey;
  cacheKey: string;
  url: string;
  signal: AbortSignal;
}

export type QueryTileFetcher<T> = (request: QueryTileRequest) => Promise<T>;

export type QueryTileLifecycleEvent<T = unknown> =
  | {
      type: "tile-requested";
      descriptorId: string;
      sourceId: string;
      tileKey: QueryTileKey;
      cacheKey: string;
      url: string;
    }
  | {
      type: "tile-cache-hit";
      descriptorId: string;
      sourceId: string;
      tileKey: QueryTileKey;
      cacheKey: string;
      value: T;
    }
  | {
      type: "tile-loaded";
      descriptorId: string;
      sourceId: string;
      tileKey: QueryTileKey;
      cacheKey: string;
      value: T;
    }
  | {
      type: "tile-aborted";
      descriptorId: string;
      sourceId: string;
      tileKey: QueryTileKey;
      cacheKey: string;
      reason?: unknown;
    }
  | {
      type: "tile-error";
      descriptorId: string;
      sourceId: string;
      tileKey: QueryTileKey;
      cacheKey: string;
      error: unknown;
    }
  | {
      type: "tile-evicted";
      descriptorId: string;
      sourceId: string;
      tileKey: QueryTileKey;
      cacheKey: string;
      reason: "invalidate" | "lru" | "clear";
    };

export type QueryTileLifecycleListener<T = unknown> = (event: QueryTileLifecycleEvent<T>) => void;

export interface QueryTileRequestControllerOptions<T> {
  fetchTile: QueryTileFetcher<T>;
  cache?: QueryTileCachePolicy;
  onEvent?: QueryTileLifecycleListener<T>;
}

export interface QueryTileRequestTileOptions {
  signal?: AbortSignal;
  cache?: QueryTileCacheKeyOptions["cache"];
}

export interface QueryTileViewportRequestOptions extends QueryTileRequestTileOptions {
  abortOutOfViewport?: boolean;
}

export interface QueryTileViewportRequestResult<T> {
  viewport: QueryTileViewport;
  tiles: readonly QueryTileKey[];
  results: readonly PromiseSettledResult<T>[];
  diagnostics: readonly QueryTileDiagnostic[];
}

export interface QueryTileCacheSnapshot {
  entries: number;
  inflight: number;
  maxEntries: number | undefined;
  tileKeys: readonly string[];
}

interface CacheEntry<T> {
  value: T;
  tileKey: QueryTileKey;
  createdAt: number;
  lastAccessedAt: number;
}

interface InflightEntry<T> {
  promise: Promise<T>;
  controller: AbortController;
  tileKey: QueryTileKey;
  cacheKey: string;
}

const WEB_MERCATOR_LAT_LIMIT = 85.05112878;

const TILE_PUSHDOWN_PROTOCOLS = new Set<Protocol>([
  "ogc-tiles",
  "wmts",
  "maplibre-vector",
  "maplibre-raster",
  "geoservices-map-service",
]);

const QUERY_FALLBACK_PROTOCOLS = new Set<Protocol>([
  "grpc",
  "geoservices-feature-service",
  "geoservices-map-service",
  "geoservices-image-service",
  "ogc-features",
  "ogc-records",
  "stac",
  "wfs",
  "wms",
  "odata",
]);

/** Build a MapLibre-compatible TileJSON document from a query tile descriptor. */
export function buildQueryTileJson<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  options: QueryTileUrlTemplateOptions = {},
): QueryTileJson {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const tilejson = normalized.tilejson;
  const tiles = tilejson?.tiles?.length ? tilejson.tiles : [buildQueryTileUrlTemplate(normalized, options)];
  return {
    tilejson: "3.0.0",
    ...tilejson,
    tiles,
    name: tilejson?.name ?? normalized.id,
    attribution: tilejson?.attribution ?? normalized.attribution,
    scheme: tilejson?.scheme ?? normalized.scheme,
    minzoom: tilejson?.minzoom ?? normalized.minzoom,
    maxzoom: tilejson?.maxzoom ?? normalized.maxzoom,
    bounds: tilejson?.bounds ?? normalized.bounds,
    vector_layers: tilejson?.vector_layers ?? [
      {
        id: normalized.sourceId,
        fields: fieldsToTileJson(normalized.projection?.fields),
        minzoom: normalized.minzoom,
        maxzoom: normalized.maxzoom,
      },
    ],
  };
}

/** Build a MapLibre vector source spec using TileJSON URL or inline tile template metadata. */
export function buildMapLibreQueryTileSourceSpec<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  options: QueryTileSourceSpecOptions = {},
): MapLibreQueryTileSourceSpec {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const endpoint = { ...(normalized.endpoint ?? {}), ...(options.endpoint ?? {}) };
  const promoteId = promoteIdFromIdentity(normalized.featureIdentity);

  if (options.useTileJsonUrl !== false && endpoint.tilejsonUrl) {
    return {
      type: "vector",
      url: endpoint.tilejsonUrl,
      ...(promoteId ? { promoteId } : {}),
      ...(options.volatile !== undefined ? { volatile: options.volatile } : {}),
    };
  }

  const tilejson = buildQueryTileJson(normalized, options);
  return {
    type: "vector",
    tiles: [...tilejson.tiles],
    scheme: tilejson.scheme,
    tileSize: normalized.tileSize,
    minzoom: tilejson.minzoom,
    maxzoom: tilejson.maxzoom,
    bounds: tilejson.bounds,
    attribution: tilejson.attribution,
    ...(promoteId ? { promoteId } : {}),
    ...(options.volatile !== undefined ? { volatile: options.volatile } : {}),
  };
}

/** Build a URL template with MapLibre `{z}` / `{x}` / `{y}` placeholders. */
export function buildQueryTileUrlTemplate<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  options: QueryTileUrlTemplateOptions = {},
): string {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const endpoint = { ...(normalized.endpoint ?? {}), ...(options.endpoint ?? {}) };
  if (endpoint.urlTemplate) return endpoint.urlTemplate;
  if (normalized.tilejson?.tiles?.[0]) return normalized.tilejson.tiles[0];

  const baseUrl = endpoint.baseUrl ?? normalized.source?.locator.url;
  if (!baseUrl) {
    throw new Error(`query tile descriptor "${normalized.id}" is missing endpoint.baseUrl or endpoint.urlTemplate`);
  }
  const path =
    endpoint.path ??
    buildQueryTileServerPath("tile", {
      sourceId: normalized.sourceId,
      routePrefix: "",
      format: normalized.format ?? "mvt",
    }).replace(/^\/+/, "");
  const url = joinUrl(baseUrl, path);
  const params = {
    ...queryTileServerRequestParamsFromDescriptor(normalized, {
      params: options.includeCacheKey
        ? { cacheKey: buildQueryTileCacheKey(normalized, { z: 0, x: 0, y: 0 }, { cache: options.cache }) }
        : undefined,
    }),
    ...(options.extraParams ?? {}),
  };
  return appendParams(url, params);
}

/** Substitute one normalized tile key into a query tile URL template. */
export function buildQueryTileUrl<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  tileKey: QueryTileKeyInput,
  options: QueryTileUrlTemplateOptions = {},
): string {
  const key = normalizeQueryTileKey(tileKey);
  return buildQueryTileUrlTemplate(descriptor, options)
    .replaceAll("{z}", String(key.z))
    .replaceAll("{x}", String(key.x))
    .replaceAll("{y}", String(key.y))
    .replaceAll("{tileMatrix}", String(key.z))
    .replaceAll("{tileCol}", String(key.x))
    .replaceAll("{tileRow}", String(key.y));
}

/** Fetch and validate TileJSON from a dynamic query tile server. */
export async function fetchQueryTileJson<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  options: FetchQueryTileJsonOptions = {},
): Promise<QueryTileJsonFetchResult> {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const url = options.url ?? buildQueryTileJsonRequestUrl(normalized, options);
  const response = await queryTileFetch(options)(url, {
    method: "GET",
    headers: queryTileRequestHeaders("application/json", options),
    signal: options.signal,
    credentials: options.credentials,
  });
  const validators = queryTileValidatorsFromHeaders(response.headers);
  if (response.status === 304) {
    return { url, status: response.status, notModified: true, validators };
  }

  const body = await readJsonBody(response);
  if (!response.ok) {
    throw queryTileServerResponseError(url, response.status, body, validators);
  }

  const tilejson = parseQueryTileJson(body);
  return {
    url,
    status: response.status,
    notModified: false,
    validators,
    tilejson,
    degraded: tilejson["honua:queryTiles"]?.degraded,
  };
}

/** Fetch and validate a source-qualified feature-detail response from a query tile server. */
export async function fetchQueryTileFeatureDetail<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  target: QueryTileFeatureIdentityTarget,
  options: FetchQueryTileFeatureDetailOptions = {},
): Promise<QueryTileFeatureDetailFetchResult<T>> {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const url = options.url ?? buildQueryTileFeatureDetailRequestUrl(normalized, target, options);
  const response = await queryTileFetch(options)(url, {
    method: "GET",
    headers: queryTileRequestHeaders("application/json", options),
    signal: options.signal,
    credentials: options.credentials,
  });
  const validators = queryTileValidatorsFromHeaders(response.headers);
  if (response.status === 304) {
    return { url, status: response.status, notModified: true, validators };
  }

  const body = await readJsonBody(response);
  if (!response.ok) {
    throw queryTileServerResponseError(url, response.status, body, validators);
  }

  const detail = parseQueryTileFeatureDetailResponse<T>(body);
  return {
    url,
    status: response.status,
    notModified: false,
    validators,
    detail,
    degraded: detail.degraded,
  };
}

/** Compute visible XYZ tiles for a WGS84 bounds + zoom viewport. */
export function queryTilesForViewport(viewport: QueryTileViewport): readonly QueryTileKey[] {
  const z = clampZoom(Math.floor(viewport.zoom), viewport.minzoom, viewport.maxzoom);
  const ranges = tileRangesForBounds(viewport.bounds, z);
  const out: QueryTileKey[] = [];
  for (const range of ranges) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        out.push(normalizeQueryTileKey({ z, x, y }));
      }
    }
  }
  const deduped = uniqueTiles(out);
  const maxTiles = viewport.maxTiles ?? 1024;
  if (deduped.length > maxTiles) {
    throw new Error(`viewport resolves to ${deduped.length} tiles, exceeding maxTiles=${maxTiles}`);
  }
  return deduped;
}

/** Diagnose protocol support, fallback behavior, and cache observability gaps. */
export function diagnoseQueryTileSourceSupport<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
): readonly QueryTileDiagnostic[] {
  const normalized = normalizeQueryTileSourceDescriptor(descriptor);
  const protocol = normalized.protocol;
  const diagnostics: QueryTileDiagnostic[] = [];
  const base = {
    sourceId: normalized.sourceId,
    descriptorId: normalized.id,
    ...(protocol ? { protocol } : {}),
  };

  const hasEndpoint =
    Boolean(normalized.endpoint?.urlTemplate) ||
    Boolean(normalized.endpoint?.baseUrl) ||
    Boolean(normalized.endpoint?.tilejsonUrl) ||
    Boolean(normalized.tilejson?.tiles?.length) ||
    Boolean(normalized.source?.locator.url);

  if (!hasEndpoint) {
    diagnostics.push({
      ...base,
      severity: "error",
      code: "missing-tile-endpoint",
      message: "query tile source has no urlTemplate, tilejson, baseUrl, or source locator URL",
    });
  }

  if (!protocol) {
    if (normalized.analyticsSource) {
      const assessment = assessAnalyticsSourcePushdown(normalized.analyticsSource, "tiles", {
        operation: "tiles",
        cache: normalized.analyticsSource.cache?.key,
      });
      diagnostics.push({
        ...base,
        severity: assessment.supported ? "info" : "warning",
        code: assessment.supported ? "analytics-tile-pushdown-supported" : "analytics-tile-pushdown-unavailable",
        capability: "tiles",
        message: assessment.supported
          ? `analytics source "${normalized.analyticsSource.id}" advertises tile pushdown`
          : (assessment.degraded?.[0]?.reason ??
            `analytics source "${normalized.analyticsSource.id}" lacks tile pushdown`),
      });
      if (normalized.analyticsSource.fallback?.mode === "disabled") {
        diagnostics.push({
          ...base,
          severity: "info",
          code: "client-materialization-disabled",
          capability: "query",
          message: "analytics source disables unbounded browser materialization",
        });
      }
    } else {
      diagnostics.push({
        ...base,
        severity: "warning",
        code: "unsupported-protocol",
        message: "query tile source has no protocol metadata; server pushdown cannot be inferred",
      });
    }
  } else if (TILE_PUSHDOWN_PROTOCOLS.has(protocol)) {
    diagnostics.push({
      ...base,
      severity: "info",
      code: "tile-pushdown-supported",
      capability: "tiles",
      message: `protocol "${protocol}" advertises first-party tile/render support`,
    });
  } else if (QUERY_FALLBACK_PROTOCOLS.has(protocol)) {
    diagnostics.push({
      ...base,
      severity: normalized.fallback?.mode === "disabled" ? "error" : "warning",
      code: normalized.fallback?.mode === "disabled" ? "fallback-disabled" : "tile-pushdown-unavailable",
      capability: "tiles",
      message:
        normalized.fallback?.mode === "disabled"
          ? `protocol "${protocol}" does not support tile pushdown and fallback is disabled`
          : `protocol "${protocol}" needs a query-backed tile endpoint or viewport-bounded fallback`,
    });
    if (normalized.fallback && normalized.fallback.mode !== "disabled") {
      diagnostics.push({
        ...base,
        severity: "warning",
        code: "fallback-enabled",
        capability: "query",
        message: normalized.fallback.reason ?? `fallback mode "${normalized.fallback.mode}" is enabled`,
      });
    }
  } else {
    diagnostics.push({
      ...base,
      severity: "error",
      code: "unsupported-protocol",
      message: `protocol "${protocol}" cannot serve query tiles or query fallback requests`,
    });
  }

  const cacheKey = normalized.cache?.key;
  if (!cacheKey?.sourceVersion || !cacheKey.authorizationScope) {
    diagnostics.push({
      ...base,
      severity: "warning",
      code: "missing-cache-scope",
      message: "tile cache key should include sourceVersion and authorizationScope",
    });
  }
  if (normalized.cache?.maxEntries === undefined) {
    diagnostics.push({
      ...base,
      severity: "warning",
      code: "unbounded-cache",
      message: "tile cache maxEntries is not set on the descriptor",
    });
  }

  return diagnostics;
}

export function createQueryTileRequestController<T = unknown>(
  descriptor: QueryTileSourceDescriptor,
  options: QueryTileRequestControllerOptions<T>,
): QueryTileRequestController<T> {
  return new QueryTileRequestController(descriptor, options);
}

/** Viewport-aware tile request manager with abortable inflight requests and bounded cache. */
export class QueryTileRequestController<T = unknown> {
  public readonly descriptor: QueryTileSourceDescriptor;

  readonly #fetchTile: QueryTileFetcher<T>;
  readonly #cachePolicy: QueryTileCachePolicy;
  readonly #onEvent: QueryTileLifecycleListener<T> | undefined;
  readonly #cache = new Map<string, CacheEntry<T>>();
  readonly #inflight = new Map<string, InflightEntry<T>>();

  public constructor(descriptor: QueryTileSourceDescriptor, options: QueryTileRequestControllerOptions<T>) {
    this.descriptor = normalizeQueryTileSourceDescriptor(descriptor);
    this.#fetchTile = options.fetchTile;
    this.#cachePolicy = { ...(this.descriptor.cache ?? {}), ...(options.cache ?? {}) };
    this.#onEvent = options.onEvent;
  }

  public requestTile(tileKey: QueryTileKeyInput, options: QueryTileRequestTileOptions = {}): Promise<T> {
    const key = normalizeQueryTileKey(tileKey);
    const cacheKey = this.#cacheKey(key, options.cache);
    const cached = this.#cache.get(cacheKey);
    const now = Date.now();
    if (cached && this.#isFresh(cached, now)) {
      cached.lastAccessedAt = now;
      this.#emit({ type: "tile-cache-hit", ...this.#eventBase(key, cacheKey), value: cached.value });
      return Promise.resolve(cached.value);
    }
    if (cached) this.#evict(cacheKey, cached, "invalidate");

    const inflight = this.#inflight.get(cacheKey);
    if (inflight) return inflight.promise;

    const controller = new AbortController();
    const cleanup = linkAbortSignals(controller, options.signal);
    const url = buildQueryTileUrl(this.descriptor, key, { cache: options.cache });
    const request: QueryTileRequest = {
      descriptor: this.descriptor,
      tileKey: key,
      cacheKey,
      url,
      signal: controller.signal,
    };

    this.#emit({ type: "tile-requested", ...this.#eventBase(key, cacheKey), url });

    const promise = this.#fetchTile(request)
      .then((value) => {
        if (controller.signal.aborted) {
          this.#emit({
            type: "tile-aborted",
            ...this.#eventBase(key, cacheKey),
            reason: controller.signal.reason,
          });
          throw abortError(controller.signal.reason);
        }
        this.#cache.set(cacheKey, {
          value,
          tileKey: key,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        });
        this.#enforceMaxEntries();
        this.#emit({ type: "tile-loaded", ...this.#eventBase(key, cacheKey), value });
        return value;
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) {
          this.#emit({
            type: "tile-aborted",
            ...this.#eventBase(key, cacheKey),
            reason: controller.signal.reason ?? error,
          });
        } else {
          this.#emit({ type: "tile-error", ...this.#eventBase(key, cacheKey), error });
        }
        throw error;
      })
      .finally(() => {
        cleanup();
        this.#inflight.delete(cacheKey);
      });

    this.#inflight.set(cacheKey, { promise, controller, tileKey: key, cacheKey });
    return promise;
  }

  public async requestViewport(
    viewport: QueryTileViewport,
    options: QueryTileViewportRequestOptions = {},
  ): Promise<QueryTileViewportRequestResult<T>> {
    const tiles = queryTilesForViewport(viewport);
    const visibleCacheKeys = new Set(tiles.map((tile) => this.#cacheKey(tile, options.cache)));
    if (options.abortOutOfViewport !== false) {
      for (const [cacheKey, entry] of this.#inflight) {
        if (!visibleCacheKeys.has(cacheKey)) entry.controller.abort("out-of-viewport");
      }
    }
    const results = await Promise.allSettled(tiles.map((tile) => this.requestTile(tile, options)));
    return {
      viewport,
      tiles,
      results,
      diagnostics: this.diagnostics(),
    };
  }

  public abort(tileKey?: QueryTileKeyInput, reason: unknown = "aborted"): void {
    if (!tileKey) {
      for (const entry of this.#inflight.values()) entry.controller.abort(reason);
      return;
    }
    const normalized = normalizeQueryTileKey(tileKey);
    for (const entry of this.#inflight.values()) {
      if (sameTile(entry.tileKey, normalized)) entry.controller.abort(reason);
    }
  }

  public invalidate(predicate?: (entry: { cacheKey: string; tileKey: QueryTileKey; value: T }) => boolean): number {
    let count = 0;
    for (const [cacheKey, entry] of this.#cache) {
      if (!predicate || predicate({ cacheKey, tileKey: entry.tileKey, value: entry.value })) {
        this.#evict(cacheKey, entry, "invalidate");
        count += 1;
      }
    }
    return count;
  }

  public clearCache(): void {
    for (const [cacheKey, entry] of this.#cache) {
      this.#evict(cacheKey, entry, "clear");
    }
  }

  public dispose(): void {
    this.abort(undefined, "disposed");
    this.clearCache();
  }

  public cacheSnapshot(): QueryTileCacheSnapshot {
    return {
      entries: this.#cache.size,
      inflight: this.#inflight.size,
      maxEntries: this.#cachePolicy.maxEntries,
      tileKeys: [...this.#cache.values()].map((entry) => queryTileKeyString(entry.tileKey)),
    };
  }

  public diagnostics(): readonly QueryTileDiagnostic[] {
    return diagnoseQueryTileSourceSupport({
      ...this.descriptor,
      cache: { ...(this.descriptor.cache ?? {}), ...this.#cachePolicy },
    });
  }

  #cacheKey(tileKey: QueryTileKey, cache: QueryTileCacheKeyOptions["cache"] | undefined): string {
    return buildQueryTileCacheKey(this.descriptor, tileKey, { cache });
  }

  #isFresh(entry: CacheEntry<T>, now: number): boolean {
    const ttlMs = this.#cachePolicy.ttlMs;
    return ttlMs === undefined || now - entry.createdAt <= ttlMs;
  }

  #enforceMaxEntries(): void {
    const maxEntries = this.#cachePolicy.maxEntries;
    if (maxEntries === undefined || maxEntries < 0) return;
    while (this.#cache.size > maxEntries) {
      const lru = [...this.#cache.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
      if (!lru) return;
      this.#evict(lru[0], lru[1], "lru");
    }
  }

  #evict(cacheKey: string, entry: CacheEntry<T>, reason: "invalidate" | "lru" | "clear"): void {
    if (!this.#cache.delete(cacheKey)) return;
    this.#emit({ type: "tile-evicted", ...this.#eventBase(entry.tileKey, cacheKey), reason });
  }

  #eventBase(
    tileKey: QueryTileKey,
    cacheKey: string,
  ): {
    descriptorId: string;
    sourceId: string;
    tileKey: QueryTileKey;
    cacheKey: string;
  } {
    return {
      descriptorId: this.descriptor.id,
      sourceId: this.descriptor.sourceId,
      tileKey,
      cacheKey,
    };
  }

  #emit(event: QueryTileLifecycleEvent<T>): void {
    this.#onEvent?.(event);
  }
}

function fieldsToTileJson(fields: readonly string[] | undefined): Record<string, string> | undefined {
  if (!fields || fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((field) => [field, "String"]));
}

function promoteIdFromIdentity(
  identity: QueryTileFeatureIdentityDescriptor | undefined,
): string | Readonly<Record<string, string>> | undefined {
  if (identity?.promoteId) return identity.promoteId;
  if (typeof identity?.idProperty === "string") return identity.idProperty;
  return undefined;
}

function buildQueryTileJsonRequestUrl<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  options: FetchQueryTileJsonOptions,
): string {
  const endpoint = { ...(descriptor.endpoint ?? {}), ...(options.endpoint ?? {}) };
  if (options.url) return options.url;
  if (endpoint.tilejsonUrl)
    return appendParams(endpoint.tilejsonUrl, {
      ...queryTileServerRequestParamsFromDescriptor(descriptor, { params: options.params }),
      ...(options.extraParams ?? {}),
    });
  const baseUrl = endpoint.baseUrl ?? descriptor.source?.locator.url;
  if (!baseUrl) {
    throw new Error(`query tile descriptor "${descriptor.id}" is missing endpoint.baseUrl or endpoint.tilejsonUrl`);
  }
  const path = buildQueryTileServerPath("tilejson", {
    sourceId: descriptor.sourceId,
    routePrefix: options.routePrefix ?? "",
  });
  return appendParams(joinUrl(baseUrl, path), {
    ...queryTileServerRequestParamsFromDescriptor(descriptor, { params: options.params }),
    ...(options.extraParams ?? {}),
  });
}

function buildQueryTileFeatureDetailRequestUrl<T = Record<string, unknown>>(
  descriptor: QueryTileSourceDescriptor<T>,
  target: QueryTileFeatureIdentityTarget,
  options: FetchQueryTileFeatureDetailOptions,
): string {
  const detailTemplate = descriptor.tilejson?.["honua:queryTiles"]?.detailUrlTemplate;
  const baseUrl = descriptor.endpoint?.baseUrl ?? descriptor.source?.locator.url;
  const url = detailTemplate
    ? substituteFeatureDetailTemplate(detailTemplate, target)
    : baseUrl
      ? joinUrl(
          baseUrl,
          buildQueryTileServerPath("feature-detail", {
            sourceId: target.sourceId || descriptor.sourceId,
            featureId: target.id,
            routePrefix: options.routePrefix ?? "",
          }),
        )
      : undefined;
  if (!url) {
    throw new Error(`query tile descriptor "${descriptor.id}" is missing detailUrlTemplate or endpoint.baseUrl`);
  }
  return appendParams(url, { ...(options.params ?? {}), ...(options.extraParams ?? {}) });
}

function substituteFeatureDetailTemplate(template: string, target: QueryTileFeatureIdentityTarget): string {
  return template
    .replaceAll("{sourceId}", encodeURIComponent(target.sourceId))
    .replaceAll("{featureId}", encodeURIComponent(String(target.id)))
    .replaceAll("{id}", encodeURIComponent(String(target.id)))
    .replaceAll("{sourceLayer}", encodeURIComponent(target.sourceLayer ?? ""));
}

function queryTileFetch(options: QueryTileServerFetchOptions): QueryTileServerFetch {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("fetch is required to request query tile server resources");
  return fetchImpl;
}

function queryTileRequestHeaders(accept: string, options: QueryTileServerFetchOptions): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) headers.set("Accept", accept);
  if (options.validators?.etag && !headers.has("If-None-Match")) {
    headers.set("If-None-Match", options.validators.etag);
  }
  if (options.validators?.lastModified && !headers.has("If-Modified-Since")) {
    headers.set("If-Modified-Since", options.validators.lastModified);
  }
  return headers;
}

function queryTileValidatorsFromHeaders(headers: Headers): QueryTileServerCacheValidators {
  return stripUndefined({
    etag: headers.get("ETag") ?? undefined,
    lastModified: headers.get("Last-Modified") ?? undefined,
    cacheControl: headers.get("Cache-Control") ?? undefined,
    expires: headers.get("Expires") ?? undefined,
    vary: headers.get("Vary") ?? undefined,
    sourceVersion: headers.get("X-Honua-Source-Version") ?? undefined,
  });
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

function queryTileServerResponseError(
  url: string,
  status: number,
  body: unknown,
  validators: QueryTileServerCacheValidators,
): QueryTileServerResponseError {
  let errorResponse: QueryTileServerErrorResponse | undefined;
  try {
    errorResponse = parseQueryTileServerErrorResponse(body);
  } catch {
    errorResponse = undefined;
  }
  return new QueryTileServerResponseError({
    status,
    url,
    response: errorResponse,
    body,
    validators,
    message: errorResponse?.error.message ?? `query tile server request failed with HTTP ${status}`,
  });
}

function joinUrl(baseUrl: string, path: string): string {
  const [basePath, query = ""] = baseUrl.split("?", 2);
  const joined = `${basePath.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return query ? `${joined}?${query}` : joined;
}

function appendParams(url: string, params: Readonly<Record<string, unknown>>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const serialized = urlParamValue(value);
    if (serialized === undefined) continue;
    searchParams.set(key, serialized);
  }
  const query = searchParams.toString();
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function urlParamValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") return stableJson(value);
  return String(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

function clampZoom(zoom: number, minzoom: number | undefined, maxzoom: number | undefined): number {
  const min = minzoom ?? 0;
  const max = maxzoom ?? 24;
  return Math.min(max, Math.max(min, zoom));
}

function tileRangesForBounds(
  bounds: readonly [number, number, number, number],
  z: number,
): Array<{ minX: number; maxX: number; minY: number; maxY: number }> {
  const [west, south, east, north] = bounds;
  if (west <= east) return [tileRangeForNormalizedBounds(west, south, east, north, z)];
  return [
    tileRangeForNormalizedBounds(west, south, 180, north, z),
    tileRangeForNormalizedBounds(-180, south, east, north, z),
  ];
}

function tileRangeForNormalizedBounds(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const tileCount = 2 ** z;
  const minX = lonToTileX(west, z);
  const maxX = lonToTileX(east, z);
  const minY = latToTileY(north, z);
  const maxY = latToTileY(south, z);
  return {
    minX: Math.max(0, Math.min(tileCount - 1, Math.min(minX, maxX))),
    maxX: Math.max(0, Math.min(tileCount - 1, Math.max(minX, maxX))),
    minY: Math.max(0, Math.min(tileCount - 1, Math.min(minY, maxY))),
    maxY: Math.max(0, Math.min(tileCount - 1, Math.max(minY, maxY))),
  };
}

function lonToTileX(lon: number, z: number): number {
  const clampedLon = Math.max(-180, Math.min(180, lon));
  return Math.floor(((clampedLon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const clampedLat = Math.max(-WEB_MERCATOR_LAT_LIMIT, Math.min(WEB_MERCATOR_LAT_LIMIT, lat));
  const radians = (clampedLat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** z);
}

function uniqueTiles(tiles: readonly QueryTileKey[]): readonly QueryTileKey[] {
  const seen = new Set<string>();
  const out: QueryTileKey[] = [];
  for (const tile of tiles) {
    const id = stableJson(tile);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(tile);
  }
  return out;
}

function sameTile(a: QueryTileKey, b: QueryTileKey): boolean {
  return a.z === b.z && a.x === b.x && a.y === b.y;
}

function linkAbortSignals(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" ? reason : "tile request aborted");
  error.name = "AbortError";
  return error;
}
