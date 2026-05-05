# Universal GIS Service Explorer

This sample demonstrates a linked service/layer explorer using the Honua SDK app-workspace and linked-view abstractions.

The default app configuration targets cloud Honua:

- `VITE_HONUA_SERVICE_EXPLORER_BASE_URL=https://cloud.honua.io`
- `VITE_HONUA_SERVICE_EXPLORER_SERVICE_ID=natural-earth`
- `VITE_HONUA_SERVICE_EXPLORER_LAYER_ID=0`

When no API key or bearer token is configured and `VITE_HONUA_SERVICE_EXPLORER_MODE=auto`, the app loads a bundled fixture so the sample remains buildable and useful locally. The UI keeps the cloud target visible and surfaces the fixture lane as a degraded diagnostic.

## Run

```sh
npm run demo:service-explorer
```

## Validate

```sh
npm run demo:service-explorer:typecheck
npm run demo:service-explorer:build
npm test -- test/service-explorer-workspace.test.ts
```

## Slice Coverage

- Service and layer discovery from cloud Honua or the local fixture catalog.
- Schema, capabilities, extent, metadata cache status, and revalidate controls.
- Map, table, chart, filter, and detail panels synchronized through one `ExplorationContext`.
- Map extent publishes a debounced spatial filter that drives table and chart projections.
- Filters update the map layer filter, table rows, chart buckets, and query diagnostics.
- Shared selection drives map feature-state, table highlighting, and the detail panel.
- Unsupported/degraded states are represented as diagnostics and capability badges.
