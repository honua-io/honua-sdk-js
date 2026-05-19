import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";

export interface WMSSublayerCompatOptions {
  name: string;
  title?: string;
  visible?: boolean;
  legendUrl?: string;
}

export interface WMSLayerCompatOptions {
  url: string;
  sublayers?: ReadonlyArray<WMSSublayerCompatOptions | string>;
  version?: "1.1.0" | "1.1.1" | "1.3.0";
  spatialReference?: { wkid?: number };
  imageFormat?: string;
  id?: string;
  title?: string;
  opacity?: number;
  visible?: boolean;
  customLayerParameters?: Record<string, string>;
  customParameters?: Record<string, string>;
  listMode?: string;
  eventBus?: CompatEventBus;
}

export type WMSLayerLoadStatusCompat = "not-loaded" | "loading" | "loaded" | "failed";

export interface WMSLayerHandleCompat {
  remove(): void;
}

export class WMSSublayerCompat {
  public readonly name: string;
  public title: string | undefined;
  public visible: boolean;
  public legendUrl: string | undefined;

  public constructor(options: WMSSublayerCompatOptions) {
    this.name = options.name;
    this.title = options.title ?? options.name;
    this.visible = options.visible ?? true;
    this.legendUrl = options.legendUrl;
  }
}

export class WMSLayerCompat {
  public readonly type: "wms";
  public readonly url: string;
  public id: string | undefined;
  public title: string | undefined;
  public version: "1.1.0" | "1.1.1" | "1.3.0";
  public spatialReference: { wkid?: number };
  public imageFormat: string;
  public opacity: number;
  public visible: boolean;
  public listMode: string;
  public customLayerParameters: Record<string, string>;
  public customParameters: Record<string, string>;
  public sublayers: WMSSublayerCompat[];
  public loaded: boolean;
  public loadStatus: WMSLayerLoadStatusCompat;
  public readonly eventBus: CompatEventBus;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly eventListeners: Map<string, Set<(event: unknown) => void>>;

  public constructor(options: WMSLayerCompatOptions) {
    this.type = "wms";
    this.url = options.url;
    this.id = options.id;
    this.title = options.title;
    this.version = options.version ?? "1.3.0";
    this.spatialReference = options.spatialReference ?? { wkid: 4326 };
    this.imageFormat = options.imageFormat ?? "image/png";
    this.opacity = options.opacity ?? 1;
    this.visible = options.visible ?? true;
    this.listMode = options.listMode ?? "show";
    this.customLayerParameters = { ...(options.customLayerParameters ?? {}) };
    this.customParameters = { ...(options.customParameters ?? {}) };
    this.sublayers = (options.sublayers ?? []).map((sub) =>
      typeof sub === "string" ? new WMSSublayerCompat({ name: sub }) : new WMSSublayerCompat(sub),
    );
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.sublayers) ?? new CompatEventBus();
    this.watchListeners = new Map();
    this.eventListeners = new Map();
  }

  public async load(): Promise<WMSLayerCompat> {
    if (this.loaded) return this;
    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.loaded = true;
    this.loadStatus = "loaded";
    this.notifyWatchers("loaded", this.loaded);
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("wms-layer.loaded", { layerId: this.id, url: this.url }, this);
    return this;
  }

  public async when(callback?: (layer: WMSLayerCompat) => void): Promise<WMSLayerCompat> {
    const layer = await this.load();
    if (callback) callback(layer);
    return layer;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): WMSLayerHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);
    return { remove: () => { listeners?.delete(listener); } };
  }

  public on(eventName: string, listener: (event: unknown) => void): WMSLayerHandleCompat {
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);
    const subscription = this.eventBus.on(`wms-layer.${eventName}`, (event) => {
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

  public setVisibleSublayers(names: ReadonlyArray<string>): void {
    const set = new Set(names);
    for (const sub of this.sublayers) sub.visible = set.has(sub.name);
    this.notifyWatchers("sublayers", this.sublayers);
    this.eventBus.emit("wms-layer.sublayers-changed", { layerId: this.id, names: [...names] }, this);
  }

  public findSublayerByName(name: string): WMSSublayerCompat | undefined {
    return this.sublayers.find((sub) => sub.name === name);
  }

  public getMapImageUrl(input: {
    bbox: [number, number, number, number];
    width: number;
    height: number;
    crs?: string;
    transparent?: boolean;
  }): string {
    const visibleLayers = this.sublayers.filter((sub) => sub.visible).map((sub) => sub.name);
    const crs = input.crs ?? `EPSG:${this.spatialReference.wkid ?? 4326}`;
    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: this.version,
      REQUEST: "GetMap",
      LAYERS: visibleLayers.join(","),
      STYLES: "",
      [this.version === "1.3.0" ? "CRS" : "SRS"]: crs,
      BBOX: input.bbox.join(","),
      WIDTH: String(input.width),
      HEIGHT: String(input.height),
      FORMAT: this.imageFormat,
      TRANSPARENT: input.transparent === false ? "FALSE" : "TRUE",
      ...this.customParameters,
    });
    return `${this.url}${this.url.includes("?") ? "&" : "?"}${params.toString()}`;
  }

  public destroy(): void {
    this.watchListeners.clear();
    this.eventListeners.clear();
    this.eventBus.emit("wms-layer.destroyed", { layerId: this.id }, this);
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) return;
    for (const listener of listeners) safeInvokeCompatListener(listener, value);
  }
}
