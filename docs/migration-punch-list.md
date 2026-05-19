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
4. **`Query` argument depth.** The `Query` shim accepts the common
   property set, but the codemod's options validator currently
   allows-but-passes-through complex sub-objects
   (`statisticDefinitions`, `quantizationParameters`, etc.) without
   transforming them into the Honua-side request shape. A failing
   query at runtime is preferable to a silently-wrong query — but
   the codemod should detect these and emit a manual TODO instead
   of letting the call through.
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
7. **`reactiveUtils.watch` semantics.** Compat `watch` is
   property-name-based and synchronous. ArcGIS `watch` accepts an
   accessor function and returns a `WatchHandle` with `pause()` /
   `resume()`. Apps using accessor-style `watch(() => view.scale)`
   will be flagged but not rewritten.

### Codemod gaps

These are the load-bearing pieces required to turn "rewrites
known constructors" into "automated app conversion":

1. **Event-name remap (Task D, in progress).**
   `.on("edits", h)`, `.on("visibility-change", h)`,
   `.on("layerview-create", h)`, and a handful of others have
   different names in Honua compat (e.g.,
   `"layerview-created"` / `"layer.visibility-changed"`). The
   codemod needs a CallExpression pass that detects
   `<arcgis-bound>.on(stringLiteral, ...)` and rewrites the
   literal, plus parallel handling for `.watch()`. None of this is
   implemented yet — it requires extending `walk()` in
   `codemodFile` to track method calls on identifiers whose
   binding came from `importsByLocalName`.
2. **Dynamic / CJS imports (Task F, not started).**
   The codemod handles static ESM imports only. It does **not**
   rewrite `import("@arcgis/core/...")` (dynamic import), nor
   `require("@arcgis/core/...")`. Real apps mix both. Until those
   are handled, `filesScanned` undercounts and the
   `no-unhandled-modules` gate is unreliable for CJS code paths.
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
5. **End-to-end demo conversion.** No tooling exists in this repo
   that takes a real ArcGIS sample app and outputs a building
   honua-compat app + parity report. The codemod has unit tests
   only. The honest test of the "automated conversion" claim is
   to run the codemod against ArcGIS's own sample repo, file the
   diff into CI, and let it fail loudly when shipped code drifts.

---

## What's required to make the claim defensibly true

In rough effort order:

| Bucket | Effort | Notes |
| --- | --- | --- |
| Codemod event-name remap (Task D) | 1–2 days | Pure JS-side work; needs an event-name dictionary plus AST pass. |
| Codemod dynamic-import + CJS (Task F) | 1–2 days | Mirror the static-ESM path; care needed for awaited dynamic imports' destructuring. |
| Query argument deep-transform (Task E) | 3–5 days | Need to fork allowlist into "rewrite" vs "passthrough" props and emit transformed sub-objects. |
| Locator + Geoprocessor compat (Task C) | 1–2 weeks | Requires `HonuaGeocodeService`, `HonuaGeoprocessService` surfaces (server work). |
| Scene-layer compat (Task A-rest) | 4–8 weeks | Requires I3S/glTF pipeline on `honua-server`; not pure-JS work. |
| E2E demo conversion harness (Task I) | 1 week | Wire codemod into a CI job that builds an ArcGIS sample app and asserts the report stays green. |

Until the first three rows ship, "automated app conversion" should
be marketed as "deterministic constructor rewrite + manual-TODO
report," not as a one-click migration. Until the last three rows
ship, "parity with ArcGIS JS SDK" should be qualified as
"deterministic 2D parity; scene/3D and advanced tasks remain
assisted migration."
