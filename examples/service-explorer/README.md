# Universal GIS Service Explorer

This sample demonstrates a linked service/layer explorer using the Honua SDK app-workspace and linked-view abstractions.

The default app configuration targets cloud Honua:

- `VITE_HONUA_SERVICE_EXPLORER_BASE_URL=https://cloud.honua.io`
- `VITE_HONUA_SERVICE_EXPLORER_SERVICE_ID=natural-earth`
- `VITE_HONUA_SERVICE_EXPLORER_LAYER_ID=0`

When no API key or bearer token is configured and `VITE_HONUA_SERVICE_EXPLORER_MODE=auto`, the app loads a bundled fixture so the sample remains buildable and useful locally. The UI keeps the cloud target visible and surfaces the fixture lane as a degraded diagnostic.

The source picker demonstrates FeatureServer, MapServer, WFS, WMTS, OGC Maps, and OData lanes against the same Cloud Honua-oriented app shell. Queryable sources participate in the shared linked context. Render-only standards sources keep metadata, cache, capability, map, and diagnostics panels active while table/query controls are disabled.

## Run

```sh
npm run demo:service-explorer
```

To open a specific fixture source, pass `?source=<id>` in the URL. Useful source ids include `honolulu-civic-services:0`, `wfs-service-requests`, `wmts-basemap`, `ogc-maps-zoning`, and `odata-assets`.

## Validate

```sh
npm run demo:service-explorer:typecheck
npm run demo:service-explorer:build
npm test -- test/service-explorer-workspace.test.ts
npm run test:playwright:service-explorer
```

## Slice Coverage

- Service and layer discovery from cloud Honua or the local fixture catalog.
- Standards source picker for FeatureServer, MapServer, WFS, WMTS, OGC Maps, and OData.
- Schema, capabilities, extent, metadata cache status, and revalidate controls.
- Map, table, chart, filter, and detail panels synchronized through one `ExplorationContext`.
- Map extent publishes a debounced spatial filter that drives table and chart projections.
- Filters update the map layer filter, table rows, chart buckets, and query diagnostics.
- Shared selection drives map feature-state, table highlighting, and the detail panel.
- Unsupported/degraded states are represented as diagnostics and capability badges.

## Caching Notes

- Cache catalog, capabilities, schema/domain metadata, drawingInfo/style metadata, WFS capabilities, WMTS tile matrix metadata, OGC Maps collection/style metadata, and OData `$metadata` by source/config version.
- Treat viewport filters, ad hoc feature queries, MapServer export requests, WFS GetFeature requests, OData table queries, and explicit user refreshes as fresh requests unless a materialized result includes visible provenance.
- Realtime is not required for this source-picker sample; a selected source would need to advertise stream capability before live state can be treated as authoritative.
