/**
 * `@honua/geometry` — curated, tree-shakeable client-side geometry operations
 * for the Honua SDK.
 *
 * This subpath (`@honua/sdk-js/geometry`, split-packaged as `@honua/geometry`)
 * wraps the individual `@turf/*` packages and `proj4`, typed against the SDK's
 * own GeoJSON contract. Importing a single op only pulls that op's turf backing
 * into a consumer bundle; the core SDK never imports this module, so core-only
 * consumers never pay for turf/proj4.
 *
 * @module
 */

export {
  area,
  bbox,
  booleanContains,
  booleanIntersects,
  booleanWithin,
  buffer,
  centroid,
  convex,
  difference,
  intersect,
  length,
  nearestPoint,
  simplify,
  union,
} from "./ops.js";

export { defineProjection, normalizeCrs, project, toWebMercator, toWgs84 } from "./project.js";

export { esriFeatureToGeoJson, esriToGeoJson, geoJsonToEsri } from "./convert.js";

export type {
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoJsonGeometry,
  GeoJsonLineString,
  GeoJsonMultiLineString,
  GeoJsonMultiPoint,
  GeoJsonMultiPolygon,
  GeoJsonPoint,
  GeoJsonPolygon,
  GeometryInput,
  LinearUnit,
} from "./types.js";
