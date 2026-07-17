import { connect, createHonua } from "@honua/sdk-js";
import { type MountedSource, type MountedSourceDiagnostics, mountSource } from "@honua/sdk-js/map";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import maplibregl from "maplibre-gl";

import { type EndpointToMapConfig, resolveEndpointToMapConfig } from "./config.js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

const config = resolveEndpointToMapConfig({
  VITE_ENDPOINT_TO_MAP_BASEMAP_STYLE: import.meta.env.VITE_ENDPOINT_TO_MAP_BASEMAP_STYLE,
  VITE_ENDPOINT_TO_MAP_MAX_FEATURES: import.meta.env.VITE_ENDPOINT_TO_MAP_MAX_FEATURES,
  VITE_ENDPOINT_TO_MAP_URL: import.meta.env.VITE_ENDPOINT_TO_MAP_URL,
});

/**
 * The headline workflow — public endpoint to a styled, interactive map.
 * Four statements of application code (13 physical lines at this file's
 * 120-column formatting); everything below `endpointToMap()` is demo-shell
 * chrome (status panel, filter UI).
 */
async function endpointToMap(): Promise<{ readonly map: maplibregl.Map; readonly mounted: MountedSource }> {
  // ── headline start ──────────────────────────────────────────────
  const map = new maplibregl.Map({ container: "map", style: config.basemapStyle, center: [-98, 39], zoom: 3 });
  await map.once("load");
  const data = await connect({
    endpoint: config.featureLayerUrl,
    protocol: "auto",
    authorizationScopeFingerprint: "public",
  });
  const mounted = await mountSource(map, data.source(), {
    maxGeoJsonFeatures: config.maxFeatures,
    popup: { factory: () => new maplibregl.Popup({ closeButton: true }), fields: [...config.popupFields] },
    hover: true,
    fitBounds: true,
  });
  // ── headline end ────────────────────────────────────────────────
  return { map, mounted };
}

// ── Demo shell (not counted): status panel, diagnostics, live filter ──

async function proveConnectionMountLifecycle(map: maplibregl.Map): Promise<void> {
  const kernel = createHonua();
  const sourceId = "honua-kernel-lifecycle-proof";
  const layerId = `${sourceId}-features`;
  try {
    const connection = await kernel.connect(config.featureLayerUrl, {
      protocol: "auto",
      authorizationScopeFingerprint: "public",
    });
    const sourceCount = Object.keys(map.getStyle().sources).length;
    const layerCount = map.getStyle().layers.length;
    const mounted = await connection.mount(map, {
      renderer: maplibreRenderer(maplibregl),
      rendererOptions: { sourceId, layerId },
    });
    await mounted.ready;
    const borrowedMapReady = mounted.raw("maplibre") === map && map.getSource(sourceId) !== undefined;
    await mounted.dispose();
    const disposed =
      mounted.raw("maplibre") === undefined &&
      map.getSource(sourceId) === undefined &&
      ["point", "line", "polygon"].every((kind) => map.getLayer(`${layerId}-${kind}`) === undefined) &&
      Object.keys(map.getStyle().sources).length === sourceCount &&
      map.getStyle().layers.length === layerCount;
    patchState({ kernelMountReady: borrowedMapReady, kernelMountDisposed: disposed });
    setText("status-kernel-mount", borrowedMapReady && disposed ? "Ready → disposed; host survived" : "Failed proof");
  } finally {
    await kernel.dispose();
  }
}

interface EndpointToMapState {
  ready?: boolean;
  strategy?: string;
  featureCount?: number;
  layerIds?: readonly string[];
  overflow?: boolean;
  kernelMountReady?: boolean;
  kernelMountDisposed?: boolean;
  error?: string;
}

declare global {
  interface Window {
    __endpointToMapState?: EndpointToMapState;
  }
}

function patchState(patch: EndpointToMapState): void {
  window.__endpointToMapState = { ...(window.__endpointToMapState ?? {}), ...patch };
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function renderDiagnostics(diagnostics: MountedSourceDiagnostics): void {
  setText("status-strategy", diagnostics.strategy);
  setText("status-feature-count", String(diagnostics.featureCount ?? 0));
  setText("status-geometry", diagnostics.geometryKinds?.join(", ") || "unknown");
  setText(
    "status-overflow",
    diagnostics.overflow
      ? `Truncated at ${diagnostics.overflow.renderedFeatureCount} of ${diagnostics.overflow.totalCount ?? "many"} rows`
      : "None",
  );
  const list = document.getElementById("strategy-reasons");
  if (list) {
    list.innerHTML = "";
    for (const reason of diagnostics.reasons) {
      const item = document.createElement("li");
      item.dataset.severity = reason.severity;
      item.textContent = `${reason.code}: ${reason.message}`;
      list.appendChild(item);
    }
  }
}

function wireFilter(config: EndpointToMapConfig, mounted: MountedSource): void {
  const select = document.getElementById("filter-select") as HTMLSelectElement | null;
  if (!select) return;
  select.innerHTML = "";
  for (const filter of config.filters) {
    const option = document.createElement("option");
    option.value = filter.where;
    option.textContent = filter.label;
    select.appendChild(option);
  }
  select.disabled = false;
  select.addEventListener("change", () => {
    const where = select.value;
    void mounted
      .setFilter(where ? { where } : undefined)
      .then((diagnostics) => {
        renderDiagnostics(diagnostics);
        patchState({ featureCount: diagnostics.featureCount });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setText("status-error", message);
        patchState({ error: message });
      });
  });
}

function setOverlay(state: "loading" | "ready" | "error", title: string, body: string): void {
  const overlay = document.getElementById("map-overlay");
  if (overlay) overlay.setAttribute("data-state", state);
  setText("overlay-title", title);
  setText("overlay-body", body);
}

async function main(): Promise<void> {
  setText("status-endpoint", new URL(config.featureLayerUrl).host || "same-origin fixture");
  try {
    const { map, mounted } = await endpointToMap();
    await proveConnectionMountLifecycle(map);
    renderDiagnostics(mounted.diagnostics);
    wireFilter(config, mounted);
    setOverlay("ready", "Mounted", "Click a feature for a popup; hover for feature-state.");
    patchState({
      ready: true,
      strategy: mounted.strategy,
      featureCount: mounted.diagnostics.featureCount,
      layerIds: mounted.layerIds,
      overflow: Boolean(mounted.diagnostics.overflow),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setText("status-error", message);
    setOverlay("error", "Mount failed", message);
    patchState({ ready: true, error: message });
  }
}

void main();
