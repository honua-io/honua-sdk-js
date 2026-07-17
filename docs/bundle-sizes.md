<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-17 at commit `870381c9`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 498.1 KiB | 547.9 KiB | 131.2 KiB | 144.3 KiB |
| `/honua` | 582.1 KiB | 640.4 KiB | 153.7 KiB | 169.1 KiB |
| `/contract` | 263.6 KiB | 287.3 KiB | 69.8 KiB | 72.9 KiB |
| `/source-schema` (focused schema + pinned PROJJSON validator) | 668.9 KiB | 735.8 KiB | 139.7 KiB | 153.7 KiB |
| `/source-capabilities` (static evidence ingestion + lightweight evaluator) | 253.7 KiB | 257.5 KiB | 31.2 KiB | 33.2 KiB |
| `/source-capability-discovery` (GeoServices/OData schema-bound evaluation) | 701.6 KiB | 733.3 KiB | 148.4 KiB | 152.6 KiB |
| `/plugin` (registry + certification, no heavy peers) | 53.2 KiB | 62.6 KiB | 16.5 KiB | 19.3 KiB |
| `/agent-tools` | 20.6 KiB | 22.7 KiB | 6.4 KiB | 7.0 KiB |
| `/agent-safety` | 52.4 KiB | 55.2 KiB | 15.2 KiB | 15.8 KiB |
| `/nl-map-control` | 73.8 KiB | 84.5 KiB | 22.2 KiB | 25.3 KiB |
| `/runtime` | 456.0 KiB | 458.7 KiB | 120.8 KiB | 131.7 KiB |
| `/realtime` | 41.2 KiB | 49.3 KiB | 11.4 KiB | 13.5 KiB |
| `/offline` | 36.6 KiB | 44.3 KiB | 11.1 KiB | 13.2 KiB |
| `/query-planner` (worker runtime injected) | 519.8 KiB | 569.1 KiB | 101.8 KiB | 111.3 KiB |
| `/scene-workspace` (MapLibre/Cesium external — optional peers) | 92.7 KiB | 100.0 KiB | 28.7 KiB | 30.8 KiB |
| `/esri-compat` | 979.3 KiB | 1026.2 KiB | 243.6 KiB | 253.6 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 24.8 KiB | 27.3 KiB | 7.6 KiB | 8.3 KiB |
| `/geocoding` | 25.1 KiB | 31.6 KiB | 7.3 KiB | 9.1 KiB |
| `/routing` | 18.7 KiB | 24.6 KiB | 6.0 KiB | 7.6 KiB |
| `/auth` | 24.1 KiB | 30.6 KiB | 7.0 KiB | 8.7 KiB |
| `/style` | 59.1 KiB | 69.0 KiB | 14.6 KiB | 17.2 KiB |
| `/map` | 167.3 KiB | 182.2 KiB | 46.7 KiB | 50.7 KiB |
| `/geoparquet` (duckdb-wasm external — lazy peer) | 46.9 KiB | 53.6 KiB | 14.8 KiB | 16.8 KiB |
| `/cog` (caller-injected decoder; no raster peer in the static graph) | 51.0 KiB | 56.1 KiB | 14.6 KiB | 16.1 KiB |
| `/deckgl` (deck.gl external — lazy peer) | 15.0 KiB | 16.5 KiB | 5.0 KiB | 5.6 KiB |
| `/react` (react/react-dom external) | 437.5 KiB | 446.7 KiB | 115.8 KiB | 117.2 KiB |
| `/geometry` (turf/proj4 bundled — real consumer cost) | 516.4 KiB | 568.0 KiB | 142.7 KiB | 157.0 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 498.6 KiB | 548.5 KiB | 131.4 KiB | 144.5 KiB |
| browser ESM (`./browser`) | 497.4 KiB | 547.1 KiB | 131.1 KiB | 144.3 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 211.7 KiB | 229.7 KiB | 53.6 KiB | 57.6 KiB |
| tree-shake guard (`{ connect }` from root, source-schema runtime excluded) | 383.6 KiB | 421.9 KiB | 99.3 KiB | 109.2 KiB |
| tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded) | 16.3 KiB | 17.9 KiB | 5.7 KiB | 6.2 KiB |
| tree-shake guard (`{ createHonua }` managed discovery facade only) | 404.9 KiB | 445.4 KiB | 105.0 KiB | 115.5 KiB |
| tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`) | 226.4 KiB | 245.9 KiB | 56.9 KiB | 61.4 KiB |
| tree-shake guard (`{ buffer }` from `/geometry`, turf bundled) | 287.5 KiB | 316.3 KiB | 65.6 KiB | 72.2 KiB |
| tree-shake guard (`{ mountSourceToMapLibre }` from `/map`) | 36.0 KiB | 37.7 KiB | 11.4 KiB | 12.0 KiB |
| tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external) | 3.3 KiB | 3.3 KiB | 1.5 KiB | 1.5 KiB |
