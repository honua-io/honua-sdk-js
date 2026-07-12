# Automatic Source → MapLibre workflow

Deterministic, headless browser fixture for the golden automatic
Source → MapLibre workflow (#390, AC#4 / Validation).

`app.mjs` drives a real MapLibre GL renderer and:

- explains the correct automatic strategy for every source shape — GeoJSON
  query, vector tiles, native raster tiles, WMS, WMTS, PMTiles (vector and
  raster), and dynamic query tiles;
- mounts the natively-understood tile strategies on the real renderer and
  disposes them cleanly (no leaked sources or layers);
- runs the incremental integration surface on the client-materialized
  `geojson-query` strategy via `attachAutomaticMapLibreInteractions`:
  selection (feature-state), a popup, a filter-registry-driven runtime filter
  (composed with the layer's baked-in geometry filter), realtime feature-state
  deltas, hit-testing, an in-place refresh, and leak-free disposal.

Feature data is served in-memory and native tile URLs point at the local
fixture origin, so the fixture needs no external network.

The Playwright spec that serves and asserts against this fixture lives at
`test/playwright/automatic-source-workflow.spec.mjs` and runs as part of
`npm run test:playwright`.
