<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-17 at commit `a18e3f01`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 579.2 KiB | 637.1 KiB | 153.6 KiB | 168.9 KiB |
| `/honua` | 745.8 KiB | 781.2 KiB | 198.8 KiB | 209.3 KiB |
| `/contract` | 264.9 KiB | 287.3 KiB | 70.1 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 732.3 KiB | 737.1 KiB | 157.1 KiB | 172.8 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 254.0 KiB | 257.5 KiB | 31.3 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData/WMS/WMTS schema-bound evaluation) | 765.3 KiB | 824.2 KiB | 165.8 KiB | 178.4 KiB |
| `/plugin` (registry + certification, no heavy peers) | 53.2 KiB | 62.6 KiB | 16.5 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 52.4 KiB | 55.2 KiB | 15.2 KiB | 15.8 KiB |
| `/nl-map-control` | 73.8 KiB | 84.5 KiB | 22.2 KiB | 25.3 KiB |
| `/runtime` | 509.1 KiB | 550.7 KiB | 136.7 KiB | 147.5 KiB |
| `/realtime` | 41.2 KiB | 49.3 KiB | 11.4 KiB | 13.5 KiB |
| `/offline` | 36.6 KiB | 44.3 KiB | 11.1 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 521.4 KiB | 568.1 KiB | 102.7 KiB | 111.1 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 92.7 KiB | 100.0 KiB | 28.7 KiB | 30.8 KiB |
| `/esri-compat` | 983.2 KiB | 1026.2 KiB | 245.2 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 25.1 KiB | 31.6 KiB | 7.3 KiB | 9.1 KiB |
| `/routing` | 18.7 KiB | 24.6 KiB | 6.0 KiB | 7.6 KiB |
| `/auth` | 24.1 KiB | 30.6 KiB | 7.0 KiB | 8.7 KiB |
| `/style` | 59.1 KiB | 69.0 KiB | 14.6 KiB | 17.2 KiB |
| `/map` | 174.8 KiB | 182.2 KiB | 49.3 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 46.9 KiB | 53.6 KiB | 14.8 KiB | 16.8 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 438.9 KiB | 446.7 KiB | 116.1 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 579.8 KiB | 637.8 KiB | 153.7 KiB | 169.1 KiB |
| browser ESM (`./browser`) | 578.5 KiB | 636.4 KiB | 153.5 KiB | 168.9 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 215.6 KiB | 229.7 KiB | 55.1 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 446.5 KiB | 473.4 KiB | 116.3 KiB | 123.8 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 549.0 KiB | 603.9 KiB | 145.4 KiB | 155.7 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 230.4 KiB | 245.9 KiB | 58.5 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 40.7 KiB | 44.7 KiB | 12.8 KiB | 14.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
