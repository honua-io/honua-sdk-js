import type {
  AxisOrder,
  CapabilityProfile,
  CrsBinding,
  ExecutableCrsBinding,
  MetadataProvenance,
  ResolvedCrsDefinition,
  SchemaIdentityFor,
  SchemaState,
  SourceDescriptorV2,
  SourceProtocol,
  SpatialExtent,
  TemporalExtent,
} from "./contracts.js";

export const longitudeLatitude: AxisOrder = {
  state: "known",
  source: "encoding",
  axes: [
    { name: "geodetic longitude", abbreviation: "Lon", direction: "east", unit: "degree" },
    { name: "geodetic latitude", abbreviation: "Lat", direction: "north", unit: "degree" },
  ],
};

export const longitudeLatitudeDefinition: AxisOrder = {
  ...longitudeLatitude,
  source: "crs-definition",
};

export const crs84 = {
  definition: {
    kind: "authority",
    authority: "OGC",
    code: "CRS84",
    version: "1.3",
    uri: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
    definitionAxisOrder: longitudeLatitudeDefinition,
  },
  coordinateOrder: longitudeLatitude,
  provenance: { method: "standard-default" },
} as const satisfies CrsBinding;

export const ogcUriCrs = {
  kind: "uri",
  uri: "https://schemas.example.test/crs/hawaii-geographic-v1",
  name: "Hawaii geographic CRS advertised by OGC API",
  definitionAxisOrder: longitudeLatitudeDefinition,
} as const satisfies ResolvedCrsDefinition;

export const geoParquetProjjsonCrs = {
  kind: "projjson",
  name: "WGS 84",
  projjson: {
    $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
    type: "GeographicCRS",
    name: "WGS 84",
    datum_ensemble: { name: "World Geodetic System 1984 ensemble" },
    coordinate_system: {
      subtype: "ellipsoidal",
      axis: [
        { name: "Geodetic latitude", abbreviation: "Lat", direction: "north", unit: "degree" },
        { name: "Geodetic longitude", abbreviation: "Lon", direction: "east", unit: "degree" },
      ],
    },
  },
  definitionAxisOrder: {
    state: "known",
    source: "crs-definition",
    axes: [
      { name: "geodetic latitude", abbreviation: "Lat", direction: "north", unit: "degree" },
      { name: "geodetic longitude", abbreviation: "Lon", direction: "east", unit: "degree" },
    ],
  },
} as const satisfies ResolvedCrsDefinition;

export const ogcUriCrsBinding = {
  definition: ogcUriCrs,
  coordinateOrder: longitudeLatitude,
  provenance: { method: "metadata" },
} as const satisfies ExecutableCrsBinding;

export const geoParquetProjjsonBinding = {
  definition: geoParquetProjjsonCrs,
  coordinateOrder: longitudeLatitude,
  provenance: { method: "metadata" },
} as const satisfies ExecutableCrsBinding;

export const provenance: MetadataProvenance = {
  method: "observed",
  protocol: "ogc-features",
  source: "https://example.test/ogc/collections/parcels",
  observedAt: "2026-07-13T12:00:00Z",
  validator: { kind: "etag", value: '"metadata-v4"' },
};

export const unavailableSchema = {
  state: "unavailable",
  reason: "not-requested",
  provenance: [{ ...provenance, method: "unavailable" }],
} as const satisfies SchemaState;

export const primarySpatialSchema = {
  state: "known",
  value: {
    kind: "honua.source-schema",
    version: "2.0",
    fingerprint: "sha256:schema-primary-spatial",
    fields: [
      {
        name: "geometry",
        path: ["geometry"],
        type: { kind: "geometry" },
        nullability: "nullable",
        mutability: "read-only",
        roles: ["geometry"],
        domain: { state: "none", reason: "not-applicable" },
        constraints: { state: "none" },
        native: [],
      },
      {
        name: "centroid",
        path: ["centroid"],
        type: { kind: "geometry" },
        nullability: "nullable",
        mutability: "read-only",
        roles: ["geometry"],
        domain: { state: "none", reason: "not-applicable" },
        constraints: { state: "none" },
        native: [],
      },
    ],
    key: { state: "unknown", reason: "not-declared" },
    geometry: {
      state: "known",
      primaryField: { state: "known", field: "geometry" },
      fields: [
        {
          field: "geometry",
          geometryTypes: { state: "mixed", types: ["Polygon", "MultiPolygon"] },
          crs: crs84,
          layout: "xy",
          allowsEmpty: true,
        },
        {
          field: "centroid",
          geometryTypes: { state: "known", type: "Point" },
          crs: crs84,
          layout: "xy",
          allowsEmpty: true,
        },
      ],
    },
    temporal: { state: "none" },
    openContent: "unknown",
    provenance: [provenance],
  },
} as const satisfies SchemaState;

export const nonSpatialSchema = {
  state: "known",
  value: {
    kind: "honua.source-schema",
    version: "2.0",
    fingerprint: "sha256:schema-non-spatial",
    fields: [
      {
        name: "parcelId",
        path: ["parcelId"],
        type: { kind: "string" },
        nullability: "non-nullable",
        mutability: "read-only",
        roles: ["primary-key"],
        domain: { state: "unknown", reason: "not-reported" },
        constraints: { state: "unknown", reason: "not-reported" },
        native: [],
      },
    ],
    key: { state: "known", fields: ["parcelId"] },
    geometry: { state: "none", reason: "no-geometry-fields" },
    temporal: { state: "none" },
    openContent: "unknown",
    provenance: [provenance],
  },
} as const satisfies SchemaState;

export const compositeOdataSchema = {
  state: "known",
  value: {
    ...nonSpatialSchema.value,
    fingerprint: "sha256:schema-composite-odata",
    fields: [
      {
        ...nonSpatialSchema.value.fields[0],
        name: "tenantId",
        path: ["tenantId"],
      },
      {
        ...nonSpatialSchema.value.fields[0],
        name: "parcelNumber",
        path: ["parcelNumber"],
        type: { kind: "integer", bits: 64, signed: false, jsonEncoding: "string" },
      },
    ],
    key: { state: "known", fields: ["tenantId", "parcelNumber"] },
  },
} as const satisfies SchemaState;

export const ambiguousSpatialSchema = {
  state: "known",
  value: {
    ...primarySpatialSchema.value,
    fingerprint: "sha256:schema-ambiguous-spatial",
    geometry: {
      ...primarySpatialSchema.value.geometry,
      primaryField: { state: "none", reason: "no-default" },
    },
  },
} as const satisfies SchemaState;

export const capabilities: CapabilityProfile = {
  kind: "honua.capabilities",
  version: "1.0",
  fingerprint: "sha256:capabilities",
  evidenceFingerprint: "sha256:capability-evidence",
  sourceFingerprint: "sha256:schema-primary-spatial",
  evaluatedAt: "2026-07-14T12:00:00Z",
  validUntil: "2026-07-20T12:00:00Z",
  context: {
    availablePeers: [],
    authorization: { grantedScopes: [], deniedScopes: [] },
  },
  entries: [
    {
      id: "query",
      claimed: "supported",
      observed: "supported",
      effective: "supported",
      evidence: [
        {
          kind: "protocol-default",
          truth: "supported",
          reference: "ogcapi-features:core",
          sourceFingerprint: "sha256:schema-primary-spatial",
        },
        {
          kind: "conformance",
          truth: "supported",
          reference: "ogcapi-features:conf/core",
          observedAt: "2026-07-13T12:00:00Z",
          expiresAt: "2026-07-20T12:00:00Z",
          sourceFingerprint: "sha256:schema-primary-spatial",
        },
      ],
      reasons: ["supported-by-claim-and-observation"],
      constraints: {
        outputFormats: ["application/geo+json"],
        filterOperators: ["eq", "in", "intersects"],
        spatialPredicates: ["intersects"],
        supportedCrs: [crs84.definition, ogcUriCrs, geoParquetProjjsonCrs],
        pagination: { modes: ["offset"], maxPageSize: 10_000 },
        limits: { maxRecords: 100_000, maxResponseBytes: 64_000_000 },
      },
    },
  ],
};

export const unknownExtent: SpatialExtent = {
  state: "unknown",
  reason: "not-reported",
  provenance: [{ ...provenance, method: "unavailable" }],
};

export const knownHawaiiExtent: SpatialExtent = {
  state: "known",
  boxes: [{ layout: "xy", bounds: [-160.3, 18.9, -154.7, 22.3] }],
  crs: crs84,
  provenance: [provenance],
};

export const nonSpatialExtent: SpatialExtent = {
  state: "none",
  reason: "non-spatial",
  provenance: [{ ...provenance, method: "declared" }],
};

export const stacTemporalExtent: TemporalExtent = {
  state: "known",
  intervals: [
    [null, "2018-12-31T23:59:59Z"],
    ["2020-01-01T00:00:00Z", "2020-12-31T23:59:59Z"],
    ["2024-01-01T00:00:00Z", null],
  ],
  referenceSystem: { kind: "gregorian" },
  provenance: [
    {
      ...provenance,
      protocol: "stac",
      source: "https://example.test/stac/collections/landsat-c2-l2",
    },
  ],
};

export const emptyTemporalExtent: TemporalExtent = {
  state: "empty",
  reason: "no-temporal-values",
  provenance: [provenance],
};

export const unknownTemporalExtent: TemporalExtent = {
  state: "unknown",
  reason: "not-reported",
  provenance: [{ ...provenance, method: "unavailable" }],
};

export const nonTemporalExtent: TemporalExtent = {
  state: "none",
  reason: "non-temporal",
  provenance: [{ ...provenance, method: "declared" }],
};

function schemaIdentityFor<TSchemaState extends SchemaState>(schema: TSchemaState): SchemaIdentityFor<TSchemaState> {
  const identity =
    schema.state === "known"
      ? { state: "known" as const, fingerprint: schema.value.fingerprint }
      : {
          state: "unavailable" as const,
          reason: schema.reason,
          provenance: schema.provenance,
        };
  // TypeScript cannot correlate a generic discriminant branch to its conditional return type.
  return identity as SchemaIdentityFor<TSchemaState>;
}

export function descriptor<TProtocol extends SourceProtocol, TSchemaState extends SchemaState>(
  locator: SourceDescriptorV2<TProtocol, TSchemaState>["locator"],
  schema: TSchemaState,
  extent: SpatialExtent = unknownExtent,
  temporalExtent: TemporalExtent = unknownTemporalExtent,
): SourceDescriptorV2<TProtocol, TSchemaState> {
  return {
    kind: "honua.source-descriptor",
    version: "2.0",
    id: "fixture",
    locator,
    schema,
    extent,
    temporalExtent,
    capabilities,
    identity: {
      descriptorFingerprint: "sha256:descriptor",
      schema: schemaIdentityFor(schema),
      capabilityFingerprint: capabilities.fingerprint,
    },
    provenance: [provenance],
  };
}
