/**
 * Mounts a MapLibre map into a compat view container. `maplibre-gl` stays a
 * dynamic peer import so the esri-compat bundle does not inline the renderer.
 * Headless callers (no element) get `undefined`. A real element whose renderer
 * fails to start also gets `undefined`, and the view treats that as a failed load.
 */

const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const ESRI_BASEMAP_TILES: Record<string, string> = {
  streets: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  "streets-vector":
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  "streets-navigation-vector":
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  satellite: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  hybrid: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  "satellite-vector": "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  "hybrid-vector": "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  topo: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  "topo-vector": "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  gray: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  "gray-vector":
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  "dark-gray":
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  oceans: "https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
  osm: OSM_TILES,
};

interface MapLibreMapLike {
  setCenter?(center: [number, number]): void;
  setZoom?(zoom: number): void;
  fitBounds?(bounds: [[number, number], [number, number]], options?: Record<string, unknown>): void;
  getSource?(id: string): { setData?(data: unknown): void } | undefined;
  addSource?(id: string, source: unknown): void;
  addLayer?(layer: unknown): void;
  setStyle?(style: unknown): void;
  project?(point: [number, number]): { x: number; y: number };
  unproject?(point: [number, number]): { lng: number; lat: number };
  on?(
    event: string,
    handler: (event: { point?: { x: number; y: number }; lngLat?: { lng: number; lat: number } }) => void,
  ): void;
  once?(event: string, handler: () => void): void;
  remove?(): void;
}

interface MapLibreNamespace {
  Map?: new (options: Record<string, unknown>) => MapLibreMapLike;
  default?: { Map?: new (options: Record<string, unknown>) => MapLibreMapLike };
}

export interface CompatMapClick {
  x: number;
  y: number;
  longitude: number;
  latitude: number;
}

export interface CompatMapExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: { wkid?: number };
}

export interface CompatMapSurface {
  setView(center: [number, number] | undefined, zoom: number | undefined): void;
  setGraphics(graphics: readonly unknown[]): void;
  setOverlays(graphics: readonly unknown[]): void;
  fitExtent(extent: CompatMapExtent): void;
  project(longitude: number, latitude: number): { x: number; y: number } | undefined;
  unproject(x: number, y: number): { longitude: number; latitude: number } | undefined;
  onClick(handler: (event: CompatMapClick) => void): void;
  setBasemap(basemap: unknown): void;
  destroy(): void;
}

export function resolveViewContainer(container: unknown): HTMLElement | undefined {
  if (typeof HTMLElement !== "undefined" && container instanceof HTMLElement) {
    return container;
  }
  if (typeof container === "string" && typeof document !== "undefined") {
    const element = document.getElementById(container);
    return typeof HTMLElement !== "undefined" && element instanceof HTMLElement ? element : undefined;
  }
  return undefined;
}

export function rasterStyleForBasemap(basemap: unknown): Record<string, unknown> {
  const templates = tileTemplatesForBasemap(basemap);
  const tiles = templates.length > 0 ? templates : [OSM_TILES];
  const sources: Record<string, unknown> = {};
  const layers: Record<string, unknown>[] = [];
  for (const [index, template] of tiles.entries()) {
    const id = index === 0 ? "honua-basemap" : `honua-basemap-${index}`;
    const attribution = template === OSM_TILES ? "© OpenStreetMap contributors" : "Esri, Maxar, Earthstar Geographics";
    sources[id] = { type: "raster", tiles: [template], tileSize: 256, attribution };
    layers.push({ id, type: "raster", source: id });
  }
  return { version: 8, sources, layers };
}

export async function mountCompatMap(
  container: HTMLElement,
  center: [number, number] | undefined,
  zoom: number | undefined,
  basemap?: unknown,
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
    style: rasterStyleForBasemap(basemap),
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
      features: graphics.flatMap((graphic) => drawnFeaturesFromGraphic(graphic)),
    };
    const source = map.getSource?.("honua-overlays");
    if (source?.setData) {
      source.setData(data);
      return;
    }
    map.addSource?.("honua-overlays", { type: "geojson", data });
    map.addLayer?.({
      id: "honua-overlays-fill",
      type: "fill",
      source: "honua-overlays",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": ["coalesce", ["get", "color"], "#c62828"], "fill-opacity": 0.35 },
    });
    map.addLayer?.({
      id: "honua-overlays-line",
      type: "line",
      source: "honua-overlays",
      filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon"]]],
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#c62828"],
        "line-width": ["coalesce", ["get", "width"], 2],
      },
    });
    map.addLayer?.({
      id: "honua-overlays-circle",
      type: "circle",
      source: "honua-overlays",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ["coalesce", ["get", "radius"], 6],
        "circle-color": ["coalesce", ["get", "color"], "#c62828"],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
      },
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
    setOverlays(next) {
      graphics = next;
      paint();
    },
    fitExtent(extent) {
      const sw = coordinateToLonLat([extent.xmin, extent.ymin], extent.spatialReference?.wkid);
      const ne = coordinateToLonLat([extent.xmax, extent.ymax], extent.spatialReference?.wkid);
      if (!sw || !ne) {
        return;
      }
      map.fitBounds?.(
        [
          [sw[0], sw[1]],
          [ne[0], ne[1]],
        ],
        { padding: 24, animate: false },
      );
    },
    project(longitude, latitude) {
      const point = map.project?.([longitude, latitude]);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return undefined;
      }
      return { x: point.x, y: point.y };
    },
    unproject(x, y) {
      const lngLat = map.unproject?.([x, y]);
      if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) {
        return undefined;
      }
      return { longitude: lngLat.lng, latitude: lngLat.lat };
    },
    setBasemap(basemap) {
      map.setStyle?.(rasterStyleForBasemap(basemap));
      map.once?.("style.load", () => paint());
    },
    onClick(handler) {
      map.on?.("click", (event) => {
        const x = event.point?.x;
        const y = event.point?.y;
        const longitude = event.lngLat?.lng;
        const latitude = event.lngLat?.lat;
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          typeof longitude !== "number" ||
          typeof latitude !== "number"
        ) {
          return;
        }
        handler({ x, y, longitude, latitude });
      });
    },
    destroy() {
      map.remove?.();
    },
  };
}

export function lonLatFromUnknown(value: unknown): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return coordinateToLonLat([value[0], value[1]]);
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
  return coordinateToLonLat([record.x, record.y], record.spatialReference?.wkid);
}

export function drawnFeaturesFromGraphic(graphic: unknown): Array<{
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown>;
}> {
  if (!graphic || typeof graphic !== "object") {
    return [];
  }
  const record = graphic as { geometry?: unknown; attributes?: unknown; symbol?: unknown };
  const geometry = geoJsonGeometry(record.geometry);
  if (!geometry) {
    return [];
  }
  const style = symbolStyle(record.symbol);
  const attributes = record.attributes && typeof record.attributes === "object" ? record.attributes : {};
  return [
    {
      type: "Feature",
      geometry,
      properties: {
        ...(attributes as Record<string, unknown>),
        color: style.color,
        radius: style.radius,
        width: style.width,
      },
    },
  ];
}

export function coordinateToLonLat(pair: readonly number[], wkid?: number): [number, number] | undefined {
  const x = pair[0];
  const y = pair[1];
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  if (wkid === 102100 || wkid === 3857 || Math.abs(x) > 180 || Math.abs(y) > 90) {
    return webMercatorToLonLat(x, y);
  }
  return [x, y];
}

function tileTemplatesForBasemap(basemap: unknown): string[] {
  if (typeof basemap === "string") {
    const known = ESRI_BASEMAP_TILES[basemap];
    return known ? [known] : [];
  }
  if (!basemap || typeof basemap !== "object") {
    return [];
  }
  const record = basemap as {
    id?: unknown;
    title?: unknown;
    portalItem?: unknown;
    baseMapLayers?: unknown;
    baseLayers?: unknown;
    referenceLayers?: unknown;
  };
  const fromLayers = tileTemplatesFromLayerLists(record.baseLayers, record.baseMapLayers, record.referenceLayers);
  if (fromLayers.length > 0) {
    return fromLayers;
  }
  // A portal item owns its tiles. The app id (WFRC uses "hybrid" as a URL key)
  // must not select the well-known imagery template before that item loads.
  if (record.portalItem !== undefined && record.portalItem !== null) {
    return [];
  }
  const id = typeof record.id === "string" ? record.id : typeof record.title === "string" ? record.title : undefined;
  if (id && ESRI_BASEMAP_TILES[id]) {
    return [ESRI_BASEMAP_TILES[id]];
  }
  return [];
}

function tileTemplatesFromLayerLists(...lists: unknown[]): string[] {
  const templates: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const layer of list) {
      if (!layer || typeof layer !== "object") {
        continue;
      }
      const url = (layer as { url?: unknown }).url;
      if (typeof url === "string" && /MapServer/i.test(url)) {
        templates.push(`${url.replace(/\/$/, "")}/tile/{z}/{y}/{x}`);
      }
    }
  }
  return templates;
}

function geoJsonGeometry(geometry: unknown): { type: string; coordinates: unknown } | undefined {
  if (!geometry || typeof geometry !== "object") {
    return undefined;
  }
  const record = geometry as {
    x?: number;
    y?: number;
    longitude?: number;
    latitude?: number;
    paths?: unknown;
    rings?: unknown;
    spatialReference?: { wkid?: number };
  };
  const wkid = record.spatialReference?.wkid;
  const point = lonLatFromUnknown(record);
  if (point && record.paths === undefined && record.rings === undefined) {
    return { type: "Point", coordinates: point };
  }
  const paths = lineCoordinates(record.paths, wkid);
  if (paths.length === 1) {
    return { type: "LineString", coordinates: paths[0] };
  }
  if (paths.length > 1) {
    return { type: "MultiLineString", coordinates: paths };
  }
  const rings = lineCoordinates(record.rings, wkid);
  if (rings.length > 0) {
    return { type: "Polygon", coordinates: rings };
  }
  return undefined;
}

function lineCoordinates(value: unknown, wkid: number | undefined): number[][][] {
  if (!Array.isArray(value)) {
    return [];
  }
  const lines: number[][][] = [];
  for (const line of value) {
    if (!Array.isArray(line)) {
      continue;
    }
    const coordinates: number[][] = [];
    for (const pair of line) {
      if (!Array.isArray(pair)) {
        continue;
      }
      const lonLat = coordinateToLonLat(pair, wkid);
      if (lonLat) {
        coordinates.push(lonLat);
      }
    }
    if (coordinates.length >= 2) {
      lines.push(coordinates);
    }
  }
  return lines;
}

function symbolStyle(symbol: unknown): { color: string; radius: number; width: number } {
  const fallback = { color: "#c62828", radius: 6, width: 2 };
  if (!symbol || typeof symbol !== "object") {
    return fallback;
  }
  const record = symbol as {
    color?: unknown;
    size?: unknown;
    width?: unknown;
    outline?: { color?: unknown; width?: unknown };
  };
  const color = cssColor(record.color) ?? cssColor(record.outline?.color) ?? fallback.color;
  const radius = typeof record.size === "number" && record.size > 0 ? record.size / 2 : fallback.radius;
  const width =
    typeof record.width === "number" && record.width > 0
      ? record.width
      : typeof record.outline?.width === "number" && record.outline.width > 0
        ? record.outline.width
        : fallback.width;
  return { color, radius, width };
}

function cssColor(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (!Array.isArray(value) || value.length < 3) {
    return undefined;
  }
  const [red, green, blue, alpha] = value;
  if (typeof red !== "number" || typeof green !== "number" || typeof blue !== "number") {
    return undefined;
  }
  const a = typeof alpha === "number" ? alpha / 255 : 1;
  return `rgba(${red}, ${green}, ${blue}, ${a})`;
}

function webMercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  const latRadians = Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 2 - Math.PI / 2;
  return [lon, (latRadians * 180) / Math.PI];
}
