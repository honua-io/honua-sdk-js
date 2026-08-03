/**
 * First-party WMS 1.3.0 adapter. `HonuaWms` is the service-level handle
 * returned by `client.wms(serviceId)`; `HonuaWmsLayer` is the bound
 * handle returned by `HonuaWms.layer(name)` that pre-fills the LAYER and
 * default STYLE so per-call envelopes can drop the routing fields.
 *
 * Wire transport lives on `HonuaClient` (`getWmsCapabilities`,
 * `getWmsMap`, `getWmsFeatureInfo`, `getWmsLegend`); this class is the
 * typed surface consumers reach through `Source.protocol("wms")`.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import { HonuaCapabilityNotSupportedError } from "./errors.js";
import { encodeServiceIdPath } from "./path-utils.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type { HonuaTypedFeature } from "./types.js";
import { wmsBboxRequiresAxisSwap } from "./wms-axis.js";
import type { WmsCapabilities, WmsCapabilityLayer, WmsCapabilityStyle } from "./wms-capabilities.js";
import { findWmsLayer, parseWmsCapabilities } from "./wms-capabilities.js";
import type {
  HonuaWmsFeatureInfoResponse,
  HonuaWmsImageResponse,
  WmsFeatureInfoRequest,
  WmsLegendRequest,
  WmsMapRequest,
} from "./wms-types.js";

export interface HonuaWmsOptions {
  client: HonuaClient;
  serviceId: string;
}

/**
 * Split a WMS `LAYERS=` value (or `locator.typeName` / `spec.layers` of
 * the same shape) into the list of non-empty trimmed layer tokens. Used
 * by the contract WMS adapter and shared style resolver so the
 * single-layer handle rule stays in one place.
 */
export function parseWmsLayerNames(value: string | undefined): readonly string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface HonuaWmsLayerOptions extends HonuaWmsOptions {
  /** WMS LAYER name (single layer; multi-layer renders use the parent handle). */
  layerName: string;
  /** Default STYLE for renders / feature-info on this layer. */
  defaultStyleId?: string;
}

/**
 * Service-level WMS handle. Use `layer(name)` to bind a single LAYER and
 * style; for multi-layer composites (`LAYERS=a,b,c`) call `map()` /
 * `featureInfo()` directly on this handle.
 */
export class HonuaWms {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  private capabilitiesPromise: Promise<WmsCapabilities> | undefined;

  public constructor(options: HonuaWmsOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
  }

  /** Bind a single named layer for layer-scoped requests. */
  public layer(name: string, defaultStyleId?: string): HonuaWmsLayer {
    const opts: HonuaWmsLayerOptions = {
      client: this.client,
      serviceId: this.serviceId,
      layerName: name,
    };
    if (defaultStyleId !== undefined) opts.defaultStyleId = defaultStyleId;
    return new HonuaWmsLayer(opts);
  }

  /** Fetch and parse the service `GetCapabilities` document. */
  public async capabilities(options?: { signal?: AbortSignal }): Promise<WmsCapabilities> {
    return this.client.getWmsCapabilities({
      serviceId: this.serviceId,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  /** Render a `GetMap` request across one or more advertised layers. */
  public async map(request: WmsMapRequest): Promise<HonuaWmsImageResponse> {
    return this.client.getWmsMap({ serviceId: this.serviceId, ...request });
  }

  /** Issue a `GetFeatureInfo` against one or more advertised layers. */
  public async featureInfo<T = Record<string, unknown>>(
    request: WmsFeatureInfoRequest,
  ): Promise<HonuaWmsFeatureInfoResponse<T>> {
    return this.client.getWmsFeatureInfo<T>({ serviceId: this.serviceId, ...request });
  }

  /**
   * Fetch a `GetLegendGraphic` image. Always gates on parsed Capabilities:
   * when the caller does not pre-supply `options.capabilities`, the handle
   * lazily loads them once via `getWmsCapabilities` and caches the
   * promise on the instance so repeat calls reuse the same fetch. Throws
   * `HonuaCapabilityNotSupportedError("legend", "wms", serviceId)` when
   * the service does not advertise `<GetLegendGraphic>`.
   */
  public async legend(
    request: WmsLegendRequest,
    options?: { capabilities?: WmsCapabilities },
  ): Promise<HonuaWmsImageResponse> {
    const caps = options?.capabilities ?? (await this.loadCachedCapabilities());
    if (!caps.request.getLegendGraphic) {
      throw new HonuaCapabilityNotSupportedError("legend", "wms", this.serviceId);
    }
    return this.client.getWmsLegend({ serviceId: this.serviceId, ...request });
  }

  private async loadCachedCapabilities(): Promise<WmsCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.capabilities().catch((error) => {
        // Drop the cached promise on failure so the next call retries
        // instead of permanently surfacing the same error.
        this.capabilitiesPromise = undefined;
        throw error;
      });
    }
    return this.capabilitiesPromise;
  }
}

/**
 * Bound layer handle. Drops `layers` / `styles` from per-call requests
 * and pre-fills the LAYER name. `featureInfo()` carries the same `i`,
 * `j`, and `bbox` envelope as the service-level handle.
 */
export class HonuaWmsLayer {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  public readonly layerName: string;
  public readonly defaultStyleId: string | undefined;
  private capabilitiesPromise: Promise<WmsCapabilities> | undefined;

  public constructor(options: HonuaWmsLayerOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.layerName = options.layerName;
    this.defaultStyleId = options.defaultStyleId;
  }

  /** Fetch the parent service's `GetCapabilities`. */
  public async capabilities(options?: { signal?: AbortSignal }): Promise<WmsCapabilities> {
    return this.client.getWmsCapabilities({
      serviceId: this.serviceId,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  /** Find this layer in a parsed Capabilities document. */
  public describe(capabilities: WmsCapabilities): WmsCapabilityLayer | undefined {
    return findWmsLayer(capabilities, this.layerName);
  }

  /** Enumerate the styles advertised on this layer. */
  public stylesIn(capabilities: WmsCapabilities): readonly WmsCapabilityStyle[] {
    return this.describe(capabilities)?.styles ?? [];
  }

  public async map(
    request: Omit<WmsMapRequest, "layers" | "styles"> & {
      style?: string;
    },
  ): Promise<HonuaWmsImageResponse> {
    const { style, ...rest } = request;
    const styleId = style ?? this.defaultStyleId;
    return this.client.getWmsMap({
      serviceId: this.serviceId,
      layers: [this.layerName],
      ...(styleId !== undefined ? { styles: [styleId] } : {}),
      ...rest,
    });
  }

  public async featureInfo<T = Record<string, unknown>>(
    request: Omit<WmsFeatureInfoRequest, "layers" | "queryLayers" | "styles"> & {
      style?: string;
    },
  ): Promise<HonuaWmsFeatureInfoResponse<T>> {
    const { style, ...rest } = request;
    const styleId = style ?? this.defaultStyleId;
    return this.client.getWmsFeatureInfo<T>({
      serviceId: this.serviceId,
      layers: [this.layerName],
      queryLayers: [this.layerName],
      ...(styleId !== undefined ? { styles: [styleId] } : {}),
      ...rest,
    });
  }

  /**
   * Fetch a `GetLegendGraphic` image scoped to the bound layer + style.
   * Mirrors `HonuaWms.legend`'s gating: when `options.capabilities` is
   * not supplied, the handle lazily loads them once via
   * `getWmsCapabilities` and caches the promise. Throws
   * `HonuaCapabilityNotSupportedError("legend", "wms", serviceId)` when
   * the service does not advertise `<GetLegendGraphic>`.
   */
  public async legend(
    request: Omit<WmsLegendRequest, "layer" | "style"> & { style?: string } = {},
    options?: { capabilities?: WmsCapabilities },
  ): Promise<HonuaWmsImageResponse> {
    const caps = options?.capabilities ?? (await this.loadCachedCapabilities());
    if (!caps.request.getLegendGraphic) {
      throw new HonuaCapabilityNotSupportedError("legend", "wms", this.serviceId);
    }
    const { style, ...rest } = request;
    const styleId = style ?? this.defaultStyleId;
    return this.client.getWmsLegend({
      serviceId: this.serviceId,
      layer: this.layerName,
      ...(styleId !== undefined ? { style: styleId } : {}),
      ...rest,
    });
  }

  private async loadCachedCapabilities(): Promise<WmsCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.capabilities().catch((error) => {
        this.capabilitiesPromise = undefined;
        throw error;
      });
    }
    return this.capabilitiesPromise;
  }
}

export function createHonuaWms(client: HonuaClient, serviceId: string): HonuaWms {
  return new HonuaWms({ client, serviceId });
}

// ── WMS 1.3 wire methods ────────────────────────────────────────

/** Canonical WMS endpoint path. honua-server publishes both `/rest/services/{id}/MapServer/WMS` and `/ogc/services/{id}/wms`; the SDK targets the GeoServices-aliased path because every Honua deployment exposes it. */
function wmsBasePath(serviceId: string): string {
  return `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/WMS`;
}

/**
 * Fetch and parse a WMS `GetCapabilities` document for the addressed
 * service. The XML body decodes through `requestText`; the parsed
 * shape is the typed `WmsCapabilities` envelope (no XML node leaks
 * through the public surface).
 */
export async function getWmsCapabilities(
  transport: HonuaProtocolTransport,
  request: {
    serviceId: string;
    version?: string;
    signal?: AbortSignal;
    extraParams?: Record<string, string | number | boolean>;
  },
): Promise<WmsCapabilities> {
  const params = new URLSearchParams();
  params.set("SERVICE", "WMS");
  params.set("REQUEST", "GetCapabilities");
  params.set("VERSION", request.version ?? "1.3.0");
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
  const { text: xml } = await transport.requestText("GET", path, {
    accept: "text/xml,application/xml",
    signal: request.signal,
  });
  return parseWmsCapabilities(xml);
}

/** Render a WMS `GetMap`. Returns the raw image bytes. */
export async function getWmsMap(
  transport: HonuaProtocolTransport,
  request: { serviceId: string } & WmsMapRequest,
): Promise<HonuaWmsImageResponse> {
  const params = serializeWmsMapParams(request);
  params.set("REQUEST", "GetMap");
  const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
  const accept = request.format ?? "image/png";
  const response = await transport.requestBytes("GET", path, accept, undefined, request.signal);
  return { bytes: response.bytes, contentType: response.contentType };
}

/**
 * Issue a WMS `GetFeatureInfo`. When `INFO_FORMAT=application/json`
 * the JSON body decodes into the canonical `HonuaTypedFeature[]`
 * shape; non-JSON formats round-trip on `bytes` so callers retain the
 * raw payload behind the protocol escape hatch.
 */
export async function getWmsFeatureInfo<T = Record<string, unknown>>(
  transport: HonuaProtocolTransport,
  request: { serviceId: string } & WmsFeatureInfoRequest,
): Promise<HonuaWmsFeatureInfoResponse<T>> {
  const params = serializeWmsFeatureInfoParams(request);
  const infoFormat = params.get("INFO_FORMAT")!;
  const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
  const response = await transport.requestBytes("GET", path, infoFormat, undefined, request.signal);
  return decodeWmsFeatureInfoResponse<T>(response.bytes, response.contentType, infoFormat);
}

/**
 * Serialize the WMS 1.3.0 KVP for a `GetFeatureInfo` request, including the
 * authority-defined `BBOX` axis order for the requested CRS.
 *
 * Shared by the Honua service-id path above and the capabilities-driven
 * third-party path (`wms-feature-info.ts`) so both emit byte-identical query
 * state and only differ in which URL receives it.
 */
export function serializeWmsFeatureInfoParams(request: WmsFeatureInfoRequest): URLSearchParams {
  const params = serializeWmsMapParams(request);
  params.set("REQUEST", "GetFeatureInfo");
  params.set("QUERY_LAYERS", request.queryLayers.join(","));
  params.set("I", String(Math.trunc(request.i)));
  params.set("J", String(Math.trunc(request.j)));
  params.set("INFO_FORMAT", request.infoFormat ?? "application/json");
  if (request.featureCount !== undefined) {
    params.set("FEATURE_COUNT", String(Math.trunc(request.featureCount)));
  }
  return params;
}

/**
 * Fetch a WMS `GetLegendGraphic`. honua-server does not implement
 * GetLegendGraphic today; callers should branch on
 * `WmsCapabilities.request.getLegendGraphic` before invoking. When
 * the wire returns 5xx the underlying `HonuaHttpError` flows through.
 */
export async function getWmsLegend(
  transport: HonuaProtocolTransport,
  request: { serviceId: string } & WmsLegendRequest,
): Promise<HonuaWmsImageResponse> {
  const params = new URLSearchParams();
  params.set("SERVICE", "WMS");
  params.set("VERSION", "1.3.0");
  params.set("REQUEST", "GetLegendGraphic");
  params.set("LAYER", request.layer);
  if (request.style) params.set("STYLE", request.style);
  const format = request.format ?? "image/png";
  params.set("FORMAT", format);
  if (request.width !== undefined) params.set("WIDTH", String(Math.trunc(request.width)));
  if (request.height !== undefined) params.set("HEIGHT", String(Math.trunc(request.height)));
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
  const response = await transport.requestBytes("GET", path, format, undefined, request.signal);
  return { bytes: response.bytes, contentType: response.contentType };
}

function serializeWmsMapParams(request: WmsMapRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set("SERVICE", "WMS");
  params.set("VERSION", "1.3.0");
  params.set("LAYERS", request.layers.join(","));
  params.set("STYLES", request.styles ? request.styles.join(",") : "");
  const crs = request.crs ?? "EPSG:3857";
  params.set("CRS", crs);
  const [minx, miny, maxx, maxy] = request.bbox;
  const wireBbox = wmsBboxRequiresAxisSwap(crs) ? [miny, minx, maxy, maxx] : [minx, miny, maxx, maxy];
  params.set("BBOX", wireBbox.join(","));
  params.set("WIDTH", String(Math.trunc(request.width)));
  params.set("HEIGHT", String(Math.trunc(request.height)));
  params.set("FORMAT", request.format ?? "image/png");
  params.set("TRANSPARENT", String(request.transparent ?? true).toUpperCase());
  if (request.bgcolor !== undefined) params.set("BGCOLOR", request.bgcolor);
  if (request.time !== undefined) params.set("TIME", request.time);
  if (request.elevation !== undefined) params.set("ELEVATION", request.elevation);
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  return params;
}

export function decodeWmsFeatureInfoResponse<T>(
  bytes: Uint8Array,
  contentType: string,
  requestedFormat: string,
): HonuaWmsFeatureInfoResponse<T> {
  const isJson =
    contentType.toLowerCase().includes("application/json") ||
    requestedFormat.toLowerCase().includes("application/json");
  if (!isJson) {
    return { contentType, bytes };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.length === 0) {
    return { contentType, features: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Server emitted a non-JSON body despite the JSON Accept; preserve as bytes.
    return { contentType, bytes };
  }
  const features = extractFeatureInfoFeatures<T>(parsed);
  return { contentType, features };
}

function extractFeatureInfoFeatures<T>(parsed: unknown): ReadonlyArray<HonuaTypedFeature<T>> {
  if (!parsed || typeof parsed !== "object") return [];
  // honua-server emits `{ type: "FeatureInfoResponse", features: [{ layer, attributes }, ...] }`
  // and a fallback GeoJSON `{ type: "FeatureCollection", features: [...] }`; both decode here.
  const obj = parsed as Record<string, unknown>;
  const featuresRaw = Array.isArray(obj.features) ? obj.features : [];
  const out: HonuaTypedFeature<T>[] = [];
  for (const raw of featuresRaw) {
    if (!raw || typeof raw !== "object") continue;
    const feat = raw as Record<string, unknown>;
    const attributes = (feat.attributes ?? feat.properties ?? {}) as T;
    const geometry = (feat.geometry as Record<string, unknown> | null | undefined) ?? null;
    out.push({ attributes, geometry });
  }
  return out;
}
