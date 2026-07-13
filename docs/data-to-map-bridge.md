# Data-to-map bridge (`mountSource`)

> Status: `@experimental` — the surface ships on the stable `/map` entrypoint
> but the option and diagnostics shapes may still change in minor releases.

`mountSource(map, source, options)` from `@honua/sdk-js/map` turns any
contract `Source` into a live, styled MapLibre layer set — no MapPackage, no
Honua server, no app-platform import. It is the standalone slice of the kernel
ADR's `connection.mount(target)` contract
([`docs/decisions/north-star-sdk-application-kernel.md`](./decisions/north-star-sdk-application-kernel.md)):
the bridge borrows a caller-owned map, mutates it transactionally, and returns
one handle that owns every source, layer, and event listener it created.

The module never imports `maplibre-gl`. The map parameter is duck-typed
(`DataToMapLibreMap`); any MapLibre GL `Map` instance works, and so do the
test doubles used by the SDK's own suites.

```ts doc-test=skip reason="requires a browser MapLibre host"
import maplibregl from "maplibre-gl";
import { connect } from "@honua/sdk-js";
import { mountSource } from "@honua/sdk-js/map";

const map = new maplibregl.Map({ container: "map", style: BASEMAP_STYLE_URL, center: [-98, 39], zoom: 3 });
await map.once("load");
const data = await connect({ endpoint: FEATURE_LAYER_URL, protocol: "auto", authorizationScopeFingerprint: "public" });
const mounted = await mountSource(map, data.source(), {
  popup: { factory: () => new maplibregl.Popup(), fields: ["NAME"] },
  hover: true,
  fitBounds: true,
});
```

The runnable version of this workflow (fixture and live lanes) is
[`examples/endpoint-to-map/`](../examples/endpoint-to-map/README.md).

## Strategy selection

The bridge materializes data one of two ways:

| Strategy | Mechanism | Best for |
| --- | --- | --- |
| `"geojson"` | `source.queryAll()` drained into one bounded GeoJSON source | Small/medium result sets; full-fidelity attribute access; offline snapshots |
| `"query-tiles"` | The existing dynamic query-tile path (`@honua/sdk-js/runtime` query-tile helpers): MapLibre pulls viewport-bounded vector tiles and the descriptor's tile cache policy applies | Large or unbounded result sets served by a dynamic query-tile endpoint |

Selection is deterministic and recorded on the handle:

1. `options.strategy` — explicit override, validated against capabilities.
2. No `options.queryTiles` descriptor → `"geojson"` (the source must
   advertise `query`). A declared `tiles` capability without a descriptor is
   reported as a `tile-endpoint-missing` reason, not silently upgraded.
3. `options.queryTiles` present but no `query` capability → `"query-tiles"`.
4. Both viable → **result-size heuristic**: when the source advertises
   `queryExtent`, the bridge probes the matching row count. Counts within
   `maxGeoJsonFeatures` (default 10 000) choose `"geojson"`; larger or
   unknown counts choose `"query-tiles"` (bounded tile requests over
   unbounded materialization).

`explainDataToMapStrategy(source, options)` runs the same logic without
touching a map, mirroring the query planner's explain-before-execute
vocabulary:

```ts doc-test=skip reason="requires a live Source instance"
import { explainDataToMapStrategy } from "@honua/sdk-js/map";

const explanation = await explainDataToMapStrategy(source, { queryTiles });
console.log(explanation.strategy);            // "geojson" | "query-tiles"
console.log(explanation.probedCount);         // row count when the probe ran
for (const reason of explanation.reasons) console.log(reason.code, reason.message);
```

## Diagnostics on the handle

`mounted.diagnostics` is the explain surface required by the bridge contract
(REQ-002). It carries:

- `strategy` and `reasons[]` — why the strategy was chosen
  (`strategy-override`, `result-size-within-limit`, `count-probe-unavailable`, …).
- `featureCount`, `totalCount`, `geometryKinds` — current GeoJSON
  materialization state.
- `overflow` — pagination-truncation report (below).
- `updates[]` — lifecycle events appended by `setFilter` / `refresh`
  (`filter-applied`, `filter-recreated-source`, `refresh-applied`).

### Limits and overflow

GeoJSON materialization is always bounded by `maxGeoJsonFeatures`. When the
source reports more matching rows than were materialized, the handle reports
it instead of pretending the map is complete:

```ts doc-test=skip reason="requires a mounted handle"
if (mounted.diagnostics.overflow) {
  const { renderedFeatureCount, totalCount, limit } = mounted.diagnostics.overflow;
  // e.g. "Showing 10000 of 250000 rows" — raise maxGeoJsonFeatures,
  // narrow options.query, or supply a queryTiles descriptor.
}
```

## Default styling

Without overrides the bridge installs a stable geometry matrix so filter
changes can move between geometry kinds without structural layer churn:

- `<layerId>-point` — `circle` layer (filtered to `Point`)
- `<layerId>-line` — `line` layer (filtered to `LineString`)
- `<layerId>-polygon` — `fill` layer (filtered to `Polygon`)
- `<layerId>-polygon-outline` — `line` layer over the polygon fill

Overrides, from lightest to heaviest:

```ts doc-test=skip reason="requires a browser MapLibre host"
await mountSource(map, source, {
  geometry: "polygon",                                  // restrict to one kind (fill + outline)
  paint: {
    polygon: { "fill-color": "#123456" },               // merged over the defaults
    polygonOutline: { "line-width": 3 },
  },
  layout: { point: { visibility: "visible" } },
});

await mountSource(map, source, {
  layers: [                                             // full control: bridge adds them verbatim
    { id: "heat", type: "heatmap", paint: { "heatmap-radius": 12 } },
  ],
});
```

The GeoJSON source sets `promoteId` from `schema.primaryKey` so feature-state
(hover, selection) works out of the box, and requests WGS84 output
(`outSr: 4326`) unless the caller's query specifies otherwise.

## Interactions

```ts doc-test=skip reason="requires a browser MapLibre host"
await mountSource(map, source, {
  popup: {
    factory: () => new maplibregl.Popup({ closeButton: true }),
    fields: ["NAME", "STATUS"],                    // or a formatter:
    // render: ({ features }) => `<b>${features[0]?.properties?.NAME}</b>`,
    title: "Parcel",
  },
  hover: true,                                     // or { stateKey: "highlight" }
});
```

- **Popup** — binds `click` on each interactive layer through the runtime's
  popup primitives. `fields` restricts the default definition-list renderer;
  `render` replaces it entirely (return `undefined` to suppress a popup).
- **Hover** — toggles a boolean feature-state key through the interactions
  layer (`createHoverHandler`). Pair it with a paint expression such as
  `["case", ["boolean", ["feature-state", "hover"], false], 1, 0.6]`.

Both require the corresponding map methods (`on`/`off`, `setFeatureState`);
the bridge throws a typed `interaction-unsupported` error rather than
degrading silently.

## Filter updates and refresh

`setFilter(query)` replaces the mounted filter and **diff-updates** rather
than tearing down:

- **GeoJSON** — re-runs the bounded query and applies it through
  `source.setData()`; layers, listeners, and camera are untouched.
- **Query-tiles** — rewrites the tile URL template (the descriptor's `query`)
  and applies it through `source.setTiles()`. Hosts without `setTiles` get an
  in-place source recreation (reported as a `filter-recreated-source`
  warning). Descriptors with fixed tile URLs that cannot carry a query throw
  a typed `filter-unsupported` error instead of silently rendering stale data.

`refresh()` re-executes the current filter through the same paths. Updates
are serialized: concurrent calls run in order, never interleaved.

```ts doc-test=skip reason="requires a mounted handle"
await mounted.setFilter({ where: "STATUS = 'ACTIVE'" });
await mounted.refresh();
await mounted.setFilter(undefined);   // clear
```

## Disposal

The handle owns every MapLibre resource it created and follows the kernel
resource-ownership contract (REQ-004):

- `dispose()` removes popup bindings, hover handlers, layers (reverse order),
  and the source, then aborts any in-flight query work. It is **idempotent**
  — a second call (React StrictMode double-invoke, `finally` blocks) is a
  silent no-op.
- `Symbol.asyncDispose` awaits in-flight updates before disposing, so
  `await using` works end-to-end:

```ts doc-test=skip reason="requires a browser MapLibre host"
{
  await using mounted = await mountSource(map, source);
  // … the mount is removed when the block exits
}
```

The bridge never touches resources it did not create: the map itself, the
basemap style, and other sources/layers stay caller-owned.

## Option reference

| Option | Default | Purpose |
| --- | --- | --- |
| `strategy` | auto | Force `"geojson"` or `"query-tiles"` |
| `query` | — | Initial filter (`where`, `spatialFilter`, `outFields`, …) |
| `maxGeoJsonFeatures` | `10000` | GeoJSON bound + heuristic threshold |
| `queryTiles` | — | Dynamic query-tile descriptor (enables the tile strategy) |
| `sourceLayer` | tile descriptor's `sourceId` | Vector `source-layer` for tile layers |
| `sourceId` / `layerId` / `beforeId` | derived | MapLibre id control |
| `geometry` | `"auto"` | Restrict default styling to one geometry kind |
| `layers` / `paint` / `layout` | defaults | Styling overrides |
| `attribution` | descriptor attribution | Source attribution |
| `fitBounds` | off | Fit camera to data / descriptor bounds |
| `popup` / `hover` | off | Interactions |
| `signal` | — | Cancels mounting and in-flight updates |

## Related surfaces

- Accepted-plan (fingerprinted) mounting and the automatic strategy planner:
  [`docs/maplibre-runtime.md`](./maplibre-runtime.md) —
  `mountSourceToMapLibre` / `explainAutomaticSourceToMapLibre` on the same
  `/map` entrypoint. Use those when you need plan review, provenance, and
  freshness policy; use `mountSource` when you want the ten-line path.
- Dynamic query-tile descriptors, TileJSON, and the tile request controller:
  `@honua/sdk-js/runtime` (`buildMapLibreQueryTileSourceSpec`,
  `QueryTileRequestController`).
- Feature-state and selection primitives: `@honua/sdk-js/interactions`.
