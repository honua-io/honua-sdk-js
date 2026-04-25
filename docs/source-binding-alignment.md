# SourceDescriptor ↔ Server SourceBinding Alignment

This document keeps the SDK's `SourceDescriptor` shape aligned with the
server's `SourceBinding` model (currently implemented in
`honua-server/src/Honua.Core/Features/Geoprocessing/Domain/SourceBinding.cs`)
and the SDK runtime's `HonuaMapPackageSourceBinding` mirror. The SDK
`SourceLocator` is a superset of the current server locator: `url`,
`serviceId`, and `layerId` are guaranteed by the server model today,
while OGC route hints such as `collectionId`, `tileMatrixSetId`, and
`styleId` are SDK-side fields that can be carried as additive package
locator fields until the server schema exposes them explicitly.

## Field map

| `SourceDescriptor` (SDK) | `SourceBinding` (server) | Notes |
| --- | --- | --- |
| `id` | `id` | Stable identifier; preserved verbatim. |
| `protocol` | `protocol` | Same enum; the SDK's MapLibre-native protocols (`maplibre-vector`, `maplibre-raster`, `maplibre-geojson`) project onto the server's `mapSpec.sources` stanza rather than `sourceBindings`. |
| `locator.url` | `locator.url` | Fully qualified endpoint URL. |
| `locator.serviceId` | `locator.serviceId` | GeoServices service identifier (FeatureServer, MapServer, ImageServer, Geometry, GP). |
| `locator.layerId` | `locator.layerId` | Numeric layer identifier within the service. |
| `locator.collectionId` | `locator.collectionId` | OGC API Features / Tiles / Maps / STAC collection. |
| `locator.tileMatrixSetId` | `locator.tileMatrixSetId` | OGC API Tiles tile-matrix-set identifier. When set, `Source.adapter("ogc-tiles")` returns a bound `HonuaOgcTileset`; when omitted, it returns the root `HonuaOgcTiles` handle for tile-matrix-set discovery. Preserved as an additive locator field when present. |
| `locator.styleId` | `locator.styleId` | OGC API Maps styled-output identifier. Consumed by `Source.adapter("ogc-maps")` to build the `/styles/{styleId}/map` route. Not consumed by the OGC Tiles adapter today: honua-server does not expose a `/styles/{styleId}/tiles/...` route, so the SDK keeps the tile path canonical. Preserved as an additive locator field when present. |
| `locator.typeName` | `locator.typeName` | WFS / WMS / WMTS layer name (the WMS `LAYERS=` value, the WMTS `Layer` identifier). |
| `locator.entitySet` | `locator.entitySet` | OData entity set. |
| `locator.taskName` | `locator.taskName` | GP Service task identifier; combined with `serviceId` it uniquely identifies one async task without leaking task parameters into the descriptor. Required on descriptors that advertise the `geoprocess` capability — `createDataset` rejects bindings without it because the lifecycle routes (`/GPServer/<taskName>/submitJob` etc.) do not exist at the service root. |
| `capabilities` | `capabilities` | Set serialized as a sorted string array on the wire. The server is authoritative for what it serves; the SDK's set is what the **adapter** can produce. |
| `schema.fields` | `schema.fields` | Optional. Same shape as `HonuaFieldInfo`. |
| `schema.primaryKey` | `schema.primaryKey` | Optional; defaults to first PK detected in `fields`. |
| `schema.timeField` | `schema.timeField` | Optional temporal validity hint. |
| `attribution` | `attribution` | Free text. Attribution survives round-trip; the SDK does not modify it. |

## MapBinding ↔ MapPackage

| `MapBinding` (SDK) | `MapPackage.sourceBindings[i]` / `mapSpec.layers[j]` (server) |
| --- | --- |
| `sourceId` | Resolved against `sourceBindings[].id`; the export writer dedupes. |
| `layerIds` | Layer ids in `mapSpec.layers[].id`. |
| `style` | Merged into the corresponding `mapSpec.layers[].paint` / `.layout` blocks. |
| `minzoom` / `maxzoom` | `mapSpec.layers[].minzoom` / `.maxzoom`. |

The SDK does not own `MapPackage.metadata` or `AppPackage` shapes — those
are server-side concepts. An SDK ticket exporting an `AppPackage` should
construct one server-side document that wraps the canonical
`SourceDescriptor` + `MapBinding` arrays produced here.

## What changes when you add a protocol

Adding a new protocol on the SDK side requires:

1. Extending the `Protocol` union and the `PROTOCOLS` array in
   `src/contract/types.ts`.
2. Adding an entry to `PROTOCOL_DEFAULT_CAPABILITIES`.
3. Updating the matrix in
   [`protocol-capability-matrix.md`](./protocol-capability-matrix.md).
4. Implementing the adapter (built-in or via `resolveSource`).
5. Coordinating with the server-side `SourceBinding.protocol` enum so the
   exported document round-trips. If the protocol is SDK-only (e.g. an
   in-memory cache layer), the export writer must drop or transform it
   before serializing.

## What does not round-trip

- `Source.protocol()` (alias `Source.adapter()`) — the typed escape
  hatch. Exists only on the SDK side. The exporter emits the descriptor,
  not the live adapter instance, so protocol-specific operations
  (`exportImage`, `identify`, `buffer`, `project`, `submitJob`, raw
  `where` / `outFields`, `calculate`, `validateSQL`, `replica`,
  `queryBins`, `getEstimates`) never serialize into a `SourceBinding`.
- `Capabilities` from the `SourceDescriptor` serialize verbatim on
  export. Automatic metadata-driven downgrades inside the adapter
  constructor (e.g. dropping `queryAggregate` when metadata reports
  `supportsStatistics: false`) are not implemented today — callers that
  want a downgraded capability set must pass it on
  `SourceDescriptor.capabilities`. When metadata-driven downgrades land,
  the exported `SourceBinding.capabilities` will reflect the runtime set
  and the server will treat it as authoritative.
- `Result.degraded` flags — they describe runtime behavior, not the
  source itself. Exporting state to a `SourceBinding` discards them.
- Auth headers — never serialized into a `SourceBinding`. The
  server-side runtime resolves credentials from its own credential store.
- The current honua-server `SourceLocator` model guarantees `url`,
  `serviceId`, and `layerId`; OGC-specific locator hints such as
  `collectionId`, `tileMatrixSetId`, and `styleId` are SDK-side route
  discriminators until the server schema carries them explicitly. Unknown
  locator fields are preserved by the SDK runtime package model.

## Verification

The conformance suite under `test/contract/` includes a round-trip
scenario per protocol that takes a `SourceDescriptor`, projects it to a
`SourceBinding`-shaped object, and re-imports it. If the server-side
shape changes, that fixture must be updated in lockstep with this
document and `PROTOCOL_DEFAULT_CAPABILITIES`.

## Runtime consumer: `@honua/sdk-js/runtime`

The MapLibre GL JS-first runtime (`loadMapPackage`) consumes a
server-produced `MapPackage` and projects its `sourceBindings[]` through
the same alignment table. Protocol name translation happens inside the
runtime's `source-bridge.ts`:

| Server wire (snake_case) | SDK `Protocol` (kebab-case) |
| --- | --- |
| `geoservices_feature_service` | `geoservices-feature-service` |
| `geoservices_map_service` | `geoservices-map-service` |
| `ogc_features` | `ogc-features` |
| `wms` | `wms` (custom MapLibre source `honua-wms`; `locator.typeName` → `layers`, `locator.styleId` → `styles`) |
| `wmts` | `wmts` (custom MapLibre source `honua-wmts`; `locator.typeName` / `locator.styleId` / `locator.tileMatrixSetId` → `layer` / `style` / `tileMatrixSet`) |
| `wfs` / `odata` | `wfs` / `odata` |
| `vector_tile` / `ogc_tiles` | MapLibre-native `vector` source (no SDK adapter) |
| `raster_tile` / `ogc_maps` | MapLibre-native `raster` source (no SDK adapter) |
| `workspace_artifact` | Deferred — throws `HonuaMapPackageError { stage: "source-bind" }` until a workspace resolver is wired. |

The `geoservices-image-service`, `geoservices-geometry-service`, and
`geoservices-gp-service` protocols are first-party at the contract
layer (`createDataset`, `Source.protocol()`) but are **not yet
translated by `source-bridge.ts`** — the runtime currently rejects a
`MapPackage` that ships an ImageServer / Geometry / GP binding because
those services are not typically composed as map sources. Direct
construction via `geoServicesImageSource(...)`,
`geoServicesGeometryServiceSource(...)`, or
`geoServicesGPServiceSource(...)` works without going through the
package projection. Routing them through `MapPackage.sourceBindings[]`
is tracked as a follow-on; until it lands the server should not emit
those protocols on bindings consumed by `loadMapPackage`.

Unknown fields on a `SourceBinding` are preserved on the
`HonuaMapPackage` round-trip so server additions do not break runtime
consumers. See [`maplibre-runtime.md`](./maplibre-runtime.md) for the
full runtime surface, `src/runtime/index.ts` for the module barrel, and
`test/runtime/runtime.test.ts` for the lifecycle contract (`load →
updatePackage → dispose`).
