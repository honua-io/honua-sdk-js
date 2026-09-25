<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-09-25 at commit `d10ee0c12`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 778.3 KiB | 829.3 KiB | 210.9 KiB | 211.8 KiB |
| `/honua` | 950.9 KiB | 1033.4 KiB | 258.5 KiB | 278.1 KiB |
| `/contract` | 373.7 KiB | 400.6 KiB | 100.8 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 912.0 KiB | 925.5 KiB | 208.8 KiB | 227.3 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.8 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 946.0 KiB | 961.8 KiB | 218.2 KiB | 237.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 67.6 KiB | 69.2 KiB | 20.3 KiB | 21.9 KiB |
| `/agent-tools` | 45.7 KiB | 48.1 KiB | 12.5 KiB | 13.3 KiB |
| `/agent-safety` | 69.1 KiB | 73.2 KiB | 19.1 KiB | 20.5 KiB |
| `/nl-map-control` | 87.9 KiB | 94.2 KiB | 25.6 KiB | 27.9 KiB |
| `/interactions/declarative` (ADR-0030 compiler over the existing binding primitives) | 14.3 KiB | 15.8 KiB | 5.0 KiB | 5.5 KiB |
| `/studio-agent` (SSE + MCP transports and the turn loop; bundles its agent-tools dependency) | 43.7 KiB | 46.9 KiB | 14.0 KiB | 15.0 KiB |
| `/runtime` | 690.6 KiB | 752.5 KiB | 176.9 KiB | 180.4 KiB |
| `/realtime` | 81.7 KiB | 86.2 KiB | 23.4 KiB | 25.0 KiB |
| `/offline` | 171.5 KiB | 186.2 KiB | 45.5 KiB | 49.7 KiB |
| `/query-planner` (worker runtime injected) | 767.4 KiB | 778.7 KiB | 173.9 KiB | 182.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 170.2 KiB | 183.6 KiB | 51.5 KiB | 55.8 KiB |
| `/esri-compat` | 1053.5 KiB | 1139.7 KiB | 267.0 KiB | 280.9 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 35.0 KiB | 38.6 KiB | 10.7 KiB | 11.8 KiB |
| `/geocoding` | 32.7 KiB | 35.9 KiB | 9.2 KiB | 10.1 KiB |
| `/routing` | 26.1 KiB | 28.7 KiB | 7.8 KiB | 8.5 KiB |
| `/auth` | 28.2 KiB | 30.6 KiB | 7.7 KiB | 8.7 KiB |
| `/style` | 65.3 KiB | 69.0 KiB | 16.4 KiB | 17.2 KiB |
| `/map` | 193.5 KiB | 198.2 KiB | 54.9 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 147.2 KiB | 154.9 KiB | 44.0 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/pmtiles` (bounded direct inspection + managed lifecycle; renderer runtime excluded) | 353.5 KiB | 364.2 KiB | 97.5 KiB | 98.7 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 66.1 KiB | 68.3 KiB | 17.7 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1165.0 KiB | 1275.0 KiB | 307.4 KiB | 312.7 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1268.6 KiB | 1395.4 KiB | 338.0 KiB | 356.1 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 549.4 KiB | 562.6 KiB | 147.9 KiB | 150.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 525.1 KiB | 568.0 KiB | 144.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 774.8 KiB | 832.8 KiB | 209.7 KiB | 222.1 KiB |
| browser ESM (`./browser`) | 773.7 KiB | 828.5 KiB | 209.4 KiB | 221.7 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 260.6 KiB | 280.2 KiB | 69.9 KiB | 74.3 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 637.7 KiB | 695.1 KiB | 172.0 KiB | 186.7 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.4 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 16.6 KiB | 17.1 KiB | 4.4 KiB | 4.5 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 17.1 KiB | 18.5 KiB | 3.6 KiB | 3.9 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 739.9 KiB | 791.3 KiB | 201.0 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 275.2 KiB | 296.3 KiB | 72.8 KiB | 77.7 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 46.0 KiB | 49.4 KiB | 13.8 KiB | 14.0 KiB |
| tree-shake guard (`{ createHonuaPmtilesLifecycle }` from `/pmtiles`, generic discovery excluded) | 35.0 KiB | 35.1 KiB | 9.7 KiB | 10.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
