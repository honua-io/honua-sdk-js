/**
 * Compile-only contract for the vendor-neutral source contract v2 decision.
 *
 * Nothing in this directory is exported by the package. These declarations
 * make the accepted design mechanically reviewable before #523, #525, and
 * #526 change production adapters or public exports.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Reverse-DNS identifiers are runtime-validated; the template prevents unqualified literals. */
export type ExtensionIdentifier = `${string}.${string}`;
export type ExtensionMap = Readonly<Record<ExtensionIdentifier, JsonValue>>;
export type IsoInstant = string;
export type Sha256 = `sha256:${string}`;
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

// ── Protocol-discriminated source locators ────────────────────────────────

export type BuiltInSourceProtocol =
  | "grpc"
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-image-service"
  | "geoservices-geometry-service"
  | "geoservices-gp-service"
  | "ogc-features"
  | "ogc-tiles"
  | "ogc-maps"
  | "ogc-records"
  | "stac"
  | "wfs"
  | "wms"
  | "wmts"
  | "odata"
  | "pmtiles"
  | "geoparquet"
  | "maplibre-vector"
  | "maplibre-raster"
  | "maplibre-geojson";

export type SourceProtocol = BuiltInSourceProtocol | ExtensionIdentifier;

export interface UrlResourceReference {
  readonly kind: "url";
  readonly href: string;
  readonly pattern?: "literal" | "glob";
}

export interface FileResourceReference {
  readonly kind: "file";
  /** Absolute Node path or caller-controlled glob; never accepted in browsers. */
  readonly path: string;
  readonly pattern?: "literal" | "glob";
}

export interface ResolverResourceReference {
  readonly kind: "resolver";
  readonly resolver: ExtensionIdentifier;
  readonly id: string;
  readonly options?: JsonObject;
}

/** Serializable identity for static assets; credentials belong to a resolver/auth provider. */
export type ResourceReference = UrlResourceReference | FileResourceReference | ResolverResourceReference;

export type LiteralResourceReference =
  | (Omit<UrlResourceReference, "pattern"> & { readonly pattern?: "literal" })
  | (Omit<FileResourceReference, "pattern"> & { readonly pattern?: "literal" })
  | ResolverResourceReference;

export type NetworkResourceReference =
  | (Omit<UrlResourceReference, "pattern"> & { readonly pattern?: "literal" })
  | ResolverResourceReference;

interface LocatorBase<TProtocol extends SourceProtocol> {
  readonly protocol: TProtocol;
  /** Credential-free HTTP(S) URL at the smallest stable service root. */
  readonly endpoint: string;
  readonly extensions?: ExtensionMap;
}

export interface GrpcSourceLocator extends LocatorBase<"grpc"> {
  readonly serviceId: string;
  readonly layerId: number;
}

export interface GeoServicesFeatureLocator extends LocatorBase<"geoservices-feature-service"> {
  /** `endpoint` ends in `/FeatureServer`; it does not include the layer id. */
  readonly layerId: number;
}

export interface GeoServicesMapLocator extends LocatorBase<"geoservices-map-service"> {
  /** `endpoint` ends in `/MapServer`; it does not include the layer id. */
  readonly layerId: number;
}

export interface GeoServicesImageLocator extends LocatorBase<"geoservices-image-service"> {
  /** Optional catalog layer. The ImageServer root is addressable without one. */
  readonly layerId?: number;
}

export interface GeoServicesGeometryLocator extends LocatorBase<"geoservices-geometry-service"> {}

export interface GeoServicesGpLocator extends LocatorBase<"geoservices-gp-service"> {
  readonly taskName: string;
}

export interface OgcFeaturesLocator extends LocatorBase<"ogc-features"> {
  readonly collectionId: string;
  /** Resolved descriptors never retain discovery-only `auto`. */
  readonly layout: "ogc-api" | "honua-facade";
}

export type OgcTilesLocator =
  | (LocatorBase<"ogc-tiles"> & {
      readonly scope: "dataset";
      readonly tileMatrixSetId?: string;
      readonly styleId?: string;
    })
  | (LocatorBase<"ogc-tiles"> & {
      readonly scope: "collection";
      readonly collectionId: string;
      readonly tileMatrixSetId?: string;
      readonly styleId?: string;
    });

export type OgcMapsLocator =
  | (LocatorBase<"ogc-maps"> & {
      readonly scope: "dataset";
      readonly styleId?: string;
    })
  | (LocatorBase<"ogc-maps"> & {
      readonly scope: "collection";
      readonly collectionId: string;
      readonly styleId?: string;
    });

export interface OgcRecordsLocator extends LocatorBase<"ogc-records"> {
  readonly catalogId: string;
}

export interface QualifiedName {
  readonly localName: string;
  readonly namespaceUri: string;
  /** Presentation-only prefix; identity is namespace URI plus local name. */
  readonly prefix?: string;
}

export interface WfsSourceLocator extends LocatorBase<"wfs"> {
  readonly version: "2.0.0";
  readonly featureType: QualifiedName;
}

export interface WmsSourceLocator extends LocatorBase<"wms"> {
  readonly version: "1.3.0";
  readonly layerName: string;
  readonly styleName?: string;
}

export interface WmtsSourceLocator extends LocatorBase<"wmts"> {
  readonly version: "1.0.0";
  readonly layerId: string;
  readonly tileMatrixSetId: string;
  readonly styleId?: string;
}

export interface OdataSourceLocator extends LocatorBase<"odata"> {
  /** Current certified adapter scope; later OData revisions require conformance evidence. */
  readonly version: "4.0";
  readonly entitySet: string;
}

export type StacSourceLocator =
  | (LocatorBase<"stac"> & {
      readonly scope: "api-catalog";
    })
  | (LocatorBase<"stac"> & {
      readonly scope: "api-collection";
      readonly collectionId: string;
    })
  | {
      readonly protocol: "stac";
      readonly scope: "static-document";
      readonly resource: LiteralResourceReference;
      readonly documentType: "catalog" | "collection" | "item";
      readonly extensions?: ExtensionMap;
    };

export interface PmtilesSourceLocator {
  readonly protocol: "pmtiles";
  readonly resource: LiteralResourceReference;
  readonly extensions?: ExtensionMap;
}

export interface GeoparquetSourceLocator {
  readonly protocol: "geoparquet";
  /** One or more files/globs read as a single logical relation. */
  readonly assets: NonEmptyReadonlyArray<ResourceReference>;
  readonly hivePartitioning?: boolean;
  readonly geometryColumn?: string;
  readonly geometryEncoding?:
    | "geoparquet-1.0-wkb"
    | "geoparquet-1.1-wkb"
    | "geoparquet-1.1-native-point"
    | "geoparquet-1.1-native-linestring"
    | "geoparquet-1.1-native-polygon"
    | "geoparquet-1.1-native-multipoint"
    | "geoparquet-1.1-native-multilinestring"
    | "geoparquet-1.1-native-multipolygon"
    | "duckdb-native"
    | "geojson-compat"
    | "wkb-compat";
  readonly geometryExecution?: "wkb" | "duckdb-native" | "geojson-compat";
  readonly geometrySpatialRuntimeAvailable?: boolean;
  readonly bboxColumn?: string;
  readonly extensions?: ExtensionMap;
}

export type MaplibreTileResource =
  | {
      readonly form: "tilejson";
      readonly resource: NetworkResourceReference;
    }
  | {
      readonly form: "templates";
      readonly templates: NonEmptyReadonlyArray<NetworkResourceReference>;
      readonly scheme?: "xyz" | "tms";
      readonly minZoom?: number;
      readonly maxZoom?: number;
    };

export interface MaplibreVectorSourceLocator {
  readonly protocol: "maplibre-vector";
  readonly tiles: MaplibreTileResource;
  readonly sourceLayer?: string;
  readonly extensions?: ExtensionMap;
}

export interface MaplibreRasterSourceLocator {
  readonly protocol: "maplibre-raster";
  readonly tiles: MaplibreTileResource;
  readonly tileSize?: 256 | 512;
  readonly extensions?: ExtensionMap;
}

export interface MaplibreGeojsonSourceLocator {
  readonly protocol: "maplibre-geojson";
  readonly resource: LiteralResourceReference;
  readonly extensions?: ExtensionMap;
}

export interface ExtensionSourceLocator<TProtocol extends ExtensionIdentifier = ExtensionIdentifier> {
  readonly protocol: TProtocol;
  readonly resource: ResourceReference;
  readonly extension: {
    readonly locatorVersion: string;
    readonly payload: JsonObject;
  };
  readonly extensions?: ExtensionMap;
}

export type BuiltInSourceLocator =
  | GrpcSourceLocator
  | GeoServicesFeatureLocator
  | GeoServicesMapLocator
  | GeoServicesImageLocator
  | GeoServicesGeometryLocator
  | GeoServicesGpLocator
  | OgcFeaturesLocator
  | OgcTilesLocator
  | OgcMapsLocator
  | OgcRecordsLocator
  | StacSourceLocator
  | WfsSourceLocator
  | WmsSourceLocator
  | WmtsSourceLocator
  | OdataSourceLocator
  | PmtilesSourceLocator
  | GeoparquetSourceLocator
  | MaplibreVectorSourceLocator
  | MaplibreRasterSourceLocator
  | MaplibreGeojsonSourceLocator;

export type SourceLocatorV2 = BuiltInSourceLocator | ExtensionSourceLocator;

export type LocatorFor<TProtocol extends SourceProtocol> = TProtocol extends BuiltInSourceProtocol
  ? Extract<BuiltInSourceLocator, { readonly protocol: TProtocol }>
  : TProtocol extends ExtensionIdentifier
    ? ExtensionSourceLocator<TProtocol>
    : never;

// ── Native provenance and extension preservation ──────────────────────────

export interface NativeTypeReference {
  readonly protocol: SourceProtocol;
  readonly name: string;
  readonly namespace?: string;
  readonly path?: readonly string[];
  /** Sanitized, bounded metadata only; raw documents stay on native surfaces. */
  readonly definition?: JsonValue;
}

export interface MetadataProvenance {
  readonly method: "observed" | "declared" | "standard-default" | "inferred" | "unavailable";
  readonly protocol: SourceProtocol;
  readonly source: string;
  readonly observedAt?: IsoInstant;
  readonly validator?:
    | { readonly kind: "etag"; readonly value: string }
    | { readonly kind: "last-modified"; readonly value: string }
    | { readonly kind: "version"; readonly value: string };
  readonly detail?: string;
}

// ── CRS, axis order, geometry, and extent ─────────────────────────────────

export type AxisDirection = "east" | "west" | "north" | "south" | "up" | "down" | "future" | "past" | "other";

export interface CoordinateAxis {
  readonly name: string;
  readonly abbreviation?: string;
  readonly direction: AxisDirection;
  readonly unit: string;
}

export type AxisOrder =
  | {
      readonly state: "known";
      readonly source: "crs-definition" | "protocol" | "encoding" | "declared";
      readonly axes: readonly [CoordinateAxis, CoordinateAxis, ...CoordinateAxis[]];
    }
  | {
      readonly state: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type CrsDefinition =
  | {
      readonly kind: "authority";
      readonly authority: string;
      readonly code: string;
      readonly version?: string;
      readonly uri?: string;
      readonly wkt?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "wkt";
      readonly wkt: string;
      readonly dialect: "wkt1" | "wkt2" | "unknown";
      readonly validation: "unverified" | "engine";
      readonly name?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      /** Canonical absolute CRS URI when no reviewed authority/code split is available. */
      readonly kind: "uri";
      readonly uri: string;
      readonly name?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      /** Bounded, RFC 8785-canonicalizable PROJJSON definition. */
      readonly kind: "projjson";
      readonly projjson: JsonObject;
      readonly name?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type ResolvedCrsDefinition =
  | Exclude<CrsDefinition, { readonly kind: "unknown" | "wkt" }>
  | (Extract<CrsDefinition, { readonly kind: "wkt" }> & { readonly validation: "engine" });

export interface ReprojectionRecord {
  readonly source: ResolvedCrsDefinition;
  readonly target: ResolvedCrsDefinition;
  readonly operation?: string;
  readonly engine: string;
  readonly accuracyMeters?: number;
  readonly transformedAt?: IsoInstant;
}

export type CrsProvenance =
  | {
      readonly method: "metadata" | "payload" | "standard-default" | "declared";
      readonly native?: NativeTypeReference;
    }
  | {
      readonly method: "reprojected";
      readonly native?: NativeTypeReference;
      readonly reprojection: ReprojectionRecord;
    };

export interface CrsBinding {
  readonly definition: CrsDefinition;
  /** Order of numbers in this payload, independent of definition axis order. */
  readonly coordinateOrder: AxisOrder;
  readonly coordinateEpoch?: number;
  readonly provenance: CrsProvenance;
}

export type KnownAxisOrder = Extract<AxisOrder, { readonly state: "known" }>;

/** CRS/order knowledge required before a geometry can enter spatial execution. */
export interface ExecutableCrsBinding {
  readonly definition: ResolvedCrsDefinition;
  readonly coordinateOrder: KnownAxisOrder;
  readonly coordinateEpoch?: number;
  readonly provenance: CrsProvenance;
}

export type CoordinateLayout = "xy" | "xyz" | "xym" | "xyzm";
export type Position2D = readonly [number, number];
export type Position3D = readonly [number, number, number];
export type Position4D = readonly [number, number, number, number];
export type Position = Position2D | Position3D | Position4D;
export type LinePositions<TPosition extends Position = Position> = readonly [TPosition, TPosition, ...TPosition[]];
export type LinearRing<TPosition extends Position = Position> = readonly [
  TPosition,
  TPosition,
  TPosition,
  TPosition,
  ...TPosition[],
];

export interface PointGeometry<TPosition extends Position = Position> {
  readonly type: "Point";
  readonly coordinates: TPosition;
}

export interface MultiPointGeometry<TPosition extends Position = Position> {
  readonly type: "MultiPoint";
  readonly coordinates: NonEmptyReadonlyArray<TPosition>;
}

export interface LineStringGeometry<TPosition extends Position = Position> {
  readonly type: "LineString";
  readonly coordinates: LinePositions<TPosition>;
}

export interface MultiLineStringGeometry<TPosition extends Position = Position> {
  readonly type: "MultiLineString";
  readonly coordinates: NonEmptyReadonlyArray<LinePositions<TPosition>>;
}

export interface PolygonGeometry<TPosition extends Position = Position> {
  readonly type: "Polygon";
  readonly coordinates: NonEmptyReadonlyArray<LinearRing<TPosition>>;
}

export interface MultiPolygonGeometry<TPosition extends Position = Position> {
  readonly type: "MultiPolygon";
  readonly coordinates: NonEmptyReadonlyArray<NonEmptyReadonlyArray<LinearRing<TPosition>>>;
}

export interface GeometryCollectionGeometry<TPosition extends Position = Position> {
  readonly type: "GeometryCollection";
  readonly geometries: NonEmptyReadonlyArray<CanonicalGeometry<TPosition>>;
}

/** Known, executable geometry shapes. There is deliberately no unknown member. */
export type CanonicalGeometry<TPosition extends Position = Position> =
  | PointGeometry<TPosition>
  | MultiPointGeometry<TPosition>
  | LineStringGeometry<TPosition>
  | MultiLineStringGeometry<TPosition>
  | PolygonGeometry<TPosition>
  | MultiPolygonGeometry<TPosition>
  | GeometryCollectionGeometry<TPosition>;

export type GeometryKind = CanonicalGeometry["type"];

export type PresentGeometryWithCrs<TCrs extends CrsBinding | ExecutableCrsBinding> =
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position2D>;
      readonly crs: TCrs;
      readonly layout: "xy";
    }
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position3D>;
      readonly crs: TCrs;
      readonly layout: "xyz" | "xym";
    }
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position4D>;
      readonly crs: TCrs;
      readonly layout: "xyzm";
    };

export type PresentGeometryValue = PresentGeometryWithCrs<CrsBinding>;
export type ExecutableGeometryValue = PresentGeometryWithCrs<ExecutableCrsBinding>;

export interface EmptyGeometryValue {
  readonly state: "empty";
  readonly expectedType?: GeometryKind;
  readonly crs: CrsBinding;
  /** Empty values have no tuple from which to infer layout. */
  readonly layout: CoordinateLayout | "unknown";
}

/** Missing projection omits the property; a returned empty geometry uses `state: empty`. */
export type GeometryValue = PresentGeometryValue | EmptyGeometryValue;

export type GeometryTypeKnowledge =
  | { readonly state: "known"; readonly type: GeometryKind }
  | {
      readonly state: "mixed";
      readonly types: readonly [GeometryKind, GeometryKind, ...GeometryKind[]];
    }
  | {
      readonly state: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting" | "unsupported";
      readonly native?: NativeTypeReference;
    };

export interface GeometryFieldSchema {
  readonly field: string;
  readonly geometryTypes: GeometryTypeKnowledge;
  readonly crs: CrsBinding;
  readonly layout: CoordinateLayout | "unknown";
  readonly allowsEmpty: boolean | "unknown";
}

export type PrimaryGeometryField =
  | { readonly state: "known"; readonly field: string }
  | { readonly state: "none"; readonly reason: "not-declared" | "no-default" }
  | {
      readonly state: "unknown";
      readonly reason: "metadata-unavailable" | "conflicting";
    };

export type SourceGeometrySchema =
  | { readonly state: "none"; readonly reason: "declared-non-spatial" | "no-geometry-fields" }
  | {
      readonly state: "known";
      readonly fields: NonEmptyReadonlyArray<GeometryFieldSchema>;
      readonly primaryField: PrimaryGeometryField;
    }
  | {
      readonly state: "unknown";
      readonly reason: "metadata-unavailable" | "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type BoundingBox =
  | {
      readonly layout: "xy";
      readonly bounds: readonly [number, number, number, number];
    }
  | {
      /** Spatial XYZ only. Measures/time never occupy canonical bbox ordinates. */
      readonly layout: "xyz";
      readonly bounds: readonly [number, number, number, number, number, number];
    };

export interface ExecutableBoundingBox {
  readonly box: BoundingBox;
  readonly crs: ExecutableCrsBinding;
}

export type SpatialExtent =
  | {
      readonly state: "known";
      readonly boxes: NonEmptyReadonlyArray<BoundingBox>;
      readonly crs: CrsBinding;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "empty";
      readonly reason: "empty-source" | "empty-result" | "all-geometries-empty";
      readonly crs: CrsBinding;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "mixed";
      readonly extents: readonly [
        Extract<SpatialExtent, { readonly state: "known" | "empty" }>,
        Extract<SpatialExtent, { readonly state: "known" | "empty" }>,
        ...Extract<SpatialExtent, { readonly state: "known" | "empty" }>[],
      ];
      readonly reason: "multiple-crs";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "not-computed" | "invalid";
      readonly native?: NativeTypeReference;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "none";
      readonly reason: "non-spatial";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

export type TemporalReferenceSystem =
  | { readonly kind: "gregorian" }
  | { readonly kind: "uri"; readonly uri: string }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

/** Null is an explicitly open lower/upper bound, never an invented date. */
export type TemporalInterval = readonly [string | null, string | null];

export type TemporalExtent =
  | {
      readonly state: "known";
      readonly intervals: NonEmptyReadonlyArray<TemporalInterval>;
      readonly referenceSystem: TemporalReferenceSystem;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "empty";
      readonly reason: "empty-source" | "empty-result" | "no-temporal-values";
      readonly referenceSystem?: TemporalReferenceSystem;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "not-computed" | "invalid" | "conflicting";
      readonly native?: NativeTypeReference;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "none";
      readonly reason: "non-temporal";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

// ── Logical fields and source schema ──────────────────────────────────────

export type IntegerWidth = 8 | 16 | 32 | 64;
export type FloatWidth = 32 | 64;
export type TemporalUnit = "second" | "millisecond" | "microsecond" | "nanosecond";

export type LogicalType =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "integer";
      readonly bits: IntegerWidth;
      readonly signed: boolean;
      /** Int64/uint64 values may require decimal strings in JSON. */
      readonly jsonEncoding: "number" | "string";
    }
  | { readonly kind: "float"; readonly bits: FloatWidth }
  | {
      readonly kind: "decimal";
      readonly precision?: number;
      readonly scale?: number;
      readonly jsonEncoding: "number" | "string";
    }
  | { readonly kind: "string"; readonly maxLength?: number; readonly encoding?: string }
  | { readonly kind: "binary"; readonly encoding: "base64" | "url" | "opaque" }
  | { readonly kind: "uuid" }
  | { readonly kind: "date" }
  | { readonly kind: "time"; readonly unit: TemporalUnit }
  | {
      readonly kind: "timestamp";
      readonly unit: TemporalUnit;
      readonly timezone: "utc" | "offset" | "local" | "unknown";
    }
  | { readonly kind: "duration"; readonly unit: TemporalUnit }
  | { readonly kind: "json" }
  | { readonly kind: "geometry" }
  | { readonly kind: "list"; readonly element: LogicalType }
  | { readonly kind: "struct"; readonly fields: readonly LogicalField[] }
  | {
      readonly kind: "union";
      readonly members: readonly [LogicalType, LogicalType, ...LogicalType[]];
    }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting" | "unsupported";
      readonly native?: NativeTypeReference;
    };

export type BuiltInFieldRole =
  | "primary-key"
  | "feature-id"
  | "geometry"
  | "time-instant"
  | "time-start"
  | "time-end"
  | "created-at"
  | "updated-at";

export type FieldRole = BuiltInFieldRole | ExtensionIdentifier;

export type DomainValue = Exclude<JsonPrimitive, null>;
export type OrderedDomainValue = string | number;

export interface CodedDomainValue {
  readonly value: DomainValue;
  readonly label?: string;
  readonly description?: string;
  readonly extensions?: ExtensionMap;
}

export interface RangeEndpoint {
  readonly value: OrderedDomainValue;
  readonly inclusive: boolean;
}

export type FieldValueDomain =
  | { readonly state: "none"; readonly reason: "unconstrained" | "not-applicable" }
  | {
      readonly state: "coded";
      readonly values: NonEmptyReadonlyArray<CodedDomainValue>;
      readonly openness: "closed" | "open" | "unknown";
    }
  | ({
      readonly state: "range";
      readonly unit?: string;
    } & (
      | { readonly minimum: RangeEndpoint; readonly maximum?: RangeEndpoint }
      | { readonly minimum?: never; readonly maximum: RangeEndpoint }
    ))
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "unrecognized" | "conflicting" | "limit-exceeded";
      readonly native?: NativeTypeReference;
    };

export type FieldConstraint =
  | { readonly kind: "length"; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: "pattern"; readonly syntax: "ecma-262"; readonly expression: string; readonly flags?: string }
  | { readonly kind: "multiple-of"; readonly value: number }
  | { readonly kind: "unique" }
  | { readonly kind: ExtensionIdentifier; readonly value: JsonValue };

export type FieldConstraintState =
  | { readonly state: "none" }
  | { readonly state: "known"; readonly values: NonEmptyReadonlyArray<FieldConstraint> }
  | {
      readonly state: "partial";
      readonly values: NonEmptyReadonlyArray<FieldConstraint>;
      readonly reason: "unrecognized" | "conflicting" | "limit-exceeded";
      readonly native: NonEmptyReadonlyArray<NativeTypeReference>;
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "unrecognized" | "conflicting" | "limit-exceeded";
      readonly native?: NativeTypeReference;
    };

export interface LogicalField {
  /** Stable logical name used by typed query fields. */
  readonly name: string;
  /** Native/nested path segments, e.g. an OData complex property path. */
  readonly path: NonEmptyReadonlyArray<string>;
  readonly title?: string;
  readonly description?: string;
  readonly type: LogicalType;
  readonly nullability: "nullable" | "non-nullable" | "unknown";
  readonly mutability: "read-only" | "read-write" | "write-once" | "unknown";
  readonly roles: readonly FieldRole[];
  readonly defaultValue?: JsonValue;
  readonly domain: FieldValueDomain;
  readonly constraints: FieldConstraintState;
  readonly native: readonly NativeTypeReference[];
  readonly extensions?: ExtensionMap;
}

export type KeyDefinition =
  | { readonly state: "known"; readonly fields: NonEmptyReadonlyArray<string> }
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly reason: "metadata-unavailable" | "not-declared" | "conflicting" };

export type TemporalSchema =
  | { readonly state: "none" }
  | { readonly state: "instant"; readonly field: string }
  | { readonly state: "interval"; readonly startField: string; readonly endField: string }
  | { readonly state: "mixed"; readonly fields: NonEmptyReadonlyArray<string> }
  | { readonly state: "unknown"; readonly reason: "metadata-unavailable" | "not-declared" | "conflicting" };

export interface SourceSchemaV2 {
  readonly kind: "honua.source-schema";
  readonly version: "2.0";
  readonly fingerprint: Sha256;
  /** Zero fields means an observed empty schema, not unavailable metadata. */
  readonly fields: readonly LogicalField[];
  readonly key: KeyDefinition;
  readonly geometry: SourceGeometrySchema;
  readonly temporal: TemporalSchema;
  readonly openContent: "closed" | "open" | "unknown";
  readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
  readonly extensions?: ExtensionMap;
}

export type SchemaState<TSchema extends SourceSchemaV2 = SourceSchemaV2> =
  | { readonly state: "known"; readonly value: TSchema }
  | {
      readonly state: "unavailable";
      readonly reason: "not-requested" | "request-failed" | "not-advertised" | "invalid";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

export type SchemaIdentity =
  | { readonly state: "known"; readonly fingerprint: Sha256 }
  | {
      readonly state: "unavailable";
      readonly reason: "not-requested" | "request-failed" | "not-advertised" | "invalid";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

export type SchemaIdentityFor<TSchemaState extends SchemaState> = TSchemaState extends {
  readonly state: "known";
  readonly value: infer TSchema extends SourceSchemaV2;
}
  ? { readonly state: "known"; readonly fingerprint: TSchema["fingerprint"] }
  : TSchemaState extends Extract<SchemaState, { readonly state: "unavailable" }>
    ? {
        readonly state: "unavailable";
        readonly reason: TSchemaState["reason"];
        readonly provenance: TSchemaState["provenance"];
      }
    : never;

// ── JSON-safe claimed/observed/effective capabilities ─────────────────────

export type BuiltInCapabilityId =
  | "query"
  | "queryAggregate"
  | "spatialAggregate"
  | "queryExtent"
  | "queryObjectIds"
  | "queryRelated"
  | "applyEdits"
  | "attachments"
  | "render"
  | "tiles"
  | "sql"
  | "stream"
  | "pbf"
  | "image"
  | "geometry"
  | "geoprocess"
  | "processes";

export type CapabilityId = BuiltInCapabilityId | ExtensionIdentifier;
export type CapabilityTruth = "supported" | "unsupported" | "unknown";

export interface CapabilityEvidence {
  readonly kind: "protocol-default" | "metadata" | "conformance" | "probe" | "declaration";
  readonly truth: CapabilityTruth;
  readonly reference: string;
  readonly observedAt?: IsoInstant;
  readonly sourceFingerprint?: Sha256;
}

export type EffectiveCapabilityState =
  | "supported"
  | "unsupported"
  | "unknown"
  | "policy-disabled"
  | "peer-unavailable"
  | "authorization-required";

export type PaginationMode = "offset" | "cursor" | "next-link";

export interface CapabilityDecision {
  readonly id: CapabilityId;
  readonly claimed: CapabilityTruth;
  readonly observed: CapabilityTruth | "not-observed";
  readonly effective: EffectiveCapabilityState;
  readonly evidence: readonly CapabilityEvidence[];
  readonly reasons: readonly string[];
  /** Stable scope identifiers only; never credentials or tokens. */
  readonly authorizationScopes?: readonly string[];
  /** Machine-readable operation limits used by validation and planning. */
  readonly constraints?: CapabilityConstraints;
}

export interface CapabilityConstraints {
  readonly inputFormats?: readonly string[];
  readonly outputFormats?: readonly string[];
  readonly filterOperators?: readonly FilterOperatorId[];
  readonly spatialPredicates?: readonly SpatialPredicate[];
  readonly temporalPredicates?: readonly TemporalPredicate[];
  readonly supportedCrs?: readonly ResolvedCrsDefinition[];
  readonly pagination?: {
    readonly modes: readonly PaginationMode[];
    readonly maxPageSize?: number;
  };
  readonly limits?: {
    readonly maxRecords?: number;
    readonly maxRequestBytes?: number;
    readonly maxResponseBytes?: number;
  };
  readonly extensions?: ExtensionMap;
}

export interface CapabilityProfile {
  readonly kind: "honua.capabilities";
  readonly version: "1.0";
  readonly fingerprint: Sha256;
  /** Sorted by id with no duplicates; arrays replace the current Set. */
  readonly entries: readonly CapabilityDecision[];
}

// ── Serializable descriptor and invalidation identity ─────────────────────

export interface DescriptorIdentity<TSchemaIdentity extends SchemaIdentity = SchemaIdentity> {
  readonly descriptorFingerprint: Sha256;
  readonly schema: TSchemaIdentity;
  readonly capabilityFingerprint: Sha256;
  readonly sourceRevision?: string;
  /** Opaque hash/identifier for authorization partitioning, never a token. */
  readonly authorizationContextId?: string;
}

export interface SourceDescriptorV2<
  TProtocol extends SourceProtocol = SourceProtocol,
  TSchemaState extends SchemaState = SchemaState,
> {
  readonly kind: "honua.source-descriptor";
  readonly version: "2.0";
  readonly id: string;
  readonly locator: LocatorFor<TProtocol>;
  readonly schema: TSchemaState;
  readonly extent: SpatialExtent;
  readonly temporalExtent: TemporalExtent;
  readonly capabilities: CapabilityProfile;
  readonly identity: DescriptorIdentity<SchemaIdentityFor<TSchemaState>>;
  readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
  readonly attribution?: string;
  readonly extensions?: ExtensionMap;
}

// ── Typed semantic query and result relationship ──────────────────────────

export type FieldName<TRecord> = Extract<keyof TRecord, string>;
type NonNullish<T> = Exclude<T, null | undefined>;
type Scalar = string | number | boolean | bigint | Date;

export type ScalarFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: NonNullish<TRecord[TKey]> extends Scalar ? TKey : never;
}[FieldName<TRecord>];

export type GroupableFieldName<TRecord> = ScalarFieldName<TRecord>;

export type StringFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: NonNullish<TRecord[TKey]> extends string ? TKey : never;
}[FieldName<TRecord>];

export type OrderableFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: NonNullish<TRecord[TKey]> extends string | number | bigint | Date ? TKey : never;
}[FieldName<TRecord>];

export type NumericFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: NonNullish<TRecord[TKey]> extends number | bigint ? TKey : never;
}[FieldName<TRecord>];

declare const temporalValueBrand: unique symbol;

/** Schema/role-derived temporal string; ordinary strings never gain temporal operators. */
export type TemporalValue<TKind extends "date" | "instant" = "date" | "instant"> = string & {
  readonly [temporalValueBrand]: TKind;
};

export type TemporalFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: NonNullish<TRecord[TKey]> extends TemporalValue | Date ? TKey : never;
}[FieldName<TRecord>];

export type GeometryFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: NonNullish<TRecord[TKey]> extends GeometryValue ? TKey : never;
}[FieldName<TRecord>];

export type QueryLiteral<TValue> = NonNullish<TValue> extends bigint | Date
  ? string
  : NonNullish<TValue> extends JsonPrimitive
    ? NonNullish<TValue>
    : JsonValue;

type EqualityExpression<TRecord> = {
  [TKey in ScalarFieldName<TRecord>]: {
    readonly op: "eq" | "ne";
    readonly field: TKey;
    readonly value: QueryLiteral<TRecord[TKey]>;
  };
}[ScalarFieldName<TRecord>];

type OrderedExpression<TRecord> = {
  [TKey in OrderableFieldName<TRecord>]: {
    readonly op: "lt" | "lte" | "gt" | "gte";
    readonly field: TKey;
    readonly value: QueryLiteral<TRecord[TKey]>;
  };
}[OrderableFieldName<TRecord>];

type InExpression<TRecord> = {
  [TKey in ScalarFieldName<TRecord>]: {
    readonly op: "in";
    readonly field: TKey;
    readonly values: NonEmptyReadonlyArray<QueryLiteral<TRecord[TKey]>>;
  };
}[ScalarFieldName<TRecord>];

type BetweenExpression<TRecord> = {
  [TKey in OrderableFieldName<TRecord>]: {
    readonly op: "between";
    readonly field: TKey;
    readonly lower: QueryLiteral<TRecord[TKey]>;
    readonly upper: QueryLiteral<TRecord[TKey]>;
  };
}[OrderableFieldName<TRecord>];

export interface TemporalLiteral {
  readonly kind: "date" | "instant" | "interval";
  readonly value: string | readonly [string, string];
}

export type TopologicalSpatialPredicate =
  | "equals"
  | "intersects"
  | "within"
  | "contains"
  | "disjoint"
  | "touches"
  | "overlaps"
  | "crosses";
export type DistanceSpatialPredicate = "within-distance" | "beyond-distance";
export type SpatialPredicate = TopologicalSpatialPredicate | "bbox-intersects" | DistanceSpatialPredicate;
export type DistanceUnit =
  | "metre"
  | "kilometre"
  | "foot"
  | "us-survey-foot"
  | "mile"
  | "nautical-mile"
  | "degree"
  | "radian";

export interface DistanceOperand {
  readonly value: number;
  readonly unit: DistanceUnit;
  readonly mode: "planar" | "geodesic";
}
export type TemporalPredicate = "before" | "after" | "during" | "time-intersects";
export type BuiltInFilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "between"
  | "is-null"
  | "is-not-null"
  | "like"
  | "and"
  | "or"
  | "not"
  | SpatialPredicate
  | TemporalPredicate;
export type FilterOperatorId = BuiltInFilterOperator | ExtensionIdentifier;

type SpatialOperandExpression =
  | {
      readonly op: TopologicalSpatialPredicate;
      readonly geometry: ExecutableGeometryValue;
    }
  | {
      readonly op: "bbox-intersects";
      readonly bbox: ExecutableBoundingBox;
    }
  | {
      readonly op: DistanceSpatialPredicate;
      readonly geometry: ExecutableGeometryValue;
      readonly distance: DistanceOperand;
    };

type SpatialExpressionFor<TRecord, TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? never
  : SpatialOperandExpression &
      (TSpatiality extends "primary-geometry"
        ? { readonly field?: GeometryFieldName<TRecord> }
        : {
            /** Ambiguous/multi-geometry sources must name the geometry field. */
            readonly field: GeometryFieldName<TRecord>;
          });

export type SemanticFilter<TRecord, TSpatiality extends SourceSpatiality> =
  | EqualityExpression<TRecord>
  | OrderedExpression<TRecord>
  | InExpression<TRecord>
  | BetweenExpression<TRecord>
  | { readonly op: "is-null" | "is-not-null"; readonly field: FieldName<TRecord> }
  | {
      readonly op: "like";
      readonly field: StringFieldName<TRecord>;
      readonly pattern: string;
      readonly caseSensitive?: boolean;
    }
  | SpatialExpressionFor<TRecord, TSpatiality>
  | {
      readonly op: TemporalPredicate;
      readonly field: TemporalFieldName<TRecord>;
      readonly value: TemporalLiteral;
    }
  | {
      readonly op: "and" | "or";
      readonly args: NonEmptyReadonlyArray<SemanticFilter<TRecord, TSpatiality>>;
    }
  | { readonly op: "not"; readonly arg: SemanticFilter<TRecord, TSpatiality> };

export type BuiltInNativeDialect =
  | "honua-grpc"
  | "geoservices-sql92"
  | "cql2-json"
  | "cql2-text"
  | "fes-2.0"
  | "odata-4.0"
  | "duckdb-sql";

export type NativeDialectFor<TProtocol extends SourceProtocol> = TProtocol extends "grpc"
  ? "honua-grpc"
  : TProtocol extends "geoservices-feature-service" | "geoservices-map-service" | "geoservices-image-service"
    ? "geoservices-sql92"
    : TProtocol extends "ogc-features" | "ogc-records" | "stac"
      ? "cql2-json" | "cql2-text"
      : TProtocol extends "wfs"
        ? "fes-2.0"
        : TProtocol extends "odata"
          ? "odata-4.0"
          : TProtocol extends "geoparquet"
            ? "duckdb-sql"
            : TProtocol extends ExtensionIdentifier
              ? `${TProtocol}.${string}`
              : never;

export type NativePayloadFor<TDialect extends BuiltInNativeDialect | ExtensionIdentifier> = TDialect extends
  | "cql2-json"
  | "honua-grpc"
  ? { readonly format: "json"; readonly value: JsonValue }
  : TDialect extends "fes-2.0"
    ? { readonly format: "xml"; readonly text: string }
    : TDialect extends "geoservices-sql92" | "cql2-text" | "odata-4.0" | "duckdb-sql"
      ? { readonly format: "text"; readonly text: string }
      : TDialect extends ExtensionIdentifier
        ?
            | { readonly format: "text" | "xml"; readonly text: string }
            | { readonly format: "json"; readonly value: JsonValue }
        : never;

export type NativeFilter<TDialect extends BuiltInNativeDialect | ExtensionIdentifier> = TDialect extends
  | BuiltInNativeDialect
  | ExtensionIdentifier
  ? {
      readonly kind: "native";
      readonly dialect: TDialect;
      readonly payload: NativePayloadFor<TDialect>;
    }
  : never;

export type QueryFilter<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> =
  | SemanticFilter<TRecord, TSpatiality>
  | (NativeDialectFor<TProtocol> extends never ? never : NativeFilter<NativeDialectFor<TProtocol>>);

export interface Sort<TRecord> {
  readonly field: OrderableFieldName<TRecord>;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last" | "native";
}

export type CountMetric<TRecord, TAlias extends string = string> = {
  readonly fn: "count";
  readonly field?: FieldName<TRecord>;
  readonly as: TAlias;
};

export type NumericMetric<TRecord, TAlias extends string = string> = {
  readonly fn: "sum" | "avg" | "stddev" | "variance";
  readonly field: NumericFieldName<TRecord>;
  readonly as: TAlias;
};

export type ExtremumMetric<TRecord, TAlias extends string = string> = {
  readonly fn: "min" | "max";
  readonly field: OrderableFieldName<TRecord>;
  readonly as: TAlias;
};

export type AggregateMetric<TRecord, TAlias extends string = string> =
  | CountMetric<TRecord, TAlias>
  | NumericMetric<TRecord, TAlias>
  | ExtremumMetric<TRecord, TAlias>;

export type SourceSpatiality = "primary-geometry" | "non-spatial" | "ambiguous-geometry";

export type SpatialityForGeometry<TGeometry extends SourceGeometrySchema> = TGeometry extends { readonly state: "none" }
  ? "non-spatial"
  : TGeometry extends {
        readonly state: "known";
        readonly primaryField: { readonly state: "known" };
      }
    ? "primary-geometry"
    : "ambiguous-geometry";

/** A validated projection of descriptor schema state, never a second caller-selected truth. */
export type SpatialityForSchemaState<TSchemaState extends SchemaState> = TSchemaState extends {
  readonly state: "known";
  readonly value: infer TSchema extends SourceSchemaV2;
}
  ? SpatialityForGeometry<TSchema["geometry"]>
  : "ambiguous-geometry";

export type GeometryProjectionFor<TRecord, TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? "omit"
  : TSpatiality extends "primary-geometry"
    ? "include" | "omit" | { readonly field: GeometryFieldName<TRecord> }
    : "omit" | { readonly field: GeometryFieldName<TRecord> };

export type OutputCrsFor<TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? never
  : ResolvedCrsDefinition;

declare const pageContinuationBrand: unique symbol;

export interface ContinuationBinding {
  readonly descriptorFingerprint: Sha256;
  /** Canonical semantic query fingerprint with page/execution options removed. */
  readonly queryFingerprint: Sha256;
}

/**
 * Public metadata for a process/runtime-owned continuation. Raw cursor and
 * next-link bytes live in a private vault keyed by this branded object.
 */
export interface PageContinuation<TMode extends "cursor" | "next-link" = "cursor" | "next-link"> {
  readonly kind: "honua.page-continuation";
  readonly mode: TMode;
  readonly binding: ContinuationBinding;
  readonly expiresAt?: IsoInstant;
  readonly [pageContinuationBrand]: true;
}

export interface FirstPageRequest {
  readonly kind: "first";
  readonly limit?: number;
}

export interface OffsetPageRequest {
  readonly kind: "offset";
  readonly offset: number;
  readonly limit?: number;
}

export interface ContinuationPageRequest<TMode extends "cursor" | "next-link" = "cursor" | "next-link"> {
  readonly kind: "continuation";
  readonly continuation: PageContinuation<TMode>;
}

export type PageRequest = FirstPageRequest | OffsetPageRequest | ContinuationPageRequest;

export interface PageEvidence {
  readonly kind: "protocol-contract" | "response-flag" | "continuation" | "short-page" | "unpaged";
  /** Sanitized requirement/field name; never raw cursor or next-link data. */
  readonly reference: string;
}

export type PageResultState =
  | {
      readonly state: "complete";
      readonly mode: PaginationMode | "none";
      readonly returned: number;
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    }
  | {
      readonly state: "more";
      readonly mode: "offset";
      readonly returned: number;
      readonly next: OffsetPageRequest;
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    }
  | {
      readonly state: "more";
      readonly mode: "cursor";
      readonly returned: number;
      readonly next: ContinuationPageRequest<"cursor">;
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    }
  | {
      readonly state: "more";
      readonly mode: "next-link";
      readonly returned: number;
      readonly next: ContinuationPageRequest<"next-link">;
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    }
  | {
      readonly state: "unknown";
      readonly mode: PaginationMode | "none" | "unknown";
      readonly returned: number;
      readonly reason:
        | "missing-completeness-evidence"
        | "conflicting-completeness-evidence"
        | "invalid-continuation-evidence";
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    };

interface QueryBase<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> {
  readonly filter?: QueryFilter<TRecord, TProtocol, TSpatiality>;
  readonly sort?: readonly Sort<TRecord>[];
  readonly page?: PageRequest;
  readonly outputCrs?: OutputCrsFor<TSpatiality>;
}

export interface FeatureQuery<
  TRecord,
  TProtocol extends SourceProtocol,
  TSpatiality extends SourceSpatiality,
  TSelect extends readonly FieldName<TRecord>[] | undefined = undefined,
  TGeometry extends GeometryProjectionFor<TRecord, TSpatiality> = GeometryProjectionFor<TRecord, TSpatiality>,
> extends QueryBase<TRecord, TProtocol, TSpatiality> {
  readonly kind: "features";
  readonly select?: TSelect;
  readonly geometry?: TGeometry;
}

export interface AggregateQuery<
  TRecord,
  TProtocol extends SourceProtocol,
  TSpatiality extends SourceSpatiality,
  TGroupBy extends readonly GroupableFieldName<TRecord>[] = readonly [],
  TMetrics extends NonEmptyReadonlyArray<AggregateMetric<TRecord>> = NonEmptyReadonlyArray<AggregateMetric<TRecord>>,
> extends QueryBase<TRecord, TProtocol, TSpatiality> {
  readonly kind: "aggregate";
  readonly groupBy: TGroupBy;
  readonly metrics: TMetrics;
}

export type QueryV2<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> =
  | FeatureQuery<
      TRecord,
      TProtocol,
      TSpatiality,
      readonly FieldName<TRecord>[] | undefined,
      GeometryProjectionFor<TRecord, TSpatiality>
    >
  | AggregateQuery<
      TRecord,
      TProtocol,
      TSpatiality,
      readonly GroupableFieldName<TRecord>[],
      NonEmptyReadonlyArray<AggregateMetric<TRecord>>
    >;

/** Minimal cancellation contract; deliberately does not import a DOM global. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

type SelectedRecord<TRecord, TSelect> = TSelect extends readonly FieldName<TRecord>[]
  ? Pick<TRecord, TSelect[number]>
  : TRecord;

type PromotedGeometryField<TQuery> = TQuery extends {
  readonly geometry: { readonly field: infer TField extends PropertyKey };
}
  ? TField
  : never;

type SelectedRecordForQuery<TRecord, TQuery> = TQuery extends { readonly select?: infer TSelect }
  ? Omit<
      SelectedRecord<TRecord, TSelect>,
      Extract<PromotedGeometryField<TQuery>, keyof SelectedRecord<TRecord, TSelect>>
    >
  : never;

export type FeatureIdentityValue = string | number | boolean;

export interface FeatureIdentityPart {
  readonly field: string;
  readonly value: FeatureIdentityValue;
}

export type FeatureIdentity =
  | {
      readonly kind: "scalar";
      readonly value: FeatureIdentityValue;
      readonly field?: string;
    }
  | {
      readonly kind: "composite";
      readonly parts: readonly [FeatureIdentityPart, FeatureIdentityPart, ...FeatureIdentityPart[]];
    };

type IdentityValueFor<TValue> = NonNullish<TValue> extends bigint | Date
  ? string
  : NonNullish<TValue> extends FeatureIdentityValue
    ? NonNullish<TValue>
    : FeatureIdentityValue;

type IdentityPartFor<TRecord, TField extends string> = {
  readonly field: TField;
  readonly value: TField extends keyof TRecord ? IdentityValueFor<TRecord[TField]> : FeatureIdentityValue;
};

type IdentityPartsFor<TRecord, TFields extends readonly string[]> = {
  readonly [TIndex in keyof TFields]: TFields[TIndex] extends string
    ? IdentityPartFor<TRecord, TFields[TIndex]>
    : never;
};

export type FeatureIdentityForFields<
  TRecord,
  TFields extends NonEmptyReadonlyArray<string>,
> = TFields extends readonly [infer TField extends string]
  ? {
      readonly kind: "scalar";
      readonly field: TField;
      readonly value: TField extends keyof TRecord ? IdentityValueFor<TRecord[TField]> : FeatureIdentityValue;
    }
  : TFields extends readonly [string, string, ...string[]]
    ? {
        readonly kind: "composite";
        readonly parts: IdentityPartsFor<TRecord, TFields>;
      }
    : FeatureIdentity;

type FeatureIdentityMemberFor<TRecord, TSchemaState extends SchemaState> = TSchemaState extends {
  readonly state: "known";
  readonly value: { readonly key: { readonly state: "known"; readonly fields: infer TFields } };
}
  ? TFields extends NonEmptyReadonlyArray<string>
    ? { readonly identity: FeatureIdentityForFields<TRecord, TFields> }
    : never
  : { readonly identity?: FeatureIdentity };

type BaseFeatureForQuery<TRecord, TQuery, TSchemaState extends SchemaState> = TQuery extends {
  readonly select?: infer TSelect;
}
  ? {
      /** A field promoted to top-level geometry is removed to avoid duplicate values. */
      readonly properties: SelectedRecordForQuery<TRecord, TQuery>;
    } & FeatureIdentityMemberFor<TRecord, TSchemaState>
  : never;

type QueryIncludesGeometry<TQuery, TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? false
  : TQuery extends { readonly geometry: "omit" }
    ? false
    : TQuery extends { readonly geometry: "include" | { readonly field: string } }
      ? true
      : TSpatiality extends "primary-geometry"
        ? true
        : false;

export type FeatureForQuery<
  TRecord,
  TQuery,
  TSpatiality extends SourceSpatiality,
  TSchemaState extends SchemaState,
> = BaseFeatureForQuery<TRecord, TQuery, TSchemaState> &
  (QueryIncludesGeometry<TQuery, TSpatiality> extends true ? { readonly geometry: GeometryValue } : object);

type MetricValue<TRecord, TMetric> = TMetric extends { readonly fn: "count" }
  ? number
  : TMetric extends { readonly fn: "min" | "max"; readonly field: infer TField extends keyof TRecord }
    ? TRecord[TField]
    : number;

type MetricRow<TRecord, TMetrics> = TMetrics extends readonly AggregateMetric<TRecord>[]
  ? { readonly [TMetric in TMetrics[number] as TMetric["as"]]: MetricValue<TRecord, TMetric> }
  : never;

export type AggregateRow<TRecord, TQuery> = TQuery extends {
  readonly groupBy: infer TGroupBy extends readonly GroupableFieldName<TRecord>[];
  readonly metrics: infer TMetrics extends readonly AggregateMetric<TRecord>[];
}
  ? Pick<TRecord, TGroupBy[number]> & MetricRow<TRecord, TMetrics>
  : never;

export interface ResultObservation {
  readonly state: "live" | "cached" | "replayed" | "pending-local";
  readonly observedAt: IsoInstant;
  readonly validAt?: IsoInstant;
  readonly expiresAt?: IsoInstant;
  readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
}

export type ResultCountScope = "matched-features" | "result-rows";

export interface ResultCountEvidence {
  readonly kind: "protocol" | "computed" | "estimate" | "unavailable";
  readonly reference: string;
}

export type ResultCount<TScope extends ResultCountScope = ResultCountScope> =
  | {
      readonly state: "exact";
      readonly scope: TScope;
      readonly value: number;
      readonly evidence: NonEmptyReadonlyArray<ResultCountEvidence>;
    }
  | {
      readonly state: "estimated";
      readonly scope: TScope;
      readonly value: number;
      readonly confidence?: number;
      readonly evidence: NonEmptyReadonlyArray<ResultCountEvidence>;
    }
  | {
      readonly state: "unknown";
      readonly scope: TScope;
      readonly reason: "not-requested" | "not-reported" | "unsupported" | "invalid";
      readonly evidence: NonEmptyReadonlyArray<ResultCountEvidence>;
    };

export interface FeatureQueryResult<TFeature, TSchemaIdentity extends SchemaIdentity = SchemaIdentity> {
  readonly kind: "feature-result";
  readonly features: readonly TFeature[];
  readonly page: PageResultState;
  readonly count: ResultCount<"matched-features">;
  readonly extent: SpatialExtent;
  readonly temporalExtent: TemporalExtent;
  readonly schema: TSchemaIdentity;
  readonly observation: ResultObservation;
}

export interface AggregateQueryResult<TRow, TSchemaIdentity extends SchemaIdentity = SchemaIdentity> {
  readonly kind: "aggregate-result";
  readonly rows: readonly TRow[];
  readonly page: PageResultState;
  readonly count: ResultCount<"result-rows">;
  readonly schema: TSchemaIdentity;
  readonly observation: ResultObservation;
}

export type ResultFor<
  TRecord,
  TQuery,
  TSpatiality extends SourceSpatiality,
  TSchemaState extends SchemaState,
> = TQuery extends { readonly kind: "features" }
  ? FeatureQueryResult<FeatureForQuery<TRecord, TQuery, TSpatiality, TSchemaState>, SchemaIdentityFor<TSchemaState>>
  : TQuery extends { readonly kind: "aggregate" }
    ? AggregateQueryResult<AggregateRow<TRecord, TQuery>, SchemaIdentityFor<TSchemaState>>
    : never;

export interface SourceV2<TRecord, TProtocol extends SourceProtocol, TSchemaState extends SchemaState> {
  readonly descriptor: SourceDescriptorV2<TProtocol, TSchemaState>;
  /** Computed and validated from descriptor.schema; callers cannot supply it. */
  readonly spatiality: SpatialityForSchemaState<TSchemaState>;
  query<const TQuery extends QueryV2<TRecord, TProtocol, SpatialityForSchemaState<TSchemaState>>>(
    query: TQuery,
    options?: { readonly signal?: AbortSignalLike },
  ): Promise<ResultFor<TRecord, TQuery, SpatialityForSchemaState<TSchemaState>, TSchemaState>>;
}

/** Design-only constructor used to prove locator/protocol/query coupling. */
export declare function sourceFromDescriptor<
  TRecord,
  TProtocol extends SourceProtocol,
  TSchemaState extends SchemaState,
>(descriptor: SourceDescriptorV2<TProtocol, TSchemaState>): SourceV2<TRecord, TProtocol, TSchemaState>;
