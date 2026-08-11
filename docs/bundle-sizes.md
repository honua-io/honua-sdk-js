<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-08-11 at commit `8e40873f`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 752.1 KiB | 753.9 KiB | 201.9 KiB | 211.8 KiB |
| `/honua` | 914.8 KiB | 937.2 KiB | 246.2 KiB | 251.0 KiB |
| `/contract` | 366.6 KiB | 400.6 KiB | 98.8 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 888.0 KiB | 925.5 KiB | 200.5 KiB | 206.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.8 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 922.0 KiB | 961.8 KiB | 209.8 KiB | 215.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 66.0 KiB | 69.2 KiB | 20.0 KiB | 21.9 KiB |
| `/agent-tools` | 35.7 KiB | 38.2 KiB | 10.1 KiB | 10.9 KiB |
| `/agent-safety` | 67.5 KiB | 73.2 KiB | 18.8 KiB | 20.5 KiB |
| `/nl-map-control` | 77.4 KiB | 84.5 KiB | 22.9 KiB | 25.3 KiB |
| `/runtime` | 605.8 KiB | 612.2 KiB | 163.8 KiB | 163.9 KiB |
| `/realtime` | 79.3 KiB | 86.2 KiB | 22.9 KiB | 25.0 KiB |
| `/offline` | 169.9 KiB | 186.2 KiB | 45.3 KiB | 49.7 KiB |
| `/query-planner` (worker runtime injected) | 764.8 KiB | 778.7 KiB | 173.3 KiB | 182.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 167.5 KiB | 183.6 KiB | 50.9 KiB | 55.8 KiB |
| `/esri-compat` | 1020.6 KiB | 1026.2 KiB | 255.6 KiB | 280.9 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 27.5 KiB | 31.6 KiB | 7.7 KiB | 9.1 KiB |
| `/routing` | 21.1 KiB | 24.6 KiB | 6.4 KiB | 7.6 KiB |
| `/auth` | 26.6 KiB | 30.6 KiB | 7.4 KiB | 8.7 KiB |
| `/style` | 63.4 KiB | 69.0 KiB | 16.0 KiB | 17.2 KiB |
| `/map` | 181.6 KiB | 198.2 KiB | 51.4 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 145.6 KiB | 154.9 KiB | 43.8 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 66.1 KiB | 68.3 KiB | 17.7 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1011.8 KiB | 1037.6 KiB | 271.8 KiB | 277.9 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1088.5 KiB | 1120.1 KiB | 295.2 KiB | 321.9 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 541.7 KiB | 562.6 KiB | 145.7 KiB | 150.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 752.7 KiB | 754.5 KiB | 202.2 KiB | 222.1 KiB |
| browser ESM (`./browser`) | 751.4 KiB | 753.1 KiB | 201.9 KiB | 221.7 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 239.2 KiB | 254.0 KiB | 61.8 KiB | 63.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 613.7 KiB | 627.9 KiB | 163.6 KiB | 166.9 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.4 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 15.0 KiB | 15.5 KiB | 4.2 KiB | 4.5 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 14.8 KiB | 16.3 KiB | 3.2 KiB | 3.5 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 715.9 KiB | 717.1 KiB | 192.5 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 253.8 KiB | 267.0 KiB | 65.0 KiB | 68.1 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 44.4 KiB | 44.7 KiB | 13.5 KiB | 14.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
