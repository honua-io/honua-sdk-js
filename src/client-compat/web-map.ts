import { FeatureLayerCompat } from "./feature-layer.js";
import { MapCompat, type MapCompatHandle, type MapCompatOptions, type MapLoadStatusCompat } from "./map.js";
import { PortalCompat } from "./portal.js";

export interface WebMapCompatOptions extends MapCompatOptions {
  portalItem?: unknown;
}

export type WebMapLoadStatusCompat = MapLoadStatusCompat;
export type WebMapHandleCompat = MapCompatHandle;

export class WebMapCompat extends MapCompat {
  public initialExtent:
    | { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference?: { wkid?: number } }
    | undefined;

  public constructor(options: WebMapCompatOptions = {}) {
    super(options);
    this.initialExtent = undefined;
  }

  public override async load(): Promise<WebMapCompat> {
    if (this.loaded) {
      return this;
    }
    await this.populateFromPortalItem();
    await super.load();
    return this;
  }

  private async populateFromPortalItem(): Promise<void> {
    const portalItem = readPortalItem(this.portalItem);
    if (!portalItem || this.layers.length > 0) {
      return;
    }
    const portal = new PortalCompat({ portalUrl: portalItem.portalUrl });
    try {
      const item = await portal.getItem(portalItem.id);
      this.setPortalItem({ ...portalItem.raw, ...item, id: portalItem.id });
      const data = await portal.getItemData(portalItem.id);
      const viewState = readWebMapViewState(data);
      if (viewState.extent) {
        this.initialExtent = viewState.extent;
      }
      if (this.basemap === undefined && viewState.basemap !== undefined) {
        this.setBasemap(viewState.basemap);
      }
      for (const layer of featureLayersFromWebMap(data)) {
        this.add(layer);
      }
    } catch {
      // A private item or a missing data document leaves the map empty.
      // The view still becomes ready so the page can show the failure.
    }
  }

  public async when(callback?: (map: WebMapCompat) => void): Promise<WebMapCompat> {
    const map = await this.load();
    if (callback) {
      callback(map);
    }
    return map;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): WebMapHandleCompat {
    return super.watch(propertyName, listener);
  }

  public setPortalItem(portalItem: unknown): void {
    super.setPortalItem(portalItem);
    this.eventBus.emit("web-map.portal-item-changed", { portalItem }, this);
  }
}

function readPortalItem(value: unknown): { id: string; portalUrl?: string; raw: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { id?: unknown; portal?: { url?: unknown } };
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  const portalUrl = typeof record.portal?.url === "string" ? record.portal.url : undefined;
  return { id: record.id, portalUrl, raw: value as Record<string, unknown> };
}

function readWebMapViewState(data: unknown): {
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference?: { wkid?: number } };
  basemap?: unknown;
} {
  if (!data || typeof data !== "object") {
    return {};
  }
  const record = data as {
    basemap?: unknown;
    baseMap?: unknown;
    extent?: unknown;
    initialState?: { viewpoint?: { targetGeometry?: unknown } };
  };
  const target = record.initialState?.viewpoint?.targetGeometry ?? record.extent;
  return {
    basemap: record.basemap ?? record.baseMap,
    extent: readExtent(target),
  };
}

function readExtent(
  value: unknown,
): { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference?: { wkid?: number } } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as {
    xmin?: unknown;
    ymin?: unknown;
    xmax?: unknown;
    ymax?: unknown;
    spatialReference?: { wkid?: unknown };
  };
  if (
    typeof record.xmin !== "number" ||
    typeof record.ymin !== "number" ||
    typeof record.xmax !== "number" ||
    typeof record.ymax !== "number"
  ) {
    return undefined;
  }
  const wkid = record.spatialReference?.wkid;
  return {
    xmin: record.xmin,
    ymin: record.ymin,
    xmax: record.xmax,
    ymax: record.ymax,
    ...(typeof wkid === "number" ? { spatialReference: { wkid } } : {}),
  };
}

function featureLayersFromWebMap(data: unknown): FeatureLayerCompat[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const layers = (data as { operationalLayers?: unknown }).operationalLayers;
  if (!Array.isArray(layers)) {
    return [];
  }
  const created: FeatureLayerCompat[] = [];
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") {
      continue;
    }
    const record = layer as { url?: unknown; title?: unknown; id?: unknown; visibility?: unknown };
    if (typeof record.url !== "string" || !/FeatureServer\/\d+/i.test(record.url)) {
      continue;
    }
    created.push(
      new FeatureLayerCompat({
        url: record.url,
        title: typeof record.title === "string" ? record.title : undefined,
        id: typeof record.id === "string" ? record.id : undefined,
        visible: record.visibility !== false,
      }),
    );
  }
  return created;
}
