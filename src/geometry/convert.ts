/**
 * GeoServices REST geometry ↔ GeoJSON conversion for the geometry package.
 *
 * These are re-exports of the single canonical converter utility in
 * `src/core/geoservices-geojson.ts` — the geometry package
 * deliberately does not fork its own conversion logic. `geoServicesToGeoJson` /
 * `geoJsonToGeoServices` are the ergonomic aliases used by `@honua/geometry` and the
 * `geometryEngine` compat shim.
 *
 * @module
 */

export {
  geoServicesGeometryToGeoJSON,
  geoServicesGeometryToGeoJSON as geoServicesToGeoJson,
  geoServicesFeatureToGeoJSON as geoServicesFeatureToGeoJson,
  geoJsonToGeoServices,
} from "../core/geoservices-geojson.js";
