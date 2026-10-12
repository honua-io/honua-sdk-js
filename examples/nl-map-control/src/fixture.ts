import type { FeatureCollection } from "geojson";
import type { ExecutableCrsBinding, LogicalField } from "../../../src/contract/schema.js";
import { createSourceSchemaV2 } from "../../../src/source-schema.js";

export const FIXTURE_VERSION = "ask-map-incidents-v1";
export const CRS: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "EPSG",
    code: "3857",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "easting", direction: "east", unit: "metre" },
        { name: "northing", direction: "north", unit: "metre" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "easting", direction: "east", unit: "metre" },
      { name: "northing", direction: "north", unit: "metre" },
    ],
  },
  provenance: { method: "declared" },
};
export const ORIGIN = [-13618288, 6046761] as const;
/** Exact projected-metre offsets independently specified for distance/boundary oracles. */
export const INCIDENTS = [
  { id: 1, status: "open", kind: "fire", x: 0, y: 0 },
  { id: 2, status: "open", kind: "medical", x: 300, y: 400 },
  { id: 3, status: "closed", kind: "fire", x: 100, y: 100 },
  { id: 4, status: "open", kind: "hazmat", x: 501, y: 0 },
  { id: 5, status: "open", kind: "medical", x: -499, y: 0 },
  { id: 6, status: "closed", kind: "rescue", x: -1000, y: -1000 },
] as const;
export function geographic(x: number, y: number): [number, number] {
  return [((x / 6378137) * 180) / Math.PI, ((2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180) / Math.PI];
}
export function projected(lng: number, lat: number): [number, number] {
  return [((lng * Math.PI) / 180) * 6378137, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 6378137];
}
function field(name: string, type: LogicalField["type"], roles: LogicalField["roles"] = []): LogicalField {
  return {
    name,
    path: [name],
    type,
    nullability: "non-nullable",
    mutability: "read-only",
    roles,
    domain: { state: "none", reason: type.kind === "geometry" ? "not-applicable" : "unconstrained" },
    constraints: { state: "none" },
    native: [],
  };
}
export const SCHEMA = createSourceSchemaV2({
  fields: [
    field("id", { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }, ["primary-key", "feature-id"]),
    field("status", { kind: "string" }),
    field("kind", { kind: "string" }),
    field("shape", { kind: "geometry" }, ["geometry"]),
  ],
  key: { state: "known", fields: ["id"] },
  geometry: {
    state: "known",
    fields: [
      { field: "shape", geometryTypes: { state: "known", type: "Point" }, crs: CRS, layout: "xy", allowsEmpty: false },
    ],
    primaryField: { state: "known", field: "shape" },
  },
  temporal: { state: "none" },
  openContent: "closed",
  provenance: [{ method: "declared", protocol: "geoparquet", source: FIXTURE_VERSION }],
});
export function incidentsGeoJson(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: INCIDENTS.map((row) => ({
      type: "Feature",
      id: row.id,
      properties: { id: row.id, status: row.status, kind: row.kind },
      geometry: { type: "Point", coordinates: geographic(ORIGIN[0] + row.x, ORIGIN[1] + row.y) },
    })),
  };
}
