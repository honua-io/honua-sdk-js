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

## Remote pushdown

The remote compilers target existing GeoServices FeatureServer, OGC API
Features `/items`, WFS 2.0 GetFeature, and OData v4 entity-set query paths. The
compiled request is included in the plan so diagnostics, CLIs, agents, and
renderers can inspect the same decision before execution.

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
`executeQueryPlan`. Source URLs in plan identity are stripped of credentials,
query strings, and fragments; pass stable authorization scope identifiers, not
tokens.

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

- `QUERY_IR_VERSION` and `QUERY_PLAN_VERSION` are both `1.0` for this slice.
- Objects serialize with sorted keys; array order remains semantically
  significant. SHA-256 fingerprints are identical in browsers, workers, and
  Node for the same descriptor, query, policy, versions, scope, and estimates.
- Capabilities, authorization scopes, source/schema versions, CRS/query
  fields, and fallback budgets participate in the fingerprint.
- `executeQueryPlan` verifies the fingerprint and the current source context.
  A changed plan, locator, version, capability set, or scope is rejected; the
  executor does not re-plan.
- Feature/query/result caching remains bypassed. Opt-in materialization is a
  separate workflow.

## Deliberate first-slice boundaries

This foundation does not close the full planner workstream. Follow-on slices
must add typed semantic predicates and temporal windows, CQL2 JSON and richer
OGC filter negotiation, gRPC and DuckDB compilers, spatial aggregation, joins/composition,
columnar/worker execution, cache/freshness decisions, cost models, realtime
snapshot/delta plans, receipts, golden cross-protocol fixtures, and shared
CLI/renderer/MCP consumption. Histogram and time-series aggregation are
rejected by this compiler rather than silently ignored.
