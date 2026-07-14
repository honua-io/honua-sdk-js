<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-14 at commit `f88a38e`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 374.6 KiB | 382.0 KiB | 99.1 KiB | 101.2 KiB |
| `/honua` | 489.5 KiB | 510.3 KiB | 129.8 KiB | 135.7 KiB |
| `/contract` | 241.6 KiB | 261.1 KiB | 63.6 KiB | 66.1 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 608.5 KiB | 663.7 KiB | 123.8 KiB | 134.0 KiB |
| `/plugin` (registry + certification, no heavy peers) | 39.8 KiB | 43.7 KiB | 13.1 KiB | 14.4 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 50.2 KiB | 55.2 KiB | 14.3 KiB | 15.8 KiB |
| `/nl-map-control` | 60.6 KiB | 65.8 KiB | 18.7 KiB | 20.4 KiB |
| `/runtime` | 432.8 KiB | 458.7 KiB | 114.1 KiB | 119.5 KiB |
| `/realtime` | 26.6 KiB | 29.3 KiB | 7.8 KiB | 8.6 KiB |
| `/offline` | 23.6 KiB | 26.0 KiB | 7.7 KiB | 8.5 KiB |
| `/query-planner` (worker runtime injected) | 73.5 KiB | 80.6 KiB | 21.9 KiB | 23.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 75.0 KiB | 77.8 KiB | 23.9 KiB | 24.9 KiB |
| `/esri-compat` | 963.4 KiB | 1026.2 KiB | 240.2 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 12.5 KiB | 13.7 KiB | 3.9 KiB | 4.3 KiB |
| `/routing` | 6.1 KiB | 6.6 KiB | 2.5 KiB | 2.7 KiB |
| `/auth` | 12.0 KiB | 12.8 KiB | 3.8 KiB | 4.0 KiB |
| `/style` | 46.7 KiB | 51.4 KiB | 11.3 KiB | 12.4 KiB |
| `/map` | 147.8 KiB | 149.8 KiB | 41.5 KiB | 45.8 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 21.6 KiB | 23.7 KiB | 7.7 KiB | 8.5 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 414.1 KiB | 446.7 KiB | 109.0 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 375.2 KiB | 382.8 KiB | 99.4 KiB | 101.5 KiB |
| browser ESM (`./browser`) | 374.0 KiB | 381.4 KiB | 99.0 KiB | 101.2 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 195.9 KiB | 204.3 KiB | 50.2 KiB | 52.1 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 327.5 KiB | 359.2 KiB | 84.9 KiB | 92.8 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 210.7 KiB | 220.4 KiB | 53.6 KiB | 55.8 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 18.0 KiB | 18.8 KiB | 6.8 KiB | 7.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
