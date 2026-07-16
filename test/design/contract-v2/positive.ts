import type {
  AbortSignalLike,
  EmptyGeometryValue,
  ExtensionSourceLocator,
  FeatureIdentity,
  GeoServicesFeatureLocator,
  GeoparquetSourceLocator,
  LogicalField,
  MaplibreGeojsonSourceLocator,
  MaplibreRasterSourceLocator,
  MaplibreVectorSourceLocator,
  OdataSourceLocator,
  OgcFeaturesLocator,
  OgcMapsLocator,
  OgcTilesLocator,
  PageResultState,
  PmtilesSourceLocator,
  ResultCount,
  SourceGeometrySchema,
  StacSourceLocator,
  TemporalValue,
  WfsSourceLocator,
} from "./contracts.js";
import { sourceFromDescriptor } from "./contracts.js";
import {
  ambiguousSpatialSchema,
  compositeOdataSchema,
  crs84,
  descriptor,
  geoParquetProjjsonBinding,
  nonSpatialExtent,
  nonSpatialSchema,
  nonTemporalExtent,
  ogcUriCrsBinding,
  primarySpatialSchema,
  stacTemporalExtent,
  unavailableSchema,
  unknownExtent,
} from "./fixtures.js";

interface Parcel {
  readonly parcelId: string;
  readonly owner: string;
  readonly assessedValue: number;
  readonly status: "active" | "retired";
  readonly updatedAt: TemporalValue<"instant">;
  readonly centroid: import("./contracts.js").GeometryValue;
}

interface OdataParcel {
  readonly tenantId: string;
  readonly parcelNumber: bigint;
  readonly owner: string;
}

export const codedStatusField: LogicalField = {
  name: "status",
  path: ["STATUS"],
  type: { kind: "string", maxLength: 16 },
  nullability: "non-nullable",
  mutability: "read-write",
  roles: [],
  domain: {
    state: "coded",
    openness: "closed",
    values: [
      { value: "active", label: "Active" },
      { value: "retired", label: "Retired" },
    ],
  },
  constraints: { state: "known", values: [{ kind: "length", minimum: 1, maximum: 16 }] },
  native: [{ protocol: "geoservices-feature-service", name: "codedValueDomain" }],
};

export const assessedValueField: LogicalField = {
  name: "assessedValue",
  path: ["assessedValue"],
  type: { kind: "decimal", precision: 18, scale: 2, jsonEncoding: "string" },
  nullability: "nullable",
  mutability: "read-write",
  roles: [],
  domain: {
    state: "range",
    minimum: { value: "0.00", inclusive: true },
    maximum: { value: "9999999999999999.99", inclusive: true },
    unit: "USD",
  },
  constraints: { state: "known", values: [{ kind: "multiple-of", value: 0.01 }] },
  native: [{ protocol: "odata", name: "Org.OData.Validation.V1.Minimum" }],
};

export const unknownDomainField: LogicalField = {
  name: "qualityCode",
  path: ["quality_code"],
  type: { kind: "string" },
  nullability: "unknown",
  mutability: "unknown",
  roles: [],
  domain: {
    state: "unknown",
    reason: "unrecognized",
    native: { protocol: "wfs", name: "customRestriction", path: ["simpleType", "restriction"] },
  },
  constraints: {
    state: "partial",
    values: [{ kind: "pattern", syntax: "ecma-262", expression: "^[A-Z]+$" }],
    reason: "unrecognized",
    native: [{ protocol: "wfs", name: "app:qualityConstraint" }],
  },
  native: [],
};

export const geoservices: GeoServicesFeatureLocator = {
  protocol: "geoservices-feature-service",
  endpoint: "https://example.test/arcgis/rest/services/Parcels/FeatureServer",
  layerId: 0,
};

export const ogcFeatures: OgcFeaturesLocator = {
  protocol: "ogc-features",
  endpoint: "https://example.test/ogc",
  collectionId: "parcels",
  layout: "ogc-api",
};

export const ogcDatasetTiles: OgcTilesLocator = {
  protocol: "ogc-tiles",
  endpoint: "https://example.test/ogc",
  scope: "dataset",
  tileMatrixSetId: "WebMercatorQuad",
};

export const ogcCollectionTiles: OgcTilesLocator = {
  protocol: "ogc-tiles",
  endpoint: "https://example.test/ogc",
  scope: "collection",
  collectionId: "parcels",
  tileMatrixSetId: "WebMercatorQuad",
};

export const ogcDatasetMap: OgcMapsLocator = {
  protocol: "ogc-maps",
  endpoint: "https://example.test/ogc",
  scope: "dataset",
  styleId: "default",
};

export const ogcCollectionMap: OgcMapsLocator = {
  protocol: "ogc-maps",
  endpoint: "https://example.test/ogc",
  scope: "collection",
  collectionId: "parcels",
  styleId: "default",
};

export const wfs: WfsSourceLocator = {
  protocol: "wfs",
  endpoint: "https://example.test/wfs",
  version: "2.0.0",
  featureType: {
    localName: "parcel",
    namespaceUri: "https://example.test/ns/parcels",
    prefix: "parcels",
  },
};

export const odata: OdataSourceLocator = {
  protocol: "odata",
  endpoint: "https://example.test/odata",
  version: "4.0",
  entitySet: "Parcels",
};

export const stacApi: StacSourceLocator = {
  protocol: "stac",
  endpoint: "https://example.test/stac",
  scope: "api-collection",
  collectionId: "landsat-c2-l2",
};

export const stacStatic: StacSourceLocator = {
  protocol: "stac",
  scope: "static-document",
  resource: { kind: "file", path: "/srv/catalog/catalog.json" },
  documentType: "catalog",
};

export const geoparquet: GeoparquetSourceLocator = {
  protocol: "geoparquet",
  assets: [
    {
      kind: "url",
      href: "https://example.test/overture/places/*.parquet",
      pattern: "glob",
    },
  ],
  hivePartitioning: true,
  geometryColumn: "geometry",
  geometryEncoding: "geoparquet-1.1-wkb",
  geometryExecution: "wkb",
  geometrySpatialRuntimeAvailable: true,
  bboxColumn: "bbox",
};

export const pmtiles: PmtilesSourceLocator = {
  protocol: "pmtiles",
  resource: { kind: "file", path: "/srv/tiles/hawaii.pmtiles" },
};

export const maplibreVectorTileJson: MaplibreVectorSourceLocator = {
  protocol: "maplibre-vector",
  tiles: {
    form: "tilejson",
    resource: { kind: "url", href: "https://example.test/vector/tilejson.json" },
  },
  sourceLayer: "parcels",
};

export const maplibreRasterTemplates: MaplibreRasterSourceLocator = {
  protocol: "maplibre-raster",
  tiles: {
    form: "templates",
    templates: [
      { kind: "url", href: "https://a.example.test/tiles/{z}/{x}/{y}.png" },
      { kind: "url", href: "https://b.example.test/tiles/{z}/{x}/{y}.png" },
    ],
    scheme: "xyz",
  },
  tileSize: 512,
};

export const maplibreGeojson: MaplibreGeojsonSourceLocator = {
  protocol: "maplibre-geojson",
  resource: { kind: "file", path: "/srv/data/parcels.geojson" },
};

export const extension: ExtensionSourceLocator<"io.honua.example-protocol"> = {
  protocol: "io.honua.example-protocol",
  resource: { kind: "resolver", resolver: "io.honua.example-resolver", id: "parcels:2" },
  extension: {
    locatorVersion: "1",
    payload: { dataset: "parcels", shard: 2, options: [true, null] },
  },
};

export const stacDescriptor = descriptor(stacApi, primarySpatialSchema, unknownExtent, stacTemporalExtent);

export const compositeOdataDescriptor = descriptor(odata, compositeOdataSchema, nonSpatialExtent, nonTemporalExtent);

export const compositeOdataIdentity: FeatureIdentity = {
  kind: "composite",
  parts: [
    { field: "tenantId", value: "honolulu" },
    { field: "parcelNumber", value: "9007199254740993" },
  ],
};

const geoservicesSource = sourceFromDescriptor<Parcel, "geoservices-feature-service", typeof primarySpatialSchema>(
  descriptor(geoservices, primarySpatialSchema),
);
const ogcSource = sourceFromDescriptor<Parcel, "ogc-features", typeof primarySpatialSchema>(
  descriptor(ogcFeatures, primarySpatialSchema),
);
const odataSource = sourceFromDescriptor<Parcel, "odata", typeof nonSpatialSchema>(
  descriptor(odata, nonSpatialSchema, nonSpatialExtent, nonTemporalExtent),
);
const ambiguousOgcSource = sourceFromDescriptor<Parcel, "ogc-features", typeof ambiguousSpatialSchema>(
  descriptor(ogcFeatures, ambiguousSpatialSchema),
);
const unavailableOgcSource = sourceFromDescriptor<Parcel, "ogc-features", typeof unavailableSchema>(
  descriptor(ogcFeatures, unavailableSchema),
);
const compositeOdataSource = sourceFromDescriptor<OdataParcel, "odata", typeof compositeOdataSchema>(
  compositeOdataDescriptor,
);

const derivedSpatiality: "primary-geometry" = ogcSource.spatiality;
const derivedNonSpatiality: "non-spatial" = odataSource.spatiality;
const derivedAmbiguousSpatiality: "ambiguous-geometry" = ambiguousOgcSource.spatiality;
void derivedSpatiality;
void derivedNonSpatiality;
void derivedAmbiguousSpatiality;

const cancellationSignal: AbortSignalLike = {
  aborted: false,
  addEventListener() {},
  removeEventListener() {},
};

export const unpagedResultState: PageResultState = {
  state: "complete",
  mode: "none",
  returned: 1,
  evidence: [{ kind: "unpaged", reference: "adapter:single-document" }],
};

export const unknownPageResultState: PageResultState = {
  state: "unknown",
  mode: "unknown",
  returned: 100,
  reason: "missing-completeness-evidence",
  evidence: [{ kind: "response-flag", reference: "exceededTransferLimit:absent" }],
};

export const offsetMoreResultState: PageResultState = {
  state: "more",
  mode: "offset",
  returned: 100,
  next: { kind: "offset", offset: 200, limit: 100 },
  evidence: [{ kind: "response-flag", reference: "hasMore:true" }],
};

export const exactFeatureCount: ResultCount<"matched-features"> = {
  state: "exact",
  scope: "matched-features",
  value: 42,
  evidence: [{ kind: "protocol", reference: "numberMatched" }],
};

export const estimatedFeatureCount: ResultCount<"matched-features"> = {
  state: "estimated",
  scope: "matched-features",
  value: 1_000_000,
  confidence: 0.95,
  evidence: [{ kind: "estimate", reference: "catalog-statistics" }],
};

export const unknownFeatureCount: ResultCount<"matched-features"> = {
  state: "unknown",
  scope: "matched-features",
  reason: "not-requested",
  evidence: [{ kind: "unavailable", reference: "query:count=false" }],
};

export const multipleGeometryFields: SourceGeometrySchema = {
  state: "known",
  primaryField: { state: "known", field: "footprint" },
  fields: [
    {
      field: "footprint",
      geometryTypes: { state: "known", type: "Polygon" },
      crs: crs84,
      layout: "xy",
      allowsEmpty: false,
    },
    {
      field: "centroid",
      geometryTypes: { state: "known", type: "Point" },
      crs: crs84,
      layout: "xy",
      allowsEmpty: true,
    },
  ],
};

export const wfsNoCrsGeometrySchema: SourceGeometrySchema = {
  state: "none",
  reason: "declared-non-spatial",
};

export const emptyGeometryWithoutInventedLayout: EmptyGeometryValue = {
  state: "empty",
  expectedType: "Polygon",
  crs: crs84,
  layout: "unknown",
};

export async function typedQueryProof(): Promise<void> {
  const defaultSpatialResult = await ogcSource.query({ kind: "features", select: ["parcelId"] as const });
  defaultSpatialResult.features[0]?.geometry;
  defaultSpatialResult.temporalExtent;
  defaultSpatialResult.schema.fingerprint;

  const unavailableSchemaResult = await unavailableOgcSource.query({
    kind: "features",
    select: ["parcelId"] as const,
  });
  unavailableSchemaResult.schema.provenance;

  const compositeIdentityResult = await compositeOdataSource.query({
    kind: "features",
    select: ["owner"] as const,
  });
  const compositeIdentity = compositeIdentityResult.features[0]?.identity;
  if (compositeIdentity) {
    compositeIdentity.parts[0].field;
    compositeIdentity.parts[0].value.toUpperCase();
    compositeIdentity.parts[1].field;
    compositeIdentity.parts[1].value.toUpperCase();
  }

  const nonSpatialResult = await odataSource.query({ kind: "features", select: ["parcelId"] as const });
  nonSpatialResult.features[0]?.identity.field;
  const nonSpatialFeature: { readonly properties: { readonly parcelId: string } } | undefined =
    nonSpatialResult.features[0];
  void nonSpatialFeature;

  const secondaryGeometryResult = await ogcSource.query({
    kind: "features",
    select: ["parcelId", "centroid"] as const,
    geometry: { field: "centroid" },
  });
  secondaryGeometryResult.features[0]?.geometry;

  const retainedSecondaryGeometry = await ogcSource.query({
    kind: "features",
    select: ["parcelId", "centroid"] as const,
    geometry: "omit",
  });
  retainedSecondaryGeometry.features[0]?.properties.centroid;

  const featureResult = await ogcSource.query({
    kind: "features",
    select: ["parcelId", "owner"] as const,
    geometry: "omit",
    filter: { op: "eq", field: "status", value: "active" },
    sort: [{ field: "owner", direction: "asc", nulls: "last" }],
    page: { kind: "first", limit: 100 },
  });

  const first = featureResult.features[0];
  if (first) {
    first.properties.parcelId;
    first.properties.owner;
  }

  const offsetPage = await ogcSource.query({
    kind: "features",
    select: ["parcelId"] as const,
    page: { kind: "offset", offset: 100, limit: 100 },
  });
  offsetPage.page;

  const opaqueFirstPage = await odataSource.query({
    kind: "features",
    select: ["parcelId"] as const,
    page: { kind: "first", limit: 50 },
  });
  if (
    opaqueFirstPage.page.state === "more" &&
    (opaqueFirstPage.page.mode === "cursor" || opaqueFirstPage.page.mode === "next-link")
  ) {
    await odataSource.query({
      kind: "features",
      select: ["parcelId"] as const,
      page: opaqueFirstPage.page.next,
    });
  }

  const aggregateResult = await ogcSource.query({
    kind: "aggregate",
    groupBy: ["status"] as const,
    metrics: [
      { fn: "count", as: "parcels" },
      { fn: "avg", field: "assessedValue", as: "meanValue" },
      { fn: "max", field: "updatedAt", as: "latestUpdate" },
    ] as const,
  });

  const aggregate = aggregateResult.rows[0];
  if (aggregate) {
    aggregate.status;
    aggregate.parcels.toFixed();
    aggregate.meanValue.toFixed(2);
    aggregate.latestUpdate.toUpperCase();
  }

  await geoservicesSource.query({
    kind: "features",
    filter: {
      kind: "native",
      dialect: "geoservices-sql92",
      payload: { format: "text", text: "STATUS = 'active'" },
    },
  });

  await odataSource.query({
    kind: "features",
    filter: {
      kind: "native",
      dialect: "odata-4.0",
      payload: { format: "text", text: "status eq 'active'" },
    },
  });

  await ogcSource.query({
    kind: "features",
    filter: {
      kind: "native",
      dialect: "cql2-json",
      payload: { format: "json", value: { op: "=", args: [{ property: "status" }, "active"] } },
    },
  });

  await ogcSource.query({
    kind: "features",
    filter: {
      op: "after",
      field: "updatedAt",
      value: { kind: "instant", value: "2026-07-13T00:00:00Z" },
    },
  });

  await ogcSource.query({
    kind: "features",
    filter: {
      op: "equals",
      geometry: {
        state: "present",
        geometry: { type: "Point", coordinates: [-157.86, 21.31] },
        crs: ogcUriCrsBinding,
        layout: "xy",
      },
    },
  });

  await ogcSource.query({
    kind: "features",
    outputCrs: geoParquetProjjsonBinding.definition,
  });

  await ogcSource.query(
    {
      kind: "features",
      filter: {
        op: "intersects",
        geometry: {
          state: "present",
          geometry: { type: "Point", coordinates: [-157.86, 21.31] },
          crs: crs84,
          layout: "xy",
        },
      },
    },
    { signal: cancellationSignal },
  );

  await ogcSource.query({
    kind: "features",
    filter: {
      op: "bbox-intersects",
      bbox: {
        box: { layout: "xy", bounds: [-158.3, 21.2, -157.6, 21.8] },
        crs: crs84,
      },
    },
  });

  await ogcSource.query({
    kind: "features",
    filter: {
      op: "within-distance",
      geometry: {
        state: "present",
        geometry: { type: "Point", coordinates: [-157.86, 21.31] },
        crs: crs84,
        layout: "xy",
      },
      distance: { value: 5, unit: "kilometre", mode: "geodesic" },
    },
  });

  await ambiguousOgcSource.query({
    kind: "features",
    geometry: { field: "centroid" },
    filter: {
      op: "intersects",
      field: "centroid",
      geometry: {
        state: "present",
        geometry: { type: "Point", coordinates: [-157.86, 21.31] },
        crs: crs84,
        layout: "xy",
      },
    },
  });
}
