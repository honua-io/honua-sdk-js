# Warehouse Analytics Sources

Status: draft contract primitives for issue #184.

The SDK now exposes provider-neutral descriptors for CARTO-style analytics
sources:

| CARTO-style concept | Honua descriptor |
| --- | --- |
| table source | `WarehouseTableSourceDescriptor` / `defineWarehouseTableSource()` |
| SQL query source | `WarehouseQuerySourceDescriptor` / `defineWarehouseQuerySource()` |
| tileset source | `WarehouseTilesetSourceDescriptor` / `defineWarehouseTilesetSource()` |
| H3 source | `IndexedSpatialSourceDescriptor` with `kind: "h3-index"` |
| Quadbin source | `IndexedSpatialSourceDescriptor` with `kind: "quadbin-index"` |
| generic indexed source | `IndexedSpatialSourceDescriptor` with `kind: "indexed-spatial"` |

Descriptors live in `@honua/sdk-js/contract`. They are serializable metadata,
not credential containers. SQL text, table identifiers, tileset ids, index
resolution, cache partitions, and non-secret authorization scope ids belong in
the descriptor. API keys, database passwords, OAuth tokens, and warehouse
sessions belong in transport/control-plane configuration.

```ts doc-test=compile
import {
  defineIndexedSpatialSource,
  defineQueryTileSource,
  buildAnalyticsSourceCacheKey,
} from "@honua/sdk-js/contract";

const incidentCells = defineIndexedSpatialSource({
  id: "warehouse.incidents.h3",
  provider: "carto",
  sql: {
    text: "select h3_cell, severity, exposure from incidents where status <> 'closed'",
    dialect: "postgres",
  },
  index: {
    modelId: "h3",
    cellIdField: "h3_cell",
    resolution: 8,
    hierarchy: "parent-child",
    coverage: { kind: "bounded", complete: false },
  },
  cache: {
    key: {
      sourceVersion: "materialized-view-17",
      authorizationScope: "role:ops",
    },
  },
  fallback: { mode: "disabled" },
});

const tiles = defineQueryTileSource({
  id: "incident-h3-tiles",
  source: incidentCells,
  endpoint: { baseUrl: "https://honua.example.com/query-tiles" },
  // Deprecated warehouse-native compatibility text; not a portable semantic filter.
  query: { where: "severity >= 3", outFields: ["severity", "exposure"] },
  projection: { fields: ["severity", "exposure"] },
  cache: { key: { styleFilters: { severity: "high" }, extra: { indexResolution: 8 } } },
});

const widgetCacheKey = buildAnalyticsSourceCacheKey(incidentCells, {
  operation: "widget",
  cache: {
    filters: { severity: ["critical", "high"] },
    indexResolution: 8,
    widgetProjection: { kind: "histogram", field: "exposure" },
  },
});
```

## Cache And Pushdown

`buildAnalyticsSourceCacheKey()` includes source kind, table/query/tileset
identity, SQL text, index model/resolution, source version, authorization
scope, filters, and widget/style projections. Query-tile and widget helpers
reuse the same descriptor key so maps, charts, and crossfilters share a source
identity without sharing secrets.

`assessAnalyticsSourcePushdown()` reports whether a descriptor advertises
`sql`, `tiles`, `widgets`, `spatialAggregate`, `crossfilter`, or `metadata`
pushdown. Unsupported capabilities return structured `DegradedReason` objects.
Large warehouse sources should use `fallback: { mode: "disabled" }` unless a
server-owned bounded fallback is explicitly available; the SDK should not infer
an unbounded browser materialization path.

## Spatial Aggregation

`SpatialAggregationRequest` and `SpatialAggregationMetadata` can carry the same
analytics descriptor. Index metadata now records hierarchy and coverage so H3,
Quadbin, and provider-specific grids can advertise parent/child behavior,
bounded or sparse coverage, and progressive refinement without callers parsing
cell ids.

Production execution remains a server/platform concern. This SDK slice defines
the client-side contract, cache identity, degradation vocabulary, fixture
coverage, and query-tile/widget integration points.
