<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-19 at commit `b670eda7`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 612.4 KiB | 661.1 KiB | 162.4 KiB | 168.9 KiB |
| `/honua` | 779.1 KiB | 849.0 KiB | 207.8 KiB | 226.0 KiB |
| `/contract` | 288.3 KiB | 317.1 KiB | 76.4 KiB | 83.7 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 761.3 KiB | 829.5 KiB | 164.7 KiB | 179.5 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.0 KiB | 257.5 KiB | 31.3 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 794.4 KiB | 865.8 KiB | 173.4 KiB | 189.2 KiB |
| `/plugin` (registry + certification, no heavy peers) | 54.7 KiB | 62.6 KiB | 16.8 KiB | 19.3 KiB |
| `/agent-tools` | 34.7 KiB | 38.2 KiB | 9.9 KiB | 10.9 KiB |
| `/agent-safety` | 66.5 KiB | 73.2 KiB | 18.6 KiB | 20.5 KiB |
| `/nl-map-control` | 76.3 KiB | 84.5 KiB | 22.7 KiB | 25.3 KiB |
| `/runtime` | 532.4 KiB | 550.7 KiB | 143.1 KiB | 147.5 KiB |
| `/realtime` | 61.2 KiB | 67.3 KiB | 17.8 KiB | 19.5 KiB |
| `/offline` | 38.1 KiB | 44.3 KiB | 11.3 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 581.1 KiB | 638.9 KiB | 118.2 KiB | 129.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 94.2 KiB | 100.0 KiB | 29.0 KiB | 30.8 KiB |
| `/esri-compat` | 984.7 KiB | 1026.2 KiB | 245.5 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 26.6 KiB | 31.6 KiB | 7.6 KiB | 9.1 KiB |
| `/routing` | 20.2 KiB | 24.6 KiB | 6.2 KiB | 7.6 KiB |
| `/auth` | 25.6 KiB | 30.6 KiB | 7.3 KiB | 8.7 KiB |
| `/style` | 60.6 KiB | 69.0 KiB | 14.9 KiB | 17.2 KiB |
| `/map` | 176.4 KiB | 182.2 KiB | 49.6 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 76.8 KiB | 81.6 KiB | 23.7 KiB | 25.3 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 47.7 KiB | 52.1 KiB | 13.9 KiB | 15.2 KiB |
| `/react` (react/react-dom external) | 462.1 KiB | 506.7 KiB | 122.6 KiB | 134.6 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 613.0 KiB | 661.8 KiB | 162.7 KiB | 176.3 KiB |
| browser ESM (`./browser`) | 611.7 KiB | 660.4 KiB | 162.4 KiB | 176.0 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 217.3 KiB | 229.7 KiB | 55.5 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 475.5 KiB | 515.1 KiB | 124.3 KiB | 135.1 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 14.1 KiB | 15.5 KiB | 4.0 KiB | 4.1 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 13.2 KiB | 14.6 KiB | 2.8 KiB | 3.1 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 579.5 KiB | 627.9 KiB | 153.7 KiB | 167.0 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 231.8 KiB | 245.9 KiB | 58.8 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 42.2 KiB | 44.7 KiB | 13.0 KiB | 14.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
