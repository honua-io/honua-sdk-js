// Generated from schemas/honua-map-package.v1.json. Do not edit.
// Run "npm run map-package-schema:generate" after changing the schema.

/** `$id` of the schema this projection was generated from. */
export const HONUA_MAP_PACKAGE_SCHEMA_ID = "https://honua.io/schemas/honua-map-package.v1.json" as const;

/** sha256 of the schema bytes, so a drifted projection is identifiable. */
export const HONUA_MAP_PACKAGE_SCHEMA_SHA256 = "7d34a2b27b25135ad09795a66959596ce3b8593298d3a7e28bb5142bea597ec9" as const;

/** Every `SourceBinding.protocol` value the schema admits. */
export const HONUA_MAP_PACKAGE_SCHEMA_PROTOCOLS = ["geoservices_feature_service","geoservices_map_service","ogc_features","ogc_maps","ogc_tiles","wfs","wms","wmts","odata","vector_tile","raster_tile","pmtiles","workspace_artifact"] as const;

/** Every `status` value the schema admits (server-produced; see the schema). */
export const HONUA_MAP_PACKAGE_SCHEMA_STATUSES = ["Draft","Composing","Ready","Failed","Expired"] as const;

/** Top-level properties the schema requires. */
export const HONUA_MAP_PACKAGE_SCHEMA_REQUIRED = ["mapPackageId","format","sourceBindings","mapSpec"] as const;
