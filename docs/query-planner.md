# Deterministic query planner

`@honua/sdk-js/query-planner` is the first production slice of the execution
planner described by the [north-star application-kernel
decision](./decisions/north-star-sdk-application-kernel.md). It turns the
current protocol-neutral `Query` plus an already-discovered `SourceDescriptor`
into a versioned, serializable IR and an immutable explain plan. Explaining is
synchronous and side-effect free: it does not fetch metadata or rows, mutate a
renderer, or execute the query.

The subpath is experimental while the remaining compiler and columnar slices
land. It is intentionally not exported from the root barrel.

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

This semantic surface does not change compilation or execution. Protocol
compiler adoption remains in #527-#529.

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
standard topological/non-wrapping-bbox predicates, and the four semantic
temporal predicates. CQL2 carries spatial CRS outside its JSON expression, so
spatial import/export requires an explicit executable `filterCrs` binding and
verifies every operand against it. JSON-number-encoded decimal fields preserve
their supported CQL2 scalar representation; string-encoded high-precision
numbers remain unsupported. Both import and export enforce the normative CQL2
JSON schema's two-member minimum for `GeometryCollection`. Distance extensions,
native expressions, property-property comparisons, arithmetic/custom
functions, measured geometry layouts, and wrapping bounding boxes fail closed
rather than being weakened.

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
expression }`, preserving compatibility until #527-#529 adopt semantic nodes.
New code should use typed builders instead of the bridge.

## Semantic DuckDB and Honua gRPC compilers

`compileSemanticDuckDbQuery()` and `compileSemanticGrpcQuery()` are pure
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

Neither compiler imports DuckDB, `@bufbuild/protobuf`, or Connect runtimes.
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
  query: {
    where: "status = 'open'",
    aggregation: {
      groupBy: ["severity"],
      metrics: [{ fn: "count", field: "OBJECTID", alias: "incidents" }],
    },
  },
});

console.log(plan.fingerprint, plan.steps[0]?.compiled);

// `source` is the matching Source from Dataset.source(...). Version and scope
// are repeated so execution can reject a stale or differently-authorized plan.
const execution = await executeQueryPlan(plan, source, {
  sourceVersion: "2026-07-10",
  authorizationScope: ["data:read"],
});
console.log(execution.result.aggregateRows);
```

For an OGC API Features source, the same `explainQuery()` call selects
`ogc-api-features-query-v1` from the descriptor protocol. Source-native
`Query.where` is identified as CQL2 text; projection, sorting, pagination,
CRS, and envelope-intersects filters compile to `properties`, `sortby`,
`limit`/`offset`, `crs`, and `bbox` respectively:

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
  Node for the same descriptor, query, policy, versions, scope, and estimates.
- Capabilities, authorization scopes, source/schema versions, CRS/query
  fields, and fallback budgets participate in the fingerprint.
- `executeQueryPlan` verifies the complete canonical v2 projection, its
  fingerprint, and the current source context. A changed plan, stable source
  identity, version, capability set, or scope is rejected; the executor does
  not re-plan. Opaque GeoParquet credential rotation is intentionally outside
  that identity.
- Feature/query/result caching remains bypassed. Opt-in materialization is a
  separate workflow.

## Deliberate first-slice boundaries

This foundation does not close the full planner workstream. The typed semantic
AST, temporal values, canonical identity, and CQL2 JSON interchange are now
available, while the existing v1 compilers remain on their compatibility path.
Follow-on slices must adopt the AST in those compilers, negotiate richer OGC
filter support, and add spatial-binning aggregation (grid/hex),
joins/composition, cache/freshness decisions, cost models, realtime
snapshot/delta plans, receipts, and richer renderer/MCP consumption. Histogram
and time-series aggregation are rejected by the current compiler rather than
silently ignored. The GeoServices, OGC API Features, WFS, OData, credential-free
and opaque DuckDB SQL, gRPC, bounded columnar/worker paths,
spatial-aggregation pushdown, and CLI plan consumer are now delivered.
