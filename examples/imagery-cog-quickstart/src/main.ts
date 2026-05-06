import "maplibre-gl/dist/maplibre-gl.css";

import { HonuaClient } from "@honua/sdk-js/honua";
import maplibregl from "maplibre-gl";

import { clientOptionsFromImageryConfig, rasterRequestHeaders, resolveImageryCogConfig } from "./config.js";
import {
  activeImageryLayerCount,
  createDefaultImageryDataset,
  createImageryRenderPlan,
  hydrateImageryRenderPlan,
  setImageryLayerOpacity,
  setImageryLayerVisibility,
  summarizeImageryCache,
  summarizeImageryCapabilities,
} from "./model.js";
import type { ImageryLayerState, ImageryRenderPlan } from "./types.js";

import "./styles.css";

interface ImageryCogRuntime {
  readonly ready: boolean;
  readonly activeLayerCount: number;
  readonly layerIds: readonly string[];
  readonly tileTemplates: readonly string[];
  toggleLayer(layerId: string, visible: boolean): void;
  setOpacity(layerId: string, opacity: number): void;
}

declare global {
  interface Window {
    __HONUA_IMAGERY_COG_DEMO__?: ImageryCogRuntime;
  }
}

const config = resolveImageryCogConfig(import.meta.env);
const client = new HonuaClient(clientOptionsFromImageryConfig(config));
const authHeaders = rasterRequestHeaders(config);
const dataset = createDefaultImageryDataset();
let renderPlan = createImageryRenderPlan(dataset, client);
let selectedLayerId = renderPlan.layers[0]?.layer.id ?? "";

const map = new maplibregl.Map({
  container: "map",
  center: [...dataset.center],
  zoom: dataset.zoom,
  attributionControl: false,
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#dce8ef" },
      },
    ],
  },
  transformRequest(url) {
    if (authHeaders && url.startsWith(client.serverBaseUrl)) {
      return { url, headers: authHeaders };
    }
    return { url };
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

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

function render(): void {
  renderStatus();
  renderLayers();
  renderSelectedLayer();
  renderAudit();
}

function renderStatus(): void {
  setText("#mode-state", config.mode === "live" ? "Live Honua" : "Fixture safe mode");
  setText("#capability-state", summarizeImageryCapabilities(renderPlan));
  setText("#cache-state", summarizeImageryCache(renderPlan.dataset));
  setText("#active-layer-count", `${activeImageryLayerCount(renderPlan)} active`);
  setText("#endpoint-state", `${client.serverBaseUrl} / ${renderPlan.layers.length} render path(s)`);
}

function renderLayers(): void {
  const list = getElement<HTMLElement>("#layer-list");
  list.innerHTML = renderPlan.layers
    .map(
      (state) => `
        <article class="layer-row" data-visible="${state.visible}" data-selected="${state.layer.id === selectedLayerId}">
          <button type="button" class="layer-select" data-select-layer="${escapeHtml(state.layer.id)}">
            <strong>${escapeHtml(state.layer.title)}</strong>
            <span>${escapeHtml(state.layer.accessPath)} / ${escapeHtml(state.layer.bandPreset)}</span>
          </button>
          <label class="toggle-row">
            <input type="checkbox" data-toggle-layer="${escapeHtml(state.layer.id)}" ${state.visible ? "checked" : ""} />
            <span>Visible</span>
          </label>
          <label class="opacity-row">
            <span>Opacity</span>
            <input
              type="range"
              min="0"
              max="100"
              value="${Math.round(state.opacity * 100)}"
              data-opacity-layer="${escapeHtml(state.layer.id)}"
              aria-label="${escapeHtml(state.layer.title)} opacity"
            />
          </label>
        </article>
      `,
    )
    .join("");

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-select-layer]")) {
    button.addEventListener("click", () => {
      selectedLayerId = button.dataset.selectLayer ?? selectedLayerId;
      render();
    });
  }

  for (const checkbox of document.querySelectorAll<HTMLInputElement>("[data-toggle-layer]")) {
    checkbox.addEventListener("change", () => {
      const layerId = checkbox.dataset.toggleLayer ?? "";
      updateLayerVisibility(layerId, checkbox.checked);
    });
  }

  for (const slider of document.querySelectorAll<HTMLInputElement>("[data-opacity-layer]")) {
    slider.addEventListener("input", () => {
      const layerId = slider.dataset.opacityLayer ?? "";
      updateLayerOpacity(layerId, Number(slider.value) / 100);
    });
  }
}

function renderSelectedLayer(): void {
  const state = requireSelectedLayer();
  setText("#selected-kind", state.layer.auditCapability);
  getElement<HTMLElement>("#selected-metadata").innerHTML = `
    <div><dt>Service</dt><dd>${escapeHtml(state.layer.serviceId)}</dd></div>
    <div><dt>Endpoint</dt><dd>${escapeHtml(state.layer.endpointPath)}</dd></div>
    <div><dt>Asset</dt><dd>${escapeHtml(state.layer.sourceAsset)}</dd></div>
    <div><dt>Metadata</dt><dd>${escapeHtml(metadataLabel(state))}</dd></div>
  `;
  getElement<HTMLElement>("#legend-strip").innerHTML = state.layer.legend
    .map(
      (entry) => `
        <span>
          <i style="background:${escapeHtml(entry.color)}"></i>
          ${escapeHtml(entry.label)}
        </span>
      `,
    )
    .join("");
  setText(
    "#export-state",
    state.exportPreview?.href
      ? `Export preview ${state.exportPreview.width ?? 0}x${state.exportPreview.height ?? 0}: ${state.exportPreview.href}`
      : state.error
        ? `Capability load warning: ${state.error}`
        : "Export preview not requested for this render path.",
  );
}

function renderAudit(): void {
  getElement<HTMLElement>("#audit-table").innerHTML = renderPlan.auditRows
    .map(
      (row) => `
        <article>
          <strong>${escapeHtml(row.capability)}</strong>
          <span>${escapeHtml(row.sampleLayer)}</span>
          <code>${escapeHtml(row.sdkSurface)}</code>
          <small>${escapeHtml(row.cachePolicy)}</small>
        </article>
      `,
    )
    .join("");
}

function addMapLayers(plan: ImageryRenderPlan): void {
  for (const state of plan.layers) {
    if (!map.getSource(state.mapSourceId)) {
      map.addSource(state.mapSourceId, {
        type: "raster",
        tiles: [...state.sourceSpec.tiles],
        tileSize: state.sourceSpec.tileSize,
        ...(state.sourceSpec.scheme ? { scheme: state.sourceSpec.scheme } : {}),
        ...(state.sourceSpec.minzoom !== undefined ? { minzoom: state.sourceSpec.minzoom } : {}),
        ...(state.sourceSpec.maxzoom !== undefined ? { maxzoom: state.sourceSpec.maxzoom } : {}),
        ...(state.sourceSpec.attribution ? { attribution: state.sourceSpec.attribution } : {}),
      });
    }
    if (!map.getLayer(state.mapLayerId)) {
      map.addLayer({
        id: state.mapLayerId,
        type: "raster",
        source: state.mapSourceId,
        layout: { visibility: state.visible ? "visible" : "none" },
        paint: { "raster-opacity": state.opacity },
      });
    }
  }
}

function updateLayerVisibility(layerId: string, visible: boolean): void {
  renderPlan = setImageryLayerVisibility(renderPlan, layerId, visible);
  const state = renderPlan.layers.find((candidate) => candidate.layer.id === layerId);
  if (state && map.getLayer(state.mapLayerId)) {
    map.setLayoutProperty(state.mapLayerId, "visibility", visible ? "visible" : "none");
  }
  render();
}

function updateLayerOpacity(layerId: string, opacity: number): void {
  renderPlan = setImageryLayerOpacity(renderPlan, layerId, opacity);
  const state = renderPlan.layers.find((candidate) => candidate.layer.id === layerId);
  if (state && map.getLayer(state.mapLayerId)) {
    map.setPaintProperty(state.mapLayerId, "raster-opacity", state.opacity);
  }
  render();
}

function requireSelectedLayer(): ImageryLayerState {
  return renderPlan.layers.find((state) => state.layer.id === selectedLayerId) ?? renderPlan.layers[0]!;
}

function metadataLabel(state: ImageryLayerState): string {
  if (state.error) return "warning";
  const service = state.metadata?.serviceDescription;
  const layerCount = state.metadata?.layers?.length ?? 0;
  return service ? `${service} / ${layerCount} layer(s)` : "fixture metadata";
}

function fitDatasetExtent(): void {
  map.fitBounds(
    [
      [dataset.extent.xmin, dataset.extent.ymin],
      [dataset.extent.xmax, dataset.extent.ymax],
    ],
    { padding: 56, duration: 350 },
  );
}

getElement<HTMLButtonElement>("#zoom-extent").addEventListener("click", fitDatasetExtent);

map.once("load", async () => {
  addMapLayers(renderPlan);
  fitDatasetExtent();
  render();
  renderPlan = await hydrateImageryRenderPlan(renderPlan, client);
  render();
  window.__HONUA_IMAGERY_COG_DEMO__ = {
    ready: true,
    get activeLayerCount() {
      return activeImageryLayerCount(renderPlan);
    },
    get layerIds() {
      return renderPlan.layers.map((state) => state.mapLayerId);
    },
    get tileTemplates() {
      return renderPlan.layers.flatMap((state) => state.sourceSpec.tiles);
    },
    toggleLayer(layerId: string, visible: boolean) {
      updateLayerVisibility(layerId, visible);
    },
    setOpacity(layerId: string, opacity: number) {
      updateLayerOpacity(layerId, opacity);
    },
  };
});
