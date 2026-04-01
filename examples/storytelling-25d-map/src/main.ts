import "maplibre-gl/dist/maplibre-gl.css";

import { resolveStoryDemoConfig } from "./config.js";
import { loadStoryDataset } from "./data.js";
import { createStoryMap } from "./map.js";
import { type StoryStepState, createStoryController } from "./story.js";
import { createStoryTelemetry } from "./telemetry.js";
import type { StoryAssetFeature, StoryDataset } from "./types.js";

import "./styles.css";

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function renderMetrics(dataset: StoryDataset): void {
  getElement<HTMLElement>("#metric-assets").textContent = String(dataset.summary.assetCount);
  getElement<HTMLElement>("#metric-priority").textContent = String(dataset.summary.priorityAssetCount);
  getElement<HTMLElement>("#metric-stops").textContent = String(dataset.summary.stopCount);
}

function renderSelectedAsset(feature: StoryAssetFeature): void {
  getElement<HTMLElement>("#selection-title").textContent = feature.properties.name;
  getElement<HTMLElement>("#selection-summary").textContent = feature.properties.summary;
  getElement<HTMLElement>("#selection-height").textContent = `${feature.properties.extrusion_height_m.toFixed(0)} m`;
  getElement<HTMLElement>("#selection-risk").textContent = feature.properties.risk_score.toFixed(1);
  getElement<HTMLElement>("#selection-status").textContent = feature.properties.status;
  getElement<HTMLElement>("#selection-district").textContent = feature.properties.district;

  const riskPill = getElement<HTMLElement>("#selection-risk-pill");
  riskPill.textContent = feature.properties.risk_bucket.toUpperCase();
  riskPill.dataset.riskBucket = feature.properties.risk_bucket;
}

function updateStatusCopy(configBaseUrl: string, summary: StoryDataset["summary"]): void {
  const target = configBaseUrl.length > 0 ? configBaseUrl : "same-origin Honua path";
  getElement<HTMLElement>("#demo-status").textContent =
    `Live target: ${target}. Story metrics: ${summary.assetCount} assets, ${summary.stopCount} stops, ${summary.routeLengthKm.toFixed(2)} km route.`;
}

function renderStepButtons(
  steps: ReturnType<typeof createStoryController>["steps"],
  onSelect: (index: number) => void,
): void {
  const container = getElement<HTMLElement>("#story-step-list");
  container.innerHTML = "";

  steps.forEach((step, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story-step-button";
    button.dataset.stepId = step.id;
    button.dataset.testid = `story-step-${step.id}`;
    button.innerHTML = `<span>${index + 1}</span><strong>${step.title}</strong>`;
    button.addEventListener("click", () => onSelect(index));
    container.append(button);
  });
}

function applyStepState(state: StoryStepState): void {
  getElement<HTMLElement>("#story-step-kicker").textContent = state.step.kicker;
  getElement<HTMLElement>("#story-step-title").textContent = state.step.title;
  getElement<HTMLElement>("#story-step-body").textContent = state.step.body;
  getElement<HTMLElement>("#story-step-support").textContent = state.step.support;
  getElement<HTMLElement>("#story-metric-label").textContent = state.step.metricLabel;
  getElement<HTMLElement>("#story-metric-value").textContent = state.step.metricValue;
  getElement<HTMLElement>("#map-mode-chip").textContent = state.step.title;

  document.querySelectorAll<HTMLButtonElement>(".story-step-button").forEach((button, index) => {
    const isActive = index === state.index;
    button.dataset.active = isActive ? "true" : "false";
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  const previousButton = getElement<HTMLButtonElement>("#story-previous");
  const nextButton = getElement<HTMLButtonElement>("#story-next");
  const replayButton = getElement<HTMLButtonElement>("#story-replay");

  previousButton.disabled = state.index === 0;
  nextButton.disabled = state.index === state.totalSteps - 1;
  replayButton.hidden = state.step.id !== "route-replay";
  replayButton.disabled = state.step.id !== "route-replay";

  const overlay = getElement<HTMLElement>("#map-overlay");
  overlay.dataset.state = "ready";
}

async function bootstrap(): Promise<void> {
  const telemetry = createStoryTelemetry(window);
  const config = resolveStoryDemoConfig(import.meta.env as Record<string, string | undefined>);
  const mapContainer = getElement<HTMLElement>("#map");
  getElement<HTMLElement>("#map-collection-chip").textContent =
    `OGC: ${config.collections.assets} / ${config.collections.route} / ${config.collections.stops}`;
  telemetry.emit("init", {
    mode: import.meta.env.MODE,
    baseUrl: config.honuaBaseUrl || "same-origin",
    collections: config.collections,
  });

  const overlay = getElement<HTMLElement>("#map-overlay");
  const overlayTitle = getElement<HTMLElement>(".map-overlay-title");
  const overlayBody = getElement<HTMLElement>(".map-overlay-body");

  try {
    overlayTitle.textContent = "Checking Honua compatibility";
    overlayBody.textContent = "The demo uses the browser SDK compatibility gate before loading any story collections.";

    const dataset = await loadStoryDataset(config, { telemetry });
    const assetById = new Map(dataset.assetViews.map((entry) => [entry.feature.id, entry.feature]));

    renderMetrics(dataset);
    updateStatusCopy(config.honuaBaseUrl, dataset.summary);
    renderSelectedAsset(assetById.get(dataset.focusAssetId) ?? dataset.assetViews[0].feature);

    const mapHandle = await createStoryMap({
      container: mapContainer,
      dataset,
      config,
      telemetry,
      onAssetSelected(id) {
        if (!id) {
          return;
        }
        const selected = assetById.get(id);
        if (!selected) {
          return;
        }
        telemetry.runtime.selectedAssetId = id;
        renderSelectedAsset(selected);
      },
    });

    telemetry.runtime.mapReady = true;
    telemetry.runtime.pitch = mapHandle.map.getPitch();
    telemetry.runtime.sourceIds = [...mapHandle.sourceIds];
    telemetry.runtime.layerIds = [...mapHandle.layerIds];

    const controller = createStoryController({
      dataset,
      mapHandle,
      config,
      telemetry,
      onStepChange(state) {
        applyStepState(state);
      },
    });

    renderStepButtons(controller.steps, (index) => {
      void controller.goToStep(index);
    });

    getElement<HTMLButtonElement>("#story-previous").addEventListener("click", () => {
      void controller.previous();
    });
    getElement<HTMLButtonElement>("#story-next").addEventListener("click", () => {
      void controller.next();
    });
    getElement<HTMLButtonElement>("#story-replay").addEventListener("click", () => {
      void controller.replayRoute();
    });

    await controller.goToStep(0);

    window.addEventListener("beforeunload", () => {
      controller.destroy();
      mapHandle.destroy();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    telemetry.emit("error", { message });
    overlay.dataset.state = "error";
    overlayTitle.textContent = "Unable to start the story demo";
    overlayBody.textContent = message;
    getElement<HTMLElement>("#demo-status").textContent = message;
    getElement<HTMLElement>("#map-mode-chip").textContent = "Error";
  }
}

void bootstrap();
