/**
 * Mounts a MapLibre map into a compat view container. `maplibre-gl` stays a
 * dynamic peer import so the esri-compat bundle does not inline the renderer.
 * Headless callers (no element, or no `maplibre-gl`) get `undefined` and the
 * view keeps its state model.
 */

const OSM_RASTER_STYLE = {
  version: 8,
  sources: {
    "honua-osm": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "honua-osm", type: "raster", source: "honua-osm" }],
} as const;

interface MapLibreMapLike {
  setCenter?(center: [number, number]): void;
  setZoom?(zoom: number): void;
  getSource?(id: string): { setData?(data: unknown): void } | undefined;
  addSource?(id: string, source: unknown): void;
  addLayer?(layer: unknown): void;
  once?(event: string, handler: () => void): void;
  remove?(): void;
}

interface MapLibreNamespace {
  Map?: new (options: Record<string, unknown>) => MapLibreMapLike;
  default?: { Map?: new (options: Record<string, unknown>) => MapLibreMapLike };
}

export interface CompatMapSurface {
  setView(center: [number, number] | undefined, zoom: number | undefined): void;
  setGraphics(graphics: readonly unknown[]): void;
  destroy(): void;
}

export function resolveViewContainer(container: unknown): HTMLElement | undefined {
  if (typeof HTMLElement !== "undefined" && container instanceof HTMLElement) {
    return container;
  }
  if (typeof container === "string" && typeof document !== "undefined") {
    const element = document.getElementById(container);
    return element instanceof HTMLElement ? element : undefined;
  }
  return undefined;
}

export async function mountCompatMap(
  container: HTMLElement,
  center: [number, number] | undefined,
  zoom: number | undefined,
): Promise<CompatMapSurface | undefined> {
  let namespace: MapLibreNamespace;
  try {
    namespace = (await import("maplibre-gl")) as unknown as MapLibreNamespace;
  } catch {
    return undefined;
  }
  const MapCtor = namespace.Map ?? namespace.default?.Map;
  if (!MapCtor) {
    return undefined;
  }

  const map = new MapCtor({
    container,
    style: OSM_RASTER_STYLE,
    center: center ?? [0, 20],
    zoom: zoom ?? 2,
    attributionControl: true,
  });
  const ready = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(ok);
    };
    map.once?.("load", () => finish(true));
    map.once?.("error", () => finish(false));
    setTimeout(() => finish(false), 15000);
  });
  if (!ready) {
    map.remove?.();
    return undefined;
  }

  let graphics: readonly unknown[] = [];
  const paint = () => {
    const data = {
      type: "FeatureCollection",
      features: graphics.flatMap((graphic) => graphicToFeatures(graphic)),
    };
    const source = map.getSource?.("honua-graphics");
    if (source?.setData) {
      source.setData(data);
      return;
    }
    map.addSource?.("honua-graphics", { type: "geojson", data });
    map.addLayer?.({
      id: "honua-graphics-circle",
      type: "circle",
      source: "honua-graphics",
      paint: { "circle-radius": 6, "circle-color": "#c62828", "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
    });
  };

  return {
    setView(nextCenter, nextZoom) {
      if (nextCenter) {
        map.setCenter?.(nextCenter);
      }
      if (typeof nextZoom === "number" && Number.isFinite(nextZoom)) {
        map.setZoom?.(nextZoom);
      }
    },
    setGraphics(next) {
      graphics = next;
      paint();
    },
    destroy() {
      map.remove?.();
    },
  };
}

export function lonLatFromUnknown(value: unknown): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [value[0], value[1]];
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as {
    longitude?: number;
    latitude?: number;
    x?: number;
    y?: number;
    spatialReference?: { wkid?: number };
  };
  if (typeof record.longitude === "number" && typeof record.latitude === "number") {
    return [record.longitude, record.latitude];
  }
  if (typeof record.x !== "number" || typeof record.y !== "number") {
    return undefined;
  }
  const wkid = record.spatialReference?.wkid;
  if (wkid === 102100 || wkid === 3857 || Math.abs(record.x) > 180 || Math.abs(record.y) > 90) {
    return webMercatorToLonLat(record.x, record.y);
  }
  return [record.x, record.y];
}

function graphicToFeatures(graphic: unknown): Array<{ type: "Feature"; geometry: unknown; properties: Record<string, unknown> }> {
  if (!graphic || typeof graphic !== "object") {
    return [];
  }
  const geometry = (graphic as { geometry?: unknown }).geometry;
  const point = lonLatFromUnknown(geometry);
  if (!point) {
    return [];
  }
  const attributes = (graphic as { attributes?: unknown }).attributes;
  return [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: point },
      properties: attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {},
    },
  ];
}

function webMercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  const latRadians = Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 2 - Math.PI / 2;
  return [lon, (latRadians * 180) / Math.PI];
}
