/**
 * HonuaMapSpec — Honua-specific source type definitions extending MapLibre Style Spec v8.
 *
 * Defines three custom source types (`honua-feature-service`, `honua-map-service`,
 * `honua-ogc-features`) and a `HonuaStyleSpecification` that widens the MapLibre
 * style's `sources` map to accept them. Standard MapLibre layer types, paint/layout
 * properties, and expressions are used unchanged.
 *
 * These types are standalone (zero dependency on `maplibre-gl` or
 * `@maplibre/maplibre-gl-style-spec`), but structurally compatible — a
 * `HonuaStyleSpecification` can be narrowed to `StyleSpecification` by filtering
 * out Honua sources.
 *
 * @module
 */

// ── Honua source types ───────────────────────────────────────

/** Common fields shared by all Honua source specifications. */
export interface HonuaSourceBase {
  /** Full URL to the service endpoint. */
  url: string;
  /** Attribution string displayed on the map. */
  attribution?: string;
}

/**
 * A source backed by an Esri-compatible Feature Service layer.
 *
 * URL format: `https://host/rest/services/{serviceId}/FeatureServer/{layerId}`
 */
export interface HonuaFeatureServiceSourceSpecification extends HonuaSourceBase {
  type: "honua-feature-service";
  /** Server-side WHERE clause applied to all queries. */
  definitionExpression?: string;
  /** Fields to include in query responses. Defaults to all (`["*"]`). */
  outFields?: string[];
  /** Whether queries return geometry. Defaults to `true`. */
  returnGeometry?: boolean;
  /** Output spatial reference WKID (e.g. `4326`, `3857`). */
  outSR?: number;
}

/**
 * A source backed by an Esri-compatible Map Service (dynamic map export).
 *
 * URL format: `https://host/rest/services/{serviceId}/MapServer`
 */
export interface HonuaMapServiceSourceSpecification extends HonuaSourceBase {
  type: "honua-map-service";
  /** Comma-separated layer IDs to include (e.g. `"0,1,3"`). */
  layers?: string;
  /** Export DPI. Defaults to `96`. */
  dpi?: number;
  /** Image format. */
  format?: "png" | "png24" | "png32" | "jpg" | "gif";
  /** Whether the exported image has a transparent background. */
  transparent?: boolean;
}

/**
 * A source backed by an OGC API Features collection.
 *
 * URL format: `https://host/ogc/collections/{collectionId}` or
 * `https://host/ogc` (with `collectionId` specified separately).
 */
export interface HonuaOgcFeaturesSourceSpecification extends HonuaSourceBase {
  type: "honua-ogc-features";
  /** The OGC collection identifier. Required if the URL does not include it. */
  collectionId?: string;
  /** Coordinate reference system URI (e.g. `"http://www.opengis.net/def/crs/OGC/1.3/CRS84"`). */
  crs?: string;
  /** CQL2 filter expression applied server-side. */
  filter?: string;
  /** Maximum items per request page. */
  limit?: number;
}

/**
 * A source backed by a first-party WMS 1.3.0 service.
 *
 * URL format: `https://host/rest/services/{serviceId}/MapServer/WMS`.
 */
export interface HonuaWmsSourceSpecification extends HonuaSourceBase {
  type: "honua-wms";
  /** Service identifier, when not parseable from the URL. */
  serviceId?: string;
  /** Comma-separated layer names (the WMS `LAYERS=` value). */
  layers?: string;
  /** Comma-separated style names (the WMS `STYLES=` value). */
  styles?: string;
  /** Image MIME type. Defaults to `image/png`. */
  format?: string;
  /** Whether the rendered image should be transparent. */
  transparent?: boolean;
  /** CRS code. Defaults to `EPSG:3857`. */
  crs?: string;
}

/**
 * A source backed by a first-party WMTS 1.0.0 service.
 *
 * URL format: `https://host/rest/services/{serviceId}/MapServer/WMTS`.
 */
export interface HonuaWmtsSourceSpecification extends HonuaSourceBase {
  type: "honua-wmts";
  /** Service identifier, when not parseable from the URL. */
  serviceId?: string;
  /** Layer identifier. */
  layer?: string;
  /** Style identifier. Defaults to `default`. */
  style?: string;
  /** TileMatrixSet identifier. Defaults to `WebMercatorQuad`. */
  tileMatrixSet?: string;
  /** Image MIME type. Defaults to `image/png`. */
  format?: string;
}

/** Union of all Honua custom source types. */
export type HonuaSourceSpecification =
  | HonuaFeatureServiceSourceSpecification
  | HonuaMapServiceSourceSpecification
  | HonuaOgcFeaturesSourceSpecification
  | HonuaWmsSourceSpecification
  | HonuaWmtsSourceSpecification;

// ── Minimal layer type (MapLibre-compatible) ─────────────────

/** Minimal layer shape compatible with MapLibre Style Spec v8. */
export interface HonuaLayerSpecification {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  minzoom?: number;
  maxzoom?: number;
  metadata?: Record<string, unknown>;
}

// ── Style specification ──────────────────────────────────────

/**
 * A MapLibre Style Spec v8 document extended with Honua custom source types.
 *
 * Standard MapLibre sources (`vector`, `raster`, `geojson`, etc.) are accepted
 * alongside Honua sources. Layer definitions use standard MapLibre types.
 */
export interface HonuaStyleSpecification {
  version: 8;
  name?: string;
  metadata?: Record<string, unknown>;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  sources: Record<string, HonuaSourceSpecification | { type: string; [key: string]: unknown }>;
  layers: HonuaLayerSpecification[];
  sprite?: string | { id: string; url: string }[];
  glyphs?: string;
  transition?: { duration?: number; delay?: number };
}

// ── Type guards ──────────────────────────────────────────────

/** Test whether a source specification is any Honua custom type. */
export function isHonuaSource(source: { type: string }): source is HonuaSourceSpecification {
  return source.type.startsWith("honua-");
}

/** Test whether a source is a `honua-feature-service`. */
export function isFeatureServiceSource(source: { type: string }): source is HonuaFeatureServiceSourceSpecification {
  return source.type === "honua-feature-service";
}

/** Test whether a source is a `honua-map-service`. */
export function isMapServiceSource(source: { type: string }): source is HonuaMapServiceSourceSpecification {
  return source.type === "honua-map-service";
}

/** Test whether a source is a `honua-ogc-features`. */
export function isOgcFeaturesSource(source: { type: string }): source is HonuaOgcFeaturesSourceSpecification {
  return source.type === "honua-ogc-features";
}

/** Test whether a source is a `honua-wms`. */
export function isWmsSource(source: { type: string }): source is HonuaWmsSourceSpecification {
  return source.type === "honua-wms";
}

/** Test whether a source is a `honua-wmts`. */
export function isWmtsSource(source: { type: string }): source is HonuaWmtsSourceSpecification {
  return source.type === "honua-wmts";
}

// ── URL parsing ──────────────────────────────────────────────

// Feature Service and Map Service URL parsers are re-exported from
// esri-compat/url.ts (parseFeatureLayerUrl, parseMapServiceUrl) to avoid
// duplication. Only the OGC Features parser is defined here since it has
// no esri-compat equivalent.

/** Parsed components of an OGC Features URL. */
export interface ParsedOgcFeaturesUrl {
  baseUrl: string;
  collectionId: string | undefined;
}

/**
 * Parse an OGC Features URL into baseUrl and optional collectionId.
 *
 * Accepts URLs like:
 * - `https://gis.example.com/ogc/collections/admin-boundaries`
 * - `https://gis.example.com/ogc` (collectionId provided separately)
 */
export function parseOgcFeaturesUrl(url: string): ParsedOgcFeaturesUrl {
  const absoluteUrl = parseAbsoluteHttpUrl(url);
  const path = absoluteUrl ? absoluteUrl.pathname : stripQueryAndHash(url);
  const normalizedPath = trimTrailingSlashes(path);
  // Locate the first `/collections/` segment (case-insensitive) and split the
  // path into basePath + collectionId. Linear `indexOf` scanning replaces the
  // prior `/^(.*?)\/collections\/([^/?#]+)(?:\/.*)?$/i` regex, whose lazy
  // leading `.*?` plus trailing alternation could backtrack super-linearly.
  const collectionsToken = "/collections/";
  const markerIndex = normalizedPath.toLowerCase().indexOf(collectionsToken);
  if (markerIndex >= 0) {
    const afterMarker = normalizedPath.slice(markerIndex + collectionsToken.length);
    const nextSlash = afterMarker.indexOf("/");
    const collectionId = nextSlash >= 0 ? afterMarker.slice(0, nextSlash) : afterMarker;
    if (collectionId !== "") {
      const basePath = normalizeCollectionBasePath(normalizedPath.slice(0, markerIndex), normalizedPath);
      return {
        baseUrl: joinUrlParts(absoluteUrl?.origin, basePath),
        collectionId,
      };
    }
  }

  return {
    baseUrl: joinUrlParts(absoluteUrl?.origin, normalizedPath),
    collectionId: undefined,
  };
}

function parseAbsoluteHttpUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed;
    }
  } catch {
    // Relative URLs are handled by string parsing below.
  }
  return undefined;
}

function stripQueryAndHash(url: string): string {
  const hashIndex = url.indexOf("#");
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

function trimTrailingSlashes(path: string): string {
  if (path === "/") {
    return "/";
  }

  // Linear-time trailing-slash trim. Avoids the `/\/+$/` regex, whose
  // anchored quantifier can backtrack super-linearly on long slash runs.
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return end === path.length ? path : path.slice(0, end);
}

function normalizeCollectionBasePath(basePath: string, fullPath: string): string {
  const normalized = trimTrailingSlashes(basePath);
  if (normalized.length > 0) {
    return normalized;
  }
  return fullPath.startsWith("/") ? "/" : "";
}

function joinUrlParts(origin: string | undefined, path: string): string {
  if (!origin) {
    return path;
  }

  if (path.length === 0 || path === "/") {
    return origin;
  }

  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

// ── Style validation ─────────────────────────────────────────

/** A validation error found in a HonuaStyleSpecification. */
export interface StyleValidationError {
  path: string;
  message: string;
}

/**
 * Validate a HonuaStyleSpecification for structural correctness.
 *
 * Returns an empty array if the style is valid. Does not validate MapLibre
 * layer/expression semantics — use `@maplibre/maplibre-gl-style-spec` for that.
 */
export function validateHonuaStyle(style: unknown): StyleValidationError[] {
  const errors: StyleValidationError[] = [];

  if (typeof style !== "object" || style === null) {
    errors.push({ path: "", message: "Style must be a non-null object" });
    return errors;
  }

  const s = style as Record<string, unknown>;

  if (s.version !== 8) {
    errors.push({ path: "version", message: "Version must be 8" });
  }

  if (typeof s.sources !== "object" || s.sources === null || Array.isArray(s.sources)) {
    errors.push({ path: "sources", message: "Sources must be a non-null object" });
  } else {
    for (const [name, source] of Object.entries(s.sources as Record<string, unknown>)) {
      if (typeof source !== "object" || source === null) {
        errors.push({ path: `sources.${name}`, message: "Source must be a non-null object" });
        continue;
      }
      const src = source as Record<string, unknown>;
      if (typeof src.type !== "string") {
        errors.push({ path: `sources.${name}.type`, message: "Source type must be a string" });
        continue;
      }
      if (isHonuaSource(src as { type: string })) {
        if (typeof (src as { url?: unknown }).url !== "string") {
          errors.push({ path: `sources.${name}.url`, message: "Honua source must have a string url" });
        }
      }
    }
  }

  if (!Array.isArray(s.layers)) {
    errors.push({ path: "layers", message: "Layers must be an array" });
  } else {
    for (let i = 0; i < (s.layers as unknown[]).length; i++) {
      const layer = (s.layers as unknown[])[i];
      if (typeof layer !== "object" || layer === null) {
        errors.push({ path: `layers[${i}]`, message: "Layer must be a non-null object" });
        continue;
      }
      const l = layer as Record<string, unknown>;
      if (typeof l.id !== "string") {
        errors.push({ path: `layers[${i}].id`, message: "Layer must have a string id" });
      }
      if (typeof l.type !== "string") {
        errors.push({ path: `layers[${i}].type`, message: "Layer must have a string type" });
      }
    }
  }

  return errors;
}
