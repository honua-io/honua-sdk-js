/**
 * Esri-JSON ↔ GeoJSON conversion for the geometry package.
 *
 * These are re-exports of the single canonical converter utility in
 * `src/core/esri-geojson.ts` (heritage of issue #264) — the geometry package
 * deliberately does not fork its own Esri conversion logic. `esriToGeoJson` /
 * `geoJsonToEsri` are the ergonomic aliases used by `@honua/geometry` and the
 * `geometryEngine` compat shim.
 *
 * @module
 */

export {
  esriGeometryToGeoJSON as esriToGeoJson,
  esriFeatureToGeoJSON as esriFeatureToGeoJson,
  geoJsonToEsriGeometry as geoJsonToEsri,
} from "../core/esri-geojson.js";
