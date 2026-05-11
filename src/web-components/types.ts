import type { FeatureId, Query } from "../contract/index.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type { HonuaHitTestOptions, HonuaHitTestResult, HonuaPointerInput } from "../interactions/index.js";
import type { HonuaMapPackage, HonuaMapPackageLegendEntry } from "../runtime/index.js";
import type { HonuaLayerSpecification } from "../style/index.js";

export type HonuaComponentStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

export interface HonuaLayerModel {
  id: string;
  title: string;
  sourceId?: string;
  type?: string;
  visible: boolean;
  metadata?: Record<string, unknown>;
}

export interface HonuaLegendItem {
  id: string;
  label: string;
  color?: string;
  iconUrl?: string;
  layerId?: string;
  minValue?: number;
  maxValue?: number;
}

export interface HonuaViewportState {
  bbox?: readonly [number, number, number, number];
  center?: readonly [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
}

export interface HonuaFeatureRecord<T = Record<string, unknown>> {
  id: FeatureId;
  sourceId: string;
  attributes: T;
  geometry?: HonuaTypedFeature<T>["geometry"];
  title?: string;
}

export interface HonuaFeatureTableModel<T = Record<string, unknown>> {
  sourceId: string | undefined;
  status: HonuaComponentStatus;
  fields: readonly string[];
  rows: readonly HonuaFeatureRecord<T>[];
  totalCount: number;
  exceededTransferLimit?: boolean;
  error?: unknown;
}

export interface HonuaSearchResult<T = Record<string, unknown>> {
  id: string;
  label: string;
  sourceId?: string;
  featureId?: FeatureId;
  feature?: HonuaFeatureRecord<T>;
  subtitle?: string;
  score?: number;
  viewport?: HonuaViewportState;
}

export interface HonuaSelectionState<T = Record<string, unknown>> {
  sourceId?: string;
  featureId?: FeatureId;
  feature?: HonuaFeatureRecord<T>;
}

export interface HonuaFeatureStateTarget {
  sourceId: string;
  featureId: FeatureId;
  sourceLayer?: string;
}

export interface HonuaFeatureStateEntry extends HonuaFeatureStateTarget {
  state: Readonly<Record<string, unknown>>;
}

export interface HonuaFilterState {
  sourceId?: string;
  expression?: string;
  text?: string;
}

export interface HonuaEditCapabilities {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  readOnly: boolean;
  reason?: string;
}

export interface HonuaEditorModel {
  sourceId?: string;
  status: HonuaComponentStatus;
  capabilities: HonuaEditCapabilities;
  selectedFeatureId?: FeatureId;
  fields?: readonly string[];
  message?: string;
}

export interface HonuaChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface HonuaChartModel {
  id: string;
  title: string;
  kind: "bar" | "line" | "pie" | "number" | "placeholder";
  status: HonuaComponentStatus;
  sourceId?: string;
  data?: readonly HonuaChartDatum[];
  message?: string;
}

export interface HonuaWebComponentState<T = Record<string, unknown>> {
  packageId?: string;
  status: HonuaComponentStatus;
  mapPackage?: HonuaMapPackage;
  layers: readonly HonuaLayerModel[];
  legend: readonly HonuaLegendItem[];
  viewport: HonuaViewportState;
  featuresBySource: Readonly<Record<string, readonly HonuaFeatureRecord<T>[]>>;
  selection?: HonuaSelectionState<T>;
  featureStates: readonly HonuaFeatureStateEntry[];
  filters: Readonly<Record<string, HonuaFilterState>>;
  editor?: HonuaEditorModel;
  chart?: HonuaChartModel;
  refreshedAt?: string;
  stale?: boolean;
}

export type HonuaControllerStateListener<T = Record<string, unknown>> = (state: HonuaWebComponentState<T>) => void;

export interface HonuaControllerSubscription {
  remove(): void;
}

export interface HonuaQueryFeaturesOptions {
  sourceId?: string;
  fields?: readonly string[];
  filter?: HonuaFilterState;
  pagination?: { offset?: number; limit?: number };
  signal?: AbortSignal;
}

export interface HonuaSearchOptions {
  sourceId?: string;
  limit?: number;
  fields?: readonly string[];
  signal?: AbortSignal;
}

export interface HonuaEditRequest<T = Record<string, unknown>> {
  sourceId: string;
  feature: HonuaFeatureRecord<T>;
  operation: "create" | "update" | "delete";
  signal?: AbortSignal;
}

export interface HonuaWebComponentController<T = Record<string, unknown>> {
  getState(): HonuaWebComponentState<T>;
  subscribe(listener: HonuaControllerStateListener<T>): HonuaControllerSubscription;
  setLayerVisibility(layerId: string, visible: boolean): void;
  setViewport(viewport: HonuaViewportState): void;
  setFilter(filter: HonuaFilterState): void;
  selectFeature(selection: HonuaSelectionState<T>): void;
  clearSelection(): void;
  setFeatureState(target: HonuaFeatureStateTarget, state: Record<string, unknown>): void;
  removeFeatureState(target: HonuaFeatureStateTarget, key?: string): void;
  queryFeatures(sourceId?: string, options?: HonuaQueryFeaturesOptions): Promise<HonuaFeatureTableModel<T>>;
  search(query: string, options?: HonuaSearchOptions): Promise<readonly HonuaSearchResult<T>[]>;
  hitTest?(input: HonuaPointerInput | unknown, options?: HonuaHitTestOptions): Promise<HonuaHitTestResult>;
  onPointer?(
    handler: (hit: HonuaHitTestResult) => void | Promise<void>,
    options?: HonuaHitTestOptions & { readonly event?: "click" | "dblclick" | "mousemove" },
  ): HonuaControllerSubscription;
  applyEdit?(request: HonuaEditRequest<T>): Promise<HonuaEditorModel>;
  updateFeatures?(sourceId: string, features: readonly HonuaFeatureRecord<T>[]): void;
}

export interface CreateHonuaWebComponentControllerOptions<T = Record<string, unknown>> {
  mapPackage?: HonuaMapPackage;
  layers?: readonly HonuaLayerModel[];
  legend?: readonly HonuaLegendItem[];
  viewport?: HonuaViewportState;
  featuresBySource?: Readonly<Record<string, readonly HonuaFeatureRecord<T>[]>>;
  fieldsBySource?: Readonly<Record<string, readonly string[]>>;
  editor?: Partial<HonuaEditorModel>;
  chart?: HonuaChartModel;
  searchFields?: readonly string[];
  status?: HonuaComponentStatus;
}

export interface HonuaWebComponentRuntimeLike<T = Record<string, unknown>> {
  readonly mapPackage: HonuaMapPackage;
  readonly composedStyle: { layers: readonly HonuaLayerSpecification[] };
  getLegend(): readonly HonuaMapPackageLegendEntry[];
  setLayerVisibility(layerId: string, visible: boolean): void;
  setViewState(viewport: HonuaViewportState): void;
  readonly dataset?: {
    source(id: string):
      | {
          query(request?: Query<T>): Promise<{
            features: readonly HonuaTypedFeature<T>[];
            totalCount?: number;
            exceededTransferLimit?: boolean;
            fields?: readonly { name: string }[];
          }>;
        }
      | undefined;
  };
  on?(listener: (event: { type: string; sourceId?: string; error?: unknown }) => void): HonuaControllerSubscription;
}

export interface HonuaSelectionChangeDetail<T = Record<string, unknown>> extends HonuaSelectionState<T> {}

export interface HonuaLayerVisibilityChangeDetail {
  layerId: string;
  visible: boolean;
}

export interface HonuaViewportChangeDetail extends HonuaViewportState {}

export interface HonuaFilterChangeDetail extends HonuaFilterState {}

export interface HonuaMapReadyDetail<T = Record<string, unknown>> {
  map: unknown;
  runtime?: HonuaWebComponentRuntimeLike<T>;
  controller?: HonuaWebComponentController<T>;
  mapPackage?: HonuaMapPackage;
}

export interface HonuaMapErrorDetail {
  error: unknown;
  message: string;
  sourceId?: string;
}

export interface HonuaMapInteractionPoint {
  x: number;
  y: number;
}

export interface HonuaMapInteractionDetail<T = Record<string, unknown>> {
  layerId?: string;
  sourceId?: string;
  sourceLayer?: string;
  featureId?: FeatureId;
  feature?: HonuaFeatureRecord<T>;
  mapFeature?: unknown;
  point?: HonuaMapInteractionPoint;
  lngLat?: readonly [number, number];
  originalEvent?: unknown;
}

export interface HonuaMapClickDetail<T = Record<string, unknown>> extends HonuaMapInteractionDetail<T> {}

export interface HonuaMapHoverDetail<T = Record<string, unknown>> extends HonuaMapInteractionDetail<T> {
  hovering: boolean;
}

export interface HonuaSearchDetail<T = Record<string, unknown>> {
  query: string;
  results: readonly HonuaSearchResult<T>[];
}

export interface HonuaEditChangeDetail<T = Record<string, unknown>> {
  status: HonuaComponentStatus;
  request?: HonuaEditRequest<T>;
  model: HonuaEditorModel;
}

export interface HonuaControllerReadyDetail<T = Record<string, unknown>> {
  controller: HonuaWebComponentController<T>;
}

export interface HonuaBasemapChangeDetail {
  basemapId: string;
  previousBasemapId?: string;
  status: HonuaComponentStatus;
}

export interface HonuaBookmark {
  id: string;
  label: string;
  viewport: HonuaViewportState;
}

export interface HonuaBookmarkChangeDetail extends HonuaBookmark {
  status: HonuaComponentStatus;
}

export interface HonuaLocateChangeDetail {
  status: HonuaComponentStatus;
  viewport?: HonuaViewportState;
  error?: unknown;
  message?: string;
}

export type HonuaMeasureMode = "off" | "distance" | "area";

export interface HonuaMeasureChangeDetail {
  mode: HonuaMeasureMode;
  status: HonuaComponentStatus;
  message?: string;
}

export type HonuaSketchMode = "off" | "point" | "line" | "polygon";

export interface HonuaSketchChangeDetail {
  mode: HonuaSketchMode;
  status: HonuaComponentStatus;
  message?: string;
}

export interface HonuaExportDetail {
  format: "print" | "png" | "json";
  status: HonuaComponentStatus;
  title?: string;
  message?: string;
}

export interface HonuaFullscreenChangeDetail {
  fullscreen: boolean;
  status: HonuaComponentStatus;
  message?: string;
}

export interface HonuaActionPanelAction {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface HonuaActionDetail extends HonuaActionPanelAction {
  status: HonuaComponentStatus;
}
