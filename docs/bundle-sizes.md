<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-13 at commit `c6d3dfd`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 369.4 KiB | 382.0 KiB | 97.1 KiB | 101.2 KiB |
| `/honua` | 480.3 KiB | 510.3 KiB | 126.7 KiB | 135.7 KiB |
| `/contract` | 237.5 KiB | 261.1 KiB | 62.1 KiB | 66.1 KiB |
| `/plugin` (registry + certification, no heavy peers) | 39.8 KiB | 43.7 KiB | 13.1 KiB | 14.4 KiB |
| `/agent-safety` | 50.2 KiB | 55.2 KiB | 14.3 KiB | 15.8 KiB |
| `/nl-map-control` | 60.6 KiB | 65.8 KiB | 18.7 KiB | 20.4 KiB |
| `/runtime` | 424.5 KiB | 458.7 KiB | 111.0 KiB | 119.5 KiB |
| `/realtime` | 26.6 KiB | 29.3 KiB | 7.8 KiB | 8.6 KiB |
| `/offline` | 23.6 KiB | 26.0 KiB | 7.7 KiB | 8.5 KiB |
| `/query-planner` (worker runtime injected) | 73.3 KiB | 80.6 KiB | 21.7 KiB | 23.9 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 74.7 KiB | 77.8 KiB | 23.8 KiB | 24.9 KiB |
| `/esri-compat` | 950.4 KiB | 1026.2 KiB | 235.5 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 19.5 KiB | 21.5 KiB | 5.9 KiB | 6.5 KiB |
| `/geocoding` | 12.5 KiB | 13.7 KiB | 3.9 KiB | 4.3 KiB |
| `/routing` | 6.1 KiB | 6.6 KiB | 2.5 KiB | 2.7 KiB |
| `/auth` | 12.0 KiB | 12.8 KiB | 3.8 KiB | 4.0 KiB |
| `/style` | 37.5 KiB | 39.9 KiB | 8.4 KiB | 9.1 KiB |
| `/map` | 136.3 KiB | 149.8 KiB | 37.8 KiB | 41.6 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 17.2 KiB | 17.8 KiB | 6.2 KiB | 6.5 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 372.3 KiB | 405.7 KiB | 96.2 KiB | 104.5 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 370.1 KiB | 382.8 KiB | 97.4 KiB | 101.5 KiB |
| browser ESM (`./browser`) | 368.8 KiB | 381.4 KiB | 97.1 KiB | 101.2 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 192.5 KiB | 204.3 KiB | 48.9 KiB | 52.1 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 207.3 KiB | 220.4 KiB | 52.3 KiB | 55.8 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 17.7 KiB | 18.8 KiB | 6.6 KiB | 7.0 KiB |
