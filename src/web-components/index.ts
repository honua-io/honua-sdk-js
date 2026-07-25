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
 * `<honua-legend>` and `<honua-layer-list>` are also each contested by the
 * `controls` kit's own framework-free implementation. This kit's classes are
 * both tags' canonical/default registrant: importing `./web-components` —
 * alone, or alongside `@honua/sdk-js/controls` in either order — always
 * registers these tags with the classes exported here (issue #679; see
 * `./catalog.js` for the full ownership record and `./registry.js` for the
 * catalog-id-addressable registration APIs re-exported below).
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import { defineHonuaWebComponents } from "./elements.js";

// The blanket auto-registration side effect lives here, not in `./elements.js`
// (issue #679 PR review): `./elements.js` must stay side-effect-free on
// import so `../controls/registry.js` can dynamically `import()` it to
// register one tag without also claiming every tag the kit owns. This is
// every existing `@honua/sdk-js/web-components` consumer's actual entry
// point, so the observable behavior — importing this module registers all 16
// tags when a `customElements` registry is present — is unchanged.
defineHonuaWebComponents();

export {
  HonuaInMemoryWebComponentController,
  createHonuaWebComponentController,
  createHonuaWebComponentControllerFromRuntime,
  layersFromMapPackage,
  legendFromMapPackage,
} from "./controller.js";

export {
  HONUA_COMPONENT_CATALOG,
  describeDeprecatedComponentImport,
  getCanonicalComponentCatalogEntry,
  getComponentCatalogEntriesForTag,
  getComponentCatalogEntry,
  listComponentCatalogEntries,
  listDeprecatedComponentImports,
} from "../controls/catalog.js";
export type {
  HonuaComponentCatalogEntry,
  HonuaComponentSource,
  HonuaComponentSupportTier,
  HonuaDeprecatedComponentDiagnostic,
} from "../controls/catalog.js";
export {
  HonuaComponentCatalogError,
  createComponentRegistry,
  registerAllComponents,
  registerComponent,
  registerComponents,
} from "../controls/registry.js";
export type {
  HonuaComponentCatalogId,
  HonuaComponentRegistrationOptions,
  HonuaComponentRegistry,
} from "../controls/registry.js";

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
  defineHonuaWebComponent,
  defineHonuaWebComponents,
} from "./elements.js";
export type { HonuaFeatureTableConflictDetail } from "./elements.js";

export { HonuaMeasurementElement, defineHonuaMeasurement } from "./measurement.js";

// Bounded production feature table (issue #681).
export {
  DEFAULT_FEATURE_TABLE_BUDGETS,
  createHonuaFeatureTable,
  describeFeatureTableCount,
  explorationClauseToFilterClause,
  featureTableAriaRowCount,
  featureTableAriaSort,
  featureTablePageCacheKey,
  featureTableRowKey,
  featureTableWindow,
  featureTableWorkByTier,
  formatFeatureTableCell,
  linkFeatureTableToExploration,
} from "./feature-table-engine.js";
export type {
  CreateHonuaFeatureTableOptions,
  HonuaFeatureTable,
  HonuaFeatureTableBudgetKind,
  HonuaFeatureTableBudgetLedger,
  HonuaFeatureTableBudgets,
  HonuaFeatureTableColumn,
  HonuaFeatureTableColumnType,
  HonuaFeatureTableConflict,
  HonuaFeatureTableConflictCode,
  HonuaFeatureTableCount,
  HonuaFeatureTableCountEvidence,
  HonuaFeatureTableExport,
  HonuaFeatureTableExportRequest,
  HonuaFeatureTableFocus,
  HonuaFeatureTableFocusMove,
  HonuaFeatureTablePageIdentity,
  HonuaFeatureTablePaging,
  HonuaFeatureTablePagingMode,
  HonuaFeatureTablePlanner,
  HonuaFeatureTableQueryEvidence,
  HonuaFeatureTableQuerySource,
  HonuaFeatureTableRealtimeDiff,
  HonuaFeatureTableRealtimeOutcome,
  HonuaFeatureTableResolvedColumn,
  HonuaFeatureTableRow,
  HonuaFeatureTableRowKey,
  HonuaFeatureTableScrollMetrics,
  HonuaFeatureTableSnapshot,
  HonuaFeatureTableState,
  HonuaFeatureTableWindow,
  HonuaFeatureTableWorkConcern,
  HonuaFeatureTableWorkItem,
  HonuaFeatureTableWorkTier,
  LinkFeatureTableToExplorationOptions,
} from "./feature-table-engine.js";
export {
  describeFeatureTableState,
  featureTableFocusMoveForKey,
  featureTableGridHtml,
  featureTableGridStyles,
  featureTableViewModel,
  legacyFeatureTableViewModel,
} from "./feature-table-view.js";
export type { HonuaFeatureTableViewModel, HonuaFeatureTableViewRow } from "./feature-table-view.js";

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
