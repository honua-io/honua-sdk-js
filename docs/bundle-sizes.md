<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-11-11 at commit `95121af7e`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 758.8 KiB | 829.3 KiB | 202.7 KiB | 211.8 KiB |
| `/honua` | 933.7 KiB | 1033.4 KiB | 250.6 KiB | 278.1 KiB |
| `/contract` | 383.9 KiB | 400.6 KiB | 104.3 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 824.2 KiB | 859.4 KiB | 194.8 KiB | 195.3 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 188.2 KiB | 257.5 KiB | 26.2 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 858.1 KiB | 961.8 KiB | 204.2 KiB | 237.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 68.4 KiB | 69.2 KiB | 20.7 KiB | 21.9 KiB |
| `/agent-tools` | 46.0 KiB | 48.1 KiB | 12.7 KiB | 13.3 KiB |
| `/agent-safety` | 69.1 KiB | 73.2 KiB | 19.1 KiB | 20.5 KiB |
| `/nl-map-control` | 92.5 KiB | 94.2 KiB | 27.3 KiB | 27.9 KiB |
| `/interactions/declarative` (ADR-0030 compiler over the existing binding primitives) | 14.3 KiB | 15.8 KiB | 5.0 KiB | 5.5 KiB |
| `/studio-agent` (SSE + MCP transports and the turn loop; bundles its agent-tools dependency) | 58.9 KiB | 64.1 KiB | 19.1 KiB | 20.8 KiB |
| `/runtime` | 717.5 KiB | 752.5 KiB | 184.7 KiB | 198.6 KiB |
| `/realtime` | 82.3 KiB | 86.2 KiB | 23.6 KiB | 25.0 KiB |
| `/offline` | 171.5 KiB | 186.2 KiB | 45.6 KiB | 49.7 KiB |
| `/query-planner` (worker runtime injected) | 706.8 KiB | 778.7 KiB | 170.8 KiB | 182.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 174.1 KiB | 183.6 KiB | 52.5 KiB | 55.8 KiB |
| `/client-compat` | 1076.8 KiB | 1139.7 KiB | 270.7 KiB | 309.5 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 35.0 KiB | 38.6 KiB | 10.7 KiB | 11.8 KiB |
| `/geocoding` | 33.0 KiB | 35.9 KiB | 9.3 KiB | 10.1 KiB |
| `/routing` | 28.7 KiB | 28.7 KiB | 8.6 KiB | 9.5 KiB |
| `/auth` | 28.2 KiB | 30.6 KiB | 7.7 KiB | 8.7 KiB |
| `/style` | 65.2 KiB | 69.0 KiB | 16.4 KiB | 17.2 KiB |
| `/map` | 196.7 KiB | 198.2 KiB | 55.9 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 147.6 KiB | 154.9 KiB | 44.2 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/pmtiles` (bounded direct inspection + managed lifecycle; renderer runtime excluded) | 326.2 KiB | 364.2 KiB | 87.2 KiB | 98.7 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 70.1 KiB | 77.7 KiB | 19.1 KiB | 21.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1205.4 KiB | 1275.0 KiB | 316.4 KiB | 344.5 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1315.1 KiB | 1395.4 KiB | 349.7 KiB | 356.1 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.5 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 41.7 KiB | 45.5 KiB | 13.0 KiB | 13.9 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 14.6 KiB | 16.0 KiB | 5.4 KiB | 5.7 KiB |
| `/react` (react/react-dom external) | 563.2 KiB | 619.8 KiB | 152.5 KiB | 165.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 519.6 KiB | 568.0 KiB | 143.4 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 759.1 KiB | 832.8 KiB | 202.8 KiB | 222.1 KiB |
| browser ESM (`./browser`) | 758.6 KiB | 828.5 KiB | 202.6 KiB | 221.7 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 232.7 KiB | 280.2 KiB | 59.2 KiB | 74.3 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 616.2 KiB | 695.1 KiB | 163.1 KiB | 186.7 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.2 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 16.7 KiB | 17.1 KiB | 4.4 KiB | 4.5 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 17.1 KiB | 18.5 KiB | 3.6 KiB | 3.9 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 718.4 KiB | 791.3 KiB | 192.1 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/client-compat`) | 256.8 KiB | 296.3 KiB | 65.5 KiB | 77.7 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 286.0 KiB | 316.3 KiB | 65.2 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 49.2 KiB | 54.4 KiB | 15.0 KiB | 16.4 KiB |
| tree-shake guard (`{ createHonuaPmtilesLifecycle }` from `/pmtiles`, generic discovery excluded) | 34.8 KiB | 35.1 KiB | 9.7 KiB | 10.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.4 KiB | 3.8 KiB | 1.5 KiB | 1.7 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 33.0 KiB | 35.9 KiB | 10.6 KiB | 11.3 KiB |
