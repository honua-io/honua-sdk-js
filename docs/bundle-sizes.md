<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-16 at commit `adacc54`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 420.7 KiB | 425.3 KiB | 110.0 KiB | 112.5 KiB |
| `/honua` | 522.5 KiB | 566.2 KiB | 137.3 KiB | 149.6 KiB |
| `/contract` | 251.1 KiB | 287.3 KiB | 66.7 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 623.2 KiB | 663.7 KiB | 127.8 KiB | 134.0 KiB |
| `/plugin` (registry + certification, no heavy peers) | 43.4 KiB | 62.6 KiB | 14.1 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 51.4 KiB | 55.2 KiB | 14.8 KiB | 15.8 KiB |
| `/nl-map-control` | 63.9 KiB | 84.5 KiB | 20.0 KiB | 25.3 KiB |
| `/runtime` | 439.3 KiB | 458.7 KiB | 116.3 KiB | 131.7 KiB |
| `/realtime` | 31.0 KiB | 34.0 KiB | 8.9 KiB | 9.2 KiB |
| `/offline` | 24.7 KiB | 27.0 KiB | 8.2 KiB | 9.0 KiB |
| `/query-planner` (worker runtime injected) | 390.0 KiB | 439.0 KiB | 69.7 KiB | 78.7 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 80.5 KiB | 100.0 KiB | 25.9 KiB | 30.8 KiB |
| `/esri-compat` | 969.2 KiB | 1026.2 KiB | 241.2 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 16.2 KiB | 17.2 KiB | 5.4 KiB | 5.6 KiB |
| `/routing` | 9.9 KiB | 10.2 KiB | 4.0 KiB | 4.1 KiB |
| `/auth` | 15.2 KiB | 16.1 KiB | 5.0 KiB | 5.2 KiB |
| `/style` | 50.1 KiB | 69.0 KiB | 12.5 KiB | 17.2 KiB |
| `/map` | 154.9 KiB | 182.2 KiB | 43.8 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 34.1 KiB | 51.1 KiB | 11.6 KiB | 14.6 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 420.9 KiB | 446.7 KiB | 111.3 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 421.3 KiB | 426.0 KiB | 110.2 KiB | 112.8 KiB |
| browser ESM (`./browser`) | 420.0 KiB | 424.6 KiB | 110.0 KiB | 112.5 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 201.7 KiB | 229.7 KiB | 51.3 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 337.9 KiB | 359.2 KiB | 87.5 KiB | 92.8 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 216.5 KiB | 245.9 KiB | 54.7 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 21.8 KiB | 24.5 KiB | 8.2 KiB | 8.2 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
| tree-shake guard (representative leaf error + safe JSON projection) | 3.9 KiB | 4.2 KiB | 1.5 KiB | 1.6 KiB |
| tree-shake guard (explicit descriptive error registry) | 10.6 KiB | 11.1 KiB | 2.3 KiB | 2.5 KiB |
| tree-shake guard (explicit error serializer, descriptors excluded) | 12.3 KiB | 12.3 KiB | 3.6 KiB | 3.7 KiB |
