/**
 * OGC API Tiles surface. Wraps the wire methods on `HonuaClient` with a
 * tileset-discovery friendly API and a single-tile fetch helper. The
 * conformance class identifiers are kept internal — callers see
 * tilesets, tile-matrix-sets, and styled-tile access through the shared
 * vocabulary, never an `OgcApiTilesPart2DatasetMap` typename.
 *
 * @module
 */

import type { HonuaMetadataRequestOptions } from "./cache-state.js";
import type { HonuaClient } from "./client.js";
import { encodePathSegments, trimTrailingSlashes } from "./path-utils.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcTileMatrixSet,
  HonuaOgcTileMatrixSetsResponse,
  HonuaOgcTileResponse,
  HonuaOgcTilesetMetadata,
  HonuaOgcTilesetsResponse,
  OgcMetadataRequest,
  OgcTileMatrixSetId,
  OgcTileRequest,
  OgcTilesetRequest,
  OgcTilesetsRequest,
} from "./types.js";
import { createOgcMetadataParams } from "./wire-shared.js";

/** Default OGC tile-matrix-set used when none is specified (Web Mercator XYZ). */
export const DEFAULT_OGC_TILE_MATRIX_SET: OgcTileMatrixSetId = "WebMercatorQuad";

/** Honua facade path prefix for OGC API Tiles. */
const TILES_FACADE_BASE = "/ogc/tiles";

/**
 * Resolve the OGC API Tiles path prefix: the caller-supplied raw `basePath` (a
 * `connect()`-discovered third-party service root) or the Honua facade default.
 * Trailing slashes are trimmed so a discovered root and the facade compose the
 * same sub-paths. Mirrors the OGC API Records seam in `ogc-records.ts`.
 */
function tilesBase(request: { basePath?: string }): string {
  // An omitted basePath uses the Honua facade; an explicit "" is a legitimate
  // root-mounted raw service and must NOT fall back to the facade prefix.
  if (request.basePath === undefined) return TILES_FACADE_BASE;
  const base = request.basePath;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  return base.slice(0, end);
}

/** Cache-key discriminator so a discovered root never collides with the facade. */
function tilesBaseKey(request: { basePath?: string }): string {
  const base = tilesBase(request);
  return base === TILES_FACADE_BASE ? "" : `${base}:`;
}

export interface HonuaOgcTilesOptions {
  client: HonuaClient;
  /** Raw endpoint path prefix (defaults to the Honua facade `/ogc/tiles`). */
  basePath?: string;
}

/**
 * Structural shape of a MapLibre `VectorSourceSpecification` for tiled
 * vector data. Declared locally so the SDK does not take a runtime or type
 * dependency on `maplibre-gl` (a peer); the object is assignable to
 * MapLibre's `VectorSourceSpecification`.
 */
export interface MapLibreVectorSourceSpec {
  type: "vector";
  tiles: string[];
  minzoom?: number;
  maxzoom?: number;
  scheme?: "xyz";
}

/** Options for {@link HonuaOgcTiles.getMapLibreVectorSource}. */
export interface HonuaMapLibreVectorSourceOptions {
  /** Tile-matrix-set to template against. Defaults to `WebMercatorQuad`. */
  tileMatrixSetId?: OgcTileMatrixSetId;
  /** Override the `minzoom` of the produced source. */
  minzoom?: number;
  /** Override the `maxzoom` of the produced source. */
  maxzoom?: number;
}

/** Result of {@link HonuaOgcTiles.getMapLibreConfig}. */
export interface HonuaMapLibreTilesConfig {
  source: MapLibreVectorSourceSpec;
  sourceLayer: string;
}

export interface HonuaOgcTilesetOptions {
  client: HonuaClient;
  collectionId: string | number;
  tileMatrixSetId: string;
  /** Raw endpoint path prefix (defaults to the Honua facade `/ogc/tiles`). */
  basePath?: string;
}

export type HonuaOgcCollectionTilesetRequest = Omit<OgcTilesetRequest, "collectionId" | "tileMatrixSetId">;
export type HonuaOgcCollectionTilesetsRequest = Omit<OgcTilesetsRequest, "collectionId">;
export type HonuaOgcCollectionTileRequest = Omit<OgcTileRequest, "collectionId" | "tileMatrixSetId">;

/**
 * Top-level OGC API Tiles handle. Mirrors `HonuaOgcFeatures` for the
 * tiles conformance classes.
 */
export class HonuaOgcTiles {
  public readonly client: HonuaClient;
  private readonly basePath: string | undefined;

  public constructor(options: HonuaOgcTilesOptions) {
    this.client = options.client;
    this.basePath = options.basePath;
  }

  private withBase<T extends { basePath?: string }>(request: T): T {
    return this.basePath !== undefined ? { ...request, basePath: this.basePath } : request;
  }

  public tileset(collectionId: string | number, tileMatrixSetId: string): HonuaOgcTileset {
    return new HonuaOgcTileset({
      client: this.client,
      collectionId,
      tileMatrixSetId,
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
    });
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcTilesLanding(this.withBase(request));
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcTilesConformance(this.withBase(request));
  }

  public async tileMatrixSets(request: OgcMetadataRequest = {}): Promise<HonuaOgcTileMatrixSetsResponse> {
    return this.client.listOgcTileMatrixSets(this.withBase(request));
  }

  public async tileMatrixSet(
    tileMatrixSetId: string,
    request: OgcMetadataRequest = {},
  ): Promise<HonuaOgcTileMatrixSet> {
    return this.client.getOgcTileMatrixSet(this.withBase({ ...request, tileMatrixSetId }));
  }

  public async tilesets(request: OgcTilesetsRequest): Promise<HonuaOgcTilesetsResponse> {
    return this.client.listOgcCollectionTilesets(this.withBase(request));
  }

  public async tilesetMetadata(request: OgcTilesetRequest): Promise<HonuaOgcTilesetMetadata> {
    return this.client.getOgcCollectionTileset(this.withBase(request));
  }

  public async tile(request: OgcTileRequest): Promise<HonuaOgcTileResponse> {
    return this.client.fetchOgcTile(this.withBase(request));
  }

  /**
   * Build a MapLibre-ready vector source definition for a tiled collection.
   *
   * Produces a `{ type: "vector", tiles: ["…/{z}/{y}/{x}"] }` object whose
   * tile URL points at the canonical OGC API Tiles collection-tile route on
   * the SDK's configured `baseUrl`. The MapLibre `{z}/{y}/{x}` placeholders
   * are kept literal (the braces are not percent-encoded) while the
   * collection / service identifier is encoded per path segment so
   * folder-prefixed identifiers like `myFolder/parcels` serialize correctly.
   *
   * No network request is made; this is a pure URL-template builder. Pass
   * `minzoom` / `maxzoom` to constrain the source, otherwise MapLibre's
   * defaults apply.
   */
  public getMapLibreVectorSource(
    serviceId: string,
    options: HonuaMapLibreVectorSourceOptions = {},
  ): MapLibreVectorSourceSpec {
    const tileMatrixSetId = options.tileMatrixSetId ?? DEFAULT_OGC_TILE_MATRIX_SET;
    const baseUrl = trimTrailingSlashes(this.client.serverBaseUrl);
    const collection = encodePathSegments(serviceId);
    const matrixSet = encodeURIComponent(tileMatrixSetId);
    const base = tilesBase({ ...(this.basePath !== undefined ? { basePath: this.basePath } : {}) });
    const template = `${baseUrl}${base}/collections/${collection}/tiles/${matrixSet}/{z}/{y}/{x}`;
    const source: MapLibreVectorSourceSpec = {
      type: "vector",
      tiles: [template],
      scheme: "xyz",
    };
    if (options.minzoom !== undefined) source.minzoom = options.minzoom;
    if (options.maxzoom !== undefined) source.maxzoom = options.maxzoom;
    return source;
  }

  /**
   * Resolve the `source-layer` name to use in a MapLibre layer that renders
   * the collection's vector tiles. The Honua server names the MVT layer after
   * the collection identifier; for folder-prefixed identifiers the trailing
   * segment is the layer name (the folder is a routing prefix, not part of
   * the layer name baked into the tile).
   */
  public getDefaultSourceLayer(serviceId: string): string {
    const segments = serviceId.split("/");
    return segments[segments.length - 1] ?? serviceId;
  }

  /**
   * Convenience wrapper returning both the MapLibre vector {@link source}
   * object and the {@link sourceLayer} name to wire into a layer definition.
   */
  public getMapLibreConfig(
    serviceId: string,
    options: HonuaMapLibreVectorSourceOptions = {},
  ): HonuaMapLibreTilesConfig {
    return {
      source: this.getMapLibreVectorSource(serviceId, options),
      sourceLayer: this.getDefaultSourceLayer(serviceId),
    };
  }
}

/**
 * Bound handle for one (collection × tile-matrix-set) tileset. Drops the
 * discovery params from the per-call surface so callers focus on tile
 * coordinates. Styled-tile access (the OGC `/styles/{styleId}` route) is
 * not exposed here because the Honua server does not currently implement
 * that route; the tile path is the canonical collection tile route.
 */
export class HonuaOgcTileset {
  public readonly client: HonuaClient;
  public readonly collectionId: string | number;
  public readonly tileMatrixSetId: string;
  private readonly basePath: string | undefined;

  public constructor(options: HonuaOgcTilesetOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
    this.tileMatrixSetId = options.tileMatrixSetId;
    this.basePath = options.basePath;
  }

  public async metadata(request: HonuaOgcCollectionTilesetRequest = {}): Promise<HonuaOgcTilesetMetadata> {
    return this.client.getOgcCollectionTileset({
      ...request,
      collectionId: this.collectionId,
      tileMatrixSetId: this.tileMatrixSetId,
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
    });
  }

  public async tile(request: HonuaOgcCollectionTileRequest): Promise<HonuaOgcTileResponse> {
    return this.client.fetchOgcTile({
      ...request,
      collectionId: this.collectionId,
      tileMatrixSetId: this.tileMatrixSetId,
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
    });
  }
}

export function createHonuaOgcTiles(client: HonuaClient): HonuaOgcTiles {
  return new HonuaOgcTiles({ client });
}

// ── OGC API Tiles wire methods ──────────────────────────────────
//
// Concrete URL-building / param-serialization / response-handling for the
// OGC API Tiles endpoints, invoked against an injected transport. The client
// exposes thin `get*/list*/fetch*` delegators that call these.

export async function getOgcTilesLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  const base = tilesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-tiles:landing:${tilesBaseKey(request)}${params.toString()}`,
    `${base}?${params.toString()}`,
    request,
  );
}

export async function getOgcTilesConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  const base = tilesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-tiles:conformance:${tilesBaseKey(request)}${params.toString()}`,
    `${base}/conformance?${params.toString()}`,
    request,
  );
}

export async function listOgcTileMatrixSets(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcTileMatrixSetsResponse> {
  const params = createOgcMetadataParams(request);
  const base = tilesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcTileMatrixSetsResponse>(
    `ogc-tiles:tile-matrix-sets:${tilesBaseKey(request)}${params.toString()}`,
    `${base}/tileMatrixSets?${params.toString()}`,
    request,
  );
}

export async function getOgcTileMatrixSet(
  transport: HonuaProtocolTransport,
  request: {
    tileMatrixSetId: string;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  } & HonuaMetadataRequestOptions & { basePath?: string },
): Promise<HonuaOgcTileMatrixSet> {
  const params = createOgcMetadataParams(request);
  const base = tilesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcTileMatrixSet>(
    `ogc-tiles:tile-matrix-set:${tilesBaseKey(request)}${request.tileMatrixSetId}:${params.toString()}`,
    `${base}/tileMatrixSets/${encodeURIComponent(request.tileMatrixSetId)}?${params.toString()}`,
    request,
  );
}

export async function listOgcCollectionTilesets(
  transport: HonuaProtocolTransport,
  request: OgcTilesetsRequest,
): Promise<HonuaOgcTilesetsResponse> {
  const params = createOgcMetadataParams(request);
  const path = `${tilesBase(request)}/collections/${encodeURIComponent(String(request.collectionId))}/tiles`;
  return transport.requestCachedMetadataJson<HonuaOgcTilesetsResponse>(
    `ogc-tiles:tilesets:${tilesBaseKey(request)}${request.collectionId}:${params.toString()}`,
    `${path}?${params.toString()}`,
    request,
  );
}

export async function getOgcCollectionTileset(
  transport: HonuaProtocolTransport,
  request: OgcTilesetRequest,
): Promise<HonuaOgcTilesetMetadata> {
  const params = createOgcMetadataParams(request);
  const path =
    `${tilesBase(request)}/collections/${encodeURIComponent(String(request.collectionId))}` +
    `/tiles/${encodeURIComponent(request.tileMatrixSetId)}`;
  return transport.requestCachedMetadataJson<HonuaOgcTilesetMetadata>(
    `ogc-tiles:tileset:${tilesBaseKey(request)}${request.collectionId}:${request.tileMatrixSetId}:${params.toString()}`,
    `${path}?${params.toString()}`,
    request,
  );
}

export async function fetchOgcTile(
  transport: HonuaProtocolTransport,
  request: OgcTileRequest,
): Promise<HonuaOgcTileResponse> {
  const params = new URLSearchParams();
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  const collection = encodeURIComponent(String(request.collectionId));
  const matrixSet = encodeURIComponent(request.tileMatrixSetId);
  const matrix = encodeURIComponent(String(request.tileMatrix));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const path = `${tilesBase(request)}/collections/${collection}/tiles/${matrixSet}/${matrix}/${request.tileRow}/${request.tileCol}${query}`;
  return transport.requestBytes("GET", path, request.accept, undefined, request.signal);
}
