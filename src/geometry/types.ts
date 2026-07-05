/**
 * Public GeoJSON and unit types for `@honua/geometry`.
 *
 * The geometry operations are typed against the SDK's own GeoJSON contract
 * (`src/expr/expression.ts` geometry union + `src/core/types.ts`
 * {@link GeoJsonFeature}) rather than pulling in the `@types/geojson`
 * declarations as a public surface. Internally the turf wrappers bridge to the
 * `geojson` types, but consumers only ever see Honua's own types.
 *
 * @module
 */

export type {
  GeoJsonGeometry,
  GeoJsonPoint,
  GeoJsonMultiPoint,
  GeoJsonLineString,
  GeoJsonMultiLineString,
  GeoJsonPolygon,
  GeoJsonMultiPolygon,
} from "../expr/expression.js";
export type { GeoJsonFeature } from "../core/types.js";

import type { GeoJsonFeature } from "../core/types.js";
import type { GeoJsonGeometry } from "../expr/expression.js";

/**
 * A GeoJSON `FeatureCollection` typed against the SDK feature type. The SDK
 * contract intentionally ships only `GeoJsonFeature`; the geometry package adds
 * the collection wrapper it needs for union/nearest-point style operations.
 */
export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

/**
 * Anything the geometry ops accept as an input shape: a bare geometry, a
 * `Feature`, or a `FeatureCollection`. Operations always return the SDK
 * geometry (or feature) types.
 */
export type GeometryInput = GeoJsonGeometry | GeoJsonFeature | GeoJsonFeatureCollection;

/**
 * Linear distance units understood by {@link buffer} and {@link length}. This is
 * the subset of turf's unit vocabulary that has an unambiguous geodesic meaning.
 */
export type LinearUnit = "meters" | "kilometers" | "miles" | "feet" | "yards" | "nauticalmiles";
