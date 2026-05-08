/**
 * Framework-neutral generated-app preview runtime for the operations
 * dashboard proof profile.
 *
 * The runtime composes the existing MapPackage loader, ExplorationContext,
 * and interaction bindings into reusable widget models. Hosts own DOM,
 * framework, and MapLibre construction; this module owns manifest binding,
 * linked state, feature filtering, and structured preview errors.
 *
 * @module
 */

import type { FeatureId, Query } from "../contract/index.js";
import {
  type ExplorationContext,
  type ExplorationStateSnapshot,
  type ExplorationViewController,
  type FeatureSelectionTarget,
  type FilterClause,
  createExplorationContext,
  isSourceQualifiedSelectionTarget,
  selectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget,
} from "../exploration/index.js";
import {
  type ChartExplorationBinding,
  type FilterControlsExplorationBinding,
  type InteractionBindingHandle,
  type TableSelectionExplorationBinding,
  bindChartToExploration,
  bindFilterControlsToExploration,
  bindTableSelectionToExploration,
  syncFeatureStateSelection,
  syncMapLayerFilterToExploration,
} from "../interactions/index.js";
import {
  type HonuaMapPackage,
  type HonuaMapRuntime,
  type LegendEntry,
  type LoadMapPackageOptions,
  type MaplibreMap,
  loadMapPackage,
} from "../runtime/index.js";
import { HonuaGeneratedAppError, toGeneratedAppDiagnostic } from "./errors.js";
import type {
  HonuaGeneratedAppChartWidget,
  HonuaGeneratedAppCountWidget,
  HonuaGeneratedAppFeatureRecord,
  HonuaGeneratedAppFilterWidget,
  HonuaGeneratedAppManifest,
  HonuaGeneratedAppMapWidget,
  HonuaGeneratedAppPackage,
  HonuaGeneratedAppTableWidget,
  HonuaGeneratedAppWidget,
} from "./manifest.js";
import { assertGeneratedAppManifest, projectAppPackageToGeneratedAppManifest } from "./projection.js";

export type HonuaGeneratedAppFeatureInput<TAttributes extends Record<string, unknown> = Record<string, unknown>> =
  | HonuaGeneratedAppFeatureRecord<TAttributes>
  | {
      readonly id?: FeatureId;
      readonly sourceId?: string;
      readonly attributes?: TAttributes;
      readonly properties?: TAttributes;
      readonly geometry?: unknown;
      readonly [extra: string]: unknown;
    };

export interface HonuaGeneratedAppFeatureLoaderContext {
  readonly manifest: HonuaGeneratedAppManifest;
  readonly sourceId: string;
  readonly projection: ReturnType<typeof selectLinkedViewQueryProjection>;
  readonly mapRuntime: HonuaMapRuntime | undefined;
}

export type HonuaGeneratedAppFeatureLoader<TAttributes extends Record<string, unknown> = Record<string, unknown>> = (
  context: HonuaGeneratedAppFeatureLoaderContext,
) => Promise<ReadonlyArray<HonuaGeneratedAppFeatureInput<TAttributes>>>;

export interface HonuaGeneratedAppMapFactoryResult {
  readonly map: MaplibreMap;
  readonly dispose?: () => void;
}

export type HonuaGeneratedAppMapFactory = (
  widget: HonuaGeneratedAppMapWidget,
  manifest: HonuaGeneratedAppManifest,
) => HonuaGeneratedAppMapFactoryResult | Promise<HonuaGeneratedAppMapFactoryResult>;

export interface HonuaGeneratedAppLoadOptions<TAttributes extends Record<string, unknown> = Record<string, unknown>> {
  readonly mapPackage?: HonuaMapPackage;
  readonly mapFactory?: HonuaGeneratedAppMapFactory;
  readonly mapLoadOptions?: Omit<LoadMapPackageOptions, "telemetry">;
  readonly initialFeatures?: ReadonlyArray<HonuaGeneratedAppFeatureInput<TAttributes>>;
  readonly featureLoader?: HonuaGeneratedAppFeatureLoader<TAttributes>;
  readonly onEvent?: HonuaGeneratedAppRuntimeEventListener;
}

export interface HonuaGeneratedAppPreviewInput {
  readonly manifest?: HonuaGeneratedAppManifest;
  readonly appPackage?: HonuaGeneratedAppPackage;
  readonly mapPackage?: HonuaMapPackage;
}

export type HonuaGeneratedAppRuntimeEvent =
  | { readonly type: "loaded"; readonly appId: string }
  | { readonly type: "widget-bound"; readonly appId: string; readonly widgetId: string; readonly widgetKind: string }
  | { readonly type: "rendered"; readonly appId: string; readonly visibleCount: number }
  | { readonly type: "error"; readonly appId?: string; readonly error: HonuaGeneratedAppError }
  | { readonly type: "disposed"; readonly appId: string };

export type HonuaGeneratedAppRuntimeEventListener = (event: HonuaGeneratedAppRuntimeEvent) => void;

export interface HonuaGeneratedAppRenderedRow {
  readonly id: FeatureId;
  readonly sourceId: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly selected: boolean;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface HonuaGeneratedAppChartBucket {
  readonly value: string | number | boolean;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly targets: ReadonlyArray<FeatureSelectionTarget>;
}

export interface HonuaGeneratedAppFilterOptionModel {
  readonly value: string | number | boolean;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
}

export type HonuaGeneratedAppWidgetModel =
  | {
      readonly id: string;
      readonly kind: "map";
      readonly title?: string;
      readonly loaded: boolean;
      readonly mapPackageId?: string;
      readonly layerId?: string;
      readonly legend: ReadonlyArray<LegendEntry>;
      readonly searchFields: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly kind: "table" | "list";
      readonly title?: string;
      readonly sourceId: string;
      readonly rows: ReadonlyArray<HonuaGeneratedAppRenderedRow>;
      readonly fields: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly kind: "count";
      readonly title?: string;
      readonly label: string;
      readonly value: number;
    }
  | {
      readonly id: string;
      readonly kind: "chart";
      readonly title?: string;
      readonly sourceId: string;
      readonly groupBy: string;
      readonly buckets: ReadonlyArray<HonuaGeneratedAppChartBucket>;
    }
  | {
      readonly id: string;
      readonly kind: "filter";
      readonly title?: string;
      readonly sourceId: string;
      readonly field: string;
      readonly options: ReadonlyArray<HonuaGeneratedAppFilterOptionModel>;
    };

export interface HonuaGeneratedAppRenderModel {
  readonly status: "ready";
  readonly appId: string;
  readonly title?: string;
  readonly sourceId: string;
  readonly visibleCount: number;
  readonly totalCount: number;
  readonly widgets: ReadonlyArray<HonuaGeneratedAppWidgetModel>;
  readonly snapshot: ExplorationStateSnapshot;
}

export type HonuaGeneratedAppPreviewResult<TAttributes extends Record<string, unknown> = Record<string, unknown>> =
  | {
      readonly status: "ready";
      readonly manifest: HonuaGeneratedAppManifest;
      readonly runtime: HonuaGeneratedAppRuntime<TAttributes>;
      readonly model: HonuaGeneratedAppRenderModel;
      readonly errors: readonly [];
    }
  | {
      readonly status: "error";
      readonly manifest?: HonuaGeneratedAppManifest;
      readonly errors: ReadonlyArray<ReturnType<typeof toGeneratedAppDiagnostic>>;
    };

interface RuntimeBindings {
  readonly mapView?: ExplorationViewController;
  readonly table: Readonly<Record<string, TableSelectionExplorationBinding>>;
  readonly chart: Readonly<Record<string, ChartExplorationBinding>>;
  readonly filter: Readonly<Record<string, FilterControlsExplorationBinding>>;
}

interface RuntimeInternals<TAttributes extends Record<string, unknown> = Record<string, unknown>> {
  readonly manifest: HonuaGeneratedAppManifest;
  readonly context: ExplorationContext;
  readonly mapRuntime?: HonuaMapRuntime;
  readonly disposeMap?: () => void;
  readonly bindings: RuntimeBindings;
  readonly handles: ReadonlyArray<InteractionBindingHandle>;
  readonly initialFeatures?: ReadonlyArray<HonuaGeneratedAppFeatureInput<TAttributes>>;
  readonly featureLoader?: HonuaGeneratedAppFeatureLoader<TAttributes>;
  readonly onEvent?: HonuaGeneratedAppRuntimeEventListener;
}

export async function loadGeneratedAppRuntime<TAttributes extends Record<string, unknown> = Record<string, unknown>>(
  manifest: HonuaGeneratedAppManifest,
  options: HonuaGeneratedAppLoadOptions<TAttributes>,
): Promise<HonuaGeneratedAppRuntime<TAttributes>> {
  assertGeneratedAppManifest(manifest);
  assertOperationsDashboardWidgets(manifest);

  const sourceId = manifest.data.sourceId;
  const mapWidget = findWidget<HonuaGeneratedAppMapWidget>(manifest, "map");
  const mapPackage = manifest.mapPackage ?? options.mapPackage;
  assertMapPackageMatchesManifest(manifest, mapPackage);
  let mapRuntime: HonuaMapRuntime | undefined;
  let disposeMap: (() => void) | undefined;

  if (mapWidget) {
    if (!mapPackage) {
      throw new HonuaGeneratedAppError("missing-map-package", "generated-app map widget requires a MapPackage", {
        stage: "load",
        detail: { appId: manifest.appId, widgetId: mapWidget.id, path: "GeneratedAppManifest.mapPackage" },
      });
    }
    if (!options.mapFactory) {
      throw new HonuaGeneratedAppError("missing-binding", "generated-app map widget requires options.mapFactory", {
        stage: "load",
        detail: { appId: manifest.appId, widgetId: mapWidget.id, path: "HonuaGeneratedAppLoadOptions.mapFactory" },
      });
    }
    if (!options.mapLoadOptions) {
      throw new HonuaGeneratedAppError("missing-binding", "generated-app map widget requires options.mapLoadOptions", {
        stage: "load",
        detail: { appId: manifest.appId, widgetId: mapWidget.id, path: "HonuaGeneratedAppLoadOptions.mapLoadOptions" },
      });
    }

    try {
      const factoryResult = await options.mapFactory(mapWidget, manifest);
      disposeMap = factoryResult.dispose;
      mapRuntime = await loadMapPackage(mapPackage, factoryResult.map, {
        ...options.mapLoadOptions,
        applyInitialView: options.mapLoadOptions.applyInitialView ?? true,
      });
    } catch (cause) {
      if (mapRuntime) mapRuntime.dispose();
      disposeMap?.();
      throw new HonuaGeneratedAppError("map-load-failed", "generated-app map widget failed to load", {
        stage: "load",
        detail: { appId: manifest.appId, widgetId: mapWidget.id, widgetKind: "map" },
        cause,
      });
    }
  }

  const sourceIds = unique([sourceId, ...(mapPackage?.sourceBindings.map((binding) => binding.sourceId) ?? [])]);
  const context = createExplorationContext({
    datasetId: manifest.appId,
    sourceIds,
    initialState: manifest.initialState,
    preset: manifest.linkedViewPreset ?? "globalLinked",
  });

  const handles: InteractionBindingHandle[] = [];
  const table: Record<string, TableSelectionExplorationBinding> = {};
  const chart: Record<string, ChartExplorationBinding> = {};
  const filter: Record<string, FilterControlsExplorationBinding> = {};
  let mapView: ExplorationViewController | undefined;

  for (const widget of manifest.layout.widgets) {
    switch (widget.kind) {
      case "map": {
        mapView = context.connectView({ id: widget.id, role: "map" });
        const layerId = mapLayerIdForWidget(widget, manifest);
        if (mapRuntime && layerId && mapRuntime.map.setFilter) {
          const setFilter = mapRuntime.map.setFilter.bind(mapRuntime.map);
          handles.push(
            syncMapLayerFilterToExploration({ setFilter }, mapView, {
              layerId,
              sourceId,
              translate: (projection) => compileMapLibreFilters(projection.filters, sourceId),
            }),
          );
          handles.push(
            syncFeatureStateSelection(mapRuntime.map, mapView, {
              source: sourceId,
              sourceLayer: widget.sourceLayer,
              includeRawIds: false,
            }),
          );
        }
        break;
      }
      case "table":
      case "list": {
        const view = context.connectView({ id: widget.id, role: "grid" });
        table[widget.id] = bindTableSelectionToExploration(view);
        break;
      }
      case "chart": {
        const view = context.connectView({ id: widget.id, role: "chart" });
        const binding = bindChartToExploration(view);
        binding.setGrouping([widget.groupBy]);
        binding.setAggregation({ groupBy: [widget.groupBy], metrics: [widget.metric ?? { fn: "count", field: "*" }] });
        chart[widget.id] = binding;
        break;
      }
      case "filter": {
        const view = context.connectView({ id: widget.id, role: "filter" });
        filter[widget.id] = bindFilterControlsToExploration(view);
        break;
      }
      case "count":
        break;
    }
    options.onEvent?.({ type: "widget-bound", appId: manifest.appId, widgetId: widget.id, widgetKind: widget.kind });
  }

  const runtime = new HonuaGeneratedAppRuntime<TAttributes>({
    manifest,
    context,
    mapRuntime,
    disposeMap,
    bindings: { mapView, table, chart, filter },
    handles,
    initialFeatures: options.initialFeatures,
    featureLoader: options.featureLoader,
    onEvent: options.onEvent,
  });
  try {
    await runtime.refresh();
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  options.onEvent?.({ type: "loaded", appId: manifest.appId });
  return runtime;
}

export async function previewGeneratedApp<TAttributes extends Record<string, unknown> = Record<string, unknown>>(
  input: HonuaGeneratedAppPreviewInput,
  options: HonuaGeneratedAppLoadOptions<TAttributes>,
): Promise<HonuaGeneratedAppPreviewResult<TAttributes>> {
  let manifest = input.manifest;
  try {
    if (!manifest && input.appPackage) {
      manifest = projectAppPackageToGeneratedAppManifest(input.appPackage, {
        mapPackage: input.mapPackage ?? options.mapPackage,
      });
    }
    if (!manifest) {
      throw new HonuaGeneratedAppError("missing-manifest", "previewGeneratedApp requires manifest or appPackage", {
        stage: "projection",
        detail: { path: "HonuaGeneratedAppPreviewInput.manifest" },
      });
    }
    const runtime = await loadGeneratedAppRuntime(manifest, {
      ...options,
      mapPackage: input.mapPackage ?? options.mapPackage,
    });
    return {
      status: "ready",
      manifest,
      runtime,
      model: runtime.render(),
      errors: [],
    };
  } catch (error) {
    const diagnostic = toGeneratedAppDiagnostic(error);
    if (error instanceof HonuaGeneratedAppError) options.onEvent?.({ type: "error", appId: manifest?.appId, error });
    return {
      status: "error",
      ...(manifest ? { manifest } : {}),
      errors: [diagnostic],
    };
  }
}

export class HonuaGeneratedAppRuntime<TAttributes extends Record<string, unknown> = Record<string, unknown>> {
  public readonly manifest: HonuaGeneratedAppManifest;
  public readonly context: ExplorationContext;
  public readonly mapRuntime: HonuaMapRuntime | undefined;

  readonly #disposeMap: (() => void) | undefined;
  readonly #bindings: RuntimeBindings;
  readonly #handles: ReadonlyArray<InteractionBindingHandle>;
  readonly #initialFeatures: ReadonlyArray<HonuaGeneratedAppFeatureInput<TAttributes>> | undefined;
  readonly #featureLoader: HonuaGeneratedAppFeatureLoader<TAttributes> | undefined;
  readonly #listeners = new Set<HonuaGeneratedAppRuntimeEventListener>();
  #records: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>> = [];
  #disposed = false;

  public constructor(internals: RuntimeInternals<TAttributes>) {
    this.manifest = internals.manifest;
    this.context = internals.context;
    this.mapRuntime = internals.mapRuntime;
    this.#disposeMap = internals.disposeMap;
    this.#bindings = internals.bindings;
    this.#handles = internals.handles;
    this.#initialFeatures = internals.initialFeatures;
    this.#featureLoader = internals.featureLoader;
    if (internals.onEvent) this.#listeners.add(internals.onEvent);
  }

  public on(listener: HonuaGeneratedAppRuntimeEventListener): { remove(): void } {
    this.#listeners.add(listener);
    return {
      remove: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public async refresh(): Promise<HonuaGeneratedAppRenderModel> {
    this.#assertLive("refresh");
    try {
      this.#records = await this.#loadFeatureRecords();
      return this.render();
    } catch (cause) {
      const error = new HonuaGeneratedAppError("data-load-failed", "generated-app feature data failed to load", {
        stage: "load",
        detail: { appId: this.manifest.appId, sourceId: this.manifest.data.sourceId },
        cause,
      });
      this.#emit({ type: "error", appId: this.manifest.appId, error });
      throw error;
    }
  }

  public render(): HonuaGeneratedAppRenderModel {
    this.#assertLive("render");
    const sourceId = this.manifest.data.sourceId;
    const projection = selectLinkedViewQueryProjection(this.context.state, { sourceId });
    const filtered = applyProjection(this.#records, projection.filters, projection.selection, sourceId);
    const paged = applySortAndPagination(filtered, this.context.state.sort, this.context.state.page);
    const widgets = this.manifest.layout.widgets.map((widget) => this.#renderWidget(widget, paged, filtered));
    const model: HonuaGeneratedAppRenderModel = {
      status: "ready",
      appId: this.manifest.appId,
      ...(this.manifest.title ? { title: this.manifest.title } : {}),
      sourceId,
      visibleCount: filtered.length,
      totalCount: this.#records.length,
      widgets,
      snapshot: this.context.snapshot(),
    };
    this.#emit({ type: "rendered", appId: this.manifest.appId, visibleCount: filtered.length });
    return model;
  }

  public setFilter(widgetId: string, value: string | number | boolean | undefined): HonuaGeneratedAppRenderModel {
    this.#assertLive("setFilter");
    const widget = this.#requireWidget<HonuaGeneratedAppFilterWidget>(widgetId, "filter");
    const binding = this.#bindings.filter[widgetId];
    if (!binding) {
      throw missingWidgetBinding(this.manifest.appId, widgetId, "filter");
    }
    if (value === undefined) {
      binding.clearFilter(widget.id);
    } else {
      binding.setFilter(widget.id, {
        field: widget.field,
        operator: "=",
        value,
        appliesTo: [widget.sourceId ?? this.manifest.data.sourceId],
      });
    }
    return this.render();
  }

  public selectChartBucket(
    widgetId: string,
    value: string | number | boolean | undefined,
  ): HonuaGeneratedAppRenderModel {
    this.#assertLive("selectChartBucket");
    const widget = this.#requireWidget<HonuaGeneratedAppChartWidget>(widgetId, "chart");
    const binding = this.#bindings.chart[widgetId];
    if (!binding) {
      throw missingWidgetBinding(this.manifest.appId, widgetId, "chart");
    }
    const sourceId = widget.sourceId ?? this.manifest.data.sourceId;
    binding.setGrouping([widget.groupBy]);
    binding.setAggregation({ groupBy: [widget.groupBy], metrics: [widget.metric ?? { fn: "count", field: "*" }] });
    for (const [id, clause] of Object.entries(this.context.state.filters)) {
      if (id !== widget.id && clause.field === widget.groupBy) {
        this.context.dispatch({ kind: "clear-filter", id, viewId: widget.id });
      }
    }
    if (value === undefined) {
      this.context.dispatch({ kind: "clear-filter", id: widget.id, viewId: widget.id });
    } else {
      binding.selectBucket({
        filters: {
          [widget.id]: {
            field: widget.groupBy,
            operator: "=",
            value,
            appliesTo: [sourceId],
          },
        },
      });
    }
    return this.render();
  }

  public selectRecord(
    widgetId: string,
    id: FeatureId,
    options: { readonly replace?: boolean } = {},
  ): HonuaGeneratedAppRenderModel {
    this.#assertLive("selectRecord");
    this.#requireWidget<HonuaGeneratedAppTableWidget>(widgetId, ["table", "list"]);
    const binding = this.#bindings.table[widgetId];
    if (!binding) {
      throw missingWidgetBinding(this.manifest.appId, widgetId, "table");
    }
    binding.select([sourceFeatureSelectionTarget(this.manifest.data.sourceId, id)], {
      replace: options.replace ?? true,
    });
    return this.render();
  }

  public snapshot(): ExplorationStateSnapshot {
    this.#assertLive("snapshot");
    return this.context.snapshot();
  }

  public restore(snapshot: ExplorationStateSnapshot): HonuaGeneratedAppRenderModel {
    this.#assertLive("restore");
    this.context.restore(snapshot);
    return this.render();
  }

  public dispose(): void {
    if (this.#disposed) return;
    for (const handle of this.#handles) handle.remove();
    this.mapRuntime?.dispose();
    this.#disposeMap?.();
    this.context.dispose();
    this.#disposed = true;
    this.#emit({ type: "disposed", appId: this.manifest.appId });
    this.#listeners.clear();
  }

  async #loadFeatureRecords(): Promise<ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>> {
    const sourceId = this.manifest.data.sourceId;
    const projection = selectLinkedViewQueryProjection(this.context.state, { sourceId });
    const raw =
      this.#initialFeatures ??
      (this.#featureLoader
        ? await this.#featureLoader({ manifest: this.manifest, sourceId, projection, mapRuntime: this.mapRuntime })
        : await loadFeaturesFromMapRuntime(this.manifest, this.mapRuntime, projection));
    return raw.map((feature, index) =>
      normalizeFeatureRecord(feature as HonuaGeneratedAppFeatureInput, sourceId, this.#primaryKey(), index),
    );
  }

  #renderWidget(
    widget: HonuaGeneratedAppWidget,
    pagedRecords: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
    filteredRecords: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
  ): HonuaGeneratedAppWidgetModel {
    const sourceId = widget.sourceId ?? this.manifest.data.sourceId;
    switch (widget.kind) {
      case "map":
        return {
          id: widget.id,
          kind: "map",
          ...(widget.title ? { title: widget.title } : {}),
          loaded: Boolean(this.mapRuntime),
          mapPackageId: this.mapRuntime?.mapPackage.mapPackageId ?? this.manifest.mapPackageId,
          layerId: mapLayerIdForWidget(widget, this.manifest),
          legend: widget.showLegend === false ? [] : (this.mapRuntime?.getLegend() ?? []),
          searchFields: widget.showSearch === false ? [] : (this.manifest.bindings?.searchFields ?? []),
        };
      case "table":
      case "list": {
        const fields = widget.fields ?? this.manifest.bindings?.tableFields ?? inferFields(pagedRecords);
        return {
          id: widget.id,
          kind: widget.kind,
          ...(widget.title ? { title: widget.title } : {}),
          sourceId,
          fields,
          rows: pagedRecords.map((record) => this.#rowModel(record, fields, widget)),
        };
      }
      case "count":
        return {
          id: widget.id,
          kind: "count",
          ...(widget.title ? { title: widget.title } : {}),
          label: widget.label ?? widget.title ?? "Records",
          value: filteredRecords.length,
        };
      case "chart":
        return {
          id: widget.id,
          kind: "chart",
          ...(widget.title ? { title: widget.title } : {}),
          sourceId,
          groupBy: widget.groupBy,
          buckets: chartBuckets(filteredRecords, widget, sourceId, this.context.state.filters),
        };
      case "filter":
        return {
          id: widget.id,
          kind: "filter",
          ...(widget.title ? { title: widget.title } : {}),
          sourceId,
          field: widget.field,
          options: filterOptions(this.#records, this.context.state.filters, widget, sourceId),
        };
    }
  }

  #rowModel(
    record: HonuaGeneratedAppFeatureRecord<Record<string, unknown>>,
    fields: ReadonlyArray<string>,
    widget: HonuaGeneratedAppTableWidget,
  ): HonuaGeneratedAppRenderedRow {
    const titleField = widget.titleField ?? this.manifest.bindings?.titleField ?? this.#primaryKey();
    const subtitleField = widget.subtitleField ?? this.manifest.bindings?.subtitleField;
    return {
      id: record.id,
      sourceId: record.sourceId ?? this.manifest.data.sourceId,
      title: stringValue(record.attributes[titleField] ?? record.id),
      ...(subtitleField ? { subtitle: stringValue(record.attributes[subtitleField] ?? "") } : {}),
      selected: selectionContains(this.context.state.selection, record, this.manifest.data.sourceId),
      values: Object.fromEntries(fields.map((field) => [field, record.attributes[field]])),
    };
  }

  #primaryKey(): string {
    return this.manifest.bindings?.primaryKey ?? "OBJECTID";
  }

  #requireWidget<TWidget extends HonuaGeneratedAppWidget>(
    widgetId: string,
    expected: HonuaGeneratedAppWidget["kind"] | ReadonlyArray<HonuaGeneratedAppWidget["kind"]>,
  ): TWidget {
    const widget = this.manifest.layout.widgets.find((entry) => entry.id === widgetId);
    const expectedKinds = Array.isArray(expected) ? expected : [expected];
    if (!widget || !expectedKinds.includes(widget.kind)) {
      throw new HonuaGeneratedAppError("missing-widget", `generated-app widget "${widgetId}" is not available`, {
        stage: "interaction",
        detail: { appId: this.manifest.appId, widgetId, expected: expectedKinds, received: widget?.kind },
      });
    }
    return widget as TWidget;
  }

  #assertLive(operation: string): void {
    if (this.#disposed) {
      throw new HonuaGeneratedAppError("disposed", `generated-app runtime cannot ${operation} after dispose()`, {
        stage: "dispose",
        detail: { appId: this.manifest.appId },
      });
    }
  }

  #emit(event: HonuaGeneratedAppRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

async function loadFeaturesFromMapRuntime(
  manifest: HonuaGeneratedAppManifest,
  mapRuntime: HonuaMapRuntime | undefined,
  projection: ReturnType<typeof selectLinkedViewQueryProjection>,
): Promise<ReadonlyArray<HonuaGeneratedAppFeatureInput>> {
  const source = mapRuntime?.dataset.source(manifest.data.sourceId);
  if (!source) {
    throw new HonuaGeneratedAppError("missing-binding", "generated-app source is not available from the MapPackage", {
      stage: "load",
      detail: {
        appId: manifest.appId,
        sourceId: manifest.data.sourceId,
        path: "HonuaMapRuntime.dataset.source",
      },
    });
  }
  const query: Query = {
    returnGeometry: true,
    outFields: manifest.bindings?.tableFields,
    orderBy: projection.orderBy,
    pagination: projection.pagination.limit
      ? projection.pagination
      : { ...projection.pagination, limit: manifest.data.previewLimit ?? 250 },
  };
  const result = await source.query(query);
  return result.features.map((feature) => ({
    attributes: feature.attributes,
    geometry: feature.geometry,
  }));
}

function assertOperationsDashboardWidgets(manifest: HonuaGeneratedAppManifest): void {
  const supported = new Set(["map", "table", "list", "count", "chart", "filter"]);
  for (const widget of manifest.layout.widgets) {
    if (!supported.has(widget.kind)) {
      throw new HonuaGeneratedAppError("unsupported-widget", `unsupported generated-app widget "${widget.kind}"`, {
        stage: "manifest",
        detail: { appId: manifest.appId, widgetId: widget.id, widgetKind: widget.kind },
      });
    }
  }

  const requiredKinds = ["map", "count", "chart", "filter"] as const;
  for (const kind of requiredKinds) {
    if (!manifest.layout.widgets.some((widget) => widget.kind === kind)) {
      throw new HonuaGeneratedAppError("missing-widget", `operations dashboard manifest is missing ${kind} widget`, {
        stage: "manifest",
        detail: { appId: manifest.appId, expected: kind },
      });
    }
  }
  if (!manifest.layout.widgets.some((widget) => widget.kind === "table" || widget.kind === "list")) {
    throw new HonuaGeneratedAppError("missing-widget", "operations dashboard manifest is missing table/list widget", {
      stage: "manifest",
      detail: { appId: manifest.appId, expected: "table|list" },
    });
  }
}

function findWidget<TWidget extends HonuaGeneratedAppWidget>(
  manifest: HonuaGeneratedAppManifest,
  kind: TWidget["kind"],
): TWidget | undefined {
  return manifest.layout.widgets.find((widget) => widget.kind === kind) as TWidget | undefined;
}

function mapLayerIdForWidget(
  widget: HonuaGeneratedAppMapWidget,
  manifest: HonuaGeneratedAppManifest,
): string | undefined {
  return widget.layerId ?? manifest.bindings?.layerId;
}

function assertMapPackageMatchesManifest(
  manifest: HonuaGeneratedAppManifest,
  mapPackage: HonuaMapPackage | undefined,
): void {
  if (!manifest.mapPackageId || !mapPackage || manifest.mapPackageId === mapPackage.mapPackageId) return;
  throw new HonuaGeneratedAppError(
    "map-package-mismatch",
    `generated-app MapPackage "${mapPackage.mapPackageId}" does not match manifest mapPackageId "${manifest.mapPackageId}"`,
    {
      stage: "load",
      detail: {
        appId: manifest.appId,
        path: "GeneratedAppManifest.mapPackageId",
        expected: manifest.mapPackageId,
        received: mapPackage.mapPackageId,
      },
    },
  );
}

function missingWidgetBinding(appId: string, widgetId: string, widgetKind: string): HonuaGeneratedAppError {
  return new HonuaGeneratedAppError("missing-binding", `generated-app widget "${widgetId}" is not bound`, {
    stage: "interaction",
    detail: { appId, widgetId, widgetKind },
  });
}

function normalizeFeatureRecord(
  input: HonuaGeneratedAppFeatureInput,
  sourceId: string,
  primaryKey: string,
  index: number,
): HonuaGeneratedAppFeatureRecord<Record<string, unknown>> {
  const raw = input as Readonly<Record<string, unknown>>;
  const attributes = asRecord(raw.attributes) ?? asRecord(raw.properties) ?? {};
  const candidateId = raw.id ?? attributes[primaryKey] ?? attributes.OBJECTID ?? attributes.objectId ?? attributes.id;
  const id = typeof candidateId === "string" || typeof candidateId === "number" ? candidateId : `${sourceId}:${index}`;
  return {
    id,
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : sourceId,
    attributes,
    ...(raw.geometry !== undefined ? { geometry: raw.geometry } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function applyProjection(
  records: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
  filters: Readonly<Record<string, FilterClause>>,
  selection: ReadonlyArray<FeatureSelectionTarget>,
  sourceId: string,
): ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>> {
  return records.filter(
    (record) =>
      Object.values(filters).every((clause) => matchesClause(record, clause, sourceId)) ||
      selectionContains(selection, record, sourceId),
  );
}

function applySortAndPagination(
  records: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
  sort: ReadonlyArray<{ readonly field: string; readonly direction?: "asc" | "desc" }>,
  page: { readonly offset?: number; readonly limit?: number },
): ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>> {
  const sorted = [...records];
  for (const entry of [...sort].reverse()) {
    sorted.sort((a, b) => compareValues(a.attributes[entry.field], b.attributes[entry.field], entry.direction));
  }
  const offset = page.offset ?? 0;
  const limit = page.limit;
  return limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
}

function matchesClause(
  record: HonuaGeneratedAppFeatureRecord<Record<string, unknown>>,
  clause: FilterClause,
  fallbackSourceId: string,
): boolean {
  const sourceId = record.sourceId ?? fallbackSourceId;
  if (clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(sourceId)) return true;
  const value = record.attributes[clause.field];
  switch (clause.operator) {
    case "=":
      return value === clause.value;
    case "!=":
      return value !== clause.value;
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(value);
    case "not-in":
      return Array.isArray(clause.value) && !clause.value.includes(value);
    case "like":
      return typeof value === "string" && typeof clause.value === "string" && value.includes(clause.value);
    case "is-null":
      return value === null || value === undefined;
    case "is-not-null":
      return value !== null && value !== undefined;
    case "<":
      return typeof value === "number" && typeof clause.value === "number" && value < clause.value;
    case "<=":
      return typeof value === "number" && typeof clause.value === "number" && value <= clause.value;
    case ">":
      return typeof value === "number" && typeof clause.value === "number" && value > clause.value;
    case ">=":
      return typeof value === "number" && typeof clause.value === "number" && value >= clause.value;
    case "between":
      return (
        typeof value === "number" &&
        Array.isArray(clause.value) &&
        typeof clause.value[0] === "number" &&
        typeof clause.value[1] === "number" &&
        value >= clause.value[0] &&
        value <= clause.value[1]
      );
  }
}

function compileMapLibreFilters(filters: Readonly<Record<string, FilterClause>>, sourceId: string): unknown[] {
  const compiled = Object.values(filters)
    .filter((clause) => !clause.appliesTo || clause.appliesTo.length === 0 || clause.appliesTo.includes(sourceId))
    .map(clauseToMapLibreFilter)
    .filter((entry): entry is unknown[] => Array.isArray(entry));
  return compiled.length === 0 ? ["all"] : ["all", ...compiled];
}

function clauseToMapLibreFilter(clause: FilterClause): unknown[] | undefined {
  switch (clause.operator) {
    case "=":
      return ["==", clause.field, clause.value];
    case "!=":
      return ["!=", clause.field, clause.value];
    case "in":
      return Array.isArray(clause.value) ? ["in", clause.field, ...clause.value] : undefined;
    case "not-in":
      return Array.isArray(clause.value) ? ["!in", clause.field, ...clause.value] : undefined;
    case "is-null":
      return ["==", clause.field, null];
    case "is-not-null":
      return ["!=", clause.field, null];
    default:
      return undefined;
  }
}

function chartBuckets(
  records: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
  widget: HonuaGeneratedAppChartWidget,
  sourceId: string,
  filters: Readonly<Record<string, FilterClause>>,
): ReadonlyArray<HonuaGeneratedAppChartBucket> {
  const buckets = new Map<
    string,
    { value: string | number | boolean; count: number; targets: FeatureSelectionTarget[] }
  >();
  for (const record of records) {
    const value = scalarBucketValue(record.attributes[widget.groupBy]);
    if (value === undefined) continue;
    const key = String(value);
    const bucket = buckets.get(key) ?? { value, count: 0, targets: [] };
    bucket.count += 1;
    bucket.targets.push(sourceFeatureSelectionTarget(record.sourceId ?? sourceId, record.id));
    buckets.set(key, bucket);
  }
  const active = filters[widget.id]?.value;
  return [...buckets.values()]
    .sort((a, b) => compareValues(a.value, b.value))
    .map((bucket) => ({
      value: bucket.value,
      label: stringValue(bucket.value),
      count: bucket.count,
      selected: active === bucket.value,
      targets: bucket.targets,
    }));
}

function filterOptions(
  records: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
  filters: Readonly<Record<string, FilterClause>>,
  widget: HonuaGeneratedAppFilterWidget,
  sourceId: string,
): ReadonlyArray<HonuaGeneratedAppFilterOptionModel> {
  const counts = new Map<string, { value: string | number | boolean; count: number }>();
  const active = filters[widget.id]?.value;
  const explicit = widget.options ?? [];
  for (const option of explicit) {
    counts.set(String(option.value), { value: option.value, count: 0 });
  }
  for (const record of records) {
    if (!Object.entries(filters).every(([id, clause]) => id === widget.id || matchesClause(record, clause, sourceId))) {
      continue;
    }
    const value = scalarBucketValue(record.attributes[widget.field]);
    if (value === undefined) continue;
    const key = String(value);
    const entry = counts.get(key) ?? { value, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => compareValues(a.value, b.value))
    .map((entry) => {
      const configured = explicit.find((option) => option.value === entry.value);
      return {
        value: entry.value,
        label: configured?.label ?? stringValue(entry.value),
        count: entry.count,
        selected: active === entry.value,
      };
    });
}

function selectionContains(
  selection: ReadonlyArray<FeatureSelectionTarget>,
  record: HonuaGeneratedAppFeatureRecord<Record<string, unknown>>,
  fallbackSourceId: string,
): boolean {
  const sourceId = record.sourceId ?? fallbackSourceId;
  return selection.some((target) => {
    if (isSourceQualifiedSelectionTarget(target)) return target.sourceId === sourceId && target.id === record.id;
    return target === record.id;
  });
}

function inferFields(
  records: ReadonlyArray<HonuaGeneratedAppFeatureRecord<Record<string, unknown>>>,
): ReadonlyArray<string> {
  const first = records[0];
  return first ? Object.keys(first.attributes).slice(0, 6) : [];
}

function compareValues(a: unknown, b: unknown, direction: "asc" | "desc" = "asc"): number {
  const multiplier = direction === "desc" ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * multiplier;
  return stringValue(a).localeCompare(stringValue(b)) * multiplier;
}

function scalarBucketValue(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}
