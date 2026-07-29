import type { FeatureId, Query } from "../contract/index.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type { HonuaHitTestOptions, HonuaHitTestResult, HonuaPointerInput } from "../interactions/index.js";
import type { HonuaMapPackage, HonuaMapPackageLegendEntry } from "../runtime/index.js";
import type { HonuaLayerSpecification } from "../style/index.js";

export type HonuaComponentStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

/**
 * Caller-supplied messages for `<honua-locate-control>`.
 *
 * The control keeps its legacy English defaults when no messages are
 * supplied, while applications can provide a complete locale without
 * replacing the element's rendering or event behavior.
 */
export interface HonuaLocateControlMessages {
  readonly actionLabel?: string;
  readonly status?: Partial<Readonly<Record<HonuaComponentStatus, string>>>;
  readonly initial?: string;
  readonly requesting?: string;
  readonly unavailable?: string;
  readonly applied?: string;
  readonly error?: (error: unknown) => string;
}

/**
 * Caller-supplied messages for `<honua-editor>`.
 *
 * Status values remain stable in the component model and events, while this
 * surface lets an application provide localized text for the rendered status
 * and the generic read-only explanation. A formatter receives the model's
 * reason so a locale can retain useful source-specific context.
 */
export interface HonuaEditorMessages {
  readonly status?: Partial<Readonly<Record<HonuaComponentStatus, string>>>;
  readonly readOnlyReason?: string | ((reason: string | undefined) => string);
}

/** Caller-supplied messages for `<honua-bookmarks>`. */
export interface HonuaBookmarksMessages {
  readonly status?: Partial<Readonly<Record<HonuaComponentStatus, string>>>;
  readonly empty?: string;
  readonly homeLabel?: string;
}

export interface HonuaLayerModel {
  id: string;
  title: string;
  sourceId?: string;
  type?: string;
  visible: boolean;
  /**
   * Layer paint opacity in the `[0, 1]` range. `undefined` means the style's
   * own opacity is untouched (treated as fully opaque by UI controls).
   */
  opacity?: number;
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
  sourceLayer?: string;
  featureId?: FeatureId;
  feature?: HonuaFeatureRecord<T>;
  subtitle?: string;
  score?: number;
  viewport?: HonuaViewportState;
}

export interface HonuaSelectionState<T = Record<string, unknown>> {
  sourceId?: string;
  sourceLayer?: string;
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
  /**
   * Sets a layer's paint opacity (clamped to `[0, 1]`). Optional so that
   * pre-existing controller implementations keep compiling; `<honua-layer-list>`
   * only renders opacity sliders when the controller implements it.
   */
  setLayerOpacity?(layerId: string, opacity: number): void;
  /**
   * Reorders a layer: inserts `layerId` before `beforeId` in the layer stack,
   * or moves it to the end (rendered on top) when `beforeId` is omitted.
   * Optional so that pre-existing controller implementations keep compiling;
   * `<honua-layer-list>` only renders reorder affordances when the controller
   * implements it.
   */
  moveLayer?(layerId: string, beforeId?: string): void;
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
  /** Whether a measurement drawing provider is configured. */
  canMeasure(): boolean;
  /** Whether a sketch drawing provider is configured. */
  canSketch(): boolean;
  /** Activate a measuring mode through the configured provider. */
  setMeasureMode(mode: HonuaMeasureMode): Promise<HonuaMeasureChangeDetail>;
  /** Activate a drawing mode through the configured provider. */
  setSketchMode(mode: HonuaSketchMode): Promise<HonuaSketchChangeDetail<T>>;
  destroy?(): void;
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
  /**
   * Optional drawing backend that powers `<honua-measure-control>`. When
   * omitted the control renders disabled with a "configure a provider"
   * affordance — measurement geometry is not available from the bare
   * in-memory controller by design. Supply an adapter (for example one backed
   * by maplibre-gl-draw) to enable distance/area measuring.
   */
  measurementGeometry?: HonuaMeasureProvider;
  /**
   * Optional drawing backend that powers `<honua-sketch-control>`. When
   * omitted the control renders disabled with a "configure a provider"
   * affordance. Supply an adapter to enable point/line/polygon sketching.
   */
  sketchGeometry?: HonuaSketchProvider<T>;
}

export interface HonuaWebComponentRuntimeLike<T = Record<string, unknown>> {
  readonly mapPackage: HonuaMapPackage;
  readonly composedStyle: { layers: readonly HonuaLayerSpecification[] };
  getLegend(): readonly HonuaMapPackageLegendEntry[];
  setLayerVisibility(layerId: string, visible: boolean): void;
  /** Optional runtime support for writing layer paint opacity. */
  setLayerOpacity?(layerId: string, opacity: number): void;
  /** Optional runtime support for reordering layers (MapLibre `beforeId` semantics). */
  moveLayer?(layerId: string, beforeId?: string): void;
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

/** Detail of the `honua-layer-opacity-change` event dispatched by `<honua-layer-list>`. */
export interface HonuaLayerOpacityChangeDetail {
  layerId: string;
  /** New opacity in `[0, 1]`. */
  opacity: number;
}

/** Detail of the `honua-layer-order-change` event dispatched by `<honua-layer-list>`. */
export interface HonuaLayerOrderChangeDetail {
  /** The layer that was moved. */
  layerId: string;
  /** Layer the moved layer was inserted before; absent when moved to the end (top). */
  beforeId?: string;
  /** Resulting layer id order (style order: last id renders on top). */
  order: readonly string[];
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

/**
 * One typeahead suggestion rendered by `<honua-search>` when a geocoding
 * provider is configured. Structurally compatible with the
 * `GeocodeSuggestion` shape returned by `HonuaGeocodingClient.suggest`
 * (`@honua/sdk-js/geocoding`).
 */
export interface HonuaSearchGeocodeSuggestion {
  text: string;
  magicKey?: string;
}

/**
 * One forward-geocode candidate consumed by `<honua-search>`. Structurally
 * compatible with the `GeocodeResult` shape returned by
 * `HonuaGeocodingClient.forwardGeocode` (`@honua/sdk-js/geocoding`).
 */
export interface HonuaSearchGeocodeCandidate {
  address: string;
  latitude: number;
  longitude: number;
  score?: number;
}

/**
 * Duck-typed geocoding provider accepted by the `<honua-search>` `geocoder`
 * property. A `HonuaGeocodingClient` instance from the stable
 * `@honua/sdk-js/geocoding` entrypoint satisfies this interface structurally
 * — the web-component kit never imports the geocoding client itself, proving
 * the provider seam. Custom providers (other geocoders, offline gazetteers)
 * only need `forwardGeocode`; `suggest` powers debounced typeahead when
 * available.
 */
export interface HonuaSearchGeocoderLike {
  suggest?(text: string, options?: { maxSuggestions?: number }): Promise<readonly HonuaSearchGeocodeSuggestion[]>;
  forwardGeocode(address: string, options?: { maxResults?: number }): Promise<readonly HonuaSearchGeocodeCandidate[]>;
}

/** Detail of the `honua-geocode-select` event dispatched by `<honua-search>`. */
export interface HonuaGeocodeSelectDetail {
  /** The query text that produced the candidate. */
  query: string;
  /** The chosen forward-geocode candidate. */
  candidate: HonuaSearchGeocodeCandidate;
  /** The viewport applied to the shared controller (center + zoom). */
  viewport: HonuaViewportState;
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

/**
 * Minimal duck-typed subset of `maplibre-gl.Map` required by
 * `<honua-measurement>`. Any MapLibre-GL `Map` instance satisfies this
 * interface, and tests can pass a plain stub (matching the duck-typing
 * posture of the `@honua/sdk-js/controls` kit and `src/runtime/runtime.ts`).
 */
export interface HonuaMeasurementMap {
  /** Subscribes to map events (`click`, `dblclick`). */
  on(type: string, listener: (event?: unknown) => void): unknown;
  /** Unsubscribes a listener registered with `on`. */
  off?(type: string, listener: (event?: unknown) => void): unknown;
  /** Optional style access used to render the in-progress sketch overlay. */
  addSource?(id: string, source: unknown): void;
  getSource?(id: string): unknown;
  addLayer?(layer: unknown, beforeId?: string): void;
  removeLayer?(id: string): void;
  getLayer?(id: string): unknown;
  removeSource?(id: string): void;
  /** Optional double-click-zoom handle disabled while a drawing mode is active. */
  doubleClickZoom?: { disable?(): void; enable?(): void };
}

/**
 * A drawn measurement geometry plus its computed result.
 *
 * Geometry is intentionally protocol-neutral (GeoJSON-style coordinates) so a
 * provider can be backed by maplibre-gl-draw, Terra Draw, a custom canvas
 * tool, or an in-memory fixture without the SDK depending on any of them.
 */
export interface HonuaMeasureResult {
  mode: HonuaMeasureMode;
  /** GeoJSON `[lng, lat]` positions describing the drawn line or ring. */
  coordinates: readonly (readonly [number, number])[];
  /** Total length in metres for distance mode. */
  distance?: number;
  /** Enclosed area in square metres for area mode. */
  area?: number;
}

export interface HonuaMeasureChangeDetail {
  mode: HonuaMeasureMode;
  status: HonuaComponentStatus;
  message?: string;
  result?: HonuaMeasureResult;
}

export type HonuaSketchMode = "off" | "point" | "line" | "polygon";

/**
 * A drawn sketch feature emitted by a {@link HonuaSketchProvider}.
 */
export interface HonuaSketchResult<T = Record<string, unknown>> {
  mode: HonuaSketchMode;
  /** Stable id for the drawn feature when the backend assigns one. */
  id?: FeatureId;
  /** Protocol-neutral GeoJSON geometry produced by the drawing backend. */
  geometry: HonuaTypedFeature<T>["geometry"];
  /** Optional attributes the backend attaches to the drawn feature. */
  attributes?: T;
}

/**
 * Minimal drawing-backend contract for the `<honua-measure-control>` widget.
 *
 * Implementations adapt a concrete drawing tool (for example a
 * maplibre-gl-draw instance) to the protocol-neutral measurement surface. The
 * SDK never imports a drawing library directly; consumers supply an adapter via
 * {@link CreateHonuaWebComponentControllerOptions.measurementGeometry}.
 */
export interface HonuaMeasureProvider {
  /**
   * Enter (or leave, when `mode === "off"`) a measuring mode. Returns the
   * current/last measurement result when one is immediately available.
   */
  startMode(mode: HonuaMeasureMode): HonuaMeasureResult | undefined | Promise<HonuaMeasureResult | undefined>;
  /** Stop measuring and discard any in-progress geometry. */
  stop?(): void;
  /** Subscribe to measurement results as the user draws. */
  onResult?(listener: (result: HonuaMeasureResult) => void): HonuaControllerSubscription;
}

/**
 * Minimal drawing-backend contract for the `<honua-sketch-control>` widget.
 *
 * @see HonuaMeasureProvider for the design rationale (no hard drawing-library
 *   dependency; adapters are supplied by the consumer).
 */
export interface HonuaSketchProvider<T = Record<string, unknown>> {
  /**
   * Enter (or leave, when `mode === "off"`) a drawing mode. Returns the
   * current/last sketch result when one is immediately available.
   */
  startMode(mode: HonuaSketchMode): HonuaSketchResult<T> | undefined | Promise<HonuaSketchResult<T> | undefined>;
  /** Stop drawing and discard any in-progress geometry. */
  stop?(): void;
  /** Subscribe to sketch results as the user draws. */
  onResult?(listener: (result: HonuaSketchResult<T>) => void): HonuaControllerSubscription;
}

export interface HonuaSketchChangeDetail<T = Record<string, unknown>> {
  mode: HonuaSketchMode;
  status: HonuaComponentStatus;
  message?: string;
  result?: HonuaSketchResult<T>;
}

/**
 * Detail carried by the `honua-export` event.
 *
 * Every string field is passed through the export pipeline's redaction pass
 * before it lands here (issue #683, REQ-002): an event listener, a console
 * logger, or an analytics hook that forwards this object cannot leak a
 * credential, a signed URL, or an authorization scope, even when the failure
 * that produced it originated inside a third-party adapter.
 */
export interface HonuaExportDetail {
  /**
   * Legacy wire label kept for compatibility with pre-#683 listeners:
   * `print`/`png`/`json` map to the `print`/`snapshot`/`state` export kinds.
   * Prefer {@link HonuaExportDetail.kind}.
   */
  format: "print" | "png" | "json";
  /**
   * Component status, so the element's `honua-export` event stays consistent
   * with every other `honua-*` event. `cancelled` exports report `idle`; use
   * {@link HonuaExportDetail.exportStatus} for the precise outcome.
   */
  status: HonuaComponentStatus;
  /** The export kind that was attempted. */
  kind?: "print" | "snapshot" | "state";
  /** Precise export outcome: `ready`, `unsupported`, `cancelled`, or `error`. */
  exportStatus?: "ready" | "unsupported" | "cancelled" | "error";
  title?: string;
  /** Redacted, displayable explanation. */
  message?: string;
  /** Adapter that served the request, when one was available. */
  adapterId?: string;
  /** Credential-safe download filename, on success. */
  filename?: string;
  mediaType?: string;
  /** Byte length of the produced artifact, when it carried bytes. */
  byteLength?: number;
  /** How many values the sanitizer withheld while building this export. */
  redactionCount?: number;
  /** Registered SDK error code, when the export did not succeed. */
  errorCode?: string;
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

export interface HonuaActionPanelMessages {
  label?: string;
  status?: Partial<Record<HonuaComponentStatus, string>>;
  empty?: string;
}

export interface HonuaActionDetail extends HonuaActionPanelAction {
  status: HonuaComponentStatus;
}
