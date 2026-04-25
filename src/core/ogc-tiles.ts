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
import type {
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcTileMatrixSet,
  HonuaOgcTileMatrixSetsResponse,
  HonuaOgcTileResponse,
  HonuaOgcTilesetMetadata,
  HonuaOgcTilesetsResponse,
  OgcMetadataRequest,
  OgcTileRequest,
  OgcTilesetRequest,
  OgcTilesetsRequest,
} from "./types.js";

export interface HonuaOgcTilesOptions {
  client: HonuaClient;
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
