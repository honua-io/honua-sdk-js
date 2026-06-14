# `honua-maplibre` migration target

The `honua-maplibre` codemod target rewrites a curated subset of
`@arcgis/core` constructors directly into `@honua/sdk-js/map` helpers
plus MapLibre GL source/layer definitions, instead of routing them
through the Esri-shaped compat shims. It is the codemod option that
produces MapLibre-native output for apps that want to leave the
ArcGIS JS API behind end-to-end.

This page documents the slice that shipped in PR #208 (commit
`af1ebee`). It does not close issue #205 — open acceptance items are
called out under [Manual gaps](#manual-gaps).

## How it differs from the other targets

The migration codemod (`src/migration/codemod.ts`) exposes three
targets selected with `--target` on the CLI:

| Target | Output shape | What it rewrites natively |
| --- | --- | --- |
| `honua-compat` (alias `honua`) | `@honua/sdk-esri-compat` shims that mimic the ArcGIS JS API surface | Every kind in `REWRITE_SPECS` (`SUPPORTED_ARCGIS_MODULE_KIND_BY_PATH`) — full 2D constructor surface (layers, views, widgets, controls, tasks, support). |
| `honua-maplibre` | `@honua/sdk-js/map` helpers + raw MapLibre style/layer objects | The five kinds in `HONUA_MAPLIBRE_NATIVE_KINDS`: `feature-layer`, `map-image-layer`, `tile-layer`, `map`, `map-view`. Everything else still falls through to a manual TODO. |
| `esri-leaflet` | Mixed esri-leaflet primitives + compat fallback | `feature-layer`, `map-image-layer`, `tile-layer` natively; the remaining 2D surface via `ESRI_LEAFLET_COMPAT_FALLBACK_KINDS`. |

`honua-compat` is the broadest deterministic option — it covers the
full `REWRITE_SPECS` matrix and is the default. `honua-maplibre`
trades surface coverage for a MapLibre-native output: it only emits
native helpers for the layer/map/view core, and everything else
(widgets, controls, renderers, geometry constructors, tasks)
becomes a manual TODO because there is no `@honua/sdk-js/map`
helper for it yet. `esri-leaflet` sits in between — three native
layer kinds with a compat fallback for the rest.

## Auto-migrated, assisted, and unsupported kinds

The exact set of kinds the `honua-maplibre` target rewrites natively
is defined in `src/migration/codemod.ts` as
`HONUA_MAPLIBRE_NATIVE_KINDS` and consumed by
`TARGET_SUPPORTED_KINDS["honua-maplibre"]`:

- `feature-layer` (`@arcgis/core/layers/FeatureLayer`) →
  `createHonuaFeatureServiceLayer({ url, ... })` returning a
  `HonuaFeatureServiceSourceSpecification` plus a default MapLibre
  render layer (`circle`/`line`/`fill` chosen via `layerType`).
- `map-image-layer` (`@arcgis/core/layers/MapImageLayer`) →
  `createHonuaMapServiceLayer({ url, ... })` returning a
  `HonuaMapServiceSourceSpecification` plus a default raster render
  layer.
- `tile-layer` (`@arcgis/core/layers/TileLayer`) →
  `createHonuaTileServiceLayer({ url, ... })` returning a MapLibre
  raster source pointing at `<url>/tile/{z}/{y}/{x}` plus a raster
  render layer.
- `map` (`@arcgis/core/Map`) → `createHonuaMapLibreStyle({ basemap,
  layers, ... })` returning a `HonuaStyleSpecification` (MapLibre
  style version 8) that aggregates the migrated layers' sources and
  layers.
- `map-view` (`@arcgis/core/views/MapView`) →
  `createHonuaMapLibreMapOptions({ container, style, center, zoom,
  bearing, pitch })`, the options bag passed to
  `new maplibregl.Map(...)`.

The helper signatures live in `src/map/maplibre-target.ts`.

### Rendering feature-service layers (custom source → `geojson`)

`createHonuaTileServiceLayer` and `createHonuaMapServiceLayer` emit
MapLibre-native `raster` sources that render as soon as you add them to
a map. `createHonuaFeatureServiceLayer` is different: its `source` uses
the custom `honua-feature-service` type, which MapLibre's renderer does
not understand. Adding that source to a `maplibre-gl` `Map` directly is
a silent no-op — no error, no features.

To render feature-service layers, run them through the MapLibre runtime
adapter exported from `@honua/sdk-js/map`. It fetches features via the
SDK query path and produces a standard `geojson` source MapLibre renders
natively:

```ts
import maplibregl from "maplibre-gl";
import { HonuaClient } from "@honua/sdk-js";
import {
  createHonuaFeatureServiceLayer,
  loadHonuaFeatureServiceGeoJson,
} from "@honua/sdk-js/map";

const client = new HonuaClient({ baseUrl: "https://gis.example.com" });
const layer = createHonuaFeatureServiceLayer({ url, outFields: ["*"] });

// Replace the custom honua-feature-service source with a fetched geojson source.
const source = await loadHonuaFeatureServiceGeoJson(client, layer.source.url);
map.addSource(layer.sourceId, source);
map.addLayer(layer.layer);
```

For a whole `HonuaMap`, `registerHonuaFeatureServiceSources(map, honuaMap,
client)` walks every `honua-feature-service` source and live-patches it
on the MapLibre map (adding a new `geojson` source or calling `setData`
on an existing one). Both helpers live in
`src/map/feature-service-adapter.ts`.

Every other constructor kind in `REWRITE_SPECS` — geometries,
symbols, renderers, `WebMap`, `SceneView`, `GraphicsLayer`,
`GroupLayer`, `VectorTileLayer`, `GeoJSONLayer`, `WMSLayer`,
`WFSLayer`, `ImageryLayer`, `FeatureFilter`, all widgets (`LayerList`,
`Legend`, `Popup`, `Search`, `Sketch`, `Editor`, `TimeSlider`, …),
all controls (`Home`, `Zoom`, `Compass`, `ScaleBar`, `Fullscreen`,
`BasemapToggle`, …), `Query`, `OAuthInfo`, `IdentityManager`,
`esriRequest`, `esriConfig`, `reactiveUtils`, `RouteTask`, etc. —
is **not** in `HONUA_MAPLIBRE_NATIVE_KINDS`. The codemod emits a
manual TODO with a reason at each call site and lists the unhandled
ArcGIS module under `unhandledArcGisModules` in the report. The
runtime parity matrix
(`src/migration/runtime-matrix.ts::inferHonuaMapLibreRuntimeStatus`)
categorizes these surfaces as `assisted` for `honua-maplibre`,
except for the `feature-layer`, `map-image-layer`, and the
`map-view.navigation-go-to` capability which are tagged `native`.

Use the canonical fixture
[`test/fixtures/esri-maplibre-simple-app/`](../test/fixtures/esri-maplibre-simple-app/src/main.ts)
as a worked example — it imports `Map`, `MapView`, `FeatureLayer`,
`MapImageLayer`, and `TileLayer` from `@arcgis/core` and exercises
exactly the kinds that `honua-maplibre` can rewrite natively.

## CLI flag and invocations

The codemod is selected with `--target honua-maplibre` on the
`codemod`, `fixtures`, and `demo` subcommands of
`node dist/src/migration/cli.js`. The accepted target tokens are
`honua` (alias of `honua-compat`), `honua-compat`, `honua-maplibre`,
and `esri-leaflet` — anything else is rejected by the parser.

```bash
# Dry-run the codemod against the bundled MapLibre fixture
node dist/src/migration/cli.js codemod test/fixtures/esri-maplibre-simple-app \
  --target honua-maplibre \
  --report reports/maplibre-fixture-report.json

# Write the rewrite in place with inline TODOs for manual sites
node dist/src/migration/cli.js codemod test/fixtures/esri-maplibre-simple-app \
  --target honua-maplibre \
  --write --annotate-todos \
  --report reports/maplibre-fixture-report.json

# Run the codemod against the hand-written parcel viewer example
node dist/src/migration/cli.js codemod examples/arcgis-source-app \
  --target honua-maplibre \
  --report reports/arcgis-source-app-maplibre-report.json

# Per-fixture readiness metrics for a single MapLibre fixture, no gating
node dist/src/migration/cli.js fixtures test/fixtures \
  --target honua-maplibre \
  --fixtures esri-maplibre-simple-app \
  --report reports/maplibre-fixture-metrics.json
```

The shared codemod flags (`--write`, `--annotate-todos`,
`--report <path>`, `--compat-import-path <pkg>`, `--fail-on-manual`,
`--fail-on-unhandled`, `--fail-on-blocked`, `--max-manual-ratio`,
`--max-manual-intervention-ratio`) all apply unchanged. With
`--target honua-maplibre` the codemod only rewrites the five native
kinds; manual TODOs and unhandled-module entries are expected to
appear for any constructor outside that set, and gating flags like
`--fail-on-manual` will fail closed against apps with widgets,
renderers, or non-2D-core surfaces.

## Migration report fields

The report writer is `buildJsMigrationReport`
(`src/migration/report.ts`); its `JsMigrationReport` shape is what
gets written to the path passed to `--report`. The fields you can
key off when consuming a `honua-maplibre` report are:

- `codemodTarget`: `"honua-maplibre"` for runs launched with
  `--target honua-maplibre`. The union is
  `"honua-compat" | "esri-leaflet" | "honua-maplibre"`.
- `rootDir`: absolute path of the codemod root that was scanned.
- `scanSummary` / `scanReport`: the
  `scanArcGisUsage`/`summarizeArcGisScan` output (import counts,
  flags like `scene-3d-detected`, `advanced-widget-or-networking-detected`).
- `codemodResult.metrics.totalCodemodScopedCallSites`,
  `codemodResult.metrics.autoMigratedCallSites`,
  `codemodResult.metrics.manualCallSites`,
  `codemodResult.metrics.byKind[<kind>]` (per-kind
  `auto/manual/total` counts).
- `manualRewriteMetric`: `{ numerator, denominator, ratio, scope }`
  where `numerator/denominator` = manual call sites / total
  codemod-scoped call sites. `ratio` is the value compared against
  `--max-manual-ratio`.
- `manualInterventionMetric`: `{ numerator, denominator, ratio,
  scope, manualCodemodCallSites, unhandledUsageHits }` — extends the
  rewrite metric by adding `unhandledArcGisModules` hits into both
  numerator and denominator. Compared against
  `--max-manual-intervention-ratio`.
- `readiness`: `"ready" | "assisted" | "blocked"` — derived from
  `gates`. Blocking flags (`scene-3d-detected`,
  `advanced-widget-or-networking-detected`) force `blocked`.
- `gates`: array of
  `{ gate: "no-manual-todos" | "no-unhandled-modules" | "no-blocking-flags", passed, detail }`.
  These are the MapLibre readiness gates: with `honua-maplibre`,
  expect `no-manual-todos` and `no-unhandled-modules` to fail on any
  app that uses widgets, renderers, geometry constructors, or other
  kinds outside `HONUA_MAPLIBRE_NATIVE_KINDS`.
- `manualTodos`: per-call-site `{ file, line, column, kind, reason,
  difficulty? }`.
- `manualTodoReasons`: rolled-up reasons sorted by count, each with
  a `kinds` list — useful for grouping cleanup work by category.
- `manualTodosByKind`: dense map of every `CodemodConstructorKind`
  to its manual-call-site count for this run.
- `unhandledArcGisModules`: `{ modulePath, usageStyle, count }`
  entries for ArcGIS modules outside the codemod's per-target
  supported set. `usageStyle` is `"static-import"`,
  `"dynamic-import"`, or `"require"`.

The parity matrix tooling (`matrix` / `runtime-matrix` subcommands)
also emits a `honuaMapLibre` summary block alongside `honuaCompat`
and `esriLeaflet` with `native`/`assisted`/`unsupported` counts —
see `summarizeJsParityMatrix` and `summarizeJsRuntimeParity`.

## Manual gaps

Issue #205 is a slice ladder, not a single landing. `honua-maplibre`
ships the native-rewrite path for the layer/map/view core; the
remaining acceptance items live in
[`docs/migration-punch-list.md`](./migration-punch-list.md) and stay
open until they ship. The notable ones, framed against the punch
list:

- **WebMap → MapLibre style conversion.** The `web-map` kind is not
  in `HONUA_MAPLIBRE_NATIVE_KINDS`, so `new WebMap(...)`
  constructors emit a manual TODO under this target. Server-side /
  CLI WebMap conversion lives behind the `content-webmap`
  subcommand and is tracked separately.
- **Widget visual parity.** Per the punch list "Widget UI behavior"
  entry: the compat shims accept ArcGIS option shapes but render
  through the Honua widget host with non-byte-identical visuals.
  `honua-maplibre` does not paper over this — widget constructors
  fall to manual TODO instead of being silently rewritten.
- **3D / SceneView and scene layers.** `scene-view`,
  `SceneLayer`/`BuildingSceneLayer`/`IntegratedMeshLayer`/
  `PointCloudLayer`/`MeshLayer`/`ElevationLayer`/`VoxelLayer` are
  flagged with the `scene-3d-detected` blocking flag and force
  `readiness: "blocked"`. MapLibre is 2D-only by design; 3D parity
  is not in this target's scope.
- **`Locator` / `Geoprocessor` / `NetworkAnalyst` (beyond `RouteTask`).**
  Not in `HONUA_MAPLIBRE_NATIVE_KINDS`; manual TODO with the
  unhandled-module list pointing at the missing surfaces.
- **Renderers, symbols, popup templates, `reactiveUtils.watch`,
  event-name remap, `Query` deep-transform.** These ship for
  `honua-compat` (some shipped as Tasks D/E/F in the punch list)
  but they do not exist as native MapLibre helpers — under
  `honua-maplibre` they remain manual TODO surfaces.
- **Playwright smoke / runtime evidence lane for MapLibre output.**
  Open acceptance item on #205.

For the broader migration story — including the `honua-compat`
parity surface, the codemod gates, and the test corpus — start at
[`docs/migration-punch-list.md`](./migration-punch-list.md) and the
fixture-only Esri sample corpus in
[`docs/esri-sample-corpus.md`](./esri-sample-corpus.md).
