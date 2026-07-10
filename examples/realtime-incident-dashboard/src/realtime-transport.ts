import {
  type RealtimeFeatureEvent,
  type RealtimeFeatureTransport,
  type RealtimeSubscriptionRequest,
  createHonuaServerRealtimeSubscription,
  decodeHonuaServerRealtimeEvent,
} from "../../../src/realtime/index.js";

import { INCIDENT_LAYER_ID, INCIDENT_SOURCE_ID } from "./fixtures.js";
import { type FixtureIncidentTransport, createFixtureIncidentTransport } from "./realtime-fixture.js";
import { SAFE_DEMO_EDIT_SOURCE_ID } from "./safe-edit.js";
import type {
  IncidentEditReceipt,
  IncidentEditRequest,
  IncidentFeature,
  IncidentResetRequest,
  IncidentScenarioStep,
} from "./types.js";

export type IncidentRequestedTransportMode = "auto" | "live" | "replay" | "fixture-edit";
export type IncidentTransportMode = "live" | "replay" | "fixture-edit";

export interface IncidentTransportControls {
  readonly mode: IncidentTransportMode;
  readonly requestedMode: IncidentRequestedTransportMode;
  readonly fallbackReason?: string;
  readonly sourceIdentity: string;
  readonly safeDemoEditing: boolean;
  readonly authorized: boolean;
  step(): IncidentScenarioStep | undefined;
  reconnect(): void;
  resume(): void;
  refresh(): void;
  duplicateLast(): void;
  staleCursor(): void;
  edit(request: IncidentEditRequest): IncidentEditReceipt;
  reset(request: IncidentResetRequest): IncidentEditReceipt;
  simulateConcurrentUpdate(): IncidentFeature | undefined;
}

export interface IncidentTransportConfig {
  readonly requestedMode: IncidentRequestedTransportMode;
  readonly demoBaseUrl: string;
  readonly capabilitiesUrl: string;
  readonly streamUrl: string;
  readonly sourceIdentity: string;
  readonly layerId: number;
}

export interface ResolvedIncidentTransportConfig extends IncidentTransportConfig {
  readonly mode: IncidentTransportMode;
  readonly fallbackReason?: string;
  readonly capabilityObservedAt?: string;
}

export interface IncidentDashboardTransport {
  readonly transport: RealtimeFeatureTransport<IncidentFeature>;
  readonly controls: IncidentTransportControls;
  readonly request: RealtimeSubscriptionRequest;
}

export interface ResolveIncidentTransportOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_DEMO_BASE_URL = "https://demo.honua.io";
const DEFAULT_SOURCE_ID = "maui-incidents";
const DEFAULT_LAYER_ID = 0;
const SENSITIVE_QUERY_KEYS = ["access_token", "api_key", "key", "sig", "signature", "token"];

export function readIncidentTransportConfig(location: Location = window.location): IncidentTransportConfig {
  const params = new URLSearchParams(location.search);
  const env = (import.meta as ImportMeta & { readonly env?: Record<string, string | undefined> }).env;
  const requestedMode = normalizeRequestedMode(params.get("transport") ?? env?.VITE_HONUA_INCIDENT_TRANSPORT);
  const demoBaseUrl = sanitizedPublicUrl(
    params.get("baseUrl") ?? env?.VITE_HONUA_INCIDENT_BASE_URL ?? DEFAULT_DEMO_BASE_URL,
  );
  const streamUrl = sanitizedPublicUrl(
    params.get("streamUrl") ?? env?.VITE_HONUA_INCIDENT_STREAM_URL ?? `${demoBaseUrl}/api/v1/streaming/features`,
  );
  const capabilitiesUrl = sanitizedPublicUrl(
    params.get("capabilitiesUrl") ??
      env?.VITE_HONUA_INCIDENT_CAPABILITIES_URL ??
      `${demoBaseUrl}/api/v1/streaming/features/capabilities`,
  );
  const layerId = Number.parseInt(params.get("layerId") ?? env?.VITE_HONUA_INCIDENT_LAYER_ID ?? "0", 10);
  return {
    requestedMode,
    demoBaseUrl,
    capabilitiesUrl,
    streamUrl,
    sourceIdentity: params.get("sourceId") ?? env?.VITE_HONUA_INCIDENT_SOURCE_ID ?? DEFAULT_SOURCE_ID,
    layerId: Number.isFinite(layerId) && layerId >= 0 ? layerId : DEFAULT_LAYER_ID,
  };
}

export async function resolveIncidentTransportConfig(
  config: IncidentTransportConfig,
  options: ResolveIncidentTransportOptions = {},
): Promise<ResolvedIncidentTransportConfig> {
  if (config.requestedMode === "fixture-edit") return { ...config, mode: "fixture-edit" };
  if (config.requestedMode === "replay") {
    return { ...config, mode: "replay", fallbackReason: "Replay was explicitly requested." };
  }
  if (config.requestedMode === "live") return { ...config, mode: "live" };

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
  const capabilityObservedAt = new Date().toISOString();
  try {
    const response = await fetchFn(config.capabilitiesUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => undefined)) as
      | { readonly enabled?: boolean; readonly data?: { readonly enabled?: boolean; readonly minimumEdition?: string } }
      | undefined;
    const capability = (body?.data ?? body) as
      | { readonly enabled?: boolean; readonly minimumEdition?: string }
      | undefined;
    if (response.ok && capability?.enabled === true) {
      return { ...config, mode: "live", capabilityObservedAt };
    }
    const edition = capability?.minimumEdition ? `; requires ${capability.minimumEdition}` : "";
    return {
      ...config,
      mode: "replay",
      capabilityObservedAt,
      fallbackReason: `Deployed realtime capability unavailable (HTTP ${response.status}${edition}).`,
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError" ? "capability probe timed out" : "demo unreachable";
    return {
      ...config,
      mode: "replay",
      capabilityObservedAt,
      fallbackReason: `Deployed realtime capability unavailable (${reason}).`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createIncidentDashboardTransport(config: ResolvedIncidentTransportConfig): IncidentDashboardTransport {
  if (config.mode === "live") {
    return {
      transport: createHonuaServerRealtimeSubscription<IncidentFeature>({
        url: config.streamUrl,
        decodeEvent: decodeIncidentServerEvent,
      }),
      controls: createReadOnlyControls(config),
      request: createIncidentRealtimeRequest(config.sourceIdentity, config.layerId, config.mode),
    };
  }

  const fixture = createFixtureIncidentTransport();
  return {
    transport: fixture,
    controls: createFixtureIncidentTransportControls(fixture, config),
    request: createIncidentRealtimeRequest(INCIDENT_SOURCE_ID, INCIDENT_LAYER_ID, config.mode),
  };
}

export function decodeIncidentServerEvent(payload: unknown): RealtimeFeatureEvent<IncidentFeature> {
  const event = decodeHonuaServerRealtimeEvent<IncidentFeature>(payload);
  switch (event.type) {
    case "snapshot":
      return {
        ...event,
        features: event.features.map((feature) => ({ ...feature, sourceId: INCIDENT_SOURCE_ID })),
      };
    case "upsert":
      return { ...event, feature: { ...event.feature, sourceId: INCIDENT_SOURCE_ID } };
    case "delete":
      return { ...event, sourceId: INCIDENT_SOURCE_ID };
    case "delta":
      return {
        ...event,
        upserts: event.upserts?.map((feature) => ({ ...feature, sourceId: INCIDENT_SOURCE_ID })),
        deletes: event.deletes?.map((feature) => ({ ...feature, sourceId: INCIDENT_SOURCE_ID })),
      };
    default:
      return event;
  }
}

function createIncidentRealtimeRequest(
  sourceId: string,
  layerId: string | number,
  channel: IncidentTransportMode,
): RealtimeSubscriptionRequest {
  return {
    requestId: "realtime-incident-dashboard",
    sourceId,
    layerId,
    mode: "snapshot-then-delta",
    metadata: {
      demo: "realtime-incident-dashboard",
      channel,
      livePreferred: true,
    },
  };
}

function createFixtureIncidentTransportControls(
  fixture: FixtureIncidentTransport,
  config: ResolvedIncidentTransportConfig,
): IncidentTransportControls {
  const editable = config.mode === "fixture-edit";
  return {
    mode: config.mode,
    requestedMode: config.requestedMode,
    fallbackReason: config.fallbackReason,
    sourceIdentity: editable ? SAFE_DEMO_EDIT_SOURCE_ID : INCIDENT_SOURCE_ID,
    safeDemoEditing: editable,
    authorized: editable,
    step: () => fixture.step(),
    reconnect: () => fixture.reconnect(),
    resume: () => fixture.resume(),
    refresh: () => fixture.refresh(),
    duplicateLast: () => fixture.duplicateLast(),
    staleCursor: () => fixture.staleCursor(),
    edit: (request) => fixture.edit(request),
    reset: (request) => fixture.reset(request),
    simulateConcurrentUpdate: () => fixture.simulateConcurrentUpdate(),
  };
}

function createReadOnlyControls(config: ResolvedIncidentTransportConfig): IncidentTransportControls {
  const blocked = (operation: "edit" | "reset", idempotencyKey: string): IncidentEditReceipt => ({
    outcome: "blocked",
    operation,
    idempotencyKey,
    reason: "Live editing is disabled until the server advertises an isolated resettable demo-edit profile.",
  });
  return {
    mode: "live",
    requestedMode: config.requestedMode,
    sourceIdentity: config.sourceIdentity,
    safeDemoEditing: false,
    authorized: false,
    step: () => undefined,
    reconnect: () => undefined,
    resume: () => undefined,
    refresh: () => undefined,
    duplicateLast: () => undefined,
    staleCursor: () => undefined,
    edit: (request) => blocked("edit", request.idempotencyKey),
    reset: (request) => blocked("reset", request.idempotencyKey),
    simulateConcurrentUpdate: () => undefined,
  };
}

function normalizeRequestedMode(value: string | undefined): IncidentRequestedTransportMode {
  if (value === "fixture" || value === "fixture-edit") return "fixture-edit";
  if (value === "replay") return "replay";
  if (value === "cloud" || value === "live") return "live";
  return "auto";
}

function sanitizedPublicUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Incident endpoint must use HTTP(S).");
  if (url.username || url.password) throw new Error("Incident endpoint must not contain credentials.");
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (url.searchParams.has(key)) throw new Error("Incident endpoint must not contain credential query parameters.");
  }
  url.hash = "";
  return url.href.replace(/\/$/, "");
}
