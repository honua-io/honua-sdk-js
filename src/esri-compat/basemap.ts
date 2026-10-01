import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { PortalCompat } from "./portal.js";

export interface BasemapCompatOptions {
  id?: string;
  title?: string;
  baseLayers?: readonly unknown[];
  referenceLayers?: readonly unknown[];
  /** ArcGIS portal item, `{ id }` or a portal item id string. `load` fills the tiled layers from its data. */
  portalItem?: unknown;
  eventBus?: CompatEventBus;
}

export type BasemapLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface BasemapHandleCompat {
  remove(): void;
}

export class BasemapCompat {
  public readonly eventBus: CompatEventBus;
  public id: string | undefined;
  public title: string | undefined;
  public portalItem: unknown;
  public baseLayers: unknown[];
  public referenceLayers: unknown[];
  public loaded: boolean;
  public loadStatus: BasemapLoadStatusCompat;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  public constructor(options: BasemapCompatOptions = {}) {
    this.eventBus =
      options.eventBus ?? resolveCompatEventBus(options.baseLayers, options.referenceLayers) ?? new CompatEventBus();
    this.id = options.id;
    this.title = options.title ?? options.id;
    this.portalItem = options.portalItem;
    this.baseLayers = options.baseLayers ? [...options.baseLayers] : [];
    this.referenceLayers = options.referenceLayers ? [...options.referenceLayers] : [];
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.watchListeners = new Map();
  }

  public static fromId(id: string): BasemapCompat {
    return new BasemapCompat({
      id,
      title: id,
    });
  }

  public setBaseLayers(layers: readonly unknown[]): void {
    this.baseLayers = [...layers];
    this.notifyWatchers("baseLayers", this.baseLayers);
    this.eventBus.emit("basemap.base-layers-changed", { count: this.baseLayers.length }, this);
  }

  public setReferenceLayers(layers: readonly unknown[]): void {
    this.referenceLayers = [...layers];
    this.notifyWatchers("referenceLayers", this.referenceLayers);
    this.eventBus.emit("basemap.reference-layers-changed", { count: this.referenceLayers.length }, this);
  }

  public async load(): Promise<BasemapCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("basemap.loading", { id: this.id }, this);
    await this.populateFromPortalItem();
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("basemap.loaded", { id: this.id }, this);
    return this;
  }

  public async when(callback?: (basemap: BasemapCompat) => void): Promise<BasemapCompat> {
    const basemap = await this.load();
    if (callback) {
      callback(basemap);
    }
    return basemap;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): BasemapHandleCompat {
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

  public destroy(): void {
    this.watchListeners.clear();
  }

  private async populateFromPortalItem(): Promise<void> {
    if (this.baseLayers.length > 0 || this.portalItem === undefined || this.portalItem === null) {
      return;
    }
    const portalItem = readPortalItem(this.portalItem);
    if (!portalItem) {
      return;
    }
    const portal = new PortalCompat({ portalUrl: portalItem.portalUrl });
    try {
      const data = await portal.getItemData(portalItem.id);
      const layers = tiledLayersFromPortalData(data);
      if (layers.title && (this.title === undefined || this.title === this.id)) {
        this.title = layers.title;
        this.notifyWatchers("title", this.title);
      }
      if (layers.base.length > 0) {
        this.setBaseLayers(layers.base);
      }
      if (layers.reference.length > 0) {
        this.setReferenceLayers(layers.reference);
      }
    } catch {
      // A private item or a missing data document leaves the basemap without tiles.
    }
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

function readPortalItem(value: unknown): { id: string; portalUrl?: string } | undefined {
  if (typeof value === "string" && value.length > 0) {
    return { id: value };
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { id?: unknown; portal?: { url?: unknown } };
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  const portalUrl = typeof record.portal?.url === "string" ? record.portal.url : undefined;
  return { id: record.id, portalUrl };
}

function tiledLayersFromPortalData(data: unknown): { title?: string; base: unknown[]; reference: unknown[] } {
  if (!data || typeof data !== "object") {
    return { base: [], reference: [] };
  }
  const record = data as { baseMap?: unknown; basemap?: unknown; title?: unknown };
  const basemap = record.baseMap ?? record.basemap;
  if (!basemap || typeof basemap !== "object") {
    return { base: [], reference: [] };
  }
  const source = basemap as {
    title?: unknown;
    baseMapLayers?: unknown;
    baseLayers?: unknown;
    referenceLayers?: unknown;
  };
  const title =
    typeof source.title === "string" ? source.title : typeof record.title === "string" ? record.title : undefined;
  return {
    title,
    base: portalLayers(source.baseMapLayers ?? source.baseLayers),
    reference: portalLayers(source.referenceLayers),
  };
}

function portalLayers(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((layer) => {
    return Boolean(layer) && typeof layer === "object" && typeof (layer as { url?: unknown }).url === "string";
  });
}
