<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-11-14 at commit `4ee1e2fca`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 763.1 KiB | 829.3 KiB | 204.3 KiB | 211.8 KiB |
| `/honua` | 938.0 KiB | 1033.4 KiB | 252.3 KiB | 278.1 KiB |
| `/contract` | 386.4 KiB | 400.6 KiB | 105.1 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 833.4 KiB | 859.4 KiB | 198.2 KiB | 218.1 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 188.2 KiB | 257.5 KiB | 26.2 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 867.4 KiB | 961.8 KiB | 207.4 KiB | 237.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 68.7 KiB | 69.2 KiB | 20.7 KiB | 21.9 KiB |
| `/agent-tools` | 46.3 KiB | 48.1 KiB | 12.7 KiB | 13.3 KiB |
| `/agent-safety` | 69.4 KiB | 73.2 KiB | 19.1 KiB | 20.5 KiB |
| `/nl-map-control` | 92.8 KiB | 94.2 KiB | 27.3 KiB | 27.9 KiB |
| `/interactions/declarative` (ADR-0030 compiler over the existing binding primitives) | 14.3 KiB | 15.8 KiB | 5.0 KiB | 5.5 KiB |
| `/studio-agent` (SSE + MCP transports and the turn loop; bundles its agent-tools dependency) | 58.9 KiB | 64.1 KiB | 19.1 KiB | 20.8 KiB |
| `/runtime` | 718.9 KiB | 752.5 KiB | 185.1 KiB | 198.6 KiB |
| `/realtime` | 82.6 KiB | 86.2 KiB | 23.7 KiB | 25.0 KiB |
| `/offline` | 171.8 KiB | 186.2 KiB | 45.6 KiB | 49.7 KiB |
| `/query-planner` (worker runtime injected) | 707.1 KiB | 778.7 KiB | 170.8 KiB | 182.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 174.4 KiB | 183.6 KiB | 52.6 KiB | 55.8 KiB |
| `/client-compat` | 1078.7 KiB | 1139.7 KiB | 271.5 KiB | 309.5 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 35.0 KiB | 38.6 KiB | 10.7 KiB | 11.8 KiB |
| `/geocoding` | 33.3 KiB | 35.9 KiB | 9.4 KiB | 10.1 KiB |
| `/routing` | 29.0 KiB | 31.8 KiB | 8.7 KiB | 9.5 KiB |
| `/auth` | 28.5 KiB | 30.6 KiB | 7.8 KiB | 8.7 KiB |
| `/style` | 67.2 KiB | 69.0 KiB | 17.0 KiB | 17.2 KiB |
| `/map` | 197.5 KiB | 198.2 KiB | 56.1 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 148.2 KiB | 154.9 KiB | 44.3 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.9 KiB | 16.1 KiB |
| `/pmtiles` (bounded direct inspection + managed lifecycle; renderer runtime excluded) | 328.8 KiB | 364.2 KiB | 87.8 KiB | 98.7 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 70.1 KiB | 77.7 KiB | 19.1 KiB | 21.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1216.2 KiB | 1275.0 KiB | 320.0 KiB | 344.5 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1325.9 KiB | 1395.4 KiB | 353.2 KiB | 356.1 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.5 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 41.7 KiB | 45.5 KiB | 13.0 KiB | 13.9 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 14.6 KiB | 16.0 KiB | 5.4 KiB | 5.7 KiB |
| `/react` (react/react-dom external) | 563.9 KiB | 619.8 KiB | 152.7 KiB | 165.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 519.6 KiB | 568.0 KiB | 143.4 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 763.3 KiB | 832.8 KiB | 204.5 KiB | 222.1 KiB |
| browser ESM (`./browser`) | 762.9 KiB | 828.5 KiB | 204.3 KiB | 221.7 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 234.6 KiB | 280.2 KiB | 59.7 KiB | 74.3 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 619.9 KiB | 695.1 KiB | 164.7 KiB | 186.7 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.2 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 17.0 KiB | 17.1 KiB | 4.5 KiB | 4.5 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 17.7 KiB | 18.5 KiB | 3.7 KiB | 3.9 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 722.1 KiB | 791.3 KiB | 193.6 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/client-compat`) | 258.7 KiB | 296.3 KiB | 66.3 KiB | 77.7 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 286.0 KiB | 316.3 KiB | 65.2 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 49.5 KiB | 54.4 KiB | 15.1 KiB | 16.4 KiB |
| tree-shake guard (`{ createHonuaPmtilesLifecycle }` from `/pmtiles`, generic discovery excluded) | 35.1 KiB | 35.1 KiB | 9.7 KiB | 10.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.4 KiB | 3.8 KiB | 1.5 KiB | 1.7 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 33.0 KiB | 35.9 KiB | 10.6 KiB | 11.3 KiB |
