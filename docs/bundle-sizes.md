<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-12 at commit `ddebdc0`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 460.9 KiB | 501.9 KiB | 122.6 KiB | 132.3 KiB |
| `/honua` | 463.4 KiB | 504.8 KiB | 123.2 KiB | 133.0 KiB |
| `/contract` | 225.5 KiB | 235.3 KiB | 58.5 KiB | 66.1 KiB |
| `/agent-safety` | 34.6 KiB | 37.9 KiB | 10.4 KiB | 11.4 KiB |
| `/runtime` | 419.0 KiB | 458.7 KiB | 109.4 KiB | 119.5 KiB |
| `/realtime` | 26.6 KiB | 29.3 KiB | 7.8 KiB | 8.6 KiB |
| `/offline` | 23.6 KiB | 26.0 KiB | 7.7 KiB | 8.5 KiB |
| `/query-planner` (worker runtime injected) | 64.4 KiB | 70.8 KiB | 19.4 KiB | 21.3 KiB |
| `/esri-compat` | 943.9 KiB | 1026.2 KiB | 233.9 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 19.5 KiB | 21.5 KiB | 5.9 KiB | 6.5 KiB |
| `/geocoding` | 4.9 KiB | 5.3 KiB | 1.9 KiB | 2.1 KiB |
| `/auth` | 12.0 KiB | 12.8 KiB | 3.8 KiB | 4.0 KiB |
| `/style` | 37.5 KiB | 39.9 KiB | 8.4 KiB | 9.1 KiB |
| `/map` | 85.6 KiB | 87.4 KiB | 23.5 KiB | 24.0 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 17.2 KiB | 17.8 KiB | 6.2 KiB | 6.5 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 11.5 KiB | 12.5 KiB | 4.1 KiB | 4.4 KiB |
| `/react` (react/react-dom external) | 370.8 KiB | 405.7 KiB | 96.0 KiB | 104.5 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 461.8 KiB | 503.0 KiB | 123.0 KiB | 132.7 KiB |
| browser ESM (`./browser`) | 460.3 KiB | 501.3 KiB | 122.5 KiB | 132.3 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 190.4 KiB | 204.3 KiB | 48.6 KiB | 52.1 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 205.1 KiB | 220.4 KiB | 52.0 KiB | 55.8 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 17.4 KiB | 18.8 KiB | 6.5 KiB | 7.0 KiB |
