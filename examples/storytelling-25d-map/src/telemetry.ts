import type { StoryFeatureId, StoryRuntimeState, StorySummary, StoryTelemetryEvent } from "./types.js";

declare global {
  interface Window {
    __HONUA_25D_EVENTS__?: StoryTelemetryEvent[];
    __HONUA_25D_RUNTIME__?: StoryRuntimeState & {
      layerIds?: string[];
      sourceIds?: string[];
      selectedAssetId?: StoryFeatureId | null;
      mapReady?: boolean;
      pitch?: number;
    };
  }
}

function ensureEvents(target: Window): StoryTelemetryEvent[] {
  target.__HONUA_25D_EVENTS__ ??= [];
  return target.__HONUA_25D_EVENTS__;
}

function ensureRuntime(target: Window): NonNullable<Window["__HONUA_25D_RUNTIME__"]> {
  target.__HONUA_25D_RUNTIME__ ??= {};
  return target.__HONUA_25D_RUNTIME__;
}

export interface StoryTelemetry {
  events: StoryTelemetryEvent[];
  runtime: NonNullable<Window["__HONUA_25D_RUNTIME__"]>;
  emit(type: StoryTelemetryEvent["type"], payload: Record<string, unknown>): void;
  setSummary(summary: StorySummary): void;
}

export function createStoryTelemetry(target: Window = window): StoryTelemetry {
  const events = ensureEvents(target);
  const runtime = ensureRuntime(target);

  return {
    events,
    runtime,
    emit(type, payload) {
      const event: StoryTelemetryEvent = {
        type,
        payload,
        timestamp: new Date().toISOString(),
      };
      events.push(event);
      target.dispatchEvent(new CustomEvent("honua:25d-demo", { detail: event }));
      console.info("[honua:25d-demo]", JSON.stringify(event));
    },
    setSummary(summary) {
      runtime.datasetSummary = summary;
    },
  };
}
