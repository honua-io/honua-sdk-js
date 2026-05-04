# ExplorationContext

Status: implemented in `src/exploration/` (ticket `honua-sdk-js-23`).
Public entrypoint: `@honua/sdk-js/exploration` (also re-exported from the
top-level barrel and `@honua/sdk-js/honua`).

`ExplorationContext` is the protocol-neutral container for exploration
state shared across linked views (map, grid, chart, form). It owns
**filters, spatial filters, extent, selection, sort, pagination, visible
fields, grouping, aggregation, and the active linked-view preset** — i.e.
the slices that every exploration UI built on the SDK needs to coordinate.

The runtime is intentionally small: a pure reducer (`reduce`), a
microtask-coalescing event bus (`createExplorationContext`), and a
declarative linked-view policy table (`LINKED_VIEW_PRESETS`). Adding a new
slice means extending the union in three places and running the
conformance suite.

## Module layout

```
src/exploration/
├── index.ts        # barrel
├── types.ts        # state, intents, slices, linked-view types, ExplorationContext interface
├── reducer.ts      # pure reduce(state, intent) → { state, changedSlices }
├── presets.ts      # LINKED_VIEW_PRESETS table + propagationFor()
└── context.ts      # createExplorationContext factory (microtask coalescing, listener bus, view controllers)
```

## State model

```ts
interface ExplorationState {
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly spatialFilter?: SpatialFilter;
  readonly extent?: HonuaExtent;
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly sort: ReadonlyArray<SortSpec>;
  readonly page: PaginationSpec;
  readonly visibleFields: ReadonlyArray<string>;
  readonly grouping: ReadonlyArray<string>;
  readonly aggregation?: AggregationSpec;
  readonly preset: LinkedViewPresetName;
}
```

Every reducer transition returns a new top-level state object. Field
mutations preserve referential equality of unchanged slices, so a listener
that holds `prev.filters` can compare with `===` to decide whether to
re-query.

## Intent vocabulary

Intents are a tagged union (`ExplorationIntent`). Adding a new intent
requires extending the union, the reducer's switch, the slice union, and
the linked-view preset table.

| Kind | Slice changed | Use |
| --- | --- | --- |
| `set-filter` / `clear-filter` | `filters` | Add or remove a global filter clause keyed by id. |
| `set-spatial-filter` | `spatialFilter` | Replace the geometry+relationship that constrains all sources. |
| `set-extent` | `extent` | Update the viewport extent (typically driven by the map view). |
| `select` / `deselect` | `selection` | Mutate the cross-view selection set. `select` is additive by default; `deselect` without ids clears the entire selection. Single-source apps may select raw feature ids; multi-source apps should select source-qualified targets. |
| `set-sort` | `sort` | Apply a sort order shared across grid + chart views. |
| `set-page` | `page` | Update offset / limit. |
| `set-visible-fields` | `visibleFields` | Drives field visibility in tables and forms. Empty = "all". |
| `set-grouping` | `grouping` | Group-by keys for chart / pivot views. |
| `set-aggregation` | `aggregation` | Mirror of `Query.aggregation`. |
| `apply-preset` | `preset` | Switch the linked-view preset. |
| `snapshot-restore` | (whatever changed) | Atomically swap state to a prior snapshot. |

## Linked-view presets

Five built-in presets describe how an intent originating in one view
propagates to peers. The reducer applies central state unconditionally;
the preset gates which **slice-specific** listeners get woken so peer
views can opt out of unrelated noise. Subscribers to the `"all"` slice
always fire for every reducer-produced change — including the slices
the preset suppressed for peers — so global observers, devtools, and
snapshot writers cannot silently miss a state movement.

| Preset | What propagates |
| --- | --- |
| `globalLinked` (default) | Every slice from every role. The safe default. |
| `mapDriven` | Only the map's `extent`, `spatialFilter`, `selection`, and `filters`. |
| `gridDriven` | Only the grid's `selection`, `sort`, `page`, `filters`, `visibleFields`. |
| `chartDriven` | Only the chart's `grouping`, `aggregation`, `filters`. |
| `decoupled` | Nothing propagates — each view is independent. |

Custom presets are not exposed in this ticket; if a downstream view needs
finer-grained control it can pass `decoupled` and re-implement
propagation in application code.

## Coalescing semantics

Listeners fire on a microtask. A burst of intents within the same tick is
coalesced into one `ChangeEvent` per subscribed slice; the event carries
the **merged** changed-slice set, the **latest** state, and the
**previous** state at the start of the tick. This means:

```ts
ctx.dispatch({ kind: "set-filter", id: "state", clause: ... });
ctx.dispatch({ kind: "set-sort", sort: [...] });
// → one microtask, listeners on "filters" and "sort" each fire once,
//   listeners on "all" fire once with changedSlices = { filters, sort }.
```

Implementation: `queueMicrotask` with a single in-flight flag. State
itself is updated synchronously on `dispatch` so `ctx.state` and
`ctx.snapshot()` always reflect the most recent intent.

## View bindings

```ts
const handle = ctx.bind({ id: "map-1", role: "map" });
ctx.dispatch({ kind: "set-extent", extent, viewId: "map-1" });
handle.unbind();
```

`viewId` on an intent identifies the originator. The reducer looks up the
binding to consult the linked-view preset; intents without a `viewId` are
treated as external (everything propagates).

`bind()` is intentionally minimal: it registers the view role for policy
lookups and `unbind()` releases that registration. Raw `ctx.subscribe(...)`
listeners remain registered until their unsubscribe function is called.

## View controllers

Most applications should use `connectView()` instead of pairing `bind()` and
`subscribe()` manually. A view controller stamps its `viewId` onto every
intent, suppresses self-origin callbacks by default to avoid UI feedback
loops, and owns its subscriptions so `unbind()` tears down the component
cleanly.

```ts
const map = ctx.connectView({ id: "map", role: "map" });
const grid = ctx.connectView({ id: "grid", role: "grid" });

grid.subscribe(["extent", "selection", "filters"], async ({ state }) => {
  const result = await dataset.source("incidents")!.query({
    spatialFilter: state.spatialFilter,
    where: assembleWhere(state.filters),
  });
  renderGrid(result, state.selection);
});

map.setExtent(nextExtent);
map.select([incidentId], { replace: true });
```

Self-origin callbacks can be enabled for components that need a local echo:

```ts
grid.subscribe("sort", ({ state }) => renderSort(state.sort), { includeSelf: true });
grid.setSort([{ field: "severity", direction: "desc" }]);
```

This API is the intended synchronization layer for map, table, graph,
filter, and detail components. Component adapters publish semantic intents
(`setExtent`, `setFilter`, `select`, `setAggregation`) and subscribe to the
slices they can render. They do not need to imperatively keep peer widgets in
sync or remember which `viewId` to pass with each intent.

`@honua/sdk-js/interactions` includes thin bindings for common map/table/detail
selection flows:

```ts
import {
  bindDetailToSelection,
  bindMapSelectionToExploration,
  bindTableSelectionToExploration,
  syncFeatureStateSelection,
} from "@honua/sdk-js";

bindMapSelectionToExploration(maplibreMap, mapView, {
  source: "incidents",
  layer: "incident-points",
});

syncFeatureStateSelection(maplibreMap, mapView, { source: "incidents" });

const table = bindTableSelectionToExploration(gridView);
table.select([sourceFeatureSelectionTarget("incidents", 101)], { replace: true });

bindDetailToSelection(detailView, ([selected]) => renderDetail(selected));
```

## Selection targets

Single-source apps can keep using raw feature ids:

```ts
map.select([incidentId], { replace: true });
```

Multi-source apps should use source-qualified targets so overlapping object
ids do not collide across map, table, detail, realtime, and MCP handoff:

```ts
import { sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";

map.select(
  [
    sourceFeatureSelectionTarget("incidents", 101),
    sourceFeatureSelectionTarget("assets", 101),
    sourceFeatureSelectionTarget("vector-tiles", 101, { sourceLayer: "hydrants" }),
  ],
  { replace: true },
);
```

The reducer de-duplicates and deselects source-qualified targets by
`sourceId`, optional `sourceLayer`, raw id type, and id value. That keeps
`incidents:101`, `assets:101`, `"101"`, and vector-tile sublayers distinct
while preserving the old raw-id path for simpler apps.

## Snapshots

```ts
const snap = ctx.snapshot();           // { version: 1, state }
ctx.restore(snap);                     // dispatch a snapshot-restore intent
```

`version: 1` is the only supported version today. A future shape change
must bump the version and add a forward-migration before
`HonuaExplorationContextError("incompatible-snapshot", ...)` triggers.

`snapshot()` returns a deep copy of the live state and `restore()` deep
copies its input before dispatching. Callers may freely retain, serialize,
or mutate a snapshot without aliasing the context's live state — and the
reverse: subsequent `dispatch()` calls cannot mutate a previously returned
snapshot's arrays or nested objects.

## Lifecycle

`ExplorationContext.dispose()` releases all bindings, clears listener
sets, and rejects subsequent `dispatch` / `bind` / `subscribe` /
`restore` calls with `HonuaExplorationContextError("disposed", ...)`.

## Worked example

```ts
import { createDataset } from "@honua/sdk-js/contract";
import { createExplorationContext } from "@honua/sdk-js/exploration";

const dataset = createDataset({ id: "parcels", client, sources: [...] });
const ctx = createExplorationContext({
  datasetId: dataset.id,
  sourceIds: dataset.sourceIds(),
  preset: "mapDriven",
});

const mapView = ctx.connectView({ id: "map", role: "map" });
const gridView = ctx.connectView({ id: "grid", role: "grid" });

gridView.subscribe("extent", async ({ state }) => {
  // Only the map propagates extent in mapDriven; this fires for map-origin extent intents.
  const result = await dataset.source("parcels-fs")!.query({
    spatialFilter: state.spatialFilter,
    where: assembleWhere(state.filters),
  });
  renderGrid(result);
});

mapView.setExtent(nextExtent);
```

## Errors

- `HonuaExplorationContextError("disposed", …)` — dispatch / bind /
  subscribe / restore called after `dispose()`.
- `HonuaExplorationContextError("duplicate-binding", …)` — `bind()`
  called twice with the same view id.
- `HonuaExplorationContextError("incompatible-snapshot", …)` — `restore`
  given a snapshot whose `version` is unknown.
