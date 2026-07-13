import { connect } from "@honua/sdk-js";
import { type MountedSource, type MountedSourceDiagnostics, mountSource } from "@honua/sdk-js/map";
import maplibregl from "maplibre-gl";

import { type EndpointToMapConfig, resolveEndpointToMapConfig } from "./config.js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

const config = resolveEndpointToMapConfig(import.meta.env as Record<string, string | undefined>);

/**
 * The headline workflow — public endpoint to a styled, interactive map.
 * Four statements of application code (13 physical lines at this file's
 * 120-column formatting); everything below `endpointToMap()` is demo-shell
 * chrome (status panel, filter UI).
 */
async function endpointToMap(): Promise<MountedSource> {
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
  return mounted;
}

// ── Demo shell (not counted): status panel, diagnostics, live filter ──

interface EndpointToMapState {
  ready?: boolean;
  strategy?: string;
  featureCount?: number;
  layerIds?: readonly string[];
  overflow?: boolean;
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
    const mounted = await endpointToMap();
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
