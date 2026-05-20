# ArcGIS JS SDK → Honua JS SDK migration punch list

This is an honest accounting of where the Honua JS SDK's two
public-facing claims stand:

1. **"Parity with the ArcGIS JS SDK"** — the symbol surface app
   authors can `import` and call against.
2. **"Automated app conversion"** — the `src/migration` codemod that
   rewrites ArcGIS imports/constructors to Honua compat shims.

It is intentionally written so a reader can tell what is shipped,
what is *partial*, and what is *not started*. None of the entries
below are aspirational — they are concrete work items.

---

## What is true today

### Parity surface (`src/esri-compat/`)

The compat module ships shims for the constructors enumerated in
`src/migration/codemod.ts::SUPPORTED_ARCGIS_MODULE_KIND_BY_PATH`.
Every kind in that map has a row in `parity-matrix.ts`, and every
row is asserted by `test/migration-parity-matrix.test.ts`. The
shims back onto real Honua surfaces in `src/core/` (HonuaClient,
HonuaFeatureService, HonuaImageService, HonuaMapService, …) rather
than being throwaway no-ops. Specifically:

- 2D `FeatureLayer`, `GraphicsLayer`, `GroupLayer`, `MapImageLayer`,
  `TileLayer`, `RouteLayer`, `Basemap`, `VectorTileLayer`,
  `GeoJSONLayer`, `WMSLayer`, `WFSLayer`, `ImageryLayer`
- `Graphic`, `Point`, `Polyline`, `Polygon`, `Extent`,
  `SpatialReference`, `Color`, `FeatureSet`
- Symbols: `SimpleLineSymbol`, `SimpleMarkerSymbol`,
  `PictureMarkerSymbol`, `TextSymbol`, `LabelClass`,
  `SimpleFillSymbol`
- Renderers: `SimpleRenderer`, `UniqueValueRenderer`,
  `ClassBreaksRenderer`
- Views: `Map`, `MapView`, `SceneView` (2D-only behavior),
  `WebMap`
- Widgets (deterministic 2D-only set): `Home`, `BasemapToggle`,
  `BasemapGallery`, `BasemapLayerList`, `LayerList`, `Legend`,
  `Popup`, `Search`, `Track`, `Swipe`, `Feature`,
  `FeatureForm`, `FeatureTemplates`, `FeatureTable`,
  `DistanceMeasurement2D`, `AreaMeasurement2D`, `Compass`,
  `Fullscreen`, `Zoom`, `Attribution`, `ScaleBar`, `Locate`,
  `Bookmarks`, `Print`, `Sketch`, `Editor`, `Expand`, `TimeSlider`,
  `Directions`, `CoordinateConversion`, `Measurement`
- Tasks & support: `RouteTask`, `Query`, `OAuthInfo`,
  `IdentityManager`, `esriRequest`, `esriConfig`, `reactiveUtils`,
  `FeatureFilter`

The `MapViewLayerViewCompat` returned from `view.whenLayerView()`
now carries `filter` / `effect` / `visible` state and forwards
filter predicates through `queryFeatures` / `queryFeatureCount` /
`queryObjectIds`, merging `where`, `objectIds`, `geometry`,
`spatialRelationship`, and `timeExtent` with any per-call options
(layer-view filter ∧ caller-provided options).

### Automated app conversion (`src/migration/codemod.ts`)

The codemod is a real AST rewriter built on the TypeScript Compiler
API (it does **not** use regex). It:

- Detects `import { X } from "@arcgis/core/..."` and rewrites
  bindings to the matching `XCompat` symbol from `esri-compat`.
- Detects `new X(opts)` for every kind above and rewrites to the
  compat constructor when the option literal is "safe" — i.e.,
  a top-level object literal whose properties are all in the
  per-kind allowlist (`FEATURE_LAYER_ALLOWED_PROPS`,
  `MAP_VIEW_ALLOWED_PROPS`, …). The new layer kinds added in this
  pass — `feature-filter`, `vector-tile-layer`, `geojson-layer`,
  `wms-layer`, `wfs-layer`, `imagery-layer` — go through the same
  `isSafeAllowedPropertiesCall` switch and gain TODO annotations on
  unsafe call sites.
- Emits `manualTodos` and `manualTodoReasons` on a `byKind` matrix
  for every untouched call site, so app authors can drive cleanup
  against a checklist.
- Emits a parity report (`src/migration/report.ts`) with three
  gates (`no-manual-todos`, `no-unhandled-modules`,
  `no-blocking-flags`) and a readiness verdict.
- Knows the `esri-leaflet` migration target as a separate column,
  with `ESRI_LEAFLET_COMPAT_FALLBACK_KINDS` gating which kinds are
  treated as deterministic vs. assisted.
- Knows the `honua-maplibre` migration target as a third column,
  gated by `HONUA_MAPLIBRE_NATIVE_KINDS` (`feature-layer`,
  `map-image-layer`, `tile-layer`, `map`, `map-view`). The native
  rewrite emits `@honua/sdk-js/map` helpers plus MapLibre
  style/layer objects instead of compat shims; everything outside
  that set falls through to a manual TODO. See
  [`docs/migration-honua-maplibre.md`](./migration-honua-maplibre.md)
  for the per-target rewrite surface, CLI invocations, report
  fields, and the manual-gap list against issue #205.

Everything in this section is covered by tests under `test/`
(`migration-codemod.test.ts` is 75 cases; `migration-report.test.ts`,
`migration-gating.test.ts`, and `migration-parity-matrix.test.ts`
hold the surface stable).

---

## What the claim does **not** yet cover

### Parity gaps

1. **3D / SceneView.**
   `SceneView` exists as a compat class but it shares the 2D
   `MapView` behavior under the hood. Anything that requires a
   WebGL/CesiumJS path (`environment`, `viewingMode: "global"`,
   `goTo` with altitude, `Ground`, `ElevationLayer`, scene layers,
   `Camera`, `qualityProfile`) is not implemented. The codemod
   sets the `scene-3d-detected` blocking flag when it sees such
   imports, so the gate fails closed.
2. **Scene layers.** `SceneLayer`, `BuildingSceneLayer`,
   `IntegratedMeshLayer`, `PointCloudLayer`, `MeshLayer`,
   `ElevationLayer`, `VoxelLayer` have no shims. These all need
   server-side glTF/I3S support (`honua-server` ticket).
3. **`Locator` / `Geoprocessor` / `NetworkAnalyst` (beyond
   RouteTask).** Today only `RouteTask` is shimmed against
   `HonuaRouteService`. The remaining task surfaces (geocoding,
   service-area, OD-cost-matrix, closest-facility,
   non-network geoprocessing) need their own surfaces under
   `src/core/` and matching compat classes.
4. **`Query` argument depth.** *Shipped (Task E).* The codemod now
   deep-transforms `new Query({...})` argument literals into the
   Honua `QueryFeaturesRequest` shape: renames `start` →
   `resultOffset`, `num` → `resultRecordCount`, `outSpatialReference`
   → `outSr`, `spatialRelationship` → `spatialRel`; splits
   `geometry: { type, ...rest }` into a sibling `geometryType`
   field with the matching `esriGeometry*` enum value; and
   lowercases `outStatistics[i].statisticType` against the
   STATISTIC_TYPE_MAP keyset (count/sum/min/max/avg/stddev/var).
   Divergent / dynamic shapes emit a manual TODO with a precise
   reason — specifically: `timeExtent` (no Honua field; use
   `extraParams.time`), `quantizationParameters` (server-side
   optimization with no Honua equivalent), `relationParam` (no
   Honua support), `geometry` without a string-literal `type`
   discriminator, and `outStatistics` items with a non-literal
   `statisticType` or an unknown enum value. The shim
   `QueryCompat` accepts either ArcGIS or Honua property
   spellings (`spatialRelationship` / `spatialRel`,
   `outSpatialReference` / `outSr`, `num` / `resultRecordCount`,
   `start` / `resultOffset`) so codemod output and hand-written
   callers both validate.
5. **Popup actions / popup templates with `actions`,
   `outFields: ["*"]` expansions, and `fieldInfos` formatters.**
   These rewrite cleanly only for the simple case; arrow-function
   field-info `format` callbacks fall through to manual TODO.
6. **Widget UI behavior.** The widget shims accept the same
   constructor options ArcGIS does, but they render through the
   Honua widget host (`HonuaWidgetHost`). Visual parity (icons,
   ARIA, CSS class names that downstream apps style against) is
   **not** byte-identical. Apps that rely on
   `calcite-action--`-prefixed selectors will need style work.
7. **`reactiveUtils.watch` semantics (partial).** Compat `watch` is
   property-name-based and synchronous. ArcGIS `watch` accepts an
   accessor function and returns a `WatchHandle` with `pause()` /
   `resume()`. Single-property accessors —
   `reactiveUtils.watch(() => view.scale, h)` where `view` is a
   tracked compat instance — are now rewritten by the codemod to
   `reactiveUtils.watch(view, "scale", h)`. Multi-property accessors
   (`() => [view.scale, view.zoom]`) and complex bodies still fall
   through to a manual TODO. `pause()` / `resume()` on the handle
   is still unsupported.

### Codemod gaps

These are the load-bearing pieces required to turn "rewrites
known constructors" into "automated app conversion":

1. **Event-name remap (Task D, partial).**
   The codemod now rewrites well-known divergent event names on
   `.on()` and `.watch()` calls in files that have at least one
   ArcGIS import being touched. The dictionary is in
   `ARCGIS_TO_COMPAT_EVENT_REMAP` in `src/migration/codemod.ts`
   and currently covers `layerview-create*`, `layerview-destroy`,
   `visibility-change`, `extent-change`, `rotation-change`,
   `scale-change`, `zoom-change`, `center-change`,
   `spatial-reference-change`, `padding-change`,
   `constraints-change`, `highlight-options-change`,
   `basemap-change`, `ground-change`, `portal-item-change`,
   `active-basemap-change`, `camera-change`,
   `quality-profile-change`, `viewing-mode-change`, and `refresh`.
   Receiver-aware scoping is now in place: the rewrite only fires
   when the receiver is an Identifier whose binding came from
   `new XCompat(...)` where `X` was a tracked ArcGIS import (via
   `resolveAssignedIdentifierForNewExpression`). Receivers that
   don't trace back to a tracked compat instance (e.g.,
   `someEmitter.on("layerview-create", h)`) are left alone even
   when the file has ArcGIS imports. What is still missing:
   pointer/keyboard event handlers (`click`, `pointer-down`,
   `key-down`, …) which compat doesn't emit yet.
2. **Dynamic / CJS imports (Task F, partial).**
   Dynamic ESM imports (`import("@arcgis/core/...")`) are
   rewritten through the `isArcGisDynamicImportCall` pass and have
   test coverage for SceneView, esriConfig, esriRequest, and
   IdentityManager. CommonJS `require("@arcgis/core/...")` is now
   auto-rewritten for the `honua-compat` target when constructor
   options are safe: the codemod emits
   `const { XCompat } = require("@honua/sdk-esri-compat");` and
   rewrites `new X(opts)` to `new XCompat(opts)` in `.cjs` files
   and `.js` files containing CommonJS markers. The original
   `const X = require("@arcgis/core/...")` declaration is now
   pruned when no other references to `X` remain in the file
   (constructor calls are the only references in the typical case;
   the codemod scans for non-constructor uses and preserves the
   require if it sees any). The `esri-leaflet` target still emits
   a manual TODO for CJS require constructors.
3. **Module re-exports beyond the registered set.** The codemod
   already follows `localArcGisReExports` for one level. Deeper
   barrel-file chains (`./esri.ts` → `./layers/index.ts` → …)
   aren't followed.
4. **`view.map.add(layer)` argument-shape transformations.**
   When a `new FeatureLayer({ ... })` is rewritten, its option
   literal is passed through verbatim. We do **not** translate
   ArcGIS-shaped properties whose Honua-side names differ
   (e.g., `renderer.field` casing, `popupTemplate.content` block
   shapes). The shim accepts the ArcGIS shape at runtime, but
   the report should flag known-divergent property values so app
   authors can confirm intent.
5. **WebMap JSON → MapLibre style derivation (`honua-maplibre`
   target).** *Partially shipped.* `src/map/webmap-maplibre.ts`
   exposes `webmapJsonToMapLibreStyle(webmap, options)`, a pure
   converter that delegates the heavy lifting to the existing
   `src/webmap/` pipeline — `parseWebMap` orchestrates
   `convertBasemap`, `convertOperationalLayer`, `convertRenderer`,
   `convertPopupInfo`, `convertLabelingInfo`, and
   `convertExtent`/`convertInitialViewpoint` — and returns a
   `HonuaStyleSpecification` ready for `map.setStyle(...)` plus a
   structured `manualGaps: WebMapMapLibreManualGap[]` array.
   `manualGaps` is the single source of truth for unsupported
   constructs: every entry carries `{ kind, reason, path?,
   layerId?, expression?, context? }` and the `kind` taxonomy
   covers `arcade-expression` (popup `expressionInfos` and complex
   Arcade label expressions), `unsupported-renderer` (heatmap,
   dotDensity, and any other renderer the converter doesn't
   handle), `scene-3d` (top-level `ground` / `camera` /
   `viewingMode`, `ArcGISSceneServiceLayer`, `elevationInfo`,
   `heightInfo`, `sceneProperties`), `dashboard-reference`,
   `experience-builder-reference`, `custom-widget-reference`
   (`applicationProperties.viewing.widgetsOnScreen` and the
   top-level `widgets` array used by host shells), plus
   pass-throughs for `unsupported-symbol`,
   `unsupported-layer-type`, `unsupported-feature-collection`, and
   `unsupported-webmap-version`. **What still requires manual
   review:** the codemod does **not** yet wire this converter into
   its import-rewriting pass — apps that call ArcGIS WebMap
   loaders (`WebMap.load()`, `WebMap({ portalItem })`) still hit
   the existing `web-map` compat shim, not the MapLibre style
   path; the gap surface is also intentionally honest about its
   ceiling, since Arcade execution, scene/3D rendering, Dashboard
   widget hosts, Experience Builder pages, and custom-widget
   plugins all require runtime support the JS SDK cannot
   synthesize from JSON alone. Each emitted gap is a `// TODO`
   anchor for an app author, not a promise of automated
   migration.
6. **End-to-end demo conversion.** Shipped at
   `examples/arcgis-source-app/` + `test/migration-e2e.test.ts`.
   The sample is a hand-written parcel viewer exercising
   `FeatureLayer` (with `outFields` + `popupTemplate`), `Map`,
   `MapView`, an untouched `view.on("click", …)` handler, and an
   event-name-remapped `layer.on("layerview-create", …)` handler.
   The e2e test copies it into a tempdir, runs the codemod with
   `target: "honua-compat"`, asserts every expected rewrite landed
   and the readiness gate is `"ready"`, and then runs `tsc
   --noEmit` against the migrated source with `paths` resolving
   `@honua/sdk-esri-compat` to the workspace `src/esri-compat/`
   entry. The CI job runs this harness immediately after the unit
   test step. Remaining work: extend the sample to additional
   layer kinds (Imagery / VectorTile / WMS / WFS / GeoJSON) so
   the harness exercises the full surface, not just the parcel
   viewer slice.

---

## What's required to make the claim defensibly true

In rough effort order:

| Bucket | Effort | Notes |
| --- | --- | --- |
| Codemod event-name remap (Task D) | 1–2 days | Pure JS-side work; needs an event-name dictionary plus AST pass. |
| Codemod dynamic-import + CJS (Task F) | 1–2 days | Mirror the static-ESM path; care needed for awaited dynamic imports' destructuring. |
| ~~Query argument deep-transform (Task E)~~ | ~~3–5 days~~ | Shipped: codemod renames `start`/`num`/`outSpatialReference`/`spatialRelationship`, splits `geometry` into `geometry`+`geometryType`, normalizes `outStatistics[i].statisticType` against `STATISTIC_TYPE_MAP`, and emits precise manual TODOs for `timeExtent`, `quantizationParameters`, `relationParam`, dynamic statisticType, and geometry without a literal `type`. `QueryCompat` accepts both ArcGIS and Honua property spellings. |
| Locator + Geoprocessor compat (Task C) | 1–2 weeks | Requires `HonuaGeocodeService`, `HonuaGeoprocessService` surfaces (server work). |
| Scene-layer compat (Task A-rest) | 4–8 weeks | Requires I3S/glTF pipeline on `honua-server`; not pure-JS work. |
| ~~E2E demo conversion harness (Task I)~~ | ~~1 week~~ | Shipped: `examples/arcgis-source-app/` + `test/migration-e2e.test.ts`, wired into the JS SDK CI workflow after the unit-test step. |

With the first three rows (Tasks D/F/E) now shipped, "automated app
conversion" reaches deterministic constructor rewrite + event-name
remap + dynamic/CJS imports + Query argument deep-transform, plus a
manual-TODO report for everything else. The remaining rows
(Locator/Geoprocessor and Scene-layer compat) still gate the
unqualified "parity with ArcGIS JS SDK" claim — that should remain
qualified as "deterministic 2D parity; scene/3D and advanced tasks
remain assisted migration" until they land.
