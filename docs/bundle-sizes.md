<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-11 at commit `ac22dd0`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 430.9 KiB | 451.6 KiB | 115.1 KiB | 119.3 KiB |
| `/honua` | 433.4 KiB | 454.4 KiB | 115.5 KiB | 119.9 KiB |
| `/contract` | 232.0 KiB | 235.3 KiB | 60.1 KiB | 66.1 KiB |
| `/runtime` | 425.3 KiB | 458.7 KiB | 110.9 KiB | 119.5 KiB |
| `/realtime` | 26.6 KiB | 29.3 KiB | 7.8 KiB | 8.6 KiB |
| `/esri-compat` | 943.4 KiB | 1026.2 KiB | 233.7 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 19.5 KiB | 21.5 KiB | 5.9 KiB | 6.5 KiB |
| `/geocoding` | 4.9 KiB | 5.3 KiB | 1.9 KiB | 2.1 KiB |
| `/auth` | 12.0 KiB | 12.8 KiB | 3.8 KiB | 4.0 KiB |
| `/style` | 37.5 KiB | 39.9 KiB | 8.4 KiB | 9.1 KiB |
| `/map` | 79.5 KiB | 87.4 KiB | 21.8 KiB | 24.0 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 14.6 KiB | 15.8 KiB | 5.4 KiB | 5.8 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 11.5 KiB | 12.5 KiB | 4.1 KiB | 4.4 KiB |
| `/react` (react/react-dom external) | 377.3 KiB | 405.7 KiB | 97.6 KiB | 104.5 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 431.8 KiB | 452.7 KiB | 115.4 KiB | 119.7 KiB |
| browser ESM (`./browser`) | 430.3 KiB | 451.0 KiB | 115.1 KiB | 119.3 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 189.8 KiB | 204.3 KiB | 48.4 KiB | 52.1 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 204.6 KiB | 220.4 KiB | 51.9 KiB | 55.8 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 17.1 KiB | 18.8 KiB | 6.4 KiB | 7.0 KiB |
