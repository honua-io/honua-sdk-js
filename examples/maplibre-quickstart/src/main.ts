import "maplibre-gl/dist/maplibre-gl.css";

import maplibregl, { type LngLatLike } from "maplibre-gl";

import { resolveQuickstartConfig } from "./config.js";
import { type QuickstartDataset, type QuickstartFeatureSummary, loadQuickstartDataset } from "./data.js";
import { toMapLibreBounds } from "./esri-geojson.js";
import { createQuickstartTelemetry } from "./telemetry.js";

import "./styles.css";

interface MapHandle {
  map: maplibregl.Map;
  layerIds: string[];
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
              "fill-color": "#2f7d6a",
              "fill-opacity": 0.44,
            },
          });
          map.addLayer({
            id: config.layerIds.outline,
            source: config.sourceId,
            type: "line",
            filter: ["==", "$type", "Polygon"],
            paint: {
              "line-color": "#16433b",
              "line-width": 2,
            },
          });
          layerIds.push(config.layerIds.fill, config.layerIds.outline);
        }

        if (dataset.geometryTypes.includes("line")) {
          map.addLayer({
            id: config.layerIds.line,
            source: config.sourceId,
            type: "line",
            filter: ["==", "$type", "LineString"],
            paint: {
              "line-color": "#b55127",
              "line-width": 3,
            },
          });
          layerIds.push(config.layerIds.line);
        }

        if (dataset.geometryTypes.includes("point")) {
          map.addLayer({
            id: config.layerIds.circle,
            source: config.sourceId,
            type: "circle",
            filter: ["==", "$type", "Point"],
            paint: {
              "circle-radius": 7,
              "circle-color": "#b55127",
              "circle-stroke-width": 2,
              "circle-stroke-color": "#fff7ed",
            },
          });
          layerIds.push(config.layerIds.circle);
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
        resolve({ map, layerIds });
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
  const featureList = getElement<HTMLElement>("#feature-list");

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
    const firstFeature = dataset.featureSummaries[0];
    if (firstFeature) {
      renderSelection(firstFeature);
    }

    overlayTitle.textContent = "Loading the map";
    overlayBody.textContent = "Adding a GeoJSON source, creating render layers, and fitting to the queried features.";

    const { map, layerIds } = await createMap(config, dataset);
    const featureById = new Map(dataset.featureSummaries.map((summary) => [summary.id, summary]));

    const selectFeature = (featureId: string, popupLngLat?: LngLatLike) => {
      const summary = featureById.get(featureId);
      if (!summary) {
        return;
      }

      renderSelection(summary);
      document.querySelectorAll<HTMLButtonElement>(".feature-inspect-button").forEach((button) => {
        const selected = button.dataset.featureId === featureId;
        button.dataset.selected = selected ? "true" : "false";
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      });

      if (summary.center) {
        activePopup?.remove();
        activePopup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          maxWidth: "320px",
        })
          .setLngLat(popupLngLat ?? summary.center)
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
    };

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
      map.on("click", layerId, (event) => {
        const clickedFeatureId = event.features?.[0]?.id;
        if (typeof clickedFeatureId === "string" || typeof clickedFeatureId === "number") {
          selectFeature(String(clickedFeatureId), event.lngLat);
        }
      });
    }

    featureList.innerHTML = "";
    for (const summary of dataset.featureSummaries) {
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
      button.dataset.testid = `inspect-feature-${summary.id}`;
      button.textContent = `Inspect ${summary.title}`;
      button.addEventListener("click", () => selectFeature(summary.id));
      item.append(button);
      featureList.append(item);
    }

    if (firstFeature) {
      selectFeature(firstFeature.id);
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
    overlayBody.textContent = "Use the inspect buttons or click a rendered feature to open the popup and inspect data.";

    window.addEventListener("beforeunload", () => {
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
