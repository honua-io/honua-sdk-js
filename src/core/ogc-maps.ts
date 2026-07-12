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

/** Honua facade path prefix for OGC API Maps. */
const MAPS_FACADE_BASE = "/ogc/maps";

/**
 * Resolve the OGC API Maps path prefix: the caller-supplied raw `basePath` (a
 * `connect()`-discovered third-party service root) or the Honua facade default.
 * Trailing slashes are trimmed so a discovered root and the facade compose the
 * same sub-paths. Mirrors the OGC API Records seam in `ogc-records.ts`.
 */
function mapsBase(request: { basePath?: string }): string {
  // An omitted basePath uses the Honua facade; an explicit "" is a legitimate
  // root-mounted raw service and must NOT fall back to the facade prefix.
  if (request.basePath === undefined) return MAPS_FACADE_BASE;
  const base = request.basePath;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  return base.slice(0, end);
}

/** Cache-key discriminator so a discovered root never collides with the facade. */
function mapsBaseKey(request: { basePath?: string }): string {
  const base = mapsBase(request);
  return base === MAPS_FACADE_BASE ? "" : `${base}:`;
}

export interface HonuaOgcMapsOptions {
  client: HonuaClient;
  /** Raw endpoint path prefix (defaults to the Honua facade `/ogc/maps`). */
  basePath?: string;
}

export interface HonuaOgcCollectionMapOptions {
  client: HonuaClient;
  collectionId: string | number;
  styleId?: string;
  /** Raw endpoint path prefix (defaults to the Honua facade `/ogc/maps`). */
  basePath?: string;
}

export type HonuaOgcCollectionMapImageRequest = Omit<OgcMapImageRequest, "collectionId" | "styleId"> & {
  styleId?: string;
};

/** Top-level OGC API Maps handle. */
export class HonuaOgcMaps {
  public readonly client: HonuaClient;
  private readonly basePath: string | undefined;

  public constructor(options: HonuaOgcMapsOptions) {
    this.client = options.client;
    this.basePath = options.basePath;
  }

  private withBase<T extends { basePath?: string }>(request: T): T {
    return this.basePath !== undefined ? { ...request, basePath: this.basePath } : request;
  }

  public collection(collectionId: string | number, styleId?: string): HonuaOgcCollectionMap {
    return new HonuaOgcCollectionMap({
      client: this.client,
      collectionId,
      styleId,
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
    });
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcMapsLanding(this.withBase(request));
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcMapsConformance(this.withBase(request));
  }

  /** Render a dataset-level map (across one or more collections). */
  public async map(request: OgcMapImageRequest = {}): Promise<HonuaOgcMapImageResponse> {
    return this.client.getOgcMapImage(this.withBase(request));
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
  private readonly basePath: string | undefined;

  public constructor(options: HonuaOgcCollectionMapOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
    this.styleId = options.styleId;
    this.basePath = options.basePath;
  }

  public async map(request: HonuaOgcCollectionMapImageRequest = {}): Promise<HonuaOgcMapImageResponse> {
    return this.client.getOgcMapImage({
      ...request,
      collectionId: this.collectionId,
      styleId: request.styleId ?? this.styleId,
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
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
  const base = mapsBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-maps:landing:${mapsBaseKey(request)}${params.toString()}`,
    `${base}?${params.toString()}`,
    request,
  );
}

export async function getOgcMapsConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  const base = mapsBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-maps:conformance:${mapsBaseKey(request)}${params.toString()}`,
    `${base}/conformance?${params.toString()}`,
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
  const path = `${mapsBase(request)}${collectionPart}${stylePart}/map${params.size > 0 ? `?${params.toString()}` : ""}`;
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
