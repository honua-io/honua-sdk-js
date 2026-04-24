# Changelog

All notable changes to the Honua JS SDK will be documented in this file.

## [0.0.2-alpha.0](https://github.com/honua-io/honua-sdk-js/compare/js-sdk-vv0.0.1-alpha.0...js-sdk-vv0.0.2-alpha.0) (2026-04-24)


### Features

* **#23:** canonical shared client and exploration semantics across GeoServices, OGC, WFS, WMS, OData adapters ([#30](https://github.com/honua-io/honua-sdk-js/issues/30)) ([6195277](https://github.com/honua-io/honua-sdk-js/commit/6195277f93d5c712b60a96a68a8153978bb9ce2d))
* add JS compatibility baseline ([#10](https://github.com/honua-io/honua-sdk-js/issues/10)) ([#13](https://github.com/honua-io/honua-sdk-js/issues/13)) ([404242d](https://github.com/honua-io/honua-sdk-js/commit/404242df3cbf10f707ee9137405bf93b3de0012d))
* add WebMap JSON compatibility contract and parser ([#385](https://github.com/honua-io/honua-sdk-js/issues/385)) ([3d03350](https://github.com/honua-io/honua-sdk-js/commit/3d03350198cf09090568f87853c65af3e457da4a))
* comprehensive JavaScript SDK enhancements for mobile integration ([094efb2](https://github.com/honua-io/honua-sdk-js/commit/094efb2831f6a3aa51479888138a0df576678e69)), closes [#359](https://github.com/honua-io/honua-sdk-js/issues/359)
* Demo Spike: Cesium 3D workflow and feasibility assessment ([#15](https://github.com/honua-io/honua-sdk-js/issues/15)) ([958f824](https://github.com/honua-io/honua-sdk-js/commit/958f8246fa7e6ad9408157d3f0cd684c047558f5))
* Demo: 2.5D web map with extrusions, tilt, and animated spatial storytelling ([#16](https://github.com/honua-io/honua-sdk-js/issues/16)) ([3f693d3](https://github.com/honua-io/honua-sdk-js/commit/3f693d3886c13cca771ecb708bdc5f9c5ebe971e))
* Demo: kepler.gl analytics app for ETL-to-insight workflows (#honua-sdk-js-14) ([edbd8a4](https://github.com/honua-io/honua-sdk-js/commit/edbd8a44a789a617d279d9466ba4d2fbc5b14374))
* JS SDK quickstart app and staging integration test suite (#honua-sdk-js-3) ([e2e20a9](https://github.com/honua-io/honua-sdk-js/commit/e2e20a9190337fe9398621a208572a34760685e1))
* MapLibre GL JS-first runtime for HonuaMapSpec and operator map packages ([#21](https://github.com/honua-io/honua-sdk-js/issues/21)) ([a9e161a](https://github.com/honua-io/honua-sdk-js/commit/a9e161aa2e37b7e6d446a56876a8389e53af390d))
* SDK publishing, geocoding client, and developer docs ([#7](https://github.com/honua-io/honua-sdk-js/issues/7)) ([9ceca23](https://github.com/honua-io/honua-sdk-js/commit/9ceca23c8eb59903846334eb7301044b27db66be))


### Bug Fixes

* align JS SDK publishing baseline ([b8d421d](https://github.com/honua-io/honua-sdk-js/commit/b8d421de74882f00e76285f0f8ea7d52d0a3afb3))
* **deps:** refresh mcp lockfile for security patches ([81cf79d](https://github.com/honua-io/honua-sdk-js/commit/81cf79d6119218b6daeb6c9b6cdf28f578989be9))
* harden client adapters and interceptor safety ([c357140](https://github.com/honua-io/honua-sdk-js/commit/c357140af183522d0ca5044e59b740e6d40a74c2))
* stabilize sdk coverage CI ([1a65335](https://github.com/honua-io/honua-sdk-js/commit/1a65335f0a99ddbcb5d7986a8b6c18613bc1d2d9))


### Documentation

* fix package scope in install and quickstart docs ([b2b2add](https://github.com/honua-io/honua-sdk-js/commit/b2b2add1d076c63f6c980abb1cf0ff454674c2f9))

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
