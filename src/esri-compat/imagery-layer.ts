import { HonuaClient } from "../core/client.js";
import type { HonuaImageService } from "../core/surfaces.js";
import type { HonuaServiceMetadata } from "../core/types.js";
import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { parseImageServiceUrl } from "./url.js";

export interface ImageryLayerCompatOptions {
  url: string;
  id?: string;
  title?: string;
  opacity?: number;
  visible?: boolean;
  listMode?: string;
  format?: string;
  pixelType?: string;
  bandIds?: ReadonlyArray<number>;
  renderingRule?: Record<string, unknown>;
  mosaicRule?: Record<string, unknown>;
  client?: HonuaClient;
  eventBus?: CompatEventBus;
}

export type ImageryLayerLoadStatusCompat = "not-loaded" | "loading" | "loaded" | "failed";

export interface ImageryLayerHandleCompat {
  remove(): void;
}

export interface ImageryLayerExportOptions {
  bbox: [number, number, number, number] | string;
  size: [number, number] | string;
  format?: string;
  pixelType?: string;
  interpolation?: string;
  bandIds?: ReadonlyArray<number>;
  compressionQuality?: number;
}

export interface ImageryLayerIdentifyOptions {
  geometry: Record<string, unknown>;
  geometryType?: string;
}

export interface ImageryLayerQueryOptions {
  where?: string;
  objectIds?: readonly number[];
  outFields?: readonly string[];
  returnGeometry?: boolean;
}

export class ImageryLayerCompat {
  public readonly type: "imagery";
  public readonly url: string;
  public readonly serviceId: string;
  public id: string;
  public title: string | undefined;
  public opacity: number;
  public visible: boolean;
  public listMode: string;
  public format: string;
  public pixelType: string | undefined;
  public bandIds: ReadonlyArray<number> | undefined;
  public renderingRule: Record<string, unknown> | undefined;
  public mosaicRule: Record<string, unknown> | undefined;
  public loaded: boolean;
  public loadStatus: ImageryLayerLoadStatusCompat;
  public metadata: HonuaServiceMetadata | undefined;
  public readonly eventBus: CompatEventBus;

  private readonly client: HonuaClient;
  private readonly imageService: HonuaImageService;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly eventListeners: Map<string, Set<(event: unknown) => void>>;

  public constructor(options: ImageryLayerCompatOptions) {
    const parsed = parseImageServiceUrl(options.url);
    this.type = "imagery";
    this.url = options.url;
    this.serviceId = parsed.serviceId;
    this.id = options.id ?? this.serviceId;
    this.title = options.title;
    this.opacity = options.opacity ?? 1;
    this.visible = options.visible ?? true;
    this.listMode = options.listMode ?? "show";
    this.format = options.format ?? "png";
    this.pixelType = options.pixelType;
    this.bandIds = options.bandIds;
    this.renderingRule = options.renderingRule;
    this.mosaicRule = options.mosaicRule;
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.metadata = undefined;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.client) ?? new CompatEventBus();
    this.client = options.client ?? new HonuaClient({ baseUrl: parsed.baseUrl });
    this.imageService = this.client.imageService(this.serviceId);
    this.watchListeners = new Map();
    this.eventListeners = new Map();
  }

  public async load(): Promise<ImageryLayerCompat> {
    if (this.loaded) return this;
    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    try {
      this.metadata = await this.imageService.metadata();
      this.notifyWatchers("metadata", this.metadata);
      this.loaded = true;
      this.loadStatus = "loaded";
      this.notifyWatchers("loaded", this.loaded);
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit("imagery-layer.loaded", { serviceId: this.serviceId, id: this.id }, this);
    } catch (error) {
      this.loadStatus = "failed";
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit("imagery-layer.failed", { serviceId: this.serviceId, id: this.id, error }, this);
      throw error;
    }
    return this;
  }

  public async when(callback?: (layer: ImageryLayerCompat) => void): Promise<ImageryLayerCompat> {
    const layer = await this.load();
    if (callback) callback(layer);
    return layer;
  }

  public async exportImage(options: ImageryLayerExportOptions): Promise<unknown> {
    await this.load();
    return this.imageService.exportImage({
      bbox: options.bbox,
      size: options.size,
      format: options.format ?? this.format,
      pixelType: options.pixelType ?? this.pixelType,
      bandIds: options.bandIds ?? this.bandIds,
      interpolation: options.interpolation,
      compressionQuality: options.compressionQuality,
    });
  }

  public async identify(options: ImageryLayerIdentifyOptions): Promise<unknown> {
    await this.load();
    return this.imageService.identify({
      geometry: options.geometry,
      geometryType: options.geometryType,
    });
  }

  public async queryRasters(options: ImageryLayerQueryOptions = {}): Promise<unknown> {
    await this.load();
    return this.imageService.queryRasterCatalog({
      where: options.where,
      objectIds: options.objectIds !== undefined ? [...options.objectIds] : undefined,
      outFields: options.outFields !== undefined ? [...options.outFields] : undefined,
      returnGeometry: options.returnGeometry,
    });
  }

  public refresh(): void {
    this.loaded = false;
    this.metadata = undefined;
    this.loadStatus = "not-loaded";
    this.notifyWatchers("loaded", this.loaded);
    this.notifyWatchers("metadata", this.metadata);
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("imagery-layer.refreshed", { serviceId: this.serviceId, id: this.id }, this);
  }

  public watch(propertyName: string, listener: (value: unknown) => void): ImageryLayerHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);
    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  public on(eventName: string, listener: (event: unknown) => void): ImageryLayerHandleCompat {
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);
    const subscription = this.eventBus.on(`imagery-layer.${eventName}`, (event) => {
      safeInvokeCompatListener(listener, event.payload);
    });
    return {
      remove: () => {
        listeners?.delete(listener);
        subscription.remove();
      },
    };
  }

  public setVisibility(visible: boolean): void {
    this.visible = visible;
    this.notifyWatchers("visible", this.visible);
    this.eventBus.emit("layer.visibility-changed", { layerId: this.id, visible }, this);
  }

  public setOpacity(opacity: number): void {
    this.opacity = Math.min(Math.max(opacity, 0), 1);
    this.notifyWatchers("opacity", this.opacity);
    this.eventBus.emit("layer.opacity-changed", { layerId: this.id, opacity: this.opacity }, this);
  }

  public destroy(): void {
    this.watchListeners.clear();
    this.eventListeners.clear();
    this.eventBus.emit("imagery-layer.destroyed", { layerId: this.id }, this);
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) return;
    for (const listener of listeners) safeInvokeCompatListener(listener, value);
  }
}
