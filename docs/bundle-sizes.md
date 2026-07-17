<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-17 at commit `82373a31`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 470.5 KiB | 488.7 KiB | 123.2 KiB | 127.9 KiB |
| `/honua` | 617.8 KiB | 673.0 KiB | 163.7 KiB | 179.0 KiB |
| `/contract` | 253.7 KiB | 287.3 KiB | 67.5 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 625.5 KiB | 663.7 KiB | 127.9 KiB | 134.0 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 253.1 KiB | 257.5 KiB | 30.7 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData schema-bound evaluation) | 658.2 KiB | 733.3 KiB | 136.6 KiB | 152.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 42.5 KiB | 62.6 KiB | 13.5 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 51.9 KiB | 55.2 KiB | 14.6 KiB | 15.8 KiB |
| `/nl-map-control` | 64.8 KiB | 84.5 KiB | 20.1 KiB | 25.3 KiB |
| `/runtime` | 444.3 KiB | 458.7 KiB | 118.2 KiB | 131.7 KiB |
| `/realtime` | 30.7 KiB | 49.3 KiB | 8.9 KiB | 13.5 KiB |
| `/offline` | 24.6 KiB | 44.3 KiB | 8.2 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 510.9 KiB | 568.1 KiB | 99.6 KiB | 111.1 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 83.3 KiB | 100.0 KiB | 26.5 KiB | 30.8 KiB |
| `/esri-compat` | 969.7 KiB | 1026.2 KiB | 241.5 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 16.8 KiB | 31.6 KiB | 5.7 KiB | 9.1 KiB |
| `/routing` | 10.3 KiB | 24.6 KiB | 4.2 KiB | 7.6 KiB |
| `/auth` | 15.8 KiB | 30.6 KiB | 5.3 KiB | 8.7 KiB |
| `/style` | 50.6 KiB | 69.0 KiB | 12.8 KiB | 17.2 KiB |
| `/map` | 159.2 KiB | 182.2 KiB | 44.9 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 38.4 KiB | 53.6 KiB | 13.1 KiB | 16.8 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 424.6 KiB | 446.7 KiB | 112.7 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 471.2 KiB | 489.3 KiB | 123.4 KiB | 128.1 KiB |
| browser ESM (`./browser`) | 469.9 KiB | 487.9 KiB | 123.2 KiB | 127.9 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 202.2 KiB | 229.7 KiB | 51.6 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 340.8 KiB | 359.2 KiB | 88.2 KiB | 92.8 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 15.8 KiB | 17.9 KiB | 5.2 KiB | 6.2 KiB |
| tree-shake guard (`{ createHonua }` managed discovery + accepted-plan facade) | 433.2 KiB | 478.1 KiB | 114.0 KiB | 125.4 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 217.0 KiB | 245.9 KiB | 55.0 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 24.7 KiB | 37.7 KiB | 8.5 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (representative leaf error + safe JSON projection) | 3.6 KiB | 3.9 KiB | 1.4 KiB | 1.6 KiB |
| tree-shake guard (explicit descriptive error registry) | 10.6 KiB | 11.7 KiB | 2.3 KiB | 2.6 KiB |
| tree-shake guard (explicit error serializer, descriptors excluded) | 12.2 KiB | 13.5 KiB | 3.6 KiB | 4.0 KiB |
