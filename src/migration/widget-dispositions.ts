/**
 * Shared widget-disposition data for the Esri Widget Cliff workstream.
 *
 * Every classic ArcGIS JS widget (`esri/widgets/*` / `@arcgis/core/widgets/*`)
 * is deprecated as of ArcGIS JS 5.0 and is removed at 6.0 ("as early as
 * Q1 2027"). This module is the single source of truth consumed by both the
 * generated survival guide (`docs/widget-survival-guide.md`, via
 * `scripts/generate-widget-survival-guide.mjs`) and the widget-usage scanner
 * (`src/migration/widget-scanner.ts`). Drift between the guide and this data
 * fails CI (`npm run docs:widget-guide:check`).
 *
 * Dispositions are grounded in what actually ships today:
 * - `automated` / `compat-shim` entries are backed by real shims under
 *   `src/esri-compat/` and codemod rewrite specs in
 *   `src/migration/codemod.ts::SUPPORTED_ARCGIS_MODULE_KIND_BY_PATH`.
 * - Gaps follow the honest accounting in `docs/migration-punch-list.md`
 *   (scene/3D widgets have no equivalent; visual parity is not byte-identical).
 */

/** Version of this disposition dataset. Bump when rows or taxonomy change. */
export const WIDGET_DISPOSITION_DATA_VERSION = "1.4.0";

/** ArcGIS JS release that deprecated every classic widget. */
export const ARCGIS_WIDGET_DEPRECATION_RELEASE = "5.0";

/** ArcGIS JS release that removes the classic widgets. */
export const ARCGIS_WIDGET_REMOVAL_RELEASE = "6.0";

/** Esri's stated removal timeframe for the 6.0 release. */
export const ARCGIS_WIDGET_REMOVAL_TIMEFRAME = "as early as Q1 2027";

/**
 * Pinned source for the deprecated-widget inventory. The list is maintained
 * manually per ArcGIS release; update the URL/release together with the rows.
 */
export const ARCGIS_WIDGET_INVENTORY_SOURCE =
  "https://developers.arcgis.com/javascript/latest/api-reference/esri-widgets.html";

export type WidgetDispositionKind =
  | "automated"
  | "compat-shim"
  | "app-platform"
  | "maplibre-plugin"
  | "manual-workaround"
  | "no-equivalent";

export const WIDGET_DISPOSITION_KINDS: readonly WidgetDispositionKind[] = [
  "automated",
  "compat-shim",
  "app-platform",
  "maplibre-plugin",
  "manual-workaround",
  "no-equivalent",
];

/** Migration-effort bucket used by the scanner readiness report. */
export type WidgetMigrationBucket = "automated" | "assisted" | "manual";

/** Internal documentation metadata rendered by the survival-guide generator. */
interface WidgetAppPlatformComponent {
  /** Published module that registers the custom element. */
  moduleSpecifier: "@honua/app-platform/web-components";
  /** Custom-element tag name, e.g. `honua-legend`. */
  tagName: `honua-${string}`;
  /** Repo-relative source file implementing the custom element. */
  source: string;
  /** Copyable markup for the generated survival guide. */
  usageHtml: string;
}

export interface WidgetDisposition {
  /** Widget class name, e.g. `Legend`. */
  widget: string;
  /** ESM module specifiers (`@arcgis/core/widgets/*`, without `.js`). */
  esmModules: readonly string[];
  /** Classic AMD module specifiers (`esri/widgets/*`). */
  amdModules: readonly string[];
  /** Exactly one disposition from the fixed taxonomy. */
  disposition: WidgetDispositionKind;
  /** Honua API/component target, or explicit workaround text. */
  target: string;
  /** Honest caveats; never "TBD". */
  notes: string;
  /** Repo-relative path to the compat shim source, when one exists. */
  shimSource?: string;
}

interface WidgetDispositionData extends WidgetDisposition {
  /** Direct app-platform component for teams replacing the widget instead of retaining the compat shim. */
  appPlatformComponent?: WidgetAppPlatformComponent;
  /**
   * What a native Honua element does **not** cover relative to the ArcGIS
   * widget, measured against the shipping code rather than assumed.
   *
   * Required for every `compat-shim` and `manual-workaround` row (honua-sdk-js
   * #1315 AC-1). The epic that owns those rows was authored without this field
   * and overstated the remaining work by roughly 2x, because `compat-shim`
   * describes the *migration path* (an API-compatible shim) and says nothing
   * about whether a native element already exists. Stating the delta per row
   * is what stops the next estimate from being a guess; "TBD" is not a value.
   */
  parityDelta?: string;
}

function widgetEntry(
  widget: string,
  disposition: WidgetDispositionKind,
  target: string,
  notes: string,
  shimSource?: string,
  appPlatformComponent?: WidgetAppPlatformComponent,
  parityDelta?: string,
): WidgetDispositionData {
  return {
    widget,
    esmModules: [`@arcgis/core/widgets/${widget}`],
    amdModules: [`esri/widgets/${widget}`],
    disposition,
    target,
    notes,
    ...(shimSource ? { shimSource } : {}),
    ...(appPlatformComponent ? { appPlatformComponent } : {}),
    ...(parityDelta ? { parityDelta } : {}),
  };
}

/**
 * The measurement element behind `Measurement`, `AreaMeasurement2D`, and
 * `DistanceMeasurement2D` — three ArcGIS widgets that collapse into one native
 * element rather than three.
 */
function measurementComponent(): WidgetAppPlatformComponent {
  return appPlatformComponent(
    "honua-measurement",
    "src/web-components/measurement.ts",
    '<honua-map id="map"></honua-map>\n<honua-measurement for="map"></honua-measurement>',
  );
}

const MEASUREMENT_UNIT_DELTA =
  "Results are formatted metric-only with automatic scaling — m/km for distance, m²/ha/km² for area " +
  "(`formatDistance` / `formatArea` in src/web-components/measurement.ts). ArcGIS's `unit` and " +
  "`unitOptions`, including the whole imperial set (feet, miles, acres, square-miles), have no " +
  "equivalent, and there is no `viewModel` for driving measurement state from outside the element. " +
  "Math itself is at parity: distance and area come from the geodesic `length` / `area` ops in " +
  "@honua/geometry, the same ones behind `geometryEngine` parity elsewhere in the SDK. The in-progress " +
  "sketch overlay needs a map exposing `addSource` / `addLayer`; on other maps the numbers are still " +
  "produced, without the overlay.";

function appPlatformComponent(
  tagName: `honua-${string}`,
  source: string,
  usageHtml: string,
): WidgetAppPlatformComponent {
  return {
    moduleSpecifier: "@honua/app-platform/web-components",
    tagName,
    source,
    usageHtml,
  };
}

const AUTOMATED_NOTE =
  "The honua-migrate codemod rewrites the import and safe constructor call sites deterministically; " +
  "unsafe option literals fall through to an annotated manual TODO. Rendering goes through the Honua " +
  "widget host, so CSS selectors and DOM structure are not byte-identical to ArcGIS.";

const COMPAT_SHIM_NOTE =
  "The honua-migrate codemod rewrites the import and safe constructor call sites, but the shim covers " +
  "the core workflow rather than the full ArcGIS surface — plan hands-on verification of app-specific " +
  "behavior after migration. Rendering is not byte-identical to ArcGIS.";

const SCENE_3D_NOTE =
  "SceneView/3D analysis widget. Honua's SceneViewCompat is 2D-behavior only and no Honua or MapLibre " +
  "surface reproduces this widget today (see docs/migration-punch-list.md, parity gap 1). Apps that " +
  "depend on it need a product decision, not a code rewrite.";

/**
 * Documentation source rows consumed by the repository guide generator.
 * This symbol is intentionally not re-exported from the public migration
 * entrypoint; scanner consumers receive the projected rows below.
 *
 * @internal
 */
export const WIDGET_DISPOSITION_DOCUMENTATION: readonly WidgetDispositionData[] = [
  // --- automated: deterministic codemod rewrite onto a compat shim ---
  widgetEntry(
    "Attribution",
    "automated",
    "AttributionCompat from @honua/sdk-esri-compat (MapLibre AttributionControl underneath)",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "BasemapGallery",
    "automated",
    "BasemapGalleryCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/basemap-gallery.ts",
  ),
  widgetEntry(
    "BasemapLayerList",
    "automated",
    "BasemapLayerListCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/basemap-layer-list.ts",
  ),
  widgetEntry(
    "BasemapToggle",
    "automated",
    "BasemapToggleCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "Bookmarks",
    "automated",
    "BookmarksCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/bookmarks.ts",
  ),
  widgetEntry(
    "Compass",
    "automated",
    "CompassCompat from @honua/sdk-esri-compat (MapLibre NavigationControl covers the same gesture natively)",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "Expand",
    "automated",
    "ExpandCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/expand.ts",
  ),
  widgetEntry(
    "Feature",
    "automated",
    "FeatureCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/feature.ts",
  ),
  widgetEntry(
    "FeatureTemplates",
    "automated",
    "FeatureTemplatesCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/feature-templates.ts",
  ),
  widgetEntry(
    "Fullscreen",
    "automated",
    "FullscreenCompat from @honua/sdk-esri-compat (MapLibre FullscreenControl underneath)",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "Home",
    "automated",
    "HomeCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "LayerList",
    "automated",
    "LayerListCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/layer-list.ts",
    appPlatformComponent(
      "honua-layer-list",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-layer-list for="map"></honua-layer-list>',
    ),
  ),
  widgetEntry(
    "Legend",
    "automated",
    "LegendCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/legend.ts",
    appPlatformComponent(
      "honua-legend",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-legend for="map"></honua-legend>',
    ),
  ),
  widgetEntry(
    "Locate",
    "automated",
    "LocateCompat from @honua/sdk-esri-compat (MapLibre GeolocateControl covers the same behavior natively)",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "Popup",
    "automated",
    "PopupCompat from @honua/sdk-esri-compat",
    [
      AUTOMATED_NOTE,
      "Popup actions and fieldInfos format callbacks migrate for the simple case only",
      "(docs/migration-punch-list.md, parity gap 5).",
    ].join(" "),
    "src/esri-compat/popup.ts",
  ),
  widgetEntry(
    "ScaleBar",
    "automated",
    "ScaleBarCompat from @honua/sdk-esri-compat (MapLibre ScaleControl underneath)",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  widgetEntry(
    "Search",
    "automated",
    "SearchCompat from @honua/sdk-esri-compat, with LocatorSearchSourceCompat as the address backend",
    [
      AUTOMATED_NOTE,
      "Layer search works out of the box. Address search wires LocatorCompat.toSearchSource() (or",
      "LocatorSearchSourceCompat) into `sources`; the geocoding provider is bring-your-own, so the codemod rewrites",
      "the constructor but cannot choose the endpoint. Providers that do not declare `suggest` (Nominatim) omit the",
      "typeahead hook rather than faking it.",
    ].join(" "),
    "src/esri-compat/search.ts",
    appPlatformComponent(
      "honua-search",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-search for="map" source="incidents"></honua-search>',
    ),
  ),
  widgetEntry(
    "Swipe",
    "automated",
    "SwipeCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/swipe.ts",
  ),
  widgetEntry(
    "TableList",
    "automated",
    "TableListCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/table-list.ts",
  ),
  widgetEntry(
    "Track",
    "automated",
    "TrackCompat from @honua/sdk-esri-compat",
    AUTOMATED_NOTE,
    "src/esri-compat/track.ts",
  ),
  widgetEntry(
    "Zoom",
    "automated",
    "ZoomCompat from @honua/sdk-esri-compat (MapLibre NavigationControl underneath)",
    AUTOMATED_NOTE,
    "src/esri-compat/controls.ts",
  ),
  // --- compat-shim / app-platform ---
  //
  // Both dispositions share a shim under src/esri-compat/ that the codemod
  // rewrites to; they differ in what a team gets if it stops there.
  //
  // `app-platform` — a native Honua element also ships, and it is the
  // destination for a deliberate rewrite. Eight rows moved here from
  // `compat-shim` once their parity deltas were measured (#1315 AC-2): the
  // label had been read as "no native component exists", which is not what it
  // means and is how that epic came to overstate its scope by roughly 2x.
  //
  // `compat-shim` — the shim is all there is. Three rows remain:
  // CoordinateConversion (nothing native), Directions (blocked on a server
  // API, honua-server#2447), FeatureForm (belongs to the form-package work).
  //
  // Both stay in the `assisted` readiness bucket: the shim covers the core
  // workflow rather than the full ArcGIS surface either way.
  widgetEntry(
    "AreaMeasurement2D",
    "app-platform",
    "AreaMeasurement2DCompat from @honua/sdk-esri-compat",
    COMPAT_SHIM_NOTE,
    "src/esri-compat/measurement-2d.ts",
    measurementComponent(),
    `A native element ships: <honua-measurement> in area mode. ${MEASUREMENT_UNIT_DELTA}`,
  ),
  widgetEntry(
    "CoordinateConversion",
    "compat-shim",
    "CoordinateConversionCompat from @honua/sdk-esri-compat",
    `${COMPAT_SHIM_NOTE} Custom coordinate formats beyond the built-in set are not reproduced.`,
    "src/esri-compat/coordinate-conversion.ts",
    undefined,
    "No native element exists — this is one of the three genuinely missing ones. The shim implements " +
      "exactly three formats (`lonlat`, `dms`, `dd` — `CoordinateFormatCompat` in " +
      "src/esri-compat/coordinate-conversion.ts); MGRS, UTM, and USNG are absent, as is ArcGIS's custom " +
      "`ConversionInfo` format authoring. Conversion is one-way: `setLocation()` formats a location, and " +
      "there is no parse path for typing a coordinate to move the map, so ArcGIS's capture/reverse input " +
      "mode has no equivalent.",
  ),
  widgetEntry(
    "Directions",
    "compat-shim",
    "DirectionsCompat from @honua/sdk-esri-compat backed by HonuaRouteService (RouteTask parity)",
    [
      COMPAT_SHIM_NOTE,
      "Only RouteTask-backed routing is shimmed; service-area, closest-facility, and OD-cost-matrix flows",
      "remain unsupported (docs/migration-punch-list.md, parity gap 3).",
    ].join(" "),
    "src/esri-compat/directions.ts",
    undefined,
    "No native element exists, and building one now would be premature: the delta is a server gap, not a " +
      "component gap. HonuaRouteService covers RouteTask-equivalent routing; service-area, " +
      "closest-facility, and OD-cost-matrix have no server surface to bind to until honua-server#2447 " +
      "(directions + isochrone API) lands. Turn-by-turn maneuver text, route editing by dragging stops, " +
      "and travel-mode selection all depend on that API's shape.",
  ),
  widgetEntry(
    "DistanceMeasurement2D",
    "app-platform",
    "DistanceMeasurement2DCompat from @honua/sdk-esri-compat",
    COMPAT_SHIM_NOTE,
    "src/esri-compat/measurement-2d.ts",
    measurementComponent(),
    `A native element ships: <honua-measurement> in distance mode. ${MEASUREMENT_UNIT_DELTA}`,
  ),
  widgetEntry(
    "Editor",
    "app-platform",
    "EditorCompat from @honua/sdk-esri-compat",
    [
      COMPAT_SHIM_NOTE,
      "Attribute + geometry editing against feature services works; advanced form elements and",
      "utility-network editing do not.",
    ].join(" "),
    "src/esri-compat/editor.ts",
    appPlatformComponent(
      "honua-editor",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-editor for="map"></honua-editor>\n<!-- richer attribute editing: <honua-feature-editor> from src/web-components/feature-editor.ts -->',
    ),
    "Two native elements ship: <honua-editor> for the map-bound edit workflow and <honua-feature-editor> " +
      "for attribute drafts, the latter with undo/redo (Ctrl/Cmd+Z), Escape-to-cancel, a polite live " +
      "region, and focus/selection that survive re-render so an unrelated realtime change never " +
      "interrupts typing. The delta is form *layout*, not editing: grouped and conditional field " +
      "layouts, Arcade-driven expressions, and utility-network editing are absent. That gap is owned " +
      "elsewhere by design — honua-server ADR-0069 defines `honua.form-package.v1` and honua-server#3244 " +
      "adopts UI5 for form layout, fields, and validation. Building a bespoke form renderer here would " +
      "be thrown away.",
  ),
  widgetEntry(
    "FeatureForm",
    "compat-shim",
    "FeatureFormCompat from @honua/sdk-esri-compat",
    `${COMPAT_SHIM_NOTE} Arcade-driven form expressions are not evaluated.`,
    "src/esri-compat/feature-form.ts",
    undefined,
    "No native element exists, and none should be built in this repo. A standalone form component would " +
      "be superseded by the form-package work: honua-server ADR-0069 owns the `honua.form-package.v1` " +
      "contract and honua-server#3244 owns the UI5 field/validation layer. The remaining shim-level gap " +
      "is Arcade expression evaluation, which is a language runtime rather than a component.",
  ),
  widgetEntry(
    "FeatureTable",
    "app-platform",
    "FeatureTableCompat from @honua/sdk-esri-compat",
    [
      COMPAT_SHIM_NOTE,
      "Related-records and popup interaction flows are exercised by the demo fixtures; column",
      "virtualization and attachment editing differ from ArcGIS.",
    ].join(" "),
    "src/esri-compat/feature-table.ts",
    appPlatformComponent(
      "honua-feature-table",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-feature-table for="map"></honua-feature-table>\n<!-- bounded lane: element.table = createHonuaFeatureTable({ ... }) -->',
    ),
    "A native element ships: <honua-feature-table>. Its bounded lane already does the parts usually " +
      "assumed missing — a virtualized window, remote paging driven by real scroll geometry, " +
      "multi-column sort from header clicks, total-known/estimated/partial/stale/cancelled truth, and " +
      "realtime reconciliation conflicts announced in a polite live region — over a full WAI-ARIA `grid` " +
      "keyboard contract (arrows, Home/End, PageUp/PageDown, roving tabindex). The `notes` line above " +
      "predates that work and is stale on virtualization. Remaining ArcGIS gaps: attachment editing, " +
      "related-records as a first-class panel, and grid chrome (column menus, field formatting UI), the " +
      "last of which is data-grid furniture owned by honua-server#3244 (UI5).",
  ),
  widgetEntry(
    "Measurement",
    "app-platform",
    "MeasurementCompat from @honua/sdk-esri-compat (2D distance/area only)",
    `${COMPAT_SHIM_NOTE} 3D measurement modes are not supported.`,
    "src/esri-compat/measurement.ts",
    measurementComponent(),
    [
      "A native element ships: <honua-measurement>, and `Measurement`, `AreaMeasurement2D`, and",
      "`DistanceMeasurement2D` collapse into it rather than into three components. Modes are",
      "`off | distance | area` only (`HonuaMeasureMode`); ArcGIS's 3D `direct-line` mode has no",
      "equivalent and needs a scene, not a component.",
      MEASUREMENT_UNIT_DELTA,
    ].join(" "),
  ),
  widgetEntry(
    "Print",
    "app-platform",
    "PrintCompat from @honua/sdk-esri-compat",
    [
      COMPAT_SHIM_NOTE,
      "Export goes through the Honua rendering pipeline, not an ArcGIS print service; custom print",
      "templates need re-authoring.",
    ].join(" "),
    "src/esri-compat/print.ts",
    appPlatformComponent(
      "honua-print-export",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-print-export for="map"></honua-print-export>\n<!-- element.exportAdapter = yourAdapter — snapshot/state fail closed without one -->',
    ),
    "A native element ships: <honua-print-export>, covering browser print, snapshot, and sanitized state " +
      "export. The delta is deliberate rather than unfinished: the SDK bundles no renderer, PDF writer, " +
      "or image encoder, so snapshot and state export require an application-supplied " +
      "`HonuaExportAdapter` and **fail closed** without one — disabled buttons and an `unsupported` " +
      "result carrying `HonuaCapabilityNotSupportedError`, never a blank image or a partially-" +
      "credentialed JSON document (src/web-components/export.ts). Browser print works with no adapter " +
      "but reproduces the on-screen layout only. ArcGIS's print-service layout templates, explicit " +
      "scale/DPI selection, and author/title/copyright metadata have no equivalent; custom templates " +
      "need re-authoring against the adapter.",
  ),
  widgetEntry(
    "Sketch",
    "app-platform",
    "SketchCompat from @honua/sdk-esri-compat",
    `${COMPAT_SHIM_NOTE} Snapping and 3D sketch tools are not reproduced.`,
    "src/esri-compat/sketch.ts",
    appPlatformComponent(
      "honua-sketch-control",
      "src/web-components/elements.ts",
      '<honua-map id="map"></honua-map>\n<honua-sketch-control for="map"></honua-sketch-control>\n<!-- requires a sketchGeometry provider on the controller -->',
    ),
    "A native element ships: <honua-sketch-control>, with point/line/polygon modes, plus the terra-draw " +
      "integration and the edit-sketch contracts in src/contract/edit-sketch.ts. Two named gaps remain, " +
      "both real: **snapping** (ArcGIS `SnappingOptions`, self- and feature-snapping) is absent, and 3D " +
      "sketch tools need a scene. One behaviour reads as a gap but is a decision: the modes render " +
      "disabled unless the controller has a `sketchGeometry` provider configured, because the SDK does " +
      "not bundle a drawing backend.",
  ),
  widgetEntry(
    "TimeSlider",
    "app-platform",
    "TimeSliderCompat from @honua/sdk-esri-compat",
    [
      COMPAT_SHIM_NOTE,
      "Time-aware layer filtering works; stops derived from server time-info metadata should be",
      "verified per service. With a container and a registered widget kit the shim now renders through",
      "<honua-time-slider>; without the kit it stays state-model-only, and the element's own transport",
      "drives the app-platform temporal playback controller rather than the shim's stop list.",
    ].join(" "),
    "src/esri-compat/time-slider.ts",
    appPlatformComponent(
      "honua-time-slider",
      "src/web-components/time-slider.ts",
      '<honua-map id="map"></honua-map>\n<honua-time-slider id="time" label="Time"></honua-time-slider>\n<!-- element.playback = createTemporalPlayback({ ... }) from @honua/sdk-js/map -->',
    ),
    "A native element ships: <honua-time-slider>, following the WAI-ARIA slider pattern with full " +
      "keyboard operation (arrows step, PageUp/PageDown move ten, Home/End jump, RTL-mirrored) and a " +
      "CSP-safe shadow tree built once so an active drag is never torn out from under the pointer. The " +
      "delta is in configuration surface, not behaviour: the element observes only `label`, " +
      "`unavailable-reason`, and `speeds`, and takes everything else from the `playback` controller " +
      "(`createTemporalPlayback`). ArcGIS's declarative `stops` modes (`count` / `interval` / `dates`), " +
      "`timeVisible`, `loop`, and `playRate` therefore have no attribute equivalents — they are " +
      "controller configuration. Stops derived from server time-info metadata should be verified per " +
      "service.",
  ),
  // --- manual-workaround ---
  widgetEntry(
    "ElevationProfile",
    "manual-workaround",
    "No drop-in widget. Sample the profile geometry yourself (e.g. @honua/sdk-js/geometry densify + an " +
      "elevation/terrain source such as maplibre-gl queryTerrainElevation) and chart with your own charting library.",
    "There is no ElevationProfile shim and no automated rewrite. The workaround is honest but real work: " +
      "profile sampling, unit handling, and chart UX are app code you own after migration.",
    undefined,
    undefined,
    "No native element and no shim — the only row in the inventory with neither, and one of the three " +
      "genuinely missing components. Every piece it needs already exists separately: densification in " +
      "@honua/sdk-js/geometry, terrain sampling via `queryTerrainElevation`, and charting via " +
      "<honua-chart>. What is missing is the component that composes them, plus the elevation-source " +
      "binding contract that says where the terrain comes from. ArcGIS's multi-profile comparison " +
      "(ground vs input line vs view) and hover-to-locate-on-map are additional surface beyond a first " +
      "cut.",
  ),
  // --- no-equivalent: SceneView/3D analysis widgets ---
  widgetEntry("Daylight", "no-equivalent", "None. Requires a 3D scene with sun/shadow simulation.", SCENE_3D_NOTE),
  widgetEntry("LineOfSight", "no-equivalent", "None. Requires 3D scene geometry intersection analysis.", SCENE_3D_NOTE),
  widgetEntry("ShadowCast", "no-equivalent", "None. Requires a 3D scene with shadow accumulation.", SCENE_3D_NOTE),
  widgetEntry("Slice", "no-equivalent", "None. Requires 3D scene slicing.", SCENE_3D_NOTE),
  widgetEntry("Weather", "no-equivalent", "None. Requires a 3D scene atmosphere/weather renderer.", SCENE_3D_NOTE),
];

function publicWidgetDisposition(entry: WidgetDispositionData): WidgetDisposition {
  return {
    widget: entry.widget,
    esmModules: entry.esmModules,
    amdModules: entry.amdModules,
    disposition: entry.disposition,
    target: entry.target,
    notes: entry.notes,
    ...(entry.shimSource ? { shimSource: entry.shimSource } : {}),
  };
}

/** Public scanner data with documentation-only component metadata projected out at runtime. */
export const WIDGET_DISPOSITIONS: readonly WidgetDisposition[] =
  WIDGET_DISPOSITION_DOCUMENTATION.map(publicWidgetDisposition);

const DISPOSITION_BUCKET: Readonly<Record<WidgetDispositionKind, WidgetMigrationBucket>> = {
  automated: "automated",
  "compat-shim": "assisted",
  "app-platform": "assisted",
  "maplibre-plugin": "assisted",
  "manual-workaround": "manual",
  "no-equivalent": "manual",
};

export function widgetMigrationBucket(disposition: WidgetDispositionKind): WidgetMigrationBucket {
  return DISPOSITION_BUCKET[disposition];
}

const DISPOSITIONS_BY_WIDGET: ReadonlyMap<string, WidgetDisposition> = new Map(
  WIDGET_DISPOSITIONS.map((entry) => [entry.widget, entry]),
);

export function getWidgetDisposition(widget: string): WidgetDisposition | undefined {
  return DISPOSITIONS_BY_WIDGET.get(widget);
}

/**
 * GitHub-style anchor for a widget's `### <Widget>` heading in the generated
 * survival guide. Shared by the guide generator and the scanner report so the
 * per-widget report rows deep-link into the guide.
 */
export function widgetSurvivalGuideAnchor(widget: string): string {
  return widget.toLowerCase();
}

/** Repo-relative path of the generated survival guide. */
export const WIDGET_SURVIVAL_GUIDE_PATH = "docs/widget-survival-guide.md";

/**
 * Extracts the widget name from a module specifier when it addresses a classic
 * widget module (`@arcgis/core/widgets/*` or `esri/widgets/*`), including
 * support modules such as `@arcgis/core/widgets/Search/SearchViewModel`.
 */
export function widgetNameFromModulePath(modulePath: string): string | undefined {
  return widgetModulePathInfo(modulePath)?.widget;
}

export interface WidgetModulePathInfo {
  widget: string;
  /**
   * True when the specifier addresses a widget *support* module (for example
   * `@arcgis/core/widgets/Search/SearchViewModel`) rather than the widget
   * module itself. The codemod only rewrites the exact widget module, so
   * support-module usage must not inherit the widget's disposition.
   */
  supportModule: boolean;
}

export function widgetModulePathInfo(modulePath: string): WidgetModulePathInfo | undefined {
  const normalized = modulePath.endsWith(".js") ? modulePath.slice(0, -3) : modulePath;
  let rest: string | undefined;
  if (normalized.startsWith("@arcgis/core/widgets/")) {
    rest = normalized.slice("@arcgis/core/widgets/".length);
  } else if (normalized.startsWith("esri/widgets/")) {
    rest = normalized.slice("esri/widgets/".length);
  }
  if (!rest) {
    return undefined;
  }
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const widget = segments[0];
  if (!widget) {
    return undefined;
  }
  return { widget, supportModule: segments.length > 1 };
}
