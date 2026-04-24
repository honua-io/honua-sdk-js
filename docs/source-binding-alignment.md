# SourceDescriptor ↔ Server SourceBinding Alignment

This document keeps the SDK's `SourceDescriptor` shape in lockstep with
the server's `SourceBinding` document (defined in
`/honua-server/docs/developer/AI_OPERATOR_CONTRACT.md`). Both shapes are
intended to round-trip: an SDK `SourceDescriptor` exports cleanly to a
server `SourceBinding`, and a `SourceBinding` re-imported through
`createDataset` produces an equivalent `SourceDescriptor`.

## Field map

| `SourceDescriptor` (SDK) | `SourceBinding` (server) | Notes |
| --- | --- | --- |
| `id` | `id` | Stable identifier; preserved verbatim. |
| `protocol` | `protocol` | Same enum; the SDK's MapLibre-native protocols (`maplibre-vector`, `maplibre-raster`, `maplibre-geojson`) project onto the server's `mapSpec.sources` stanza rather than `sourceBindings`. |
| `locator.url` | `locator.url` | Fully qualified endpoint URL. |
| `locator.serviceId` | `locator.serviceId` | GeoServices Feature/Map Service identifier. |
| `locator.layerId` | `locator.layerId` | Numeric layer identifier within the service. |
| `locator.collectionId` | `locator.collectionId` | OGC API Features collection. |
| `locator.typeName` | `locator.typeName` | WFS / WMS type-name. |
| `locator.entitySet` | `locator.entitySet` | OData entity set. |
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

- `Source.adapter()` — the typed escape hatch. Exists only on the SDK
  side. The exporter emits the descriptor, not the live adapter instance.
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
| `wfs` / `wms` / `odata` | `wfs` / `wms` / `odata` |
| `vector_tile` / `ogc_tiles` | MapLibre-native `vector` source (no SDK adapter) |
| `raster_tile` / `ogc_maps` | MapLibre-native `raster` source (no SDK adapter) |
| `workspace_artifact` | Deferred — throws `HonuaMapPackageError { stage: "source-bind" }` until a workspace resolver is wired. |

Unknown fields on a `SourceBinding` are preserved on the
`HonuaMapPackage` round-trip so server additions do not break runtime
consumers. See [`maplibre-runtime.md`](./maplibre-runtime.md) for the
full runtime surface, `src/runtime/index.ts` for the module barrel, and
`test/runtime/runtime.test.ts` for the lifecycle contract (`load →
updatePackage → dispose`).
