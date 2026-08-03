<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run docs:comparison -->
<!-- Inputs: docs/bundle-sizes.md, docs/protocol-capability-matrix.md, docs/data/time-to-first-map.json, docs/data/competitor-evidence.v1.json, node_modules/maplibre-gl. -->
<!-- Freshness is enforced by npm run docs:comparison:check. -->

# How Honua compares

**MapLibre gives you the map. Honua gives you everything else.** `@honua/sdk-js` is a typed,
protocol-neutral geospatial *service client* and migration toolkit that rides open renderers —
it is **not** a rendering engine, so this page does not compare rendering. It compares the
things Honua actually claims: the bytes you ship, the protocols you get a real client for,
and how fast a new project reaches a working map.

Four ground rules keep this page honest:

1. **Every Honua number is generated, never hand-edited.** This whole file is produced by
   `npm run docs:comparison` from committed, regenerable inputs; CI fails when it drifts
   (`npm run docs:comparison:check`). See [Methodology](#methodology-and-freshness).
2. **Every external figure, and every operation-level cell, is a structured evidence record**,
   not prose — with a primary source URL, the version it describes, an observation date, an
   expiry, its methodology, and its metric's unit and compression. See
   [Evidence contract](#evidence-contract). The protocol-coverage table is the one exception,
   and says so where it appears.
3. **Categories are never mixed silently.** A renderer, a headless client, and an all-in-one
   SDK are different products; the boundary is named below before anything is compared.
4. **Non-goals are stated.** Esri's 3D/SceneView stack and MapLibre's rendering quality are
   not competitions we enter; see the
   [three-lanes strategy](./decisions/market-strategy-2026-three-lanes.md).

## What is being compared

Most SDK comparisons quietly compare a renderer against a data client, or swap in a smaller
package for one vendor to flatter a byte count. This page names the exact package behind every
column first, and only compares within a category — or says explicitly when it is crossing one.

| Product | Package compared | Category |
| --- | --- | --- |
| Honua SDK | `@honua/sdk-js` | Headless service clients |
| MapLibre GL JS | `maplibre-gl` (6.0.0 pinned and measured here; 6.1.0 published) | Renderer engines |
| ArcGIS Maps SDK for JavaScript | `@arcgis/core` | All-in-one renderer SDKs |
| ArcGIS REST JS | `@esri/arcgis-rest-request` | Headless service clients |
| OpenLayers | `ol` | Renderer engines |

What each category means:

- **Headless service clients.** Typed data/service clients that talk to geospatial services and hand results to a renderer they do not own. They ship no map engine, so their bytes are not comparable with a renderer's.
- **Renderer engines.** Map rendering engines (and their bundled format parsers). They draw maps; they do not provide a first-party typed client for service discovery, paging, edits, or capability negotiation.
- **All-in-one renderer SDKs.** Products that bundle a renderer AND their vendor's service client in one package. Comparing one of these against a headless client alone is category error: the honest counterpart is client + renderer together.

The consequence, stated up front: `@honua/sdk-js` ships no renderer, so its byte count is not
comparable with `@arcgis/core`'s or `ol`'s on its own. Where this page puts them near each
other it compares *Honua + MapLibre* against the all-in-one SDK, and says so at the point of
comparison.

## Bundle size

Honua per-entrypoint sizes below are projected from the generated
[`docs/bundle-sizes.md`](./bundle-sizes.md) (measured 2026-08-03 at commit `fb2ae7e4`;
esbuild `--bundle --minify`, target `es2020`, runtime peers external — the way a real consumer
builds). CI enforces a byte budget on every entrypoint (`npm run verify:bundle-budgets`).

| What you import | Minified | Gzip |
| --- | ---: | ---: |
| Full root entrypoint: connect → query → explain → mount workflow | 705.4 KiB | 188.9 KiB |
| Importing only `HonuaClient` (tree-shake guard) | 229.5 KiB | 59.0 KiB |
| Data→map bridge only: `mountSourceToMapLibre` from `/map` | 43.6 KiB | 13.3 KiB |
| Protocol-neutral contract (`Dataset`/`Source`/`Query`/`Result`) | 331.4 KiB | 88.5 KiB |
| ArcGIS compatibility layer (drop-in migration surface) | 997.0 KiB | 248.9 KiB |
| Geocoding client | 26.9 KiB | 7.6 KiB |
| Routing client | 20.5 KiB | 6.3 KiB |

For context, the rendering engine itself — `maplibre-gl` 6.0.0, measured locally from
this repo's pinned production distribution graph (`dist/maplibre-gl.mjs`, `dist/maplibre-gl-shared.mjs`, `dist/maplibre-gl-worker.mjs`) — is 1036.3 KiB minified / **273.8 KiB gzip**.
The gzip figure compresses each distributed ESM file independently, as separate HTTP responses, then sums them.
A complete Honua + MapLibre app therefore ships roughly the engine plus whichever Honua
entrypoints it imports.

A complete open stack, measured here, in one unit:

- **Minified:** engine 1036.3 KiB + Honua root 705.4 KiB ≈ **1.70 MB**.
- **Gzip:** engine 273.8 KiB + Honua root 188.9 KiB ≈ **0.45 MB**.

Both totals add figures produced by the same local harness in the same unit and compression,
which is the only arithmetic this page performs.

### Against the alternatives

**ArcGIS Maps SDK for JavaScript (`@arcgis/core`) — historical evidence, 4.30.**
Esri's automated build-metrics harness over its minimal core-sample apps across the esbuild, Angular, React, Vue, Rollup and Webpack lanes; ranges span those lanes. Published as a CSV in Esri's jsapi-resources repository and cited here at a pinned commit.
As observed 2024-06-27: the main bundle alone is 1.31–1.49 MB minified
(0.36–0.42 MB gzip), a simple map view loads
**3.5–4.1 MB of JavaScript** at startup, and the on-disk build output is
8.3–10 MB across ~300–740 files.

> **This is a historical measurement and no current claim rests on it.** 4.30 is the last release line for which Esri published core-sample build metrics in jsapi-resources, and the product has since moved to a 5.x line. The figures therefore describe a superseded version and cannot stand in for a current measurement.
> The current published line is `@arcgis/core` 5.1.15
> (observed 2026-08-02, <https://registry.npmjs.org/@arcgis/core>), which this repo has **not**
> measured. Until the same committed harness measures both products under equivalent workloads and
> units, this page states no ratio, multiple, or "smaller than" headline against `@arcgis/core` —
> the numbers above and the Honua totals are reported side by side and left uncombined.

Why they are not combined: Bundles a renderer, so the only category-correct counterpart is a headless client PLUS a renderer engine, never a headless client alone. The startup figure counts transferred JavaScript for a running sample; Honua's per-entrypoint numbers are static bundler output for an imported entrypoint. Those are different workloads under different harnesses: they may be reported side by side with this caveat, but not divided into a ratio.

Provenance — **Historical evidence.** ArcGIS Maps SDK for JavaScript `@arcgis/core` 4.30 · observed 2024-06-27, retrieved 2026-07-13, expires 2027-07-13 · primary source: <https://github.com/Esri/jsapi-resources/blob/9fe7d8cc709c5daf3a342e921e897d459955b347/core-samples/.metrics/4.30.0.csv>

**ArcGIS REST JS (`@esri/arcgis-rest-request`) — 4.10.3.** ArcGIS REST JS is Esri's lightweight, modular REST client family for ArcGIS services. It provides no map runtime; it exposes ArcGIS service metadata, paging parameters, an output-spatial-reference parameter, and applyEdits, and its geocoding and routing packages address Esri's ArcGIS location services. It exposes no query-plan/explain surface and its request helpers are stateless.
It is the one alternative here in Honua's own category, so the comparison that matters is
protocol and operation coverage (below), not bytes. If all you need is small requests against
ArcGIS-only services, it is a fine, lighter choice.

Provenance — ArcGIS REST JS `@esri/arcgis-rest-request` 4.10.3 · observed 2026-07-13, retrieved 2026-08-02, expires 2027-07-13 · primary source: <https://developers.arcgis.com/arcgis-rest-js/>

**OpenLayers (`ol`) — 10.10.0.** OpenLayers is a map rendering library that also ships format parsers (for example GeoJSON, EsriJSON, WFS/GML), tile/image sources, WMS/WMTS capabilities parsers, and built-in coordinate transforms. It provides no cross-protocol discovery contract, no service paging client, and no query-plan surface; WFS transactions are built as XML the caller sends.
A renderer engine, not a headless service client. Its footprint depends heavily on which modules a consumer tree-shakes, so no single bundle number is quoted; the category-correct comparison is operation coverage of its first-party format/source modules.

Provenance — OpenLayers `ol` 10.10.0 · observed 2026-07-13, retrieved 2026-08-02, expires 2027-07-13 · primary source: <https://openlayers.org/>

## Protocol coverage

What you get a first-party, *typed* client for — versus what you hand-roll. Honua's column is
derived from the maintained
[protocol × capability matrix](./protocol-capability-matrix.md) (per-operation detail lives
there; capability misses throw `HonuaCapabilityNotSupportedError` instead of returning empty
results). Competitor columns are deliberately coarse: ✓ first-party support, ◐ partial or
manual assembly, — not provided.

**Scope note.** Unlike the figures and the operation table below, these competitor columns are
maintained characterisations of each product's documented protocol surface, not evidence
records — treat them as orientation and check the linked products for anything load-bearing.

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

## Operation-level behaviour

A protocol checkbox is not behaviour. "Speaks WFS" says nothing about whether paging, edits,
CRS negotiation, or capability checks are done *for* you or left on your desk. This table
compares the operations themselves. Honua's column is anchored to real artifacts in this
repository — a capability-matrix operation, a shipped source file, or an exported symbol — and
generation fails if an anchor disappears, so a claim here cannot outlive its implementation.

Every competitor cell is **projected from that product's evidence record** — not written
inline here — so each column is bound to the version, primary source, and expiry shown beneath
the table, and generation fails if a record omits a row that the page renders. Cells stay
deliberately coarse: ✓ first-party, ◐ partial or caller-assembled, — not provided.

| Operation | What it means | Honua SDK | `maplibre-gl` | `@esri/arcgis-rest-request` | `ol` |
| --- | --- | --- | --- | --- | --- |
| Discovery | enumerate datasets/layers from a service root with typed metadata | ✓ typed `describe()` contract | — | ✓ ArcGIS service metadata | ◐ WMS/WMTS capabilities parsers only |
| Paging | walk a result set past the service page limit | ✓ streamed + bounded queries | — | ◐ params exposed; caller drives the loop | — |
| Edits | create/update/delete features through the protocol's transaction | ✓ GeoServices / OGC Features / WFS / OData | — | ✓ ArcGIS `applyEdits` | ◐ `ol/format/WFS` builds transaction XML |
| CRS | declare, validate, and negotiate coordinate reference systems | ✓ validated PROJJSON + per-source CRS | ◐ renders in its own display projection | ◐ output-spatial-reference parameter | ✓ built-in transforms |
| Capability negotiation | know before you call whether an operation is supported | ✓ claimed / observed / effective | — | ◐ service metadata you interpret | — |
| Planning / explainability | inspect the accepted plan before execution | ✓ `explainQuery` + `hashQueryPlan` | — | — | — |
| Rendering | draw the map | — (by design: rides a renderer) | ✓ | — | ✓ |
| Lifecycle | tear down sources, layers, and listeners deterministically | ✓ `dispose()` on the mounted bridge | ✓ `map.remove()` | — stateless requests | ✓ map/layer disposal |

Competitor columns as observed:

- `maplibre-gl` 6.1.0 — observed 2026-08-02, expires 2027-08-02, from <https://maplibre.org/maplibre-gl-js/docs/>
- `@esri/arcgis-rest-request` 4.10.3 — observed 2026-07-13, expires 2027-07-13, from <https://developers.arcgis.com/arcgis-rest-js/>
- `ol` 10.10.0 — observed 2026-07-13, expires 2027-07-13, from <https://openlayers.org/>

Read the rendering row as the point of the whole page: Honua deliberately scores `—` there.
It is a data client. The comparison it invites is on the other seven rows.

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
| Operation-level rows (Honua column) | anchored to capability-matrix operations, shipped source files, and exported symbols during `npm run docs:comparison` |
| External claims | validated from [`docs/data/competitor-evidence.v1.json`](./data/competitor-evidence.v1.json) during `npm run docs:comparison` |
| This page | `npm run docs:comparison` |

This file is **generated** (`scripts/generate-comparison-page.mjs`) and CI fails when it is
hand-edited or stale (`npm run docs:comparison:check`), mirroring the README's
generated-bundle-table discipline.

### Evidence contract

External claims — every competitor figure *and* every competitor cell in the operation table —
are not prose. Each is a record in
[`docs/data/competitor-evidence.v1.json`](./data/competitor-evidence.v1.json), validated against
[`schemas/competitor-evidence.v1.json`](../schemas/competitor-evidence.v1.json) by
`scripts/lib/competitor-evidence.mjs`. Every record must carry the product and the **exact**
package it represents, the version or release line, the claim, a primary source URL, `observedAt`,
`expiresAt`, its methodology, each metric's unit and compression, and comparability notes.

Generation — and therefore CI — **fails** when:

- a projected claim has no evidence record, or the record is missing a required field;
- a **projected** record has expired (`expiresAt` in the past);
- a record's `sourceUrl` is not under a trusted primary-source origin **for that package**.
  The trusted origins live in code (`TRUSTED_PRIMARY_SOURCE_PREFIXES`), not in the evidence
  file, so a record cannot whitelist its own source and a third-party restatement of a vendor
  number cannot pass as primary evidence. A package with no trusted entry cannot be projected;
- the page would **combine or rank metrics whose unit or compression differ** without an
  explicit rendered caveat;
- the page renders an operation row a competitor's record does not state;
- a record marked `historical` is used to support a current headline, ratio, or superiority
  claim. This is a code path, not a style guide: the generator refuses, so the page cannot say it.

Records are **immutable per observation**. Refreshing a claim adds a new record with its own
`observedAt` and repoints the generator at it; it never rewrites an existing record's provenance.
Freshness is therefore checked where it belongs — on the record actually being **published** —
so a superseded observation may remain in the file, and expire, as archived provenance without
breaking generation. That is what makes the immutability rule usable rather than a dead letter.

## Try it

- [60-second quickstart](../README.md#60-second-quickstart) — public endpoint in, typed features out.
- [`First Map`](./quickstart.md) — the CI-kept-green, server-optional example: public GeoServices or OGC Features endpoint → accepted plan → inspected MapLibre map.
- [Demo gallery](https://honua-io.github.io/honua-sdk-js/gallery.html) — all runnable examples.
