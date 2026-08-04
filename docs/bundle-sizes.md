<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-08-04 at commit `3897bff4`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 716.2 KiB | 753.9 KiB | 192.6 KiB | 211.8 KiB |
| `/honua` | 880.7 KiB | 937.2 KiB | 237.3 KiB | 251.0 KiB |
| `/contract` | 344.9 KiB | 352.8 KiB | 92.9 KiB | 94.1 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 860.2 KiB | 925.5 KiB | 192.8 KiB | 206.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.7 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 893.4 KiB | 961.8 KiB | 202.3 KiB | 215.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 65.3 KiB | 69.2 KiB | 19.9 KiB | 21.9 KiB |
| `/agent-tools` | 35.0 KiB | 38.2 KiB | 10.0 KiB | 10.9 KiB |
| `/agent-safety` | 66.8 KiB | 73.2 KiB | 18.7 KiB | 20.5 KiB |
| `/nl-map-control` | 76.7 KiB | 84.5 KiB | 22.8 KiB | 25.3 KiB |
| `/runtime` | 580.9 KiB | 612.2 KiB | 156.6 KiB | 163.9 KiB |
| `/realtime` | 68.7 KiB | 75.5 KiB | 19.7 KiB | 21.7 KiB |
| `/offline` | 96.4 KiB | 106.1 KiB | 26.9 KiB | 29.5 KiB |
| `/query-planner` (worker runtime injected) | 643.1 KiB | 703.3 KiB | 137.8 KiB | 143.2 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 116.5 KiB | 122.9 KiB | 35.6 KiB | 37.7 KiB |
| `/esri-compat` | 999.2 KiB | 1026.2 KiB | 250.0 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 26.9 KiB | 31.6 KiB | 7.6 KiB | 9.1 KiB |
| `/routing` | 20.5 KiB | 24.6 KiB | 6.3 KiB | 7.6 KiB |
| `/auth` | 25.9 KiB | 30.6 KiB | 7.3 KiB | 8.7 KiB |
| `/style` | 62.8 KiB | 69.0 KiB | 15.9 KiB | 17.2 KiB |
| `/map` | 180.6 KiB | 198.2 KiB | 51.2 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 132.7 KiB | 137.8 KiB | 40.1 KiB | 40.9 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 65.2 KiB | 68.3 KiB | 17.4 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 959.0 KiB | 1037.6 KiB | 257.7 KiB | 277.9 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1035.4 KiB | 1120.1 KiB | 281.0 KiB | 292.6 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 518.1 KiB | 562.6 KiB | 138.9 KiB | 150.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 716.8 KiB | 754.5 KiB | 192.8 KiB | 201.3 KiB |
| browser ESM (`./browser`) | 715.5 KiB | 753.1 KiB | 192.5 KiB | 201.0 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 230.9 KiB | 254.0 KiB | 59.6 KiB | 63.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 585.9 KiB | 627.9 KiB | 156.4 KiB | 166.9 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 14.4 KiB | 15.5 KiB | 4.1 KiB | 4.1 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 13.8 KiB | 14.6 KiB | 3.0 KiB | 3.1 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 682.8 KiB | 717.1 KiB | 183.7 KiB | 191.3 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 245.5 KiB | 267.0 KiB | 62.9 KiB | 68.1 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 43.6 KiB | 44.7 KiB | 13.3 KiB | 14.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
