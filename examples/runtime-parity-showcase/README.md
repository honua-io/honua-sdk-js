# Runtime Parity Showcase

This example composes the current SDK application runtime pieces in one deterministic app:

- `fetchMapPackage` loads a hosted fixture `MapPackage` from the local mock server.
- `loadMapPackage` binds the fetched package to a MapLibre map.
- `HonuaController` owns viewport, selection, layer visibility, and snapshot state.
- Honua web components render the layer list, legend, search, feature table, chart, and component map surface.
- `createWidgetSource` evaluates count, category, and range widgets against linked-view projection state.

Run the deterministic local server:

```sh
npm run demo:runtime-parity:mock
```

The server prints a URL after building the example. It serves the Vite bundle, `/api/v1/map-packages/runtime-parity-showcase`, fixture features, and a tiny deterministic raster tile lane.

Useful checks:

```sh
npm run demo:runtime-parity:typecheck
npm run demo:runtime-parity:build
npm run test:playwright:runtime-parity
```
