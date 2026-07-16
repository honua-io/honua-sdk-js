<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-16 at commit `580f9a6`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 441.6 KiB | 480.9 KiB | 116.2 KiB | 126.3 KiB |
| `/honua` | 541.8 KiB | 566.2 KiB | 143.2 KiB | 149.6 KiB |
| `/contract` | 278.0 KiB | 287.3 KiB | 73.4 KiB | 80.6 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 649.7 KiB | 663.7 KiB | 134.4 KiB | 147.8 KiB |
| `/plugin` (registry + certification, no heavy peers) | 53.2 KiB | 62.6 KiB | 16.5 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 51.4 KiB | 55.2 KiB | 14.8 KiB | 15.8 KiB |
| `/nl-map-control` | 73.2 KiB | 84.5 KiB | 22.0 KiB | 25.3 KiB |
| `/runtime` | 469.8 KiB | 511.7 KiB | 124.4 KiB | 131.7 KiB |
| `/realtime` | 41.2 KiB | 49.3 KiB | 11.4 KiB | 13.5 KiB |
| `/offline` | 36.6 KiB | 44.3 KiB | 11.1 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 399.7 KiB | 439.0 KiB | 71.7 KiB | 78.7 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 90.0 KiB | 100.0 KiB | 28.0 KiB | 30.8 KiB |
| `/esri-compat` | 978.1 KiB | 1026.2 KiB | 243.2 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 25.1 KiB | 31.6 KiB | 7.3 KiB | 9.1 KiB |
| `/routing` | 18.7 KiB | 24.6 KiB | 6.0 KiB | 7.6 KiB |
| `/auth` | 24.1 KiB | 30.6 KiB | 7.0 KiB | 8.7 KiB |
| `/style` | 59.1 KiB | 69.0 KiB | 14.6 KiB | 17.2 KiB |
| `/map` | 164.8 KiB | 182.2 KiB | 46.1 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 43.1 KiB | 51.1 KiB | 13.6 KiB | 14.6 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 451.4 KiB | 491.4 KiB | 119.5 KiB | 130.0 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 442.2 KiB | 481.6 KiB | 116.5 KiB | 126.5 KiB |
| browser ESM (`./browser`) | 441.0 KiB | 480.2 KiB | 116.2 KiB | 126.3 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 210.7 KiB | 229.7 KiB | 53.3 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 364.4 KiB | 395.8 KiB | 94.6 KiB | 102.5 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 225.3 KiB | 245.9 KiB | 56.6 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 33.3 KiB | 37.7 KiB | 10.8 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
