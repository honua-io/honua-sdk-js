<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-15 at commit `2ff3aff`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 400.4 KiB | 425.3 KiB | 105.2 KiB | 112.5 KiB |
| `/honua` | 513.6 KiB | 566.2 KiB | 135.5 KiB | 149.6 KiB |
| `/contract` | 260.4 KiB | 287.3 KiB | 68.4 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 631.9 KiB | 663.7 KiB | 129.5 KiB | 134.0 KiB |
| `/plugin` (registry + certification, no heavy peers) | 57.5 KiB | 62.6 KiB | 17.7 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 50.1 KiB | 55.2 KiB | 14.3 KiB | 15.8 KiB |
| `/nl-map-control` | 77.5 KiB | 84.5 KiB | 23.2 KiB | 25.3 KiB |
| `/runtime` | 452.4 KiB | 458.7 KiB | 119.4 KiB | 131.7 KiB |
| `/realtime` | 45.5 KiB | 49.3 KiB | 12.5 KiB | 13.5 KiB |
| `/offline` | 41.0 KiB | 44.3 KiB | 12.2 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 98.9 KiB | 108.8 KiB | 28.7 KiB | 31.6 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 92.9 KiB | 100.0 KiB | 28.6 KiB | 30.8 KiB |
| `/esri-compat` | 982.4 KiB | 1026.2 KiB | 244.4 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 29.4 KiB | 31.6 KiB | 8.4 KiB | 9.1 KiB |
| `/routing` | 23.0 KiB | 24.6 KiB | 7.1 KiB | 7.6 KiB |
| `/auth` | 28.4 KiB | 30.6 KiB | 8.1 KiB | 8.7 KiB |
| `/style` | 63.4 KiB | 69.0 KiB | 15.8 KiB | 17.2 KiB |
| `/map` | 167.6 KiB | 182.2 KiB | 46.7 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 46.5 KiB | 51.1 KiB | 14.5 KiB | 14.6 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 433.9 KiB | 446.7 KiB | 114.3 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 401.0 KiB | 426.0 KiB | 105.4 KiB | 112.8 KiB |
| browser ESM (`./browser`) | 399.8 KiB | 424.6 KiB | 105.2 KiB | 112.5 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 214.8 KiB | 229.7 KiB | 54.3 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 346.9 KiB | 359.2 KiB | 89.3 KiB | 92.8 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 229.5 KiB | 245.9 KiB | 57.8 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 36.3 KiB | 37.7 KiB | 11.4 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
