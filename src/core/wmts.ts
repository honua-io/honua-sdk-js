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
import type {
  HonuaWmtsFeatureInfoResponse,
  HonuaWmtsTileResponse,
  WmtsFeatureInfoRequest,
  WmtsTileRequest,
} from "./wms-types.js";
import type { WmtsCapabilities, WmtsCapabilityLayer, WmtsCapabilityTileMatrixSet } from "./wmts-capabilities.js";
import { findWmtsLayer, findWmtsTileMatrixSet } from "./wmts-capabilities.js";

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
