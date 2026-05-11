/**
 * Framework-neutral Honua custom elements.
 *
 * Importing this module registers the shipped custom elements when a browser
 * `customElements` registry is present. Node imports are safe; call
 * `defineHonuaWebComponents()` explicitly when using a scoped registry.
 *
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
  HonuaChartElement,
  HonuaEditorElement,
  HonuaFeatureTableElement,
  HonuaLayerListElement,
  HonuaLegendElement,
  HonuaMapElement,
  HonuaSearchElement,
  defineHonuaWebComponents,
} from "./elements.js";

export type {
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
  HonuaFeatureRecord,
  HonuaFeatureTableModel,
  HonuaFilterChangeDetail,
  HonuaFilterState,
  HonuaLayerModel,
  HonuaLayerVisibilityChangeDetail,
  HonuaLegendItem,
  HonuaQueryFeaturesOptions,
  HonuaSearchDetail,
  HonuaSearchOptions,
  HonuaSearchResult,
  HonuaSelectionChangeDetail,
  HonuaSelectionState,
  HonuaViewportChangeDetail,
  HonuaViewportState,
  HonuaWebComponentController,
  HonuaWebComponentRuntimeLike,
  HonuaWebComponentState,
} from "./types.js";
