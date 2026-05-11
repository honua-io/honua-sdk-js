# Dynamic Query Tiles

Status: client descriptor/runtime implemented in `src/contract/tiles.ts` and
`src/runtime/query-tiles.ts` (issue `honua-sdk-js#152`); server contract
helpers and fixtures added for `honua-sdk-js#164`.

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
- `source`, `analyticsSource`, or `protocol`: source descriptor metadata used
  for diagnostics and cache identity.
- `endpoint`: `urlTemplate`, `tilejsonUrl`, or `baseUrl` + optional `path`.
- `query` and `projection`: filter and styling fields that affect tile content.
- `cache.key`: `sourceVersion`, `authorizationScope`, `styleFilters`, and
  adapter-specific `extra` dimensions.
- `featureIdentity`: id/property mapping hooks for rendered tile features.
- `fallback`: explicit fallback mode for protocols without tile pushdown.

`buildQueryTileCacheKey()` normalizes `{z,x,y}` tile keys, wraps X, clamps Y,
and includes source id, protocol, tile matrix set, query, projection, style
filters, source version, and authorization scope. When the descriptor is backed
by a warehouse/indexed analytics source, the key also includes the analytics
source cache identity: table/query/tileset id, SQL text, index model and
resolution, auth scope, filters, and style projection.

Warehouse and indexed descriptors can be passed directly as `source`:

```ts
import { defineIndexedSpatialSource, defineQueryTileSource } from "@honua/sdk-js/contract";

const cells = defineIndexedSpatialSource({
  id: "warehouse.incidents.h3",
  provider: "carto",
  sql: { text: "select h3_cell, severity from incidents" },
  index: { modelId: "h3", cellIdField: "h3_cell", resolution: 8 },
  cache: { key: { sourceVersion: "mv-17", authorizationScope: "role:ops" } },
  fallback: { mode: "disabled" },
});

const tiledCells = defineQueryTileSource({
  id: "incident-h3-tiles",
  source: cells,
  endpoint: { baseUrl: "https://honua.example.com/query-tiles" },
  projection: { fields: ["severity"] },
});
```

## MapLibre Helpers

`buildQueryTileJson()` emits minimal TileJSON v3 metadata. If the server already
returned TileJSON, the helper preserves it and fills missing values from the
descriptor.

`buildMapLibreQueryTileSourceSpec()` returns a MapLibre-compatible vector
source. It uses `endpoint.tilejsonUrl` when present, otherwise it emits an
inline `tiles` template with `{z}/{x}/{y}` placeholders. `featureIdentity`
drives MapLibre `promoteId` so feature-state calls can use canonical ids.

`buildQueryTileUrlTemplate()` and `buildQueryTileUrl()` are pure URL helpers
for adapters and tests. When `endpoint.baseUrl` is set, the default tile path
is the canonical source route under that service root:
`sources/{sourceId}/tiles/{z}/{x}/{y}.mvt`.

## Server HTTP Contract

Dynamic query tile servers expose one route prefix, normally `/query-tiles`.
SDK descriptors should point `endpoint.baseUrl` at that prefix, for example
`https://honua.example.com/query-tiles`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/query-tiles/sources/{sourceId}/tilejson.json` | `GET` | TileJSON discovery for a query-backed source. |
| `/query-tiles/sources/{sourceId}/tiles/{z}/{x}/{y}.mvt` | `GET` | Mapbox Vector Tile payload for one XYZ tile. |
| `/query-tiles/sources/{sourceId}/features/{featureId}` | `GET` | Source-qualified detail lookup for a rendered tile feature. |

Canonical request parameters are shared across TileJSON and tile requests:

| Parameter | Meaning |
| --- | --- |
| `where` | Server-side source filter. SQL-92, CQL2, or adapter-native expression as negotiated by the source. |
| `outFields` | Comma-separated detail fields needed by styles/interactions. |
| `returnGeometry` | Whether detail responses should include geometry. Tile payloads always include render geometry. |
| `outSr` | Output spatial reference for feature detail geometry. |
| `tileMatrixSet` | Tile matrix set id. `WebMercatorQuad` is the default for web maps. |
| `extent` / `extentSr` | Optional source extent constraint and its spatial reference. |
| `projection` | Comma-separated tile attribute projection. |
| `projectionReturnGeometry` | Whether the source projection includes geometry before tile clipping. |
| `simplifyTolerance` | Server simplification tolerance hint in output units. Servers may lower it but must report degradation if they raise it. |
| `maxFeatures` | Maximum features allowed in a tile or detail response before degradation/error behavior applies. |
| `cacheKey` / `cacheBust` | Optional cache partition or explicit invalidation token. Do not put secrets here. |

SDK route helpers are exported from `@honua/sdk-js/contract`:

```ts
import { buildQueryTileServerPath, buildQueryTileServerUrl } from "@honua/sdk-js/contract";

buildQueryTileServerPath("tile", { sourceId: "incidents" });
// /query-tiles/sources/incidents/tiles/{z}/{x}/{y}.mvt

buildQueryTileServerUrl("tilejson", {
  baseUrl: "https://honua.example.com",
  sourceId: "incidents",
});
// https://honua.example.com/query-tiles/sources/incidents/tilejson.json
```

## Response Schemas

TileJSON responses use TileJSON v3 and carry Honua metadata in the
`honua:queryTiles` extension field. Required metadata:

- `contractVersion`: currently `1`.
- `sourceId`: canonical source id used by selection and detail lookup.
- `tileMatrixSet`, `format`, `spatialReference`, and optional `extent`.
- `featureIdentity`: source id, id property, optional source layer, `promoteId`,
  and detail URL template.
- `detailUrlTemplate`: URL template containing `{featureId}`.
- `cache`: validator policy (`etag`, `last-modified`), `Cache-Control`, `Vary`,
  and source version when known.
- `limits`: max-feature and simplification settings.
- `degraded`: optional non-fatal warnings such as geometry simplification.

MVT tile responses return `application/vnd.mapbox-vector-tile`. Binary tile
responses cannot carry a JSON envelope, so servers report metadata through
headers: `ETag`, `Last-Modified`, `Cache-Control`, `Vary`,
`X-Honua-Source-Version`, `X-Honua-Feature-Count`,
`X-Honua-Max-Features`, and optional `X-Honua-Degraded` JSON.

Feature detail responses are JSON:

```json
{
  "contractVersion": 1,
  "identity": { "sourceId": "incidents", "id": "incident-42", "sourceLayer": "incidents" },
  "found": true,
  "feature": { "attributes": { "id": "incident-42" }, "geometry": null },
  "cache": { "etag": "\"incident-42-v7\"", "sourceVersion": "stream-42" },
  "degraded": []
}
```

Errors use one JSON shape on every route:

```json
{
  "contractVersion": 1,
  "error": {
    "code": "max-features-exceeded",
    "message": "The tile exceeded maxFeatures=500.",
    "status": 422,
    "requestId": "req-123",
    "degraded": []
  }
}
```

Known error codes include `bad-request`, `unauthorized`, `forbidden`,
`not-found`, `not-acceptable`, `unsupported-sr`, `tile-out-of-range`,
`max-features-exceeded`, `timeout`, `rate-limited`, `server-error`, and
`unavailable`.

## Auth, Cache, And Limits

Auth is transport-level. Clients send `Authorization`, `X-API-Key`, cookies, or
other configured auth headers through the SDK fetch helpers. Servers must vary
cacheable responses by the auth partition that changes visible data, normally
with `Vary: Authorization` plus a non-secret `authorizationScope` in the SDK
descriptor cache key.

TileJSON, tile, and detail routes should emit `ETag` and/or `Last-Modified`.
Clients may send `If-None-Match` and `If-Modified-Since`; servers answer `304`
when the cached representation is still valid. Use `X-Honua-Source-Version`
for source data versioning and `cacheBust` only when a caller explicitly needs
to bypass validators.

Servers should serve tiles in `WebMercatorQuad` / EPSG:3857 unless the
TileJSON metadata declares another tile matrix set and spatial reference.
`extent` must state its spatial reference when it is not WGS84 bounds.

Simplification must preserve topology enough for display and hit-testing. If a
server increases simplification beyond the requested tolerance, drops
attributes, applies authorization filters, returns stale cache, or truncates
features, it must include a `degraded[]` entry. If `maxFeatures` would make a
tile misleading, prefer an error response over a silent partial tile.

## Runtime Fetch Helpers

`@honua/sdk-js/runtime` exports:

- `fetchQueryTileJson(descriptor, options)` for TileJSON discovery, validator
  headers, `304` handling, and metadata degradation parsing.
- `fetchQueryTileFeatureDetail(descriptor, target, options)` for source
  qualified detail lookup and canonical error parsing.
- `QueryTileServerResponseError` for structured HTTP failures.

The reusable fixture pack lives at
`test/fixtures/sdk-contract/query-tile-server.v1.json`. It defines the routes,
request params, TileJSON metadata, detail response, and degradation/error
envelopes that server implementations can import into their own contract tests.

Affected server implementation repos are a dependency for production support:
they must implement the `/query-tiles` route prefix and pass the fixture shape.
This SDK issue only defines the client helpers, docs, and reusable fixtures.

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
