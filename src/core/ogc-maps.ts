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
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcMapImageResponse,
  OgcMapImageRequest,
  OgcMetadataRequest,
} from "./types.js";
import { createOgcMetadataParams } from "./wire-shared.js";

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

// ── OGC API Maps wire methods ───────────────────────────────────

export async function getOgcMapsLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-maps:landing:${params.toString()}`,
    `/ogc/maps?${params.toString()}`,
    request,
  );
}

export async function getOgcMapsConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-maps:conformance:${params.toString()}`,
    `/ogc/maps/conformance?${params.toString()}`,
    request,
  );
}

export async function getOgcMapImage(
  transport: HonuaProtocolTransport,
  request: OgcMapImageRequest,
): Promise<HonuaOgcMapImageResponse> {
  const params = serializeOgcMapImageParams(request);
  const collectionPart =
    request.collectionId !== undefined ? `/collections/${encodeURIComponent(String(request.collectionId))}` : "";
  const stylePart = request.styleId ? `/styles/${encodeURIComponent(request.styleId)}` : "";
  const path = `/ogc/maps${collectionPart}${stylePart}/map${params.size > 0 ? `?${params.toString()}` : ""}`;
  const accept = ogcMapAcceptHeader(request.format) ?? "image/png";
  const response = await transport.requestBytes("GET", path, accept, undefined, request.signal);
  return { bytes: response.bytes, contentType: response.contentType };
}

function serializeOgcMapImageParams(request: OgcMapImageRequest): URLSearchParams {
  const params = new URLSearchParams();
  const f = ogcMapShortFormat(request.format);
  if (f !== undefined) params.set("f", f);
  if (request.width !== undefined) params.set("width", String(request.width));
  if (request.height !== undefined) params.set("height", String(request.height));
  if (request.bbox !== undefined) {
    params.set("bbox", typeof request.bbox === "string" ? request.bbox : request.bbox.join(","));
  }
  if (request.bboxCrs !== undefined) params.set("bbox-crs", request.bboxCrs);
  if (request.crs !== undefined) params.set("crs", request.crs);
  if (request.collections !== undefined && request.collections.length > 0) {
    params.set("collections", request.collections.join(","));
  }
  if (request.transparent !== undefined) params.set("transparent", String(request.transparent));
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  return params;
}

const OGC_MAP_FORMAT_TO_SHORT: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/jpg", "jpg"],
  ["image/tiff", "tiff"],
  ["image/tif", "tif"],
]);

const OGC_MAP_SHORT_TO_MEDIA: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["tiff", "image/tiff"],
  ["tif", "image/tiff"],
]);

function ogcMapShortFormat(format: string | undefined): string | undefined {
  if (format === undefined) return undefined;
  const lower = format.toLowerCase();
  return OGC_MAP_FORMAT_TO_SHORT.get(lower) ?? lower;
}

function ogcMapAcceptHeader(format: string | undefined): string | undefined {
  if (format === undefined) return undefined;
  const lower = format.toLowerCase();
  return OGC_MAP_SHORT_TO_MEDIA.get(lower) ?? format;
}
