import type {
  AxisOrder,
  BoundingBox,
  CanonicalGeometry,
  CapabilityConstraints,
  CapabilityProfile,
  CrsDefinition,
  CrsProvenance,
  DistanceOperand,
  ExecutableBoundingBox,
  ExtensionMap,
  ExtensionSourceLocator,
  FeatureIdentity,
  FeatureIdentityForFields,
  FieldConstraintState,
  FieldValueDomain,
  GeoServicesFeatureLocator,
  GeometryValue,
  GeoparquetSourceLocator,
  KeyDefinition,
  LogicalField,
  MaplibreGeojsonSourceLocator,
  MaplibreVectorSourceLocator,
  OdataSourceLocator,
  OgcFeaturesLocator,
  OgcMapsLocator,
  OgcTilesLocator,
  PageContinuation,
  PageRequest,
  PageResultState,
  PmtilesSourceLocator,
  PresentGeometryValue,
  ResultCount,
  Sha256,
  SourceLocatorV2,
  SpatialExtent,
  StacSourceLocator,
  TemporalExtent,
  WfsSourceLocator,
} from "./contracts.js";
import { sourceFromDescriptor } from "./contracts.js";
import {
  ambiguousSpatialSchema,
  crs84,
  descriptor,
  nonSpatialExtent,
  nonSpatialSchema,
  primarySpatialSchema,
  provenance,
} from "./fixtures.js";

interface Parcel {
  readonly parcelId: string;
  readonly owner: string;
  readonly assessedValue: number;
  readonly status: "active" | "retired";
  readonly active: boolean;
  readonly centroid: GeometryValue;
  readonly metadata: { readonly district: string };
}

interface CompositeKeyParcel {
  readonly tenantId: string;
  readonly parcelNumber: bigint;
}

// @ts-expect-error A resolved GeoServices feature locator must identify its layer.
const geoservicesWithoutLayer: GeoServicesFeatureLocator = {
  protocol: "geoservices-feature-service",
  endpoint: "https://example.test/Parcels/FeatureServer",
};

const geoservicesWithOgcField: GeoServicesFeatureLocator = {
  protocol: "geoservices-feature-service",
  endpoint: "https://example.test/Parcels/FeatureServer",
  layerId: 0,
  // @ts-expect-error Protocol-specific locator fields cannot be mixed.
  collectionId: "parcels",
};

const ogcWithLayerId: OgcFeaturesLocator = {
  protocol: "ogc-features",
  endpoint: "https://example.test/ogc",
  collectionId: "parcels",
  layout: "ogc-api",
  // @ts-expect-error GeoServices layer ids do not belong on OGC locators.
  layerId: 0,
};

const datasetTilesWithCollection: OgcTilesLocator = {
  protocol: "ogc-tiles",
  endpoint: "https://example.test/ogc",
  scope: "dataset",
  // @ts-expect-error Dataset-scope tile identity never carries a collection id.
  collectionId: "parcels",
};

// @ts-expect-error Collection-scope tiles require collection identity.
const collectionTilesWithoutCollection: OgcTilesLocator = {
  protocol: "ogc-tiles",
  endpoint: "https://example.test/ogc",
  scope: "collection",
};

const datasetMapWithCollection: OgcMapsLocator = {
  protocol: "ogc-maps",
  endpoint: "https://example.test/ogc",
  scope: "dataset",
  // @ts-expect-error Dataset-scope map identity never carries a collection id.
  collectionId: "parcels",
};

// @ts-expect-error Collection-scope maps require collection identity.
const collectionMapWithoutCollection: OgcMapsLocator = {
  protocol: "ogc-maps",
  endpoint: "https://example.test/ogc",
  scope: "collection",
};

const unresolvedOgcLayout: OgcFeaturesLocator = {
  protocol: "ogc-features",
  endpoint: "https://example.test/ogc",
  collectionId: "parcels",
  // @ts-expect-error Discovery-only `auto` cannot survive in a resolved descriptor.
  layout: "auto",
};

const wfsWithoutNamespace: WfsSourceLocator = {
  protocol: "wfs",
  endpoint: "https://example.test/wfs",
  version: "2.0.0",
  // @ts-expect-error A WFS feature type is URI-qualified, not a prefix-bearing string.
  featureType: "parcels:parcel",
};

const odataWithCollection: OdataSourceLocator = {
  protocol: "odata",
  endpoint: "https://example.test/odata",
  version: "4.0",
  entitySet: "Parcels",
  // @ts-expect-error OGC collection ids do not belong on OData locators.
  collectionId: "parcels",
};

const unsupportedOdataRevision: OdataSourceLocator = {
  protocol: "odata",
  endpoint: "https://example.test/odata",
  // @ts-expect-error The current adapter certifies OData 4.0, not 4.02.
  version: "4.02",
  entitySet: "Parcels",
};

// @ts-expect-error The API collection branch requires collectionId.
const stacApiCollectionWithoutId: StacSourceLocator = {
  protocol: "stac",
  endpoint: "https://example.test/stac",
  scope: "api-collection",
};

const emptyGeoparquet: GeoparquetSourceLocator = {
  protocol: "geoparquet",
  // @ts-expect-error A GeoParquet relation must address at least one asset.
  assets: [],
};

const serviceShapedGeoparquet: GeoparquetSourceLocator = {
  protocol: "geoparquet",
  assets: [{ kind: "file", path: "/srv/data/parcels.parquet" }],
  // @ts-expect-error Static resources are not represented as service endpoints.
  endpoint: "file:///srv/data/parcels.parquet",
};

const serviceShapedMaplibreVector: MaplibreVectorSourceLocator = {
  protocol: "maplibre-vector",
  tiles: {
    form: "tilejson",
    resource: { kind: "url", href: "https://example.test/vector/tilejson.json" },
  },
  // @ts-expect-error Resolved MapLibre locators use TileJSON/templates, not a generic endpoint.
  endpoint: "https://example.test/vector",
};

const emptyMaplibreTemplates: MaplibreVectorSourceLocator = {
  protocol: "maplibre-vector",
  tiles: {
    form: "templates",
    // @ts-expect-error Direct tile-template form contains at least one template.
    templates: [],
  },
};

const globPmtiles: PmtilesSourceLocator = {
  protocol: "pmtiles",
  // @ts-expect-error A PMTiles archive identifies one literal resource, never a glob.
  resource: { kind: "file", path: "/srv/tiles/*.pmtiles", pattern: "glob" },
};

const globGeojson: MaplibreGeojsonSourceLocator = {
  protocol: "maplibre-geojson",
  // @ts-expect-error A MapLibre GeoJSON source identifies one literal resource, never a glob.
  resource: { kind: "url", href: "https://example.test/data/*.geojson", pattern: "glob" },
};

const unqualifiedExtension: ExtensionSourceLocator = {
  // @ts-expect-error Extension protocols require a namespaced identifier.
  protocol: "custom",
  resource: { kind: "url", href: "https://example.test/custom" },
  extension: { locatorVersion: "1", payload: {} },
};

const nonJsonExtension: ExtensionSourceLocator<"io.honua.custom"> = {
  protocol: "io.honua.custom",
  resource: { kind: "url", href: "https://example.test/custom" },
  extension: {
    locatorVersion: "1",
    // @ts-expect-error Extension locator payloads must be JSON-safe.
    payload: { createdAt: new Date() },
  },
};

/** Resolved endpoint parsing rejects these strings before descriptor construction. */
const runtimeRejectedNetworkLocators: readonly {
  readonly locator: SourceLocatorV2;
  readonly reason: string;
}[] = [
  {
    locator: {
      protocol: "ogc-features",
      endpoint: "https://user:secret@example.test/ogc",
      collectionId: "parcels",
      layout: "ogc-api",
    },
    reason: "userinfo is forbidden",
  },
  {
    locator: {
      protocol: "odata",
      endpoint: "https://example.test/odata#metadata",
      version: "4.0",
      entitySet: "Parcels",
    },
    reason: "fragments are forbidden",
  },
  {
    locator: {
      protocol: "wfs",
      endpoint: "https://example.test/wfs?token=secret",
      version: "2.0.0",
      featureType: { localName: "parcel", namespaceUri: "https://example.test/ns/parcels" },
    },
    reason: "credential query parameters belong to an auth provider/resolver",
  },
  {
    locator: {
      protocol: "ogc-features",
      endpoint: "https://example.test/ogc?region=west",
      collectionId: "parcels",
      layout: "ogc-api",
    },
    reason: "query identity is rejected unless the adapter explicitly allowlists the parameter",
  },
  {
    locator: {
      protocol: "maplibre-vector",
      tiles: {
        form: "templates",
        templates: [{ kind: "url", href: "https://example.test/{z}/{x}/{y}.pbf#secret" }],
      },
    },
    reason: "tile template fragments are forbidden",
  },
  {
    locator: {
      protocol: "stac",
      scope: "static-document",
      resource: { kind: "url", href: "https://example.test/catalog.json?api_key=secret" },
      documentType: "catalog",
    },
    reason: "static resource credentials belong to an auth provider/resolver",
  },
];

const unqualifiedExtensionKey: ExtensionMap = {
  // @ts-expect-error Extension keys require a namespaced identifier.
  custom: true,
};

// @ts-expect-error Unknown is metadata state, never an executable geometry type.
const unknownGeometry: CanonicalGeometry = { type: "Unknown", coordinates: [] };

// @ts-expect-error Returned geometry has only present or empty states.
const unknownGeometryValue: GeometryValue = { state: "unknown", reason: "missing" };

const emptyLineString: CanonicalGeometry = {
  type: "LineString",
  // @ts-expect-error Empty coordinate arrays normalize to EmptyGeometryValue.
  coordinates: [],
};

// @ts-expect-error Bounding boxes contain exactly four or six ordinates.
const invalidBoundingBox: BoundingBox = [0, 0, 0, 0, 0];

const measuredBoundingBox: BoundingBox = {
  // @ts-expect-error Canonical extents are spatial XY/XYZ; measures never occupy bbox ordinates.
  layout: "xym",
  bounds: [0, 0, 0, 1, 1, 1],
};

const unresolvedExecutableBoundingBox: ExecutableBoundingBox = {
  box: { layout: "xy", bounds: [-158.3, 21.2, -157.6, 21.8] },
  crs: {
    // @ts-expect-error Bbox execution requires resolved CRS identity.
    definition: { kind: "unknown", reason: "missing" },
    // @ts-expect-error Bbox execution requires known payload order.
    coordinateOrder: { state: "unknown", reason: "missing" },
    provenance: { method: "metadata" },
  },
};

/** Distance values are structurally numeric but runtime validation rejects non-positive/non-finite values. */
const runtimeRejectedDistances: readonly DistanceOperand[] = [
  { value: 0, unit: "metre", mode: "planar" },
  { value: -1, unit: "kilometre", mode: "geodesic" },
  { value: Number.POSITIVE_INFINITY, unit: "mile", mode: "geodesic" },
];

// @ts-expect-error Capability profiles use deterministic arrays, not Set.
const setCapabilities: CapabilityProfile = new Set(["query"]);

// @ts-expect-error Reprojection provenance must carry the exact transformation record.
const incompleteReprojection: CrsProvenance = { method: "reprojected" };

const oneDimensionalAxisOrder: AxisOrder = {
  state: "known",
  source: "declared",
  // @ts-expect-error A spatial CRS/coordinate order has at least two axes.
  axes: [{ name: "x", direction: "east", unit: "metre" }],
};

const noCrsAsDefinition: CrsDefinition = {
  // @ts-expect-error WFS NoCRS is a non-spatial schema state, never a CRS definition.
  kind: "none",
};

/** URI/PROJJSON CRS identities are known only after bounded canonical validation. */
const runtimeRejectedCrsDefinitions: readonly {
  readonly definition: CrsDefinition;
  readonly reason: string;
}[] = [
  {
    definition: {
      kind: "uri",
      uri: "../crs/local-grid",
      definitionAxisOrder: crs84.definition.definitionAxisOrder,
    },
    reason: "CRS URI must be absolute and canonical",
  },
  {
    definition: {
      kind: "projjson",
      projjson: {},
      definitionAxisOrder: crs84.definition.definitionAxisOrder,
    },
    reason: "PROJJSON must validate against the supported schema vocabulary",
  },
  {
    definition: {
      kind: "projjson",
      projjson: { type: "GeographicCRS", padding: "x".repeat(65_537) },
      definitionAxisOrder: crs84.definition.definitionAxisOrder,
    },
    reason: "canonical PROJJSON exceeds the 64 KiB contract bound",
  },
];

// @ts-expect-error `xy` geometry positions contain exactly two ordinates.
const mismatchedGeometryLayout: PresentGeometryValue = {
  state: "present",
  layout: "xy",
  crs: crs84,
  geometry: {
    type: "Point",
    coordinates: [-157.86, 21.31, 4],
  },
};

const nonArrayCapabilityConstraint: CapabilityConstraints = {
  // @ts-expect-error Capability constraints are JSON-safe arrays, not Set.
  outputFormats: new Set(["application/geo+json"]),
};

const nativeOperatorCapabilityConstraint: CapabilityConstraints = {
  // @ts-expect-error Capability operators use semantic or namespaced extension identifiers.
  filterOperators: ["esriSpatialRelIntersects"],
};

const knownTemporalExtentWithoutIntervals: TemporalExtent = {
  state: "known",
  // @ts-expect-error Known temporal extents contain at least one explicit interval.
  intervals: [],
  referenceSystem: { kind: "gregorian" },
  provenance: [provenance],
};

// @ts-expect-error Every spatial extent state carries provenance.
const unknownSpatialExtentWithoutProvenance: SpatialExtent = {
  state: "unknown",
  reason: "not-computed",
};

// @ts-expect-error Every temporal extent state carries provenance.
const nonTemporalExtentWithoutProvenance: TemporalExtent = {
  state: "none",
  reason: "non-temporal",
};

const rawNextLinkPageRequest: PageRequest = {
  kind: "continuation",
  // @ts-expect-error Raw next-link URLs never enter query JSON.
  continuation: "https://example.test/odata/Parcels?$skiptoken=secret",
};

// @ts-expect-error Continuations are runtime-created opaque values, not forgeable JSON.
const forgedContinuation: PageContinuation = {
  kind: "honua.page-continuation",
  mode: "cursor",
  binding: {
    descriptorFingerprint: "sha256:other-source",
    queryFingerprint: "sha256:other-query",
  },
};

const onePartCompositeIdentity: FeatureIdentity = {
  kind: "composite",
  // @ts-expect-error Composite identity contains at least two key parts.
  parts: [{ field: "tenantId", value: "honolulu" }],
};

// @ts-expect-error A known one-field schema key requires the named scalar field.
const scalarIdentityWithoutField: FeatureIdentityForFields<Parcel, readonly ["parcelId"]> = {
  kind: "scalar",
  value: "parcel-1",
};

const scalarIdentityWithWrongField: FeatureIdentityForFields<Parcel, readonly ["parcelId"]> = {
  kind: "scalar",
  // @ts-expect-error Scalar identity field must be the exact declared schema key.
  field: "owner",
  value: "parcel-1",
};

// @ts-expect-error Every completion claim carries explicit evidence.
const unsupportedCompletePageClaim: PageResultState = {
  state: "complete",
  mode: "none",
  returned: 1,
};

// @ts-expect-error A legacy bare number cannot claim exact count semantics.
const legacyBareTotalCount: ResultCount<"matched-features"> = 42;

// @ts-expect-error Every count state carries explicit evidence.
const exactCountWithoutEvidence: ResultCount<"matched-features"> = {
  state: "exact",
  scope: "matched-features",
  value: 42,
};

const runtimeRejectedCounts: readonly ResultCount[] = [
  {
    state: "exact",
    scope: "matched-features",
    value: -1,
    evidence: [{ kind: "protocol", reference: "numberMatched" }],
  },
  {
    state: "estimated",
    scope: "result-rows",
    value: 2.5,
    confidence: 1.2,
    evidence: [{ kind: "estimate", reference: "statistics" }],
  },
];

const cursorResultWithOffsetNext: PageResultState = {
  state: "more",
  mode: "cursor",
  returned: 100,
  // @ts-expect-error Cursor mode can only return an opaque cursor continuation.
  next: { kind: "offset", offset: 100, limit: 100 },
  evidence: [{ kind: "continuation", reference: "cursor:present" }],
};

/** These are structurally valid but normatively rejected by runtime page validation. */
const runtimeRejectedPageRequests: readonly { readonly request: PageRequest; readonly reason: string }[] = [
  { request: { kind: "offset", offset: -1, limit: 100 }, reason: "offset must be a safe nonnegative integer" },
  { request: { kind: "first", limit: 0 }, reason: "limit must be a positive safe integer" },
  { request: { kind: "first", limit: 10.5 }, reason: "limit must be an integer" },
  { request: { kind: "first", limit: 10_001 }, reason: "limit exceeds effective maxPageSize=10000" },
];

const wrongCompositeKeyOrder: FeatureIdentityForFields<CompositeKeyParcel, readonly ["tenantId", "parcelNumber"]> = {
  kind: "composite",
  parts: [
    // @ts-expect-error Composite identity order follows the declared key tuple exactly.
    { field: "parcelNumber", value: "9007199254740993" },
    // @ts-expect-error Composite identity order follows the declared key tuple exactly.
    { field: "tenantId", value: "honolulu" },
  ],
};

/** Runtime rejects duplicates/extras even when a value enters through a widened compatibility type. */
const runtimeRejectedCompositeIdentities: readonly {
  readonly keyFields: readonly ["tenantId", "parcelNumber"];
  readonly identity: FeatureIdentity;
  readonly reason: string;
}[] = [
  {
    keyFields: ["tenantId", "parcelNumber"],
    identity: {
      kind: "composite",
      parts: [
        { field: "tenantId", value: "honolulu" },
        { field: "tenantId", value: "duplicate" },
      ],
    },
    reason: "duplicate and missing key parts",
  },
  {
    keyFields: ["tenantId", "parcelNumber"],
    identity: {
      kind: "composite",
      parts: [
        { field: "tenantId", value: "honolulu" },
        { field: "parcelNumber", value: 9_007_199_254_740_991 },
        { field: "extra", value: true },
      ],
    },
    reason: "wrong JSON encoding and extra key part",
  },
];

const runtimeRejectedDuplicateResultIdentities: readonly {
  readonly identities: readonly FeatureIdentity[];
  readonly reason: string;
}[] = [
  {
    identities: [
      { kind: "scalar", field: "parcelId", value: "parcel-1" },
      { kind: "scalar", field: "parcelId", value: "parcel-1" },
    ],
    reason: "feature identities must be unique within a result page",
  },
];

const runtimeRejectedFingerprints: readonly Sha256[] = ["sha256:short", "sha256:ABCDEF0123456789"];

const runtimeRejectedDuplicateKey: KeyDefinition = {
  state: "known",
  fields: ["tenantId", "tenantId"],
};

// @ts-expect-error Domain and constraint knowledge are required; omission cannot mean unknown.
const fieldWithoutDomainKnowledge: LogicalField = {
  name: "status",
  path: ["status"],
  type: { kind: "string" },
  nullability: "unknown",
  mutability: "unknown",
  roles: [],
  native: [],
};

const emptyKnownConstraintState: FieldConstraintState = {
  state: "known",
  // @ts-expect-error Known constraint state contains at least one constraint.
  values: [],
};

/** Structurally valid domain metadata still receives semantic runtime validation. */
const runtimeRejectedDomains: readonly { readonly domain: FieldValueDomain; readonly reason: string }[] = [
  {
    domain: {
      state: "coded",
      openness: "closed",
      values: [
        { value: "active", label: "Active" },
        { value: "active", label: "Duplicate" },
      ],
    },
    reason: "coded domain values must be unique by canonical JSON value",
  },
  {
    domain: {
      state: "range",
      minimum: { value: 10, inclusive: true },
      maximum: { value: 1, inclusive: true },
    },
    reason: "range minimum cannot exceed maximum",
  },
  {
    domain: {
      state: "range",
      minimum: { value: Number.NaN, inclusive: true },
    },
    reason: "domain numbers must be finite JSON values",
  },
];

const runtimeRejectedConstraintCollisions: readonly FieldConstraintState[] = [
  {
    state: "known",
    values: [
      { kind: "length", minimum: 1, maximum: 16 },
      { kind: "length", minimum: 2, maximum: 32 },
    ],
  },
];

const unknownCrsSpatialOperand: PresentGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-157.86, 21.31] },
  crs: {
    definition: { kind: "unknown", reason: "missing" },
    coordinateOrder: { state: "unknown", reason: "missing" },
    provenance: { method: "metadata" },
  },
  layout: "xy",
};

const unknownOrderSpatialOperand: PresentGeometryValue = {
  state: "present",
  geometry: { type: "Point", coordinates: [-157.86, 21.31] },
  crs: {
    definition: crs84.definition,
    coordinateOrder: { state: "unknown", reason: "missing" },
    provenance: { method: "metadata" },
  },
  layout: "xy",
};

const source = sourceFromDescriptor<Parcel, "ogc-features", typeof primarySpatialSchema>(
  descriptor(
    {
      protocol: "ogc-features",
      endpoint: "https://example.test/ogc",
      collectionId: "parcels",
      layout: "ogc-api",
    },
    primarySpatialSchema,
  ),
);

const nonSpatialSource = sourceFromDescriptor<Parcel, "odata", typeof nonSpatialSchema>(
  descriptor(
    { protocol: "odata", endpoint: "https://example.test/odata", version: "4.0", entitySet: "Parcels" },
    nonSpatialSchema,
    nonSpatialExtent,
  ),
);

const ambiguousGeometrySource = sourceFromDescriptor<Parcel, "ogc-features", typeof ambiguousSpatialSchema>(
  descriptor(
    {
      protocol: "ogc-features",
      endpoint: "https://example.test/ogc",
      collectionId: "mixed",
      layout: "ogc-api",
    },
    ambiguousSpatialSchema,
  ),
);

const wfsSource = sourceFromDescriptor<Parcel, "wfs", typeof primarySpatialSchema>(
  descriptor(
    {
      protocol: "wfs",
      endpoint: "https://example.test/wfs",
      version: "2.0.0",
      featureType: { localName: "parcel", namespaceUri: "https://example.test/ns/parcels" },
    },
    primarySpatialSchema,
  ),
);

void source.query({
  kind: "features",
  // @ts-expect-error Projection is restricted to fields in Parcel.
  select: ["parcelId", "missingField"] as const,
});

const ordinaryStringTemporalQuery = {
  kind: "features",
  filter: {
    op: "before",
    field: "owner",
    value: { kind: "instant", value: "2026-07-13T00:00:00Z" },
  },
} as const;
// @ts-expect-error Ordinary string fields are not schema/role-derived temporal values.
void source.query(ordinaryStringTemporalQuery);

void source.query({
  kind: "features",
  // @ts-expect-error The v2 page request is discriminated; offset-only legacy objects are rejected.
  page: { offset: 0, limit: 100 },
});

/** These compile structurally but runtime query validation rejects duplicate/colliding names. */
void source.query({
  kind: "features",
  select: ["parcelId", "parcelId"],
  sort: [
    { field: "owner", direction: "asc" },
    { field: "owner", direction: "desc" },
  ],
});

void source.query({
  kind: "aggregate",
  groupBy: ["status", "status"],
  metrics: [
    { fn: "count", as: "status" },
    { fn: "count", as: "status" },
  ],
});

void nonSpatialSource.query({
  kind: "features",
  // @ts-expect-error A proven non-spatial source cannot include geometry.
  geometry: "include",
});

void ambiguousGeometrySource.query({
  kind: "features",
  // @ts-expect-error A multi-geometry source without a default requires an explicit field.
  geometry: "include",
});

void nonSpatialSource.query({
  kind: "features",
  // @ts-expect-error A proven non-spatial source has no semantic spatial predicate.
  filter: {
    op: "intersects",
    geometry: {
      state: "present",
      geometry: { type: "Point", coordinates: [-157.86, 21.31] },
      crs: crs84,
      layout: "xy",
    },
  },
});

void ambiguousGeometrySource.query({
  kind: "features",
  // @ts-expect-error An ambiguous geometry source must name the predicate field.
  filter: {
    op: "intersects",
    geometry: {
      state: "present",
      geometry: { type: "Point", coordinates: [-157.86, 21.31] },
      crs: crs84,
      layout: "xy",
    },
  },
});

void nonSpatialSource.query({
  kind: "features",
  // @ts-expect-error Output CRS is meaningless for a proven non-spatial source.
  outputCrs: crs84.definition,
});

const nonSpatialGeometryQuery = {
  kind: "features",
  filter: {
    op: "intersects",
    geometry: { state: "none", reason: "non-spatial" },
  },
} as const;
// @ts-expect-error A non-spatial marker is not an executable geometry operand.
void source.query(nonSpatialGeometryQuery);

void source.query({
  kind: "features",
  // @ts-expect-error Ordered comparisons do not accept boolean fields.
  filter: { op: "gt", field: "active", value: true },
});

void source.query({
  kind: "features",
  // @ts-expect-error Range comparisons do not accept boolean fields.
  filter: { op: "between", field: "active", lower: false, upper: true },
});

void source.query({
  kind: "features",
  sort: [
    {
      // @ts-expect-error Geometry fields are not ordinary ordered sort keys.
      field: "centroid",
      direction: "asc",
    },
  ],
});

void source.query({
  kind: "aggregate",
  // @ts-expect-error Struct fields are not scalar grouping keys.
  groupBy: ["metadata"],
  metrics: [{ fn: "count", as: "records" }],
});

void source.query({
  kind: "features",
  // @ts-expect-error The value type follows the selected field.
  filter: { op: "eq", field: "assessedValue", value: "expensive" },
});

void source.query({
  kind: "features",
  filter: {
    kind: "native",
    dialect: "cql2-json",
    // @ts-expect-error CQL2 JSON requires a JSON payload, not text.
    payload: { format: "text", text: "status = 'active'" },
  },
});

const unknownCrsSpatialQuery = {
  kind: "features",
  filter: {
    op: "intersects",
    geometry: unknownCrsSpatialOperand,
  },
} as const;
// @ts-expect-error Spatial execution requires a resolved CRS and known payload order.
void source.query(unknownCrsSpatialQuery);

const unknownOrderSpatialQuery = {
  kind: "features",
  filter: {
    op: "intersects",
    geometry: unknownOrderSpatialOperand,
  },
} as const;
// @ts-expect-error A resolved CRS alone is insufficient when payload coordinate order is unknown.
void source.query(unknownOrderSpatialQuery);

void wfsSource.query({
  kind: "features",
  filter: {
    kind: "native",
    dialect: "fes-2.0",
    // @ts-expect-error FES requires an XML-tagged payload.
    payload: { format: "text", text: "<fes:Filter/>" },
  },
});

void nonSpatialSource.query({
  kind: "features",
  filter: {
    kind: "native",
    dialect: "odata-4.0",
    // @ts-expect-error OData 4.0 is a built-in text dialect even though its name contains a dot.
    payload: { format: "json", value: { status: "active" } },
  },
});

void source.query({
  kind: "features",
  // @ts-expect-error Output CRS must be a resolved authority/WKT/URI/PROJJSON definition.
  outputCrs: { kind: "unknown", reason: "missing" },
});

void source.query({
  kind: "features",
  // @ts-expect-error An OGC source cannot accept a GeoServices native expression.
  filter: {
    kind: "native",
    dialect: "geoservices-sql92",
    payload: { format: "text", text: "1=1" },
  },
});

void source.query({
  kind: "aggregate",
  groupBy: [],
  // @ts-expect-error Aggregate queries require at least one metric.
  metrics: [],
});

void source.query({
  kind: "aggregate",
  groupBy: ["status"],
  metrics: [
    // @ts-expect-error Numeric metrics cannot target string fields.
    {
      fn: "avg",
      field: "owner",
      as: "badAverage",
    },
  ],
});

async function rejectedResultAccess(): Promise<void> {
  const result = await source.query({
    kind: "features",
    select: ["parcelId", "owner"] as const,
    geometry: "omit",
  });
  const feature = result.features[0];
  if (!feature) return;

  // @ts-expect-error Projection removes unselected properties from the result type.
  feature.properties.assessedValue;
  // @ts-expect-error A geometry-omitting query returns features without geometry.
  feature.geometry;
}

async function rejectedNonSpatialResultGeometry(): Promise<void> {
  const result = await nonSpatialSource.query({ kind: "features" });
  const feature = result.features[0];
  if (!feature) return;
  // @ts-expect-error Non-spatial result features never fabricate geometry.
  feature.geometry;
}

async function rejectedDuplicatePromotedGeometry(): Promise<void> {
  const result = await source.query({
    kind: "features",
    select: ["parcelId", "centroid"] as const,
    geometry: { field: "centroid" },
  });
  const feature = result.features[0];
  if (!feature) return;
  feature.geometry;
  // @ts-expect-error A promoted secondary geometry is removed from properties to avoid duplication.
  feature.properties.centroid;
}

void geoservicesWithoutLayer;
void geoservicesWithOgcField;
void ogcWithLayerId;
void unresolvedOgcLayout;
void wfsWithoutNamespace;
void odataWithCollection;
void unsupportedOdataRevision;
void stacApiCollectionWithoutId;
void emptyGeoparquet;
void serviceShapedGeoparquet;
void unqualifiedExtension;
void nonJsonExtension;
void unqualifiedExtensionKey;
void unknownGeometry;
void unknownGeometryValue;
void emptyLineString;
void invalidBoundingBox;
void setCapabilities;
void incompleteReprojection;
void oneDimensionalAxisOrder;
void mismatchedGeometryLayout;
void nonArrayCapabilityConstraint;
void rejectedResultAccess;
void rejectedNonSpatialResultGeometry;
