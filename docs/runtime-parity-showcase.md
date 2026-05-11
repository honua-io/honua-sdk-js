# Runtime Parity Showcase

The runtime parity showcase lives in `examples/runtime-parity-showcase`. It is an app-first SDK demo for issue #167, not a landing page.

## Architecture

The app starts by fetching a hosted fixture `MapPackage` with `fetchMapPackage`, preserving the SDK cache state returned by the runtime fetch helper. It validates the package style with runtime style diagnostics, loads it into MapLibre with `loadMapPackage`, and then creates a `HonuaController` over the resulting runtime.

The controller is the application state owner for viewport, selection, layer visibility, and shareable state. Honua web components are bound with `createHonuaWebComponentControllerFromRuntime`, so the layer list, legend, search, feature table, chart, and component map surface read from the same runtime package and fixture features.

Widget metrics use `createWidgetSource` over the deterministic incident fixture source. Status filters and viewport changes flow through `selectLinkedViewQueryProjection`, so widget count/category/range models refresh from the same linked-view state used by the table and map filters.

## Extension Points

- Replace `fixtures/map-package.json` with a hosted package response from Honua Server.
- Replace `createFixtureWidgetSource` with a real `Source` adapter when a server-backed feature source is available.
- Add more widget models by calling `count`, `categories`, `histogram`, `range`, or `topValues` on the widget source.
- Use the share-state input as a bookmarkable query string for linked filters, selection, viewport, and hidden layer state.

## Validation

The focused smoke test is `test/playwright/runtime-parity-showcase.spec.mjs`. It loads the mock server, waits for package/map/surface readiness, refreshes widgets, selects a feature, applies a filter, and toggles a runtime layer.
