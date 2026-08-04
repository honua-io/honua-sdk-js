<!-- GENERATED FILE - DO NOT EDIT.
     Sources of truth: config/oss-arcgis-corpus.v1.json
                       docs/data/oss-arcgis-corpus-readiness.v1.json
     Regenerate with: npm run docs:oss-arcgis-corpus -->

# Third-party open-source ArcGIS app readiness

Every other migration number Honua publishes comes from Honua-authored fixtures. This page does not: it reports what `honua-migrate` does to **real, third-party, open-source ArcGIS JS applications** that were written by other people, for their own purposes, with no knowledge of the codemod.

The corpus pins 6 public GitHub repositories at an exact commit with a reviewed permissive license. No third-party source is vendored here — the lane clones into an ignored scratch directory, analyzes the working copy, and keeps only the structured records below.

- Observation generated: `2026-08-03T22:19:37.390Z`
- Manifest revision: `2026-08-03`
- Codemod target: `honua-compat`
- Lane: opt-in only (`HONUA_OSS_ARCGIS_CORPUS_ENABLED=true`), never part of pull-request CI, static analysis only (no live Esri service contact).

## Corpus totals

| Metric | Value |
| --- | --- |
| Apps pinned | 6 |
| Apps observed | 6 |
| Apps errored | 0 |
| Readiness `ready` / `assisted` / `blocked` | 3 / 3 / 0 |
| Codemod-scoped call sites | 64 |
| Auto-migrated call sites | 54 |
| Auto-migrated call-site ratio | 84.4% |
| ArcGIS module hits outside codemod scope | 4 |
| Apps with no ArcGIS usage detected | 3 |

### Detection gaps

The scanner found **no ArcGIS usage at all** in the apps below, even though each one was reviewed and recorded with evidence paths proving it uses the ArcGIS JS API. Their readiness values are therefore meaningless — a `ready` verdict here means *the scanner saw nothing*, not *there is nothing to do*. This is the honest headline of this page: the corpus reproduces the migration cliff a legacy AMD app walks into.

- **CMV — Configurable Map Viewer** — 136 source files scanned, 0 with a recognized ArcGIS import. Reviewed evidence: `viewer/js/config/viewer.js`, `viewer/js/gis/dijit/Basemaps.js`, `viewer/index.html`.
- **WSDOT Bridge Vertical Clearance** — 1 source file scanned, 0 with a recognized ArcGIS import. Reviewed evidence: `src/main.ts`, `index.html`, `package.json`.
- **National Park Visits explorer** — 23 source files scanned, 0 with a recognized ArcGIS import. Reviewed evidence: `app/main.ts`, `app/widgets.ts`, `index.html`.

### Top manual-TODO kinds across the corpus

| Kind | Manual TODOs |
| --- | --- |
| `polygon-geometry` | 3 |
| `graphic` | 2 |
| `map-view` | 2 |
| `basemap` | 1 |
| `feature-layer` | 1 |

## Per-app readiness

| App | Styles | Readiness | Auto-migrated | Manual TODOs | Unhandled hits | Blocking flags |
| --- | --- | --- | --- | --- | --- | --- |
| [CMV — Configurable Map Viewer](#cmv--configurable-map-viewer) | `amd-require`, `widget-heavy` | `ready` (not meaningful) | no usage detected | 0 | 0 | — |
| [WSDOT Bridge Vertical Clearance](#wsdot-bridge-vertical-clearance) | `amd-require`, `featurelayer-centric`, `widget-heavy` | `ready` (not meaningful) | no usage detected | 0 | 0 | — |
| [National Park Visits explorer](#national-park-visits-explorer) | `amd-require`, `widget-heavy` | `ready` (not meaningful) | no usage detected | 0 | 0 | — |
| [Utah statewide parcel viewer](#utah-statewide-parcel-viewer) | `featurelayer-centric` | `assisted` | 85.4% (41/48) | 7 | 2 | — |
| [Utah Bikeways / WFRC bike map](#utah-bikeways--wfrc-bike-map) | `featurelayer-centric`, `widget-heavy` | `assisted` | 77.8% (7/9) | 2 | 1 | — |
| [Owls of Bavaria](#owls-of-bavaria) | `featurelayer-centric` | `assisted` | 85.7% (6/7) | 1 | 1 | — |

## App detail

### CMV — Configurable Map Viewer

A long-running community-maintained configurable ArcGIS JS 3.x viewer built on Dojo `dijit` widgets. Local governments deploy it as-is with a JSON config; it is the single most representative example of the legacy AMD viewer a migrating team actually owns.

- Author: The Configurable Map Viewer community project (`civic-tech`)
- Repository: <https://github.com/cmv/cmv-app>
- Pinned commit: `8b42b2336b1a4b357dda791c8e492b9612a5f51b`
- License: `MIT` — https://github.com/cmv/cmv-app/blob/8b42b2336b1a4b357dda791c8e492b9612a5f51b/LICENSE
- Observed: 2026-08-03
- Scan root: `viewer/js`

```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"
filesScanned=136 filesWithArcGisImports=0 importCount=0 esriLeafletImportCount=0 topSymbols=[] flags=[none]
```

> **Detection gap.** 136 source files were scanned and none produced a recognized ArcGIS import, so no codemod-scoped call site exists to migrate or count. Every metric below is a measurement of the scanner's blind spot, not of this app.

| Metric | Value |
| --- | --- |
| Readiness | `ready` (not meaningful — see above) |
| Files scanned | 136 |
| Files importing ArcGIS modules | 0 |
| Codemod-scoped call sites | 0 |
| Auto-migrated call-site ratio | 0.0% |
| Manual-rewrite ratio | 0.0% |
| Manual-intervention ratio | 0.0% |
| Widget sites (automated / assisted / manual) | 0 / 0 / 0 |
| Widget gate (`--gate 0`) | pass at 100.0% automated |

### WSDOT Bridge Vertical Clearance

A production state-DOT lookup tool that lets freight operators find bridge vertical clearances along a route. Classic ArcGIS JS 3.25 with `esri/map`, `esri/layers/FeatureLayer`, `esri/tasks/query`, and `esri/dijit` widgets, written in TypeScript against `@types/arcgis-js-api`.

- Author: Washington State Department of Transportation, GIS Office (`government`)
- Repository: <https://github.com/WSDOT-GIS/bridge-clearance-app>
- Pinned commit: `f07daaf455ac7c625c2d283c8d9df1e94665e4ea`
- License: `Unlicense` — https://github.com/WSDOT-GIS/bridge-clearance-app/blob/f07daaf455ac7c625c2d283c8d9df1e94665e4ea/UNLICENSE
- Observed: 2026-08-03
- Scan root: `src`

```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"
filesScanned=1 filesWithArcGisImports=0 importCount=0 esriLeafletImportCount=0 topSymbols=[] flags=[none]
```

> **Detection gap.** 1 source file was scanned and none produced a recognized ArcGIS import, so no codemod-scoped call site exists to migrate or count. Every metric below is a measurement of the scanner's blind spot, not of this app.

| Metric | Value |
| --- | --- |
| Readiness | `ready` (not meaningful — see above) |
| Files scanned | 1 |
| Files importing ArcGIS modules | 0 |
| Codemod-scoped call sites | 0 |
| Auto-migrated call-site ratio | 0.0% |
| Manual-rewrite ratio | 0.0% |
| Manual-intervention ratio | 0.0% |
| Widget sites (automated / assisted / manual) | 0 / 0 / 0 |
| Widget gate (`--gate 0`) | pass at 100.0% automated |

### National Park Visits explorer

A time-series visualization of US National Park visitation built on the ArcGIS JS 4.23 AMD build. Uses the TypeScript `import X = require("esri/...")` form plus Legend, Slider, Feature, and Expand widgets — the transitional 4.x-on-AMD shape many teams are still stuck in.

- Author: Kristian Ekenes (`individual`)
- Repository: <https://github.com/ekenes/national-park-visits>
- Pinned commit: `99b17289593454cc093648f7ba85b51f8ff25bad`
- License: `Apache-2.0` — https://github.com/ekenes/national-park-visits/blob/99b17289593454cc093648f7ba85b51f8ff25bad/LICENSE
- Observed: 2026-08-03
- Scan root: `app`

```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"
filesScanned=23 filesWithArcGisImports=0 importCount=0 esriLeafletImportCount=0 topSymbols=[] flags=[none]
```

> **Detection gap.** 23 source files were scanned and none produced a recognized ArcGIS import, so no codemod-scoped call site exists to migrate or count. Every metric below is a measurement of the scanner's blind spot, not of this app.

| Metric | Value |
| --- | --- |
| Readiness | `ready` (not meaningful — see above) |
| Files scanned | 23 |
| Files importing ArcGIS modules | 0 |
| Codemod-scoped call sites | 0 |
| Auto-migrated call-site ratio | 0.0% |
| Manual-rewrite ratio | 0.0% |
| Manual-intervention ratio | 0.0% |
| Widget sites (automated / assisted / manual) | 3 / 0 / 1 |
| Widget gate (`--gate 0`) | pass at 75.0% automated |

### Utah statewide parcel viewer

The public statewide parcel viewer operated by Utah's state geospatial office. React + TypeScript over `@arcgis/core` with the imperative `new EsriMap()` / `new MapView({ container })` pattern and a `FeatureLayer` per county dataset.

- Author: Utah Geospatial Resource Center (UGRC) (`government`)
- Repository: <https://github.com/agrc/parcels>
- Pinned commit: `996fd3e6a597db4996d18a607da8ece72a5b5fa0`
- License: `MIT` — https://github.com/agrc/parcels/blob/996fd3e6a597db4996d18a607da8ece72a5b5fa0/LICENSE
- Observed: 2026-08-03
- Scan root: `src`

```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"
filesScanned=11 filesWithArcGisImports=6 importCount=14 esriLeafletImportCount=0 topSymbols=[Extent:30, Graphic:14, Viewpoint:8, MapView:7, Polygon:4, FeatureLayer:2, VectorTileLayer:2, EsriMap:2, Point:2, watch:1] flags=[auth-or-request-customization-detected]
```

| Metric | Value |
| --- | --- |
| Readiness | `assisted` |
| Files scanned | 11 |
| Files importing ArcGIS modules | 6 |
| Codemod-scoped call sites | 48 |
| Auto-migrated call-site ratio | 85.4% |
| Manual-rewrite ratio | 14.6% |
| Manual-intervention ratio | 18.0% |
| Widget sites (automated / assisted / manual) | 0 / 0 / 0 |
| Widget gate (`--gate 0`) | pass at 100.0% automated |

Top manual-TODO kinds:

- `polygon-geometry` — 3
- `graphic` — 2
- `map-view` — 1
- `reactive-utils` — 1

Top ArcGIS modules outside codemod scope:

- `@arcgis/core/Viewpoint` (`static-import`) — 2

### Utah Bikeways / WFRC bike map

A public bikeway finder for the Wasatch Front. `@arcgis/core` `WebMap` + `MapView` with BasemapToggle, Home, and Track widgets, plus `@arcgis/map-components` custom elements — the modern Esri stack a 2026 migration actually meets.

- Author: Utah Geospatial Resource Center (UGRC) with the Wasatch Front Regional Council (`government`)
- Repository: <https://github.com/agrc/wfrc-bike-map>
- Pinned commit: `680bcf88b094866a096db1576f61c254f9792a39`
- License: `MIT` — https://github.com/agrc/wfrc-bike-map/blob/680bcf88b094866a096db1576f61c254f9792a39/LICENSE
- Observed: 2026-08-03
- Scan root: `src`

```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"
filesScanned=26 filesWithArcGisImports=4 importCount=10 esriLeafletImportCount=0 topSymbols=[watch:3, MapView:3, WebMap:3, Basemap:2, BasemapToggle:2, Home:2, Track:2, Graphic:2, esriConfig:1, renderPreviewHTML:1] flags=[auth-or-request-customization-detected, webmap-detected]
```

| Metric | Value |
| --- | --- |
| Readiness | `assisted` |
| Files scanned | 26 |
| Files importing ArcGIS modules | 4 |
| Codemod-scoped call sites | 9 |
| Auto-migrated call-site ratio | 77.8% |
| Manual-rewrite ratio | 22.2% |
| Manual-intervention ratio | 30.0% |
| Widget sites (automated / assisted / manual) | 3 / 0 / 0 |
| Widget gate (`--gate 0`) | pass at 100.0% automated |

Top manual-TODO kinds:

- `basemap` — 1
- `map-view` — 1

Top ArcGIS modules outside codemod scope:

- `@arcgis/core/symbols/support/symbolUtils` (`static-import`) — 1

### Owls of Bavaria

A citizen-science map of owl sightings in Bavaria sourced from iNaturalist. Small React + Redux + Vite app over `@arcgis/core` using `Map`, `MapView`, `FeatureLayer`, `GeoJSONLayer`, `Graphic`, and client-side `FeatureFilter` / `FeatureEffect`.

- Author: Lucia Johnson (`individual`)
- Repository: <https://github.com/lujoh/owls_of_bavaria>
- Pinned commit: `284949156925c63b0258aece1f48cd9e4f5ea55d`
- License: `MIT` — https://github.com/lujoh/owls_of_bavaria/blob/284949156925c63b0258aece1f48cd9e4f5ea55d/LICENSE
- Observed: 2026-08-03
- Scan root: `src`

```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"
filesScanned=15 filesWithArcGisImports=3 importCount=8 esriLeafletImportCount=0 topSymbols=[FeatureFilter:2, FeatureEffect:2, Map:2, MapView:2, GeoJSONLayer:2, FeatureLayer:2, Graphic:2, esriConfig:1] flags=[auth-or-request-customization-detected]
```

| Metric | Value |
| --- | --- |
| Readiness | `assisted` |
| Files scanned | 15 |
| Files importing ArcGIS modules | 3 |
| Codemod-scoped call sites | 7 |
| Auto-migrated call-site ratio | 85.7% |
| Manual-rewrite ratio | 14.3% |
| Manual-intervention ratio | 25.0% |
| Widget sites (automated / assisted / manual) | 0 / 0 / 0 |
| Widget gate (`--gate 0`) | pass at 100.0% automated |

Top manual-TODO kinds:

- `feature-layer` — 1

Top ArcGIS modules outside codemod scope:

- `@arcgis/core/layers/support/FeatureEffect` (`static-import`) — 1

## Reproducing this page

```bash doc-test=skip reason="shell commands for the opt-in lane, not a compilable snippet"
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true npm run corpus:oss-arcgis
npm run docs:oss-arcgis-corpus
```

See [docs/oss-arcgis-corpus.md](./oss-arcgis-corpus.md) for the manifest shape, license policy, and lane guardrails.

