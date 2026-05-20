import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";

export interface WFSLayerCompatOptions {
  url: string;
  name: string;
  version?: "2.0.0" | "1.1.0";
  id?: string;
  title?: string;
  opacity?: number;
  visible?: boolean;
  listMode?: string;
  outFields?: ReadonlyArray<string>;
  customParameters?: Record<string, string>;
  spatialReference?: { wkid?: number };
  eventBus?: CompatEventBus;
}

export type WFSLayerLoadStatusCompat = "not-loaded" | "loading" | "loaded" | "failed";

export interface WFSLayerHandleCompat {
  remove(): void;
}

export interface WFSLayerQueryOptions {
  where?: string;
  bbox?: [number, number, number, number];
  count?: number;
  startIndex?: number;
  outputFormat?: string;
}

export interface WFSLayerQueryResult {
  features: Array<Record<string, unknown>>;
  exceededTransferLimit?: boolean;
}

export class WFSLayerCompat {
  public readonly type: "wfs";
  public readonly url: string;
  public readonly name: string;
  public id: string | undefined;
  public title: string | undefined;
  public version: "2.0.0" | "1.1.0";
  public opacity: number;
  public visible: boolean;
  public listMode: string;
  public outFields: ReadonlyArray<string> | undefined;
  public customParameters: Record<string, string>;
  public spatialReference: { wkid?: number };
  public loaded: boolean;
  public loadStatus: WFSLayerLoadStatusCompat;
  public readonly eventBus: CompatEventBus;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly eventListeners: Map<string, Set<(event: unknown) => void>>;

  public constructor(options: WFSLayerCompatOptions) {
    this.type = "wfs";
    this.url = options.url;
    this.name = options.name;
    this.id = options.id;
    this.title = options.title ?? options.name;
    this.version = options.version ?? "2.0.0";
    this.opacity = options.opacity ?? 1;
    this.visible = options.visible ?? true;
    this.listMode = options.listMode ?? "show";
    this.outFields = options.outFields;
    this.customParameters = { ...(options.customParameters ?? {}) };
    this.spatialReference = options.spatialReference ?? { wkid: 4326 };
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.customParameters) ?? new CompatEventBus();
    this.watchListeners = new Map();
    this.eventListeners = new Map();
  }

  public async load(): Promise<WFSLayerCompat> {
    if (this.loaded) return this;
    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.loaded = true;
    this.loadStatus = "loaded";
    this.notifyWatchers("loaded", this.loaded);
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("wfs-layer.loaded", { layerId: this.id, url: this.url, name: this.name }, this);
    return this;
  }

  public async when(callback?: (layer: WFSLayerCompat) => void): Promise<WFSLayerCompat> {
    const layer = await this.load();
    if (callback) callback(layer);
    return layer;
  }

  public async queryFeatures(options: WFSLayerQueryOptions = {}): Promise<WFSLayerQueryResult> {
    await this.load();
    const params = new URLSearchParams({
      SERVICE: "WFS",
      VERSION: this.version,
      REQUEST: "GetFeature",
      TYPENAMES: this.name,
      OUTPUTFORMAT: options.outputFormat ?? "application/json",
      SRSNAME: `EPSG:${this.spatialReference.wkid ?? 4326}`,
      ...this.customParameters,
    });
    if (options.count !== undefined) params.set("COUNT", String(options.count));
    if (options.startIndex !== undefined) params.set("STARTINDEX", String(options.startIndex));
    if (options.bbox) params.set("BBOX", options.bbox.join(","));

    const url = `${this.url}${this.url.includes("?") ? "&" : "?"}${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`WFS GetFeature failed: ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    const rawFeatures = Array.isArray(data.features) ? (data.features as Array<Record<string, unknown>>) : [];
    return {
      features: rawFeatures.map((feature) => ({
        attributes: (feature.properties as Record<string, unknown>) ?? {},
        geometry: feature.geometry,
      })),
      exceededTransferLimit:
        typeof data.numberMatched === "number" && typeof data.numberReturned === "number"
          ? data.numberMatched > data.numberReturned
          : false,
    };
  }

  public watch(propertyName: string, listener: (value: unknown) => void): WFSLayerHandleCompat {
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

  public on(eventName: string, listener: (event: unknown) => void): WFSLayerHandleCompat {
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);
    const subscription = this.eventBus.on(`wfs-layer.${eventName}`, (event) => {
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
    this.eventBus.emit("wfs-layer.destroyed", { layerId: this.id }, this);
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) return;
    for (const listener of listeners) safeInvokeCompatListener(listener, value);
  }
}
