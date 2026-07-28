# Deterministic query planner

`@honua/sdk-js/query-planner` is the first production slice of the execution
planner described by the [north-star application-kernel
decision](./decisions/north-star-sdk-application-kernel.md). It turns the
current protocol-neutral `Query` plus an already-discovered `SourceDescriptor`
into a versioned, serializable IR and an immutable explain plan. Explaining is
synchronous and side-effect free: it does not fetch metadata or rows, mutate a
renderer, or execute the query.

The complete subpath is experimental while the remaining compiler and columnar
slices land. The stable root promotes only the reviewed plan/execution subset
used by the managed connection and MapLibre source workflows.

## Managed connection workflow

The reviewed planner subset is also wired into the lifecycle-owned root
connection. This is the shortest feature-result workflow for applications that
do not need to compose planner and executor options themselves:

```ts doc-test=compile
import { createHonua } from "@honua/sdk-js";

const honua = createHonua();
const connection = await honua.connect({
  url: "https://example.test/ogc/features",
  protocol: "ogc-features",
  sourceId: "incidents",
});
const plan = await connection.explain({
  where: "status = 'open'",
  pagination: { limit: 100 },
});
const result = await connection.query(plan);

console.log(result.execution.plan.fingerprint, result.features.length);
await honua.dispose();
```

`explain()` returns the canonical serializable `QueryExecutionPlanV1` rather
than a facade-specific plan. `query(query)` plans once and executes through the
same executor as `query(plan)`. The connection binds its logical identity,
selected source, schema, discovered capability evidence, authorization-scope
digest, and policy into that plan. Accepted plans are integrity-checked and
must still match the current connection observation; mutation, a foreign
connection or scope, and refreshed schema/capability evidence fail rather than
silently re-planning.

The returned feature result adds a credential-free terminal receipt containing
plan identity, timings, hash-only provenance, discovery observation, structured
diagnostics, and completion counts. Cancellation is combined with the kernel
lifecycle and propagated through remote paging and bounded local fallback.
Columnar and realtime plans are deliberately rejected here until their explicit
engines own a corresponding result and cancellation contract.

Discovery metadata caching and query-result caching are separate truths. The
managed connection has no implicit query-result cache, so its default plan
cache decision is `bypass` even when discovery metadata was a cache hit or was
revalidated. Callers may supply an explicit query-cache observation through
the planning options. Discovery `cacheStatus` and `retrievedAt` stay in the
execution receipt as observation evidence; clock-only refreshes do not change
semantic plan identity, while descriptor, source, validator, capability
evidence, or capability-policy changes do.

## Typed semantic query AST

The experimental planner subpath also exposes the first typed semantic-query
surface. It is additive: existing v1 plans and protocol compilers continue to
consume the compatibility `Query.where` path until the compiler migration
lands. New code can build immutable property/literal, comparison, boolean,
null, list, range, pattern, spatial, and temporal nodes without choosing a
wire dialect:

```ts doc-test=compile
import { createSemanticQueryBuilder, defineSemanticQuery } from "@honua/sdk-js/query-planner";

interface Incident {
  id: number;
  status: string;
  score: number;
}

const q = createSemanticQueryBuilder<Incident, "ogc-features", "non-spatial">();
const semanticQuery = defineSemanticQuery(
  q.features({
    select: ["id", "status"] as const,
    filter: q.and(
      q.comparison("eq", q.property("status"), q.literal("active")),
      q.between(q.property("score"), 50, 100),
    ),
    sort: [{ field: "score", direction: "desc" }],
    page: { kind: "first", limit: 100 },
  }),
);

console.log(semanticQuery.filter);
```

`parseSemanticQuery(untrusted, { schema, protocol })` is the JavaScript and JSON
boundary. It reparses the supplied `SourceSchemaV2`, validates field existence,
operator/type compatibility, closed domains, declared ranges, geometry and
temporal eligibility, safe length and `multiple-of` constraints,
projection/sort/group/metric fields, native payload form, and native dialect
compatibility. Literal type admission reuses the canonical `SourceSchemaV2`
value semantics, including binary encodings, numeric precision, and temporal
precision. Source-provided ECMA-262 field patterns remain metadata and are not
executed at this untrusted boundary. Parsed queries are deeply frozen, with
equivalent omitted defaults (case-sensitive patterns and native null ordering)
normalized before hashing or interchange. Parsing is bounded by byte, node,
depth, collection, and text limits; cyclic values, accessors, non-JSON
prototypes, unknown members, blank identifiers or native text/XML payloads,
invalid protocol options, and non-finite numbers fail closed.

Protocol-native filters remain explicit and dialect tagged. For example, an
OGC source may carry `cql2-json` or `cql2-text`; it cannot carry
`geoservices-sql92`. A native expression is an escape hatch, not a claim that
the expression is protocol neutral.

The semantic surface is now compiled directly by the OGC API Features, WFS,
DuckDB, and Honua gRPC compiler boundaries described below. Integration into
the complete explain-plan executor remains a separate planner/facade concern.

### Canonical bytes and query identity

`canonicalSemanticQueryBytes()` and `hashSemanticQuery()` first run the same
bounded runtime/schema validation, then encode a versioned envelope with sorted
object keys. Array order remains significant. The identity envelope always
contains schema fingerprint, protocol, CRS-registry version, and policy version
slots; unavailable values are explicit `null`, not omitted. Cancellation,
realtime cursors, observation timestamps, and other volatile execution state
are not members of the semantic AST.

```ts doc-test=compile
import {
  canonicalSemanticQueryBytes,
  createSemanticQueryBuilder,
  hashSemanticQuery,
} from "@honua/sdk-js/query-planner";

interface Parcel {
  id: number;
  status: string;
}

const query = createSemanticQueryBuilder<Parcel, "ogc-features", "non-spatial">();
const request = query.features({
  select: ["id"] as const,
  filter: query.comparison("eq", query.property("status"), "active"),
});
const identity = {
  protocol: "ogc-features" as const,
  crsVersion: "epsg-db:2026.1",
  policyVersion: "query-policy:7",
};

console.log(canonicalSemanticQueryBytes(request, identity).byteLength);
console.log(hashSemanticQuery(request, identity));
```

Equivalent validated inputs produce identical UTF-8 bytes and a
domain-separated SHA-256 hash. Changing schema, CRS, policy, protocol, field
order, sort precedence, or another semantic member changes identity.

### CQL2 JSON interchange

`semanticFilterToCql2Json()` and `semanticFilterFromCql2Json()` implement a
strict, lossless supported subset of the
[OGC CQL2 JSON encoding](https://docs.ogc.org/is/21-065r2/21-065r2.html).
Import uses the same byte/node/depth/collection bounds and duplicate-name
rejection as `parseSemanticQuery`; imported filters are runtime validated and
deeply frozen.

```ts doc-test=compile
import {
  createSemanticQueryBuilder,
  semanticFilterFromCql2Json,
  semanticFilterToCql2Json,
} from "@honua/sdk-js/query-planner";

interface Road {
  roadClass: string;
}

const query = createSemanticQueryBuilder<Road, "ogc-features", "non-spatial">();
const filter = query.like(query.property("roadClass"), "primary%", {
  caseSensitive: false,
});
const cql2 = semanticFilterToCql2Json(filter, { protocol: "ogc-features" });
const restored = semanticFilterFromCql2Json(cql2, { protocol: "ogc-features" });

console.log(cql2, restored);
```

The supported subset includes property/literal comparisons, `and`/`or`/`not`,
null tests, lists, numeric ranges, case-sensitive and `casei` patterns,
standard topological/non-wrapping-bbox predicates, and exact temporal
predicates. CQL2 temporal timestamp literals and interval endpoints must use a
UTC `Z` instant; offset timestamps fail closed rather than being normalized.
Semantic `during` also fails closed: its property operand is instant-valued,
while CQL2 `T_DURING` requires an interval-valued first operand. CQL2 carries
spatial CRS outside its JSON expression, so
spatial import/export requires an explicit executable `filterCrs` binding and
verifies every operand against it. JSON-number-encoded decimal fields preserve
their supported CQL2 scalar representation; string-encoded high-precision
numbers remain unsupported. Compiler literals are limited to exact CQL2 scalar
semantics: string, number, boolean, date, and timestamp. Logical binary, time,
duration, JSON, collection, and structural fields are not re-labelled as CQL2
strings. Both import and export enforce the normative CQL2
JSON schema's two-member minimum for `GeometryCollection`. Distance extensions,
native expressions, property-property comparisons, arithmetic/custom
functions, measured geometry layouts, and wrapping bounding boxes fail closed
rather than being weakened.

## OGC API Features and WFS 2.0 semantic compilers

`compileSemanticOgcApiFeaturesQuery()` compiles the validated AST to canonical
CQL2 JSON or escaped CQL2 text. It does not infer filtering support from the
protocol name: the caller supplies the concrete collection's discovered
`/conformance` values, and the compiler requires the exact Features Part 3,
basic CQL2, encoding, and optional operator conformance classes used by the
query. When both encodings are advertised, JSON is the deterministic default;
an explicit preference is accepted only when that encoding was discovered.
OGC API Features Core standardizes `limit`, but not a `properties` projection,
`sortby`, or a caller-supplied numeric `offset`. The standards-strict semantic
compiler therefore rejects `select`, `sort`, and offset paging at `$.select`,
`$.sort`, and `$.page.offset`; it never emits those extension-shaped parameters
without a future, explicit extension-evidence contract. First-page `limit`
remains portable and is preserved.

`compileSemanticWfsQuery()` compiles the same semantic nodes to namespace-safe
[FES 2.0 XML](https://docs.ogc.org/is/09-026r2/09-026r2.html). Its evidence is a
normalized projection of the concrete WFS capabilities document: ad hoc query
and sorting constraints, logical-operator presence, comparison/spatial/temporal
operators and operands, and filter/output CRS identifiers. Every generated
operator and GML operand must be advertised. Missing evidence returns an
`unsupported` result at the exact query path; it never becomes an empty filter,
`TRUE`, an envelope approximation, or a dropped relationship.
Because FES capabilities can advertise operands per operator, the flat
`geometryOperands` and `temporalOperands` evidence arrays are conservative,
globally applicable safe intersections: an operand belongs in an array only
when discovery proved it usable for every compiled operator that may consume
that array. Flattening operator-local unions into these arrays is unsafe.
WFS KVP sorting uses the normative `ASC` and `DESC` tokens. Singleton semantic
`and`/`or` nodes compile directly to their child, so they do not require or emit
a logical wrapper. WFS `During` remains supported for its instant-property and
period-literal relationship. `time-intersects` remains unsupported for WFS: FES
`AnyInteracts` requires a period-valued property, while the semantic temporal
operand contract identifies an instant-valued date or timestamp field.

```ts doc-test=compile
import type { SourceSchemaV2 } from "@honua/sdk-js/source-schema";
import {
  compileSemanticWfsQuery,
  createSemanticQueryBuilder,
} from "@honua/sdk-js/query-planner";

interface Parcel {
  id: number;
  status: string;
}

declare const schema: SourceSchemaV2;

const q = createSemanticQueryBuilder<Parcel, "wfs", "non-spatial">();
const query = q.features({
  select: ["id", "status"] as const,
  geometry: "omit",
  filter: q.and(
    q.comparison("eq", q.property("status"), "active"),
    q.isNull(q.property("id"), "is-not-null"),
  ),
});
const compilation = compileSemanticWfsQuery({
  query,
  schema,
  source: {
    typeName: "cad:Parcel",
    namespaces: { cad: "https://example.test/cadastre" },
  },
  capabilities: {
    version: "2.0.0",
    implementsAdHocQuery: true,
    implementsSorting: false,
    logicalOperators: true,
    comparisonOperators: ["PropertyIsEqualTo", "PropertyIsNull"],
    geometryOperands: [],
    spatialOperators: [],
    temporalOperands: [],
    temporalOperators: [],
    supportedFilterCrs: [],
    supportedOutputCrs: [],
  },
});

if (compilation.outcome === "compiled") {
  console.log(compilation.artifact.filter);
} else {
  console.warn(compilation.diagnostics[0]);
}
```

CQL2 identifiers and WFS `ValueReference` paths come only from the verified
`SourceSchemaV2` native mapping. CQL2 text rejects identifiers outside its
normative grammar. FES accepts only a conservative QName/path subset, requires
every prefix to have a caller-supplied namespace URI, and reserves the FES,
GML, WFS, XML Schema, and XML prefixes. Literals remain structural values in
CQL2 JSON, are escaped with the CQL2 control/quote rules in text, and use typed,
XML-escaped `fes:Literal` elements in FES. GML geometry and temporal literals
receive deterministic IDs.

Spatial values carry executable CRS bindings. The compilers reorder payload
coordinates into known CRS-definition axis order only when axis directions and
units match losslessly and stamp the resulting CRS URI. For OGC API Features,
every non-default output `crs` and `filter-crs` additionally requires the
explicit Part 2 CRS conformance class and the exact URI in the collection's
discovered CRS metadata. An explicit exact-default output CRS is satisfied by
omitting `crs`; it does not invent a Part 2 requirement. The only default
identities that can be omitted are
`http://www.opengis.net/def/crs/OGC/1.3/CRS84` for two-dimensional coordinates
and `http://www.opengis.net/def/crs/OGC/0/CRS84h` for three-dimensional
coordinates; suffix matches, alternate ports, and lookalike hosts are not
defaults. Unknown axes, coordinate epochs, required unit or
datum transforms, mixed CQL2 filter CRS, and measured geometry or bounding-box
layouts fail closed. No compiler relabels coordinates or treats a measure as a
third spatial ordinate.

Artifacts bind canonical query identity to schema and normalized capability
evidence with separate SHA-256 fingerprints, then fingerprint the complete
wire-request preimage. Reordering capability arrays or namespace object keys
does not change identity. Protocol-native escape hatches remain terminal and
dialect matched: OGC accepts only advertised `cql2-json`/`cql2-text`, while WFS
accepts only `fes-2.0` XML. `usesNativeFilter` makes that trust-boundary choice
visible to policy and diagnostics.

### Deprecated raw `where` compatibility

The v1 `Query.where` member remains operational but is deprecated and explicitly
source-native. `legacyWhereToNativeFilter()` is the migration bridge for text
whose dialect is losslessly known: GeoServices SQL-92, CQL2 text, OData 4.0, or
DuckDB SQL. WFS's parsed legacy grammar and Honua gRPC's JSON dialect are not
mislabelled as raw text.

```ts doc-test=compile
import { legacyWhereToNativeFilter } from "@honua/sdk-js/query-planner";

const compatibilityFilter = legacyWhereToNativeFilter(
  "geoservices-feature-service",
  "STATUS = 'OPEN'",
);

console.log(compatibilityFilter.dialect); // geoservices-sql92
```

Existing v1 planning still serializes `where` as `{ kind: "source-native",
expression }`, preserving compatibility while consumers migrate to semantic
compiler artifacts. New code should use typed builders instead of the bridge.

## Semantic protocol compilers

`compileSemanticGeoServicesQuery()`, `compileSemanticOdataQuery()`,
`compileSemanticDuckDbQuery()`, and `compileSemanticGrpcQuery()` are pure
compiler boundaries for the validated semantic AST. They return a
discriminated result: `compiled` contains a frozen artifact and its fidelity;
`unsupported` contains a stable code, exact query path, and bounded diagnostic.
Malformed queries, schemas, resource handles, or source identities still throw
`HonuaQueryPlanningError` before an artifact is created.

```ts doc-test=compile
import type { SourceSchemaV2 } from "@honua/sdk-js/source-schema";
import {
  compileSemanticDuckDbQuery,
  createGeoParquetResourceHandle,
  createSemanticQueryBuilder,
} from "@honua/sdk-js/query-planner";

interface Incident {
  id: number;
  status: string;
}

declare const schema: SourceSchemaV2;

const q = createSemanticQueryBuilder<Incident, "geoparquet", "non-spatial">();
const query = q.features({
  select: ["id", "status"] as const,
  geometry: "omit",
  filter: q.comparison("eq", q.property("status"), "open"),
});
const resource = createGeoParquetResourceHandle({
  resolver: "io.honua.application",
  id: "incidents",
  authorizationContextId: "tenant:alpha",
  resourceVersion: "snapshot:7",
});
const compilation = compileSemanticDuckDbQuery({ query, schema, resource });

if (compilation.outcome === "compiled") {
  console.log(compilation.fidelity, compilation.artifact.sqlTemplate);
} else {
  console.warn(compilation.diagnostics[0]);
}
```

GeoServices artifacts target standardized SQL-92 and the layer `query` request
vocabulary. Every public semantic field is resolved to its exact physical
`SourceSchemaV2.path`; SQL identifiers are delimited, string literals use quote
doubling, finite numbers never use exponent notation, and UTC temporal values
become typed SQL literals only with exact layer field-type evidence.
`esriFieldTypeDate` uses timezone-aware schema metadata and second-precision
`TIMESTAMP`; `esriFieldTypeDateOnly`, `esriFieldTypeTimeOnly`, and
`esriFieldTypeTimestampOffset` use their standardized `DATE`, `TIME`, and
offset-bearing `TIMESTAMP` forms. Precision that the native type cannot carry
fails closed. An unfiltered query omits `where` instead of
inventing `1=1`. Raw REST field parameters (`outFields`, ordering, grouping,
and statistic operands) additionally require one delimiter-free Unicode
identifier; a physical name that is safe only when SQL-delimited may be used in
`where`, but never leaks into a comma-delimited request field. Geometry output
emits explicit `returnZ`/`returnM` flags for `xy`, `xyz`, `xym`, and `xyzm`;
unknown layout metadata fails closed. `outSr` is accepted only when it is
identical to the source geometry CRS because this artifact has no explicit
datum-transformation evidence. Spatial predicates compile to the separate
geometry request parameters only when the schema identifies the target geometry
property and executable CRS/layout, and the caller supplies the relationship advertised by
the layer's `supportedSpatialRelationships` metadata. A spatial predicate
inside `OR` or `NOT`, multiple spatial predicates, an implicit CRS transform,
or an unadvertised relationship fails closed. `orderByFields` requires an
explicit `supportsAdvancedQueries: true`; feature paging requires
`supportsPagination: true`; statistics require `supportsStatistics: true`;
and paged aggregate requests additionally require
`supportsPaginationOnAggregatedQueries: true`. Missing or false metadata never
becomes inferred support. See the
[GeoServices query request reference](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/).

OData artifacts target the v4.0 URL conventions. Physical property paths retain
their exact `/`-separated Unicode segments, so a public `city` field may map to
`Address/City` without exposing that physical spelling in the semantic AST.
String, decimal, integer, float, boolean, UUID, date/time, duration, null, list,
range, and temporal predicates have deterministic v4 literal forms. `in` is
lowered to an exact parenthesized equality disjunction because OData v4.0 has no
portable `in` operator. Only LIKE shapes exactly expressible as `startswith`,
`endswith`, or `contains` compile; `_`, interior `%`, case folding, and
always-true wildcard patterns are rejected. See the
[OData v4 URL conventions](https://docs.oasis-open.org/odata/odata/v4.0/os/part2-url-conventions/odata-v4.0-os-part2-url-conventions.html).

```ts doc-test=compile
import type { SourceSchemaV2 } from "@honua/sdk-js/source-schema";
import {
  compileSemanticOdataQuery,
  createSemanticQueryBuilder,
} from "@honua/sdk-js/query-planner";

interface Place {
  id: number;
  city: string;
}

declare const schema: SourceSchemaV2;

const odata = createSemanticQueryBuilder<Place, "odata", "non-spatial">();
const query = odata.features({
  select: ["id", "city"] as const,
  geometry: "omit",
  filter: odata.comparison("eq", odata.property("city"), "Honolulu"),
});
const compilation = compileSemanticOdataQuery({
  query,
  schema,
  source: { entitySet: "Places", sourceVersion: "metadata:42" },
});

if (compilation.outcome === "compiled") {
  console.log(compilation.artifact.filter, compilation.artifact.requestFingerprint);
}
```

OData spatial compilation additionally requires one exact, whitelisted OData
v4 `Edm.Geography*`/`Edm.Geometry*` primitive type, executable EPSG CRS and
`xy` layout metadata for the property, and explicit source evidence for
`geo.intersects`. Filtering admits only the normative signatures
`geo.intersects(Edm.GeographyPoint, Edm.GeographyPolygon)` and its
`Edm.Geometry` equivalent. A Point property therefore precedes a Polygon
literal; a Polygon property is emitted second after a Point literal. Bounding
boxes are Polygon literals and can target only exact Point properties. Generic,
line, multi, collection, mixed, or unknown filter-property kinds fail closed,
while geometry output may still use the broader whitelisted spatial types.
Geography requires angular CRS axes, Geometry requires linear CRS axes, and the
literal CRS must match the property CRS byte-for-byte at the executable binding
level; the compiler never inserts a transform. Other topological predicates and
distance modes return path-addressed unsupported diagnostics. Portable
`$apply` aggregation remains outside this compiler slice rather than
approximating aggregate semantics.

Both request artifacts include `schemaFingerprint`, `queryFingerprint`, and a
domain-separated `requestFingerprint`. The latter incorporates the exact
request pre-image and an explicit null/version slot for source metadata, so
cache and approval identities change when either semantics or source evidence
changes. `fieldMappings` exposes the complete logical-to-physical trace used by
the request in Unicode-scalar order, independent of host locale or ICU data.
Protocol-native filters are accepted only with the matching
`geoservices-sql92` or `odata-4.0` tag, must be bounded nonblank text without
control characters, and set `usesNativeFilter: true`.

DuckDB artifacts contain a fixed `honua-resource://resolve-at-execution`
placeholder, the opaque #587 resource handle, parameterized SQL, and ordered
bind values. Raw locators and credentials never enter the SQL template. The
`outputGeometry` contract accompanies every geometry-returning projection,
even when no spatial predicate exists. It records the logical source field,
physical source encoding, GeoJSON result field/encoding, executable CRS, and
coordinate layout. The separate `spatial` array describes predicates only.
Measured or unknown layouts fail closed because GeoJSON output cannot prove
their semantics exact. Exact geometry predicates use DuckDB Spatial functions. A
GeoParquet bbox-covering column may prefilter an exact bbox query, but the exact
geometry predicate remains present to prevent false positives.

Reducing an arbitrary `intersects` operand to its envelope is available only
with `spatialStrategy: "bbox-envelope"`. That artifact has
`fidelity: "approximate"`, a `spatial-envelope-reduction` loss, and a spatial
entry whose strategy is `bbox-envelope`; it is never presented as exact.

Honua gRPC artifacts are protobuf-runtime-free canonical descriptions of
`honua.v1.FeatureService/QueryFeatures`. Projection, filter, sort, group, and
statistic operands use public `SourceSchemaV2` field names; physical storage
paths never enter the request. Generated `where` text is limited to the server's
executable grammar: ASCII public identifiers, simple comparisons or
`IS [NOT] NULL`, and top-level `AND`. Nested safe `AND` nodes are flattened, and
inclusive range/temporal intervals become paired comparisons without adding
parentheses. String literals are SQL-quoted as data; numeric literals must fit
the server's non-exponent decimal grammar and decimal range.

A request shape that cannot preserve the AST—such as `OR`, `NOT`, `IN`,
case-insensitive `LIKE`, a fieldless statistic, a bbox without an envelope
message, a coordinate epoch, or an unrepresentable CRS—returns an unsupported
diagnostic instead of emitting a request the server parser will reject,
manufacturing a polygon, dropping a node, or inserting a transform. The final
`where` string also honors the server's 4,000-character and control-character
admission limits.

Protocol-native filters remain explicit trust-boundary escape hatches. A
DuckDB native expression must be tagged `duckdb-sql`; a Honua request fragment
must be tagged `honua-grpc`, contain exactly one `where` member, and pass the
same server grammar, public-field, length, and control-character checks before
an artifact is created. Artifacts expose `usesNativeFilter` so policy and
inspection code can distinguish native code from compiler-escaped semantic
values.

None of the semantic compilers imports DuckDB, `@bufbuild/protobuf`, or Connect runtimes.
Execution and integration into the complete explain plan belong to the
planner/facade tranche (#530); these functions only produce deterministic,
credential-free artifacts.

## Remote pushdown

The remote compilers target existing GeoServices FeatureServer, OGC API
Features `/items`, WFS 2.0 GetFeature, OData v4 entity-set query, DuckDB SQL over
GeoParquet, and Honua gRPC `FeatureService/QueryFeatures` paths. The compiled
request is included in the plan so diagnostics, CLIs, agents, and renderers can
inspect the same decision before execution.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { executeQueryPlan, explainQuery } from "@honua/sdk-js/query-planner";

const descriptor = {
  id: "incidents",
  protocol: "geoservices-feature-service",
  locator: { url: "https://demo.honua.io", serviceId: "incidents", layerId: 0 },
  capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
} as const;

const plan = explainQuery({
  descriptor,
  sourceVersion: "2026-07-10",
  authorizationScope: ["data:read"],
  cache: {
    policy: "require-fresh",
    freshness: "stale",
    validator: { kind: "etag", value: currentEtag },
  },
  discovery: { state: "metadata", source: "catalog:incidents" },
  query: {
    where: "status = 'open'",
    aggregation: {
      groupBy: ["severity"],
      metrics: [{ fn: "count", field: "OBJECTID", alias: "incidents" }],
    },
  },
});

console.log(plan.fingerprint, plan.steps[0]?.compiled);
console.log(plan.bounds, plan.cache, plan.fidelity, plan.provenance);

// `source` is the matching Source from Dataset.source(...). Version and scope
// are repeated so execution can reject a stale or differently-authorized plan.
const execution = await executeQueryPlan(plan, source, {
  sourceVersion: "2026-07-10",
  authorizationScope: ["data:read"],
  discovery: { state: "metadata", source: "catalog:incidents" },
});
console.log(execution.result.aggregateRows);
```

For an OGC API Features source, the same `explainQuery()` call selects
`ogc-api-features-query-v1` from the descriptor protocol. Source-native
`Query.where` is identified as CQL2 text; projection, sorting, pagination,
CRS, and envelope-intersects filters compile to `properties`, `sortby`,
`limit`/`offset`, `crs`, and `bbox` respectively:

This v1 compatibility compiler models source-native/vendor-extension request
shapes and does not claim that `properties`, `sortby`, or numeric `offset` are
OGC API Features Core parameters. New typed integrations should use
`compileSemanticOgcApiFeaturesQuery()`, whose standards-strict behavior rejects
those semantics until concrete extension evidence can be supplied.

```ts doc-test=compile
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { explainQuery } from "@honua/sdk-js/query-planner";

const ogcPlan = explainQuery({
  descriptor: {
    id: "parcels",
    protocol: "ogc-features",
    locator: { url: "https://example.test/ogc", collectionId: "parcels" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
  },
  query: {
    where: "status = 'active'",
    outFields: ["parcel_id", "owner"],
    orderBy: [{ field: "updated_at", direction: "desc" }],
    spatialFilter: {
      geometryType: "esriGeometryEnvelope",
      geometry: { xmin: -158.4, ymin: 20.5, xmax: -157.6, ymax: 21.8 },
    },
    pagination: { limit: 100 },
  },
});

const firstStep = ogcPlan.steps[0];
if (!firstStep || firstStep.engine !== "remote") throw new Error("Expected a remote query step");
console.log(firstStep.compiled);
// { compiler: "ogc-api-features-query-v1", collectionId: "parcels",
//   filter: "status = 'active'", filterLang: "cql2-text", ... }
```

The OGC compiler rejects non-envelope spatial filters, relationships other
than envelope-intersects/intersects, non-EPSG:4326 or malformed bounds,
portable geometry-suppression claims, and claimed remote aggregation. It never
weakens those requests to a broader bbox query.
Aggregation remains available through the explicit bounded-local policy below:
the CQL2 filter and required-field projection stay remote while the exact
aggregate runs only after the materialization ceilings pass.

WFS plans compile the supported SQL-92 subset and spatial predicates to FES
2.0 XML, and expose `propertyName`, `sortBy`, `startIndex`, `count`, and
`srsName`. XML literals and identifiers go through the same escaping compiler
used by the WFS adapter; the portable compiler deliberately retains that
adapter's reviewed `the_geom` default. OData plans translate the canonical predicate to
`$filter`, including supported `geo.intersects` geometry, and expose
`$select`/`$expand`, `$orderby`, `$skip`, and `$top`. Both compilers fail
closed when exact translation is impossible. In particular, metadata-free
planning requires explicit `outFields` before it can prove geometry
suppression, and a descriptor geometry field before it can compile an OData
spatial predicate. OData output-CRS requests, untranslatable SQL predicates,
unterminated literals, contradictory WFS geometry projections, and WFS spatial
filters that would misuse response `outSr` as an input-geometry label also fail
closed. The planner never claims exact execution based on guessed or silently
ignored protocol behavior. A descriptor WFS `srsName` remains transaction
metadata and is not invented as a GetFeature response CRS.

`Query.signal` never enters the IR or fingerprint. Supply cancellation only to
`executeQueryPlan`. Network-protocol source URLs in plan identity are stripped
of credentials, query strings, and fragments. GeoParquet v1 planning rejects a
credential-bearing locator entirely; use the opaque v2 path below. Pass stable
authorization scope identifiers, not tokens.

## Opaque GeoParquet resource identity

`GeoParquetResourceHandleV1` is a versioned JSON value containing only a
resolver namespace, logical resource id, stable non-secret authorization
partition, and optional data revision. `explainQuery()` emits a `2.0` IR/plan
and `duckdb-sql-v2` template when `geoparquetResource` is present. Raw paths,
globs, signed URLs, and expiry remain private to a lifecycle-scoped resolver
registry and are injected only while the accepted plan executes:

```ts doc-test=skip reason="partial excerpt requires application private locator and execution host"
import {
  createGeoParquetResourceRegistry,
  executeQueryPlan,
  explainQuery,
  queryPlanCacheKey,
  serializeQueryPlan,
} from "@honua/sdk-js/query-planner";

const resources = createGeoParquetResourceRegistry({ resolver: "io.honua.app-assets" });
const handle = resources.register({
  id: "parcels:current",
  authorizationContextId: "tenant:alpha/role:analyst",
  resourceVersion: "snapshot:42",
  sources: [privateSignedGeoParquetUrl],
  expiresAt: privateSignedGeoParquetExpiryMs,
});

const plan = explainQuery({
  descriptor: source.descriptor,
  geoparquetResource: handle,
  authorizationScope: ["data:read"],
  sourceVersion: "source:9",
  query: { where: "population > 10", pagination: { limit: 100 } },
});

// Both projections contain only the stable handle and placeholder SQL.
const persistedPlan = serializeQueryPlan(plan);
const cacheKey = queryPlanCacheKey(plan);

// The resolver's private source crosses directly into the GeoParquet adapter.
// Repeat the planning context so execution can reject drift.
const execution = await executeQueryPlan(plan, source, {
  authorizationContextId: "tenant:alpha/role:analyst",
  geoParquetResourceResolver: resources.resolver,
  authorizationScope: ["data:read"],
  sourceVersion: "source:9",
  signal,
});

// Clears all private locator material when the owning client/session ends.
resources.dispose();
```

Re-registering the same resolver/id/authorization-context/resource-version
atomically rotates private credentials without changing the handle or its
fingerprint. Resolution compares authorization context before invoking the
resolver, enforces exact expiry at `now >= expiresAt`, supports pre-flight and
in-flight cancellation, and copies resolver output through fixed source-count
and UTF-8 size ceilings. Unknown, revoked, closed, or cross-context resources
fail closed. Foreign resolver failures are rebuilt as fixed-message SDK errors;
their messages, causes, contexts, and raw locators are never retained.
GeoParquet adapter failures are likewise rebuilt as
`query.execution.resource-execution-failed`. Cancellation remains an
`HonuaAbortError` before, during, and after resolution.

`resource.id`, `resourceVersion`, and `authorizationContextId` are
identity-bearing. Derive them only from stable, non-secret facts such as dataset
revision, tenant, and role ids—never from a bearer token, API key, signed query
string, or a hash of credential material. Their validators enforce bounded
syntax, not arbitrary secret detection, so callers remain responsible for this
boundary. The registry is ephemeral in-memory isolation, not encrypted storage.
Resolved `sources` cross the redaction boundary and must never be logged,
persisted, fingerprinted, placed in telemetry, or sent over a network API.

`serializeQueryPlan()`, `parseQueryPlan()`, `hashQueryPlan()`, and
`queryPlanCacheKey()` validate the persistence boundary before returning. A v2
cache identity binds the resolver/id, authorization partition, data revision,
scope, schema/source versions, query, and planner policy. Credential rotation
does not change it, and no secret value is hashed. Serialization is synchronous
and performs no resolver, filesystem, network, or DuckDB I/O. Validation does
not treat the public SHA-256 fingerprint as authentication: it reconstructs the
complete canonical v2 plan through the pure planner and compares every field,
including the derived id, IR, steps, compiled template, warnings, and exact
nested keys. A re-signed non-canonical projection is rejected with the same
fixed redacted `invalid-plan` error.

Existing `1.0` GeoParquet IR and `duckdb-sql-v1` artifacts remain supported only
when every locator is credential-free. Query strings, fragments, user-info, and
credential-bearing legacy addresses are rejected before planning, hashing,
parsing, or migration. Upgrade an accepted v1 plan explicitly with
`migrateGeoParquetQueryPlanV1(legacyPlan, handle)`; migration reconstructs a v2
plan and does not copy the old locator. There is no implicit v1 rewrite.

## DuckDB SQL and gRPC compilers

Opaque `geoparquet` sources compile through `compileDuckDbQueryV2` to a
deterministic `duckdb-sql-v2` template over the fixed
`honua-resource://resolve-at-execution` placeholder. The trusted GeoParquet
adapter recompiles the same canonical query against the ephemeral resolved
sources and consumes them without placing them in its metadata/profile cache.
Credential-free legacy sources continue to use `compileDuckDbQuery` and
`duckdb-sql-v1`. Both compilers reuse the same dependency-free, injection-safe
SQL builder. Envelope spatial filters push down as
`ST_Intersects(..., ST_MakeEnvelope(...))` (or a GeoParquet 1.1 `bbox`-covering
column when declared); non-envelope geometries are reduced to their bounding box
and reported with `bboxApproximated: true`. Geometry is projected as GeoJSON via
`ST_AsGeoJSON`. Output-CRS requests fail closed (no portable DuckDB reprojection),
and a spatial filter without a resolvable geometry column is rejected. The
geometry column and encoding come from `locator.geoparquet.geometryColumn` /
`geometryEncoding` (default `wkb`) or a descriptor geometry field, so planning
never needs a profiling round-trip.

`grpc` sources compile to `honua-grpc-query-features-v1`, a faithful,
protobuf-free description of the `honua.v1.FeatureService/QueryFeatures` unary
request. Field names and proto enum *value names* (`SPATIAL_RELATIONSHIP_*`,
`STATISTIC_TYPE_*`) mirror the generated message, so the plan is a hashable
pre-image of the wire request without importing the protobuf runtime.

## Spatial aggregation

Spatial aggregation — grouped statistics constrained by a spatial predicate —
has both a server-pushdown path and a bounded local/columnar path. GeoServices
(`outStatistics` + `groupByFieldsForStatistics` + geometry) and gRPC
(`outStatistics` + `groupBy` + `spatialFilter`) push the whole aggregation to the
server (`pushdown: "full"`); DuckDB pushes it to the columnar engine as a
`GROUP BY` with the spatial predicate in the `WHERE` clause. When a source cannot
push aggregation down at all, the bounded degraded path (below) computes it
locally after enforcing a row/byte ceiling. Histogram and time-series
aggregation remain rejected rather than silently ignored.

## Plan consumers

The plan is consumed, not re-derived. `honua explain <ref>` (CLI) builds a
`SourceDescriptor` from flags and calls `explainQuery`, printing the stages,
pushdown, per-protocol compiled request, fidelity, warnings, and fingerprint —
with no server call, since planning is side-effect free. `executeQueryPlan`
consumes the accepted plan for execution after verifying its fingerprint and
source context.

For GeoParquet, the positional CLI value is an opaque resource id, never a
locator:

```sh
honua explain parcels:current --protocol geoparquet \
  --resolver io.honua.app-assets \
  --authorization-context tenant:alpha/role:analyst \
  --resource-version snapshot:42 --json
```

## Structured diagnostics

Every plan and every step carries `diagnosticsVersion: "1.0"` data. Step
diagnostics sit beside the step's `engine` and `pushdown` decision so consumers
do not have to infer safety or fidelity from prose:

- `bounds` describes requests, rows, bytes, transfer bytes, serialized local
  materialization bytes, and actual heap memory. Each quantity declares its
  unit, evidence source, and `exact`, `bounded`, `estimated`, or `unknown`
  confidence. Plan bounds combine every step; incomplete evidence propagates
  `unknown` instead of being hidden by one known step. `maxBytes` is enforced
  against deterministic UTF-8 JSON bytes, not claimed as a heap-memory bound;
  heap memory remains unknown without runtime evidence.
- `fidelity` is `exact` when the source executes the requested semantics,
  `equivalent` when bounded residual work preserves the result, and
  `approximate` when it does not. Every approximation has a loss record with a
  stable code, affected plan path, description, and remediation. For example,
  DuckDB polygon-to-envelope reduction emits `spatial-envelope-reduction`; it
  is never reported as exact.
- `provenance` binds the credential-free source and descriptor, schema state,
  discovery evidence, and authorization-scope identity. Endpoints, discovery
  sources, validators, and authorization scopes are represented by
  domain-separated SHA-256 fingerprints where a raw value is unnecessary.
- `warnings` are stable objects with `code`, `path`, `message`, and
  `remediation`. Bounded local execution, geometry transfer, and approximate
  spatial filtering therefore remain machine-actionable.

`cache` is a deterministic decision, not a cache side effect. The caller may
select `bypass`, `prefer-cache`, or `require-fresh` and report `fresh`, `stale`,
or `unknown` evidence. The plan records an action (`bypass`, `reuse`,
`revalidate`, or `refresh`) and reason. ETags, last-modified values, revisions,
and precomputed fingerprints are normalized to a kind plus digest; raw
validators do not enter serialized plans. Cache storage and conditional
requests remain the responsibility of the plan consumer. `bypass` always
normalizes to `freshness: "unknown"` with no validator, so irrelevant cache
observations cannot fragment plan identity.

## Bounded degraded execution

Fallback is disabled by default. When a source can query features but cannot
push down aggregation, local execution requires both `capabilityPolicy:
"degraded"` and an explicit `bounded-local` budget:

```ts doc-test=skip reason="partial excerpt requires application host context"
const plan = explainQuery({
  descriptor,
  capabilityPolicy: "degraded",
  fallback: { mode: "bounded-local", maxRows: 5_000, maxBytes: 8_000_000 },
  estimates: { rows: 3_200, bytes: 4_100_000 },
  query: {
    where: "status = 'open'",
    aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] },
  },
});
```

The plan pushes filters and required-field projection to the server. Its
logical input limit is `maxRows`; the compiled wire request exposes the
adapter-owned `maxRows + 1` overflow sentinel. Aggregation runs locally only
after the row and byte ceilings pass. Planning rejects a known over-budget
estimate.
Execution rejects an overflow sentinel or transfer-limit response; it never
silently reports a partial aggregate. `maxRows` is also capped by the SDK at
`MAX_LOCAL_MATERIALIZATION_ROWS`.

## Determinism and plan validity

- `QUERY_IR_VERSION` / `QUERY_PLAN_VERSION` remain `1.0` for compatible plans;
  `QUERY_IR_V2_VERSION` / `QUERY_PLAN_V2_VERSION` are `2.0` for opaque
  GeoParquet resources.
- Objects serialize with sorted keys; array order remains semantically
  significant. SHA-256 fingerprints are identical in browsers, workers, and
  Node for the same descriptor, query, policy, versions, scope, estimates,
  cache decision, and discovery evidence.
- The versioned `validity` binding covers planner/contract version, source,
  schema, capabilities, authorization scope, discovery, query, CRS, policy,
  and execution mode. Signals, observation timestamps, expiry clocks, and raw
  realtime cursors are execution state and never enter the fingerprint.
- CRS validity includes the source SRS, input/filter geometry CRS bindings,
  output CRS, and the no-implicit-transform policy. It never infers a transform
  from output CRS alone.
- Realtime callers select `executionMode: "snapshot"` or `"delta"`; the mode
  is bound to the plan while live cursor bytes remain with the transport.
- `executeQueryPlan` verifies the complete canonical v2 projection, its
  fingerprint, and the current source context. Source or authorization-context
  drift throws `HonuaQueryPlanExecutionError` with `code: "foreign-plan"`;
  version, schema, capability, or discovery drift uses `code: "stale-plan"`.
  Both include a typed `reason`, and the executor never silently replans.
  Opaque GeoParquet credential rotation is intentionally outside that
  identity.
- Structured cache decisions are explanatory. The planner does not fetch,
  persist, or materialize cached feature/query/result data.
- Schema/source versions are byte-bounded and credential-screened before they
  enter stable IR; provenance exposes domain-separated SHA-256 evidence instead
  of repeating those values. Persistence also rejects credential material by
  nested key and path (including locator, header, and query parameter forms) as
  well as by value pattern; benign field names such as `token_count` remain
  valid.

## Deliberate first-slice boundaries

This foundation does not close the full planner workstream. The typed semantic
AST, temporal values, canonical identity, and CQL2 JSON interchange are now
available, while the existing v1 compilers remain on their compatibility path.
Follow-on slices must adopt the AST in those compilers, negotiate richer OGC
filter support, and add spatial-binning aggregation (grid/hex),
joins/composition, evidence-backed protocol cost models, execution-integrated
cache storage, receipts, and richer renderer/MCP consumption. Structured
cache/freshness decisions and snapshot/delta plan identity are available now;
the planner does not store cache entries or persist live cursors. Histogram and
time-series aggregation are rejected by the current compiler rather than
silently ignored. The GeoServices, OGC API Features, WFS, OData,
credential-free and opaque DuckDB SQL, gRPC, bounded columnar/worker paths,
spatial-aggregation pushdown, and CLI plan consumer are now delivered.
