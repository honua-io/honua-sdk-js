/**
 * `@honua/sdk-js/interactions` — hit-test, pointer normalization, and the
 * binding primitives that wire chart / map / table widgets to an
 * `ExplorationContext`.
 *
 * @example
 * ```ts
 * import { hitTestMap, bindMapSelectionToExploration } from "@honua/sdk-js/interactions";
 *
 * map.on("click", async (event) => {
 *   const hit = await hitTestMap(map, event);
 *   if (hit?.feature) ctx.dispatch({ type: "select", target: hit.feature });
 * });
 * bindMapSelectionToExploration({ map, context: ctx, sourceId: "parcels" });
 * ```
 *
 * @packageDocumentation
 */
export {
  createQueryTileDetailLoader,
  hitTestMap,
  normalizeHitFeature,
  normalizeHitTestFeatures,
  normalizePointerEvent,
} from "./hit-test.js";
export {
  extentToSpatialFilter,
  selectLinkedViewQueryProjection,
  subscribeExplorationSelector,
} from "../exploration/selectors.js";
export {
  setFeatureState,
  getFeatureState,
  removeFeatureState,
  createHoverHandler,
  createSelectionHandler,
} from "./feature-state.js";
export {
  bindDetailToSelection,
  bindChartToExploration,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  bindTableSelectionToExploration,
  syncMapLayerFilterToExploration,
  syncFeatureStateSelection,
} from "./exploration-bindings.js";
export { preparePrimaryDetailModel, prepareSelectionDetailModels } from "./detail-model.js";
export {
  interactionQueryParamNames,
  parseInteractionQueryState,
  parseSelection,
  serializeInteractionQueryState,
  serializeSelection,
} from "./share-state.js";
export type {
  HonuaHitFeature,
  HonuaHitTestDegradedReason,
  HonuaHitTestDegradedState,
  HonuaHitTestDetailContext,
  HonuaHitTestDetailLoader,
  HonuaHitTestFeatureOptions,
  HonuaHitTestMap,
  HonuaHitTestOptions,
  HonuaHitTestRasterSample,
  HonuaHitTestResult,
  HonuaLngLat,
  HonuaNormalizeHitTestOptions,
  HonuaPointerEvent,
  HonuaPointerEventType,
  HonuaPointerInput,
  HonuaRenderedFeatureContext,
  HonuaScreenPoint,
} from "./hit-test.js";
export type {
  FeatureStateMap,
  MapEventTarget,
  InteractiveMap,
  FeatureTarget,
  HoverHandlerOptions,
  HoverHandle,
  SelectionHandlerOptions,
  SelectionHandle,
} from "./feature-state.js";
export type {
  ExplorationSelector,
  ExplorationSelectorListener,
  ExplorationSelectorSubscribeOptions,
  LinkedViewQueryProjection,
  LinkedViewQueryProjectionOptions,
  LinkedViewSpatialMode,
} from "../exploration/selectors.js";
export type {
  FeatureStateSelectionSyncOptions,
  ChartBucketSelection,
  ChartBucketSelectionOptions,
  ChartExplorationBinding,
  FilterControlsExplorationBinding,
  InteractionBindingHandle,
  LinkedViewQueryBindingOptions,
  MapExtentExplorationBindingOptions,
  MapExtentExplorationSource,
  MapLayerFilterExplorationBindingOptions,
  MapLayerFilterTarget,
  MapSelectionExplorationBindingOptions,
  SelectionDetailListener,
  TableSelectionExplorationBinding,
} from "./exploration-bindings.js";
export type {
  DetailFeatureLike,
  DetailFieldDefinition,
  DetailFieldModel,
  DetailModel,
  DetailModelOptions,
  DetailSelectionStatus,
} from "./detail-model.js";
export type { ShareableInteractionQueryParams, ShareableInteractionQueryState } from "./share-state.js";
