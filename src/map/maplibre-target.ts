import { stripQueryAndFragment, trimTrailingSlashes } from "../core/path-utils.js";
import type {
  HonuaFeatureServiceSourceSpecification,
  HonuaLayerSpecification,
  HonuaMapServiceSourceSpecification,
  HonuaStyleSpecification,
} from "../style/specification.js";

/** Standard MapLibre raster source shape used by migrated tiled services. */
export interface HonuaMapLibreRasterSourceSpecification {
  [key: string]: unknown;
  type: "raster";
  tiles: string[];
  tileSize?: number;
  attribution?: string;
}

/** Layer/source pair consumed by {@link createHonuaMapLibreStyle}. */
export interface HonuaMapLibreLayerDefinition {
  id: string;
  sourceId: string;
  source:
    | HonuaFeatureServiceSourceSpecification
    | HonuaMapServiceSourceSpecification
    | HonuaMapLibreRasterSourceSpecification;
  layer: HonuaLayerSpecification;
}

/** Shared options for migrated ArcGIS layer constructors. */
export interface HonuaMapLibreLayerOptionsBase {
  id?: string;
  title?: string;
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  attribution?: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
}

/** Options for an ArcGIS FeatureLayer migrated into a Honua feature-service source. */
export interface HonuaFeatureServiceLayerOptions extends HonuaMapLibreLayerOptionsBase {
  url: string;
  outFields?: string[];
  definitionExpression?: string;
  returnGeometry?: boolean;
  outSR?: number;
  layerType?: "circle" | "line" | "fill";
}

/** Options for an ArcGIS MapImageLayer migrated into a Honua map-service source. */
export interface HonuaMapServiceLayerOptions extends HonuaMapLibreLayerOptionsBase {
  url: string;
  sublayers?: unknown;
  layers?: string;
  dpi?: number;
  format?: "png" | "png24" | "png32" | "jpg" | "gif";
  transparent?: boolean;
}

/** Options for an ArcGIS TileLayer migrated into a MapLibre raster tile source. */
export interface HonuaTileServiceLayerOptions extends HonuaMapLibreLayerOptionsBase {
  url: string;
  tileSize?: number;
}

/** Options for an ArcGIS Map migrated into a MapLibre style document. */
export interface HonuaMapLibreStyleOptions {
  basemap?: string;
  layers?: readonly HonuaMapLibreLayerDefinition[];
  name?: string;
  center?: [number, number];
  zoom?: number;
}

/** Options for an ArcGIS MapView migrated into MapLibre's `Map` constructor. */
export interface HonuaMapLibreMapOptions {
  map?: HonuaStyleSpecification;
  style?: HonuaStyleSpecification;
  container?: string | HTMLElement;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
}

/**
 * Create a Honua feature-service source and a default MapLibre render layer.
 *
 * The returned `source` carries the custom `honua-feature-service` type, which
 * MapLibre's renderer does not understand on its own — adding it to a
 * `maplibre-gl` `Map` directly is a silent no-op. To render it, run the layer's
 * source through the MapLibre runtime adapter
 * (`loadHonuaFeatureServiceGeoJson` / `registerHonuaFeatureServiceSources` from
 * `@honua/sdk-js/map`), which fetches features via the SDK and produces a
 * standard `geojson` source. This differs from
 * {@link createHonuaTileServiceLayer}, which emits a native MapLibre `raster`
 * source that renders without an adapter.
 *
 * @see loadHonuaFeatureServiceGeoJson
 * @see registerHonuaFeatureServiceSources
 */
export function createHonuaFeatureServiceLayer(options: HonuaFeatureServiceLayerOptions): HonuaMapLibreLayerDefinition {
  const sourceId = normalizeLayerId(options.id, options.title, options.url, "feature-service");
  const layerType = options.layerType ?? "circle";
  const source: HonuaFeatureServiceSourceSpecification = {
    type: "honua-feature-service",
    url: options.url,
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.definitionExpression ? { definitionExpression: options.definitionExpression } : {}),
    ...(options.outFields ? { outFields: [...options.outFields] } : {}),
    ...(options.returnGeometry !== undefined ? { returnGeometry: options.returnGeometry } : {}),
    ...(options.outSR !== undefined ? { outSR: options.outSR } : {}),
  };

  return {
    id: sourceId,
    sourceId,
    source,
    layer: buildLayer(sourceId, layerType, options),
  };
}

/**
 * Create a Honua map-service source and a default MapLibre raster layer.
 */
export function createHonuaMapServiceLayer(options: HonuaMapServiceLayerOptions): HonuaMapLibreLayerDefinition {
  const sourceId = normalizeLayerId(options.id, options.title, options.url, "map-service");
  const source: HonuaMapServiceSourceSpecification = {
    type: "honua-map-service",
    url: options.url,
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.layers ? { layers: options.layers } : {}),
    ...(options.dpi !== undefined ? { dpi: options.dpi } : {}),
    ...(options.format ? { format: options.format } : {}),
    ...(options.transparent !== undefined ? { transparent: options.transparent } : {}),
  };

  return {
    id: sourceId,
    sourceId,
    source,
    layer: buildLayer(sourceId, "raster", options),
  };
}

/**
 * Create a MapLibre raster source and layer for an ArcGIS tiled service.
 */
export function createHonuaTileServiceLayer(options: HonuaTileServiceLayerOptions): HonuaMapLibreLayerDefinition {
  const sourceId = normalizeLayerId(options.id, options.title, options.url, "tile-service");
  const baseUrl = trimTrailingSlashes(options.url);
  const source: HonuaMapLibreRasterSourceSpecification = {
    type: "raster",
    tiles: [`${baseUrl}/tile/{z}/{y}/{x}`],
    tileSize: options.tileSize ?? 256,
    ...(options.attribution ? { attribution: options.attribution } : {}),
  };

  return {
    id: sourceId,
    sourceId,
    source,
    layer: buildLayer(sourceId, "raster", options),
  };
}

/**
 * Create a MapLibre style document from migrated ArcGIS `Map` options.
 */
export function createHonuaMapLibreStyle(options: HonuaMapLibreStyleOptions = {}): HonuaStyleSpecification {
  const sources: HonuaStyleSpecification["sources"] = {};
  const layers: HonuaLayerSpecification[] = [];

  for (const layer of options.layers ?? []) {
    sources[layer.sourceId] = layer.source;
    layers.push(layer.layer);
  }

  return {
    version: 8,
    ...(options.name ? { name: options.name } : {}),
    ...(options.center ? { center: options.center } : {}),
    ...(options.zoom !== undefined ? { zoom: options.zoom } : {}),
    metadata: options.basemap ? { "honua:arcgis-basemap": options.basemap } : undefined,
    sources,
    layers,
  };
}

/**
 * Create the options object passed to `new maplibregl.Map(...)`.
 */
export function createHonuaMapLibreMapOptions(options: HonuaMapLibreMapOptions): Record<string, unknown> {
  const style = options.style ?? options.map ?? createHonuaMapLibreStyle();
  return {
    style,
    ...(options.container !== undefined ? { container: options.container } : {}),
    ...(options.center ? { center: options.center } : {}),
    ...(options.zoom !== undefined ? { zoom: options.zoom } : {}),
    ...(options.bearing !== undefined ? { bearing: options.bearing } : {}),
    ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
  };
}

function buildLayer(
  sourceId: string,
  type: "circle" | "line" | "fill" | "raster",
  options: HonuaMapLibreLayerOptionsBase,
): HonuaLayerSpecification {
  return {
    id: `${sourceId}-${type}`,
    source: sourceId,
    type,
    ...(options.visible === false ? { layout: { ...(options.layout ?? {}), visibility: "none" } } : {}),
    ...(options.visible !== false && options.layout ? { layout: options.layout } : {}),
    ...(options.paint || options.opacity !== undefined ? { paint: buildPaint(type, options) } : {}),
    ...(options.minScale !== undefined ? { minzoom: scaleToZoom(options.minScale) } : {}),
    ...(options.maxScale !== undefined ? { maxzoom: scaleToZoom(options.maxScale) } : {}),
    metadata: {
      ...(options.title ? { title: options.title } : {}),
      ...(options.id ? { "honua:source-id": options.id } : {}),
    },
  };
}

function buildPaint(
  type: "circle" | "line" | "fill" | "raster",
  options: HonuaMapLibreLayerOptionsBase,
): Record<string, unknown> {
  const paint = { ...(options.paint ?? {}) };
  if (options.opacity === undefined) {
    return paint;
  }

  if (type === "circle") paint["circle-opacity"] = options.opacity;
  if (type === "line") paint["line-opacity"] = options.opacity;
  if (type === "fill") paint["fill-opacity"] = options.opacity;
  if (type === "raster") paint["raster-opacity"] = options.opacity;
  return paint;
}

function normalizeLayerId(id: string | undefined, title: string | undefined, url: string, fallback: string): string {
  return sanitizeId(id ?? title ?? lastUrlSegment(url) ?? fallback);
}

function lastUrlSegment(url: string): string | undefined {
  const trimmed = trimTrailingSlashes(stripQueryAndFragment(url));
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return segment || undefined;
}

function sanitizeId(value: string): string {
  const id = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return id || "layer";
}

function scaleToZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 0;
  }
  return Math.max(0, Math.log2(591657550.5 / scale));
}
