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
  const bounds = [x - distance, y - distance, x + distance, y + distance] as const;
  if (!bounds.every(isFiniteNumber)) {
    throw new HonuaGeometryError(
      "malformed-geometry",
      "Cannot create a buffer envelope: computed bounds must be finite",
      {
        operation: "buffer-envelope",
        reason: "computed-bounds-not-finite",
      },
    );
  }
  return envelope(...bounds, spatialReference);
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
 * @see https://developers.arcgis.com/rest/services-reference/enterprise/geometry-objects/
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
      assertParts(geometry, "rings", "polygon", 4, true, keys);
      return "esriGeometryPolygon";
    case "polyline":
      assertParts(geometry, "paths", "polyline", 2, false, keys);
      return "esriGeometryPolyline";
    case "multipoint":
      assertPositions(geometry, keys);
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

function assertPoint(geometry: Record<string, unknown>, keys: readonly string[]): void {
  if (hasOwn(geometry, "x") && geometry.x === null) {
    assertEmptyMembers(geometry, ["y", "z", "m", "id"], "point", keys);
    return;
  }
  if (!isFiniteNumber(geometry.x) || !isFiniteNumber(geometry.y)) {
    throw geometryClassificationError(
      "malformed-geometry",
      "point requires finite numeric x and y coordinates",
      keys,
      "point",
    );
  }
  assertOptionalFiniteMember(geometry, "z", "point", keys);
  assertOptionalFiniteMember(geometry, "m", "point", keys, true);
  assertOptionalFiniteMember(geometry, "id", "point", keys);
}

function assertEnvelope(geometry: Record<string, unknown>, keys: readonly string[]): void {
  if (hasOwn(geometry, "xmin") && geometry.xmin === null) {
    assertEmptyMembers(
      geometry,
      ["ymin", "xmax", "ymax", "zmin", "zmax", "mmin", "mmax", "idmin", "idmax"],
      "envelope",
      keys,
    );
    return;
  }
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
  assertOptionalBounds(geometry, "zmin", "zmax", "envelope", keys);
  assertOptionalBounds(geometry, "mmin", "mmax", "envelope", keys);
  assertOptionalBounds(geometry, "idmin", "idmax", "envelope", keys);
}

function assertPositions(geometry: Record<string, unknown>, keys: readonly string[]): void {
  const value = geometry.points;
  if (!Array.isArray(value)) {
    throw geometryClassificationError(
      "malformed-geometry",
      "multipoint points must be an array of coordinate positions",
      keys,
      "multipoint",
    );
  }
  const dimensions = geometryDimensions(geometry, "multipoint", keys);
  for (const position of value) assertPosition(position, dimensions, "multipoint", keys);
}

function assertParts(
  geometry: Record<string, unknown>,
  property: string,
  shape: GeometryShape,
  minimumPositions: number,
  requireClosure: boolean,
  keys: readonly string[],
): void {
  const value = geometry[property];
  if (!Array.isArray(value)) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} ${property} must be an array of coordinate arrays`,
      keys,
      shape,
    );
  }
  const dimensions = geometryDimensions(geometry, shape, keys);
  for (const part of value) {
    if (!Array.isArray(part)) {
      throw geometryClassificationError(
        "malformed-geometry",
        `${shape} ${property} must contain coordinate arrays`,
        keys,
        shape,
      );
    }
    // The REST empty sentinel is an empty outer paths/rings array. Empty inner
    // parts are not canonical and cannot be mixed with populated parts.
    if (part.length < minimumPositions) {
      throw geometryClassificationError(
        "malformed-geometry",
        `${shape} ${property} parts require at least ${minimumPositions} positions`,
        keys,
        shape,
      );
    }
    for (const position of part) assertPosition(position, dimensions, shape, keys);
    if (requireClosure) {
      const first = part[0] as readonly unknown[];
      const last = part[part.length - 1] as readonly unknown[];
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

interface GeometryDimensions {
  readonly hasZ: boolean;
  readonly hasM: boolean;
}

function geometryDimensions(
  geometry: Record<string, unknown>,
  shape: GeometryShape,
  keys: readonly string[],
): GeometryDimensions {
  return {
    hasZ: geometryBooleanFlag(geometry, "hasZ", shape, keys),
    hasM: geometryBooleanFlag(geometry, "hasM", shape, keys),
  };
}

function geometryBooleanFlag(
  geometry: Record<string, unknown>,
  property: "hasZ" | "hasM",
  shape: GeometryShape,
  keys: readonly string[],
): boolean {
  if (!hasOwn(geometry, property)) return false;
  if (typeof geometry[property] !== "boolean") {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} ${property} must be a boolean when present`,
      keys,
      shape,
    );
  }
  return geometry[property];
}

function assertPosition(
  value: unknown,
  dimensions: GeometryDimensions,
  shape: GeometryShape,
  keys: readonly string[],
): asserts value is readonly unknown[] {
  const minimumArity = dimensions.hasZ ? 3 : 2;
  const maximumArity = minimumArity + (dimensions.hasM ? 1 : 0);
  if (!Array.isArray(value) || value.length < minimumArity || value.length > maximumArity || value.length > 4) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} positions must match declared hasZ/hasM dimensions and contain at most four ordinates`,
      keys,
      shape,
    );
  }
  if (!isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} positions require finite numeric x and y ordinates`,
      keys,
      shape,
    );
  }
  if (dimensions.hasZ && !isFiniteNumber(value[2])) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} positions require a finite z ordinate when hasZ is true`,
      keys,
      shape,
    );
  }
  if (dimensions.hasM && value.length === maximumArity) {
    const measure = value[maximumArity - 1];
    if (measure !== null && !isFiniteNumber(measure)) {
      throw geometryClassificationError(
        "malformed-geometry",
        `${shape} m ordinates must be finite numbers, null, or omitted`,
        keys,
        shape,
      );
    }
  }
}

function assertEmptyMembers(
  geometry: Record<string, unknown>,
  members: readonly string[],
  shape: GeometryShape,
  keys: readonly string[],
): void {
  const contradictory = members.filter((member) => hasOwn(geometry, member) && geometry[member] !== null);
  if (contradictory.length > 0) {
    throw geometryClassificationError(
      "malformed-geometry",
      `${shape} empty sentinel conflicts with non-null members: ${contradictory.join(", ")}`,
      keys,
      shape,
    );
  }
}

function assertOptionalFiniteMember(
  geometry: Record<string, unknown>,
  property: string,
  shape: GeometryShape,
  keys: readonly string[],
  allowNull = false,
): void {
  if (!hasOwn(geometry, property)) return;
  const value = geometry[property];
  if ((allowNull && value === null) || isFiniteNumber(value)) return;
  const expectation = allowNull ? "a finite number or null" : "a finite number";
  throw geometryClassificationError(
    "malformed-geometry",
    `${shape} ${property} must be ${expectation} when present`,
    keys,
    shape,
  );
}

function assertOptionalBounds(
  geometry: Record<string, unknown>,
  minimumProperty: string,
  maximumProperty: string,
  shape: GeometryShape,
  keys: readonly string[],
): void {
  const hasMinimum = hasOwn(geometry, minimumProperty);
  const hasMaximum = hasOwn(geometry, maximumProperty);
  if (!hasMinimum && !hasMaximum) return;
  const minimum = geometry[minimumProperty];
  const maximum = geometry[maximumProperty];
  if (!hasMinimum || !hasMaximum || !isFiniteNumber(minimum) || !isFiniteNumber(maximum) || minimum > maximum) {
    throw geometryClassificationError(
      "malformed-geometry",
      `envelope ${minimumProperty}/${maximumProperty} must be a complete ordered pair of finite numbers`,
      keys,
      shape,
    );
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
