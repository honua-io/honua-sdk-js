import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";

export interface GeoJSONLayerCompatOptions {
  url?: string;
  data?: Record<string, unknown>;
  id?: string;
  title?: string;
  opacity?: number;
  visible?: boolean;
  minScale?: number;
  maxScale?: number;
  listMode?: string;
  renderer?: unknown;
  popupTemplate?: unknown;
  outFields?: ReadonlyArray<string>;
  objectIdField?: string;
  fields?: ReadonlyArray<{ name: string; alias?: string; type?: string }>;
  geometryType?: string;
  spatialReference?: { wkid?: number; latestWkid?: number };
  eventBus?: CompatEventBus;
}

export type GeoJSONLayerLoadStatusCompat = "not-loaded" | "loading" | "loaded" | "failed";

export interface GeoJSONLayerHandleCompat {
  remove(): void;
}

export interface GeoJSONLayerQueryOptions {
  where?: string;
  objectIds?: ReadonlyArray<number | string>;
  outFields?: ReadonlyArray<string>;
  returnGeometry?: boolean;
}

export interface GeoJSONLayerQueryResult {
  features: Array<Record<string, unknown>>;
}

export class GeoJSONLayerCompat {
  public readonly type: "geojson";
  public id: string | undefined;
  public title: string | undefined;
  public url: string | undefined;
  public opacity: number;
  public visible: boolean;
  public minScale: number;
  public maxScale: number;
  public listMode: string;
  public renderer: unknown;
  public popupTemplate: unknown;
  public outFields: ReadonlyArray<string> | undefined;
  public objectIdField: string;
  public fields: ReadonlyArray<{ name: string; alias?: string; type?: string }>;
  public geometryType: string | undefined;
  public spatialReference: { wkid?: number; latestWkid?: number };
  public loaded: boolean;
  public loadStatus: GeoJSONLayerLoadStatusCompat;
  public readonly eventBus: CompatEventBus;
  private featuresInternal: Array<Record<string, unknown>>;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly eventListeners: Map<string, Set<(event: unknown) => void>>;

  public constructor(options: GeoJSONLayerCompatOptions = {}) {
    this.type = "geojson";
    this.id = options.id;
    this.title = options.title;
    this.url = options.url;
    this.opacity = options.opacity ?? 1;
    this.visible = options.visible ?? true;
    this.minScale = options.minScale ?? 0;
    this.maxScale = options.maxScale ?? 0;
    this.listMode = options.listMode ?? "show";
    this.renderer = options.renderer;
    this.popupTemplate = options.popupTemplate;
    this.outFields = options.outFields;
    this.objectIdField = options.objectIdField ?? "OBJECTID";
    this.fields = options.fields ?? [];
    this.geometryType = options.geometryType;
    this.spatialReference = options.spatialReference ?? { wkid: 4326 };
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.data) ?? new CompatEventBus();
    this.featuresInternal = options.data ? this.collectFeatures(options.data) : [];
    this.watchListeners = new Map();
    this.eventListeners = new Map();
  }

  public async load(): Promise<GeoJSONLayerCompat> {
    if (this.loaded) return this;
    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    try {
      if (this.featuresInternal.length === 0 && this.url) {
        const response = await fetch(this.url);
        if (!response.ok) throw new Error(`Failed to fetch GeoJSON: ${response.status}`);
        const data = (await response.json()) as Record<string, unknown>;
        this.featuresInternal = this.collectFeatures(data);
      }
      this.loaded = true;
      this.loadStatus = "loaded";
      this.notifyWatchers("loaded", this.loaded);
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit("geojson-layer.loaded", { layerId: this.id, count: this.featuresInternal.length }, this);
    } catch (error) {
      this.loadStatus = "failed";
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit("geojson-layer.failed", { layerId: this.id, error }, this);
      throw error;
    }
    return this;
  }

  public async when(callback?: (layer: GeoJSONLayerCompat) => void): Promise<GeoJSONLayerCompat> {
    const layer = await this.load();
    if (callback) callback(layer);
    return layer;
  }

  public async queryFeatures(options: GeoJSONLayerQueryOptions = {}): Promise<GeoJSONLayerQueryResult> {
    await this.load();
    const filtered = this.featuresInternal.filter((feature) => {
      if (options.objectIds && options.objectIds.length > 0) {
        const attrs = (feature.attributes as Record<string, unknown>) ?? {};
        const oid = attrs[this.objectIdField];
        if (typeof oid !== "number" && typeof oid !== "string") return false;
        if (!options.objectIds.includes(oid)) return false;
      }
      return true;
    });
    return { features: filtered.map((feature) => ({ ...feature })) };
  }

  public async queryFeatureCount(options: GeoJSONLayerQueryOptions = {}): Promise<number> {
    const result = await this.queryFeatures(options);
    return result.features.length;
  }

  public async queryObjectIds(): Promise<Array<number | string>> {
    await this.load();
    const ids: Array<number | string> = [];
    for (const feature of this.featuresInternal) {
      const attrs = (feature.attributes as Record<string, unknown>) ?? {};
      const oid = attrs[this.objectIdField];
      if (typeof oid === "number" || typeof oid === "string") ids.push(oid);
    }
    return ids;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): GeoJSONLayerHandleCompat {
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

  public on(eventName: string, listener: (event: unknown) => void): GeoJSONLayerHandleCompat {
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);
    const subscription = this.eventBus.on(`geojson-layer.${eventName}`, (event) => {
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

  public refresh(): void {
    this.loaded = false;
    this.featuresInternal = [];
    this.loadStatus = "not-loaded";
    this.notifyWatchers("loaded", this.loaded);
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("geojson-layer.refreshed", { layerId: this.id }, this);
  }

  public destroy(): void {
    this.watchListeners.clear();
    this.eventListeners.clear();
    this.eventBus.emit("geojson-layer.destroyed", { layerId: this.id }, this);
  }

  private collectFeatures(data: Record<string, unknown>): Array<Record<string, unknown>> {
    const type = data.type;
    const collected: Array<Record<string, unknown>> = [];
    const pushFeature = (feature: Record<string, unknown>) => {
      const properties = (feature.properties as Record<string, unknown>) ?? {};
      collected.push({
        attributes: properties,
        geometry: feature.geometry,
      });
    };
    if (type === "FeatureCollection" && Array.isArray(data.features)) {
      for (const feature of data.features as Array<Record<string, unknown>>) pushFeature(feature);
    } else if (type === "Feature") {
      pushFeature(data);
    }
    return collected;
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) return;
    for (const listener of listeners) safeInvokeCompatListener(listener, value);
  }
}
