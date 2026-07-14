<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run docs:comparison -->
<!-- Inputs: docs/bundle-sizes.md, docs/protocol-capability-matrix.md, docs/data/time-to-first-map.json, node_modules/maplibre-gl. -->
<!-- Freshness is enforced by npm run docs:comparison:check. -->

# How Honua compares

**MapLibre gives you the map. Honua gives you everything else.** `@honua/sdk-js` is a typed,
protocol-neutral geospatial *service client* and migration toolkit that rides open renderers —
it is **not** a rendering engine, so this page does not compare rendering. It compares the
things Honua actually claims: the bytes you ship, the protocols you get a real client for,
and how fast a new project reaches a working map.

Three ground rules keep this page honest:

1. **Every Honua number is generated, never hand-edited.** This whole file is produced by
   `npm run docs:comparison` from committed, regenerable inputs; CI fails when it drifts
   (`npm run docs:comparison:check`). See [Methodology](#methodology-and-freshness).
2. **Every external number carries a source URL and an as-of date.**
3. **Non-goals are stated.** Esri's 3D/SceneView stack and MapLibre's rendering quality are
   not competitions we enter; see the
   [three-lanes strategy](./decisions/market-strategy-2026-three-lanes.md).

## Bundle size

Honua per-entrypoint sizes below are projected from the generated
[`docs/bundle-sizes.md`](./bundle-sizes.md) (measured 2026-07-14 at commit `f88a38e`;
esbuild `--bundle --minify`, target `es2020`, runtime peers external — the way a real consumer
builds). CI enforces a byte budget on every entrypoint (`npm run verify:bundle-budgets`).

| What you import | Minified | Gzip |
| --- | ---: | ---: |
| Full root entrypoint: connect → query → explain → mount workflow | 374.6 KiB | 99.1 KiB |
| Importing only `HonuaClient` (tree-shake guard) | 195.9 KiB | 50.2 KiB |
| Data→map bridge only: `mountSourceToMapLibre` from `/map` | 18.0 KiB | 6.8 KiB |
| Protocol-neutral contract (`Dataset`/`Source`/`Query`/`Result`) | 241.6 KiB | 63.6 KiB |
| ArcGIS compatibility layer (drop-in migration surface) | 963.4 KiB | 240.2 KiB |
| Geocoding client | 12.5 KiB | 3.9 KiB |
| Routing client | 6.1 KiB | 2.5 KiB |

For context, the rendering engine itself — `maplibre-gl` 5.21.1, measured locally from
this repo's pinned dependency (`dist/maplibre-gl.js`) — is 1024.9 KiB minified / **267.9 KiB gzip**.
A complete Honua + MapLibre app therefore ships roughly the engine plus whichever Honua
entrypoints it imports.

### Against the alternatives

**`@arcgis/core` 4.30 (ArcGIS Maps SDK for JavaScript).** Esri's own automated build metrics for its minimal `@arcgis/core` map samples (esbuild, Angular, React, Vue, Rollup, Webpack lanes). As of 2024-06-27 (4.30, the last core-sample metrics Esri published in jsapi-resources):
the main bundle alone is 1.31–1.49 MB minified (0.36–0.42 MB gzip), a
simple map view loads **3.5–4.1 MB of JavaScript** at startup, and the
on-disk build output is 8.3–10 MB across ~300–740 files. Source (pinned, retrieved 2026-07-13):
<https://github.com/Esri/jsapi-resources/blob/9fe7d8cc709c5daf3a342e921e897d459955b347/core-samples/.metrics/4.30.0.csv>.

To be fair in both directions: `@arcgis/core` bundles its own renderer, so the honest
apples-to-apples is *Honua + MapLibre* against `@arcgis/core`. Compared conservatively —
our **uncompressed minified** bytes (engine 1024.9 KiB + Honua root 374.6 KiB ≈
1.37 MB) against Esri's reported startup JavaScript total
(3.5–4.1 MB) — the open stack ships roughly a third of the JavaScript, and
0.36 MB over the wire with gzip. Esri's totals also grow with widgets;
these figures are its *minimal* samples.

**`@esri/arcgis-rest-js`** (<https://developers.arcgis.com/arcgis-rest-js/>, retrieved 2026-07-13).
Esri's lightweight REST client family. Small per-package footprint; speaks ArcGIS services only, no map runtime. If all you need is small requests against ArcGIS-only services, it is a
fine, lighter choice — the comparison that matters is protocol coverage (below), not bytes.

**OpenLayers (`ol`)** (<https://openlayers.org/>, retrieved 2026-07-13). A full renderer + formats library, not a typed multi-protocol service client; size depends heavily on tree-shaken imports.

## Protocol coverage

What you get a first-party, *typed* client for — versus what you hand-roll. Honua's column is
derived from the maintained
[protocol × capability matrix](./protocol-capability-matrix.md) (per-operation detail lives
there; capability misses throw `HonuaCapabilityNotSupportedError` instead of returning empty
results). Competitor columns are deliberately coarse: ✓ first-party support, ◐ partial or
manual assembly, — not provided.

| Protocol lane | Honua SDK | raw `maplibre-gl` | `@esri/arcgis-rest-js` | OpenLayers |
| --- | --- | --- | --- | --- |
| Esri GeoServices (FeatureServer query/edit) | ✓ typed client | — | ✓ | ◐ (a) |
| Esri GeoServices (MapServer / ImageServer render) | ✓ typed client | ◐ (b) | — | ✓ |
| OGC API Features (query/edit) | ✓ typed client | ◐ (c) | — | ◐ (d) |
| OGC API Tiles / Maps | ✓ typed client | ◐ (b) | — | ✓ |
| OGC API Records (catalog search) | ✓ typed client | — | — | — |
| STAC (cross-collection search) | ✓ typed client | — | — | ◐ (e) |
| WFS 2.0 (typed filters, transactions) | ✓ typed client | — | — | ◐ (f) |
| WMS (GetMap + typed GetFeatureInfo) | ✓ typed client | ◐ (b) | — | ✓ |
| WMTS (capabilities-driven tiles) | ✓ typed client | ◐ (b) | — | ✓ |
| OData v4 (tabular + spatial query, edits) | ✓ typed client | — | — | — |
| GeoParquet (client-side SQL via DuckDB-WASM) | ✓ typed client (lazy peer) | — | — | — |
| PMTiles archives | ✓ auto-registered protocol | ◐ (g) | — | ◐ (h) |
| Geocoding (provider-pluggable) | ✓ Nominatim / Photon / Pelias / Honua | ◐ (i) | ✓ (j) | — |
| Routing (provider-pluggable) | ✓ OSRM / Valhalla / Honua | — | ✓ (j) | — |
| ArcGIS migration codemod | ✓ `honua-migrate` + esri-compat | — | — | — |

Notes:

- (a) OpenLayers ships an `EsriJSON` format; service discovery, paging, auth, and edits are hand-rolled requests.
- (b) Raw MapLibre renders XYZ/raster endpoints you template by hand; there is no capabilities negotiation, feature query, or typed error surface.
- (c) Point a MapLibre GeoJSON source at an `items` URL; paging, filters, CRS negotiation, and edits are yours to build.
- (d) OpenLayers parses GeoJSON and has OGC API tile sources, but has no OGC API Features items client (paging, filters, transactions).
- (e) Via the third-party `ol-stac` package, not OpenLayers itself.
- (f) OpenLayers ships `ol/format/WFS` (GML parsing, filter builders); request orchestration, paging, and transaction bookkeeping are manual.
- (g) Via the official `pmtiles` JS package: install it and call `maplibregl.addProtocol` yourself. Honua auto-registers the protocol on map attach.
- (h) Via the third-party `ol-pmtiles` package.
- (i) Via the `maplibre-gl-geocoder` control plugin, which needs a geocoding API adapter you supply.
- (j) `@esri/arcgis-rest-geocoding` / `-routing` speak Esri's ArcGIS location services only (token/credit metering applies); Honua's providers are pluggable across open services.

## Time to first map

One scripted, reproducible measurement — from *nothing installed* to a working map against
the deterministic fixture lane (mock GeoServices server; **no live endpoints**):

| Phase | What is measured | Time |
| --- | --- | ---: |
| Cold install | `npm install @honua/sdk-js` (v0.1.0-beta.0) into a fresh temp project with an empty npm cache | 14.0 s |
| First map | rendered-map-ready in headless Chromium (all five quickstart journey stages complete and a MapLibre canvas mounted) | 7.5 s |
| **Total** | | **21.4 s** |

Reference run: 2026-07-13, Node v24.7.0, win32/x64,
22 logical CPUs, lane `browser-first-map`. Exact definition of the measured signal:

> Cold `npm install @honua/sdk-js` (empty npm cache) in a fresh temp project, plus: build the deterministic maplibre-quickstart fixture-lane example, serve it with the mock GeoServices server, and wait in headless Chromium for the rendered-map-ready signal (all five journey stages complete and a MapLibre canvas mounted). No live endpoints.

Reproduce on your machine from a clean checkout:

```bash
npm ci
npm run bench:ttfm            # prints install / first-map / total; evidence JSON in test-results/
```

**Caveats, stated plainly.** The figure is machine-, network-, and registry-dependent — treat
it as a reference point and rerun it locally, not as a guarantee. The mock lane deliberately
excludes live-service latency (that is the point: it measures the SDK + toolchain path, not
someone's server). When Chromium is unavailable the script falls back to the
`node-first-query` lane and the evidence says exactly that — install + fixture-server ready +
first successful query, with no browser rendering claimed.

## Methodology and freshness

Every number on this page is regenerable from a clean checkout with one command:

| Figure | Regenerate with |
| --- | --- |
| Honua per-entrypoint sizes | `npm run report:bundle-sizes` (budgets enforced in CI by `npm run verify:bundle-budgets`) |
| `maplibre-gl` engine size | measured from the pinned `node_modules/maplibre-gl` during `npm run docs:comparison` |
| Protocol lanes (Honua column) | derived from [`docs/protocol-capability-matrix.md`](./protocol-capability-matrix.md) during `npm run docs:comparison` |
| Time to first map | `npm run bench:ttfm -- --write-reference` |
| This page | `npm run docs:comparison` |

This file is **generated** (`scripts/generate-comparison-page.mjs`) and CI fails when it is
hand-edited or stale (`npm run docs:comparison:check`), mirroring the README's
generated-bundle-table discipline. External figures are cited claims with pinned source URLs
and retrieval dates in the generator source — update them there, with a new date, or not at
all.

## Try it

- [60-second quickstart](../README.md#60-second-quickstart) — public endpoint in, typed features out.
- [`standalone-quickstart`](./standalone-quickstart.md) — the CI-kept-green, server-optional example: any public GeoServices endpoint → styled MapLibre map.
- [Demo gallery](https://honua-io.github.io/honua-sdk-js/gallery.html) — all runnable examples.
