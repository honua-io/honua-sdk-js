import { HonuaGeometryError } from "./errors.js";
import type { EsriGeometryType, EsriSpatialRel, HonuaSpatialReference } from "./types.js";

/**
 * A spatial filter fragment that can be spread into a `QueryFeaturesRequest`
 * or applied via `QueryBuilder.geometry()` / `.geometryType()` / `.spatialRel()`.
 */
export interface SpatialFilter {
  geometry: Record<string, unknown>;
  geometryType: EsriGeometryType;
  spatialRel?: EsriSpatialRel;
}

/**
 * Create an envelope (bounding box) spatial filter.
 *
 * @example
 * ```ts
 * const req: QueryFeaturesRequest = {
 *   serviceId: "svc", layerId: 0,
 *   ...envelope(-118.5, 33.7, -117.5, 34.2),
 * };
 * ```
 */
export function envelope(
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
  spatialReference?: HonuaSpatialReference,
): SpatialFilter {
  const geometry: Record<string, unknown> = { xmin, ymin, xmax, ymax };
  if (spatialReference) geometry.spatialReference = spatialReference;
  return {
    geometry,
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/**
 * Create a point spatial filter.
 *
 * @example
 * ```ts
 * const req: QueryFeaturesRequest = {
 *   serviceId: "svc", layerId: 0,
 *   ...point(-118.24, 34.05),
 * };
 * ```
 */
export function point(x: number, y: number, spatialReference?: HonuaSpatialReference): SpatialFilter {
  const geometry: Record<string, unknown> = { x, y };
  if (spatialReference) geometry.spatialReference = spatialReference;
  return {
    geometry,
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/**
 * Create a polygon spatial filter from an array of rings.
 *
 * @example
 * ```ts
 * const req: QueryFeaturesRequest = {
 *   serviceId: "svc", layerId: 0,
 *   ...polygon([[[-118, 34], [-117, 34], [-117, 35], [-118, 35], [-118, 34]]]),
 * };
 * ```
 */
export function polygon(rings: number[][][], spatialReference?: HonuaSpatialReference): SpatialFilter {
  const geometry: Record<string, unknown> = { rings };
  if (spatialReference) geometry.spatialReference = spatialReference;
  return {
    geometry,
    geometryType: "esriGeometryPolygon",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/**
 * Create an axis-aligned envelope spatial filter centered on a point.
 *
 * This is a planar expansion in the input coordinate system's units. It is an
 * envelope approximation, not a circular, geodesic, or topological geometry
 * buffer. Use `buffer` from `@honua/sdk-js/geometry` when a true geometry
 * buffer is required.
 *
 * @param x - Center x coordinate
 * @param y - Center y coordinate
 * @param distance - Half-width of the envelope in coordinate units
 * @param spatialReference - Optional spatial reference
 *
 * @example
 * ```ts
 * // 0.5-degree bounding box around a point
 * const req: QueryFeaturesRequest = {
 *   serviceId: "svc", layerId: 0,
 *   ...bufferEnvelope(-118.24, 34.05, 0.5),
 * };
 * ```
 */
export function bufferEnvelope(
  x: number,
  y: number,
  distance: number,
  spatialReference?: HonuaSpatialReference,
): SpatialFilter {
  if (![x, y, distance].every(isFiniteNumber) || distance < 0) {
    throw new HonuaGeometryError(
      "malformed-geometry",
      "Cannot create a buffer envelope: x, y, and distance must be finite numbers and distance must be non-negative",
      {
        operation: "buffer-envelope",
        reason: "invalid-coordinate-or-distance",
      },
    );
  }
  return envelope(x - distance, y - distance, x + distance, y + distance, spatialReference);
}

/**
 * Wrap an existing geometry with `esriSpatialRelIntersects`.
 *
 * @example
 * ```ts
 * const filter = spatialIntersects({ xmin: -180, ymin: -90, xmax: 180, ymax: 90 });
 * ```
 */
export function spatialIntersects(geometry: Record<string, unknown>): SpatialFilter {
  return {
    geometry,
    geometryType: detectGeometryType(geometry),
    spatialRel: "esriSpatialRelIntersects",
  };
}

/**
 * Wrap an existing geometry with `esriSpatialRelContains`.
 *
 * @example
 * ```ts
 * const filter = spatialContains({ rings: [[[-118, 34], [-117, 34], [-117, 35], [-118, 35], [-118, 34]]] });
 * ```
 */
export function spatialContains(geometry: Record<string, unknown>): SpatialFilter {
  return {
    geometry,
    geometryType: detectGeometryType(geometry),
    spatialRel: "esriSpatialRelContains",
  };
}

/**
 * Wrap an existing geometry with `esriSpatialRelWithin`.
 *
 * @example
 * ```ts
 * const filter = spatialWithin({ rings: [[[-118, 34], [-117, 34], [-117, 35], [-118, 35], [-118, 34]]] });
 * ```
 */
export function spatialWithin(geometry: Record<string, unknown>): SpatialFilter {
  return {
    geometry,
    geometryType: detectGeometryType(geometry),
    spatialRel: "esriSpatialRelWithin",
  };
}

/**
 * Detect the Esri geometry type from a plain geometry object by inspecting
 * its shape (duck-typing).
 *
 * @internal
 */
function detectGeometryType(geometry: unknown): EsriGeometryType {
  if (!isGeometryRecord(geometry)) {
    throw new HonuaGeometryError(
      "malformed-geometry",
      "Unable to classify geometry: geometry must be a non-null object",
      {
        operation: "classify",
        reason: "geometry-must-be-object",
        keys: [],
      },
    );
  }
  const keys = Object.keys(geometry).sort();
  const candidates = [
    hasAnyOwn(geometry, ["xmin", "ymin", "xmax", "ymax"]) ? "envelope" : undefined,
    hasOwn(geometry, "rings") ? "polygon" : undefined,
    hasOwn(geometry, "paths") ? "polyline" : undefined,
    hasOwn(geometry, "points") ? "multipoint" : undefined,
    hasAnyOwn(geometry, ["x", "y"]) ? "point" : undefined,
  ].filter((candidate): candidate is GeometryShape => candidate !== undefined);

  if (candidates.length === 0) {
    throw geometryClassificationError("unknown-geometry", "no supported Esri geometry shape was found", keys);
  }
  if (candidates.length > 1) {
    throw geometryClassificationError(
      "malformed-geometry",
      `geometry contains conflicting shape discriminators: ${candidates.join(", ")}`,
      keys,
    );
  }

  const candidate = candidates[0];
  switch (candidate) {
    case "envelope":
      assertEnvelope(geometry, keys);
      return "esriGeometryEnvelope";
    case "polygon":
      assertParts(geometry.rings, "rings", "polygon", 4, true, keys);
      return "esriGeometryPolygon";
    case "polyline":
      assertParts(geometry.paths, "paths", "polyline", 2, false, keys);
      return "esriGeometryPolyline";
    case "multipoint":
      assertPositions(geometry.points, "points", "multipoint", keys);
      return "esriGeometryMultipoint";
    case "point":
      assertPoint(geometry, keys);
      return "esriGeometryPoint";
  }
}

type GeometryShape = "envelope" | "polygon" | "polyline" | "multipoint" | "point";

function isGeometryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasAnyOwn(value: object, keys: readonly string[]): boolean {
  return keys.some((key) => hasOwn(value, key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPosition(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length >= 2 && value.every(isFiniteNumber);
}

function assertPoint(geometry: Record<string, unknown>, keys: readonly string[]): void {
  if (!isFiniteNumber(geometry.x) || !isFiniteNumber(geometry.y)) {
    throw geometryClassificationError(
      "malformed-geometry",
      "point requires finite numeric x and y coordinates",
      keys,
      "point",
    );
  }
}

function assertEnvelope(geometry: Record<string, unknown>, keys: readonly string[]): void {
  const { xmin, ymin, xmax, ymax } = geometry;
  if (![xmin, ymin, xmax, ymax].every(isFiniteNumber)) {
    throw geometryClassificationError(
      "malformed-geometry",
      "envelope requires finite numeric xmin, ymin, xmax, and ymax coordinates",
      keys,
      "envelope",
    );
  }
  if ((xmin as number) > (xmax as number) || (ymin as number) > (ymax as number)) {
    throw geometryClassificationError(
      "malformed-geometry",
      "envelope minimum coordinates must not exceed maximum coordinates",
      keys,
      "envelope",
    );
  }
}

function assertPositions(
  value: unknown,
  property: string,
  shape: GeometryShape,
  keys: readonly string[],
): asserts value is readonly (readonly number[])[] {
  if (!Array.isArray(value) || !value.every(isPosition)) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} ${property} must be an array of finite coordinate positions`,
      keys,
      shape,
    );
  }
}

function assertParts(
  value: unknown,
  property: string,
  shape: GeometryShape,
  minimumPositions: number,
  requireClosure: boolean,
  keys: readonly string[],
): void {
  if (!Array.isArray(value)) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} ${property} must be an array of coordinate arrays`,
      keys,
      shape,
    );
  }
  for (const part of value) {
    if (!Array.isArray(part) || !part.every(isPosition)) {
      throw geometryClassificationError(
        "malformed-geometry",
        `${shape} ${property} must contain only finite coordinate positions`,
        keys,
        shape,
      );
    }
    // Empty parts preserve an explicitly empty geometry. Non-empty parts must
    // be structurally usable rather than merely carrying a recognized key.
    if (part.length > 0 && part.length < minimumPositions) {
      throw geometryClassificationError(
        "malformed-geometry",
        `${shape} ${property} parts require at least ${minimumPositions} positions when non-empty`,
        keys,
        shape,
      );
    }
    if (requireClosure && part.length > 0) {
      const first = part[0];
      const last = part[part.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        throw geometryClassificationError(
          "malformed-geometry",
          `${shape} ${property} parts must be closed`,
          keys,
          shape,
        );
      }
    }
  }
}

function geometryClassificationError(
  code: "unknown-geometry" | "malformed-geometry",
  reason: string,
  keys: readonly string[],
  shape?: GeometryShape,
): HonuaGeometryError {
  return new HonuaGeometryError(code, `Unable to classify geometry: ${reason}`, {
    operation: "classify",
    reason,
    keys,
    ...(shape === undefined ? {} : { shape }),
  });
}
