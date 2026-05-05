import type { QuickstartRenderableGeometryType } from "./esri-geojson.js";

export interface QuickstartTelemetryEvent {
  type:
    | "init"
    | "compatibility-ok"
    | "query-started"
    | "query-finished"
    | "map-ready"
    | "feature-selected"
    | "linked-filter-changed"
    | "linked-query-updated"
    | "error";
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface QuickstartRuntimeState {
  baseUrl?: string;
  serviceId?: string;
  layerId?: number;
  featureCount?: number;
  renderableFeatureCount?: number;
  geometryTypes?: QuickstartRenderableGeometryType[];
  serverVersion?: string;
  releaseChannel?: string;
  queryDurationMs?: number;
  mapReady?: boolean;
  selectedFeatureId?: string | null;
  lastError?: string | null;
  layerIds?: string[];
  popupOpen?: boolean;
  linkedVisibleFeatureCount?: number;
  linkedFilterCount?: number;
  linkedExtent?: string | null;
}

declare global {
  interface Window {
    __HONUA_QUICKSTART_EVENTS__?: QuickstartTelemetryEvent[];
    __HONUA_QUICKSTART_RUNTIME__?: QuickstartRuntimeState;
  }
}

function ensureEvents(target: Window): QuickstartTelemetryEvent[] {
  target.__HONUA_QUICKSTART_EVENTS__ ??= [];
  return target.__HONUA_QUICKSTART_EVENTS__;
}

function ensureRuntime(target: Window): QuickstartRuntimeState {
  target.__HONUA_QUICKSTART_RUNTIME__ ??= {
    selectedFeatureId: null,
    lastError: null,
    mapReady: false,
    popupOpen: false,
  };
  return target.__HONUA_QUICKSTART_RUNTIME__;
}

export interface QuickstartTelemetry {
  events: QuickstartTelemetryEvent[];
  runtime: QuickstartRuntimeState;
  emit(type: QuickstartTelemetryEvent["type"], payload: Record<string, unknown>): void;
  patchRuntime(update: Partial<QuickstartRuntimeState>): void;
}

export function createQuickstartTelemetry(target: Window = window): QuickstartTelemetry {
  const events = ensureEvents(target);
  const runtime = ensureRuntime(target);

  return {
    events,
    runtime,
    emit(type, payload) {
      const event: QuickstartTelemetryEvent = {
        type,
        payload,
        timestamp: new Date().toISOString(),
      };
      events.push(event);
      target.dispatchEvent(new CustomEvent("honua:quickstart", { detail: event }));
      console.info("[honua:quickstart]", JSON.stringify(event));
    },
    patchRuntime(update) {
      Object.assign(runtime, update);
    },
  };
}
