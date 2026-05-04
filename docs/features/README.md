# Honua JS SDK Feature Map

This repository owns the JavaScript/TypeScript SDK, browser runtime helpers, migration tooling, examples, and MCP server package.

## Current Capabilities

- Honua-first `HonuaClient` for GeoServices FeatureServer/MapServer, catalog operations, request/auth interceptors, and compatibility checks.
- Protocol-neutral Dataset/Source/Query/Result contract with built-in adapters for GeoServices, OGC API Features/Tiles/Maps/Processes, STAC, WMS, WMTS, WFS, and OData.
- OGC client wrappers for Features, Tiles, Maps, Processes, STAC, WMS, WMTS, WFS, and OData.
- MapLibre runtime helpers for `MapPackage`, source/layer style validation, WMS/WMTS source specs, web-map conversion, and warning contracts.
- Esri compatibility layer for migration-critical layers, views, widgets, controls, routing helpers, search, popup, time slider, measurement, editor/sketch, graphics, groups, web maps, and basic scene-view compatibility.
- Migration tooling for ArcGIS usage scanning, safe codemods, parity matrices, fixture metrics, content export/import/reconcile, URL rewriting, service reconciliation, and migration demo reports.
- Example apps for MapLibre quickstart, 2.5D storytelling, kepler analytics, and an exploratory Cesium route-playback spike.
- MCP server package with tools and resources for service listing, layer description, extent, counts, feature queries, and statistics.

## Source Evidence

- SDK source: `src/`
- MCP package: `mcp/src/`
- Examples: `examples/`, `docs/examples/`
- Protocol and compatibility docs: `docs/protocol-capability-matrix.md`, `docs/sdk-surface-alignment.md`, `docs/webmap-json-compatibility.md`

## 3D Status

The SDK has `SceneViewCompat`, 2.5D MapLibre examples, WebMap conversion warnings for unsupported 3D properties, and a Cesium route-playback spike. Full 3D scene workspace interop across Cesium, map, table, and detail views is still tracked as backlog.
