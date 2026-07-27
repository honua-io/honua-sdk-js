import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import { createHonuaController } from "@honua/sdk-js/app-controller";
import type { HonuaControllerRuntimeLike } from "@honua/sdk-js/app-controller";
import { createWidgetSource } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";
import {
  parseInteractionQueryState,
  selectLinkedViewQueryProjection,
  serializeInteractionQueryState,
} from "@honua/sdk-js/interactions";
import {
  fetchMapPackage,
  loadMapPackage,
  throwRuntimeDiagnostics,
  validateRuntimeLayer,
  validateRuntimeSource,
} from "@honua/sdk-js/runtime";
import type { HonuaMapPackage, HonuaMapRuntime, MapPackageFetchCache } from "@honua/sdk-js/runtime";
import { createHonuaWebComponentControllerFromRuntime } from "@honua/sdk-js/web-components";
import type {
  HonuaChartElement,
  HonuaFeatureRecord,
  HonuaMapElement,
  HonuaWebComponentRuntimeLike,
} from "@honua/sdk-js/web-components";
import * as maplibregl from "maplibre-gl";

import {
  INCIDENT_SOURCE_ID,
  createFixtureWidgetSource,
  filterRecordsByProjection,
  recordsFromFeatureCollection,
  statusChartModel,
} from "./model.js";
import type {
  IncidentAttributes,
  IncidentFeatureRecord,
  IncidentStatus,
  RuntimeParityFixturePayload,
} from "./model.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_RUNTIME_PARITY_SHOWCASE__?: {
      ready: boolean;
      packageLoaded: boolean;
      mapReady: boolean;
      surfaceReady: boolean;
      widgetRefreshCount: number;
      selectedFeatureId?: string | number;
      layerVisible(layerId: string): boolean;
      renderedFeatureCount(layerId: string): number;
      renderedFeatureIds(layerId: string): Array<string | number>;
      featureState(featureId: string | number): Record<string, unknown>;
      widgetCount(): number;
      shareState(): string;
    };
  }
}

const PACKAGE_ID = "runtime-parity-showcase";
const FEATURE_FIXTURE_PATH = "/__runtime-parity-showcase__/features.json";
const INCIDENT_LAYER_IDS = ["incident-halo", "incident-points"] as const;
const DEFAULT_VIEW: { readonly center: [number, number]; readonly zoom: number } = {
  center: [-157.865, 21.302],
  zoom: 11.4,
};
const DOWNTOWN_BOUNDS = [-157.884, 21.288, -157.838, 21.321] as const;
const EAST_BOUNDS = [-157.852, 21.264, -157.806, 21.299] as const;

let runtime: HonuaMapRuntime | undefined;
let appController: ReturnType<typeof createHonuaController> | undefined;
let webController: ReturnType<typeof createHonuaWebComponentControllerFromRuntime<IncidentAttributes>> | undefined;
let widgetRefreshCount = 0;
let latestWidgetCount = 0;
let selectedFeatureId: string | number | undefined;
let latestShareState = "";
let selectedTarget: { sourceId: string; id: string | number; sourceLayer?: string } | undefined;
let allRecords: IncidentFeatureRecord[] = [];

const smokeRuntime = {
  ready: false,
  packageLoaded: false,
  mapReady: false,
  surfaceReady: false,
  get widgetRefreshCount() {
    return widgetRefreshCount;
  },
  get selectedFeatureId() {
    return selectedFeatureId;
  },
  layerVisible(layerId: string): boolean {
    return layerVisible(layerId);
  },
  renderedFeatureCount(layerId: string): number {
    return renderedFeatures(layerId).length;
  },
  renderedFeatureIds(layerId: string): Array<string | number> {
    return renderedFeatures(layerId)
      .map((feature) => feature.id ?? feature.properties?.id)
      .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
  },
  featureState(featureId: string | number): Record<string, unknown> {
    if (!runtime) return {};
    try {
      return runtime.getFeatureStateForTarget({ source: INCIDENT_SOURCE_ID, id: featureId });
    } catch {
      return {};
    }
  },
  widgetCount(): number {
    return latestWidgetCount;
  },
  shareState(): string {
    return latestShareState;
  },
};

window.__HONUA_RUNTIME_PARITY_SHOWCASE__ = smokeRuntime;

void boot().catch((error) => {
  setText("#package-status", "Failed");
  setText("#event-log", describeError(error));
  throw error;
});

async function boot(): Promise<void> {
  setText("#package-status", "Loading");
  const [fixture, fetched] = await Promise.all([loadFixturePayload(), loadHostedPackage()]);
  allRecords = recordsFromFeatureCollection(fixture.features, fixture.sourceId);
  const styleDiagnosticCount = validatePackageStyle(fetched.mapPackage);
  setText("#style-diagnostics", String(styleDiagnosticCount));
  setText("#package-cache", fetched.cache.status);
  setText("#package-status", "Loaded");
  smokeRuntime.packageLoaded = true;

  const map = createMap();
  runtime = await loadMapPackage(fetched.mapPackage, map, {
    client: createFixtureClient(),
    skipCompatibilityCheck: true,
    onEvent(event) {
      writeEvent(`runtime:${event.type}`);
    },
  });
  smokeRuntime.mapReady = true;
  setText("#map-status", "Ready");

  const widgetSource = createWidgetSource(createFixtureWidgetSource(allRecords, fixture.sourceId), {
    ttlMs: 30_000,
    cache: {
      metadataCacheable: true,
      resultCacheable: true,
      ttlMs: 30_000,
      keyParts: [PACKAGE_ID, fixture.generatedAt],
    },
  });
  const safeRuntime = createSafeRuntime(runtime, { [fixture.sourceId]: widgetSource });
  appController = createHonuaController({
    runtime: safeRuntime,
    sourceIds: [fixture.sourceId],
    datasetId: fetched.mapPackage.mapPackageId,
    layerGroups: {
      incidents: [...INCIDENT_LAYER_IDS],
      zones: ["zone-fill", "zone-outline"],
    },
  });
  const filterView = appController.context.connectView({ id: "runtime-filter", role: "filter" });

  const componentController = createHonuaWebComponentControllerFromRuntime<IncidentAttributes>(safeRuntime, {
    fieldsBySource: { [fixture.sourceId]: fixture.fields },
    chart: statusChartModel(allRecords),
    searchFields: ["name", "status", "priority", "district", "team"],
    editor: {
      sourceId: fixture.sourceId,
      status: "idle",
      capabilities: {
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        readOnly: true,
        reason: "Fixture data is read-only so CI smoke stays deterministic.",
      },
    },
  });
  webController = componentController;
  bindWebComponents(componentController);
  smokeRuntime.surfaceReady = true;

  applyInitialShareState(appController);
  wireControls(filterView, widgetSource);
  wireControllerEvents(widgetSource);
  wireMapSelection(runtime, appController);
  refreshLinkedViews();
  await refreshWidgets(widgetSource, "initial");
  updateShareState();
  smokeRuntime.ready = true;
}

function createSafeRuntime(
  runtimeHandle: HonuaMapRuntime,
  querySources: Readonly<Record<string, ReturnType<typeof createWidgetSource<IncidentAttributes>>>> = {},
): HonuaControllerRuntimeLike & HonuaWebComponentRuntimeLike<IncidentAttributes> {
  return {
    map: runtimeHandle.map,
    mapPackage: runtimeHandle.mapPackage,
    composedStyle: runtimeHandle.composedStyle,
    dataset: {
      source: (id) => querySources[id]?.source ?? runtimeHandle.dataset.source(id),
    },
    getLegend: () => runtimeHandle.getLegend(),
    on: (listener) => runtimeHandle.on(listener),
    setLayerVisibility(layerId, visible) {
      try {
        runtimeHandle.setLayerVisibility(layerId, visible);
      } catch (error) {
        writeEvent(`layer-renderer:${layerId}:${describeError(error)}`);
      }
    },
    setViewState(view) {
      try {
        runtimeHandle.setViewState(view);
      } catch (error) {
        writeEvent(`viewport-renderer:${describeError(error)}`);
      }
    },
    dispose: () => runtimeHandle.dispose(),
  };
}

async function loadHostedPackage(): Promise<{
  mapPackage: HonuaMapPackage;
  cache: ReturnType<typeof normalizeCacheState>;
}> {
  const client = createFixtureClient();
  const cache: MapPackageFetchCache = new Map();
  const fetched = await fetchMapPackage(PACKAGE_ID, {
    client,
    cache,
    maxAgeMs: 1000 * 60 * 60 * 24 * 45,
    requireStyleRefResolution: true,
  });
  return {
    mapPackage: fetched.mapPackage,
    cache: normalizeCacheState(fetched.cache),
  };
}

function createFixtureClient(): HonuaClient {
  return new HonuaClient({ baseUrl: "", fetchFn: window.fetch.bind(window) });
}

function normalizeCacheState(cache: Awaited<ReturnType<typeof fetchMapPackage>>["cache"]): {
  readonly status: string;
} {
  return { status: cache.status };
}

async function loadFixturePayload(): Promise<RuntimeParityFixturePayload> {
  const response = await fetch(FEATURE_FIXTURE_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load runtime parity fixture data: HTTP ${response.status}`);
  }
  return (await response.json()) as RuntimeParityFixturePayload;
}

function createMap(): maplibregl.Map {
  return new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [] },
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    attributionControl: false,
  });
}

function validatePackageStyle(mapPackage: HonuaMapPackage): number {
  const diagnostics = [
    ...Object.entries(mapPackage.mapSpec.sources).flatMap(([sourceId, source]) =>
      validateRuntimeSource(sourceId, source, {
        mapPackage,
        style: mapPackage.mapSpec,
        operation: "runtime-parity-showcase",
      }),
    ),
    ...mapPackage.mapSpec.layers.flatMap((layer) =>
      validateRuntimeLayer(layer, {
        mapPackage,
        style: mapPackage.mapSpec,
        operation: "runtime-parity-showcase",
      }),
    ),
  ];
  throwRuntimeDiagnostics(diagnostics, "Runtime parity showcase style failed validation.");
  return diagnostics.length;
}

function bindWebComponents(
  controller: ReturnType<typeof createHonuaWebComponentControllerFromRuntime<IncidentAttributes>>,
): void {
  getElement<HonuaMapElement<IncidentAttributes>>("#component-surface").controller = controller;
}

function wireControls(
  filterView: ReturnType<ReturnType<typeof createHonuaController>["context"]["connectView"]>,
  widgetSource: ReturnType<typeof createWidgetSource<IncidentAttributes>>,
): void {
  getElement<HTMLSelectElement>("#status-filter").addEventListener("change", (event) => {
    const status = (event.currentTarget as HTMLSelectElement).value as IncidentStatus | "";
    if (status) {
      filterView.setFilter("status", {
        field: "status",
        operator: "=",
        value: status,
        appliesTo: [INCIDENT_SOURCE_ID],
      });
    } else {
      filterView.clearFilter("status");
    }
    refreshLinkedViews();
    void refreshWidgets(widgetSource, "filter");
    updateShareState();
  });

  getElement<HTMLButtonElement>("#refresh-widgets").addEventListener("click", () => {
    void refreshWidgets(widgetSource, "manual");
  });
  getElement<HTMLButtonElement>("#fit-downtown").addEventListener("click", () => {
    appController?.fitBounds(DOWNTOWN_BOUNDS, { padding: 32 });
  });
  getElement<HTMLButtonElement>("#fit-east").addEventListener("click", () => {
    appController?.fitBounds(EAST_BOUNDS, { padding: 32 });
  });
  getElement<HTMLButtonElement>("#reset-view").addEventListener("click", () => {
    appController?.setViewport(DEFAULT_VIEW);
  });

  document.addEventListener("honua-selection-change", (event) => {
    const detail = (event as CustomEvent<{ sourceId?: string; featureId?: string | number }>).detail;
    if (!detail.sourceId || detail.featureId === undefined) return;
    selectedFeatureId = detail.featureId;
    appController?.selectFeature(detail.sourceId, detail.featureId);
    updateSelectedFeature(detail.featureId);
    updateShareState();
    writeEvent(`select:${String(detail.featureId)}`);
  });

  document.addEventListener("honua-layer-visibility-change", (event) => {
    const detail = (event as CustomEvent<{ layerId: string; visible: boolean }>).detail;
    appController?.setLayerVisibility(detail.layerId, detail.visible);
    setText("#visible-layer-state", `${detail.layerId}:${String(detail.visible)}`);
    updateShareState();
    writeEvent(`layer:${detail.layerId}:${String(detail.visible)}`);
  });
}

function wireControllerEvents(widgetSource: ReturnType<typeof createWidgetSource<IncidentAttributes>>): void {
  appController?.onViewportMoveEnd(() => {
    refreshLinkedViews();
    void refreshWidgets(widgetSource, "viewport");
    updateShareState();
    const viewport = appController?.getViewport();
    setText(
      "#viewport-state",
      viewport?.center ? `${formatNumber(viewport.center[0])}, ${formatNumber(viewport.center[1])}` : "Extent",
    );
  });

  appController?.onSelectionChange((event) => {
    const [target] = event.selection;
    const id = typeof target === "object" ? target.id : target;
    selectedFeatureId = id;
    if (id !== undefined) updateSelectedFeature(id);
    updateFeatureState(id);
    updateShareState();
  });

  appController?.onVisibilityChange((event) => {
    const changed = [...event.hide, ...event.show][0];
    if (changed?.kind === "layer") setText("#visible-layer-state", `${changed.id}:${String(layerVisible(changed.id))}`);
    updateShareState();
  });
}

function wireMapSelection(runtimeHandle: HonuaMapRuntime, controller: ReturnType<typeof createHonuaController>): void {
  runtimeHandle.bindClick(
    "incident-points",
    (event) => {
      if (event.selectionTarget) {
        controller.selectFeatures([event.selectionTarget], { replace: true });
        return;
      }
      if (event.featureId !== undefined) controller.selectFeature(INCIDENT_SOURCE_ID, event.featureId);
    },
    { featureIdProperty: "id" },
  );
}

function refreshLinkedViews(): void {
  const projection = currentProjection();
  const visibleRecords = filterRecordsByProjection(allRecords, projection);
  webController?.updateFeatures?.(INCIDENT_SOURCE_ID, visibleRecords);
  const chart = getElement<HonuaChartElement<IncidentAttributes>>("#status-chart");
  chart.chartModel = statusChartModel(visibleRecords);
  setText("#visible-feature-count", String(visibleRecords.length));
  applyRuntimeFilter(projection.filters.status?.value);
  renderFeatureCards(visibleRecords);
}

async function refreshWidgets(
  widgetSource: ReturnType<typeof createWidgetSource<IncidentAttributes>>,
  reason: string,
): Promise<void> {
  const refreshId = ++widgetRefreshCount;
  setText("#widget-refresh-count", String(widgetRefreshCount));
  setText("#widget-state", "Refreshing");
  const projection = currentProjection();
  const [count, categories, range] = await Promise.all([
    widgetSource.count({ projection }),
    widgetSource.categories({ field: "status", projection, orderBy: "value-asc" }),
    widgetSource.range({ field: "responseMinutes", projection }),
  ]);
  if (refreshId !== widgetRefreshCount) return;
  latestWidgetCount = count.value;
  setText("#widget-count", String(count.value));
  setText("#widget-cache", count.cache.resultCacheable ? count.cache.cacheKey : "no-cache");
  setText("#widget-mode", count.execution);
  setText("#widget-latency", `${range.min ?? "-"}-${range.max ?? "-"} min`);
  renderWidgetBuckets(categories.buckets);
  setText("#widget-state", `Ready (${reason})`);
  writeEvent(`widget:${reason}:${count.value}`);
  updateShareState();
}

function currentProjection(): ReturnType<typeof selectLinkedViewQueryProjection> {
  if (!appController) {
    return {
      filters: {},
      orderBy: [],
      pagination: {},
      grouping: [],
      selection: [],
    };
  }
  return selectLinkedViewQueryProjection(appController.context.state, { sourceId: INCIDENT_SOURCE_ID });
}

function applyRuntimeFilter(value: unknown): void {
  if (!runtime) return;
  const filter = typeof value === "string" && value ? ["==", ["get", "status"], value] : undefined;
  for (const layerId of INCIDENT_LAYER_IDS) {
    if (filter) {
      throwRuntimeDiagnostics(runtime.validateFilterExpression(filter, layerId), "Runtime filter validation failed.");
    }
    try {
      runtime.setLayerFilter(layerId, filter);
    } catch (error) {
      writeEvent(`filter-renderer:${layerId}:${describeError(error)}`);
    }
  }
}

function renderFeatureCards(records: readonly IncidentFeatureRecord[]): void {
  const target = getElement<HTMLElement>("#feature-cards");
  target.innerHTML = records
    .map(
      (record) => `
        <button type="button" class="feature-card" data-feature-id="${escapeHtml(String(record.id))}">
          <span>${escapeHtml(record.attributes.status)}</span>
          <strong>${escapeHtml(record.attributes.name)}</strong>
          <small>${escapeHtml(record.attributes.district)} - ${escapeHtml(record.attributes.team)}</small>
        </button>
      `,
    )
    .join("");
  for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("button[data-feature-id]"))) {
    button.addEventListener("click", () => {
      if (!button.dataset.featureId) return;
      selectedFeatureId = button.dataset.featureId;
      appController?.selectFeature(INCIDENT_SOURCE_ID, button.dataset.featureId);
      updateSelectedFeature(button.dataset.featureId);
      webController?.selectFeature({
        sourceId: INCIDENT_SOURCE_ID,
        featureId: button.dataset.featureId,
        feature: allRecords.find((record) => String(record.id) === button.dataset.featureId),
      });
      writeEvent(`select:${button.dataset.featureId}`);
    });
  }
}

function renderWidgetBuckets(
  buckets: readonly { readonly label: string; readonly count: number; readonly percent: number }[],
): void {
  getElement<HTMLElement>("#widget-buckets").innerHTML = buckets
    .map(
      (bucket) => `
        <div class="bucket-row">
          <span>${escapeHtml(bucket.label)}</span>
          <meter min="0" max="1" value="${bucket.percent}"></meter>
          <strong>${bucket.count}</strong>
        </div>
      `,
    )
    .join("");
}

function updateSelectedFeature(featureId: string | number): void {
  const record = allRecords.find((candidate) => String(candidate.id) === String(featureId));
  if (!record) return;
  setText("#selected-title", record.attributes.name);
  setText(
    "#selected-meta",
    `${record.attributes.priority} - ${record.attributes.district} - ${record.attributes.team}`,
  );
}

function updateFeatureState(featureId: string | number | undefined): void {
  if (!runtime) return;
  if (selectedTarget) {
    try {
      runtime.removeFeatureStateForTarget(selectedTarget, "selected");
    } catch (error) {
      writeEvent(`feature-state-renderer:${describeError(error)}`);
    }
    selectedTarget = undefined;
  }
  if (featureId === undefined) return;
  selectedTarget = runtime.layerSelectionTarget("incident-points", featureId);
  try {
    runtime.setFeatureStateForTarget(selectedTarget, { selected: true });
  } catch (error) {
    writeEvent(`feature-state-renderer:${describeError(error)}`);
  }
}

function applyInitialShareState(controller: ReturnType<typeof createHonuaController>): void {
  const params = new URLSearchParams(window.location.search);
  const parsed = parseInteractionQueryState(params);
  for (const [id, clause] of Object.entries(parsed.filters ?? {})) {
    controller.context.dispatch({ kind: "set-filter", id, clause });
    if (id === "status" && typeof clause.value === "string") {
      getElement<HTMLSelectElement>("#status-filter").value = clause.value;
    }
  }
  if (parsed.extent) {
    controller.context.dispatch({ kind: "set-extent", extent: parsed.extent });
  }
  if (parsed.selection && parsed.selection.length > 0) {
    controller.selectFeatures(parsed.selection, { replace: true });
  }
  const viewport = parseJsonParam<{ center?: [number, number]; zoom?: number }>(params, "viewport");
  if (viewport) controller.setViewport(viewport);
  const hiddenLayers = parseJsonParam<string[]>(params, "hiddenLayers") ?? [];
  for (const layerId of hiddenLayers) {
    controller.setLayerVisibility(layerId, false);
    webController?.setLayerVisibility(layerId, false);
  }
}

function updateShareState(): void {
  if (!appController) return;
  const projection = currentProjection();
  const params = new URLSearchParams(
    serializeInteractionQueryState({
      filters: projection.filters,
      extent: projection.extent,
      selection: appController.getSelection({ sourceId: INCIDENT_SOURCE_ID }),
    }),
  );
  const hiddenLayers = Object.entries(appController.getVisibility().layers)
    .filter(([, visible]) => !visible)
    .map(([layerId]) => layerId);
  if (hiddenLayers.length > 0) params.set("hiddenLayers", JSON.stringify(hiddenLayers));
  const viewport = appController.getViewport();
  if (viewport.center || viewport.zoom !== undefined) {
    params.set(
      "viewport",
      JSON.stringify({
        ...(viewport.center ? { center: viewport.center } : {}),
        ...(viewport.zoom !== undefined ? { zoom: Number(viewport.zoom.toFixed(2)) } : {}),
      }),
    );
  }
  latestShareState = `${window.location.pathname}${params.size > 0 ? `?${params.toString()}` : ""}`;
  window.history.replaceState(null, "", latestShareState);
  getElement<HTMLInputElement>("#share-state").value = latestShareState;
}

function layerVisible(layerId: string): boolean {
  const controllerVisible = appController?.getVisibility().layers[layerId];
  if (controllerVisible !== undefined) return controllerVisible;
  return runtime?.composedStyle.layers.find((layer) => layer.id === layerId)?.layout?.visibility !== "none";
}

function renderedFeatures(layerId: string): Array<{ id?: string | number; properties?: Record<string, unknown> }> {
  try {
    return (
      (runtime?.map.queryRenderedFeatures?.(undefined, { layers: [layerId] }) as
        | Array<{ id?: string | number; properties?: Record<string, unknown> }>
        | undefined) ?? []
    );
  } catch {
    return [];
  }
}

function parseJsonParam<T>(params: URLSearchParams, key: string): T | undefined {
  const value = params.get(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function writeEvent(value: string): void {
  setText("#event-log", value);
}

function formatNumber(value: number): string {
  return value.toFixed(4);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = (error as { readonly stage?: unknown; readonly detail?: unknown; readonly cause?: unknown }).detail;
  const cause = (error as { readonly cause?: unknown }).cause;
  return [
    error.message,
    detail ? `detail=${JSON.stringify(detail)}` : undefined,
    cause instanceof Error ? `cause=${cause.message}` : cause ? `cause=${String(cause)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}
