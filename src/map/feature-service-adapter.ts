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
import { esriGeometryToGeoJSON } from "../core/esri-geojson.js";
import { HonuaFeatureLayer } from "../core/surfaces.js";
import type { HonuaFeatureLayerQueryAllRequest } from "../core/surfaces.js";
import type { EsriGeometryType, HonuaLayerMetadata } from "../core/types.js";
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

/** Validate an unambiguous shape when the service cannot declare its geometry type. */
function isValidGenericGeometry(geometry: Record<string, unknown>): boolean {
  const shapes = [
    "x" in geometry || "y" in geometry,
    "points" in geometry,
    "paths" in geometry,
    "rings" in geometry,
    ["xmin", "ymin", "xmax", "ymax"].some((key) => key in geometry),
  ];
  if (shapes.filter(Boolean).length !== 1) return false;
  if (shapes[0]) return asFiniteNumber(geometry.x) !== undefined && asFiniteNumber(geometry.y) !== undefined;
  if (shapes[1])
    return (
      Array.isArray(geometry.points) &&
      geometry.points.length > 0 &&
      geometry.points.every((point) => asPosition(point) !== undefined)
    );
  if (shapes[2] || shapes[3]) {
    const parts = shapes[2] ? geometry.paths : geometry.rings;
    const polygon = shapes[3];
    return (
      Array.isArray(parts) &&
      parts.length > 0 &&
      parts.every((part) => {
        if (
          !Array.isArray(part) ||
          part.length < (polygon ? 4 : 2) ||
          !part.every((point) => asPosition(point) !== undefined)
        )
          return false;
        if (!polygon) return true;
        const first = asPosition(part[0])!;
        const last = asPosition(part[part.length - 1])!;
        return first[0] === last[0] && first[1] === last[1];
      })
    );
  }
  const bounds = [geometry.xmin, geometry.ymin, geometry.xmax, geometry.ymax].map(asFiniteNumber);
  return bounds.every((value) => value !== undefined) && bounds[0]! <= bounds[2]! && bounds[1]! <= bounds[3]!;
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
  dimensions?: Pick<HonuaLayerMetadata, "hasZ" | "hasM">,
): AdapterGeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return null;

  let shape: Record<string, unknown>;
  if (geometryType === undefined || geometryType === null || geometryType === "esriGeometryNull") {
    shape = geometry;
  } else if (geometryType === "esriGeometryPoint" || (geometry.x !== undefined && geometry.y !== undefined)) {
    shape = { x: geometry.x, y: geometry.y, z: geometry.z };
  } else if (geometryType === "esriGeometryMultipoint") {
    shape = { points: geometry.points };
  } else if (geometryType === "esriGeometryPolyline") {
    shape = { paths: geometry.paths };
  } else if (geometryType === "esriGeometryPolygon") {
    shape = { rings: geometry.rings };
  } else if (geometryType === "esriGeometryEnvelope") {
    shape = { xmin: geometry.xmin, ymin: geometry.ymin, xmax: geometry.xmax, ymax: geometry.ymax };
  } else return null;

  // One converter owns exterior/hole grouping, winding and coordinate ordinates
  // for both metadata-declared and structurally inferred feature geometry.
  if (!isValidGenericGeometry(shape)) return null;
  // Optional Esri Z/M can be null. Keep finite spatial coordinates, omit
  // absent Z, and never treat a measure as GeoJSON altitude.
  const converted = esriGeometryToGeoJSON({ ...shape, z: asFiniteNumber(shape.z) });
  if (!converted || !("coordinates" in converted)) return null;
  const hasZ = asFiniteNumber(shape.z) !== undefined || (geometry.hasZ ?? dimensions?.hasZ) === true;
  const coordinates = projectCoordinates(converted.coordinates, hasZ);
  const polygons =
    converted.type === "Polygon"
      ? [coordinates as number[][][]]
      : converted.type === "MultiPolygon"
        ? (coordinates as number[][][][])
        : [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      // Close after dimension projection, comparing every retained ordinate.
      // Append the first position so a distinct final Z is not discarded.
      if (first && last && (first.length !== last.length || first.some((value, index) => value !== last[index])))
        ring.push([...first]);
    }
  }
  return { type: converted.type, coordinates };
}

/**
 * Convert an array of Esri features (attributes + geometry) into a GeoJSON
 * `FeatureCollection`.
 */
export function esriFeaturesToGeoJson(
  features: ReadonlyArray<{ attributes?: Record<string, unknown>; geometry?: Record<string, unknown> | null }>,
  geometryType: EsriGeometryType | undefined,
  dimensions?: Pick<HonuaLayerMetadata, "hasZ" | "hasM">,
): AdapterGeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      type: "Feature",
      geometry: esriGeometryToGeoJson(feature.geometry ?? null, geometryType, dimensions),
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
  const metadata = await metadataPromise;

  const data = esriFeaturesToGeoJson(
    features as ReadonlyArray<{ attributes?: Record<string, unknown>; geometry?: Record<string, unknown> | null }>,
    metadata?.geometryType,
    metadata,
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

/** Options for {@link registerHonuaFeatureServiceSources}. */
export interface RegisterHonuaFeatureServiceSourcesOptions extends LoadHonuaFeatureServiceGeoJsonOptions {
  /**
   * Maximum number of feature-service sources to fetch concurrently. Defaults
   * to {@link DEFAULT_REGISTER_CONCURRENCY}. Total load latency becomes the max
   * of the per-source fetches rather than their sum.
   */
  concurrency?: number;
}

/** Default fetch fan-out for {@link registerHonuaFeatureServiceSources}. */
const DEFAULT_REGISTER_CONCURRENCY = 6;

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
  options: RegisterHonuaFeatureServiceSourcesOptions = {},
): Promise<RegisterHonuaFeatureServiceSourcesResult> {
  const registered: string[] = [];
  const failed: Array<{ sourceId: string; error: unknown }> = [];

  // Collect the feature-service sources to load, validating `url` up front so a
  // missing url fails fast without consuming a fetch slot.
  const pending: Array<{ sourceId: string; url: string; spec: unknown }> = [];
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
    pending.push({ sourceId, url, spec });
  }

  // Fetch sources with bounded concurrency: total latency becomes the max of the
  // per-source fetches instead of their sum (a startup cliff for multi-layer maps).
  const concurrency =
    typeof options.concurrency === "number" && Number.isFinite(options.concurrency)
      ? Math.max(1, Math.trunc(options.concurrency))
      : DEFAULT_REGISTER_CONCURRENCY;
  const results = await allSettledLimited(pending, concurrency, (item) =>
    loadHonuaFeatureServiceGeoJson(client, item.url, {
      ...options,
      ...featureServiceSpecOverrides(item.spec),
    }),
  );

  // Apply the fetched sources to the map sequentially, preserving source order.
  // Map mutations are synchronous and must stay single-threaded.
  for (let index = 0; index < pending.length; index += 1) {
    const { sourceId } = pending[index];
    const result = results[index];
    if (result.status === "rejected") {
      failed.push({ sourceId, error: result.reason });
      continue;
    }
    try {
      const source = result.value;
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

/** Derive per-source query overrides from a `honua-feature-service` source spec. */
function featureServiceSpecOverrides(spec: unknown): LoadHonuaFeatureServiceGeoJsonOptions {
  return {
    ...(typeof (spec as { definitionExpression?: unknown }).definitionExpression === "string"
      ? { definitionExpression: (spec as { definitionExpression: string }).definitionExpression }
      : {}),
    ...(Array.isArray((spec as { outFields?: unknown }).outFields)
      ? { outFields: (spec as { outFields: string[] }).outFields }
      : {}),
    ...(typeof (spec as { outSR?: unknown }).outSR === "number" ? { outSR: (spec as { outSR: number }).outSR } : {}),
    ...(typeof (spec as { attribution?: unknown }).attribution === "string"
      ? { attribution: (spec as { attribution: string }).attribution }
      : {}),
  };
}

/**
 * Run `worker` over `values` with at most `concurrency` in flight, collecting
 * settled results in input order. Mirrors the limiter in `runtime/query-tiles`;
 * kept local to avoid coupling the map layer to the runtime tile pipeline.
 */
async function allSettledLimited<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(values[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => run());
  await Promise.all(workers);
  return results;
}

// ── Coercion helpers ─────────────────────────────────────────

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPosition(value: unknown): [number, number, ...number[]] | undefined {
  return Array.isArray(value) &&
    value.length >= 2 &&
    asFiniteNumber(value[0]) !== undefined &&
    asFiniteNumber(value[1]) !== undefined
    ? (value as [number, number, ...number[]])
    : undefined;
}

/** GeoJSON has spatial coordinates, not Esri measures; absent optional Z stays 2D. */
function projectCoordinates(coordinates: unknown, hasZ: boolean): unknown {
  if (!Array.isArray(coordinates)) return coordinates;
  if (Array.isArray(coordinates[0])) return coordinates.map((part) => projectCoordinates(part, hasZ));
  return coordinates.slice(0, hasZ && asFiniteNumber(coordinates[2]) !== undefined ? 3 : 2);
}
