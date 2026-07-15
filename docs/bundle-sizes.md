<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-15 at commit `a7163ec`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 406.5 KiB | 425.3 KiB | 106.2 KiB | 112.5 KiB |
| `/honua` | 519.8 KiB | 566.2 KiB | 136.7 KiB | 149.6 KiB |
| `/contract` | 256.0 KiB | 287.3 KiB | 67.3 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 627.9 KiB | 663.7 KiB | 128.4 KiB | 134.0 KiB |
| `/plugin` (registry + certification, no heavy peers) | 53.2 KiB | 62.6 KiB | 16.5 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 50.1 KiB | 55.2 KiB | 14.3 KiB | 15.8 KiB |
| `/nl-map-control` | 73.1 KiB | 84.5 KiB | 22.0 KiB | 25.3 KiB |
| `/runtime` | 448.0 KiB | 458.7 KiB | 118.3 KiB | 131.7 KiB |
| `/realtime` | 41.1 KiB | 49.3 KiB | 11.4 KiB | 13.5 KiB |
| `/offline` | 36.6 KiB | 44.3 KiB | 11.1 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 371.7 KiB | 408.7 KiB | 64.9 KiB | 71.4 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 88.5 KiB | 100.0 KiB | 27.5 KiB | 30.8 KiB |
| `/esri-compat` | 978.0 KiB | 1026.2 KiB | 243.2 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 25.0 KiB | 31.6 KiB | 7.3 KiB | 9.1 KiB |
| `/routing` | 18.7 KiB | 24.6 KiB | 6.0 KiB | 7.6 KiB |
| `/auth` | 24.1 KiB | 30.6 KiB | 7.0 KiB | 8.7 KiB |
| `/style` | 59.0 KiB | 69.0 KiB | 14.6 KiB | 17.2 KiB |
| `/map` | 163.2 KiB | 182.2 KiB | 45.5 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 42.1 KiB | 51.1 KiB | 13.4 KiB | 14.6 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 429.5 KiB | 446.7 KiB | 113.2 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 407.2 KiB | 426.0 KiB | 106.5 KiB | 112.8 KiB |
| browser ESM (`./browser`) | 405.9 KiB | 424.6 KiB | 106.2 KiB | 112.5 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 210.4 KiB | 229.7 KiB | 53.2 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 342.6 KiB | 359.2 KiB | 88.1 KiB | 92.8 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 225.2 KiB | 245.9 KiB | 56.6 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 31.9 KiB | 37.7 KiB | 10.3 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
