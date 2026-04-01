import { getBoundsForGeometry, mergeBounds, toLngLatBounds } from "./geometry.js";
import type { StoryMapHandle } from "./map.js";
import type { StoryTelemetry } from "./telemetry.js";
import type { StoryDataset, StoryDemoConfig } from "./types.js";

export interface StoryStep {
  id: "overview" | "triage" | "route-replay" | "asset-focus";
  title: string;
  kicker: string;
  body: string;
  support: string;
  metricLabel: string;
  metricValue: string;
}

export interface StoryStepState {
  step: StoryStep;
  index: number;
  totalSteps: number;
}

export interface StoryController {
  steps: readonly StoryStep[];
  readonly currentStepIndex: number;
  goToStep(index: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  replayRoute(): Promise<void>;
  destroy(): void;
}

function getMapPadding() {
  if (window.innerWidth < 900) {
    return {
      top: 24,
      right: 24,
      bottom: 320,
      left: 24,
    };
  }

  return {
    top: 48,
    right: 430,
    bottom: 48,
    left: 48,
  };
}

export interface CreateStoryControllerOptions {
  dataset: StoryDataset;
  mapHandle: StoryMapHandle;
  config: Pick<StoryDemoConfig, "priorityRiskThreshold" | "routeAnimationMs">;
  telemetry: StoryTelemetry;
  onStepChange?: (state: StoryStepState) => void;
}

export function createStoryController(options: CreateStoryControllerOptions): StoryController {
  const assetById = new Map(options.dataset.assetViews.map((entry) => [entry.feature.id, entry]));
  const focusAsset = assetById.get(options.dataset.focusAssetId) ?? options.dataset.assetViews[0];
  const priorityBounds = mergeBounds(
    options.dataset.priorityAssetIds
      .map((id) => assetById.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => entry.bounds),
  );
  const routeBounds = mergeBounds([
    getBoundsForGeometry(options.dataset.routeFeature.geometry),
    ...options.dataset.stopViews.map((entry) => getBoundsForGeometry(entry.feature.geometry)),
  ]);

  const steps: StoryStep[] = [
    {
      id: "overview",
      title: "Pitched corridor overview",
      kicker: "Step 1 / Overview",
      body: `All ${options.dataset.summary.assetCount} corridor assets load from Honua OGC collections and rise above a flat basemap as a 2.5D bridge, not a full 3D scene.`,
      support:
        "The camera stays pitched and the polygon layer is rendered as fill extrusions so the difference from a flat analytics map is obvious before the narrative narrows.",
      metricLabel: "Runtime path",
      metricValue: "Honua compatibility gate + OGC API Features",
    },
    {
      id: "triage",
      title: "Triage the highest-risk corridor",
      kicker: "Step 2 / Triage",
      body: `${options.dataset.summary.priorityAssetCount} assets cross the priority threshold and remain highlighted while the camera tightens to the corridor that needs action first.`,
      support:
        "This step keeps the story deterministic: the same ranked assets are emphasized every run, and the same corridor camera move sets up the replay lane.",
      metricLabel: "Priority threshold",
      metricValue: `Risk score >= ${options.config.priorityRiskThreshold}`,
    },
    {
      id: "route-replay",
      title: "Replay the inspection route",
      kicker: "Step 3 / Route Replay",
      body: `A ${options.dataset.summary.routeLengthKm.toFixed(2)} km inspection path animates across ${options.dataset.summary.stopCount} fixed stops while the camera stays pitched for depth cues.`,
      support:
        "The replay is fully client-side after the initial data load, so the route animation does not trigger repeated network calls or source reloads.",
      metricLabel: "Animation mode",
      metricValue: "Client-side route progress + moving marker",
    },
    {
      id: "asset-focus",
      title: "Close on the highest-risk asset",
      kicker: "Step 4 / Asset Focus",
      body: `${focusAsset.feature.properties.name} becomes the focal asset to close the walkthrough with a grounded explanation of why this is 2.5D: extrusion, tilt, and storytelling without terrain or mesh claims.`,
      support:
        "This ending step is intentionally explicit about the boundary. It is a credible bridge from 2D analytics toward future 3D work, not a digital-twin parity statement.",
      metricLabel: "Bridge claim",
      metricValue: "2.5D web-map storytelling, not full 3D",
    },
  ];

  let currentStepIndex = 0;
  let activeRoutePlayback: ReturnType<StoryMapHandle["playRoute"]> | undefined;

  function cancelRoutePlayback(): void {
    activeRoutePlayback?.cancel();
    activeRoutePlayback = undefined;
  }

  function publishStep(index: number): void {
    const step = steps[index];
    options.telemetry.runtime.currentStepId = step.id;
    options.telemetry.emit("story-step-changed", {
      stepId: step.id,
      stepIndex: index,
      totalSteps: steps.length,
    });
    options.onStepChange?.({
      step,
      index,
      totalSteps: steps.length,
    });
  }

  async function startRoutePlayback(): Promise<void> {
    cancelRoutePlayback();
    options.mapHandle.setPriorityAssets(options.dataset.priorityAssetIds);
    options.mapHandle.setSelectedAsset(undefined);
    options.mapHandle.setActiveStop(options.dataset.stopViews[0]?.feature.id);
    options.telemetry.emit("route-playback-started", {
      stopCount: options.dataset.summary.stopCount,
      durationMs: options.config.routeAnimationMs,
    });

    const playback = options.mapHandle.playRoute({
      durationMs: options.config.routeAnimationMs,
      onProgress(progress) {
        const stopIndex = Math.min(
          options.dataset.stopViews.length - 1,
          Math.max(0, Math.floor(progress * options.dataset.stopViews.length)),
        );
        const activeStop = options.dataset.stopViews[stopIndex]?.feature.id;
        options.mapHandle.setActiveStop(activeStop);
      },
    });

    activeRoutePlayback = playback;
    const completed = await playback.promise;
    if (completed) {
      options.telemetry.emit("route-playback-finished", {
        stopCount: options.dataset.summary.stopCount,
      });
    }
    if (activeRoutePlayback === playback) {
      activeRoutePlayback = undefined;
    }
  }

  async function goToStep(index: number): Promise<void> {
    if (index < 0 || index >= steps.length) {
      return;
    }

    currentStepIndex = index;
    cancelRoutePlayback();
    options.mapHandle.resetRoutePlayback();

    switch (steps[index].id) {
      case "overview":
        options.mapHandle.setPriorityAssets([]);
        options.mapHandle.setSelectedAsset(undefined);
        options.mapHandle.setActiveStop(undefined);
        options.mapHandle.map.fitBounds(toLngLatBounds(options.dataset.bounds), {
          padding: getMapPadding(),
          pitch: 60,
          bearing: -18,
          duration: 1_500,
        });
        break;
      case "triage":
        options.mapHandle.setPriorityAssets(options.dataset.priorityAssetIds);
        options.mapHandle.setSelectedAsset(undefined);
        options.mapHandle.setActiveStop(options.dataset.stopViews[0]?.feature.id);
        options.mapHandle.map.fitBounds(toLngLatBounds(priorityBounds), {
          padding: getMapPadding(),
          pitch: 68,
          bearing: -4,
          duration: 1_400,
          maxZoom: 15.5,
        });
        break;
      case "route-replay":
        options.mapHandle.map.fitBounds(toLngLatBounds(routeBounds), {
          padding: getMapPadding(),
          pitch: 74,
          bearing: 24,
          duration: 1_400,
        });
        void startRoutePlayback();
        break;
      case "asset-focus":
        options.mapHandle.setPriorityAssets([options.dataset.focusAssetId]);
        options.mapHandle.setSelectedAsset(options.dataset.focusAssetId);
        options.mapHandle.setActiveStop(options.dataset.focusStopId);
        options.mapHandle.map.fitBounds(toLngLatBounds(focusAsset.bounds), {
          padding: getMapPadding(),
          pitch: 76,
          bearing: 34,
          duration: 1_400,
          maxZoom: 16.6,
        });
        break;
    }

    publishStep(index);
  }

  return {
    steps,
    get currentStepIndex() {
      return currentStepIndex;
    },
    async goToStep(index: number) {
      await goToStep(index);
    },
    async next() {
      await goToStep(Math.min(steps.length - 1, currentStepIndex + 1));
    },
    async previous() {
      await goToStep(Math.max(0, currentStepIndex - 1));
    },
    async replayRoute() {
      if (steps[currentStepIndex]?.id !== "route-replay") {
        return;
      }
      await startRoutePlayback();
    },
    destroy() {
      cancelRoutePlayback();
    },
  };
}
