import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";

export interface VectorTileLayerCompatOptions {
  url?: string;
  style?: string | Record<string, unknown>;
  id?: string;
  title?: string;
  opacity?: number;
  visible?: boolean;
  minScale?: number;
  maxScale?: number;
  listMode?: string;
  eventBus?: CompatEventBus;
}

export type VectorTileLayerLoadStatusCompat = "not-loaded" | "loading" | "loaded" | "failed";

export interface VectorTileLayerHandleCompat {
  remove(): void;
}

export class VectorTileLayerCompat {
  public readonly type: "vector-tile";
  public id: string | undefined;
  public title: string | undefined;
  public url: string | undefined;
  public style: string | Record<string, unknown> | undefined;
  public opacity: number;
  public visible: boolean;
  public minScale: number;
  public maxScale: number;
  public listMode: string;
  public loaded: boolean;
  public loadStatus: VectorTileLayerLoadStatusCompat;
  public readonly eventBus: CompatEventBus;
  private styleJson: Record<string, unknown> | undefined;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly eventListeners: Map<string, Set<(event: unknown) => void>>;

  public constructor(options: VectorTileLayerCompatOptions = {}) {
    this.type = "vector-tile";
    this.id = options.id;
    this.title = options.title;
    this.url = options.url;
    this.style = options.style;
    this.opacity = options.opacity ?? 1;
    this.visible = options.visible ?? true;
    this.minScale = options.minScale ?? 0;
    this.maxScale = options.maxScale ?? 0;
    this.listMode = options.listMode ?? "show";
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.style) ?? new CompatEventBus();
    this.styleJson = typeof options.style === "object" && options.style !== null ? { ...options.style } : undefined;
    this.watchListeners = new Map();
    this.eventListeners = new Map();
  }

  public async load(): Promise<VectorTileLayerCompat> {
    if (this.loaded) return this;
    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    try {
      if (this.styleJson === undefined && typeof this.style === "string") {
        const response = await fetch(this.style);
        if (!response.ok) throw new Error(`Failed to fetch vector tile style: ${response.status}`);
        this.styleJson = (await response.json()) as Record<string, unknown>;
      }
      this.loaded = true;
      this.loadStatus = "loaded";
      this.notifyWatchers("loaded", this.loaded);
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit("vector-tile-layer.loaded", { layerId: this.id, url: this.url }, this);
    } catch (error) {
      this.loadStatus = "failed";
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit("vector-tile-layer.failed", { layerId: this.id, error }, this);
      throw error;
    }
    return this;
  }

  public async when(callback?: (layer: VectorTileLayerCompat) => void): Promise<VectorTileLayerCompat> {
    const layer = await this.load();
    if (callback) callback(layer);
    return layer;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): VectorTileLayerHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);
    return { remove: () => { listeners?.delete(listener); } };
  }

  public on(eventName: string, listener: (event: unknown) => void): VectorTileLayerHandleCompat {
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);
    const subscription = this.eventBus.on(`vector-tile-layer.${eventName}`, (event) => {
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

  public getStyle(): Record<string, unknown> | undefined {
    return this.styleJson ? { ...this.styleJson } : undefined;
  }

  public loadStyle(style: Record<string, unknown>): void {
    this.styleJson = { ...style };
    this.style = style;
    this.notifyWatchers("style", this.styleJson);
    this.eventBus.emit("vector-tile-layer.style-changed", { layerId: this.id, style: this.styleJson }, this);
  }

  public destroy(): void {
    this.watchListeners.clear();
    this.eventListeners.clear();
    this.eventBus.emit("vector-tile-layer.destroyed", { layerId: this.id }, this);
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) return;
    for (const listener of listeners) safeInvokeCompatListener(listener, value);
  }
}
