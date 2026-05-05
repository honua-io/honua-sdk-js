import "maplibre-gl/dist/maplibre-gl.css";

import maplibregl from "maplibre-gl";

import {
  createExplorationContext,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "@honua/sdk-js/exploration";
import type { FeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";
import {
  bindDetailToSelection,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  bindTableSelectionToExploration,
  syncFeatureStateSelection,
  syncMapLayerFilterToExploration,
} from "@honua/sdk-js/interactions";
import type { FeatureStateMap, InteractiveMap, LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

import { resolveQuickstartConfig } from "./config.js";
import { type QuickstartDataset, type QuickstartFeatureSummary, loadQuickstartDataset } from "./data.js";
import { type QuickstartRenderableGeometryType, toMapLibreBounds } from "./esri-geojson.js";
import {
  applyQuickstartProjection,
  createMapLibreLayerFilter,
  createQuickstartFilterOptions,
  formatProjectionExtent,
} from "./linked-exploration.js";
import { createQuickstartTelemetry } from "./telemetry.js";

import "./styles.css";

interface MapHandle {
  map: maplibregl.Map;
  layerIds: string[];
  layerFilterBindings: LayerFilterBinding[];
}

interface LayerFilterBinding {
  layerId: string;
  geometryType: QuickstartRenderableGeometryType;
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
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

function formatTarget(baseUrl: string): string {
  return baseUrl.length > 0 ? baseUrl : "same-origin fixture lane";
}

function renderStatus(config: ReturnType<typeof resolveQuickstartConfig>, dataset: QuickstartDataset): void {
  setText(
    "#status-compatibility",
    `Compatible (${dataset.compatibility.serverVersion}, ${dataset.compatibility.releaseChannel})`,
  );
  setText("#status-target", formatTarget(config.honuaBaseUrl));
  setText("#status-service-layer", `${config.serviceId} / ${config.layerId}`);
  setText("#status-feature-count", `${dataset.renderableFeatureCount} renderable of ${dataset.featureCount}`);
  setText("#status-geometry-types", dataset.geometryTypes.join(", "));
  setText("#status-error", "None");
  setText(
    "#demo-status",
    `Loaded ${dataset.renderableFeatureCount} renderable feature(s) from ${config.serviceId}/${config.layerId} in ${dataset.queryDurationMs} ms.`,
  );
}

function renderSelection(summary: QuickstartFeatureSummary): void {
  setText("#selected-feature-title", summary.title);
  setText("#selected-feature-subtitle", summary.subtitle);
  setText("#selected-feature-id", summary.id);
  setText("#selected-feature-geometry", summary.geometryKind ?? "unknown");

  const attributes = Object.entries(summary.feature.properties)
    .slice(0, 8)
    .map(
      ([key, value]) =>
        `<div class="attribute-row"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? "null")}</dd></div>`,
    )
    .join("");

  getElement<HTMLElement>("#selected-feature-attributes").innerHTML =
    attributes.length > 0 ? attributes : '<div class="empty-copy">No attributes available.</div>';
}

function renderEmptySelection(): void {
  setText("#selected-feature-title", "No linked selection");
  setText("#selected-feature-subtitle", "Select a feature from the map or results list.");
  setText("#selected-feature-id", "-");
  setText("#selected-feature-geometry", "-");
  getElement<HTMLElement>("#selected-feature-attributes").innerHTML =
    '<div class="empty-copy">Attributes will appear after a linked selection.</div>';
}

function renderLinkedProjection(projection: LinkedViewQueryProjection, visibleFeatureCount: number): void {
  const filterIds = Object.keys(projection.filters);
  setText("#linked-visible-count", String(visibleFeatureCount));
  setText("#linked-filter-state", filterIds.length > 0 ? filterIds.join(", ") : "None");
  setText("#linked-extent", formatProjectionExtent(projection.extent));
  getElement<HTMLElement>("#linked-query-projection").textContent = JSON.stringify(
    {
      filters: projection.filters,
      extent: projection.extent,
      spatialFilter: projection.spatialFilter,
      orderBy: projection.orderBy,
      pagination: projection.pagination,
    },
    null,
    2,
  );
}

function renderFilterOptions(select: HTMLSelectElement, dataset: QuickstartDataset): void {
  const options = createQuickstartFilterOptions(dataset.featureSummaries);
  select.innerHTML = '<option value="">All rendered features</option>';

  for (const option of options) {
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

  select.disabled = options.length === 0;
}

function renderFeatureList(
  summaries: readonly QuickstartFeatureSummary[],
  selectedFeatureId: string | undefined,
  onInspect: (summary: QuickstartFeatureSummary) => void,
): void {
  const featureList = getElement<HTMLElement>("#feature-list");
  featureList.innerHTML = "";

  if (summaries.length === 0) {
    featureList.innerHTML = '<div class="empty-copy">No features match the linked context.</div>';
    return;
  }

  for (const summary of summaries) {
    const item = document.createElement("article");
    item.className = "feature-list-item";
    item.innerHTML = `
      <div>
        <p class="feature-list-kicker">${escapeHtml(summary.geometryKind ?? "feature")}</p>
        <h3>${escapeHtml(summary.title)}</h3>
        <p>${escapeHtml(summary.subtitle)}</p>
      </div>
    `;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "feature-inspect-button";
    button.dataset.featureId = summary.id;
    button.dataset.selected = summary.id === selectedFeatureId ? "true" : "false";
    button.dataset.testid = `inspect-feature-${summary.id}`;
    button.setAttribute("aria-pressed", summary.id === selectedFeatureId ? "true" : "false");
    button.textContent = `Inspect ${summary.title}`;
    button.addEventListener("click", () => onInspect(summary));
    item.append(button);
    featureList.append(item);
  }
}

function mapBoundsToHonuaExtent(bounds: maplibregl.LngLatBounds): HonuaExtent {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  return {
    xmin: Math.min(west, east),
    ymin: Math.min(south, north),
    xmax: Math.max(west, east),
    ymax: Math.max(south, north),
    spatialReference: { wkid: 4326 },
  };
}

function createMapExtentSource(map: maplibregl.Map) {
  return {
    current(): HonuaExtent | undefined {
      return mapBoundsToHonuaExtent(map.getBounds());
    },
    subscribe(listener: (extent: HonuaExtent | undefined) => void) {
      const emit = () => listener(mapBoundsToHonuaExtent(map.getBounds()));
      map.on("moveend", emit);
      return {
        remove() {
          map.off("moveend", emit);
        },
      };
    },
  };
}

function readSelectedFeatureId(selection: ReadonlyArray<FeatureSelectionTarget>, sourceId: string): string | undefined {
  const [target] = selection;
  if (target === undefined) return undefined;
  if (isSourceQualifiedSelectionTarget(target)) {
    return target.sourceId === sourceId ? String(target.id) : undefined;
  }
  return String(target);
}

function setFeatureListSelection(featureId: string | undefined): void {
  document.querySelectorAll<HTMLButtonElement>(".feature-inspect-button").forEach((button) => {
    const selected = button.dataset.featureId === featureId;
    button.dataset.selected = selected ? "true" : "false";
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function parseFilterValue(value: string): { field: string; value: string } | undefined {
  if (!value) return undefined;
  const [field, filterValue] = value.split("\u001f", 2);
  if (!field || filterValue === undefined) return undefined;
  return { field, value: filterValue };
}

function createPopupHtml(summary: QuickstartFeatureSummary): string {
  const attributeRows = Object.entries(summary.feature.properties)
    .slice(0, 5)
    .map(
      ([key, value]) =>
        `<div class="popup-row"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value ?? "null")}</strong></div>`,
    )
    .join("");

  return `
    <article class="popup-card">
      <p class="popup-kicker">${escapeHtml(summary.geometryKind ?? "feature")}</p>
      <h3>${escapeHtml(summary.title)}</h3>
      <p>${escapeHtml(summary.subtitle)}</p>
      <div class="popup-grid">${attributeRows}</div>
    </article>
  `;
}

async function createMap(
  config: ReturnType<typeof resolveQuickstartConfig>,
  dataset: QuickstartDataset,
): Promise<MapHandle> {
  const map = new maplibregl.Map({
    container: "map",
    style: config.basemapStyle,
    center: dataset.featureSummaries[0]?.center ?? [-157.8583, 21.3069],
    zoom: 11,
  });

  return await new Promise((resolve, reject) => {
    const onLoad = () => {
      try {
        const layerIds: string[] = [];
        const layerFilterBindings: LayerFilterBinding[] = [];

        map.addSource(config.sourceId, {
          type: "geojson",
          data: dataset.geojson as never,
        });

        if (dataset.geometryTypes.includes("polygon")) {
          map.addLayer({
            id: config.layerIds.fill,
            source: config.sourceId,
            type: "fill",
            filter: ["==", "$type", "Polygon"],
            paint: {
              "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#c2410c", "#0f766e"],
              "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.68, 0.42],
            },
          });
          map.addLayer({
            id: config.layerIds.outline,
            source: config.sourceId,
            type: "line",
            filter: ["==", "$type", "Polygon"],
            paint: {
              "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#7c2d12", "#134e4a"],
              "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 2],
            },
          });
          layerIds.push(config.layerIds.fill, config.layerIds.outline);
          layerFilterBindings.push(
            { layerId: config.layerIds.fill, geometryType: "polygon" },
            { layerId: config.layerIds.outline, geometryType: "polygon" },
          );
        }

        if (dataset.geometryTypes.includes("line")) {
          map.addLayer({
            id: config.layerIds.line,
            source: config.sourceId,
            type: "line",
            filter: ["==", "$type", "LineString"],
            paint: {
              "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#c2410c", "#2563eb"],
              "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 5, 3],
            },
          });
          layerIds.push(config.layerIds.line);
          layerFilterBindings.push({ layerId: config.layerIds.line, geometryType: "line" });
        }

        if (dataset.geometryTypes.includes("point")) {
          map.addLayer({
            id: config.layerIds.circle,
            source: config.sourceId,
            type: "circle",
            filter: ["==", "$type", "Point"],
            paint: {
              "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 9, 7],
              "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "#c2410c", "#2563eb"],
              "circle-stroke-width": 2,
              "circle-stroke-color": "#ffffff",
            },
          });
          layerIds.push(config.layerIds.circle);
          layerFilterBindings.push({ layerId: config.layerIds.circle, geometryType: "point" });
        }

        if (dataset.bounds) {
          const isPointLike =
            dataset.bounds.minX === dataset.bounds.maxX && dataset.bounds.minY === dataset.bounds.maxY;
          if (isPointLike) {
            map.jumpTo({
              center: [dataset.bounds.minX, dataset.bounds.minY],
              zoom: 12,
            });
          } else {
            map.fitBounds(toMapLibreBounds(dataset.bounds), {
              padding: 48,
              duration: 0,
              maxZoom: 12,
            });
          }
        }

        cleanup();
        resolve({ map, layerIds, layerFilterBindings });
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (event: { error?: { message?: string } }) => {
      cleanup();
      map.remove();
      reject(
        new Error(
          `Failed to load the basemap style "${config.basemapStyle}": ${event.error?.message ?? "Unknown error"}`,
        ),
      );
    };

    const cleanup = () => {
      map.off("load", onLoad);
      map.off("error", onError);
    };

    map.on("load", onLoad);
    map.on("error", onError);
  });
}

async function bootstrap(): Promise<void> {
  const telemetry = createQuickstartTelemetry(window);
  const config = resolveQuickstartConfig(import.meta.env as Record<string, string | undefined>);
  const overlay = getElement<HTMLElement>("#map-overlay");
  const overlayTitle = getElement<HTMLElement>(".map-overlay-title");
  const overlayBody = getElement<HTMLElement>(".map-overlay-body");
  const filterSelect = getElement<HTMLSelectElement>("#attribute-filter");
  const clearFilterButton = getElement<HTMLButtonElement>("#clear-filter-button");

  telemetry.patchRuntime({
    baseUrl: config.honuaBaseUrl || "same-origin",
    serviceId: config.serviceId,
    layerId: config.layerId,
  });
  telemetry.emit("init", {
    mode: import.meta.env.MODE,
    baseUrl: config.honuaBaseUrl || "same-origin",
    serviceId: config.serviceId,
    layerId: config.layerId,
  });

  let activePopup: maplibregl.Popup | null = null;

  try {
    overlayTitle.textContent = "Checking Honua compatibility";
    overlayBody.textContent =
      "Running the SDK compatibility gate, querying one layer, and loading the result into MapLibre.";

    const dataset = await loadQuickstartDataset(config, { telemetry });
    renderStatus(config, dataset);
    renderFilterOptions(filterSelect, dataset);
    const firstFeature = dataset.featureSummaries[0];
    if (firstFeature) {
      renderSelection(firstFeature);
    }

    overlayTitle.textContent = "Loading the map";
    overlayBody.textContent = "Adding a GeoJSON source, creating render layers, and fitting to the queried features.";

    const { map, layerIds, layerFilterBindings } = await createMap(config, dataset);
    const featureById = new Map(dataset.featureSummaries.map((summary) => [summary.id, summary]));
    const context = createExplorationContext({
      datasetId: `${config.serviceId}/${config.layerId}`,
      sourceIds: [config.sourceId],
      preset: "globalLinked",
    });
    const mapView = context.connectView({ id: "quickstart-map", role: "map" });
    const tableView = context.connectView({ id: "quickstart-results", role: "grid" });
    const detailView = context.connectView({ id: "quickstart-detail", role: "form" });
    const filterView = context.connectView({ id: "quickstart-filter", role: "filter" });
    const filterControls = bindFilterControlsToExploration(filterView);
    const tableSelection = bindTableSelectionToExploration(tableView);
    const removableHandles: Array<{ remove(): void }> = [
      syncFeatureStateSelection(map as unknown as FeatureStateMap, mapView, { source: config.sourceId }),
    ];
    const unsubscribeHandles: Array<() => void> = [];
    let selectedFeatureId: string | undefined;
    let latestProjection: LinkedViewQueryProjection | undefined;

    function renderProjectedResults(projection: LinkedViewQueryProjection): void {
      latestProjection = projection;
      const projectedSummaries = applyQuickstartProjection(dataset.featureSummaries, projection);
      renderLinkedProjection(projection, projectedSummaries.length);
      renderFeatureList(projectedSummaries, selectedFeatureId, (summary) => {
        tableSelection.select([sourceFeatureSelectionTarget(config.sourceId, summary.id)], { replace: true });
      });
      telemetry.patchRuntime({
        linkedVisibleFeatureCount: projectedSummaries.length,
        linkedFilterCount: Object.keys(projection.filters).length,
        linkedExtent: projection.extent ? formatProjectionExtent(projection.extent) : null,
      });
      telemetry.emit("linked-query-updated", {
        visibleFeatureCount: projectedSummaries.length,
        filterCount: Object.keys(projection.filters).length,
        hasExtent: Boolean(projection.extent),
      });
    }

    function renderSelectedFeature(featureId: string | undefined): void {
      selectedFeatureId = featureId;
      setText("#linked-selection-count", featureId ? "1" : "0");
      setFeatureListSelection(featureId);

      if (!featureId) {
        activePopup?.remove();
        activePopup = null;
        renderEmptySelection();
        telemetry.patchRuntime({
          selectedFeatureId: null,
          popupOpen: false,
        });
        return;
      }

      const summary = featureById.get(featureId);
      if (!summary) return;

      renderSelection(summary);
      if (summary.center) {
        activePopup?.remove();
        activePopup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          maxWidth: "320px",
        })
          .setLngLat(summary.center)
          .setHTML(createPopupHtml(summary))
          .addTo(map);

        telemetry.patchRuntime({
          popupOpen: true,
        });
        activePopup.on("close", () => {
          telemetry.patchRuntime({
            popupOpen: false,
          });
        });
      }

      telemetry.patchRuntime({
        selectedFeatureId: featureId,
      });
      telemetry.emit("feature-selected", {
        featureId,
        geometryType: summary.geometryKind ?? "unknown",
      });
    }

    const interactiveLayerIds = [config.layerIds.fill, config.layerIds.line, config.layerIds.circle].filter((id) =>
      layerIds.includes(id),
    );

    for (const layerId of interactiveLayerIds) {
      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });
      removableHandles.push(
        bindMapSelectionToExploration(map as unknown as InteractiveMap, mapView, {
          source: config.sourceId,
          layer: layerId,
        }),
      );
    }

    for (const binding of layerFilterBindings) {
      removableHandles.push(
        syncMapLayerFilterToExploration(
          {
            setFilter(layerId, filter) {
              map.setFilter(layerId, filter as never);
            },
          },
          mapView,
          {
            layerId: binding.layerId,
            translate(projection) {
              return createMapLibreLayerFilter(binding.geometryType, projection);
            },
          },
        ),
      );
    }

    removableHandles.push(
      bindMapExtentToExploration(mapView, createMapExtentSource(map), {
        publishSpatialFilter: true,
      }),
    );
    unsubscribeHandles.push(
      bindDetailToSelection(detailView, (selection) => {
        renderSelectedFeature(readSelectedFeatureId(selection, config.sourceId));
      }),
      bindQueryProjectionToExploration(tableView, renderProjectedResults, {
        sourceId: config.sourceId,
      }),
    );

    filterSelect.addEventListener("change", () => {
      const selected = parseFilterValue(filterSelect.value);
      if (!selected) {
        filterControls.clearFilter("attribute");
        telemetry.emit("linked-filter-changed", { active: false });
        return;
      }
      filterControls.setFilter("attribute", {
        field: selected.field,
        operator: "=",
        value: selected.value,
        appliesTo: [config.sourceId],
      });
      telemetry.emit("linked-filter-changed", {
        active: true,
        field: selected.field,
        value: selected.value,
      });
    });
    clearFilterButton.addEventListener("click", () => {
      filterSelect.value = "";
      filterControls.clearFilter("attribute");
      telemetry.emit("linked-filter-changed", { active: false });
    });

    if (latestProjection) {
      renderProjectedResults(latestProjection);
    }
    if (firstFeature) {
      tableSelection.select([sourceFeatureSelectionTarget(config.sourceId, firstFeature.id)], { replace: true });
    }

    telemetry.patchRuntime({
      layerIds,
      mapReady: true,
    });
    telemetry.emit("map-ready", {
      layerIds,
      geometryTypes: dataset.geometryTypes,
    });

    overlay.dataset.state = "ready";
    overlayTitle.textContent = "Map ready";
    overlayBody.textContent = "Linked map, filter, result, and detail context is ready.";

    window.addEventListener("beforeunload", () => {
      for (const unsubscribe of unsubscribeHandles) unsubscribe();
      for (const handle of removableHandles) handle.remove();
      context.dispose();
      activePopup?.remove();
      map.remove();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    overlay.dataset.state = "error";
    overlayTitle.textContent = "Unable to start the quickstart app";
    overlayBody.textContent = message;
    setText("#status-error", message);
    setText("#demo-status", message);
    telemetry.patchRuntime({
      lastError: message,
      popupOpen: false,
    });
    telemetry.emit("error", { message });
  }
}

void bootstrap();
