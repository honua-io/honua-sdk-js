<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-08-18 at commit `3d455684`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 758.5 KiB | 829.3 KiB | 203.0 KiB | 211.8 KiB |
| `/honua` | 921.3 KiB | 937.2 KiB | 247.2 KiB | 251.0 KiB |
| `/contract` | 368.2 KiB | 400.6 KiB | 99.1 KiB | 108.0 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 892.3 KiB | 925.5 KiB | 201.1 KiB | 206.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.8 KiB | 257.5 KiB | 31.4 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 926.3 KiB | 961.8 KiB | 210.5 KiB | 215.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 67.2 KiB | 69.2 KiB | 20.3 KiB | 21.9 KiB |
| `/agent-tools` | 44.5 KiB | 48.1 KiB | 12.2 KiB | 13.3 KiB |
| `/agent-safety` | 68.7 KiB | 73.2 KiB | 19.0 KiB | 20.5 KiB |
| `/nl-map-control` | 86.4 KiB | 94.2 KiB | 25.1 KiB | 25.3 KiB |
| `/interactions/declarative` (ADR-0030 compiler over the existing binding primitives) | 14.3 KiB | 15.8 KiB | 5.0 KiB | 5.5 KiB |
| `/studio-agent` (SSE + MCP transports and the turn loop; bundles its agent-tools dependency) | 25.4 KiB | 27.9 KiB | 8.1 KiB | 8.9 KiB |
| `/runtime` | 608.0 KiB | 612.2 KiB | 164.3 KiB | 180.4 KiB |
| `/realtime` | 80.6 KiB | 86.2 KiB | 23.1 KiB | 25.0 KiB |
| `/offline` | 171.1 KiB | 186.2 KiB | 45.5 KiB | 49.7 KiB |
| `/query-planner` (worker runtime injected) | 766.1 KiB | 778.7 KiB | 173.4 KiB | 182.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 168.7 KiB | 183.6 KiB | 51.0 KiB | 55.8 KiB |
| `/esri-compat` | 1022.3 KiB | 1026.2 KiB | 255.9 KiB | 280.9 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 28.7 KiB | 31.6 KiB | 7.9 KiB | 9.1 KiB |
| `/routing` | 22.4 KiB | 24.6 KiB | 6.6 KiB | 7.6 KiB |
| `/auth` | 27.8 KiB | 30.6 KiB | 7.6 KiB | 8.7 KiB |
| `/style` | 64.6 KiB | 69.0 KiB | 16.2 KiB | 17.2 KiB |
| `/map` | 183.0 KiB | 198.2 KiB | 51.6 KiB | 56.2 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 146.8 KiB | 154.9 KiB | 44.0 KiB | 46.6 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.7 KiB | 56.1 KiB | 14.8 KiB | 16.1 KiB |
| `/pmtiles` (bounded direct inspection + managed lifecycle; renderer runtime excluded) | 333.8 KiB | 364.2 KiB | 89.9 KiB | 98.7 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 66.1 KiB | 68.3 KiB | 17.7 KiB | 18.3 KiB |
| `/controls` (framework-free control kit; includes the lazy web-components registration chunk) | 1014.1 KiB | 1037.6 KiB | 272.4 KiB | 277.9 KiB |
| `/web-components` (custom-element kit; maplibre-gl external, export adapters injected) | 1090.7 KiB | 1120.1 KiB | 295.8 KiB | 321.9 KiB |
| `/kepler` (kepler.gl/react/redux absent — dynamic optional peer) | 61.4 KiB | 67.5 KiB | 17.9 KiB | 18.1 KiB |
| `/analytics` (contract + accessible default presentation; no chart adapter, no chart peer) | 35.7 KiB | 39.2 KiB | 11.2 KiB | 11.6 KiB |
| `/analytics/uplot` (µPlot external — dynamically imported optional peer) | 10.1 KiB | 10.3 KiB | 3.9 KiB | 4.2 KiB |
| `/react` (react/react-dom external) | 543.8 KiB | 562.6 KiB | 146.2 KiB | 150.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 759.1 KiB | 832.8 KiB | 203.2 KiB | 222.1 KiB |
| browser ESM (`./browser`) | 757.8 KiB | 828.5 KiB | 202.9 KiB | 221.7 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 240.9 KiB | 254.0 KiB | 62.1 KiB | 63.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 618.0 KiB | 627.9 KiB | 164.1 KiB | 166.9 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.4 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ HonuaTimeoutError }` only, descriptive code registry excluded) | 16.3 KiB | 17.1 KiB | 4.3 KiB | 4.5 KiB |
| explicit registry import (`{ HONUA_ERROR_CODE_REGISTRY }`, full descriptive summaries) | 17.0 KiB | 18.5 KiB | 3.6 KiB | 3.9 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 720.2 KiB | 791.3 KiB | 193.0 KiB | 210.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 255.5 KiB | 267.0 KiB | 65.3 KiB | 68.1 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 45.6 KiB | 49.4 KiB | 13.7 KiB | 14.0 KiB |
| tree-shake guard (`{ createHonuaPmtilesLifecycle }` from `/pmtiles`, generic discovery excluded) | 34.6 KiB | 35.1 KiB | 9.7 KiB | 10.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (`/analytics` contract + default presentation, chart adapters/peers excluded) | 27.4 KiB | 30.2 KiB | 9.0 KiB | 9.2 KiB |
