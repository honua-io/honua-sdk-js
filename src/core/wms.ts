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
import type { WmsCapabilities, WmsCapabilityLayer, WmsCapabilityStyle } from "./wms-capabilities.js";
import { findWmsLayer } from "./wms-capabilities.js";
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
