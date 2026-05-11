# Dynamic Query Tiles

Status: implemented in `src/contract/tiles.ts` and
`src/runtime/query-tiles.ts` (issue `honua-sdk-js#152`).

Dynamic query tiles let SDK consumers describe large operational sources as
viewport-scoped vector tiles while preserving the canonical `Source` identity
used by selection, feature-state, and detail panels. The abstraction is split
between the contract entrypoint and the MapLibre-aware runtime entrypoint:

```ts
import { defineQueryTileSource } from "@honua/sdk-js/contract";
import { buildMapLibreQueryTileSourceSpec } from "@honua/sdk-js/runtime";

const tiledIncidents = defineQueryTileSource({
  id: "incidents-query-tiles",
  source: incidentsSourceDescriptor,
  endpoint: { baseUrl: "https://honua.example.com/query-tiles" },
  query: { where: "severity >= 3", outFields: ["id", "severity"] },
  projection: { fields: ["id", "severity"] },
  cache: {
    maxEntries: 256,
    key: {
      sourceVersion: "stream-42",
      authorizationScope: "ops-role",
      styleFilters: { minSeverity: 3 },
    },
  },
  fallback: { mode: "query-bbox" },
  featureIdentity: { idProperty: "id" },
});

map.addSource("incidents-query-tiles", buildMapLibreQueryTileSourceSpec(tiledIncidents));
```

## Descriptor

`QueryTileSourceDescriptor` carries:

- `id`: runtime / MapLibre source id.
- `sourceId`: canonical source id used by selection and detail lookup.
- `source` or `protocol`: source descriptor metadata used for diagnostics.
- `endpoint`: `urlTemplate`, `tilejsonUrl`, or `baseUrl` + optional `path`.
- `query` and `projection`: filter and styling fields that affect tile content.
- `cache.key`: `sourceVersion`, `authorizationScope`, `styleFilters`, and
  adapter-specific `extra` dimensions.
- `featureIdentity`: id/property mapping hooks for rendered tile features.
- `fallback`: explicit fallback mode for protocols without tile pushdown.

`buildQueryTileCacheKey()` normalizes `{z,x,y}` tile keys, wraps X, clamps Y,
and includes source id, protocol, tile matrix set, query, projection, style
filters, source version, and authorization scope.

## MapLibre Helpers

`buildQueryTileJson()` emits minimal TileJSON v3 metadata. If the server already
returned TileJSON, the helper preserves it and fills missing values from the
descriptor.

`buildMapLibreQueryTileSourceSpec()` returns a MapLibre-compatible vector
source. It uses `endpoint.tilejsonUrl` when present, otherwise it emits an
inline `tiles` template with `{z}/{x}/{y}` placeholders. `featureIdentity`
drives MapLibre `promoteId` so feature-state calls can use canonical ids.

`buildQueryTileUrlTemplate()` and `buildQueryTileUrl()` are pure URL helpers
for adapters and tests.

## Viewport Lifecycle

`QueryTileRequestController` is an opt-in request manager for surfaces that do
not delegate tile loading to MapLibre. It provides:

- `requestTile({ z, x, y })` with cache reuse.
- `requestViewport({ bounds, zoom })` that requests only visible tiles.
- automatic aborts for inflight requests outside the next viewport.
- lifecycle events: `tile-requested`, `tile-cache-hit`, `tile-loaded`,
  `tile-aborted`, `tile-error`, and `tile-evicted`.
- `invalidate()`, `clearCache()`, `cacheSnapshot()`, and `diagnostics()`.

## Identity And Detail

`mapQueryTileFeatureIdentity()` maps rendered tile features back to
`{ sourceId, id, sourceLayer }`. It can use simple property names or a custom
`mapFeature` hook.

`loadQueryTileFeatureDetail()` turns a selected tile feature into a canonical
`Source.query()` detail request. The helper uses the descriptor's
`featureIdentity.idProperty` or an explicit `idField`, combines it with an
optional base query, and requests one feature.

## Diagnostics

`diagnoseQueryTileSourceSupport()` reports unsupported protocols, missing tile
endpoints, unbounded cache settings, missing cache scopes, and explicit
fallbacks. Protocols with first-party tile/render support report
`tile-pushdown-supported`; queryable protocols without native tile pushdown
report `tile-pushdown-unavailable` unless fallback is disabled.
