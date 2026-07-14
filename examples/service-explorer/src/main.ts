import "maplibre-gl/dist/maplibre-gl.css";

import {
  bindHonuaAppWorkspaceSelector,
  selectHonuaAppWorkspaceDetailModel,
  selectHonuaAppWorkspaceJobModel,
  selectHonuaAppWorkspaceMetadataCacheModel,
} from "@honua/sdk-js/app-workspace";
import { isSourceQualifiedSelectionTarget, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import {
  bindDetailToSelection,
  bindMapExtentToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  syncFeatureStateSelection,
  syncMapLayerFilterToExploration,
} from "@honua/sdk-js/interactions";
import type { FeatureStateMap, InteractiveMap, LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import { uniqueValueRenderer } from "@honua/sdk-js/style";
import maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";

import { SampleCleanupRegistry } from "../../_kit/cleanup.js";
import { mountSamplePresentation } from "../../_kit/presentation.js";
import { resolveServiceExplorerConfig } from "./config.js";
import {
  beginServiceExplorerMetadataRevalidation,
  completeServiceExplorerMetadataRevalidation,
  createServiceExplorerWorkspace,
  recordServiceExplorerQueryProjection,
} from "./explorer-workspace.js";
import { createDebouncedMapExtentSource } from "./map-adapter.js";
import {
  applyServiceExplorerProjection,
  createServiceExplorerChartModel,
  createServiceExplorerFilterOptions,
  createServiceExplorerMapFilter,
  createServiceExplorerQueryDiagnostics,
  formatAttribute,
  formatExtent,
  formatTimestamp,
  serviceExplorerFeatureCollection,
} from "./projection.js";
import type {
  ServiceExplorerDataset,
  ServiceExplorerFeatureSummary,
  ServiceExplorerProjectionResult,
  ServiceExplorerProtocol,
} from "./types.js";
import { runServiceExplorerWorkflow } from "./workflow.js";

import "../../_kit/presentation.css";
import "./styles.css";

declare global {
  interface Window {
    __HONUA_SERVICE_EXPLORER_RUNTIME__?: {
      readonly ready: boolean;
      readonly sourceId: string;
      readonly protocol: string;
      readonly mode: string;
      readonly queryable: boolean;
      readonly visibleCount: number;
      readonly filterCount: number;
      readonly interactionCount: number;
      readonly disposed?: boolean;
    };
    __HONUA_SERVICE_EXPLORER_DISPOSE__?: () => Promise<void>;
  }
}

const MAP_LAYER_ID = "service-explorer-points";
const MAP_LABEL_LAYER_ID = "service-explorer-labels";

/** Incident priority styling as a first-class renderer object (issue #497). */
const priorityRenderer = uniqueValueRenderer({
  field: "priority",
  values: [
    { value: "high", color: "#b91c1c", label: "High priority" },
    { value: "medium", color: "#2563eb", label: "Medium priority" },
    { value: "low", color: "#0f766e", label: "Low priority" },
  ],
  defaultColor: "#334155",
  defaultLabel: "Unclassified",
});

const DEFAULT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#edf2f0",
      },
    },
  ],
};

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setOverlay(state: "loading" | "ready" | "error", title: string, detail: string): void {
  const overlay = getElement<HTMLElement>("#map-overlay");
  overlay.dataset.state = state;
  setText("#overlay-title", title);
  setText("#overlay-detail", detail);
}

// Group label for each protocol so the picker reads as a protocol catalog
// rather than a flat list once every SDK protocol has a lane.
const PROTOCOL_FAMILY_ORDER = [
  "Honua native",
  "Esri GeoServices",
  "OGC API & catalogs",
  "OGC web services",
  "OData",
  "MapLibre native",
] as const;

function protocolFamily(protocol: ServiceExplorerProtocol): (typeof PROTOCOL_FAMILY_ORDER)[number] {
  switch (protocol) {
    case "Honua gRPC":
      return "Honua native";
    case "FeatureServer":
    case "MapServer":
    case "ImageServer":
    case "Geometry Service":
    case "GP Service":
      return "Esri GeoServices";
    case "OGC Features":
    case "OGC Tiles":
    case "OGC Maps":
    case "OGC Records":
    case "STAC":
      return "OGC API & catalogs";
    case "WFS":
    case "WMS":
    case "WMTS":
      return "OGC web services";
    case "OData":
      return "OData";
    case "MapLibre Vector":
    case "MapLibre Raster":
    case "MapLibre GeoJSON":
      return "MapLibre native";
  }
}

function renderDiscovery(dataset: ServiceExplorerDataset): void {
  const sourcePicker = getElement<HTMLSelectElement>("#source-picker");
  sourcePicker.innerHTML = "";
  const byFamily = new Map<string, HTMLOptGroupElement>();
  for (const family of PROTOCOL_FAMILY_ORDER) {
    if (!dataset.catalog.sources.some((source) => protocolFamily(source.protocol) === family)) continue;
    const group = document.createElement("optgroup");
    group.label = family;
    byFamily.set(family, group);
    sourcePicker.append(group);
  }
  for (const source of dataset.catalog.sources) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = `${source.protocol} / ${source.name}`;
    option.dataset.mode = source.mode;
    option.selected = source.id === dataset.sourceOption.id;
    (byFamily.get(protocolFamily(source.protocol)) ?? sourcePicker).append(option);
  }

  const services = getElement<HTMLElement>("#service-list");
  services.innerHTML = dataset.catalog.services
    .map(
      (service) => `
        <li data-status="${escapeHtml(service.status ?? "available")}">
          <strong>${escapeHtml(service.name)}</strong>
          <span>${escapeHtml(service.type)}${service.layerCount === undefined ? "" : ` / ${service.layerCount} layer(s)`}</span>
        </li>
      `,
    )
    .join("");

  const layers = dataset.catalog.layersByServiceId[dataset.metadata.service.id] ?? [];
  getElement<HTMLElement>("#layer-list").innerHTML = layers
    .map(
      (layer) => `
        <li data-active="${layer.sourceId === dataset.sourceId ? "true" : "false"}">
          <strong>${escapeHtml(layer.name)}</strong>
          <span>${escapeHtml(layer.serviceType)} / ${escapeHtml(layer.geometryType ?? "metadata pending")}</span>
        </li>
      `,
    )
    .join("");

  setText("#active-service", dataset.metadata.service.name);
  setText("#active-layer", `${dataset.metadata.layer.name} (${dataset.metadata.layer.id})`);
  setText("#source-kind", `${dataset.sourceOption.protocol} / ${dataset.sourceOption.mode}`);
  setText("#source-description", dataset.sourceOption.description);
  setText("#source-cache-policy", dataset.sourceOption.cachePolicy);
  setText("#data-source", dataset.source === "cloud" ? "Cloud Honua" : "Fixture fallback");
  setText("#query-duration", `${dataset.queryDurationMs} ms`);
}

function renderMetadata(dataset: ServiceExplorerDataset): void {
  const schema = dataset.metadata.schema;
  setText("#schema-title", `${schema.fields?.length ?? 0} fields`);
  setText("#layer-extent", formatExtent(schema.extent));
  getElement<HTMLElement>("#schema-list").innerHTML = (schema.fields ?? [])
    .map(
      (field) => `
        <li>
          <strong>${escapeHtml(field.alias ?? field.name)}</strong>
          <span>${escapeHtml(field.name)} / ${escapeHtml(field.type)}</span>
        </li>
      `,
    )
    .join("");

  getElement<HTMLElement>("#capability-list").innerHTML = Object.entries(dataset.metadata.capabilities)
    .map(
      ([name, status]) => `
        <li data-status="${escapeHtml(status)}">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(status)}</span>
        </li>
      `,
    )
    .join("");
}

function renderFilterOptions(dataset: ServiceExplorerDataset): void {
  const select = getElement<HTMLSelectElement>("#attribute-filter");
  const queryable = isQueryableSource(dataset);
  select.disabled = !queryable;
  select.innerHTML = queryable
    ? '<option value="">All linked features</option>'
    : '<option value="">Table/query unavailable for this source</option>';
  if (!queryable) return;

  for (const option of createServiceExplorerFilterOptions(dataset.featureSummaries)) {
    const group = document.createElement("optgroup");
    group.label = option.field;
    for (const value of option.values) {
      const item = document.createElement("option");
      item.value = `${option.field}\u001f${value}`;
      item.textContent = `${option.field}: ${value}`;
      group.append(item);
    }
    select.append(group);
  }
}

function renderCacheAndDiagnostics(
  dataset: ServiceExplorerDataset,
  workspace: ReturnType<typeof createServiceExplorerWorkspace>,
): void {
  const cache = selectHonuaAppWorkspaceMetadataCacheModel(workspace.workspace.state);
  const entry = cache.entries[dataset.sourceId];
  const metadata = entry?.metadata ?? dataset.metadata;

  const displayStatus = entry?.status === "loading" ? "loading" : metadata.cache.state.status;
  setText("#cache-status", displayStatus);
  setText("#cache-updated", formatTimestamp(entry?.updatedAt ?? metadata.cache.updatedAt));
  setText("#cache-source", metadata.cache.source === "cloud" ? "Cloud Honua" : "Fixture");
  setText(
    "#cache-revalidate",
    `${Math.round((metadata.cache.state.ttlMs ?? metadata.cache.revalidateAfterMs) / 1000)} seconds`,
  );

  const jobs = selectHonuaAppWorkspaceJobModel(workspace.workspace.state);
  setText("#job-status", jobs.entries["linked-query-projection"]?.snapshot.status ?? "waiting");

  getElement<HTMLElement>("#diagnostic-list").innerHTML = metadata.diagnostics
    .map(
      (diagnostic) => `
        <li data-level="${escapeHtml(diagnostic.level)}">
          <strong>${escapeHtml(diagnostic.title)}</strong>
          <span>${escapeHtml(diagnostic.detail)}</span>
        </li>
      `,
    )
    .join("");
}

function renderTable(
  dataset: ServiceExplorerDataset,
  result: ServiceExplorerProjectionResult,
  selectedFeatureId: string | undefined,
): void {
  const body = getElement<HTMLElement>("#result-table-body");
  body.innerHTML = "";

  if (!isQueryableSource(dataset)) {
    body.innerHTML =
      '<tr><td colspan="5">Table/query controls are disabled for this render-only standards source.</td></tr>';
    return;
  }

  if (result.rows.length === 0) {
    body.innerHTML = '<tr><td colspan="5">No features match the linked map and filter state.</td></tr>';
    return;
  }

  for (const summary of result.rows) {
    const row = document.createElement("tr");
    row.dataset.selected = selectedFeatureId === summary.id ? "true" : "false";
    row.innerHTML = `
      <td>${escapeHtml(summary.id)}</td>
      <td>${escapeHtml(summary.title)}</td>
      <td>${escapeHtml(summary.attributes.status ?? "-")}</td>
      <td>${escapeHtml(summary.attributes.category ?? "-")}</td>
    `;
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-text-button";
    button.textContent = "Select";
    button.dataset.featureId = summary.id;
    action.append(button);
    row.append(action);
    body.append(row);
  }
}

function renderChart(
  dataset: ServiceExplorerDataset,
  result: ServiceExplorerProjectionResult,
  projection: LinkedViewQueryProjection,
): void {
  if (!isQueryableSource(dataset)) {
    setText("#chart-field", "render-only");
    getElement<HTMLElement>("#chart-buckets").innerHTML =
      '<p class="disabled-copy">Chart buckets require a queryable feature source.</p>';
    return;
  }

  const chart = createServiceExplorerChartModel(result, projection);
  setText("#chart-field", chart.field);
  const max = Math.max(1, ...chart.buckets.map((bucket) => bucket.count));
  getElement<HTMLElement>("#chart-buckets").innerHTML = chart.buckets
    .map(
      (bucket) => `
        <button type="button" class="chart-bucket" data-field="${escapeHtml(bucket.field)}" data-value="${escapeHtml(
          bucket.value,
        )}" data-selected="${bucket.selected ? "true" : "false"}">
          <span>${escapeHtml(bucket.value)}</span>
          <strong>${bucket.count}</strong>
          <i style="inline-size: ${(bucket.count / max) * 100}%"></i>
        </button>
      `,
    )
    .join("");
}

function renderDetail(workspace: ReturnType<typeof createServiceExplorerWorkspace>): void {
  const detail = selectHonuaAppWorkspaceDetailModel(workspace.workspace.state);
  const selected = detail.selectedRecords[0]?.feature;
  setText("#selection-count", String(detail.selection.length));

  if (!selected) {
    setText("#detail-title", "No selected feature");
    setText(
      "#detail-subtitle",
      detail.missingSelection.length > 0
        ? "Selection is not present in the active layer."
        : "Select a map point or table row.",
    );
    getElement<HTMLElement>("#detail-attributes").innerHTML = "";
    return;
  }

  setText("#detail-title", selected.title);
  setText("#detail-subtitle", selected.subtitle);
  getElement<HTMLElement>("#detail-attributes").innerHTML = Object.entries(selected.attributes)
    .slice(0, 10)
    .map(
      ([key, value]) => `
        <div class="attribute-row">
          <dt>${escapeHtml(key)}</dt>
          <dd>${escapeHtml(formatAttribute(value))}</dd>
        </div>
      `,
    )
    .join("");
}

function renderQuery(result: ServiceExplorerProjectionResult): void {
  const diagnostics = createServiceExplorerQueryDiagnostics(result.projection);
  setText("#visible-count", String(result.visibleCount));
  setText("#matched-count", String(result.totalMatched));
  setText("#filter-count", String(Object.keys(result.projection.filters).length));
  setText("#map-extent", formatExtent(result.projection.extent));
  getElement<HTMLElement>("#query-json").textContent = JSON.stringify(diagnostics, null, 2);
}

function isQueryableSource(dataset: ServiceExplorerDataset): boolean {
  return dataset.metadata.capabilities.query !== "unsupported" && dataset.metadata.capabilities.table !== "unsupported";
}

function selectedSourceIdFromLocation(configSourceId: string | undefined): string | undefined {
  const selected = new URLSearchParams(window.location.search).get("source")?.trim();
  return selected && selected.length > 0 ? selected : configSourceId;
}

function updateSourceLocation(sourceId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("source", sourceId);
  window.location.href = url.toString();
}

function selectedFeatureIdFromProjection(projection: LinkedViewQueryProjection, sourceId: string): string | undefined {
  const [target] = projection.selection;
  if (target === undefined) return undefined;
  if (isSourceQualifiedSelectionTarget(target)) {
    return target.sourceId === sourceId ? String(target.id) : undefined;
  }
  return String(target);
}

function parseFilterValue(value: string): { field: string; value: string } | undefined {
  if (!value) return undefined;
  const [field, filterValue] = value.split("\u001f", 2);
  if (!field || filterValue === undefined) return undefined;
  return { field, value: filterValue };
}

function featureBounds(summaries: readonly ServiceExplorerFeatureSummary[]): maplibregl.LngLatBoundsLike {
  const bounds = new maplibregl.LngLatBounds();
  for (const summary of summaries) {
    if (summary.coordinate) bounds.extend([...summary.coordinate] as [number, number]);
  }
  return bounds.isEmpty()
    ? [
        [-157.86, 21.3],
        [-157.86, 21.3],
      ]
    : bounds;
}

async function createMap(
  dataset: ServiceExplorerDataset,
  cleanupRegistry: SampleCleanupRegistry,
  signal: AbortSignal,
): Promise<maplibregl.Map> {
  const firstCoordinate = dataset.featureSummaries.find((summary) => summary.coordinate)?.coordinate ?? [
    -157.8583, 21.3069,
  ];
  const map = new maplibregl.Map({
    container: "map",
    style: DEFAULT_STYLE,
    center: [...firstCoordinate] as [number, number],
    zoom: 11,
  });
  try {
    cleanupRegistry.resource(map);
  } catch (error) {
    map.remove();
    throw error;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      removeInitialListeners();
      resolve(map);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      removeInitialListeners();
      reject(error);
    };
    const onLoad = () => {
      try {
        map.addSource(dataset.sourceId, {
          type: "geojson",
          data: serviceExplorerFeatureCollection(dataset.featureSummaries) as never,
        });
        // First-class renderer object (issue #497): the priority categories
        // compile to the same MapLibre match expression the demo used to
        // hand-write, and the legend derives from renderer.legendItems().
        const [priorityFragment] = priorityRenderer.toMapLibre("point");
        map.addLayer({
          id: MAP_LAYER_ID,
          source: dataset.sourceId,
          type: "circle",
          filter: ["==", "$type", "Point"],
          paint: {
            ...priorityFragment.paint,
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 7],
            "circle-stroke-color": ["case", ["boolean", ["feature-state", "selected"], false], "#111827", "#ffffff"],
            "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 4, 2],
            "circle-opacity": ["case", ["==", ["get", "status"], "resolved"], 0.45, 0.9],
          },
        });
        map.addLayer({
          id: MAP_LABEL_LAYER_ID,
          source: dataset.sourceId,
          type: "symbol",
          filter: ["==", "$type", "Point"],
          layout: {
            "text-field": ["get", "OBJECTID"],
            "text-size": 11,
            "text-offset": [0, 1.35],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#1f2937",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.1,
          },
        });
        map.fitBounds(featureBounds(dataset.featureSummaries), { padding: 72, duration: 0, maxZoom: 12 });
        succeed();
      } catch (error) {
        fail(error);
      }
    };
    const onError = (event: { error?: { message?: string } }) => {
      fail(new Error(event.error?.message ?? "Map failed to load"));
    };
    const onAbort = () => fail(signal.reason);
    const removeInitialListeners = () => {
      map.off("load", onLoad);
      map.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    map.on("load", onLoad);
    map.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanupRegistry.add(removeInitialListeners);
    if (signal.aborted) onAbort();
  });
}

async function bootstrap(): Promise<void> {
  const cleanup = new SampleCleanupRegistry();
  const bootstrapController = new AbortController();
  cleanup.add(() => bootstrapController.abort());
  let presentation: ReturnType<typeof mountSamplePresentation>;
  const teardown = async () => {
    bootstrapController.abort();
    await cleanup.dispose();
    window.__HONUA_SERVICE_EXPLORER_RUNTIME__ = {
      ...window.__HONUA_SERVICE_EXPLORER_RUNTIME__,
      ready: false,
      disposed: true,
    } as NonNullable<Window["__HONUA_SERVICE_EXPLORER_RUNTIME__"]>;
  };
  const dispose = async () => {
    await teardown();
    presentation.root.remove();
  };
  presentation = mountSamplePresentation({
    sampleId: "service-explorer",
    evidence: {
      mode: "resolved at startup",
      target: "configured service or deterministic fixture",
      authentication: "catalog policy",
    },
    onDispose: dispose,
  });
  window.__HONUA_SERVICE_EXPLORER_DISPOSE__ = dispose;
  cleanup.add(() => {
    delete window.__HONUA_SERVICE_EXPLORER_DISPOSE__;
  });
  cleanup.listen(window, "beforeunload", () => void dispose(), { once: true });
  setOverlay("loading", "Loading service explorer", "Resolving cloud Honua configuration and local fixture fallback.");

  try {
    const resolvedConfig = resolveServiceExplorerConfig(import.meta.env as Record<string, string | undefined>);
    const config = {
      ...resolvedConfig,
      selectedSourceId: selectedSourceIdFromLocation(resolvedConfig.selectedSourceId),
    };
    const dataset = await runServiceExplorerWorkflow(config, { signal: bootstrapController.signal });
    bootstrapController.signal.throwIfAborted();
    let endpointHost = "relative fixture origin";
    try {
      endpointHost = new URL(config.honuaBaseUrl).host;
    } catch {
      // Keep the safe relative-origin label; never surface raw configured URLs.
    }
    presentation.updateEvidence({
      mode: dataset.source === "cloud" ? "cloud service" : "fixture fallback",
      endpoint: endpointHost,
      attribution: "Source catalog attribution retained",
      cache: dataset.metadata.cache.state.status,
    });
    presentation.showDegradation(dataset.diagnostics.filter((item) => item.level !== "info").map((item) => item.title));
    const workspace = createServiceExplorerWorkspace(dataset);
    cleanup.resource(workspace);
    renderDiscovery(dataset);
    renderMetadata(dataset);
    renderFilterOptions(dataset);
    renderCacheAndDiagnostics(dataset, workspace);

    setOverlay("loading", "Loading map", "Binding map, table, chart, filter, detail, cache, and diagnostics views.");
    const map = await createMap(dataset, cleanup, bootstrapController.signal);
    bootstrapController.signal.throwIfAborted();
    const sourcePicker = getElement<HTMLSelectElement>("#source-picker");
    const filterSelect = getElement<HTMLSelectElement>("#attribute-filter");
    const clearFilterButton = getElement<HTMLButtonElement>("#clear-filter-button");
    const revalidateButton = getElement<HTMLButtonElement>("#revalidate-cache-button");
    const markStaleButton = getElement<HTMLButtonElement>("#mark-stale-button");
    const resultTableBody = getElement<HTMLElement>("#result-table-body");
    const chartBuckets = getElement<HTMLElement>("#chart-buckets");
    let selectedFeatureId: string | undefined;
    let latestResult: ServiceExplorerProjectionResult | undefined;
    let interactionCount = 0;
    const featureSummariesById = new Map(dataset.featureSummaries.map((summary) => [summary.id, summary]));

    const removableHandles = [
      syncFeatureStateSelection(map as unknown as FeatureStateMap, workspace.views.map, {
        source: dataset.sourceId,
      }),
      bindMapSelectionToExploration(map as unknown as InteractiveMap, workspace.views.map, {
        source: dataset.sourceId,
        layer: MAP_LAYER_ID,
      }),
      syncMapLayerFilterToExploration(
        {
          setFilter(layerId, filter) {
            map.setFilter(layerId, filter as never);
          },
        },
        workspace.views.map,
        {
          layerId: MAP_LAYER_ID,
          sourceId: dataset.sourceId,
          translate(projection) {
            return createServiceExplorerMapFilter(projection, { sourceId: dataset.sourceId });
          },
        },
      ),
      bindMapExtentToExploration(
        workspace.views.map,
        createDebouncedMapExtentSource(map, { debounceMs: config.mapMoveDebounceMs }),
        {
          publishSpatialFilter: true,
        },
      ),
    ];
    clearFilterButton.disabled = !isQueryableSource(dataset);
    const unsubscribeHandles = [
      bindDetailToSelection(workspace.views.detail, () => renderDetail(workspace)),
      bindQueryProjectionToExploration(
        workspace.views.table,
        (projection) => {
          selectedFeatureId = selectedFeatureIdFromProjection(projection, dataset.sourceId);
          const result = applyServiceExplorerProjection(dataset.featureSummaries, projection, {
            sourceId: dataset.sourceId,
          });
          latestResult = result;
          recordServiceExplorerQueryProjection(workspace.workspace, result);
          renderTable(dataset, result, selectedFeatureId);
          renderQuery(result);
          renderCacheAndDiagnostics(dataset, workspace);
        },
        { sourceId: dataset.sourceId },
      ),
      workspace.controllers.chart.subscribeQuery(
        (projection) => {
          const result =
            latestResult?.projection === projection
              ? latestResult
              : applyServiceExplorerProjection(dataset.featureSummaries, projection, { sourceId: dataset.sourceId });
          renderChart(dataset, result, projection);
        },
        { sourceId: dataset.sourceId },
      ),
      bindHonuaAppWorkspaceSelector(
        workspace.workspace,
        (state) => selectHonuaAppWorkspaceMetadataCacheModel(state),
        () => renderCacheAndDiagnostics(dataset, workspace),
      ),
    ];
    for (const unsubscribe of unsubscribeHandles) cleanup.add(unsubscribe);
    for (const handle of removableHandles) cleanup.resource(handle);

    const onMapMouseEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onMapMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("mouseenter", MAP_LAYER_ID, onMapMouseEnter);
    map.on("mouseleave", MAP_LAYER_ID, onMapMouseLeave);
    cleanup.add(() => {
      map.off("mouseenter", MAP_LAYER_ID, onMapMouseEnter);
      map.off("mouseleave", MAP_LAYER_ID, onMapMouseLeave);
    });
    cleanup.listen(resultTableBody, "click", (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>("button[data-feature-id]");
      if (!button || !resultTableBody.contains(button)) return;
      const summary = button.dataset.featureId ? featureSummariesById.get(button.dataset.featureId) : undefined;
      if (!summary) return;
      interactionCount += 1;
      workspace.controllers.table.select([sourceFeatureSelectionTarget(dataset.sourceId, summary.id)], {
        replace: true,
      });
    });
    cleanup.listen(chartBuckets, "click", (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>("button.chart-bucket");
      if (!button || !chartBuckets.contains(button)) return;
      const field = button.dataset.field;
      const value = button.dataset.value;
      if (!field || !value) return;
      interactionCount += 1;
      workspace.controllers.chart.selectBucket({
        filters: {
          [`chart-${field}`]: { field, operator: "=", value, appliesTo: [dataset.sourceId] },
        },
      });
    });
    cleanup.listen(filterSelect, "change", () => {
      const selected = parseFilterValue(filterSelect.value);
      if (!selected) {
        workspace.controllers.filters.clearFilter("attribute");
        return;
      }
      workspace.controllers.filters.setFilter("attribute", {
        field: selected.field,
        operator: "=",
        value: selected.value,
        appliesTo: [dataset.sourceId],
      });
    });
    cleanup.listen(sourcePicker, "change", () => {
      updateSourceLocation(sourcePicker.value);
    });
    cleanup.listen(clearFilterButton, "click", () => {
      filterSelect.value = "";
      workspace.controllers.filters.clearFilter("attribute");
    });
    cleanup.listen(revalidateButton, "click", () => {
      beginServiceExplorerMetadataRevalidation(workspace.workspace, dataset);
      cleanup.timeout(() => {
        completeServiceExplorerMetadataRevalidation(workspace.workspace, dataset, { status: "ready" });
      }, 350);
    });
    cleanup.listen(markStaleButton, "click", () => {
      completeServiceExplorerMetadataRevalidation(workspace.workspace, dataset, { status: "stale" });
    });

    const source = map.getSource(dataset.sourceId) as GeoJSONSource | undefined;
    source?.setData(serviceExplorerFeatureCollection(dataset.featureSummaries) as never);

    setOverlay(
      "ready",
      "Explorer ready",
      isQueryableSource(dataset)
        ? "Linked service discovery, metadata, map, table, chart, detail, and diagnostics are synchronized."
        : "Render-only source selected; metadata, cache, map, and diagnostics stay visible while table/query controls are disabled.",
    );

    window.__HONUA_SERVICE_EXPLORER_RUNTIME__ = {
      ready: true,
      sourceId: dataset.sourceOption.id,
      protocol: dataset.sourceOption.protocol,
      mode: dataset.sourceOption.mode,
      queryable: isQueryableSource(dataset),
      get visibleCount() {
        return latestResult?.visibleCount ?? 0;
      },
      get filterCount() {
        return latestResult ? Object.keys(latestResult.projection.filters).length : 0;
      },
      get interactionCount() {
        return interactionCount;
      },
    };
    const onRuntimeError = (event: { error?: { message?: string } }) => {
      const error = new Error(event.error?.message ?? "Map runtime error");
      setOverlay("error", "Service explorer map error", error.message);
      presentation.showError(error);
      void teardown().catch((cleanupError) => presentation.showError(cleanupError));
    };
    map.on("error", onRuntimeError);
    cleanup.add(() => {
      map.off("error", onRuntimeError);
    });
  } catch (error) {
    if (bootstrapController.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    setOverlay("error", "Unable to start the service explorer", message);
    setText("#diagnostic-list", message);
    presentation.showError(error);
    await teardown().catch((cleanupError) => presentation.showError(cleanupError));
  }
}

void bootstrap();
