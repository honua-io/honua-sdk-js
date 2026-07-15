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

This first slice does not change compilation or execution. Deterministic
semantic bytes/hash, CQL2 JSON interchange, and the deprecated raw-`where`
migration are follow-up work in issue #526; protocol compiler adoption remains
in #527-#529.

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

This foundation does not close the full planner workstream. Follow-on slices
must add typed semantic predicates and temporal windows, CQL2 JSON and richer
OGC filter negotiation, spatial-binning aggregation (grid/hex) in the IR,
joins/composition, cache/freshness decisions, cost models, realtime
snapshot/delta plans, receipts, and richer renderer/MCP consumption. Histogram
and time-series aggregation are rejected by this compiler rather than silently
ignored. The GeoServices, OGC API Features, WFS, OData, credential-free and
opaque DuckDB SQL, gRPC, bounded columnar/worker paths, spatial-aggregation
pushdown, and CLI plan consumer are now delivered.
