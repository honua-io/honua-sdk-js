/**
 * Shared fixture for comparing the canonical filter lowering
 * (`src/contract/query-filter.ts`) with the schema-verified planner compilers
 * (`src/query-planner/*`).
 *
 * Mirrors the logical schema of `conformance/semantic-query/v1/corpus.json` so
 * the equivalence ledger and the corpus suite reason about the same source.
 */

import type { ExecutableCrsBinding, LogicalField, SourceSchemaV2 } from "../src/contract/schema.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

export const epsg4326: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "EPSG",
    code: "4326",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "latitude", direction: "north", unit: "degree" },
        { name: "longitude", direction: "east", unit: "degree" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "longitude", direction: "east", unit: "degree" },
      { name: "latitude", direction: "north", unit: "degree" },
    ],
  },
  provenance: { method: "declared" },
};

/** Schema shared by both lanes: id, status, score, observedAt, shape. */
export function semanticLaneSchema(): SourceSchemaV2 {
  const field = (
    name: string,
    type: LogicalField["type"],
    options: { readonly nullable?: boolean; readonly roles?: LogicalField["roles"] } = {},
  ): LogicalField => ({
    name,
    path: [name],
    type,
    nullability: options.nullable ? "nullable" : "non-nullable",
    mutability: "read-only",
    roles: options.roles ?? [],
    domain: { state: "none", reason: type.kind === "geometry" ? "not-applicable" : "unconstrained" },
    constraints: { state: "none" },
    native: [
      { protocol: "wfs", name: `inc:${name}`, path: [`inc:${name}`] },
      ...(name === "observedAt"
        ? [
            {
              protocol: "geoservices-feature-service" as const,
              name: "esriFieldTypeDate",
              path: ["FeatureServer", "0", name],
            },
          ]
        : []),
      ...(name === "shape" ? [{ protocol: "odata" as const, name: "Edm.GeographyPoint", path: [name] }] : []),
    ],
  });

  return createSourceSchemaV2({
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        { roles: ["primary-key", "feature-id"] },
      ),
      field("status", { kind: "string" }),
      field("score", { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }),
      field("optionalNote", { kind: "string" }, { nullable: true }),
      field("observedAt", { kind: "timestamp", unit: "second", timezone: "utc" }, { roles: ["time-instant"] }),
      field("shape", { kind: "geometry" }, { roles: ["geometry"] }),
    ],
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes: { state: "known", type: "Point" },
          crs: epsg4326,
          layout: "xy",
          allowsEmpty: false,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "instant", field: "observedAt" },
    openContent: "closed",
    provenance: [{ method: "declared", protocol: "ogc-features", source: "test/semantic-lane-fixture.ts" }],
  });
}

/** GeoServices identity advertising the full reviewed relationship set. */
export const geoServicesSemanticSource = {
  protocol: "geoservices-feature-service",
  serviceId: "lane-equivalence",
  layerId: 0,
  supportedSpatialRelationships: [
    "esriSpatialRelIntersects",
    "esriSpatialRelContains",
    "esriSpatialRelWithin",
    "esriSpatialRelCrosses",
    "esriSpatialRelTouches",
    "esriSpatialRelOverlaps",
  ],
  supportsAdvancedQueries: true,
  supportsPagination: true,
  supportsStatistics: true,
  supportsPaginationOnAggregatedQueries: true,
} as const;
