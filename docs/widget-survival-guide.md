<!-- GENERATED FILE - DO NOT EDIT.
     Source of truth: src/migration/widget-dispositions.ts
     Regenerate with: npm run docs:widget-guide -->

# ArcGIS widget-removal survival guide

Every classic ArcGIS JS SDK widget (`esri/widgets/*` / `@arcgis/core/widgets/*`) is deprecated as of ArcGIS JS 5.0 and is removed at 6.0 — **as early as Q1 2027**. If your app constructs any of these widgets, that code stops compiling and running when you take the 6.0 upgrade.

This guide answers, for each deprecated widget, what happens if you migrate to Honua/MapLibre instead of rewriting onto Esri's web components. Dispositions are deliberately honest — including "no equivalent" — in the spirit of [docs/migration-punch-list.md](./migration-punch-list.md).

This document is generated from the versioned disposition data in [`src/migration/widget-dispositions.ts`](../src/migration/widget-dispositions.ts) (v1.0.0); the `honua-migrate` widget scanner consumes the same data, so the scanner report and this guide cannot drift apart. The deprecated-widget inventory is pinned per ArcGIS release against https://developers.arcgis.com/javascript/latest/api-reference/esri-widgets.html (5.0 deprecation list) and updated manually.

## Scan your app first

```bash
# Human-readable table (also: --json, --markdown, --gate <pct>, --report <file>)
npm run scan:arcgis:widgets -- ./src
```

The report inventories every widget usage site (ESM imports, AMD `require([...])` arrays, and dynamic `$arcgis.import(...)` specifiers), joins each row to the disposition below, and emits an overall automated/assisted/manual split against the 6.0 removal deadline. `--gate <pct>` makes CI fail when the automated share drops below the threshold.

## Disposition taxonomy

- **Automated** (`automated`): The `honua-migrate` codemod deterministically rewrites the import and safe constructor call sites to a Honua compat shim from `@honua/sdk-esri-compat`. Unsafe option literals fall through to an annotated manual TODO.
- **Compat shim** (`compat-shim`): A Honua compat shim exists and the codemod rewrites to it, but the widget carries a large interaction surface — treat the migration as assisted and verify app-specific behavior by hand.
- **App platform** (`app-platform`): The capability is served by a Honua app-platform component rather than an SDK widget. (Reserved: no widget currently carries this disposition; rows may move here as the app platform matures.)
- **MapLibre plugin** (`maplibre-plugin`): The capability is served by a MapLibre control or community plugin wired up by hand. (Reserved: no widget currently carries this disposition; several `automated` rows note the MapLibre-native control underneath.)
- **Manual workaround** (`manual-workaround`): No drop-in replacement. The row documents an explicit, honest workaround that is real app work you own.
- **No equivalent** (`no-equivalent`): No Honua or MapLibre surface reproduces the widget today. Apps that depend on it need a product decision, not a rewrite.

Readiness buckets: `automated` counts as automated; `compat-shim`, `app-platform`, and `maplibre-plugin` count as assisted; `manual-workaround` and `no-equivalent` count as manual.

A compat-backed row may also list a direct `@honua/app-platform` component. That component is the recommended destination for a deliberate UI rewrite; the disposition still describes what `honua-migrate` can automate today.

## Summary

| Disposition | Widgets |
| --- | --- |
| `automated` | 21 |
| `compat-shim` | 11 |
| `app-platform` | 0 |
| `maplibre-plugin` | 0 |
| `manual-workaround` | 1 |
| `no-equivalent` | 5 |
| **Total** | **38** |

## Widget dispositions

| Widget | ESM module | AMD module | Disposition | Target |
| --- | --- | --- | --- | --- |
| [AreaMeasurement2D](#areameasurement2d) | `@arcgis/core/widgets/AreaMeasurement2D` | `esri/widgets/AreaMeasurement2D` | `compat-shim` | AreaMeasurement2DCompat from @honua/sdk-esri-compat |
| [Attribution](#attribution) | `@arcgis/core/widgets/Attribution` | `esri/widgets/Attribution` | `automated` | AttributionCompat from @honua/sdk-esri-compat (MapLibre AttributionControl underneath) |
| [BasemapGallery](#basemapgallery) | `@arcgis/core/widgets/BasemapGallery` | `esri/widgets/BasemapGallery` | `automated` | BasemapGalleryCompat from @honua/sdk-esri-compat |
| [BasemapLayerList](#basemaplayerlist) | `@arcgis/core/widgets/BasemapLayerList` | `esri/widgets/BasemapLayerList` | `automated` | BasemapLayerListCompat from @honua/sdk-esri-compat |
| [BasemapToggle](#basemaptoggle) | `@arcgis/core/widgets/BasemapToggle` | `esri/widgets/BasemapToggle` | `automated` | BasemapToggleCompat from @honua/sdk-esri-compat |
| [Bookmarks](#bookmarks) | `@arcgis/core/widgets/Bookmarks` | `esri/widgets/Bookmarks` | `automated` | BookmarksCompat from @honua/sdk-esri-compat |
| [Compass](#compass) | `@arcgis/core/widgets/Compass` | `esri/widgets/Compass` | `automated` | CompassCompat from @honua/sdk-esri-compat (MapLibre NavigationControl covers the same gesture natively) |
| [CoordinateConversion](#coordinateconversion) | `@arcgis/core/widgets/CoordinateConversion` | `esri/widgets/CoordinateConversion` | `compat-shim` | CoordinateConversionCompat from @honua/sdk-esri-compat |
| [Daylight](#daylight) | `@arcgis/core/widgets/Daylight` | `esri/widgets/Daylight` | `no-equivalent` | None. Requires a 3D scene with sun/shadow simulation. |
| [Directions](#directions) | `@arcgis/core/widgets/Directions` | `esri/widgets/Directions` | `compat-shim` | DirectionsCompat from @honua/sdk-esri-compat backed by HonuaRouteService (RouteTask parity) |
| [DistanceMeasurement2D](#distancemeasurement2d) | `@arcgis/core/widgets/DistanceMeasurement2D` | `esri/widgets/DistanceMeasurement2D` | `compat-shim` | DistanceMeasurement2DCompat from @honua/sdk-esri-compat |
| [Editor](#editor) | `@arcgis/core/widgets/Editor` | `esri/widgets/Editor` | `compat-shim` | EditorCompat from @honua/sdk-esri-compat |
| [ElevationProfile](#elevationprofile) | `@arcgis/core/widgets/ElevationProfile` | `esri/widgets/ElevationProfile` | `manual-workaround` | No drop-in widget. Sample the profile geometry yourself (e.g. @honua/sdk-js/geometry densify + an elevation/terrain source such as maplibre-gl queryTerrainElevation) and chart with your own charting library. |
| [Expand](#expand) | `@arcgis/core/widgets/Expand` | `esri/widgets/Expand` | `automated` | ExpandCompat from @honua/sdk-esri-compat |
| [Feature](#feature) | `@arcgis/core/widgets/Feature` | `esri/widgets/Feature` | `automated` | FeatureCompat from @honua/sdk-esri-compat |
| [FeatureForm](#featureform) | `@arcgis/core/widgets/FeatureForm` | `esri/widgets/FeatureForm` | `compat-shim` | FeatureFormCompat from @honua/sdk-esri-compat |
| [FeatureTable](#featuretable) | `@arcgis/core/widgets/FeatureTable` | `esri/widgets/FeatureTable` | `compat-shim` | FeatureTableCompat from @honua/sdk-esri-compat |
| [FeatureTemplates](#featuretemplates) | `@arcgis/core/widgets/FeatureTemplates` | `esri/widgets/FeatureTemplates` | `automated` | FeatureTemplatesCompat from @honua/sdk-esri-compat |
| [Fullscreen](#fullscreen) | `@arcgis/core/widgets/Fullscreen` | `esri/widgets/Fullscreen` | `automated` | FullscreenCompat from @honua/sdk-esri-compat (MapLibre FullscreenControl underneath) |
| [Home](#home) | `@arcgis/core/widgets/Home` | `esri/widgets/Home` | `automated` | HomeCompat from @honua/sdk-esri-compat |
| [LayerList](#layerlist) | `@arcgis/core/widgets/LayerList` | `esri/widgets/LayerList` | `automated` | LayerListCompat from @honua/sdk-esri-compat<br>Direct app-platform component: [`<honua-layer-list>`](../src/web-components/elements.ts) from `@honua/app-platform/web-components` |
| [Legend](#legend) | `@arcgis/core/widgets/Legend` | `esri/widgets/Legend` | `automated` | LegendCompat from @honua/sdk-esri-compat<br>Direct app-platform component: [`<honua-legend>`](../src/web-components/elements.ts) from `@honua/app-platform/web-components` |
| [LineOfSight](#lineofsight) | `@arcgis/core/widgets/LineOfSight` | `esri/widgets/LineOfSight` | `no-equivalent` | None. Requires 3D scene geometry intersection analysis. |
| [Locate](#locate) | `@arcgis/core/widgets/Locate` | `esri/widgets/Locate` | `automated` | LocateCompat from @honua/sdk-esri-compat (MapLibre GeolocateControl covers the same behavior natively) |
| [Measurement](#measurement) | `@arcgis/core/widgets/Measurement` | `esri/widgets/Measurement` | `compat-shim` | MeasurementCompat from @honua/sdk-esri-compat (2D distance/area only)<br>Direct app-platform component: [`<honua-measurement>`](../src/web-components/measurement.ts) from `@honua/app-platform/web-components` |
| [Popup](#popup) | `@arcgis/core/widgets/Popup` | `esri/widgets/Popup` | `automated` | PopupCompat from @honua/sdk-esri-compat |
| [Print](#print) | `@arcgis/core/widgets/Print` | `esri/widgets/Print` | `compat-shim` | PrintCompat from @honua/sdk-esri-compat |
| [ScaleBar](#scalebar) | `@arcgis/core/widgets/ScaleBar` | `esri/widgets/ScaleBar` | `automated` | ScaleBarCompat from @honua/sdk-esri-compat (MapLibre ScaleControl underneath) |
| [Search](#search) | `@arcgis/core/widgets/Search` | `esri/widgets/Search` | `automated` | SearchCompat from @honua/sdk-esri-compat backed by the Honua geocoding surface<br>Direct app-platform component: [`<honua-search>`](../src/web-components/elements.ts) from `@honua/app-platform/web-components` |
| [ShadowCast](#shadowcast) | `@arcgis/core/widgets/ShadowCast` | `esri/widgets/ShadowCast` | `no-equivalent` | None. Requires a 3D scene with shadow accumulation. |
| [Sketch](#sketch) | `@arcgis/core/widgets/Sketch` | `esri/widgets/Sketch` | `compat-shim` | SketchCompat from @honua/sdk-esri-compat |
| [Slice](#slice) | `@arcgis/core/widgets/Slice` | `esri/widgets/Slice` | `no-equivalent` | None. Requires 3D scene slicing. |
| [Swipe](#swipe) | `@arcgis/core/widgets/Swipe` | `esri/widgets/Swipe` | `automated` | SwipeCompat from @honua/sdk-esri-compat |
| [TableList](#tablelist) | `@arcgis/core/widgets/TableList` | `esri/widgets/TableList` | `automated` | TableListCompat from @honua/sdk-esri-compat |
| [TimeSlider](#timeslider) | `@arcgis/core/widgets/TimeSlider` | `esri/widgets/TimeSlider` | `compat-shim` | TimeSliderCompat from @honua/sdk-esri-compat |
| [Track](#track) | `@arcgis/core/widgets/Track` | `esri/widgets/Track` | `automated` | TrackCompat from @honua/sdk-esri-compat |
| [Weather](#weather) | `@arcgis/core/widgets/Weather` | `esri/widgets/Weather` | `no-equivalent` | None. Requires a 3D scene atmosphere/weather renderer. |
| [Zoom](#zoom) | `@arcgis/core/widgets/Zoom` | `esri/widgets/Zoom` | `automated` | ZoomCompat from @honua/sdk-esri-compat (MapLibre NavigationControl underneath) |

## Per-widget details

### AreaMeasurement2D

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/AreaMeasurement2D`, `esri/widgets/AreaMeasurement2D`
- Target: AreaMeasurement2DCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/measurement-2d.ts`](../src/esri-compat/measurement-2d.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS.

### Attribution

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Attribution`, `esri/widgets/Attribution`
- Target: AttributionCompat from @honua/sdk-esri-compat (MapLibre AttributionControl underneath)
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### BasemapGallery

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/BasemapGallery`, `esri/widgets/BasemapGallery`
- Target: BasemapGalleryCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/basemap-gallery.ts`](../src/esri-compat/basemap-gallery.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### BasemapLayerList

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/BasemapLayerList`, `esri/widgets/BasemapLayerList`
- Target: BasemapLayerListCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/basemap-layer-list.ts`](../src/esri-compat/basemap-layer-list.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### BasemapToggle

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/BasemapToggle`, `esri/widgets/BasemapToggle`
- Target: BasemapToggleCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Bookmarks

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Bookmarks`, `esri/widgets/Bookmarks`
- Target: BookmarksCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/bookmarks.ts`](../src/esri-compat/bookmarks.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Compass

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Compass`, `esri/widgets/Compass`
- Target: CompassCompat from @honua/sdk-esri-compat (MapLibre NavigationControl covers the same gesture natively)
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### CoordinateConversion

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/CoordinateConversion`, `esri/widgets/CoordinateConversion`
- Target: CoordinateConversionCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/coordinate-conversion.ts`](../src/esri-compat/coordinate-conversion.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Custom coordinate formats beyond the built-in set are not reproduced.

### Daylight

- Disposition: `no-equivalent` (No equivalent)
- Modules: `@arcgis/core/widgets/Daylight`, `esri/widgets/Daylight`
- Target: None. Requires a 3D scene with sun/shadow simulation.
- Notes: SceneView/3D analysis widget. Honua's SceneViewCompat is 2D-behavior only and no Honua or MapLibre surface reproduces this widget today (see docs/migration-punch-list.md, parity gap 1). Apps that depend on it need a product decision, not a code rewrite.

### Directions

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/Directions`, `esri/widgets/Directions`
- Target: DirectionsCompat from @honua/sdk-esri-compat backed by HonuaRouteService (RouteTask parity)
- Compat shim source: [`src/esri-compat/directions.ts`](../src/esri-compat/directions.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Only RouteTask-backed routing is shimmed; service-area, closest-facility, and OD-cost-matrix flows remain unsupported (docs/migration-punch-list.md, parity gap 3).

### DistanceMeasurement2D

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/DistanceMeasurement2D`, `esri/widgets/DistanceMeasurement2D`
- Target: DistanceMeasurement2DCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/measurement-2d.ts`](../src/esri-compat/measurement-2d.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS.

### Editor

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/Editor`, `esri/widgets/Editor`
- Target: EditorCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/editor.ts`](../src/esri-compat/editor.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Attribute + geometry editing against feature services works; advanced form elements and utility-network editing do not.

### ElevationProfile

- Disposition: `manual-workaround` (Manual workaround)
- Modules: `@arcgis/core/widgets/ElevationProfile`, `esri/widgets/ElevationProfile`
- Target: No drop-in widget. Sample the profile geometry yourself (e.g. @honua/sdk-js/geometry densify + an elevation/terrain source such as maplibre-gl queryTerrainElevation) and chart with your own charting library.
- Notes: There is no ElevationProfile shim and no automated rewrite. The workaround is honest but real work: profile sampling, unit handling, and chart UX are app code you own after migration.

### Expand

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Expand`, `esri/widgets/Expand`
- Target: ExpandCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/expand.ts`](../src/esri-compat/expand.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Feature

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Feature`, `esri/widgets/Feature`
- Target: FeatureCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/feature.ts`](../src/esri-compat/feature.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### FeatureForm

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/FeatureForm`, `esri/widgets/FeatureForm`
- Target: FeatureFormCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/feature-form.ts`](../src/esri-compat/feature-form.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Arcade-driven form expressions are not evaluated.

### FeatureTable

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/FeatureTable`, `esri/widgets/FeatureTable`
- Target: FeatureTableCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/feature-table.ts`](../src/esri-compat/feature-table.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Related-records and popup interaction flows are exercised by the demo fixtures; column virtualization and attachment editing differ from ArcGIS.

### FeatureTemplates

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/FeatureTemplates`, `esri/widgets/FeatureTemplates`
- Target: FeatureTemplatesCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/feature-templates.ts`](../src/esri-compat/feature-templates.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Fullscreen

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Fullscreen`, `esri/widgets/Fullscreen`
- Target: FullscreenCompat from @honua/sdk-esri-compat (MapLibre FullscreenControl underneath)
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Home

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Home`, `esri/widgets/Home`
- Target: HomeCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### LayerList

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/LayerList`, `esri/widgets/LayerList`
- Target: LayerListCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/layer-list.ts`](../src/esri-compat/layer-list.ts)
- Direct app-platform component: [`<honua-layer-list>`](../src/web-components/elements.ts) from `@honua/app-platform/web-components`
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

App-platform usage (the module import auto-registers the element):

```ts doc-test=skip reason="requires the separately published app-platform package"
import "@honua/app-platform/web-components";
```

```html
<honua-map id="map"></honua-map>
<honua-layer-list for="map"></honua-layer-list>
```

### Legend

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Legend`, `esri/widgets/Legend`
- Target: LegendCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/legend.ts`](../src/esri-compat/legend.ts)
- Direct app-platform component: [`<honua-legend>`](../src/web-components/elements.ts) from `@honua/app-platform/web-components`
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

App-platform usage (the module import auto-registers the element):

```ts doc-test=skip reason="requires the separately published app-platform package"
import "@honua/app-platform/web-components";
```

```html
<honua-map id="map"></honua-map>
<honua-legend for="map"></honua-legend>
```

### LineOfSight

- Disposition: `no-equivalent` (No equivalent)
- Modules: `@arcgis/core/widgets/LineOfSight`, `esri/widgets/LineOfSight`
- Target: None. Requires 3D scene geometry intersection analysis.
- Notes: SceneView/3D analysis widget. Honua's SceneViewCompat is 2D-behavior only and no Honua or MapLibre surface reproduces this widget today (see docs/migration-punch-list.md, parity gap 1). Apps that depend on it need a product decision, not a code rewrite.

### Locate

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Locate`, `esri/widgets/Locate`
- Target: LocateCompat from @honua/sdk-esri-compat (MapLibre GeolocateControl covers the same behavior natively)
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Measurement

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/Measurement`, `esri/widgets/Measurement`
- Target: MeasurementCompat from @honua/sdk-esri-compat (2D distance/area only)
- Compat shim source: [`src/esri-compat/measurement.ts`](../src/esri-compat/measurement.ts)
- Direct app-platform component: [`<honua-measurement>`](../src/web-components/measurement.ts) from `@honua/app-platform/web-components`
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. 3D measurement modes are not supported.

App-platform usage (the module import auto-registers the element):

```ts doc-test=skip reason="requires the separately published app-platform package"
import "@honua/app-platform/web-components";
```

```html
<honua-map id="map"></honua-map>
<honua-measurement for="map"></honua-measurement>
```

### Popup

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Popup`, `esri/widgets/Popup`
- Target: PopupCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/popup.ts`](../src/esri-compat/popup.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS. Popup actions and fieldInfos format callbacks migrate for the simple case only (docs/migration-punch-list.md, parity gap 5).

### Print

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/Print`, `esri/widgets/Print`
- Target: PrintCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/print.ts`](../src/esri-compat/print.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Export goes through the Honua rendering pipeline, not an ArcGIS print service; custom print templates need re-authoring.

### ScaleBar

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/ScaleBar`, `esri/widgets/ScaleBar`
- Target: ScaleBarCompat from @honua/sdk-esri-compat (MapLibre ScaleControl underneath)
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Search

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Search`, `esri/widgets/Search`
- Target: SearchCompat from @honua/sdk-esri-compat backed by the Honua geocoding surface
- Compat shim source: [`src/esri-compat/search.ts`](../src/esri-compat/search.ts)
- Direct app-platform component: [`<honua-search>`](../src/web-components/elements.ts) from `@honua/app-platform/web-components`
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS. Custom Locator sources are out of scope (Locator/Geoprocessor parity gap).

App-platform usage (the module import auto-registers the element):

```ts doc-test=skip reason="requires the separately published app-platform package"
import "@honua/app-platform/web-components";
```

```html
<honua-map id="map"></honua-map>
<honua-search for="map" source="incidents"></honua-search>
```

### ShadowCast

- Disposition: `no-equivalent` (No equivalent)
- Modules: `@arcgis/core/widgets/ShadowCast`, `esri/widgets/ShadowCast`
- Target: None. Requires a 3D scene with shadow accumulation.
- Notes: SceneView/3D analysis widget. Honua's SceneViewCompat is 2D-behavior only and no Honua or MapLibre surface reproduces this widget today (see docs/migration-punch-list.md, parity gap 1). Apps that depend on it need a product decision, not a code rewrite.

### Sketch

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/Sketch`, `esri/widgets/Sketch`
- Target: SketchCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/sketch.ts`](../src/esri-compat/sketch.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Snapping and 3D sketch tools are not reproduced.

### Slice

- Disposition: `no-equivalent` (No equivalent)
- Modules: `@arcgis/core/widgets/Slice`, `esri/widgets/Slice`
- Target: None. Requires 3D scene slicing.
- Notes: SceneView/3D analysis widget. Honua's SceneViewCompat is 2D-behavior only and no Honua or MapLibre surface reproduces this widget today (see docs/migration-punch-list.md, parity gap 1). Apps that depend on it need a product decision, not a code rewrite.

### Swipe

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Swipe`, `esri/widgets/Swipe`
- Target: SwipeCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/swipe.ts`](../src/esri-compat/swipe.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### TableList

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/TableList`, `esri/widgets/TableList`
- Target: TableListCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/table-list.ts`](../src/esri-compat/table-list.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### TimeSlider

- Disposition: `compat-shim` (Compat shim)
- Modules: `@arcgis/core/widgets/TimeSlider`, `esri/widgets/TimeSlider`
- Target: TimeSliderCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/time-slider.ts`](../src/esri-compat/time-slider.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific behavior after migration. Rendering is not byte-identical to ArcGIS. Time-aware layer filtering works; stops derived from server time-info metadata should be verified per service.

### Track

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Track`, `esri/widgets/Track`
- Target: TrackCompat from @honua/sdk-esri-compat
- Compat shim source: [`src/esri-compat/track.ts`](../src/esri-compat/track.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

### Weather

- Disposition: `no-equivalent` (No equivalent)
- Modules: `@arcgis/core/widgets/Weather`, `esri/widgets/Weather`
- Target: None. Requires a 3D scene atmosphere/weather renderer.
- Notes: SceneView/3D analysis widget. Honua's SceneViewCompat is 2D-behavior only and no Honua or MapLibre surface reproduces this widget today (see docs/migration-punch-list.md, parity gap 1). Apps that depend on it need a product decision, not a code rewrite.

### Zoom

- Disposition: `automated` (Automated)
- Modules: `@arcgis/core/widgets/Zoom`, `esri/widgets/Zoom`
- Target: ZoomCompat from @honua/sdk-esri-compat (MapLibre NavigationControl underneath)
- Compat shim source: [`src/esri-compat/controls.ts`](../src/esri-compat/controls.ts)
- Notes: The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.

## Out of scope

These surfaces are intentionally **not** covered by the dispositions above:

- **SceneView / 3D rendering.** Honua's `SceneViewCompat` shares 2D `MapView` behavior; WebGL/CesiumJS scene parity (environment, global viewing mode, scene layers, camera) is not implemented ([punch list, parity gaps 1-2](./migration-punch-list.md)). The 3D analysis widgets above are therefore `no-equivalent` rather than shimmed.
- **Locator (geocoding tasks).** Only the `Search` widget's core flow is shimmed; the standalone `Locator` task surface (suggest/geocode customization, custom locators) needs its own Honua surface first ([punch list, parity gap 3](./migration-punch-list.md)).
- **Geoprocessor / NetworkAnalyst beyond RouteTask.** Service-area, closest-facility, OD-cost-matrix, and general geoprocessing have no Honua equivalent yet; the scanner's `advanced-widget-or-networking-detected` flag calls these out separately ([punch list, parity gap 3](./migration-punch-list.md)).

## Related reading

- [Migration punch list](./migration-punch-list.md) — the honest parity/codemod accounting.
- [Honua ⇄ MapLibre migration notes](./migration-honua-maplibre.md) — the `honua-maplibre` codemod target.
- [SDK guide: Migration CLI](./guide.md#migration-cli) — every `honua-migrate` subcommand.
