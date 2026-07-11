# Filter Registry

Status: experimental SDK state primitive for issue `#179`.
Public entrypoint: `@honua/sdk-js/filter-registry`, also re-exported from
the top-level and `@honua/sdk-js/honua` barrels.

The filter registry is the shared state container for crossfilter behavior.
Map extents, chart bucket selections, table selections, search text, and
explicit filter controls register clauses with an owner and optional source
scope. Components can clear their own filters without touching unrelated
application filters.

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createFilterRegistry,
  projectFilterRegistryToQuery,
} from "@honua/sdk-js/filter-registry";

const filters = createFilterRegistry();

filters.upsert({
  id: "chart:severity",
  owner: { kind: "chart", id: "severity-chart" },
  sourceScope: ["incidents"],
  field: "SEVERITY",
  operator: "in",
  value: ["high", "critical"],
  effect: "crossfilter",
});

filters.upsert({
  id: "map:extent",
  owner: { kind: "map", id: "main-map" },
  effect: "spatial-mask",
  spatialScope: { extent: mapExtent },
});

const projection = projectFilterRegistryToQuery(filters.snapshot, {
  sourceId: "incidents",
  source: incidentSource.descriptor,
});

await incidentSource.query(projection.query);
```

## Clause Model

Each clause carries:

- `id`: stable registry key.
- `owner`: component ownership for scoped clearing.
- `sourceScope`: `"all"` or a list of source ids.
- `field`, `operator`, `value`: structured attribute filter.
- `spatialScope`: spatial filter or extent.
- `lifecycle`: `persistent`, `session`, or `transient`.
- `effect`: `filter`, `crossfilter`, `selection`, `search`, or `spatial-mask`.
- `enabled`: disabled clauses stay in the registry but are omitted from active projections.

`clearOwner(owner)` removes only clauses owned by that component. `clearSource`
removes clauses that apply to one source while leaving filters for other
sources intact.

## Projections

`projectFilterRegistryToQuery()` returns all SDK-facing projections together:

- `query`: canonical `Query` with composed `where` and spatial filter.
- `projection`: `WidgetSourceProjection` for `createWidgetSource()`.
- `linkedView`: structural `LinkedViewQueryProjection` for existing linked-view helpers.
- `runtimeFilter`: MapLibre-style expression for runtime layer filtering.
- `degraded`: structured reasons when the target source cannot apply filters server-side.
- `cacheKey`: deterministic serialization suitable for result cache keys.
- `cacheable`: false when any active clause is transient or explicitly non-cacheable.

`serializeFilterRegistry()` is stable and deterministic for URL sharing and
cache keys. It omits disabled and transient clauses, omits values marked
`valuePolicy.secret`, and drops values whose serialized size exceeds
`valuePolicy.maxSerializedBytes` or the default 2048 byte guardrail.

## Example Crossfilter Flow

```ts doc-test=skip reason="partial excerpt requires application host context"
const registry = createFilterRegistry();

function onChartBucket(values: readonly string[]) {
  registry.upsert({
    id: "chart:status",
    owner: { kind: "chart", id: "status-chart" },
    sourceScope: ["incidents"],
    field: "STATUS",
    operator: "in",
    value: values,
    effect: "crossfilter",
  });
}

function onSearch(text: string) {
  registry.upsert({
    id: "search:global",
    owner: { kind: "search", id: "header-search" },
    field: "NAME",
    operator: "like",
    value: `%${text}%`,
    effect: "search",
    lifecycle: "session",
  });
}

registry.select(
  (snapshot) => projectFilterRegistryToQuery(snapshot, { sourceId: "incidents" }),
  ({ query, projection, runtimeFilter }) => {
    tableSource.query(query);
    widgets.categories({ field: "STATUS", projection });
    map.setFilter("incident-points", runtimeFilter ?? true);
  },
);
```
