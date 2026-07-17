export interface QuickstartTelemetryEvent {
  type:
    | "init"
    | "compatibility-ok"
    | "plan-explained"
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
  mode?: "fixture" | "live" | "public-live";
  baseUrl?: string;
  serviceId?: string;
  layerId?: number;
  featureCount?: number;
  renderableFeatureCount?: number;
  geometryTypes?: string[];
  serverVersion?: string;
  releaseChannel?: string;
  queryDurationMs?: number;
  sdkVersion?: string;
  dataVersion?: string;
  sourceProtocol?: string;
  sourceId?: string;
  sourceAttribution?: string | null;
  sourceObservedAt?: string | null;
  sourceFreshness?: "observed" | "unavailable";
  cacheStatus?: "bypass" | "hit" | "miss" | "refreshed";
  degradation?: string[];
  authorizationMode?: "anonymous";
  planId?: string;
  planFingerprint?: string;
  planPushdown?: "full" | "partial";
  mapReady?: boolean;
  selectedFeatureId?: string | null;
  lastError?: string | null;
  layerIds?: string[];
  popupOpen?: boolean;
  linkedVisibleFeatureCount?: number;
  linkedFilterCount?: number;
  linkedExtent?: string | null;
  journeyComplete?: boolean;
  disposed?: boolean;
  firstMapDurationMs?: number;
  firstMapBudgetMs?: number;
  firstMapBudgetMet?: boolean;
  interactionDurationMs?: number;
  interactionBudgetMet?: boolean;
  cleanupDurationMs?: number;
  cleanupBudgetMet?: boolean;
}

declare global {
  interface Window {
    __HONUA_QUICKSTART_EVENTS__?: QuickstartTelemetryEvent[];
    __HONUA_QUICKSTART_RUNTIME__?: QuickstartRuntimeState;
    __HONUA_QUICKSTART_DISPOSE__?: () => Promise<void>;
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
