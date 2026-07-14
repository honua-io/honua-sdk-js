<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-14 at commit `19c31fb`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 386.6 KiB | 425.3 KiB | 100.9 KiB | 101.2 KiB |
| `/honua` | 501.2 KiB | 510.3 KiB | 131.6 KiB | 135.7 KiB |
| `/contract` | 253.8 KiB | 261.1 KiB | 66.3 KiB | 72.9 KiB |
| `/plugin` (registry + certification, no heavy peers) | 56.9 KiB | 62.6 KiB | 17.5 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 50.1 KiB | 55.2 KiB | 14.3 KiB | 15.8 KiB |
| `/nl-map-control` | 76.8 KiB | 84.5 KiB | 23.0 KiB | 25.3 KiB |
| `/runtime` | 446.4 KiB | 458.7 KiB | 117.3 KiB | 119.5 KiB |
| `/realtime` | 44.8 KiB | 49.3 KiB | 12.3 KiB | 13.5 KiB |
| `/offline` | 40.3 KiB | 44.3 KiB | 12.0 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 89.5 KiB | 98.5 KiB | 26.0 KiB | 28.6 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 91.0 KiB | 100.0 KiB | 28.0 KiB | 30.8 KiB |
| `/esri-compat` | 976.4 KiB | 1026.2 KiB | 242.3 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 28.7 KiB | 31.6 KiB | 8.3 KiB | 9.1 KiB |
| `/routing` | 22.4 KiB | 24.6 KiB | 6.9 KiB | 7.6 KiB |
| `/auth` | 27.8 KiB | 30.6 KiB | 7.9 KiB | 8.7 KiB |
| `/style` | 62.7 KiB | 69.0 KiB | 15.6 KiB | 17.2 KiB |
| `/map` | 165.6 KiB | 182.2 KiB | 46.1 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 33.2 KiB | 36.5 KiB | 10.4 KiB | 11.4 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 428.0 KiB | 446.7 KiB | 112.4 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 387.3 KiB | 426.0 KiB | 101.1 KiB | 101.5 KiB |
| browser ESM (`./browser`) | 386.0 KiB | 424.6 KiB | 100.9 KiB | 101.2 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 208.8 KiB | 229.7 KiB | 52.4 KiB | 57.6 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 223.6 KiB | 245.9 KiB | 55.8 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 34.3 KiB | 37.7 KiB | 10.9 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
