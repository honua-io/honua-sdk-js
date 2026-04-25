/**
 * OGC API Maps surface. Server-rendered map images at the dataset or
 * collection level, with optional styled-output access. The runtime
 * deliberately exposes a thin envelope (`width`, `height`, `bbox`,
 * `crs`, `format`, optional `filter` / `collections`) — extension
 * parameters live on `extraParams`.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import type {
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcMapImageResponse,
  OgcMapImageRequest,
  OgcMetadataRequest,
} from "./types.js";

export interface HonuaOgcMapsOptions {
  client: HonuaClient;
}

export interface HonuaOgcCollectionMapOptions {
  client: HonuaClient;
  collectionId: string | number;
  styleId?: string;
}

export type HonuaOgcCollectionMapImageRequest = Omit<OgcMapImageRequest, "collectionId" | "styleId"> & {
  styleId?: string;
};

/** Top-level OGC API Maps handle. */
export class HonuaOgcMaps {
  public readonly client: HonuaClient;

  public constructor(options: HonuaOgcMapsOptions) {
    this.client = options.client;
  }

  public collection(collectionId: string | number, styleId?: string): HonuaOgcCollectionMap {
    return new HonuaOgcCollectionMap({ client: this.client, collectionId, styleId });
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcMapsLanding(request);
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcMapsConformance(request);
  }

  /** Render a dataset-level map (across one or more collections). */
  public async map(request: OgcMapImageRequest = {}): Promise<HonuaOgcMapImageResponse> {
    return this.client.getOgcMapImage(request);
  }
}

/**
 * Bound handle for a collection-level (and optionally styled) map. Drops
 * the routing-discriminator fields from per-call requests.
 */
export class HonuaOgcCollectionMap {
  public readonly client: HonuaClient;
  public readonly collectionId: string | number;
  public readonly styleId: string | undefined;

  public constructor(options: HonuaOgcCollectionMapOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
    this.styleId = options.styleId;
  }

  public async map(request: HonuaOgcCollectionMapImageRequest = {}): Promise<HonuaOgcMapImageResponse> {
    return this.client.getOgcMapImage({
      ...request,
      collectionId: this.collectionId,
      styleId: request.styleId ?? this.styleId,
    });
  }
}

export function createHonuaOgcMaps(client: HonuaClient): HonuaOgcMaps {
  return new HonuaOgcMaps({ client });
}
