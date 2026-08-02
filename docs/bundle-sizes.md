<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-08-02 at commit `3a844725`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 697.3 KiB | 753.9 KiB | 186.3 KiB | 191.4 KiB |
| `/honua` | 864.0 KiB | 937.2 KiB | 231.8 KiB | 251.0 KiB |
| `/contract` | 326.0 KiB | 352.8 KiB | 86.8 KiB | 94.1 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 844.7 KiB | 925.5 KiB | 187.7 KiB | 206.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.7 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 878.0 KiB | 961.8 KiB | 197.0 KiB | 215.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 65.3 KiB | 69.2 KiB | 19.9 KiB | 21.9 KiB |
| `/agent-tools` | 35.0 KiB | 38.2 KiB | 10.0 KiB | 10.9 KiB |
| `/agent-safety` | 66.8 KiB | 73.2 KiB | 18.7 KiB | 20.5 KiB |
| `/nl-map-control` | 76.7 KiB | 84.5 KiB | 22.8 KiB | 25.3 KiB |
| `/runtime` | 562.1 KiB | 612.2 KiB | 150.4 KiB | 163.9 KiB |
| `/realtime` | 68.7 KiB | 75.5 KiB | 19.7 KiB | 21.7 KiB |
| `/offline` | 83.6 KiB | 91.9 KiB | 23.2 KiB | 25.5 KiB |
| `/query-planner` (worker runtime injected) | 639.4 KiB | 703.3 KiB | 136.4 KiB | 143.2 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 111.6 KiB | 112.3 KiB | 34.2 KiB | 34.3 KiB |
| `/esri-compat` | 992.9 KiB | 1026.2 KiB | 247.8 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 26.9 KiB | 31.6 KiB | 7.6 KiB | 9.1 KiB |
| `/routing` | 20.5 KiB | 24.6 KiB | 6.3 KiB | 7.6 KiB |
| `/auth` | 25.9 KiB | 30.6 KiB | 7.3 KiB | 8.7 KiB |
| `/style` | 61.4 KiB | 69.0 KiB | 15.3 KiB | 17.2 KiB |
| `/map` | 179.2 KiB | 182.2 KiB | 50.6 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 129.3 KiB | 137.8 KiB | 38.9 KiB | 40.9 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 65.2 KiB | 68.3 KiB | 17.4 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 945.3 KiB | 1037.6 KiB | 253.3 KiB | 277.9 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1021.7 KiB | 1120.1 KiB | 276.8 KiB | 292.6 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 499.3 KiB | 506.7 KiB | 132.7 KiB | 134.6 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 697.9 KiB | 754.5 KiB | 186.6 KiB | 201.3 KiB |
| browser ESM (`./browser`) | 696.6 KiB | 753.1 KiB | 186.3 KiB | 201.0 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 225.4 KiB | 229.7 KiB | 57.8 KiB | 63.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 570.5 KiB | 627.9 KiB | 151.7 KiB | 166.9 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 14.4 KiB | 15.5 KiB | 4.1 KiB | 4.1 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 13.8 KiB | 14.6 KiB | 3.0 KiB | 3.1 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 663.8 KiB | 717.1 KiB | 177.4 KiB | 191.3 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 240.0 KiB | 245.9 KiB | 61.1 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 43.6 KiB | 44.7 KiB | 13.3 KiB | 14.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
