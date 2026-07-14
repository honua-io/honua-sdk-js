# Vendor-neutral source contract v2

Status: **proposed for acceptance** on 2026-07-13 for
[`honua-sdk-js#522`](https://github.com/honua-io/honua-sdk-js/issues/522).
Merging this decision accepts the contract direction and unblocks the bounded
implementation issues listed below. It does not add a production export,
migrate an adapter, or claim that v2 is already implemented.

The sole complete normative TypeScript proposal is the mechanically checked
[`contracts.ts`](../../test/design/contract-v2/contracts.ts). Its
[`positive.ts`](../../test/design/contract-v2/positive.ts),
[`negative.ts`](../../test/design/contract-v2/negative.ts), and shared
[`fixtures.ts`](../../test/design/contract-v2/fixtures.ts) are normative
acceptance evidence. TypeScript blocks below are deliberately non-exhaustive
representative shapes; they explain decisions but do not form a second contract.
If prose or an excerpt disagrees with `contracts.ts` before implementation, the
compiled declaration wins and this ADR must be corrected in the same change.

## Decision summary

The stable semantic contract will replace Esri-shaped shared metadata with a
versioned, deeply readonly and JSON-safe model. Protocol adapters retain their
native metadata behind explicit protocol boundaries, but map it into the same
logical field, geometry, CRS, extent, descriptor, capability, query and result
vocabulary.

The following rules are normative:

1. Logical types and roles never contain an Esri, OGC, OData, STAC, Arrow or
   renderer vocabulary. Native names survive only in bounded provenance.
2. A resolved source locator is a protocol-discriminated union. Discovery
   inputs such as a bare URL or `auto` are not resolved locators; dataset and
   collection origin are distinct identities where the standard exposes both.
3. Service endpoints and static resources are different types. Static
   resources may be credential-free URLs, Node file paths/globs, or
   caller-registered opaque resolver identities.
4. CRS definition axis order and the actual tuple order of a payload are
   separate values. Missing CRS never means WGS84 unless an accepted standard
   and observed conformance make that default normative.
5. `NoCRS`/non-spatial is a geometry-schema state, not a CRS that can be put on
   a geometry. Returned geometry may preserve unknown CRS/order, but a spatial
   operand requires resolved CRS identity and known payload coordinate order.
6. Unknown geometry type is metadata, not an executable geometry member.
   Spatial compilation fails closed through the common error envelope owned by
   [#524](https://github.com/honua-io/honua-sdk-js/issues/524).
7. Empty, unknown and mixed are different states. Omitted metadata is never
   converted to an empty array or an invented default.
8. Field domains and constraints are typed, bounded and evidence-preserving;
   absence never means unconstrained and duplicate/conflicting rules fail.
9. Capability collections are deterministically ordered arrays, not `Set`.
   Claimed, observed and effective truth are separate.
10. `Query<T>` uses `T` for projection, filtering, ordering, grouping and
    aggregate metrics. Temporal operators require schema-derived temporal
    fields. The query literal determines the result property shape.
11. Result pagination, completeness and total counts are evidence-bearing;
    exact, estimated, unknown and unpaged states are never conflated.
12. Source-native filter text is a dialect-tagged escape hatch whose dialect is
    constrained by the source protocol. It is not the semantic query language.
13. Schema, descriptor and capability fingerprints participate in plan, cache
    and subscription identity. Observation timestamps and cancellation state do
    not.
14. Core remains ESM-only, DOM-free, renderer-free, transport-neutral and free
    of optional heavy peers.

## Scope and non-goals

This decision specifies:

- JSON and extension primitives;
- every current built-in source locator plus a namespaced extension locator;
- native metadata provenance;
- logical fields and nested/list/union/unknown types;
- coded/range domains and portable field constraints;
- geometry values and source geometry knowledge;
- CRS identity, axis order, coordinate order and reprojection provenance;
- known, empty, mixed and unknown extents;
- schema and descriptor versioning;
- JSON-safe claimed/observed/effective capability truth;
- the typed relationship between a query and its feature or aggregate result;
- evidence-bearing pagination and exact/estimated/unknown counts;
- compatibility boundaries and pre-1.0 migration;
- descriptor/cache/realtime invalidation rules.

This decision does not implement adapters, a CRS database, reprojection,
geometry repair, CQL2/FES/OData compilers, capability discovery, persistent
caching, subscriptions, or the common error registry. Those remain owned by
existing child issues.

## Standards baseline

The design follows primary specifications rather than one vendor's object
model:

- [GeoJSON RFC 7946](https://www.rfc-editor.org/rfc/rfc7946) fixes the common
  geometry shapes, CRS84 longitude/latitude coordinates, nullable feature
  geometry and `2*n` bounding-box layout. A canonical value carries its CRS
  outside the GeoJSON geometry object so alternative encodings and CRS-aware
  protocols are still representable.
- [OGC API Features Part 1](https://docs.ogc.org/is/17-069r4/17-069r4.html)
  defines the CRS84 core default and collection spatial/temporal extents.
  [Part 2](https://docs.ogc.org/is/18-058r1/18-058r1.html) defines URI CRS
  identifiers, supported/output CRS and storage CRS/coordinate epoch.
- [OGC API Tiles Part 1](https://docs.ogc.org/is/20-057/20-057.html) and
  [OGC API Maps Part 1](https://docs.ogc.org/is/20-058/20-058.html) expose
  dataset-level resources as well as resources originating at an individual
  collection. Locator scope must preserve that distinction.
- [WFS 2.0](https://docs.ogc.org/is/09-025r2/09-025r2.html) identifies feature
  types by qualified name, advertises `DefaultCRS`/`OtherCRS`, and explicitly
  says `NoCRS` identifies a feature type with no spatial properties; it must
  not be interpreted as unknown CRS.
- [STAC Item 1.1](https://github.com/radiantearth/stac-spec/blob/v1.1.0/item-spec/item-spec.md)
  is a GeoJSON Feature with `id`, nullable geometry, `bbox`, temporal
  properties, assets and namespaced extension schemas.
- [GeoParquet 1.1](https://geoparquet.org/releases/v1.1.0/) defines one or more
  geometry columns, explicit empty `geometry_types` for unknown type, mixed
  type lists, PROJJSON CRS, coordinate epoch, covering columns and an x/y wire
  order that may override the definition's axis order.
- [OData CSDL 4.0](https://docs.oasis-open.org/odata/odata/v4.0/errata03/os/complete/part3-csdl/odata-v4.0-errata03-os-part3-csdl-complete.html)
  defines structural properties, keys, nullability, complex/collection types
  and spatial primitives. The SDK currently certifies the OData **4.0**
  adapter family only. Later 4.01/4.02 metadata may be preserved as native
  provenance but does not imply conformance until separately tested.
- [GeoServices feature-layer metadata](https://developers.arcgis.com/rest/services-reference/enterprise/layer-feature-service/)
  and [geometry objects](https://developers.arcgis.com/rest/services-reference/enterprise/geometry-objects/)
  are adapter inputs, not canonical types.

## Representative TypeScript shapes

These excerpts show only the discriminants and relationships needed to read
the decision. They intentionally omit repetitive built-in members and helper
conditionals; follow the linked compiled declaration for the complete proposal.
`npm run verify:contract-v2-design` checks this ADR's evidence links, anchors,
snippet directives and JSON examples in addition to compiling the contract.

### JSON, extensions and resource identity

All persisted values are JSON values. Dates are ISO strings, 64-bit integers
may be decimal strings, and no `Date`, `bigint`, `Map`, `Set`, class instance,
DOM node, URL object, cancellation object, credential or raw cursor can enter a
descriptor.

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type JsonPrimitive = null | boolean | number | string;
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

type ExtensionIdentifier = `${string}.${string}`;
type ExtensionMap = Readonly<Record<ExtensionIdentifier, JsonValue>>;
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
type Sha256 = `sha256:${string}`;

interface UrlResourceReference {
  readonly kind: "url";
  readonly href: string;
  readonly pattern?: "literal" | "glob";
}
interface FileResourceReference {
  readonly kind: "file";
  readonly path: string;
  readonly pattern?: "literal" | "glob";
}
interface ResolverResourceReference {
  readonly kind: "resolver";
  readonly resolver: ExtensionIdentifier;
  readonly id: string;
  readonly options?: JsonObject;
}

type ResourceReference =
  | UrlResourceReference | FileResourceReference | ResolverResourceReference;
type LiteralResourceReference =
  | (Omit<UrlResourceReference, "pattern"> & { readonly pattern?: "literal" })
  | (Omit<FileResourceReference, "pattern"> & { readonly pattern?: "literal" })
  | ResolverResourceReference;
type NetworkResourceReference =
  | (Omit<UrlResourceReference, "pattern"> & { readonly pattern?: "literal" })
  | ResolverResourceReference;
```

Network locators are a fail-closed trust boundary. A resolved `endpoint`, URL
resource, TileJSON URL, tile template and redirect target must be absolute
HTTP(S). Construction rejects user-info and fragments; it never silently
strips them. A query string is absent unless that adapter has a reviewed,
fixed allowlist of stable identity parameters. Unknown parameter names are
rejected even when they appear harmless, and allowed parameters are sorted and
encoded canonically. Tokens, API keys and signed URLs are resolved at execution
time through an auth provider or opaque `resolver`; they never enter descriptor
JSON, fingerprints, logs or errors.

A `file` resource is Node-only and is not accepted by browser adapters. A
`resolver` value is an opaque identity. Glob semantics are permitted for
GeoParquet assets and extension protocols whose contract explicitly defines
them. PMTiles, static STAC, MapLibre GeoJSON, TileJSON and tile-template
resources are literal-only; accepting a glob there would make source identity
dependent on an unstated expansion.

### Resolved locators

The complete union is in `contracts.ts`. These representatives show the
service/static/tile/extension distinctions. A future built-in adds one
discriminant and conformance fixtures; a third-party protocol uses a
reverse-DNS identifier and JSON payload.

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type SourceProtocol = BuiltInSourceProtocol | ExtensionIdentifier;

interface LocatorBase<P extends SourceProtocol> {
  readonly protocol: P;
  readonly endpoint: string;
  readonly extensions?: ExtensionMap;
}

interface GeoServicesFeatureLocator
  extends LocatorBase<"geoservices-feature-service"> {
  readonly layerId: number;
}

interface OgcFeaturesLocator extends LocatorBase<"ogc-features"> {
  readonly collectionId: string;
  readonly layout: "ogc-api" | "honua-facade";
}

type OgcTilesLocator =
  | (LocatorBase<"ogc-tiles"> & { readonly scope: "dataset" })
  | (LocatorBase<"ogc-tiles"> & {
      readonly scope: "collection";
      readonly collectionId: string;
    });
type OgcMapsLocator =
  | (LocatorBase<"ogc-maps"> & { readonly scope: "dataset" })
  | (LocatorBase<"ogc-maps"> & {
      readonly scope: "collection";
      readonly collectionId: string;
    });

interface QualifiedName {
  readonly localName: string;
  readonly namespaceUri: string;
  readonly prefix?: string;
}

interface WfsSourceLocator extends LocatorBase<"wfs"> {
  readonly version: "2.0.0";
  readonly featureType: QualifiedName;
}

interface OdataSourceLocator extends LocatorBase<"odata"> {
  readonly version: "4.0";
  readonly entitySet: string;
}

type StacSourceLocator =
  | (LocatorBase<"stac"> & { readonly scope: "api-catalog" })
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

type MaplibreTileResource =
  | {
      readonly form: "tilejson";
      readonly resource: NetworkResourceReference;
    }
  | {
      readonly form: "templates";
      readonly templates: NonEmptyReadonlyArray<NetworkResourceReference>;
    };

interface MaplibreTilesSourceLocator {
  readonly protocol: "maplibre-vector" | "maplibre-raster";
  readonly tiles: MaplibreTileResource;
}

interface LiteralStaticSourceLocator {
  readonly protocol: "pmtiles" | "maplibre-geojson";
  readonly resource: LiteralResourceReference;
}

interface ExtensionSourceLocator<
  P extends ExtensionIdentifier = ExtensionIdentifier,
> {
  readonly protocol: P;
  readonly resource: ResourceReference;
  readonly extension: {
    readonly locatorVersion: string;
    readonly payload: JsonObject;
  };
  readonly extensions?: ExtensionMap;
}

type SourceLocatorV2 = BuiltInSourceLocator | ExtensionSourceLocator;
type LocatorFor<P extends SourceProtocol> = Extract<
  SourceLocatorV2,
  { readonly protocol: P }
>;
```

The exact service root is in `endpoint`: a GeoServices layer locator uses a
URL ending in `FeatureServer`/`MapServer` and a separate layer id. It does not
split a service into ambiguous `url + serviceId` pieces. OGC API locators use a
service root plus an explicit origin scope. Tiles/Maps `dataset` scope has no
collection id; `collection` scope requires exactly one. These are distinct
descriptor identities even when content happens to be equivalent. A WFS QName uses namespace URI
plus local name; the prefix is presentation only. A resolved locator never
contains `layout: "auto"`.

### Native provenance

Native metadata is retained only in a bounded, sanitized description. Full
capabilities documents, CSDL, JSON Schema, Parquet metadata and layer JSON stay
on protocol-specific inspection surfaces or in evidence artifacts.

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
interface NativeTypeReference {
  readonly protocol: SourceProtocol;
  readonly name: string;
  readonly namespace?: string;
  readonly path?: readonly string[];
  readonly definition?: JsonValue;
}

interface MetadataProvenance {
  readonly method:
    | "observed"
    | "declared"
    | "standard-default"
    | "inferred"
    | "unavailable";
  readonly protocol: SourceProtocol;
  readonly source: string;
  readonly observedAt?: string;
  readonly validator?:
    | { readonly kind: "etag"; readonly value: string }
    | { readonly kind: "last-modified"; readonly value: string }
    | { readonly kind: "version"; readonly value: string };
  readonly detail?: string;
}
```

`standard-default` is allowed only when evidence proves the corresponding
requirements class/encoding. Examples are RFC 7946/STAC longitude-latitude,
OGC API Features Core CRS84 and GeoParquet 1.1's absent-`crs` rule. A generic
missing spatial reference is `unknown`, never `standard-default`.

### CRS and coordinate order

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type AxisOrder =
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

type CrsDefinition =
  | {
      readonly kind: "authority";
      readonly authority: string;
      readonly code: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "wkt";
      readonly wkt: string;
      readonly validation: "unverified" | "engine";
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "uri";
      readonly uri: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "projjson";
      readonly projjson: JsonObject;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

interface CrsBinding {
  readonly definition: CrsDefinition;
  readonly coordinateOrder: AxisOrder;
  readonly coordinateEpoch?: number;
  readonly provenance: CrsProvenance;
}

interface ExecutableCrsBinding extends CrsBinding {
  readonly definition: ResolvedCrsDefinition;
  readonly coordinateOrder: Extract<AxisOrder, { readonly state: "known" }>;
}
```

There is deliberately no `CrsDefinition { kind: "none" }`. A non-spatial
table has `SourceGeometrySchema { state: "none" }` and therefore no geometry
binding. A spatial value whose CRS metadata is missing carries
`{ kind: "unknown", reason: "missing" }` and cannot be reprojected until a
caller supplies an explicit, policy-checked CRS. It also cannot enter a spatial
predicate until payload coordinate order is known. That executable boundary
uses `ExecutableCrsBinding`; preservation types remain lossless.

The `definitionAxisOrder` describes the CRS definition; `coordinateOrder`
describes numbers in this payload. Thus EPSG:4326 can retain latitude/longitude
definition axes while a GeoJSON or GeoParquet payload records
longitude/latitude or x/y encoding order.

For `provenance.method: "reprojected"`, the binding's public `definition` must
semantically equal `reprojection.target`; source and target are both resolved.
This prevents provenance from claiming a transform into one CRS while the
payload binding advertises another.

Resolved CRS identity includes reviewed authority/code, WKT, an absolute
canonical URI, or bounded PROJJSON. An adapter does not have to invent an
authority split for an OGC-advertised URI, and a custom GeoParquet PROJJSON
definition is not downgraded to unknown. URI normalization follows RFC 3986
syntax without dereferencing; relative values, user-info, fragments and
non-canonical encodings fail validation. PROJJSON must validate against the
supported PROJJSON v0.7 vocabulary (`$schema`, when present, is the v0.7 schema
URI), and its RFC 8785 canonical UTF-8 representation is at most 64 KiB with
nesting depth at most 32. Axis evidence is retained separately and checked
against parsed definition axes when available. The canonical URI or complete
canonical PROJJSON object—not display `name`—participates in
schema/descriptor identity.

### Geometry and extent

Canonical geometry uses the seven RFC 7946 shapes. It has no embedded `crs`
member, envelope pseudo-geometry, unknown member or protocol tag.

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type Position2D = readonly [number, number];
type Position3D = readonly [number, number, number];
type Position4D = readonly [number, number, number, number];
type Position = Position2D | Position3D | Position4D;
type CoordinateLayout = "xy" | "xyz" | "xym" | "xyzm";

type GeometryValue =
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position>;
      readonly crs: CrsBinding;
      readonly layout: CoordinateLayout;
    }
  | {
      readonly state: "empty";
      readonly expectedType?: GeometryKind;
      readonly crs: CrsBinding;
      readonly layout: CoordinateLayout | "unknown";
    };

type ExecutableGeometryValue = Extract<GeometryValue, { state: "present" }> & {
  readonly crs: ExecutableCrsBinding;
};

type GeometryTypeKnowledge =
  | { readonly state: "known"; readonly type: GeometryKind }
  | {
      readonly state: "mixed";
      readonly types: readonly [GeometryKind, GeometryKind, ...GeometryKind[]];
    }
  | {
      readonly state: "unknown";
      readonly reason:
        | "missing" | "unrecognized" | "conflicting" | "unsupported";
      readonly native?: NativeTypeReference;
    };

interface GeometryFieldSchema {
  readonly field: string;
  readonly geometryTypes: GeometryTypeKnowledge;
  readonly crs: CrsBinding;
  readonly layout: CoordinateLayout | "unknown";
  readonly allowsEmpty: boolean | "unknown";
}

type PrimaryGeometryField =
  | { readonly state: "known"; readonly field: string }
  | {
      readonly state: "none";
      readonly reason: "not-declared" | "no-default";
    }
  | {
      readonly state: "unknown";
      readonly reason: "metadata-unavailable" | "conflicting";
    };

type SourceGeometrySchema =
  | {
      readonly state: "none";
      readonly reason: "declared-non-spatial" | "no-geometry-fields";
    }
  | {
      readonly state: "known";
      readonly fields: NonEmptyReadonlyArray<GeometryFieldSchema>;
      readonly primaryField: PrimaryGeometryField;
    }
  | {
      readonly state: "unknown";
      readonly reason:
        | "metadata-unavailable" | "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

type BoundingBox =
  | {
      readonly layout: "xy";
      readonly bounds: readonly [number, number, number, number];
    }
  | {
      readonly layout: "xyz";
      readonly bounds: readonly [number, number, number, number, number, number];
    };

interface ExecutableBoundingBox {
  readonly box: BoundingBox;
  readonly crs: ExecutableCrsBinding;
}

type SingleSpatialExtent =
  | {
      readonly state: "known";
      readonly boxes: NonEmptyReadonlyArray<BoundingBox>;
      readonly crs: CrsBinding;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "empty";
      readonly reason:
        | "empty-source" | "empty-result" | "all-geometries-empty";
      readonly crs: CrsBinding;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

type SpatialExtent =
  | SingleSpatialExtent
  | {
      readonly state: "mixed";
      readonly extents: readonly [
        SingleSpatialExtent,
        SingleSpatialExtent,
        ...SingleSpatialExtent[],
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

type TemporalReferenceSystem =
  | { readonly kind: "gregorian" }
  | { readonly kind: "uri"; readonly uri: string }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

type TemporalInterval = readonly [string | null, string | null];

type TemporalExtent =
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
```

`state: "empty"` is an observed empty geometry value or extent. Empty
coordinate arrays normalize to that wrapper rather than a present geometry;
because no coordinate tuple exists, an adapter may honestly report
`layout: "unknown"`. Non-spatial exists only on source schema and extent, not
as a value inside a returned feature. A non-spatial result omits top-level
`geometry`. An empty feature array is a successful result. `state: "unknown"`
means knowledge is unavailable. A source geometry schema is `known` whenever
its geometry-field inventory is known, including multiple fields. Mixed type
knowledge is recorded on each field and multiple real CRS extents use the
extent's `mixed` state. Top-level geometry-schema `unknown` is reserved for an
unavailable or conflicting field inventory. These states must never be
converted into each other.

The tuple types enforce 2/3/4-ordinate arity and the line/ring minimum sizes at
compile time. Runtime decoders additionally reject non-finite ordinates,
inconsistent tuple arity, unclosed rings and invalid bbox cardinality. They
validate bbox ordering according to the CRS and encoding, preserving valid
geographic antimeridian-crossing boxes rather than applying a naïve `west <=
east` rule. `xyz` versus `xym` is never inferred from the third number alone;
it comes from schema/encoding evidence.

A non-null geometry `defaultValue` passes the same runtime geometry decoder.
Its ordinate arity must agree with a known field layout, and its root geometry
kind must equal known type knowledge or be a member of mixed type knowledge.

Canonical bounding boxes are spatial-only. `xy` bounds are
`[minX,minY,maxX,maxY]`; `xyz` bounds are
`[minX,minY,minZ,maxX,maxY,maxZ]`. An `xym` value projects its spatial x/y
range to an `xy` box, and an `xyzm` value projects x/y/z to `xyz`. Measures and
time never occupy bbox ordinates; temporal bounds belong in `TemporalExtent`.
The explicit layout plus CRS/order evidence removes the otherwise ambiguous
meaning of a six-number array. All extent states carry provenance, including
`unknown` and `none`, so absence is an evidence-backed claim rather than an
empty-object convention.

`primaryField: { state: "known" }` authorizes an unqualified geometry
projection. Multiple known geometry fields without a default use
`primaryField: { state: "none", reason: "no-default" }` and require an explicit
field. The query record type `T` describes feature `properties`: the primary
geometry is controlled separately, while secondary geometry fields may appear
in `T`. Promoting a secondary field into top-level `geometry` removes it from
`properties` for that result to avoid duplicate values. Selecting it without
promotion leaves it in `properties`.

Temporal extent is independent from temporal field roles. A known value has
one or more intervals; `null` is an explicitly open lower/upper bound, not a
substitute date. Gregorian/STAC positions are runtime-validated and
canonicalized as RFC 3339 instants. A lexical `:60` leap second is accepted
only when its offset-normalized instant is the UTC end of June or December;
equivalent offset spellings are validated against that UTC boundary. Other
temporal reference systems retain a URI and adapter-specific lexical
validation. Empty, unavailable and declared non-temporal all carry evidence
and never manufacture dates or default bounds.
`duration` is a scalar amount, not an instant or endpoint, and therefore cannot
populate the source temporal instant, interval or mixed-field positions.

An adapter encountering an unrecognized executable geometry must not construct
`CanonicalGeometry`. It preserves the native type on
`GeometryTypeKnowledge { state: "unknown" }` and rejects spatial execution.
The structured SDK error and diagnostic tags come from #524; this ADR does not
create a parallel error hierarchy. The immediate legacy fail-closed correction
is owned by [#521](https://github.com/honua-io/honua-sdk-js/issues/521).

### Logical fields and schema

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type LogicalType =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "integer";
      readonly bits: 8 | 16 | 32 | 64;
      readonly signed: boolean;
      readonly jsonEncoding: "number" | "string";
    }
  | { readonly kind: "string"; readonly maxLength?: number }
  | { readonly kind: "geometry" }
  | { readonly kind: "list"; readonly element: LogicalType }
  | { readonly kind: "struct"; readonly fields: readonly LogicalField[] }
  | {
      readonly kind: "union";
      readonly members: readonly [LogicalType, LogicalType, ...LogicalType[]];
    }
  | {
      readonly kind: "unknown";
      readonly reason:
        | "missing" | "unrecognized" | "conflicting" | "unsupported";
      readonly native?: NativeTypeReference;
    };

type FieldValueDomain =
  | NoValueDomain | CodedValueDomain | RangeValueDomain | UnknownValueDomain;
type FieldConstraintState =
  | NoConstraints | KnownConstraints | PartialConstraints | UnknownConstraints;

interface LogicalField {
  readonly name: string;
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

type KeyDefinition =
  | { readonly state: "known"; readonly fields: NonEmptyReadonlyArray<string> }
  | { readonly state: "none" }
  | {
      readonly state: "unknown";
      readonly reason: "metadata-unavailable" | "not-declared" | "conflicting";
    };

interface SourceSchemaV2 {
  readonly kind: "honua.source-schema";
  readonly version: "2.0";
  readonly fingerprint: Sha256;
  readonly fields: readonly LogicalField[];
  readonly key: KeyDefinition;
  readonly geometry: SourceGeometrySchema;
  readonly temporal: TemporalSchema;
  readonly openContent: "closed" | "open" | "unknown";
  readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
  readonly extensions?: ExtensionMap;
}

type SchemaState<S extends SourceSchemaV2 = SourceSchemaV2> =
  | { readonly state: "known"; readonly value: S }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "not-requested" | "request-failed" | "not-advertised" | "invalid";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

type SchemaIdentity =
  | { readonly state: "known"; readonly fingerprint: Sha256 }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "not-requested" | "request-failed" | "not-advertised" | "invalid";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

type SchemaIdentityFor<S extends SchemaState> =
  S extends { readonly state: "known"; readonly value: infer V extends SourceSchemaV2 }
    ? { readonly state: "known"; readonly fingerprint: V["fingerprint"] }
    : S extends Extract<SchemaState, { readonly state: "unavailable" }>
      ? {
          readonly state: "unavailable";
          readonly reason: S["reason"];
          readonly provenance: S["provenance"];
        }
      : never;
```

`LogicalField.path` is an absolute native path from the source-record root.
Every struct descendant strictly extends its parent's path. Paths are unique
among fields that can be addressed simultaneously; mutually exclusive union
branches may reuse the same native path for one logical location. This keeps
path-based projection and mutation deterministic without rejecting
polymorphic representations.

An observed zero-field schema is `{ state: "known", value: { fields: [] } }`.
Failed/unrequested metadata is `{ state: "unavailable" }`. A native field type
that is present but not understood is a logical `{ kind: "unknown" }`, not a
string. A polymorphic value is `{ kind: "union", members: [...] }`, not
unknown.

Schema identity is equally honest: a descriptor/result with unavailable schema
metadata carries the unavailable reason and provenance, not a fabricated hash.
Moving from unavailable to known schema is an identity change.

A `known` key is directly usable as `FeatureIdentity`: every referenced field
is non-nullable and has a scalar logical encoding that produces string, number
or boolean. A nullable, unknown-nullability, list, struct, geometry, JSON or
unknown field cannot be certified as a known key. Protocol defaults such as an
omitted OData key-property `Nullable` facet are applied before this check.

Every logical field explicitly carries domain and constraint knowledge.
`none` means metadata affirmatively says unconstrained/not applicable;
`unknown` means it was absent, conflicting, unrecognized or exceeded the
sanitization bound. Coded domains retain typed JSON scalar values, labels and
open/closed knowledge. Range endpoints retain typed value and inclusivity;
decimal/int64/temporal endpoints use the field's declared JSON encoding.
Additional length, ECMA-262 pattern, positive `multiple-of`, uniqueness and
namespaced extension constraints are JSON-safe. `partial` retains understood
constraints together with non-empty native references to what was not mapped.

Runtime construction enforces field-type compatibility, finite numeric values,
at least one range endpoint, comparable endpoint encodings and minimum <=
maximum. Equal endpoints are valid only when both are inclusive; an exclusive
side would describe an empty domain. Coded values are unique by canonical JSON
value. Constraint kinds are unique per field; duplicate built-ins/extensions
and a constraint that contradicts logical-type metadata (for example two
different maximum lengths)
fail as `conflicting`, rather than applying last-one-wins. Coded domains are
bounded to 10,000 entries and the canonical domain-plus-constraint projection
to 1 MiB per field; overflow becomes `unknown/limit-exceeded` with bounded
native provenance, never a silently truncated closed domain.

GeoServices coded/range domains, OData enum/validation annotations, JSON Schema
`enum`/minimum/maximum/pattern/length keywords and WFS XSD restrictions map
into this vocabulary. Unrecognized vendor annotations remain bounded native
references and cannot silently become portable validation rules.

### JSON-safe capabilities

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type CapabilityTruth = "supported" | "unsupported" | "unknown";
type EffectiveCapabilityState =
  | "supported"
  | "unsupported"
  | "unknown"
  | "policy-disabled"
  | "peer-unavailable"
  | "authorization-required"
  | "authorization-denied";

interface CapabilityEvidence {
  readonly kind:
    | "protocol-default" | "metadata" | "conformance" | "probe" | "declaration";
  readonly truth: CapabilityTruth;
  readonly reference: string;
  readonly observedAt?: string;
  readonly expiresAt?: string;
  readonly sourceFingerprint?: Sha256;
}

type TopologicalSpatialPredicate =
  | "equals" | "intersects" | "within" | "contains" | "disjoint"
  | "touches" | "overlaps" | "crosses";
type DistanceSpatialPredicate = "within-distance" | "beyond-distance";
type SpatialPredicate =
  | TopologicalSpatialPredicate | "bbox-intersects" | DistanceSpatialPredicate;
type TemporalPredicate =
  | "before" | "after" | "during" | "time-intersects";

type BuiltInFilterOperator =
  | "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
  | "in" | "between" | "is-null" | "is-not-null" | "like"
  | "and" | "or" | "not"
  | SpatialPredicate
  | TemporalPredicate;
type FilterOperatorId = BuiltInFilterOperator | ExtensionIdentifier;

interface CapabilityConstraints {
  readonly inputFormats?: readonly string[];
  readonly outputFormats?: readonly string[];
  readonly filterOperators?: readonly FilterOperatorId[];
  readonly spatialPredicates?: readonly SpatialPredicate[];
  readonly temporalPredicates?: readonly TemporalPredicate[];
  readonly supportedCrs?: readonly ResolvedCrsDefinition[];
  readonly pagination?: {
    readonly modes: readonly ("offset" | "cursor" | "next-link")[];
    readonly maxPageSize?: number;
  };
  readonly limits?: {
    readonly maxRecords?: number;
    readonly maxRequestBytes?: number;
    readonly maxResponseBytes?: number;
  };
  readonly extensions?: ExtensionMap;
}

interface CapabilityRequirements {
  readonly environments?: readonly ("browser" | "worker" | "node" | "edge" | ExtensionIdentifier)[];
  readonly peers?: readonly string[];
}

interface CapabilityEvidenceEntry {
  readonly id: CapabilityId;
  readonly claimed: CapabilityTruth;
  readonly observed: CapabilityTruth | "not-observed";
  readonly evidence: readonly CapabilityEvidence[];
  readonly authorizationScopes?: readonly string[];
  readonly constraints?: CapabilityConstraints;
  readonly requirements?: CapabilityRequirements;
}

interface CapabilityEvidenceProfile {
  readonly kind: "honua.capability-evidence"; readonly version: "1.0";
  readonly fingerprint: Sha256; readonly sourceFingerprint?: Sha256;
  readonly entries: readonly CapabilityEvidenceEntry[];
}

interface CapabilityDecision extends CapabilityEvidenceEntry {
  readonly effective: EffectiveCapabilityState; readonly reasons: readonly string[];
}

interface CapabilityProfile {
  readonly kind: "honua.capabilities"; readonly version: "1.0";
  readonly fingerprint: Sha256; readonly evidenceFingerprint: Sha256;
  readonly sourceFingerprint?: Sha256; readonly context: CapabilityEvaluationContextSnapshot;
  readonly evaluatedAt: string | null; readonly validUntil: string | null;
  readonly entries: readonly CapabilityDecision[];
}
```

`CapabilityId` retains the existing operation identifiers except `connect`:
discovery is a kernel operation, not a per-source capability. Extension
capabilities use reverse-DNS names. `entries` is sorted by id with no duplicate.
Metadata can downgrade a default; optional discovery failure cannot upgrade
one. Policy, peer availability and authorization are effective-decision inputs,
not mutations of observed evidence. Operation limits and supported formats,
operators, predicates, CRS and pagination modes live in JSON-safe
`constraints`; a `supported` decision without the required constraint is not
permission for an arbitrary operation. Filter operator IDs are canonical
semantic names or reverse-DNS extensions, never raw vendor constants. Runtime
validation rejects duplicate entries, duplicate constraint values, non-finite
or non-positive limits and an effective `supported` state that contradicts
claimed/observed truth or omits operation-critical constraints. Spatial
predicate support is granular: `equals`, bbox intersection and distance
predicates are separate declarations, not aliases for an adapter-created
polygon or buffer. Runtime validation and capability combination belong to
[#525](https://github.com/honua-io/honua-sdk-js/issues/525).

Static evidence ingestion and dynamic evaluation are separate boundaries. A
versioned, fingerprinted, deeply immutable `CapabilityEvidenceProfile` owns
one source and performs heavy CRS/PROJJSON and I-JSON validation once. Repeat
evaluation consumes only that validated profile, reuses its static values, and
fingerprints the evidence identity plus dynamic decisions rather than walking
the full static envelope. Mixed evidence `sourceFingerprint` values and an
expected source mismatch are rejected. Explicit empty constraint sets remain
distinct from omitted/unknown sets; `supportedCrs` is capped at 64 definitions.

Metadata, conformance and probe evidence carries an observation instant and an
exclusive expiry instant. Effective evaluation receives `evaluatedAt`
explicitly; it never reads the wall clock. Omitted evaluation time and stale or
not-yet-current observation evidence fail closed to `unknown` with stable
freshness reasons. Protocol defaults and declarations are non-observation claim
evidence and do not carry those timestamps. Requirements are retained in the
effective decision because environment and peer eligibility are semantic
inputs, not transient diagnostics.

Evaluated transport retains `evaluatedAt`, a conservative exclusive
`validUntil`, and normalized credential-free policy/environment/peer/scope
context. Strict parsing reconstructs the evidence profile and re-evaluates the
decision; it never treats caller-authored `effective` state as evidence.
Undefined object members, duplicate JSON names and unpaired UTF-16 surrogates
are rejected before RFC 8785 canonicalization. `CapabilityEvaluationPolicy` is
the canonical v2 allow/deny policy; stable `DiscoveryCapabilityPolicy` and the
stable `"strict" | "degraded"` `CapabilityPolicy` are compatibility adapters,
not alternative v2 policy vocabularies.

Example JSON:

```json
{
  "kind": "honua.capabilities",
  "version": "1.0",
  "fingerprint": "sha256:5c72...",
  "evidenceFingerprint": "sha256:923a...",
  "evaluatedAt": "2026-07-14T12:00:00Z",
  "validUntil": "2026-07-20T12:00:00Z",
  "context": {
    "availablePeers": [],
    "authorization": { "grantedScopes": [], "deniedScopes": [] }
  },
  "entries": [
    {
      "id": "query",
      "claimed": "supported",
      "observed": "supported",
      "effective": "supported",
      "evidence": [
        {
          "kind": "conformance",
          "truth": "supported",
          "reference": "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
          "observedAt": "2026-07-13T12:00:00Z",
          "expiresAt": "2026-07-20T12:00:00Z"
        }
      ],
      "reasons": [],
      "constraints": {
        "outputFormats": ["application/geo+json"],
        "filterOperators": ["eq", "in", "intersects"],
        "spatialPredicates": ["intersects"],
        "pagination": { "modes": ["offset"], "maxPageSize": 10000 },
        "limits": { "maxRecords": 100000 }
      }
    }
  ]
}
```

### Descriptor

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
interface DescriptorIdentity<S extends SchemaIdentity = SchemaIdentity> {
  readonly descriptorFingerprint: Sha256;
  readonly schema: S;
  readonly capabilityFingerprint: Sha256;
  readonly sourceRevision?: string;
  readonly authorizationContextId?: string;
}

interface SourceDescriptorV2<
  P extends SourceProtocol = SourceProtocol,
  S extends SchemaState = SchemaState,
> {
  readonly kind: "honua.source-descriptor";
  readonly version: "2.0";
  readonly id: string;
  readonly locator: LocatorFor<P>;
  readonly schema: S;
  readonly extent: SpatialExtent;
  readonly temporalExtent: TemporalExtent;
  readonly capabilities: CapabilityProfile;
  readonly identity: DescriptorIdentity<SchemaIdentityFor<S>>;
  readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
  readonly attribution?: string;
  readonly extensions?: ExtensionMap;
}
```

The protocol is not duplicated beside the locator. `locator.protocol` is the
single discriminator. `identity` contains canonical fingerprints computed by
the implementation; clients do not supply trusted fingerprints to bypass
validation. Descriptor construction validates that a non-spatial schema uses a
non-spatial extent and that geometry fields/primary-field names exist in the
schema. The source's ergonomic spatiality flag is computed from this validated
schema; it is never serialized or accepted as an independent constructor
argument. Schema identity mirrors the descriptor's schema state, and spatial
and temporal extent states participate in descriptor identity.

### Typed query and result relationship

The full recursive filter/metric utilities are compile-checked in
[`contracts.ts`](../../test/design/contract-v2/contracts.ts). The public
relationship is:

```ts doc-test=skip reason="design-only declarations compile in test/design/contract-v2"
type FieldName<T> = Extract<keyof T, string>;
type GeometryFieldName<T> = {
  [K in FieldName<T>]-?: Exclude<T[K], null | undefined> extends GeometryValue
    ? K
    : never;
}[FieldName<T>];
declare const temporalValueBrand: unique symbol;
type TemporalValue<K extends "date" | "instant"> = string & {
  readonly [temporalValueBrand]: K;
};
type TemporalFieldName<T> = {
  [K in FieldName<T>]-?: Exclude<T[K], null | undefined> extends
    TemporalValue<"date" | "instant"> | Date ? K : never;
}[FieldName<T>];
type SourceSpatiality =
  | "primary-geometry"
  | "non-spatial"
  | "ambiguous-geometry";

type SpatialityForGeometry<G extends SourceGeometrySchema> =
  G extends { readonly state: "none" }
    ? "non-spatial"
    : G extends {
          readonly state: "known";
          readonly primaryField: { readonly state: "known" };
        }
      ? "primary-geometry"
      : "ambiguous-geometry";

type SpatialityForSchemaState<S extends SchemaState> =
  S extends {
    readonly state: "known";
    readonly value: infer V extends SourceSchemaV2;
  }
    ? SpatialityForGeometry<V["geometry"]>
    : "ambiguous-geometry";

type GeometryProjectionFor<T, S extends SourceSpatiality> =
  S extends "non-spatial"
    ? "omit"
    : S extends "primary-geometry"
      ? "include" | "omit" | { readonly field: GeometryFieldName<T> }
      : "omit" | { readonly field: GeometryFieldName<T> };

type DistanceUnit =
  | "metre" | "kilometre" | "foot" | "us-survey-foot"
  | "mile" | "nautical-mile" | "degree" | "radian";
interface DistanceOperand {
  readonly value: number;
  readonly unit: DistanceUnit;
  readonly mode: "planar" | "geodesic";
}
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
type SpatialExpressionFor<T, S extends SourceSpatiality> =
  S extends "non-spatial" ? never
    : SpatialOperandExpression &
        (S extends "primary-geometry"
          ? { readonly field?: GeometryFieldName<T> }
          : { readonly field: GeometryFieldName<T> });

type QueryFilter<T, P extends SourceProtocol, S extends SourceSpatiality> =
  | SemanticFilter<T, S>
  | NativeFilter<NativeDialectFor<P>>;

type OutputCrsFor<S extends SourceSpatiality> =
  S extends "non-spatial" ? never : ResolvedCrsDefinition;

type PaginationMode = "offset" | "cursor" | "next-link";
declare const pageContinuationBrand: unique symbol;

interface PageContinuation<
  Mode extends "cursor" | "next-link" = "cursor" | "next-link",
> {
  readonly kind: "honua.page-continuation";
  readonly mode: Mode;
  readonly binding: {
    readonly descriptorFingerprint: Sha256;
    readonly queryFingerprint: Sha256;
  };
  readonly expiresAt?: string;
  readonly [pageContinuationBrand]: true;
}

interface PageEvidence {
  readonly kind:
    | "protocol-contract" | "response-flag" | "continuation"
    | "short-page" | "unpaged";
  readonly reference: string;
}

type PageRequest =
  | { readonly kind: "first"; readonly limit?: number }
  | { readonly kind: "offset"; readonly offset: number; readonly limit?: number }
  | {
      readonly kind: "continuation";
      readonly continuation: PageContinuation;
    };

type PageResultState =
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
      readonly next: Extract<PageRequest, { readonly kind: "offset" }>;
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    }
  | {
      readonly state: "more";
      readonly mode: "cursor";
      readonly returned: number;
      readonly next: Extract<PageRequest, { readonly kind: "continuation" }> & {
        readonly continuation: PageContinuation<"cursor">;
      };
      readonly evidence: NonEmptyReadonlyArray<PageEvidence>;
    }
  | {
      readonly state: "more";
      readonly mode: "next-link";
      readonly returned: number;
      readonly next: Extract<PageRequest, { readonly kind: "continuation" }> & {
        readonly continuation: PageContinuation<"next-link">;
      };
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

type ResultCount<Scope extends "matched-features" | "result-rows"> =
  | ExactResultCount<Scope>
  | EstimatedResultCount<Scope>
  | UnknownResultCount<Scope>;

type QueryV2<
  T,
  P extends SourceProtocol,
  S extends SourceSpatiality,
> = FeatureQuery<T, P, S> | AggregateQuery<T, P, S>;

type FeatureIdentityValue = string | number | boolean;
type FeatureIdentityForFields<
  Fields extends NonEmptyReadonlyArray<string>,
> = Fields extends readonly [infer Field extends string]
  ? { readonly kind: "scalar"; readonly field: Field; readonly value: FeatureIdentityValue }
  : Fields extends readonly [string, string, ...string[]]
    ? {
        readonly kind: "composite";
        readonly parts: IdentityPartsForSchemaKey<Fields>;
      }
    : FeatureIdentity;

interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface SourceV2<T, P extends SourceProtocol, S extends SchemaState> {
  readonly descriptor: SourceDescriptorV2<P, S>;
  readonly spatiality: SpatialityForSchemaState<S>;
  query<
    const Q extends QueryV2<T, P, SpatialityForSchemaState<S>>,
  >(
    query: Q,
    options?: { readonly signal?: AbortSignalLike },
  ): Promise<
    ResultFor<
      T,
      Q,
      SpatialityForSchemaState<S>,
      S
    >
  >;
}

declare function sourceFromDescriptor<
  T,
  P extends SourceProtocol,
  S extends SchemaState,
>(descriptor: SourceDescriptorV2<P, S>): SourceV2<T, P, S>;
```

`SemanticFilter<T, Spatiality>` contains typed
equality/order/null/list/range/pattern, boolean composition, spatial predicates
with an `ExecutableGeometryValue`, and temporal predicates with tagged
date/instant/interval values. Field/value compatibility is constrained where
TypeScript knows it and always revalidated against `SourceSchemaV2` at runtime.
Temporal string eligibility is not inferred from JavaScript `string`: schema
binding/code generation brands fields whose logical type/role is temporal.
Ordinary strings such as owner/name cannot use before/after/during operators;
manual type assertions cannot bypass the runtime schema/role check.
Non-spatial sources have no semantic spatial-predicate member. Ambiguous
geometry sources require `field`; only a known-primary source may omit it.
Spatial operands cannot be empty and must have resolved CRS plus known payload
order; preserved present geometry with unknown CRS/order therefore fails
closed. Topological `equals` is explicit. Bbox intersection accepts an
`ExecutableBoundingBox`, so its CRS and payload order are as trustworthy as a
geometry operand. Distance predicates carry a finite, strictly positive value,
an enumerated unit and an explicit planar/geodesic mode. Adapters either
compile the exact predicate advertised by capability evidence or return the
common unsupported/fidelity error; they do not approximate bbox/distance by
manufacturing polygons or buffers. `AggregateMetric<T>` restricts `sum`,
`avg`, standard deviation and variance to numeric fields; count accepts an
optional field; min/max accept
ordered string, number, bigint or date fields, never booleans. Sort keys are
ordered scalar fields, and group keys are scalar fields; geometry and struct
fields are rejected. Every aggregate query has at least one metric.
`outputCrs` must be a resolved authority, WKT, URI or bounded PROJJSON
definition and is absent on a proven non-spatial source; an unknown CRS is
metadata, not an executable output instruction.

Native filters are tagged as `honua-grpc`, `geoservices-sql92`, `cql2-json`,
`cql2-text`, `fes-2.0`, `odata-4.0`, `duckdb-sql` or a namespaced extension.
The type mapping rejects a GeoServices SQL expression on an OGC/OData/WFS
source. Payload form is also coupled to dialect: Honua gRPC and CQL2 JSON carry
JSON, FES 2.0 carries XML, and GeoServices SQL92, CQL2 text, OData 4.0 and
DuckDB SQL carry text. Built-in dialects are matched before the broad
reverse-DNS template—important because names such as `odata-4.0` contain a
dot. Namespaced extensions may explicitly choose text, XML or JSON. Capability
evidence still decides whether a semantically valid query is executable; a
protocol literal alone never promises support.

`ResultFor<T, Q, Spatiality, SchemaIdentity>` is conditional:

- a feature query with `select: ["id", "owner"]` returns properties
  `Pick<T, "id" | "owner">`;
- a proven primary-geometry source includes top-level geometry by default;
  non-spatial sources allow only `"omit"`, while ambiguous sources require a
  named secondary field before geometry can be included;
- `geometry: "omit"` removes top-level geometry from the feature type;
- a named secondary geometry is promoted to top-level geometry and removed
  from projected properties for that result;
- included geometry is `GeometryValue`, whose empty state is explicit;
- an aggregate query returns group fields plus metric aliases, with count and
  numeric metrics as numbers and min/max retaining the source field type.

Feature identity is derived from the descriptor schema, not merely optional
decoration. When `schema.key` is known, every returned feature must contain an
identity with exactly those fields in declared key order: exactly one key uses
the scalar form with a required field name, and two or more use the composite
form with exactly one part per key field. Part values follow each field's JSON
encoding, so Int64/decimal/date values use strings where required. Duplicate,
missing, extra, reordered or wrongly encoded parts fail result validation, and
identities must be unique within a result page. When the key is explicitly
none, unknown, or the schema is unavailable, identity is optional but—if
present—must still be a valid JSON-safe scalar or ordered composite. No adapter
may delimiter-join a composite key or fabricate a vendor-specific ID.

Ordered query collections have explicit collision rules. `select`, `sort` and
`groupBy` contain no duplicate field names; their order remains significant
for projection, precedence and result layout. Schema key fields are unique and
ordered. Metric aliases are unique and may not collide with any `groupBy`
field. These constraints are runtime-validated because variadic arrays can
escape literal type checking; invalid queries never reach an adapter or enter
a fingerprint.

Pagination has three request forms. `first` optionally constrains initial page
size; `offset` is canonical JSON-safe state; `continuation` accepts only an
opaque runtime-created handle. The handle publicly exposes mode, expiry, and
its descriptor/base-query fingerprint binding. Raw `$skiptoken`, cursor bytes,
signed URLs and next-link URLs live only in a private runtime vault keyed by
the branded object—they are not descriptor/query JSON, persistent cache keys,
logs or telemetry. The base query fingerprint excludes page and execution
options. Resume validates the exact descriptor and base-query fingerprints
before resolving the secret; mismatch/expiry/unknown-handle failures use #524's
common tagged error envelope. A next link is never surfaced as an ordinary URL
or followed without the adapter's origin/credential policy.

At execution, offsets are safe integers greater than or equal to zero. Limits
are safe integers greater than zero and no larger than the effective
`maxPageSize`; the requested mode must be effectively supported. Continuations
must match both the advertised mode and their exact descriptor/base-query
binding. A result's `returned` is a non-negative safe integer equal to
`features.length` or `rows.length`.

Page completeness is evidence-bearing. `complete` is allowed only from an
explicit end signal, a reviewed protocol contract (including a short-page rule
when that contract truly guarantees it), or a declared unpaged adapter.
`more/offset` requires explicit more-data evidence and a safely computed next
offset. Cursor and next-link states require a valid private continuation of the
same mode. Missing, conflicting or invalid evidence produces `unknown`; it
never invents `complete` or an offset. Evidence references name sanitized
protocol requirements/fields and never contain a raw token or URL.

Total count is never an optional bare number. Every feature result carries a
`matched-features` count and every aggregate result a `result-rows` count.
`exact` requires protocol or computed evidence; `estimated` identifies its
estimate evidence and may include confidence in the closed interval 0..1;
`unknown` states why no value is available. Count values are finite,
non-negative safe integers, are at least the returned page length, and never
use a short page as proof of an exact total. Count evidence is sanitized like
page evidence. Callers therefore cannot mistake a catalog estimate for an
exact query total or absence for zero.

Feature results always contain an array (possibly empty), page/count state,
explicit spatial/temporal extent states, honest schema identity and
observation. Aggregate results contain rows, page/count state, schema identity
and observation. The
contract-owned structural `AbortSignalLike` is an execution option, carries no
DOM type, and never serializes or enters query identity.

The canonical property member is `properties`, not Esri `attributes`. The
legacy adapter keeps `attributes` until the pre-1.0 migration stage below.

For example, this query promotes the secondary `centroid` field:

```json
{
  "kind": "features",
  "select": ["parcelId", "centroid"],
  "geometry": { "field": "centroid" },
  "filter": { "op": "eq", "field": "status", "value": "active" },
  "page": { "kind": "first", "limit": 100 }
}
```

The promoted value occurs only at top level in the corresponding result;
`properties.centroid` is intentionally absent:

```json
{
  "kind": "feature-result",
  "features": [
    {
      "identity": { "kind": "scalar", "field": "parcelId", "value": "42" },
      "properties": { "parcelId": "42" },
      "geometry": {
        "state": "present",
        "geometry": { "type": "Point", "coordinates": [-157.86, 21.31] },
        "crs": {
          "definition": { "kind": "unknown", "reason": "missing" },
          "coordinateOrder": { "state": "known", "source": "encoding", "axes": [
            { "name": "x", "direction": "east", "unit": "unknown" },
            { "name": "y", "direction": "north", "unit": "unknown" }
          ] },
          "provenance": { "method": "payload" }
        },
        "layout": "xy"
      }
    }
  ],
  "page": {
    "state": "complete",
    "mode": "offset",
    "returned": 1,
    "evidence": [
      { "kind": "response-flag", "reference": "hasMore:false" }
    ]
  },
  "count": {
    "state": "exact",
    "scope": "matched-features",
    "value": 1,
    "evidence": [
      { "kind": "protocol", "reference": "numberMatched" }
    ]
  },
  "extent": {
    "state": "unknown",
    "reason": "not-computed",
    "provenance": [
      {
        "method": "unavailable",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels/items"
      }
    ]
  },
  "temporalExtent": {
    "state": "unknown",
    "reason": "not-computed",
    "provenance": [
      {
        "method": "unavailable",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels/items"
      }
    ]
  },
  "schema": { "state": "known", "fingerprint": "sha256:schema-a1" },
  "observation": {
    "state": "live",
    "observedAt": "2026-07-13T12:05:00Z",
    "provenance": [
      {
        "method": "observed",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels/items"
      }
    ]
  }
}
```

An OData entity with a composite key keeps ordered, typed parts rather than a
delimiter-joined synthetic string:

```json
{
  "kind": "composite",
  "parts": [
    { "field": "tenantId", "value": "honolulu" },
    { "field": "parcelNumber", "value": "9007199254740993" }
  ]
}
```

An offset request is ordinary canonical query JSON:

```json
{ "kind": "offset", "offset": 100, "limit": 100 }
```

Estimated and unavailable counts remain distinguishable from exact totals:

```json
{
  "state": "estimated",
  "scope": "matched-features",
  "value": 1000000,
  "confidence": 0.95,
  "evidence": [{ "kind": "estimate", "reference": "catalog-statistics" }]
}
```

```json
{
  "state": "unknown",
  "scope": "matched-features",
  "reason": "not-requested",
  "evidence": [{ "kind": "unavailable", "reference": "query:count=false" }]
}
```

By contrast, JSON/stringification of an opaque continuation can expose only
safe binding metadata such as the following. The missing symbol brand and
private-vault entry mean this diagnostic projection cannot be parsed back into
a valid continuation, and no raw next link or cursor appears:

```json
{
  "kind": "honua.page-continuation",
  "mode": "next-link",
  "binding": {
    "descriptorFingerprint": "sha256:descriptor-01",
    "queryFingerprint": "sha256:query-without-page-01"
  },
  "expiresAt": "2026-07-13T12:15:00Z"
}
```

## Protocol normalization examples

The canonical logical output does not contain the native strings shown in the
left column except inside `native[]` provenance.

| Input | Canonical mapping |
| --- | --- |
| GeoServices `esriFieldTypeOID` | `integer { bits: 32/64 from observed metadata, signed: true, jsonEncoding }`, roles `primary-key`, `feature-id` |
| GeoServices `esriFieldTypeString` | `string { maxLength }`; alias becomes `title`; editable becomes `mutability` |
| GeoServices coded/range domain | closed/open coded values or inclusive range endpoints; duplicate codes/conflicting bounds fail validation |
| GeoServices `esriGeometryPolyline` | geometry `LineString` or `MultiLineString` only after value inspection/conversion; envelope becomes extent, not geometry |
| OGC API JSON Schema string/date-time | `timestamp`; collection CRS/extent are normalized independently |
| WFS XSD `xsd:long` | signed 64-bit integer; QName path retains namespace provenance |
| WFS GML geometry property | canonical geometry kind when recognized; `DefaultCRS`/wire `srsName` become separate CRS/order evidence |
| OData `Edm.Int64` | signed 64-bit integer; `jsonEncoding` reflects IEEE754-compatible representation |
| OData complex/collection property | `struct`/`list`; path segments retain nesting; entity key becomes key/ID roles |
| OData EnumType / validation annotation | coded domain or portable constraint when recognized; otherwise bounded native provenance |
| JSON Schema / XSD restriction | enum/range/pattern/length constraint with source lexical values normalized to the field JSON encoding |
| STAC `id`, `geometry`, `datetime`, `assets` | feature ID role, RFC 7946 geometry, UTC timestamp role, JSON/struct asset metadata; STAC extensions remain namespaced |
| GeoParquet Arrow field | logical scalar/list/struct; `geo.primary_column` identifies default geometry; empty `geometry_types` is unknown, multiple values are mixed |
| Unknown extension/native type | logical `unknown` with `NativeTypeReference`; never coerced to string or point |

An OData adapter may claim `openContent: "closed"` only after projecting the
complete selected entity shape. Namespace-local type collisions and unresolved
`BaseType` inheritance on the selected entity or a referenced complex type
make focused schema projection unavailable/invalid rather than producing a
closed partial field list.

Resolved locator examples:

```json
{
  "protocol": "geoservices-feature-service",
  "endpoint": "https://example.test/arcgis/rest/services/Parcels/FeatureServer",
  "layerId": 0
}
```

```json
{
  "protocol": "ogc-features",
  "endpoint": "https://example.test/ogc",
  "collectionId": "parcels",
  "layout": "ogc-api"
}
```

<!-- contract-example:ogc-tiles-dataset -->
```json
{
  "protocol": "ogc-tiles",
  "endpoint": "https://example.test/ogc",
  "scope": "dataset",
  "tileMatrixSetId": "WebMercatorQuad"
}
```

<!-- contract-example:ogc-tiles-collection -->
```json
{
  "protocol": "ogc-tiles",
  "endpoint": "https://example.test/ogc",
  "scope": "collection",
  "collectionId": "parcels",
  "tileMatrixSetId": "WebMercatorQuad"
}
```

<!-- contract-example:ogc-maps-dataset -->
```json
{
  "protocol": "ogc-maps",
  "endpoint": "https://example.test/ogc",
  "scope": "dataset",
  "styleId": "default"
}
```

<!-- contract-example:ogc-maps-collection -->
```json
{
  "protocol": "ogc-maps",
  "endpoint": "https://example.test/ogc",
  "scope": "collection",
  "collectionId": "parcels",
  "styleId": "default"
}
```

```json
{
  "protocol": "wfs",
  "endpoint": "https://example.test/wfs",
  "version": "2.0.0",
  "featureType": {
    "namespaceUri": "https://example.test/ns/parcels",
    "localName": "parcel",
    "prefix": "parcels"
  }
}
```

```json
{
  "protocol": "odata",
  "endpoint": "https://example.test/odata",
  "version": "4.0",
  "entitySet": "Parcels"
}
```

```json
{
  "protocol": "stac",
  "endpoint": "https://example.test/stac",
  "scope": "api-collection",
  "collectionId": "landsat-c2-l2"
}
```

```json
{
  "protocol": "geoparquet",
  "assets": [
    {
      "kind": "url",
      "href": "https://example.test/overture/places/*.parquet",
      "pattern": "glob"
    }
  ],
  "hivePartitioning": true
}
```

```json
{
  "protocol": "maplibre-vector",
  "tiles": {
    "form": "tilejson",
    "resource": {
      "kind": "url",
      "href": "https://example.test/vector/tilejson.json"
    }
  },
  "sourceLayer": "parcels"
}
```

```json
{
  "protocol": "maplibre-raster",
  "tiles": {
    "form": "templates",
    "templates": [
      { "kind": "url", "href": "https://a.example.test/{z}/{x}/{y}.png" },
      { "kind": "url", "href": "https://b.example.test/{z}/{x}/{y}.png" }
    ],
    "scheme": "xyz",
    "minZoom": 0,
    "maxZoom": 18
  },
  "tileSize": 512
}
```

```json
{
  "protocol": "pmtiles",
  "resource": { "kind": "file", "path": "/srv/tiles/hawaii.pmtiles" }
}
```

```json
{
  "protocol": "io.honua.example-protocol",
  "resource": {
    "kind": "resolver",
    "resolver": "io.honua.example-resolver",
    "id": "parcels:2"
  },
  "extension": {
    "locatorVersion": "1",
    "payload": { "dataset": "parcels", "shard": 2 }
  }
}
```

### Canonical schema, geometry, extent and descriptor examples

The following objects are serialized JSON, not in-memory vendor objects. Hash
values are shortened only for readability.

A logical field preserves its source spelling in bounded provenance while its
meaning and extension data remain vendor-neutral and JSON-safe:

```json
{
  "name": "parcelId",
  "path": ["OBJECTID"],
  "title": "Parcel identifier",
  "type": {
    "kind": "integer",
    "bits": 64,
    "signed": true,
    "jsonEncoding": "string"
  },
  "nullability": "non-nullable",
  "mutability": "read-only",
  "roles": ["primary-key", "feature-id"],
  "domain": { "state": "unknown", "reason": "not-reported" },
  "constraints": { "state": "unknown", "reason": "not-reported" },
  "native": [
    {
      "protocol": "geoservices-feature-service",
      "name": "esriFieldTypeOID",
      "path": ["fields", "OBJECTID"],
      "definition": { "length": 8 }
    }
  ],
  "extensions": {
    "io.honua.example.display": { "base": 10 }
  }
}
```

A portable coded domain and a decimal-string range keep validation semantics
without leaking vendor domain objects:

<!-- contract-example:field-domain-coded -->
```json
{
  "state": "coded",
  "openness": "closed",
  "values": [
    { "value": "active", "label": "Active" },
    { "value": "retired", "label": "Retired" }
  ]
}
```

<!-- contract-example:field-domain-range -->
```json
{
  "state": "range",
  "minimum": { "value": "0.00", "inclusive": true },
  "maximum": { "value": "9999999999999999.99", "inclusive": true },
  "unit": "USD"
}
```

A known schema may still honestly describe mixed geometry. Here two geometry
fields are known, `footprint` is the default, and both CRS bindings are
explicitly unknown rather than silently assumed:

```json
{
  "state": "known",
  "value": {
    "kind": "honua.source-schema",
    "version": "2.0",
    "fingerprint": "sha256:schema-a1",
    "fields": [
      {
        "name": "footprint",
        "path": ["footprint"],
        "type": { "kind": "geometry" },
        "nullability": "nullable",
        "mutability": "read-only",
        "roles": ["geometry"],
        "domain": { "state": "none", "reason": "not-applicable" },
        "constraints": { "state": "none" },
        "native": []
      },
      {
        "name": "centroid",
        "path": ["centroid"],
        "type": { "kind": "geometry" },
        "nullability": "nullable",
        "mutability": "read-only",
        "roles": ["geometry"],
        "domain": { "state": "none", "reason": "not-applicable" },
        "constraints": { "state": "none" },
        "native": []
      }
    ],
    "key": { "state": "unknown", "reason": "not-declared" },
    "geometry": {
      "state": "known",
      "primaryField": { "state": "known", "field": "footprint" },
      "fields": [
        {
          "field": "footprint",
          "geometryTypes": {
            "state": "mixed",
            "types": ["Polygon", "MultiPolygon"]
          },
          "crs": {
            "definition": { "kind": "unknown", "reason": "missing" },
            "coordinateOrder": { "state": "unknown", "reason": "missing" },
            "provenance": { "method": "metadata" }
          },
          "layout": "xy",
          "allowsEmpty": true
        },
        {
          "field": "centroid",
          "geometryTypes": { "state": "known", "type": "Point" },
          "crs": {
            "definition": { "kind": "unknown", "reason": "missing" },
            "coordinateOrder": { "state": "unknown", "reason": "missing" },
            "provenance": { "method": "metadata" }
          },
          "layout": "xy",
          "allowsEmpty": true
        }
      ]
    },
    "temporal": { "state": "none" },
    "openContent": "closed",
    "provenance": [
      {
        "method": "observed",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels",
        "observedAt": "2026-07-13T12:00:00Z"
      }
    ]
  }
}
```

Present and empty geometry remain distinct. Unknown CRS does not make a
present geometry an unknown geometry, but it prevents that value from becoming
an executable spatial operand. An empty value does not invent a coordinate
layout:

```json
{
  "state": "present",
  "geometry": { "type": "Point", "coordinates": [-157.86, 21.31] },
  "crs": {
    "definition": { "kind": "unknown", "reason": "missing" },
    "coordinateOrder": { "state": "known", "source": "encoding", "axes": [
      { "name": "x", "direction": "east", "unit": "unknown" },
      { "name": "y", "direction": "north", "unit": "unknown" }
    ] },
    "provenance": { "method": "payload" }
  },
  "layout": "xy"
}
```

```json
{
  "state": "empty",
  "expectedType": "Polygon",
  "crs": {
    "definition": { "kind": "unknown", "reason": "missing" },
    "coordinateOrder": { "state": "unknown", "reason": "missing" },
    "provenance": { "method": "metadata" }
  },
  "layout": "unknown"
}
```

Extent state is equally explicit. A known extent has one or more boxes and one
CRS binding; non-spatial and uncomputed are different values:

<!-- contract-example:spatial-extent-known -->
```json
{
  "state": "known",
  "boxes": [
    { "layout": "xy", "bounds": [-160.3, 18.9, -154.7, 22.3] }
  ],
  "crs": {
    "definition": {
      "kind": "authority",
      "authority": "OGC",
      "code": "CRS84",
      "uri": "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
      "definitionAxisOrder": { "state": "unknown", "reason": "unrecognized" }
    },
    "coordinateOrder": { "state": "known", "source": "encoding", "axes": [
      { "name": "longitude", "direction": "east", "unit": "degree" },
      { "name": "latitude", "direction": "north", "unit": "degree" }
    ] },
    "provenance": { "method": "standard-default" }
  },
  "provenance": [
    {
      "method": "observed",
      "protocol": "ogc-features",
      "source": "https://example.test/ogc/collections/hawaii"
    }
  ]
}
```

<!-- contract-example:spatial-extent-unknown -->
```json
{
  "state": "unknown",
  "reason": "not-computed",
  "provenance": [
    {
      "method": "unavailable",
      "protocol": "ogc-features",
      "source": "https://example.test/ogc/collections/hawaii"
    }
  ]
}
```

<!-- contract-example:spatial-extent-none -->
```json
{
  "state": "none",
  "reason": "non-spatial",
  "provenance": [
    {
      "method": "declared",
      "protocol": "odata",
      "source": "https://example.test/odata/$metadata#Parcels"
    }
  ]
}
```

STAC/OGC temporal extents preserve multiple and open intervals. Empty,
unknown and declared non-temporal remain separate evidence-bearing states:

```json
{
  "state": "known",
  "intervals": [
    [null, "2018-12-31T23:59:59Z"],
    ["2020-01-01T00:00:00Z", "2020-12-31T23:59:59Z"],
    ["2024-01-01T00:00:00Z", null]
  ],
  "referenceSystem": { "kind": "gregorian" },
  "provenance": [
    {
      "method": "observed",
      "protocol": "stac",
      "source": "https://example.test/stac/collections/landsat-c2-l2"
    }
  ]
}
```

```json
{
  "state": "empty",
  "reason": "no-temporal-values",
  "provenance": [
    {
      "method": "observed",
      "protocol": "stac",
      "source": "https://example.test/stac/collections/empty"
    }
  ]
}
```

```json
{
  "state": "unknown",
  "reason": "not-reported",
  "provenance": [
    {
      "method": "unavailable",
      "protocol": "ogc-features",
      "source": "https://example.test/ogc/collections/parcels"
    }
  ]
}
```

```json
{
  "state": "none",
  "reason": "non-temporal",
  "provenance": [
    {
      "method": "declared",
      "protocol": "odata",
      "source": "https://example.test/odata/$metadata#Parcels"
    }
  ]
}
```

A complete descriptor can be persisted before schema discovery. Its
unavailable schema makes source spatiality ambiguous until a later descriptor
revision supplies validated geometry knowledge:

```json
{
  "kind": "honua.source-descriptor",
  "version": "2.0",
  "id": "parcels",
  "locator": {
    "protocol": "ogc-features",
    "endpoint": "https://example.test/ogc",
    "collectionId": "parcels",
    "layout": "ogc-api"
  },
  "schema": {
    "state": "unavailable",
    "reason": "not-requested",
    "provenance": [
      {
        "method": "unavailable",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels"
      }
    ]
  },
  "extent": {
    "state": "unknown",
    "reason": "not-reported",
    "provenance": [
      {
        "method": "unavailable",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels"
      }
    ]
  },
  "temporalExtent": {
    "state": "unknown",
    "reason": "not-reported",
    "provenance": [
      {
        "method": "unavailable",
        "protocol": "ogc-features",
        "source": "https://example.test/ogc/collections/parcels"
      }
    ]
  },
  "capabilities": {
    "kind": "honua.capabilities",
    "version": "1.0",
    "fingerprint": "sha256:cap-01",
    "entries": []
  },
  "identity": {
    "descriptorFingerprint": "sha256:descriptor-01",
    "schema": {
      "state": "unavailable",
      "reason": "not-requested",
      "provenance": [
        {
          "method": "unavailable",
          "protocol": "ogc-features",
          "source": "https://example.test/ogc/collections/parcels"
        }
      ]
    },
    "capabilityFingerprint": "sha256:cap-01"
  },
  "provenance": [
    {
      "method": "observed",
      "protocol": "ogc-features",
      "source": "https://example.test/ogc/collections/parcels",
      "validator": { "kind": "etag", "value": "metadata-v4" }
    }
  ],
  "extensions": {
    "io.honua.example.catalog": { "tenant": "public" }
  }
}
```

### CRS and provenance examples

An EPSG authority/code whose definition order differs from a GeoJSON payload:

```json
{
  "definition": {
    "kind": "authority",
    "authority": "EPSG",
    "code": "4326",
    "uri": "http://www.opengis.net/def/crs/EPSG/0/4326",
    "definitionAxisOrder": {
      "state": "known",
      "source": "crs-definition",
      "axes": [
        { "name": "geodetic latitude", "direction": "north", "unit": "degree" },
        { "name": "geodetic longitude", "direction": "east", "unit": "degree" }
      ]
    }
  },
  "coordinateOrder": {
    "state": "known",
    "source": "encoding",
    "axes": [
      { "name": "geodetic longitude", "direction": "east", "unit": "degree" },
      { "name": "geodetic latitude", "direction": "north", "unit": "degree" }
    ]
  },
  "provenance": { "method": "standard-default" }
}
```

WKT without a resolved authority/code is still known CRS identity:

```json
{
  "kind": "wkt",
  "dialect": "wkt2",
  "name": "NAD83 / Hawai'i zone 3",
  "wkt": "PROJCRS[\"NAD83 / Hawaii zone 3\",...]",
  "definitionAxisOrder": {
    "state": "known",
    "source": "crs-definition",
    "axes": [
      { "name": "easting", "direction": "east", "unit": "metre" },
      { "name": "northing", "direction": "north", "unit": "metre" }
    ]
  }
}
```

An absolute URI advertised by an OGC API remains resolved even when the SDK
has no reviewed authority/code split:

```json
{
  "kind": "uri",
  "uri": "https://schemas.example.test/crs/hawaii-geographic-v1",
  "name": "Hawaii geographic CRS advertised by OGC API",
  "definitionAxisOrder": {
    "state": "known",
    "source": "crs-definition",
    "axes": [
      { "name": "longitude", "direction": "east", "unit": "degree" },
      { "name": "latitude", "direction": "north", "unit": "degree" }
    ]
  }
}
```

GeoParquet PROJJSON is retained as bounded canonical JSON, rather than reduced
to a display name or marked unknown:

```json
{
  "kind": "projjson",
  "name": "WGS 84",
  "projjson": {
    "$schema": "https://proj.org/schemas/v0.7/projjson.schema.json",
    "type": "GeographicCRS",
    "name": "WGS 84",
    "datum_ensemble": { "name": "World Geodetic System 1984 ensemble" }
  },
  "definitionAxisOrder": {
    "state": "known",
    "source": "crs-definition",
    "axes": [
      { "name": "geodetic latitude", "direction": "north", "unit": "degree" },
      { "name": "geodetic longitude", "direction": "east", "unit": "degree" }
    ]
  }
}
```

Missing CRS is explicit and is not WGS84:

```json
{
  "definition": { "kind": "unknown", "reason": "missing" },
  "coordinateOrder": { "state": "unknown", "reason": "missing" },
  "provenance": { "method": "metadata" }
}
```

A non-spatial WFS `NoCRS` feature type has no CRS object at all:

```json
{
  "geometry": {
    "state": "none",
    "reason": "declared-non-spatial"
  }
}
```

Reprojection is explicit provenance rather than an inferred WKID change:

```json
{
  "method": "reprojected",
  "reprojection": {
    "source": {
      "kind": "authority",
      "authority": "EPSG",
      "code": "4326",
      "definitionAxisOrder": { "state": "unknown", "reason": "unrecognized" }
    },
    "target": {
      "kind": "authority",
      "authority": "EPSG",
      "code": "3857",
      "definitionAxisOrder": { "state": "unknown", "reason": "unrecognized" }
    },
    "operation": "EPSG:3856",
    "engine": "proj-wasm@x.y.z",
    "accuracyMeters": 1
  }
}
```

## Compatibility adapters

Compatibility is an explicit boundary, not fields added to v2. Conversion
functions live internally during rollout and later under the Esri/legacy
compatibility subpath. Their accepted signatures are:

Every conversion returns `exact`, `lossy` with path-addressed losses, or
`unsupported`; the complete future signatures remain implementation work, not
a second declaration surface in this design ADR.

Conversion rules:

- legacy descriptors lacking resolved locator identity, schema/capability
  fingerprints or evidence return `lossy` or `unsupported`; conversion never
  manufactures trusted identity or capability observations. Missing schema or
  temporal extent becomes evidence-bearing `unavailable`/`unknown`, never a
  fake fingerprint, empty interval, or non-temporal claim;
- `HonuaFieldInfo.type` maps through a closed table. An unrecognized Esri type
  becomes logical `unknown` with native provenance.
- `wkid` is not automatically EPSG. The authority resolver must confirm it;
  otherwise CRS is unknown with the WKID retained natively. `latestWkid` is
  provenance, not proof that reprojection occurred.
- Esri envelope maps to `SpatialExtent`/bbox intent, never a geometry value.
  Unknown/malformed geometry fails closed as required by #521 and reports
  through #524.
- legacy `where` becomes a dialect-tagged native filter selected from the
  resolved protocol; it is never relabeled semantic.
- `outFields`, order, grouping and metric names validate against schema;
  `returnGeometry` maps to `include`/`omit`; legacy offset/limit maps to a
  discriminated page request; `signal` moves to structural execution options.
- a legacy object ID becomes scalar feature identity. Composite keys use
  ordered named parts; reverse conversion may be lossy/unsupported rather than
  delimiter-joining them;
- raw legacy continuation tokens/next links are accepted only at an internal
  adapter boundary and wrapped in a runtime vault. `exceededTransferLimit`
  without enough request/continuation evidence cannot fabricate a next page;
- legacy result `attributes` maps to canonical `properties`. Raw fields remain
  on the Esri/native response surface.
- reverse conversion is allowed to return `lossy` or `unsupported`; it must not
  fabricate an Esri type, WKID, envelope or SQL string.

All conversion failures and warnings use #524's common tagged SDK
error/diagnostic envelope. This ADR intentionally does not define competing
error domains, codes or serialization.

## Cache, plan and realtime invalidation

Every fingerprint is SHA-256 over UTF-8 bytes consisting of a domain separator,
a newline, and RFC 8785 canonical JSON of the projection below. The separators
are respectively `honua:schema:2.0`, `honua:capabilities:1.0`, and
`honua:descriptor:2.0`; the stored form is lowercase
`sha256:<64-hex-digits>`. Implementations must not hash the serialized public
object wholesale. Property presence is significant: an omitted constraint
means unknown/unbounded, while an explicit empty array means observed none.
Before hashing, set-like arrays are deduplicated and sorted by their canonical
JSON bytes; order-bearing arrays remain in declared order.

The `schemaFingerprint` projection contains exactly:

- schema `kind`, `version`, `openContent`, and schema `extensions`;
- logical fields sorted by canonical `path` then `name`, including `name`,
  `path`, logical type, nullability, mutability, default-value
  presence/value, sorted/deduplicated roles, canonical domain/constraint state,
  and field extensions;
- key state and reason, with known key fields retained in declared order;
- geometry-schema state/reason, fields sorted by field name, primary-field
  state, and each field's type knowledge, layout, allows-empty and canonical
  CRS binding;
- temporal-schema state/reason: instant field, role-ordered interval start/end,
  or sorted/deduplicated mixed fields.

Logical union members and mixed geometry kinds are sets and therefore sorted;
struct fields use the same path/name sort as top-level fields. A canonical CRS
binding includes definition kind and semantic content, definition/payload axis
orders, coordinate epoch and reprojection source/target/operation/engine/
accuracy. Authority aliases, absolute URI strings, WKT text and the full
bounded RFC 8785 PROJJSON object are identity-bearing. It excludes the
`fingerprint` property itself, titles/descriptions, every `native` reference,
except the domain/constraint reference identities described below, schema
provenance, observation timestamps, `transformedAt`, and presentation names.
Unknown state/reason remains identity-bearing.

Coded domain values are sorted by canonical JSON value; constraint entries are
sorted by kind; range endpoint roles remain distinct. Domain labels,
descriptions, openness, units, extension data, partial/unknown reasons and the
presence of bounded native evidence are included. Native protocol payloads are
still excluded: for unknown/partial states the projection retains only each
native reference's protocol/name/namespace/path identity, not its `definition`.

The `capabilityFingerprint` projection contains exactly `kind`, `version`, and
entries sorted by capability id. Each entry contains id, claimed/observed/
effective truth, sorted/deduplicated reason codes and authorization-scope ids,
constraints, requirements, and evidence. Constraint formats/operators/predicates/CRS values/
pagination modes are sets and sorted; numeric limits and property presence are
preserved; extensions are included. Evidence is sorted by canonical
`[kind,truth,reference,sourceFingerprint]` and excludes `observedAt` and
`expiresAt`. The
projection excludes only the profile's `fingerprint` field and observation/
expiry timestamps.

The `descriptorFingerprint` projection contains exactly:

- descriptor `kind`, `version`, `id`, sanitized resolved locator identity and
  descriptor extensions (WFS QName prefix and other presentation-only aliases
  are excluded; OGC Tiles/Maps scope is included and `collectionId` is included
  only at collection scope; template/resource array order remains significant);
- schema identity: its known schema fingerprint, or unavailable state/reason
  plus canonical evidence projection;
- canonical spatial and temporal extents, including explicit bbox layout,
  bounds, CRS/reference system and evidence projection; boxes, mixed extent
  components and temporal intervals are sorted/deduplicated by canonical bytes;
- capability fingerprint, `sourceRevision` presence/value and
  `authorizationContextId` presence/value;
- descriptor provenance projected to sorted
  `[method,protocol,source,validator]` records.

The shared evidence projection keeps validator kind/value but excludes
`observedAt` and free-form `detail`. The descriptor projection excludes
`descriptorFingerprint` itself, the duplicated schema/capability objects,
attribution, retrieval/expiry timestamps, credentials, resolver outputs and
raw cursor/next-link values. A validator change therefore invalidates a
descriptor even when semantic schema/capability fingerprints remain stable;
an observation-time-only change does not. Cache records retain timestamps and
the full evidence beside semantic identity.

A plan binds at least:

```text
source id
+ descriptor fingerprint
+ schema identity
+ capability fingerprint
+ authorization context id
+ policy fingerprint
+ semantic query fingerprint
+ contract/planner version
```

The semantic query fingerprint excludes `page` and execution options so every
continuation binds to the same base query. A first/offset request has a separate
JSON-safe page-request fingerprint for response-cache partitioning. Opaque
continuation responses are non-persistent by default; an implementation may
use a process-local keyed digest, but never raw cursor/next-link bytes, as an
ephemeral cache coordinate. Telemetry records only mode and safe binding
fingerprints.

Any changed component makes the plan stale. Execution returns the common typed
stale-plan failure; it does not silently replan.

A realtime subscription binds the same identity plus the snapshot plan
fingerprint. Cursor/token bytes are transport state and never descriptor/query
identity. Any changed descriptor component—including unavailable-to-known
schema, capabilities, or canonical spatial/temporal extents—invalidates the
bound descriptor/plan. A schema/capability change cannot promote new deltas
into the old typed result; the state machine pauses/terminates with evidence
and requires an explicit compatible migration or resnapshot. Exact cursor, ordering,
backpressure and resnapshot semantics remain owned by
[#556](https://github.com/honua-io/honua-sdk-js/issues/556).

## Staged migration

1. **Design gate (#522, this change).** Land only this ADR, design-only
   declarations and compile fixtures. No public export or adapter behavior
   changes.
2. **Schema module (#523).** Add experimental v2 schema/geometry/CRS,
   spatial/temporal extent, field domain/constraint, schema-identity and
   feature-identity types with canonical serialization. Migrate GeoServices,
   OData 4.0 and GeoParquet
   discovery behind internal dual-read adapters. Keep v1 output unchanged;
   #552 supplies static STAC time/extent discovery.
3. **Capability truth (#525).** Add the array-based capability profile,
   evidence combiner and `source.supports()` narrowing. Keep a legacy set view
   as a derived compatibility value, never the stored source of truth.
4. **Semantic query (#526).** Implement and runtime-validate the AST, CQL2 JSON
   interchange, projection/result inference, discriminated page/result state,
   branded temporal eligibility, exact/estimated/unknown counts, opaque
   continuation vault and native dialect nodes. Legacy `where` becomes
   a documented deprecated adapter path.
5. **Protocol compilers (#527–#529).** Consume only v2 query/schema/CRS and
   emit explicit unsupported/fidelity outcomes. Do not mutate the AST.
6. **Descriptor rollout (#551–#555 and relevant #391 children).** Migrate
   remaining discovery protocols family by family and prove semantic identity
   across equivalent endpoints.
7. **Planner/facade (#530–#534).** Bind plans, inspection, query and mount to v2
   fingerprints. The facade exposes v2 while low-level v1 remains available.
8. **Pre-1.0 cutover (#385).** Make v2 canonical `SourceDescriptor`, `Query`
   and `Result`; move legacy/Esri conversions to explicit compatibility
   subpaths; update API report, shared server fixtures and migration guide.
   Remove shims only after packed-package and cross-protocol conformance passes.

No stage silently changes serialized v1 documents. Cross-version readers
discriminate `kind` and `version`; unsupported future major versions fail
closed.

## Backlog ownership audit

No new issue is required. Every implementation slice exposed by the decision
already has a Specifica owner:

| Slice | Owner |
| --- | --- |
| Immediate unknown-geometry and buffer naming correction | #521 |
| Source schema/geometry/CRS implementation and first three adapters | #523 |
| Common tagged errors and diagnostics | #524 |
| Claimed/observed/effective capabilities | #525 |
| Typed AST, CQL2 JSON and query/result inference | #526 |
| OGC/WFS compiler | #527 |
| GeoServices/OData compiler | #528 |
| DuckDB/gRPC compiler | #529 |
| Plan identity, cache, fidelity and provenance | #530 |
| Cross-protocol semantic fixture corpus | #531 |
| Static STAC temporal/extent preservation | #552 |
| Descriptor identity/conformance matrix | #555 |
| Realtime schema/cursor/plan identity | #556 |

## Compile evidence

`npm run verify:contract-v2-design` compiles the design-only module, verifies
the ADR's evidence links/headings/snippet directives, parses every JSON example
and shape-checks representative result/spatial-extent examples. Its positive,
negative and runtime-rejection fixtures cover:

- valid GeoServices, OGC Features, WFS, OData 4.0, STAC API/static,
  PMTiles, GeoParquet URL-glob/options, MapLibre TileJSON/template/GeoJSON and
  namespaced extension locators, with globs limited to meaningful resources;
  OGC Tiles/Maps prove distinct dataset and collection scopes;
- valid authority, WKT, absolute-URI and bounded-PROJJSON CRS identities,
  resolved-CRS/known-order geometry and bbox operands, and explicit spatial
  extent bbox layout/provenance;
- valid semantic equals/bbox/distance predicates and correctly tagged native
  queries;
- selected feature property and aggregate alias/result inference;
- coded/range/unknown value domains, portable/partial constraints and branded
  temporal fields, while ordinary strings are rejected by temporal operators;
- schema-derived primary/non-spatial/ambiguous source states, explicit
  secondary-geometry promotion without duplicated properties, and a
  DOM-independent structural cancellation option;
- schema-key-derived required scalar/composite feature identity, exact
  composite order/encoding, honest known/unavailable result schema identity,
  temporal extents, evidence-bearing unpaged/complete/more/unknown page states
  and exact/estimated/unknown count states plus opaque continuation binding;
- rejected missing/mixed locator properties, unresolved OGC `auto`, WFS name
  without namespace URI, empty GeoParquet assets, unqualified extension ids and
  non-JSON payloads, static-resource globs, service-shaped MapLibre locators,
  and unsupported OData 4.02 claims;
- rejected unknown/empty/non-spatial executable geometry, present geometry
  with unknown CRS or payload order, ambiguous spatial predicates without a
  field, non-spatial output CRS, invalid bbox cardinality, incomplete
  reprojection evidence and one-axis spatial order;
- rejected `Set` capability storage, raw vendor operator IDs, missing extent
  provenance, raw/forged continuations, missing page evidence, and page-mode
  mismatches;
- rejected missing projection fields, field/value mismatches, nonnumeric
  aggregate fields, struct/geometry group or sort fields, cross-dialect/native
  payload mismatches (including dotted `odata-4.0`), unselected result fields,
  duplicate promoted geometry and geometry access after `geometry: "omit"`;
- documented runtime rejection of unsafe network locators, noncanonical or
  oversized URI/PROJJSON CRS values, invalid pagination bounds, non-positive
  distance values, duplicate select/sort/group/key names, metric alias
  collisions, invalid/duplicate field domain constraints, invalid count values
  and duplicate/extra/wrongly encoded composite identity parts.

These fixtures import only design declarations. They do not alter the package
root, `@honua/sdk-js/contract`, runtime adapters, generated protobufs or API
report.

## Consequences

Positive:

- applications and planners can compare equivalent schema and query meaning
  across protocols without parsing vendor strings;
- axis-order and CRS mistakes become representable and testable instead of
  hidden defaults;
- invalid locator and query combinations move from runtime surprises to
  compile-time failures where TypeScript has enough information;
- descriptors, capabilities, plans and subscriptions gain deterministic
  identity;
- unknown and unsupported metadata remains honest and extensible.

Costs:

- `properties` and discriminated locators are a real pre-1.0 migration, not a
  type alias over the current surface;
- every adapter must supply provenance and explicit unknown/empty states;
- callers cannot use a bare native `where` string as portable query intent;
- authority/axis resolution requires reviewed metadata or an injected CRS
  registry rather than WKID guessing;
- server SourceBinding and other SDKs need versioned fixture updates during the
  cutover.

## Rejected alternatives

- **Keep `HonuaFieldInfo`, `HonuaExtent` and `HonuaSpatialReference` canonical.**
  Rejected because their names and value domains encode GeoServices assumptions
  and cannot distinguish missing, unknown, mixed or tuple-order evidence.
- **Use a single locator with optional protocol fields.** Rejected because it
  admits impossible combinations and makes identity dependent on ignored
  properties.
- **Store capabilities in `ReadonlySet`.** Rejected because Set has no standard
  JSON form or canonical order and loses evidence/state distinctions.
- **Treat all missing CRS as CRS84/EPSG:4326.** Rejected as silent spatial
  corruption. Defaults are accepted only from standards conformance evidence.
- **Put `NoCRS` on geometry values.** Rejected because WFS defines it as a
  non-spatial feature-type marker. Unknown-CRS geometry remains spatial and
  explicitly unknown.
- **Use URL only for static assets.** Rejected because Node file paths/globs and
  caller-owned resolvers are legitimate; credentials still remain outside the
  descriptor.
- **Make CQL2 text or SQL the canonical filter.** Rejected because strings do
  not preserve typed semantic intent across dialects. They remain named escape
  hatches.
