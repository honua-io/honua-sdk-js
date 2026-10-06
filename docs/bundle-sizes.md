<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-10-06 at commit `0991c847b`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 746.5 KiB | 829.3 KiB | 198.4 KiB | 211.8 KiB |
| `/honua` | 919.1 KiB | 1033.4 KiB | 245.9 KiB | 278.1 KiB |
| `/contract` | 374.5 KiB | 400.6 KiB | 101.2 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 878.9 KiB | 925.5 KiB | 196.3 KiB | 227.3 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.8 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 912.9 KiB | 961.8 KiB | 205.6 KiB | 237.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 68.4 KiB | 69.2 KiB | 20.6 KiB | 21.9 KiB |
| `/agent-tools` | 45.7 KiB | 48.1 KiB | 12.5 KiB | 13.3 KiB |
| `/agent-safety` | 68.9 KiB | 73.2 KiB | 19.0 KiB | 20.5 KiB |
| `/nl-map-control` | 87.7 KiB | 94.2 KiB | 25.5 KiB | 27.9 KiB |
| `/interactions/declarative` (ADR-0030 compiler over the existing binding primitives) | 14.3 KiB | 15.8 KiB | 5.0 KiB | 5.5 KiB |
| `/studio-agent` (SSE + MCP transports and the turn loop; bundles its agent-tools dependency) | 44.3 KiB | 46.9 KiB | 14.2 KiB | 15.0 KiB |
| `/runtime` | 691.5 KiB | 752.5 KiB | 177.3 KiB | 180.4 KiB |
| `/realtime` | 82.3 KiB | 86.2 KiB | 23.6 KiB | 25.0 KiB |
| `/offline` | 171.5 KiB | 186.2 KiB | 45.5 KiB | 49.7 KiB |
| `/query-planner` (worker runtime injected) | 767.4 KiB | 778.7 KiB | 173.9 KiB | 182.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 174.1 KiB | 183.6 KiB | 52.5 KiB | 55.8 KiB |
| `/client-compat` | 1076.9 KiB | 1139.7 KiB | 268.7 KiB | 309.5 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 35.0 KiB | 38.6 KiB | 10.7 KiB | 11.8 KiB |
| `/geocoding` | 32.7 KiB | 35.9 KiB | 9.2 KiB | 10.1 KiB |
| `/routing` | 26.1 KiB | 28.7 KiB | 7.8 KiB | 8.5 KiB |
| `/auth` | 28.2 KiB | 30.6 KiB | 7.7 KiB | 8.7 KiB |
| `/style` | 65.3 KiB | 69.0 KiB | 16.4 KiB | 17.2 KiB |
| `/map` | 193.5 KiB | 198.2 KiB | 54.9 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 147.2 KiB | 154.9 KiB | 44.0 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/pmtiles` (bounded direct inspection + managed lifecycle; renderer runtime excluded) | 320.3 KiB | 364.2 KiB | 85.1 KiB | 98.7 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 66.1 KiB | 68.3 KiB | 17.7 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1149.0 KiB | 1275.0 KiB | 299.0 KiB | 312.7 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1252.8 KiB | 1395.4 KiB | 330.1 KiB | 356.1 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 550.3 KiB | 562.6 KiB | 148.3 KiB | 150.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 532.8 KiB | 568.0 KiB | 145.2 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 746.8 KiB | 832.8 KiB | 198.6 KiB | 222.1 KiB |
| browser ESM (`./browser`) | 746.3 KiB | 828.5 KiB | 198.4 KiB | 221.7 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 226.6 KiB | 280.2 KiB | 57.1 KiB | 74.3 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 604.6 KiB | 695.1 KiB | 159.2 KiB | 186.7 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.4 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 16.6 KiB | 17.1 KiB | 4.4 KiB | 4.5 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 17.1 KiB | 18.5 KiB | 3.6 KiB | 3.9 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 706.8 KiB | 791.3 KiB | 188.2 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/client-compat`) | 250.8 KiB | 296.3 KiB | 63.4 KiB | 77.7 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 286.5 KiB | 316.3 KiB | 65.3 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 46.0 KiB | 49.4 KiB | 13.8 KiB | 14.0 KiB |
| tree-shake guard (`{ createHonuaPmtilesLifecycle }` from `/pmtiles`, generic discovery excluded) | 34.7 KiB | 35.1 KiB | 9.7 KiB | 10.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
