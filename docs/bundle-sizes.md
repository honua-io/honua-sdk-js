<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-17 at commit `0a0ba83c`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 518.6 KiB | 568.6 KiB | 136.7 KiB | 150.2 KiB |
| `/honua` | 664.6 KiB | 673.0 KiB | 176.9 KiB | 179.0 KiB |
| `/contract` | 259.2 KiB | 287.3 KiB | 69.1 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 664.9 KiB | 737.1 KiB | 139.1 KiB | 154.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 253.7 KiB | 257.5 KiB | 31.2 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData schema-bound evaluation) | 697.5 KiB | 733.3 KiB | 147.8 KiB | 152.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 43.0 KiB | 62.6 KiB | 14.0 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 52.8 KiB | 55.2 KiB | 15.3 KiB | 15.8 KiB |
| `/nl-map-control` | 65.3 KiB | 84.5 KiB | 20.6 KiB | 25.3 KiB |
| `/runtime` | 493.7 KiB | 550.7 KiB | 133.4 KiB | 147.5 KiB |
| `/realtime` | 30.7 KiB | 33.8 KiB | 8.9 KiB | 9.7 KiB |
| `/offline` | 24.6 KiB | 27.0 KiB | 8.2 KiB | 9.0 KiB |
| `/query-planner` (worker runtime injected) | 511.5 KiB | 568.1 KiB | 100.4 KiB | 111.1 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 83.1 KiB | 100.0 KiB | 26.9 KiB | 30.8 KiB |
| `/esri-compat` | 970.9 KiB | 1026.2 KiB | 241.9 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 16.7 KiB | 18.5 KiB | 5.7 KiB | 6.3 KiB |
| `/routing` | 10.2 KiB | 11.3 KiB | 4.2 KiB | 4.7 KiB |
| `/auth` | 15.7 KiB | 17.3 KiB | 5.3 KiB | 5.9 KiB |
| `/style` | 50.6 KiB | 69.0 KiB | 12.8 KiB | 17.2 KiB |
| `/map` | 160.5 KiB | 182.2 KiB | 45.7 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 38.3 KiB | 53.6 KiB | 13.1 KiB | 16.8 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 429.6 KiB | 446.7 KiB | 114.3 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 519.3 KiB | 569.2 KiB | 136.9 KiB | 150.5 KiB |
| browser ESM (`./browser`) | 518.0 KiB | 567.8 KiB | 136.7 KiB | 150.2 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 203.4 KiB | 229.7 KiB | 52.0 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 379.5 KiB | 423.2 KiB | 98.7 KiB | 109.5 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 480.0 KiB | 535.3 KiB | 127.1 KiB | 141.2 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 218.1 KiB | 245.9 KiB | 55.3 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 23.1 KiB | 25.5 KiB | 8.2 KiB | 8.9 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (representative leaf error + safe JSON projection) | 3.6 KiB | 3.9 KiB | 1.4 KiB | 1.6 KiB |
| tree-shake guard (explicit descriptive error registry) | 10.6 KiB | 11.7 KiB | 2.3 KiB | 2.6 KiB |
| tree-shake guard (explicit error serializer, descriptors excluded) | 12.2 KiB | 13.5 KiB | 3.6 KiB | 4.0 KiB |
