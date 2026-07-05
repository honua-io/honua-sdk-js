/**
 * Internal bridge between the SDK's GeoJSON contract types and the `geojson`
 * declarations that the `@turf/*` packages are typed against. The two are
 * structurally identical for the primitive geometry types the geometry package
 * supports, so the conversions are erased casts — kept in one place so the ops
 * modules stay free of scattered `as unknown as` noise.
 *
 * @internal
 * @module
 */

import type {
  Feature as TurfFeature,
  FeatureCollection as TurfFeatureCollection,
  Geometry as TurfGeometry,
} from "geojson";

import type { GeoJsonFeature } from "../core/types.js";
import type { GeoJsonGeometry } from "../expr/expression.js";
import type { GeometryInput } from "./types.js";

/** Narrow an input to its bare geometry, unwrapping a `Feature` if needed. */
export function inputToGeometry(input: GeometryInput): GeoJsonGeometry {
  if (input.type === "Feature") {
    const geometry = (input as GeoJsonFeature).geometry;
    if (!geometry) {
      throw new TypeError("@honua/geometry: feature has no geometry");
    }
    return geometry;
  }
  if (input.type === "FeatureCollection") {
    throw new TypeError("@honua/geometry: expected a geometry or Feature, received a FeatureCollection");
  }
  return input as GeoJsonGeometry;
}

/** Present an SDK geometry to turf as a `geojson` geometry. */
export function toTurfGeometry(geometry: GeoJsonGeometry): TurfGeometry {
  return geometry as unknown as TurfGeometry;
}

/** Present an SDK geometry input to turf as a `geojson` value. */
export function toTurfInput(input: GeometryInput): TurfFeature | TurfFeatureCollection | TurfGeometry {
  return input as unknown as TurfFeature | TurfFeatureCollection | TurfGeometry;
}

/** Convert a turf geometry back into an SDK geometry. */
export function fromTurfGeometry(geometry: TurfGeometry): GeoJsonGeometry {
  return geometry as unknown as GeoJsonGeometry;
}

/** Convert a turf feature back into an SDK feature. */
export function fromTurfFeature(feature: TurfFeature): GeoJsonFeature {
  return feature as unknown as GeoJsonFeature;
}
