<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-08-04 at commit `d72050b3`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 747.5 KiB | 753.9 KiB | 200.8 KiB | 211.8 KiB |
| `/honua` | 910.2 KiB | 937.2 KiB | 245.1 KiB | 251.0 KiB |
| `/contract` | 366.0 KiB | 400.6 KiB | 98.7 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 887.2 KiB | 925.5 KiB | 200.0 KiB | 206.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.7 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 921.2 KiB | 961.8 KiB | 209.6 KiB | 215.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 65.4 KiB | 69.2 KiB | 19.9 KiB | 21.9 KiB |
| `/agent-tools` | 35.1 KiB | 38.2 KiB | 10.0 KiB | 10.9 KiB |
| `/agent-safety` | 66.9 KiB | 73.2 KiB | 18.7 KiB | 20.5 KiB |
| `/nl-map-control` | 76.8 KiB | 84.5 KiB | 22.8 KiB | 25.3 KiB |
| `/runtime` | 605.2 KiB | 612.2 KiB | 163.7 KiB | 163.9 KiB |
| `/realtime` | 78.4 KiB | 86.2 KiB | 22.7 KiB | 25.0 KiB |
| `/offline` | 138.7 KiB | 144.9 KiB | 37.8 KiB | 39.2 KiB |
| `/query-planner` (worker runtime injected) | 710.8 KiB | 780.1 KiB | 157.5 KiB | 162.6 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 125.6 KiB | 138.2 KiB | 38.2 KiB | 42.0 KiB |
| `/esri-compat` | 1020.0 KiB | 1026.2 KiB | 255.5 KiB | 280.9 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 26.9 KiB | 31.6 KiB | 7.6 KiB | 9.1 KiB |
| `/routing` | 20.6 KiB | 24.6 KiB | 6.3 KiB | 7.6 KiB |
| `/auth` | 26.0 KiB | 30.6 KiB | 7.3 KiB | 8.7 KiB |
| `/style` | 62.8 KiB | 69.0 KiB | 15.9 KiB | 17.2 KiB |
| `/map` | 181.1 KiB | 198.2 KiB | 51.3 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 140.0 KiB | 154.9 KiB | 42.2 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 65.3 KiB | 68.3 KiB | 17.4 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1011.1 KiB | 1037.6 KiB | 271.7 KiB | 277.9 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1087.8 KiB | 1120.1 KiB | 295.1 KiB | 321.9 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 541.1 KiB | 562.6 KiB | 145.6 KiB | 150.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 748.1 KiB | 754.5 KiB | 201.1 KiB | 201.3 KiB |
| browser ESM (`./browser`) | 746.8 KiB | 753.1 KiB | 200.7 KiB | 201.0 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 238.6 KiB | 254.0 KiB | 61.7 KiB | 63.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 612.9 KiB | 627.9 KiB | 163.4 KiB | 166.9 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 14.5 KiB | 15.5 KiB | 4.1 KiB | 4.1 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 13.9 KiB | 14.6 KiB | 3.0 KiB | 3.1 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 712.2 KiB | 717.1 KiB | 191.5 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 253.2 KiB | 267.0 KiB | 64.9 KiB | 68.1 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 43.8 KiB | 44.7 KiB | 13.4 KiB | 14.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
