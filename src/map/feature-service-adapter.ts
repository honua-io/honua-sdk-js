/**
 * MapLibre runtime adapter for Honua feature-service sources.
 *
 * {@link createHonuaFeatureServiceLayer} (and the migration codemod) emit a
 * custom `honua-feature-service` source type that MapLibre's renderer does not
 * understand — adding it to a `maplibre-gl` `Map` directly is a silent no-op.
 *
 * This module bridges that gap. It fetches features through the SDK query path
 * ({@link HonuaFeatureLayer}) and converts the Esri feature set into a standard
 * GeoJSON `FeatureCollection`, then exposes it as a plain MapLibre `geojson`
 * source spec that the renderer renders natively. Callers either:
 *
 *  - call {@link loadHonuaFeatureServiceGeoJson} to obtain a `geojson` source
 *    spec they add to their style themselves, or
 *  - call {@link registerHonuaFeatureServiceSources} to walk a {@link HonuaMap}
 *    and live-patch every `honua-feature-service` source on a real MapLibre map
 *    into a fetched `geojson` source.
 *
 * Raster Honua sources (`honua-map-service`, tile services) already project
 * onto MapLibre-native sources and need no adapter; this fills in the feature
 * (vector) asymmetry.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaFeatureLayer } from "../core/surfaces.js";
import type { HonuaFeatureLayerQueryAllRequest } from "../core/surfaces.js";
import type { EsriGeometryType } from "../core/types.js";
import { parseFeatureLayerUrl } from "../esri-compat/url.js";
import type { HonuaMap } from "./honua-map.js";

/** A GeoJSON geometry produced by the adapter. */
export interface AdapterGeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** A GeoJSON feature produced by the adapter. */
export interface AdapterGeoJsonFeature {
  type: "Feature";
  id?: string | number;
  geometry: AdapterGeoJsonGeometry | null;
  properties: Record<string, unknown>;
}

/** A GeoJSON feature collection produced by the adapter. */
export interface AdapterGeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: AdapterGeoJsonFeature[];
}

/** A standard MapLibre `geojson` source specification. */
export interface MapLibreGeoJsonSourceSpecification {
  type: "geojson";
  data: AdapterGeoJsonFeatureCollection;
  attribution?: string;
}

/** Options controlling how the adapter fetches feature-service data. */
export interface LoadHonuaFeatureServiceGeoJsonOptions {
  /** Server-side WHERE clause. Defaults to `"1=1"`. */
  definitionExpression?: string;
  /** Fields to request. Defaults to all (`["*"]`). */
  outFields?: string[];
  /** Output spatial reference WKID. GeoJSON requires `4326`; defaults to it. */
  outSR?: number;
  /** Page size for paginated fetching. */
  pageSize?: number;
  /** Maximum pages to fetch. */
  maxPages?: number;
  /** Attribution to attach to the produced source spec. */
  attribution?: string;
  /** Abort signal forwarded to the query. */
  signal?: AbortSignal;
}

/**
 * The minimal MapLibre `Map` surface the adapter mutates. Any object exposing
 * these methods — including a real `maplibre-gl` `Map` — satisfies it.
 */
export interface FeatureServiceAdapterMap {
  getSource(id: string): unknown;
  addSource(id: string, source: unknown): void;
  removeSource(id: string): void;
}

interface MapLibreGeoJsonSourceHandle {
  setData(data: AdapterGeoJsonFeatureCollection): void;
}

/**
 * Convert a single Esri geometry into a GeoJSON geometry.
 *
 * Handles the geometry kinds a feature-service query returns (point,
 * multipoint, polyline, polygon, envelope). Returns `null` when the geometry is
 * absent or unrecognised so the feature still renders attribute-only.
 */
export function esriGeometryToGeoJson(
  geometry: Record<string, unknown> | null | undefined,
  geometryType: EsriGeometryType | undefined,
): AdapterGeoJsonGeometry | null {
  if (!geometry) {
    return null;
  }

  // Point geometries are recognisable structurally even without a declared
  // type (queries that elide geometryType still return {x, y}).
  if (geometryType === "esriGeometryPoint" || (geometry.x !== undefined && geometry.y !== undefined)) {
    const x = asFiniteNumber(geometry.x);
    const y = asFiniteNumber(geometry.y);
    if (x === undefined || y === undefined) return null;
    return { type: "Point", coordinates: [x, y] };
  }

  if (geometryType === "esriGeometryMultipoint") {
    const points = asArray(geometry.points)
      .map(asCoordinatePair)
      .filter((value): value is [number, number] => value !== undefined);
    return { type: "MultiPoint", coordinates: points };
  }

  if (geometryType === "esriGeometryPolyline") {
    const paths = asArray(geometry.paths)
      .map(asCoordinateArray)
      .filter((path) => path.length > 0);
    if (paths.length === 1) {
      return { type: "LineString", coordinates: paths[0] };
    }
    return { type: "MultiLineString", coordinates: paths };
  }

  if (geometryType === "esriGeometryPolygon") {
    const rings = asArray(geometry.rings)
      .map(asCoordinateArray)
      .filter((ring) => ring.length > 0);
    // MapLibre does not enforce GeoJSON ring winding for rendering, so the
    // adapter passes Esri rings through as a Polygon without re-nesting.
    return { type: "Polygon", coordinates: rings };
  }

  if (geometryType === "esriGeometryEnvelope") {
    const xmin = asFiniteNumber(geometry.xmin);
    const ymin = asFiniteNumber(geometry.ymin);
    const xmax = asFiniteNumber(geometry.xmax);
    const ymax = asFiniteNumber(geometry.ymax);
    if (xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined) {
      return null;
    }
    return {
      type: "Polygon",
      coordinates: [
        [
          [xmin, ymin],
          [xmax, ymin],
          [xmax, ymax],
          [xmin, ymax],
          [xmin, ymin],
        ],
      ],
    };
  }

  return null;
}

/**
 * Convert an array of Esri features (attributes + geometry) into a GeoJSON
 * `FeatureCollection`.
 */
export function esriFeaturesToGeoJson(
  features: ReadonlyArray<{ attributes?: Record<string, unknown>; geometry?: Record<string, unknown> | null }>,
  geometryType: EsriGeometryType | undefined,
): AdapterGeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      type: "Feature",
      geometry: esriGeometryToGeoJson(feature.geometry ?? null, geometryType),
      properties: { ...(feature.attributes ?? {}) },
    })),
  };
}

/**
 * Fetch a Honua feature-service layer through the SDK and return a standard
 * MapLibre `geojson` source specification that the renderer renders natively.
 *
 * @example
 * ```ts
 * const source = await loadHonuaFeatureServiceGeoJson(client, layer.source.url);
 * map.addSource(layer.sourceId, source);
 * map.addLayer(layer.layer);
 * ```
 */
export async function loadHonuaFeatureServiceGeoJson(
  client: HonuaClient,
  url: string,
  options: LoadHonuaFeatureServiceGeoJsonOptions = {},
): Promise<MapLibreGeoJsonSourceSpecification> {
  const parsed = parseFeatureLayerUrl(url);
  const layer = new HonuaFeatureLayer({
    client,
    serviceId: parsed.serviceId,
    layerId: parsed.layerId,
  });

  // GeoJSON is lon/lat (WGS84). Default outSR to 4326 so the rendered
  // coordinates land where MapLibre expects them.
  const outSR = options.outSR ?? 4326;
  const request: HonuaFeatureLayerQueryAllRequest = {
    where: options.definitionExpression ?? "1=1",
    outFields: options.outFields ?? ["*"],
    returnGeometry: true,
    outSr: outSR,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const metadataPromise = layer.metadata(options.signal ? { signal: options.signal } : {}).catch(() => undefined);
  const features = await layer.queryFeaturesAll(request);
  const geometryType = (await metadataPromise)?.geometryType;

  const data = esriFeaturesToGeoJson(
    features as ReadonlyArray<{ attributes?: Record<string, unknown>; geometry?: Record<string, unknown> | null }>,
    geometryType,
  );

  return {
    type: "geojson",
    data,
    ...(options.attribution ? { attribution: options.attribution } : {}),
  };
}

/** Result of {@link registerHonuaFeatureServiceSources}. */
export interface RegisterHonuaFeatureServiceSourcesResult {
  /** Source ids that were fetched and wired as `geojson` sources. */
  registered: string[];
  /** Source ids that failed to load, with the error encountered. */
  failed: Array<{ sourceId: string; error: unknown }>;
}

/**
 * Walk a {@link HonuaMap} and replace every `honua-feature-service` source on a
 * real MapLibre map with a fetched standard `geojson` source so feature layers
 * actually render.
 *
 * Existing `geojson` sources are updated in place via `setData`; otherwise a new
 * source is added. Layers should be added by the caller (or already present in
 * the style) — this only manages the data sources.
 *
 * @param map - A `maplibre-gl` `Map` (or any {@link FeatureServiceAdapterMap}).
 * @param honuaMap - The {@link HonuaMap} whose feature-service sources to wire.
 * @param client - The Honua client used to fetch features.
 */
export async function registerHonuaFeatureServiceSources(
  map: FeatureServiceAdapterMap,
  honuaMap: HonuaMap,
  client: HonuaClient,
  options: LoadHonuaFeatureServiceGeoJsonOptions = {},
): Promise<RegisterHonuaFeatureServiceSourcesResult> {
  const registered: string[] = [];
  const failed: Array<{ sourceId: string; error: unknown }> = [];

  for (const sourceId of honuaMap.sourceIds) {
    const spec = honuaMap.getSourceSpec(sourceId);
    if (!spec || spec.type !== "honua-feature-service") {
      continue;
    }
    const url = (spec as { url?: unknown }).url;
    if (typeof url !== "string" || url.length === 0) {
      failed.push({ sourceId, error: new Error(`feature-service source "${sourceId}" is missing url`) });
      continue;
    }

    try {
      const source = await loadHonuaFeatureServiceGeoJson(client, url, {
        ...options,
        ...(typeof (spec as { definitionExpression?: unknown }).definitionExpression === "string"
          ? { definitionExpression: (spec as { definitionExpression: string }).definitionExpression }
          : {}),
        ...(Array.isArray((spec as { outFields?: unknown }).outFields)
          ? { outFields: (spec as { outFields: string[] }).outFields }
          : {}),
        ...(typeof (spec as { outSR?: unknown }).outSR === "number"
          ? { outSR: (spec as { outSR: number }).outSR }
          : {}),
        ...(typeof (spec as { attribution?: unknown }).attribution === "string"
          ? { attribution: (spec as { attribution: string }).attribution }
          : {}),
      });

      const existing = map.getSource(sourceId);
      if (existing && typeof (existing as MapLibreGeoJsonSourceHandle).setData === "function") {
        (existing as MapLibreGeoJsonSourceHandle).setData(source.data);
      } else {
        if (existing) {
          map.removeSource(sourceId);
        }
        map.addSource(sourceId, source);
      }
      registered.push(sourceId);
    } catch (error) {
      failed.push({ sourceId, error });
    }
  }

  return { registered, failed };
}

// ── Coercion helpers ─────────────────────────────────────────

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asCoordinatePair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = asFiniteNumber(value[0]);
  const y = asFiniteNumber(value[1]);
  if (x === undefined || y === undefined) return undefined;
  return [x, y];
}

function asCoordinateArray(value: unknown): [number, number][] {
  return asArray(value)
    .map(asCoordinatePair)
    .filter((pair): pair is [number, number] => pair !== undefined);
}
