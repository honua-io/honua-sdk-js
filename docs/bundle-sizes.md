<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Bundle sizes

Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:
esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,
`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`
(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).

_Generated 2026-07-05 at commit `8226033`._

| Entrypoint | Min | Min budget | Gzip | Gzip budget |
| --- | ---: | ---: | ---: | ---: |
| `.` (root) | 410.5 KiB | 451.6 KiB | 108.3 KiB | 119.3 KiB |
| `/honua` | 413.1 KiB | 454.4 KiB | 108.8 KiB | 119.9 KiB |
| `/contract` | 213.9 KiB | 235.3 KiB | 54.2 KiB | 59.7 KiB |
| `/runtime` | 417.0 KiB | 458.7 KiB | 108.3 KiB | 119.5 KiB |
| `/esri-compat` | 420.8 KiB | 462.9 KiB | 88.6 KiB | 97.8 KiB |
| `/expr` | 7.7 KiB | 8.4 KiB | 2.4 KiB | 2.7 KiB |
| `/webmap` | 19.5 KiB | 21.5 KiB | 5.9 KiB | 6.5 KiB |
| `/geocoding` | 4.9 KiB | 5.3 KiB | 1.9 KiB | 2.1 KiB |
| `/style` | 36.2 KiB | 39.9 KiB | 8.3 KiB | 9.1 KiB |
| `/map` | 62.6 KiB | 68.8 KiB | 16.2 KiB | 17.9 KiB |
| browser IIFE (`./browser` unpkg/jsdelivr) | 411.5 KiB | 452.7 KiB | 108.6 KiB | 119.7 KiB |
| browser ESM (`./browser`) | 410.0 KiB | 451.0 KiB | 108.3 KiB | 119.3 KiB |
| tree-shake guard (`{ HonuaClient }` only) | 185.7 KiB | 204.3 KiB | 47.2 KiB | 52.1 KiB |
