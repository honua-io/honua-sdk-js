/**
 * OGC API Tiles surface. Wraps the wire methods on `HonuaClient` with a
 * tileset-discovery friendly API and a single-tile fetch helper. The
 * conformance class identifiers are kept internal — callers see
 * tilesets, tile-matrix-sets, and styled-tile access through the shared
 * vocabulary, never an `OgcApiTilesPart2DatasetMap` typename.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import { encodePathSegments, trimTrailingSlashes } from "./path-utils.js";
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

/** Default OGC tile-matrix-set used when none is specified (Web Mercator XYZ). */
export const DEFAULT_OGC_TILE_MATRIX_SET: OgcTileMatrixSetId = "WebMercatorQuad";

export interface HonuaOgcTilesOptions {
  client: HonuaClient;
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

  public constructor(options: HonuaOgcTilesOptions) {
    this.client = options.client;
  }

  public tileset(collectionId: string | number, tileMatrixSetId: string): HonuaOgcTileset {
    return new HonuaOgcTileset({
      client: this.client,
      collectionId,
      tileMatrixSetId,
    });
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcTilesLanding(request);
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcTilesConformance(request);
  }

  public async tileMatrixSets(request: OgcMetadataRequest = {}): Promise<HonuaOgcTileMatrixSetsResponse> {
    return this.client.listOgcTileMatrixSets(request);
  }

  public async tileMatrixSet(
    tileMatrixSetId: string,
    request: OgcMetadataRequest = {},
  ): Promise<HonuaOgcTileMatrixSet> {
    return this.client.getOgcTileMatrixSet({ ...request, tileMatrixSetId });
  }

  public async tilesets(request: OgcTilesetsRequest): Promise<HonuaOgcTilesetsResponse> {
    return this.client.listOgcCollectionTilesets(request);
  }

  public async tilesetMetadata(request: OgcTilesetRequest): Promise<HonuaOgcTilesetMetadata> {
    return this.client.getOgcCollectionTileset(request);
  }

  public async tile(request: OgcTileRequest): Promise<HonuaOgcTileResponse> {
    return this.client.fetchOgcTile(request);
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
    const template = `${baseUrl}/ogc/tiles/collections/${collection}/tiles/${matrixSet}/{z}/{y}/{x}`;
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

  public constructor(options: HonuaOgcTilesetOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
    this.tileMatrixSetId = options.tileMatrixSetId;
  }

  public async metadata(request: HonuaOgcCollectionTilesetRequest = {}): Promise<HonuaOgcTilesetMetadata> {
    return this.client.getOgcCollectionTileset({
      ...request,
      collectionId: this.collectionId,
      tileMatrixSetId: this.tileMatrixSetId,
    });
  }

  public async tile(request: HonuaOgcCollectionTileRequest): Promise<HonuaOgcTileResponse> {
    return this.client.fetchOgcTile({
      ...request,
      collectionId: this.collectionId,
      tileMatrixSetId: this.tileMatrixSetId,
    });
  }
}

export function createHonuaOgcTiles(client: HonuaClient): HonuaOgcTiles {
  return new HonuaOgcTiles({ client });
}
