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

The first compiler targets an existing GeoServices FeatureServer query path.
The compiled request is included in the plan so diagnostics, CLIs, agents, and
future renderers can inspect the same decision before execution.

```ts
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

`Query.signal` never enters the IR or fingerprint. Supply cancellation only to
`executeQueryPlan`. Source URLs in plan identity are stripped of credentials,
query strings, and fragments; pass stable authorization scope identifiers, not
tokens.

## Bounded degraded execution

Fallback is disabled by default. When a source can query features but cannot
push down aggregation, local execution requires both `capabilityPolicy:
"degraded"` and an explicit `bounded-local` budget:

```ts
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

The plan pushes filters and required-field projection to the server, requests
at most `maxRows + 1` records, then aggregates locally only after checking the
row and byte ceilings. Planning rejects a known over-budget estimate.
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
must add typed semantic predicates and temporal windows, CQL2/OGC, WFS FES,
OData, gRPC, and DuckDB compilers, spatial aggregation, joins/composition,
columnar/worker execution, cache/freshness decisions, cost models, realtime
snapshot/delta plans, receipts, golden cross-protocol fixtures, and shared
CLI/renderer/MCP consumption. Histogram and time-series aggregation are
rejected by this compiler rather than silently ignored.
