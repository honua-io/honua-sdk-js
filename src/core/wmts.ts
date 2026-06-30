/**
 * First-party WMTS 1.0.0 adapter. `HonuaWmts` is the service-level
 * handle returned by `client.wmts(serviceId)`; `HonuaWmtsLayer` is a
 * single-layer projection that pre-fills LAYER and (optionally) STYLE;
 * `HonuaWmtsTileset` adds a TileMatrixSet binding so per-call requests
 * shrink to `{tileMatrix, tileRow, tileCol}`.
 *
 * The wire path lives on `HonuaClient` (`getWmtsCapabilities`,
 * `fetchWmtsTile`, `getWmtsFeatureInfo`).
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import { encodeServiceIdPath } from "./path-utils.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import {
  type HonuaWmtsFeatureInfoResponse,
  type HonuaWmtsTileResponse,
  type WmtsFeatureInfoRequest,
  type WmtsTileRequest,
  wmtsExtensionForFormat,
} from "./wms-types.js";
import { decodeWmsFeatureInfoResponse } from "./wms.js";
import type { WmtsCapabilities, WmtsCapabilityLayer, WmtsCapabilityTileMatrixSet } from "./wmts-capabilities.js";
import { findWmtsLayer, findWmtsTileMatrixSet, parseWmtsCapabilities } from "./wmts-capabilities.js";

export interface HonuaWmtsOptions {
  client: HonuaClient;
  serviceId: string;
}

export interface HonuaWmtsLayerOptions extends HonuaWmtsOptions {
  layerName: string;
  defaultStyleId?: string;
  defaultTileMatrixSetId?: string;
}

export interface HonuaWmtsTilesetOptions extends HonuaWmtsOptions {
  layerName: string;
  styleId: string;
  tileMatrixSetId: string;
}

export class HonuaWmts {
  public readonly client: HonuaClient;
  public readonly serviceId: string;

  public constructor(options: HonuaWmtsOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
  }

  /** Bind a single LAYER + optional STYLE / TileMatrixSet defaults. */
  public layer(name: string, options?: { styleId?: string; tileMatrixSetId?: string }): HonuaWmtsLayer {
    const opts: HonuaWmtsLayerOptions = {
      client: this.client,
      serviceId: this.serviceId,
      layerName: name,
    };
    if (options?.styleId !== undefined) opts.defaultStyleId = options.styleId;
    if (options?.tileMatrixSetId !== undefined) opts.defaultTileMatrixSetId = options.tileMatrixSetId;
    return new HonuaWmtsLayer(opts);
  }

  public tileset(layerName: string, styleId: string, tileMatrixSetId: string): HonuaWmtsTileset {
    return new HonuaWmtsTileset({
      client: this.client,
      serviceId: this.serviceId,
      layerName,
      styleId,
      tileMatrixSetId,
    });
  }

  public async capabilities(options?: { signal?: AbortSignal }): Promise<WmtsCapabilities> {
    return this.client.getWmtsCapabilities({
      serviceId: this.serviceId,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  public async tile(request: WmtsTileRequest): Promise<HonuaWmtsTileResponse> {
    return this.client.fetchWmtsTile({ serviceId: this.serviceId, ...request });
  }

  public async featureInfo<T = Record<string, unknown>>(
    request: WmtsFeatureInfoRequest,
  ): Promise<HonuaWmtsFeatureInfoResponse<T>> {
    return this.client.getWmtsFeatureInfo<T>({ serviceId: this.serviceId, ...request });
  }
}

export class HonuaWmtsLayer {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  public readonly layerName: string;
  public readonly defaultStyleId: string | undefined;
  public readonly defaultTileMatrixSetId: string | undefined;

  public constructor(options: HonuaWmtsLayerOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.layerName = options.layerName;
    this.defaultStyleId = options.defaultStyleId;
    this.defaultTileMatrixSetId = options.defaultTileMatrixSetId;
  }

  public describe(capabilities: WmtsCapabilities): WmtsCapabilityLayer | undefined {
    return findWmtsLayer(capabilities, this.layerName);
  }

  public tileset(styleId?: string, tileMatrixSetId?: string): HonuaWmtsTileset {
    const style = styleId ?? this.defaultStyleId ?? "default";
    const tms = tileMatrixSetId ?? this.defaultTileMatrixSetId ?? "WebMercatorQuad";
    return new HonuaWmtsTileset({
      client: this.client,
      serviceId: this.serviceId,
      layerName: this.layerName,
      styleId: style,
      tileMatrixSetId: tms,
    });
  }

  public async tile(
    request: Omit<WmtsTileRequest, "layer" | "style" | "tileMatrixSet"> & {
      style?: string;
      tileMatrixSet?: string;
    },
  ): Promise<HonuaWmtsTileResponse> {
    return this.client.fetchWmtsTile({
      serviceId: this.serviceId,
      layer: this.layerName,
      style: request.style ?? this.defaultStyleId,
      tileMatrixSet: request.tileMatrixSet ?? this.defaultTileMatrixSetId,
      tileMatrix: request.tileMatrix,
      tileRow: request.tileRow,
      tileCol: request.tileCol,
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.extraParams !== undefined ? { extraParams: request.extraParams } : {}),
    });
  }

  public async featureInfo<T = Record<string, unknown>>(
    request: Omit<WmtsFeatureInfoRequest, "layer" | "style" | "tileMatrixSet"> & {
      style?: string;
      tileMatrixSet?: string;
    },
  ): Promise<HonuaWmtsFeatureInfoResponse<T>> {
    return this.client.getWmtsFeatureInfo<T>({
      serviceId: this.serviceId,
      layer: this.layerName,
      style: request.style ?? this.defaultStyleId,
      tileMatrixSet: request.tileMatrixSet ?? this.defaultTileMatrixSetId,
      tileMatrix: request.tileMatrix,
      tileRow: request.tileRow,
      tileCol: request.tileCol,
      i: request.i,
      j: request.j,
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.infoFormat !== undefined ? { infoFormat: request.infoFormat } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.extraParams !== undefined ? { extraParams: request.extraParams } : {}),
    });
  }
}

/**
 * Tileset handle bound to (layer × style × tileMatrixSet). The runtime
 * binding for MapLibre's `raster` source spec is keyed off this shape.
 */
export class HonuaWmtsTileset {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  public readonly layerName: string;
  public readonly styleId: string;
  public readonly tileMatrixSetId: string;

  public constructor(options: HonuaWmtsTilesetOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.layerName = options.layerName;
    this.styleId = options.styleId;
    this.tileMatrixSetId = options.tileMatrixSetId;
  }

  public describe(capabilities: WmtsCapabilities): WmtsCapabilityTileMatrixSet | undefined {
    return findWmtsTileMatrixSet(capabilities, this.tileMatrixSetId);
  }

  public async tile(
    request: Omit<WmtsTileRequest, "layer" | "style" | "tileMatrixSet">,
  ): Promise<HonuaWmtsTileResponse> {
    return this.client.fetchWmtsTile({
      serviceId: this.serviceId,
      layer: this.layerName,
      style: this.styleId,
      tileMatrixSet: this.tileMatrixSetId,
      tileMatrix: request.tileMatrix,
      tileRow: request.tileRow,
      tileCol: request.tileCol,
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.extraParams !== undefined ? { extraParams: request.extraParams } : {}),
    });
  }

  public async featureInfo<T = Record<string, unknown>>(
    request: Omit<WmtsFeatureInfoRequest, "layer" | "style" | "tileMatrixSet">,
  ): Promise<HonuaWmtsFeatureInfoResponse<T>> {
    return this.client.getWmtsFeatureInfo<T>({
      serviceId: this.serviceId,
      layer: this.layerName,
      style: this.styleId,
      tileMatrixSet: this.tileMatrixSetId,
      tileMatrix: request.tileMatrix,
      tileRow: request.tileRow,
      tileCol: request.tileCol,
      i: request.i,
      j: request.j,
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.infoFormat !== undefined ? { infoFormat: request.infoFormat } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.extraParams !== undefined ? { extraParams: request.extraParams } : {}),
    });
  }
}

export function createHonuaWmts(client: HonuaClient, serviceId: string): HonuaWmts {
  return new HonuaWmts({ client, serviceId });
}

// ── WMTS 1.0 wire methods ───────────────────────────────────────

/** Canonical WMTS endpoint path. */
function wmtsBasePath(serviceId: string): string {
  return `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/WMTS`;
}

export async function getWmtsCapabilities(
  transport: HonuaProtocolTransport,
  request: {
    serviceId: string;
    signal?: AbortSignal;
  },
): Promise<WmtsCapabilities> {
  const params = new URLSearchParams();
  params.set("SERVICE", "WMTS");
  params.set("REQUEST", "GetCapabilities");
  params.set("VERSION", "1.0.0");
  const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
  const { text: xml } = await transport.requestText("GET", path, {
    accept: "text/xml,application/xml",
    signal: request.signal,
  });
  return parseWmtsCapabilities(xml);
}

/**
 * Fetch a single WMTS tile. `mode` selects between KVP
 * (`?REQUEST=GetTile&...`) and the RESTful path
 * (`/{layer}/{style}/{tms}/{z}/{y}/{x}.{ext}`). honua-server
 * advertises both; the SDK defaults to RESTful because the wire path
 * is a single string substitution per tile and skips
 * URLSearchParams serialisation on the hot path.
 */
export async function fetchWmtsTile(
  transport: HonuaProtocolTransport,
  request: { serviceId: string } & WmtsTileRequest,
): Promise<HonuaWmtsTileResponse> {
  const mode: "kvp" | "rest" = request.mode ?? "rest";
  const format = request.format ?? "image/png";
  const style = request.style ?? "default";
  const tileMatrixSet = request.tileMatrixSet ?? "WebMercatorQuad";
  if (mode === "kvp") {
    const params = new URLSearchParams();
    params.set("SERVICE", "WMTS");
    params.set("VERSION", "1.0.0");
    params.set("REQUEST", "GetTile");
    params.set("LAYER", request.layer);
    params.set("STYLE", style);
    params.set("FORMAT", format);
    params.set("TILEMATRIXSET", tileMatrixSet);
    params.set("TILEMATRIX", String(request.tileMatrix));
    params.set("TILEROW", String(request.tileRow));
    params.set("TILECOL", String(request.tileCol));
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }
    const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
    return transport.requestBytes("GET", path, format, undefined, request.signal);
  }
  const ext = wmtsExtensionForFormat(format);
  const base = wmtsBasePath(request.serviceId);
  const layer = encodeURIComponent(request.layer);
  const styleSeg = encodeURIComponent(style);
  const tmsSeg = encodeURIComponent(tileMatrixSet);
  const tm = encodeURIComponent(String(request.tileMatrix));
  const tr = encodeURIComponent(String(request.tileRow));
  const tc = encodeURIComponent(String(request.tileCol));
  const extra = wmtsRestExtraParamsSuffix(request.extraParams);
  const path = `${base}/${layer}/${styleSeg}/${tmsSeg}/${tm}/${tr}/${tc}.${ext}${extra}`;
  return transport.requestBytes("GET", path, format, undefined, request.signal);
}

/**
 * WMTS GetFeatureInfo. honua-server accepts both KVP and RESTful
 * routing; mode default mirrors `fetchWmtsTile`.
 */
export async function getWmtsFeatureInfo<T = Record<string, unknown>>(
  transport: HonuaProtocolTransport,
  request: { serviceId: string } & WmtsFeatureInfoRequest,
): Promise<HonuaWmtsFeatureInfoResponse<T>> {
  const mode: "kvp" | "rest" = request.mode ?? "rest";
  const infoFormat = request.infoFormat ?? "application/json";
  const format = request.format ?? "image/png";
  const style = request.style ?? "default";
  const tileMatrixSet = request.tileMatrixSet ?? "WebMercatorQuad";
  if (mode === "kvp") {
    const params = new URLSearchParams();
    params.set("SERVICE", "WMTS");
    params.set("VERSION", "1.0.0");
    params.set("REQUEST", "GetFeatureInfo");
    params.set("LAYER", request.layer);
    params.set("STYLE", style);
    params.set("FORMAT", format);
    params.set("TILEMATRIXSET", tileMatrixSet);
    params.set("TILEMATRIX", String(request.tileMatrix));
    params.set("TILEROW", String(request.tileRow));
    params.set("TILECOL", String(request.tileCol));
    params.set("I", String(Math.trunc(request.i)));
    params.set("J", String(Math.trunc(request.j)));
    params.set("INFOFORMAT", infoFormat);
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }
    const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
    const response = await transport.requestBytes("GET", path, infoFormat, undefined, request.signal);
    return decodeWmsFeatureInfoResponse<T>(response.bytes, response.contentType, infoFormat);
  }
  const ext = wmtsFeatureInfoExtensionForFormat(infoFormat);
  const base = wmtsBasePath(request.serviceId);
  const layer = encodeURIComponent(request.layer);
  const styleSeg = encodeURIComponent(style);
  const tmsSeg = encodeURIComponent(tileMatrixSet);
  const tm = encodeURIComponent(String(request.tileMatrix));
  const tr = encodeURIComponent(String(request.tileRow));
  const tc = encodeURIComponent(String(request.tileCol));
  const jSeg = encodeURIComponent(String(Math.trunc(request.j)));
  const iSeg = encodeURIComponent(String(Math.trunc(request.i)));
  const extra = wmtsRestExtraParamsSuffix(request.extraParams);
  const path = `${base}/${layer}/${styleSeg}/${tmsSeg}/${tm}/${tr}/${tc}/${jSeg}/${iSeg}.${ext}${extra}`;
  const response = await transport.requestBytes("GET", path, infoFormat, undefined, request.signal);
  return decodeWmsFeatureInfoResponse<T>(response.bytes, response.contentType, infoFormat);
}

const WMTS_FEATURE_INFO_FORMAT_TO_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["application/json", "json"],
  ["text/plain", "txt"],
  ["text/html", "html"],
  ["application/geo+json", "geojson"],
]);

function wmtsFeatureInfoExtensionForFormat(format: string): string {
  return WMTS_FEATURE_INFO_FORMAT_TO_EXTENSION.get(format.toLowerCase()) ?? "txt";
}

const WMTS_REST_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "service",
  "version",
  "request",
  "layer",
  "style",
  "format",
  "infoformat",
  "tilematrixset",
  "tilematrix",
  "tilerow",
  "tilecol",
  "i",
  "j",
]);

/**
 * Serialize `extraParams` for the RESTful WMTS routes. Path-encoded WMTS
 * keys take precedence — any extraParams whose key (case-insensitively)
 * matches a path-derived value is dropped so the same URL never carries
 * the value twice. Returns the query-string suffix to append (empty
 * string when there is nothing left after filtering).
 */
function wmtsRestExtraParamsSuffix(extraParams: Record<string, unknown> | undefined): string {
  if (!extraParams) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extraParams)) {
    if (value === undefined || value === null) continue;
    if (WMTS_REST_RESERVED_KEYS.has(key.toLowerCase())) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}
