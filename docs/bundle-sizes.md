<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-14 at commit `f7be7a3`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 391.6 KiB | 425.3 KiB | 102.3 KiB | 112.5 KiB |
| `/honua` | 506.1 KiB | 510.3 KiB | 133.0 KiB | 135.7 KiB |
| `/contract` | 254.1 KiB | 261.1 KiB | 66.3 KiB | 72.9 KiB |
| `/plugin` (registry + certification, no heavy peers) | 57.1 KiB | 62.6 KiB | 17.6 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 50.1 KiB | 55.2 KiB | 14.3 KiB | 15.8 KiB |
| `/nl-map-control` | 77.0 KiB | 84.5 KiB | 23.1 KiB | 25.3 KiB |
| `/runtime` | 446.6 KiB | 458.7 KiB | 117.4 KiB | 119.5 KiB |
| `/realtime` | 45.0 KiB | 49.3 KiB | 12.4 KiB | 13.5 KiB |
| `/offline` | 40.5 KiB | 44.3 KiB | 12.1 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 89.7 KiB | 98.5 KiB | 26.1 KiB | 28.6 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 91.2 KiB | 100.0 KiB | 28.1 KiB | 30.8 KiB |
| `/esri-compat` | 976.6 KiB | 1026.2 KiB | 242.4 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 28.9 KiB | 31.6 KiB | 8.4 KiB | 9.1 KiB |
| `/routing` | 22.6 KiB | 24.6 KiB | 7.0 KiB | 7.6 KiB |
| `/auth` | 28.0 KiB | 30.6 KiB | 8.0 KiB | 8.7 KiB |
| `/style` | 63.0 KiB | 69.0 KiB | 15.7 KiB | 17.2 KiB |
| `/map` | 165.8 KiB | 182.2 KiB | 46.2 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 33.4 KiB | 36.5 KiB | 10.5 KiB | 11.4 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 428.2 KiB | 446.7 KiB | 112.5 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 392.2 KiB | 426.0 KiB | 102.6 KiB | 112.8 KiB |
| browser ESM (`./browser`) | 390.9 KiB | 424.6 KiB | 102.3 KiB | 112.5 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 209.1 KiB | 229.7 KiB | 52.5 KiB | 57.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 223.8 KiB | 245.9 KiB | 55.9 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 34.5 KiB | 37.7 KiB | 11.0 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
