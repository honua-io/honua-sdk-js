import type { FeatureId, Query } from "../contract/index.js";
import { trimChar } from "../core/path-utils.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type { HonuaLayerSpecification } from "../style/index.js";
import type {
  CreateHonuaWebComponentControllerOptions,
  HonuaChartModel,
  HonuaComponentStatus,
  HonuaControllerStateListener,
  HonuaEditorModel,
  HonuaFeatureRecord,
  HonuaFeatureStateEntry,
  HonuaFeatureStateTarget,
  HonuaFeatureTableModel,
  HonuaFilterState,
  HonuaLayerModel,
  HonuaLegendItem,
  HonuaMeasureChangeDetail,
  HonuaMeasureMode,
  HonuaMeasureProvider,
  HonuaQueryFeaturesOptions,
  HonuaSearchOptions,
  HonuaSearchResult,
  HonuaSelectionState,
  HonuaSketchChangeDetail,
  HonuaSketchMode,
  HonuaSketchProvider,
  HonuaViewportState,
  HonuaWebComponentController,
  HonuaWebComponentRuntimeLike,
  HonuaWebComponentState,
} from "./types.js";

export class HonuaInMemoryWebComponentController<T = Record<string, unknown>>
  implements HonuaWebComponentController<T>
{
  readonly #listeners = new Set<HonuaControllerStateListener<T>>();
  readonly #fieldsBySource = new Map<string, readonly string[]>();
  readonly #searchFields: readonly string[] | undefined;
  readonly #runtime: HonuaWebComponentRuntimeLike<T> | undefined;
  readonly #measurementGeometry: HonuaMeasureProvider | undefined;
  readonly #sketchGeometry: HonuaSketchProvider<T> | undefined;
  #runtimeHandle: { remove(): void } | undefined;
  #state: HonuaWebComponentState<T>;

  public constructor(
    options: CreateHonuaWebComponentControllerOptions<T> & {
      runtime?: HonuaWebComponentRuntimeLike<T>;
    } = {},
  ) {
    this.#runtime = options.runtime;
    this.#measurementGeometry = options.measurementGeometry;
    this.#sketchGeometry = options.sketchGeometry;
    this.#searchFields = options.searchFields;
    for (const [sourceId, fields] of Object.entries(options.fieldsBySource ?? {})) {
      this.#fieldsBySource.set(sourceId, [...fields]);
    }

    const layers = options.layers
      ? options.layers.map(copyLayerModel)
      : options.mapPackage
        ? layersFromMapPackage(options.mapPackage.mapSpec.layers)
        : [];
    const legend = options.legend
      ? options.legend.map(copyLegendItem)
      : options.mapPackage
        ? legendFromMapPackage(options.mapPackage.legend, layers, options.mapPackage.mapSpec.layers)
        : [];
    const featuresBySource = normalizeFeaturesBySource(options.featuresBySource ?? {});
    this.#state = {
      packageId: options.mapPackage?.mapPackageId,
      status: options.status ?? "ready",
      ...(options.mapPackage ? { mapPackage: options.mapPackage } : {}),
      layers,
      legend,
      viewport: { ...(options.viewport ?? options.mapPackage?.initialView ?? {}) },
      featuresBySource,
      filters: {},
      featureStates: [],
      ...(options.editor || options.mapPackage
        ? { editor: normalizeEditor(options.editor, firstSourceId(featuresBySource, layers)) }
        : {}),
      ...(options.chart ? { chart: copyChartModel(options.chart) } : {}),
      refreshedAt: new Date().toISOString(),
    };

    this.#runtimeHandle = this.#runtime?.on?.((event) => {
      if (event.type === "source-error" && event.sourceId) {
        this.#state = { ...this.#state, status: "error" };
        this.#notify();
      }
    });
  }

  public getState(): HonuaWebComponentState<T> {
    return copyState(this.#state);
  }

  public subscribe(listener: HonuaControllerStateListener<T>): { remove(): void } {
    this.#listeners.add(listener);
    listener(this.getState());
    return {
      remove: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public setLayerVisibility(layerId: string, visible: boolean): void {
    this.#runtime?.setLayerVisibility(layerId, visible);
    this.#state = {
      ...this.#state,
      layers: this.#state.layers.map((layer) => (layer.id === layerId ? { ...layer, visible } : layer)),
    };
    this.#notify();
  }

  public setLayerOpacity(layerId: string, opacity: number): void {
    if (!Number.isFinite(opacity)) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    if (!this.#state.layers.some((layer) => layer.id === layerId)) return;
    this.#runtime?.setLayerOpacity?.(layerId, clamped);
    this.#state = {
      ...this.#state,
      layers: this.#state.layers.map((layer) => (layer.id === layerId ? { ...layer, opacity: clamped } : layer)),
    };
    this.#notify();
  }

  public moveLayer(layerId: string, beforeId?: string): void {
    if (layerId === beforeId) return;
    const layers = this.#state.layers.map(copyLayerModel);
    const fromIndex = layers.findIndex((layer) => layer.id === layerId);
    if (fromIndex === -1) return;
    const moved = layers.splice(fromIndex, 1)[0];
    if (!moved) return;
    const targetIndex = beforeId === undefined ? layers.length : layers.findIndex((layer) => layer.id === beforeId);
    if (targetIndex === -1) return;
    layers.splice(targetIndex, 0, moved);
    this.#runtime?.moveLayer?.(layerId, beforeId);
    this.#state = { ...this.#state, layers };
    this.#notify();
  }

  public setViewport(viewport: HonuaViewportState): void {
    this.#runtime?.setViewState(viewport);
    this.#state = {
      ...this.#state,
      viewport: { ...this.#state.viewport, ...viewport },
    };
    this.#notify();
  }

  public setFilter(filter: HonuaFilterState): void {
    const sourceId = filter.sourceId ?? firstSourceId(this.#state.featuresBySource, this.#state.layers);
    if (!sourceId) return;
    this.#state = {
      ...this.#state,
      filters: {
        ...this.#state.filters,
        [sourceId]: { ...filter, sourceId },
      },
    };
    this.#notify();
  }

  public selectFeature(selection: HonuaSelectionState<T>): void {
    const sourceId = selection.sourceId;
    const sourceLayer = selection.sourceLayer;
    const featureId = selection.featureId;
    const feature =
      selection.feature ??
      (sourceId !== undefined && featureId !== undefined
        ? this.#state.featuresBySource[sourceId]?.find((row) => String(row.id) === String(featureId))
        : undefined);
    this.#state = {
      ...this.#state,
      selection: {
        ...(sourceId !== undefined ? { sourceId } : {}),
        ...(sourceLayer !== undefined ? { sourceLayer } : {}),
        ...(featureId !== undefined ? { featureId } : {}),
        ...(feature ? { feature: copyFeature(feature) } : {}),
      },
      ...(this.#state.editor
        ? {
            editor: {
              ...this.#state.editor,
              ...(featureId !== undefined ? { selectedFeatureId: featureId } : {}),
            },
          }
        : {}),
    };
    this.#notify();
  }

  public clearSelection(): void {
    this.#state = {
      ...this.#state,
      selection: undefined,
      ...(this.#state.editor
        ? {
            editor: {
              ...this.#state.editor,
              selectedFeatureId: undefined,
            },
          }
        : {}),
    };
    this.#notify();
  }

  public setFeatureState(target: HonuaFeatureStateTarget, state: Record<string, unknown>): void {
    const key = featureStateKey(target);
    const previous = this.#state.featureStates.find((entry) => featureStateKey(entry) === key);
    const nextEntry: HonuaFeatureStateEntry = {
      sourceId: target.sourceId,
      featureId: target.featureId,
      ...(target.sourceLayer !== undefined ? { sourceLayer: target.sourceLayer } : {}),
      state: { ...(previous?.state ?? {}), ...state },
    };
    this.#state = {
      ...this.#state,
      featureStates: [
        ...this.#state.featureStates.filter((entry) => featureStateKey(entry) !== key).map(copyFeatureStateEntry),
        nextEntry,
      ],
    };
    this.#notify();
  }

  public removeFeatureState(target: HonuaFeatureStateTarget, key?: string): void {
    const targetKey = featureStateKey(target);
    this.#state = {
      ...this.#state,
      featureStates: this.#state.featureStates.flatMap((entry) => {
        if (featureStateKey(entry) !== targetKey) return [copyFeatureStateEntry(entry)];
        if (key === undefined) return [];
        const nextState = { ...entry.state };
        delete nextState[key];
        return Object.keys(nextState).length > 0
          ? [
              {
                sourceId: entry.sourceId,
                featureId: entry.featureId,
                ...(entry.sourceLayer !== undefined ? { sourceLayer: entry.sourceLayer } : {}),
                state: nextState,
              },
            ]
          : [];
      }),
    };
    this.#notify();
  }

  public async queryFeatures(
    sourceId = firstSourceId(this.#state.featuresBySource, this.#state.layers),
    options: HonuaQueryFeaturesOptions = {},
  ): Promise<HonuaFeatureTableModel<T>> {
    const resolvedSourceId = options.sourceId ?? sourceId;
    if (!resolvedSourceId) {
      return {
        sourceId: undefined,
        status: "ready",
        fields: [],
        rows: [],
        totalCount: 0,
      };
    }

    const inMemoryRows = this.#state.featuresBySource[resolvedSourceId] ?? [];
    if (inMemoryRows.length > 0 || !this.#runtime?.dataset) {
      return this.#queryInMemory(resolvedSourceId, options);
    }

    const source = this.#runtime.dataset.source(resolvedSourceId);
    if (!source) return this.#queryInMemory(resolvedSourceId, options);

    try {
      const request = queryOptionsToRuntimeQuery(this.#state.filters[resolvedSourceId], options);
      const result = await source.query(request);
      const rows = result.features.map((feature, index) => normalizeFeature(resolvedSourceId, feature, index));
      const fields = result.fields?.map((field) => field.name) ?? options.fields ?? inferFields(rows);
      this.#cacheRuntimeRows(resolvedSourceId, rows);
      return {
        sourceId: resolvedSourceId,
        status: "ready",
        fields,
        rows,
        totalCount: result.totalCount ?? rows.length,
        exceededTransferLimit: result.exceededTransferLimit,
      };
    } catch (error) {
      return {
        sourceId: resolvedSourceId,
        status: "error",
        fields: options.fields ?? this.#fieldsBySource.get(resolvedSourceId) ?? [],
        rows: [],
        totalCount: 0,
        error,
      };
    }
  }

  public async search(query: string, options: HonuaSearchOptions = {}): Promise<readonly HonuaSearchResult<T>[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const needle = trimmed.toLowerCase();
    const limit = Math.max(1, options.limit ?? 10);
    const sourceIds = options.sourceId
      ? [options.sourceId]
      : sourceIdsFromState(this.#state.featuresBySource, this.#state.layers);
    const fields = options.fields ?? this.#searchFields;
    const results: HonuaSearchResult<T>[] = [];

    for (const sourceId of sourceIds) {
      const rows = await this.#searchRows(sourceId, fields, options.signal);
      for (const row of rows) {
        if (!featureMatches(row, needle, fields)) continue;
        results.push({
          id: `${sourceId}:${String(row.id)}`,
          label: row.title ?? String(row.id),
          sourceId,
          featureId: row.id,
          feature: copyFeature(row),
          subtitle: sourceId,
          score: featureScore(row, needle, fields),
        });
        if (results.length >= limit) return results;
      }
    }

    return results;
  }

  public async applyEdit(): Promise<HonuaEditorModel> {
    const editor = this.#state.editor ?? normalizeEditor(undefined, firstSourceId(this.#state.featuresBySource, []));
    const next: HonuaEditorModel = editor.capabilities.readOnly
      ? {
          ...editor,
          status: "unsupported",
          message: editor.capabilities.reason ?? "Source is read-only.",
        }
      : {
          ...editor,
          status: "unsupported",
          message: "Editing is reserved for the HonuaController integration path.",
        };
    this.#state = { ...this.#state, editor: next };
    this.#notify();
    return next;
  }

  public updateFeatures(sourceId: string, features: readonly HonuaFeatureRecord<T>[]): void {
    this.#state = {
      ...this.#state,
      featuresBySource: {
        ...this.#state.featuresBySource,
        [sourceId]: features.map((feature, index) => normalizeFeature(sourceId, feature, index)),
      },
    };
    this.#notify();
  }

  public canMeasure(): boolean {
    return this.#measurementGeometry !== undefined;
  }

  public canSketch(): boolean {
    return this.#sketchGeometry !== undefined;
  }

  public async setMeasureMode(mode: HonuaMeasureMode): Promise<HonuaMeasureChangeDetail> {
    const provider = this.#measurementGeometry;
    if (!provider) {
      return {
        mode,
        status: "unsupported",
        message:
          "Measurement requires a geometry provider. Configure `measurementGeometry` on the controller to enable measuring.",
      };
    }
    try {
      if (mode === "off") provider.stop?.();
      const result = await provider.startMode(mode);
      return {
        mode,
        status: "ready",
        ...(result ? { result } : {}),
      };
    } catch (error) {
      return {
        mode,
        status: "error",
        message: error instanceof Error ? error.message : "Measurement provider failed.",
      };
    }
  }

  public async setSketchMode(mode: HonuaSketchMode): Promise<HonuaSketchChangeDetail<T>> {
    const provider = this.#sketchGeometry;
    if (!provider) {
      return {
        mode,
        status: "unsupported",
        message:
          "Sketching requires a geometry provider. Configure `sketchGeometry` on the controller to enable drawing.",
      };
    }
    try {
      if (mode === "off") provider.stop?.();
      const result = await provider.startMode(mode);
      return {
        mode,
        status: "ready",
        ...(result ? { result } : {}),
      };
    } catch (error) {
      return {
        mode,
        status: "error",
        message: error instanceof Error ? error.message : "Sketch provider failed.",
      };
    }
  }

  public destroy(): void {
    this.#measurementGeometry?.stop?.();
    this.#sketchGeometry?.stop?.();
    this.#runtimeHandle?.remove();
    this.#runtimeHandle = undefined;
    this.#listeners.clear();
  }

  #queryInMemory(sourceId: string, options: HonuaQueryFeaturesOptions): HonuaFeatureTableModel<T> {
    const filter = options.filter ?? this.#state.filters[sourceId];
    const allRows = this.#state.featuresBySource[sourceId] ?? [];
    const rows = filterRows(allRows, filter);
    const offset = Math.max(0, options.pagination?.offset ?? 0);
    const limit = options.pagination?.limit;
    const pagedRows = limit !== undefined ? rows.slice(offset, offset + Math.max(0, limit)) : rows.slice(offset);
    const fields = options.fields ?? this.#fieldsBySource.get(sourceId) ?? inferFields(rows);
    return {
      sourceId,
      status: "ready",
      fields,
      rows: pagedRows.map(copyFeature),
      totalCount: rows.length,
    };
  }

  async #searchRows(
    sourceId: string,
    fields: readonly string[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly HonuaFeatureRecord<T>[]> {
    const rows = this.#state.featuresBySource[sourceId] ?? [];
    if (rows.length > 0 || !this.#runtime?.dataset?.source(sourceId)) return rows;
    const table = await this.queryFeatures(sourceId, {
      fields,
      pagination: { limit: 1000 },
      ...(signal ? { signal } : {}),
    });
    return table.rows;
  }

  #cacheRuntimeRows(sourceId: string, rows: readonly HonuaFeatureRecord<T>[]): void {
    this.#state = {
      ...this.#state,
      featuresBySource: {
        ...this.#state.featuresBySource,
        [sourceId]: rows.map(copyFeature),
      },
    };
    this.#notify();
  }

  #notify(): void {
    this.#state = {
      ...this.#state,
      refreshedAt: new Date().toISOString(),
    };
    const snapshot = this.getState();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export function createHonuaWebComponentController<T = Record<string, unknown>>(
  options: CreateHonuaWebComponentControllerOptions<T> = {},
): HonuaWebComponentController<T> {
  return new HonuaInMemoryWebComponentController(options);
}

export function createHonuaWebComponentControllerFromRuntime<T = Record<string, unknown>>(
  runtime: HonuaWebComponentRuntimeLike<T>,
  options: Omit<CreateHonuaWebComponentControllerOptions<T>, "mapPackage" | "layers" | "legend" | "viewport"> = {},
): HonuaWebComponentController<T> {
  return new HonuaInMemoryWebComponentController({
    ...options,
    runtime,
    mapPackage: runtime.mapPackage,
    layers: layersFromMapPackage(runtime.composedStyle.layers),
    legend: runtime.getLegend().map((entry, index) => ({
      id: "id" in entry && typeof entry.id === "string" ? entry.id : legendId(entry.label, index),
      label: entry.label,
      ...(entry.color !== undefined ? { color: entry.color } : {}),
      ...(entry.iconUrl !== undefined ? { iconUrl: entry.iconUrl } : {}),
      ...(entry.minValue !== undefined ? { minValue: entry.minValue } : {}),
      ...(entry.maxValue !== undefined ? { maxValue: entry.maxValue } : {}),
    })),
    viewport: runtime.mapPackage.initialView,
  });
}

export function layersFromMapPackage(layers: readonly HonuaLayerSpecification[]): HonuaLayerModel[] {
  return layers.map((layer) => {
    const opacity = layerOpacity(layer);
    return {
      id: layer.id,
      title: layerTitle(layer),
      ...(layer.source ? { sourceId: layer.source } : {}),
      type: layer.type,
      visible: layer.layout?.visibility !== "none",
      ...(opacity !== undefined ? { opacity } : {}),
      ...(layer.metadata ? { metadata: layer.metadata } : {}),
    };
  });
}

export function legendFromMapPackage(
  entries:
    | readonly { label: string; color?: string; iconUrl?: string; minValue?: number; maxValue?: number }[]
    | undefined,
  layers: readonly HonuaLayerModel[],
  styleLayers: readonly HonuaLayerSpecification[],
): HonuaLegendItem[] {
  if (entries && entries.length > 0) {
    return entries.map((entry, index) => ({
      id: legendId(entry.label, index),
      label: entry.label,
      ...(entry.color !== undefined ? { color: entry.color } : {}),
      ...(entry.iconUrl !== undefined ? { iconUrl: entry.iconUrl } : {}),
      ...(entry.minValue !== undefined ? { minValue: entry.minValue } : {}),
      ...(entry.maxValue !== undefined ? { maxValue: entry.maxValue } : {}),
    }));
  }

  return styleLayers.map((layer, index) => ({
    id: legendId(layer.id, index),
    label: layers.find((candidate) => candidate.id === layer.id)?.title ?? layer.id,
    layerId: layer.id,
    ...(layerColor(layer) ? { color: layerColor(layer) } : {}),
  }));
}

function queryOptionsToRuntimeQuery<T>(
  filter: HonuaFilterState | undefined,
  options: HonuaQueryFeaturesOptions,
): Query<T> {
  const query: Query<T> = {
    ...(filter?.expression ? { where: filter.expression } : {}),
    ...(options.fields ? { outFields: options.fields } : {}),
    ...(options.pagination ? { pagination: options.pagination } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return query;
}

function normalizeFeaturesBySource<T>(
  featuresBySource: Readonly<Record<string, readonly HonuaFeatureRecord<T>[]>>,
): Record<string, HonuaFeatureRecord<T>[]> {
  const out: Record<string, HonuaFeatureRecord<T>[]> = {};
  for (const [sourceId, rows] of Object.entries(featuresBySource)) {
    out[sourceId] = rows.map((row, index) => normalizeFeature(sourceId, row, index));
  }
  return out;
}

function normalizeFeature<T>(
  sourceId: string,
  feature: HonuaFeatureRecord<T> | HonuaTypedFeature<T>,
  index: number,
): HonuaFeatureRecord<T> {
  const attributes = "attributes" in feature ? feature.attributes : ({} as T);
  const existingId = "id" in feature ? feature.id : undefined;
  const id = existingId ?? featureIdFromAttributes(attributes, sourceId, index);
  return {
    id,
    sourceId,
    attributes,
    ...("geometry" in feature && feature.geometry !== undefined ? { geometry: feature.geometry } : {}),
    title: "title" in feature && feature.title ? feature.title : featureTitle(attributes, id),
  };
}

function featureIdFromAttributes<T>(attributes: T, sourceId: string, index: number): FeatureId {
  const values = attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  for (const key of ["OBJECTID", "objectid", "objectId", "id", "globalid", "GlobalID", "GLOBALID"]) {
    const value = values[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return `${sourceId}:${index}`;
}

function featureTitle<T>(attributes: T, id: FeatureId): string {
  const values = attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  for (const key of ["name", "Name", "NAME", "title", "Title", "TITLE", "label", "Label", "LABEL"]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const firstString = Object.values(values).find((value) => typeof value === "string" && value.trim());
  return typeof firstString === "string" ? firstString : String(id);
}

function normalizeEditor(
  editor: Partial<HonuaEditorModel> | undefined,
  sourceId: string | undefined,
): HonuaEditorModel {
  return {
    sourceId: editor?.sourceId ?? sourceId,
    status: editor?.status ?? "idle",
    capabilities: {
      canCreate: editor?.capabilities?.canCreate ?? false,
      canUpdate: editor?.capabilities?.canUpdate ?? false,
      canDelete: editor?.capabilities?.canDelete ?? false,
      readOnly: editor?.capabilities?.readOnly ?? true,
      reason: editor?.capabilities?.reason ?? "Editing is not enabled for this source.",
    },
    ...(editor?.selectedFeatureId !== undefined ? { selectedFeatureId: editor.selectedFeatureId } : {}),
    ...(editor?.fields ? { fields: [...editor.fields] } : {}),
    ...(editor?.message ? { message: editor.message } : {}),
  };
}

function copyState<T>(state: HonuaWebComponentState<T>): HonuaWebComponentState<T> {
  const featuresBySource: Record<string, HonuaFeatureRecord<T>[]> = {};
  for (const [sourceId, rows] of Object.entries(state.featuresBySource)) {
    featuresBySource[sourceId] = rows.map(copyFeature);
  }
  return {
    ...state,
    layers: state.layers.map(copyLayerModel),
    legend: state.legend.map(copyLegendItem),
    viewport: { ...state.viewport },
    featuresBySource,
    featureStates: state.featureStates.map(copyFeatureStateEntry),
    filters: Object.fromEntries(Object.entries(state.filters).map(([sourceId, filter]) => [sourceId, { ...filter }])),
    ...(state.selection ? { selection: copySelection(state.selection) } : { selection: undefined }),
    ...(state.editor ? { editor: copyEditorModel(state.editor) } : {}),
    ...(state.chart ? { chart: copyChartModel(state.chart) } : {}),
  };
}

function copySelection<T>(selection: HonuaSelectionState<T>): HonuaSelectionState<T> {
  return {
    ...(selection.sourceId !== undefined ? { sourceId: selection.sourceId } : {}),
    ...(selection.sourceLayer !== undefined ? { sourceLayer: selection.sourceLayer } : {}),
    ...(selection.featureId !== undefined ? { featureId: selection.featureId } : {}),
    ...(selection.feature ? { feature: copyFeature(selection.feature) } : {}),
  };
}

function copyFeatureStateEntry(entry: HonuaFeatureStateEntry): HonuaFeatureStateEntry {
  return {
    sourceId: entry.sourceId,
    featureId: entry.featureId,
    ...(entry.sourceLayer !== undefined ? { sourceLayer: entry.sourceLayer } : {}),
    state: { ...entry.state },
  };
}

function featureStateKey(target: HonuaFeatureStateTarget): string {
  return `${target.sourceId}\u0000${target.sourceLayer ?? ""}\u0000${typeof target.featureId}:${String(
    target.featureId,
  )}`;
}

function copyLayerModel(layer: HonuaLayerModel): HonuaLayerModel {
  return {
    ...layer,
    ...(layer.metadata ? { metadata: { ...layer.metadata } } : {}),
  };
}

function copyLegendItem(item: HonuaLegendItem): HonuaLegendItem {
  return { ...item };
}

function copyFeature<T>(feature: HonuaFeatureRecord<T>): HonuaFeatureRecord<T> {
  return {
    ...feature,
    attributes:
      feature.attributes && typeof feature.attributes === "object"
        ? ({ ...(feature.attributes as Record<string, unknown>) } as T)
        : feature.attributes,
  };
}

function copyEditorModel(editor: HonuaEditorModel): HonuaEditorModel {
  return {
    ...editor,
    capabilities: { ...editor.capabilities },
    ...(editor.fields ? { fields: [...editor.fields] } : {}),
  };
}

function copyChartModel(chart: HonuaChartModel): HonuaChartModel {
  return {
    ...chart,
    ...(chart.data ? { data: chart.data.map((datum) => ({ ...datum })) } : {}),
  };
}

function firstSourceId<T>(
  featuresBySource: Readonly<Record<string, readonly HonuaFeatureRecord<T>[]>>,
  layers: readonly HonuaLayerModel[],
): string | undefined {
  const featureSource = Object.keys(featuresBySource)[0];
  if (featureSource) return featureSource;
  return layers.find((layer) => layer.sourceId)?.sourceId;
}

function sourceIdsFromState<T>(
  featuresBySource: Readonly<Record<string, readonly HonuaFeatureRecord<T>[]>>,
  layers: readonly HonuaLayerModel[],
): string[] {
  return [
    ...new Set([
      ...Object.keys(featuresBySource).filter((sourceId) => sourceId.trim().length > 0),
      ...layers.flatMap((layer) => (layer.sourceId ? [layer.sourceId] : [])),
    ]),
  ];
}

function filterRows<T>(
  rows: readonly HonuaFeatureRecord<T>[],
  filter: HonuaFilterState | undefined,
): HonuaFeatureRecord<T>[] {
  if (!filter?.text?.trim()) return rows.map(copyFeature);
  const needle = filter.text.trim().toLowerCase();
  return rows.filter((row) => featureMatches(row, needle)).map(copyFeature);
}

function featureMatches<T>(row: HonuaFeatureRecord<T>, needle: string, fields?: readonly string[]): boolean {
  if (String(row.id).toLowerCase().includes(needle)) return true;
  if (row.title?.toLowerCase().includes(needle)) return true;
  const attrs = row.attributes as Record<string, unknown>;
  const keys = fields && fields.length > 0 ? fields : Object.keys(attrs);
  return keys.some((key) =>
    String(attrs[key] ?? "")
      .toLowerCase()
      .includes(needle),
  );
}

function featureScore<T>(row: HonuaFeatureRecord<T>, needle: string, fields?: readonly string[]): number {
  if (row.title?.toLowerCase() === needle) return 1;
  if (row.title?.toLowerCase().startsWith(needle)) return 0.9;
  const attrs = row.attributes as Record<string, unknown>;
  const keys = fields && fields.length > 0 ? fields : Object.keys(attrs);
  return keys.some((key) =>
    String(attrs[key] ?? "")
      .toLowerCase()
      .startsWith(needle),
  )
    ? 0.8
    : 0.5;
}

function inferFields<T>(rows: readonly HonuaFeatureRecord<T>[]): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    const attrs = row.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) fields.add(key);
  }
  return [...fields];
}

function layerTitle(layer: HonuaLayerSpecification): string {
  const metadataTitle = layer.metadata?.title ?? layer.metadata?.name ?? layer.metadata?.label;
  return typeof metadataTitle === "string" && metadataTitle.trim() ? metadataTitle : layer.id;
}

function layerColor(layer: HonuaLayerSpecification): string | undefined {
  const value = layer.paint?.["fill-color"] ?? layer.paint?.["circle-color"] ?? layer.paint?.["line-color"];
  return typeof value === "string" ? value : undefined;
}

/** Reads a literal numeric opacity from the layer's paint block (expressions are ignored). */
function layerOpacity(layer: HonuaLayerSpecification): number | undefined {
  const value =
    layer.paint?.[`${layer.type}-opacity`] ??
    (layer.type === "symbol" ? (layer.paint?.["icon-opacity"] ?? layer.paint?.["text-opacity"]) : undefined);
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function legendId(label: string, index: number): string {
  const slug = trimChar(
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
    "-",
  );
  return slug ? `${slug}-${index}` : `legend-${index}`;
}
