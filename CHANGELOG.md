# Changelog

All notable changes to the Honua JS SDK will be documented in this file.

## [0.0.1-alpha.0] - Unreleased

### Added

- Canonical shared client contract at `@honua/sdk-js/contract`: `Dataset`, `Source`, `SourceDescriptor`,
  `Capabilities`, `Query`, `Result`, and `MapBinding` types plus `createDataset(...)` with built-in adapters
  for `geoservices-feature-service`, `geoservices-map-service`, and `ogc-features`; WFS / WMS / OData plug
  in through `CreateDatasetOptions.resolveSource`. Capability policy defaults to `strict` (missing
  capabilities throw `HonuaCapabilityNotSupportedError`); `degraded` opts into client-side fallbacks that
  surface `Result.degraded[]`.
- Exploration state module at `@honua/sdk-js/exploration`: `createExplorationContext(...)` with a
  microtask-coalesced reducer over filters, spatial filter, extent, selection, sort, pagination, visible
  fields, grouping, and aggregation; five linked-view presets (`globalLinked`, `mapDriven`, `gridDriven`,
  `chartDriven`, `decoupled`); view bindings for `map`, `grid`, `chart`, `form`, and `custom`; snapshot
  restore; `HonuaExplorationContextError` for disposed / duplicate-binding / incompatible-snapshot states.
- MapLibre GL JS runtime at `@honua/sdk-js/runtime`: `loadMapPackage(...)` and `HonuaMapRuntime` bind a
  server-produced `MapPackage` (format `honua_map_package.v1`) to a caller-provided `maplibre-gl.Map`.
  Projects `sourceBindings[]` through the shared contract adapters (MapLibre-native `vector_tile` /
  `raster_tile` / `ogc_tiles` / `ogc_maps` flow straight into the composed style; `workspace_artifact` is
  deferred), composes the style from `mapSpec` + `styleRefs[]` + `{theme:key}` token substitution,
  surfaces a stable operational API (`setLayerVisibility`, `bindPopup`, `setViewState`, `updatePackage`,
  `on`, `dispose`) with lifecycle events (`package-loaded`, `source-ready`, `source-error`,
  `package-updated`, `disposed`), diff-based incremental updates that avoid full `setStyle` on
  theme-only / single-layer changes, and a `HonuaMapPackageError` discriminated by
  `stage: "load" | "update" | "style-compose" | "source-bind" | "view" | "popup" | "dispose"`.
  `maplibre-gl` stays a peer dependency (duck-typed `MaplibreMap` interface).
- Contract docs: `docs/shared-client-contract.md`, `docs/exploration-context.md`,
  `docs/protocol-capability-matrix.md`, `docs/source-binding-alignment.md`, and
  `docs/maplibre-runtime.md`.
- Core HTTP client (`HonuaClient`) with FeatureServer, MapServer, and OGC API Features support
- Fluent layer wrappers (`featureLayer()`, `mapLayer()`, `mapService()`, `ogcFeatures()`)
- Typed response models for all query, edit, metadata, and OGC endpoints
- Schema-aware typed collections via `HonuaFeatureLayer<T>` generic parameter
- Expression engine with 65 operators including spatial (`distance`, `within`, `intersects`)
- PBF binary transport with transparent JSON fallback (`preferBinary` option)
- gRPC-Web transport via Connect protocol (`transport: "grpc-web"`)
- Request interceptor pipeline (`before`/`after`/`error` hooks)
- Retry with exponential backoff for transient failures
- `HonuaMap` for source/layer separation with MapLibre GL JS
- Feature-state interaction helpers (`createHoverHandler`, `createSelectionHandler`)
- Esri compatibility layer for migration (`FeatureLayerCompat`, `MapImageLayerCompat`, etc.)
- Migration tooling: scanner, codemod, reconciliation, parity matrices
- Split-package publishing (`@honua/sdk`, `@honua/sdk-esri-compat`, `@honua/migrate`)
- Biome linter and formatter configuration
