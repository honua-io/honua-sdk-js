import type { FeatureId, Query } from "../contract/index.js";
import type { HonuaTypedFeature } from "../core/types.js";
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
  queryFeatures(sourceId?: string, options?: HonuaQueryFeaturesOptions): Promise<HonuaFeatureTableModel<T>>;
  search(query: string, options?: HonuaSearchOptions): Promise<readonly HonuaSearchResult<T>[]>;
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
