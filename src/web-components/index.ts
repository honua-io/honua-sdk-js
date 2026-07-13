/**
 * Framework-neutral Honua custom elements.
 *
 * Importing this module registers the shipped custom elements when a browser
 * `customElements` registry is present. Node imports are safe; call
 * `defineHonuaWebComponents()` explicitly when using a scoped registry.
 *
 * The `<honua-measure-control>` and `<honua-sketch-control>` elements need a
 * drawing backend to be interactive. The SDK does not bundle one (no hard
 * dependency on maplibre-gl-draw or similar); instead, supply a
 * {@link HonuaMeasureProvider} via `measurementGeometry` and/or a
 * {@link HonuaSketchProvider} via `sketchGeometry` to
 * `createHonuaWebComponentController`. Without a provider both controls render
 * disabled by design with a "configure a provider" affordance.
 *
 * The survival-tier widget set (issue #493) — `<honua-legend>`,
 * `<honua-layer-list>` (visibility / opacity / reorder), `<honua-search>`
 * (geocoding-provider-aware), and `<honua-measurement>` (self-contained
 * distance/area drawing on the map's pointer events, computed with
 * `@honua/geometry` ops) — needs no external drawing provider.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import "./elements.js";

export {
  HonuaInMemoryWebComponentController,
  createHonuaWebComponentController,
  createHonuaWebComponentControllerFromRuntime,
  layersFromMapPackage,
  legendFromMapPackage,
} from "./controller.js";

export {
  HonuaActionPanelElement,
  HonuaBasemapControlElement,
  HonuaBookmarksElement,
  HonuaChartElement,
  HonuaEditorElement,
  HonuaFeatureTableElement,
  HonuaLayerListElement,
  HonuaLegendElement,
  HonuaLocateControlElement,
  HonuaMapElement,
  HonuaMapStatusElement,
  HonuaMeasureControlElement,
  HonuaPrintExportElement,
  HonuaSearchElement,
  HonuaSketchControlElement,
  defineHonuaWebComponents,
} from "./elements.js";

export { HonuaMeasurementElement, defineHonuaMeasurement } from "./measurement.js";

export type {
  HonuaActionDetail,
  HonuaActionPanelAction,
  HonuaBasemapChangeDetail,
  HonuaBookmark,
  HonuaBookmarkChangeDetail,
  CreateHonuaWebComponentControllerOptions,
  HonuaChartDatum,
  HonuaChartModel,
  HonuaComponentStatus,
  HonuaControllerReadyDetail,
  HonuaControllerStateListener,
  HonuaControllerSubscription,
  HonuaEditCapabilities,
  HonuaEditChangeDetail,
  HonuaEditRequest,
  HonuaEditorModel,
  HonuaExportDetail,
  HonuaFeatureRecord,
  HonuaFeatureStateEntry,
  HonuaFeatureStateTarget,
  HonuaFeatureTableModel,
  HonuaFilterChangeDetail,
  HonuaFilterState,
  HonuaFullscreenChangeDetail,
  HonuaGeocodeSelectDetail,
  HonuaLayerModel,
  HonuaLayerOpacityChangeDetail,
  HonuaLayerOrderChangeDetail,
  HonuaLayerVisibilityChangeDetail,
  HonuaLegendItem,
  HonuaLocateChangeDetail,
  HonuaMapClickDetail,
  HonuaMapErrorDetail,
  HonuaMapHoverDetail,
  HonuaMapInteractionDetail,
  HonuaMapInteractionPoint,
  HonuaMapReadyDetail,
  HonuaMeasureChangeDetail,
  HonuaMeasureMode,
  HonuaMeasureProvider,
  HonuaMeasureResult,
  HonuaMeasurementMap,
  HonuaQueryFeaturesOptions,
  HonuaSearchDetail,
  HonuaSearchGeocodeCandidate,
  HonuaSearchGeocodeSuggestion,
  HonuaSearchGeocoderLike,
  HonuaSearchOptions,
  HonuaSearchResult,
  HonuaSelectionChangeDetail,
  HonuaSelectionState,
  HonuaSketchChangeDetail,
  HonuaSketchMode,
  HonuaSketchProvider,
  HonuaSketchResult,
  HonuaViewportChangeDetail,
  HonuaViewportState,
  HonuaWebComponentController,
  HonuaWebComponentRuntimeLike,
  HonuaWebComponentState,
} from "./types.js";
