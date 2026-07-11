# Linked-View Context Sync

Status: optional SDK/UI integration layer for issue `#72`, building on the
`ExplorationContext`, `@honua/sdk-js/interactions`, and
`@honua/sdk-js/realtime` public surfaces.

Linked-view context sync coordinates maps, tables, charts or graphs, filter
controls, detail panels, and live operational layers without wiring those
components directly to each other. Each component adapter dispatches typed
exploration intents into one `ExplorationContext` and subscribes to the slice
or selector it can render. A map does not call a table, a chart does not call a
map, and a filter bar does not know which layers or protocols consume its
clauses.

## Core Pattern

```ts doc-test=compile
import { createExplorationContext, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import {
  bindChartToExploration,
  bindDetailToSelection,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindQueryProjectionToExploration,
  bindTableSelectionToExploration,
  syncMapLayerFilterToExploration,
} from "@honua/sdk-js/interactions";
import { reconcileRealtimeSelection } from "@honua/sdk-js/realtime";

const ctx = createExplorationContext({
  datasetId: "ops",
  sourceIds: ["incidents"],
  preset: "mapDriven",
});

const mapView = ctx.connectView({ id: "map", role: "map" });
const tableView = ctx.connectView({ id: "table", role: "grid" });
const chartView = ctx.connectView({ id: "chart", role: "chart" });
const filterView = ctx.connectView({ id: "filters", role: "filter" });
const detailView = ctx.connectView({ id: "detail", role: "detail" });
```

`connectView()` returns an `ExplorationViewController`. The controller stamps
the bound `viewId` onto every dispatch, suppresses self-origin callbacks by
default, and releases subscriptions on `unbind()`.

## Component Adapters

Maps publish viewport and selection intents:

```ts doc-test=skip reason="partial excerpt requires application host context"
bindMapExtentToExploration(mapView, mapExtentSource, {
  publishSpatialFilter: false,
});

mapView.select([sourceFeatureSelectionTarget("incidents", 101)], { replace: true });
```

Tables and charts subscribe to a query projection rather than to the map:

```ts doc-test=skip reason="partial excerpt requires application host context"
bindQueryProjectionToExploration(tableView, async (projection) => {
  const rows = await source.query({
    spatialFilter: projection.spatialFilter,
    orderBy: projection.orderBy,
    pagination: projection.pagination,
    outFields: projection.outFields,
  });
  renderRows(rows, projection.selection);
});

bindChartToExploration(chartView).subscribeQuery((projection) => {
  renderChart({
    filters: projection.filters,
    spatialFilter: projection.spatialFilter,
    grouping: projection.grouping,
    aggregation: projection.aggregation,
  });
});
```

Filter controls publish structured `FilterClause` values. Map, table, and
chart adapters translate the same projection at their protocol edge:

```ts doc-test=skip reason="partial excerpt requires application host context"
const filters = bindFilterControlsToExploration(filterView);

syncMapLayerFilterToExploration(maplibreMap, mapView, {
  layerId: "incident-points",
  sourceId: "incidents",
  translate: (projection) => compileMapLibreFilter(projection.filters),
});

filters.setFilter("status", {
  field: "STATUS",
  operator: "=",
  value: "open",
  appliesTo: ["incidents"],
});
```

Charts or graphs can drive grouped exploration by dispatching grouping,
aggregation, selected feature targets, and bucket filters:

```ts doc-test=skip reason="partial excerpt requires application host context"
const chart = bindChartToExploration(chartView);

chart.setGrouping(["SEVERITY"]);
chart.setAggregation({
  groupBy: ["SEVERITY"],
  metrics: [{ fn: "count", field: "OBJECTID" }],
});
chart.selectBucket({
  targets: [sourceFeatureSelectionTarget("incidents", 101)],
  filters: {
    severity: { field: "SEVERITY", operator: "=", value: "high" },
  },
});
```

Detail panels subscribe to selection:

```ts doc-test=skip reason="partial excerpt requires application host context"
bindDetailToSelection(detailView, ([selected]) => {
  renderDetail(selected);
});

const table = bindTableSelectionToExploration(tableView);
table.clearSelection();
```

## Presets

Presets decide which bound-view slice notifications propagate to peers. Central
state still moves for every valid intent, and `"all"` subscribers still observe
every reducer change for devtools, persistence, and snapshot writing.

| Preset | Use when | Peer propagation |
| --- | --- | --- |
| `globalLinked` | Prototypes and fully coordinated apps. | Every role can publish every slice. |
| `mapDriven` | The map viewport is the primary browsing surface. | Map publishes `extent`, `spatialFilter`, `selection`, and `filters`; filter controls publish `filters` and `spatialFilter`. |
| `chartDriven` | A chart or graph bucket controls the working set. | Chart publishes `grouping`, `aggregation`, `filters`, and `selection`; filter controls publish `filters`. |
| `decoupled` | Components should keep local interaction state while sharing one serializable context. | No peer slice notifications; snapshots still contain central state. |

```ts doc-test=skip reason="partial excerpt requires application host context"
ctx.connectView({ id: "map", role: "map" }).applyPreset("chartDriven");
```

Use `decoupled` when an application wants the SDK state container and snapshot
format but needs app-owned propagation rules. Because slice listeners stay
quiet, components must subscribe to `"all"` or use app-specific routing if they
need to observe local-only movement.

## Realtime Deltas

Realtime feature stores are another producer of typed state. Transport adapters
emit normalized deltas through `@honua/sdk-js/realtime`; UI adapters reconcile
the resulting live set against `ExplorationContext` selection.

```ts doc-test=skip reason="partial excerpt requires application host context"
store.subscribe((state) => {
  reconcileRealtimeSelection(detailView, state, {
    sourceId: "incidents",
    requireLiveRecord: true,
  });
});
```

`delete` events create tombstones, and stale or replayed streams keep cursor and
watermark metadata in the realtime store. Selection reconciliation removes
tombstoned and, by default, missing live records from the shared selection so
map highlights, table rows, charts, and detail panels do not point at archived
features.

## Adoption Paths

Issue `#56` can adopt this layer for sample and application work by binding
maps, grids, charts, filters, and details through one `ExplorationContext`
instead of custom pairwise callbacks.

Issue `#57` can reuse the realtime reconciliation path for the incident
operations dashboard so live feature deltas, map highlights, table rows,
charts, filters, and detail panels converge through the same context instead
of pairwise synchronization callbacks.
