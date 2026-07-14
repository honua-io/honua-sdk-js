import {
  type RealtimeFeatureEvent,
  type RealtimeFeatureTransport,
  type RealtimeSubscriptionRequest,
  createHonuaServerRealtimeSubscription,
  decodeHonuaServerRealtimeEvent,
} from "../../../src/realtime/index.js";

import { INCIDENT_LAYER_ID, INCIDENT_SOURCE_ID } from "./fixtures.js";
import { type FixtureIncidentTransport, createFixtureIncidentTransport } from "./realtime-fixture.js";
import { SAFE_DEMO_EDIT_SOURCE_ID, SAFE_DEMO_INCIDENT_ID } from "./safe-edit.js";
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
  step(): Promise<IncidentScenarioStep | undefined>;
  reconnect(): Promise<void>;
  resume(): Promise<void>;
  refresh(): Promise<void>;
  duplicateLast(): Promise<void>;
  staleCursor(): Promise<void>;
  edit(request: IncidentEditRequest): Promise<IncidentEditReceipt>;
  reset(request: IncidentResetRequest): Promise<IncidentEditReceipt>;
  simulateConcurrentUpdate(): Promise<IncidentFeature | undefined>;
  dispose(): void;
}

export interface IncidentTransportConfig {
  readonly requestedMode: IncidentRequestedTransportMode;
  readonly demoBaseUrl: string;
  readonly capabilitiesUrl: string;
  readonly streamUrl: string;
  readonly sourceIdentity: string;
  readonly layerId: number;
  readonly fixtureRunId?: string;
  readonly fixtureControlUrl?: string;
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

export interface CreateIncidentDashboardTransportOptions {
  readonly fetchFn?: typeof fetch;
}

type ImportMetaWithOptionalEnvironment = ImportMeta & {
  readonly env?: Record<string, string | undefined>;
};

const DEFAULT_DEMO_BASE_URL = "https://demo.honua.io";
const DEFAULT_SOURCE_ID = "maui-incidents";
const DEFAULT_LAYER_ID = 0;
const SENSITIVE_QUERY_KEY_TOKENS = new Set([
  "access_key",
  "access_key_id",
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "authorization",
  "aws_access_key_id",
  "awsaccesskeyid",
  "bearer_token",
  "client_secret",
  "credential",
  "id_token",
  "key",
  "password",
  "private_key",
  "refresh_token",
  "sas",
  "secret",
  "sig",
  "signature",
  "subscription_key",
  "token",
  "x_amz_credential",
  "x_amz_signature",
  "x_api_key",
  "x_goog_signature",
]);

export function readIncidentTransportConfig(location: Location = window.location): IncidentTransportConfig {
  const params = new URLSearchParams(location.search);
  const env = {
    VITE_HONUA_INCIDENT_BASE_URL: (import.meta as ImportMetaWithOptionalEnvironment).env?.VITE_HONUA_INCIDENT_BASE_URL,
    VITE_HONUA_INCIDENT_CAPABILITIES_URL: (import.meta as ImportMetaWithOptionalEnvironment).env
      ?.VITE_HONUA_INCIDENT_CAPABILITIES_URL,
    VITE_HONUA_INCIDENT_LAYER_ID: (import.meta as ImportMetaWithOptionalEnvironment).env?.VITE_HONUA_INCIDENT_LAYER_ID,
    VITE_HONUA_INCIDENT_SOURCE_ID: (import.meta as ImportMetaWithOptionalEnvironment).env
      ?.VITE_HONUA_INCIDENT_SOURCE_ID,
    VITE_HONUA_INCIDENT_STREAM_URL: (import.meta as ImportMetaWithOptionalEnvironment).env
      ?.VITE_HONUA_INCIDENT_STREAM_URL,
    VITE_HONUA_INCIDENT_TRANSPORT: (import.meta as ImportMetaWithOptionalEnvironment).env
      ?.VITE_HONUA_INCIDENT_TRANSPORT,
  };
  const requestedMode = normalizeRequestedMode(params.get("transport") ?? env?.VITE_HONUA_INCIDENT_TRANSPORT);
  const fixtureOrigin = requestedMode === "fixture-edit" ? sanitizedPublicUrl(location.origin) : undefined;
  const demoBaseUrl = sanitizedPublicUrl(
    params.get("baseUrl") ?? env?.VITE_HONUA_INCIDENT_BASE_URL ?? fixtureOrigin ?? DEFAULT_DEMO_BASE_URL,
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
  let fixtureRunId: string | undefined;
  let fixtureControlUrl: string | undefined;
  if (requestedMode === "fixture-edit") {
    fixtureRunId = params.get("fixtureRun") ?? undefined;
    if (!fixtureRunId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fixtureRunId)) {
      throw new Error("Fixture-edit mode requires one explicit valid fixtureRun identifier.");
    }
    const expectedOrigin = new URL(fixtureOrigin ?? "").origin;
    for (const [description, endpoint] of [
      ["base", demoBaseUrl],
      ["stream", streamUrl],
      ["capabilities", capabilitiesUrl],
    ] as const) {
      if (new URL(endpoint).origin !== expectedOrigin) {
        throw new Error(`Fixture-edit ${description} endpoint must use the page's same origin.`);
      }
    }
    fixtureControlUrl = sanitizedPublicUrl(
      new URL(`/__fixture__/runs/${encodeURIComponent(fixtureRunId)}`, demoBaseUrl).toString(),
    );
    if (new URL(fixtureControlUrl).origin !== expectedOrigin) {
      throw new Error("Fixture-edit action endpoint must use the sanitized fixture origin.");
    }
  }
  return {
    requestedMode,
    demoBaseUrl,
    capabilitiesUrl,
    streamUrl,
    sourceIdentity: params.get("sourceId") ?? env?.VITE_HONUA_INCIDENT_SOURCE_ID ?? DEFAULT_SOURCE_ID,
    layerId: Number.isFinite(layerId) && layerId >= 0 ? layerId : DEFAULT_LAYER_ID,
    fixtureRunId,
    fixtureControlUrl,
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

export function createIncidentDashboardTransport(
  config: ResolvedIncidentTransportConfig,
  options: CreateIncidentDashboardTransportOptions = {},
): IncidentDashboardTransport {
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

  if (config.mode === "fixture-edit") {
    if (!config.fixtureRunId || !config.fixtureControlUrl) {
      throw new Error("Fixture-edit transport requires an explicit run and same-origin action endpoint.");
    }
    const streamUrl = new URL(config.streamUrl);
    if (streamUrl.origin !== new URL(config.fixtureControlUrl).origin) {
      throw new Error("Fixture-edit stream and action endpoints must share the sanitized fixture origin.");
    }
    streamUrl.searchParams.set("run", config.fixtureRunId);
    return {
      transport: createHonuaServerRealtimeSubscription<IncidentFeature>({
        url: streamUrl.toString(),
        decodeEvent: decodeIncidentServerEvent,
      }),
      controls: createRemoteFixtureIncidentTransportControls(config, options.fetchFn ?? globalThis.fetch),
      request: createIncidentRealtimeRequest(INCIDENT_SOURCE_ID, INCIDENT_LAYER_ID, config.mode),
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
  return {
    mode: config.mode,
    requestedMode: config.requestedMode,
    fallbackReason: config.fallbackReason,
    sourceIdentity: INCIDENT_SOURCE_ID,
    safeDemoEditing: false,
    authorized: false,
    step: async () => fixture.step(),
    reconnect: async () => fixture.reconnect(),
    resume: async () => fixture.resume(),
    refresh: async () => fixture.refresh(),
    duplicateLast: async () => fixture.duplicateLast(),
    staleCursor: async () => fixture.staleCursor(),
    edit: async (request) => fixture.edit(request),
    reset: async (request) => fixture.reset(request),
    simulateConcurrentUpdate: async () => fixture.simulateConcurrentUpdate(),
    dispose: () => undefined,
  };
}

function malformedActionResult(action: string): never {
  throw new Error(`Fixture action ${action} returned a malformed response.`);
}

function actionRecord(value: unknown, action: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformedActionResult(action);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformedActionResult(action);
  return value as Record<string, unknown>;
}

function exactActionKeys(record: Record<string, unknown>, allowed: readonly string[], action: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) malformedActionResult(action);
}

function actionString(value: unknown, action: string, maximum = 256): string {
  const containsControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || containsControlCharacter) {
    malformedActionResult(action);
  }
  return value;
}

function actionRevision(value: unknown, action: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformedActionResult(action);
  return value as number;
}

function decodeIncidentFeatureResult(value: unknown, action: string): IncidentFeature {
  const incident = actionRecord(value, action);
  const required = [
    "id",
    "title",
    "type",
    "severity",
    "status",
    "assignedTo",
    "updatedAt",
    "reportedAt",
    "coordinate",
    "etaMinutes",
    "affectedAssets",
    "summary",
    "relatedRecords",
    "attachments",
  ] as const;
  exactActionKeys(incident, [...required, "revision", "safeDemoRecord"], action);
  if (required.some((key) => !Object.hasOwn(incident, key))) malformedActionResult(action);
  for (const name of ["id", "title", "type", "assignedTo"] as const) actionString(incident[name], action, 160);
  actionString(incident.summary, action, 1_024);
  if (!(["critical", "high", "medium", "low"] as const).includes(incident.severity as never)) {
    malformedActionResult(action);
  }
  if (!(["open", "assigned", "monitoring", "resolved"] as const).includes(incident.status as never)) {
    malformedActionResult(action);
  }
  for (const name of ["updatedAt", "reportedAt"] as const) {
    const timestamp = actionString(incident[name], action, 64);
    if (!Number.isFinite(Date.parse(timestamp))) malformedActionResult(action);
  }
  if (
    !Array.isArray(incident.coordinate) ||
    incident.coordinate.length !== 2 ||
    !incident.coordinate.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    malformedActionResult(action);
  }
  for (const name of ["etaMinutes", "affectedAssets"] as const) {
    if (!Number.isSafeInteger(incident[name]) || (incident[name] as number) < 0) malformedActionResult(action);
  }
  if (!Array.isArray(incident.relatedRecords) || incident.relatedRecords.length > 128) malformedActionResult(action);
  for (const value of incident.relatedRecords) {
    const related = actionRecord(value, action);
    exactActionKeys(related, ["id", "label", "status"], action);
    for (const name of ["id", "label", "status"] as const) actionString(related[name], action, 160);
  }
  if (!Array.isArray(incident.attachments) || incident.attachments.length > 128) malformedActionResult(action);
  for (const value of incident.attachments) {
    const attachment = actionRecord(value, action);
    exactActionKeys(attachment, ["id", "name", "kind"], action);
    for (const name of ["id", "name", "kind"] as const) actionString(attachment[name], action, 160);
  }
  const revision = incident.revision;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
    malformedActionResult(action);
  }
  if (incident.safeDemoRecord !== undefined && typeof incident.safeDemoRecord !== "boolean") {
    malformedActionResult(action);
  }
  return incident as unknown as IncidentFeature;
}

function decodeStepResult(value: unknown): IncidentScenarioStep {
  const action = "step";
  const result = actionRecord(value, action);
  exactActionKeys(result, ["label", "kind", "event"], action);
  const label = actionString(result.label, action, 160);
  if (result.kind !== "upsert" && result.kind !== "delete") malformedActionResult(action);
  if (result.event === undefined) {
    return { label, description: "Shared harness scenario action.", kind: result.kind };
  }
  let event: RealtimeFeatureEvent<IncidentFeature>;
  try {
    event = decodeIncidentServerEvent(result.event);
  } catch {
    malformedActionResult(action);
  }
  if (event.type !== result.kind) malformedActionResult(action);
  if (event.sequence !== undefined && (!Number.isSafeInteger(event.sequence) || event.sequence < 0)) {
    malformedActionResult(action);
  }
  if (event.receivedAt !== undefined && !Number.isFinite(event.receivedAt)) malformedActionResult(action);
  if (event.type === "upsert") {
    const patch = actionRecord(event.feature, action);
    const incident = decodeIncidentFeatureResult(patch.feature, action);
    if (actionString(patch.id, action, 64) !== incident.id) malformedActionResult(action);
    return {
      label,
      description: "Shared harness scenario action.",
      kind: "upsert",
      incident,
      id: incident.id,
    };
  }
  const id = actionString(event.id, action, 64);
  return { label, description: "Shared harness scenario action.", kind: "delete", id };
}

function decodeActionAcknowledgement(value: unknown, action: string, property: string, allowFalse = false): void {
  const result = actionRecord(value, action);
  exactActionKeys(result, action === "refresh" ? [property, "event"] : [property], action);
  if (allowFalse ? typeof result[property] !== "boolean" : result[property] !== true) malformedActionResult(action);
}

function decodeEditReceipt(
  value: unknown,
  request: IncidentEditRequest | IncidentResetRequest,
  operation: "edit" | "reset",
): IncidentEditReceipt {
  const action = operation === "edit" ? "edit" : "reset-edit";
  const result = actionRecord(value, action);
  exactActionKeys(
    result,
    ["outcome", "operation", "idempotencyKey", "incident", "expectedRevision", "actualRevision", "reason", "code"],
    action,
  );
  const allowedOutcomes =
    operation === "edit"
      ? (["applied", "duplicate", "conflict", "blocked"] as const)
      : (["reset", "duplicate", "conflict", "blocked"] as const);
  if (!allowedOutcomes.includes(result.outcome as never) || result.operation !== operation) {
    malformedActionResult(action);
  }
  const idempotencyKey = actionString(result.idempotencyKey, action, 128);
  if (idempotencyKey !== request.idempotencyKey) malformedActionResult(action);
  const reason = actionString(result.reason, action, 512);
  const expectedRevision = actionRevision(result.expectedRevision, action);
  const actualRevision = actionRevision(result.actualRevision, action);
  if (
    operation === "edit" &&
    expectedRevision !== undefined &&
    expectedRevision !== (request as IncidentEditRequest).expectedRevision
  ) {
    malformedActionResult(action);
  }
  if (result.code !== undefined) actionString(result.code, action, 64);
  const incident = result.incident === undefined ? undefined : decodeIncidentFeatureResult(result.incident, action);
  if (incident && (incident.id !== request.incidentId || incident.safeDemoRecord !== true)) {
    malformedActionResult(action);
  }
  const committedOutcome = ["applied", "reset", "duplicate"].includes(result.outcome as string);
  if (committedOutcome) {
    if (
      !incident ||
      incident.revision === undefined ||
      actualRevision === undefined ||
      incident.revision !== actualRevision
    ) {
      malformedActionResult(action);
    }
    if (operation === "edit" && expectedRevision !== (request as IncidentEditRequest).expectedRevision) {
      malformedActionResult(action);
    }
  } else if (incident?.revision !== undefined && actualRevision !== undefined && incident.revision !== actualRevision) {
    malformedActionResult(action);
  }
  return {
    outcome: result.outcome as IncidentEditReceipt["outcome"],
    operation,
    idempotencyKey,
    reason,
    ...(incident ? { incident } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}

function decodeConcurrentEditResult(value: unknown): IncidentFeature {
  const action = "concurrent-edit";
  const result = actionRecord(value, action);
  exactActionKeys(result, ["incident"], action);
  const incident = decodeIncidentFeatureResult(result.incident, action);
  if (incident.id !== SAFE_DEMO_INCIDENT_ID || incident.safeDemoRecord !== true || incident.revision === undefined) {
    malformedActionResult(action);
  }
  return incident;
}

function createRemoteFixtureIncidentTransportControls(
  config: ResolvedIncidentTransportConfig,
  fetchFn: typeof fetch,
): IncidentTransportControls {
  const controlUrl = config.fixtureControlUrl;
  if (!controlUrl || !config.fixtureRunId) throw new Error("Fixture-edit controls require an explicit fixture run.");
  const controlOrigin = new URL(controlUrl).origin;
  if (controlOrigin !== new URL(config.demoBaseUrl).origin || controlOrigin !== new URL(config.streamUrl).origin) {
    throw new Error("Fixture-edit action endpoint must remain on the sanitized fixture origin.");
  }
  const controller = new AbortController();
  let disposed = false;

  async function action(name: string, body: object = {}): Promise<unknown> {
    if (disposed) throw new DOMException("Fixture-edit controls are disposed.", "AbortError");
    const actionUrl = new URL(`${controlUrl}/actions/${name}`);
    if (actionUrl.origin !== controlOrigin)
      throw new Error("Fixture-edit action escaped the sanitized fixture origin.");
    const response = await fetchFn(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result: unknown = await response.json().catch(() => undefined);
    const domainConflict =
      response.status === 409 &&
      (name === "edit" || name === "reset-edit") &&
      typeof result === "object" &&
      result !== null;
    if ((!response.ok && !domainConflict) || result === undefined) {
      throw new Error(`Fixture action ${name} failed with HTTP ${response.status}.`);
    }
    return result;
  }

  return {
    mode: "fixture-edit",
    requestedMode: config.requestedMode,
    sourceIdentity: SAFE_DEMO_EDIT_SOURCE_ID,
    safeDemoEditing: true,
    authorized: true,
    async step() {
      return decodeStepResult(await action("step"));
    },
    async reconnect() {
      decodeActionAcknowledgement(await action("reconnect"), "reconnect", "reconnecting");
    },
    async resume() {
      decodeActionAcknowledgement(await action("resume"), "resume", "resumed");
    },
    async refresh() {
      decodeActionAcknowledgement(await action("refresh"), "refresh", "refreshed");
    },
    async duplicateLast() {
      decodeActionAcknowledgement(await action("duplicate-event"), "duplicate-event", "duplicated", true);
    },
    async staleCursor() {
      decodeActionAcknowledgement(await action("stale-cursor"), "stale-cursor", "staleCursorInjected");
    },
    edit: async (request) => decodeEditReceipt(await action("edit", request), request, "edit"),
    reset: async (request) => decodeEditReceipt(await action("reset-edit", request), request, "reset"),
    async simulateConcurrentUpdate() {
      return decodeConcurrentEditResult(await action("concurrent-edit"));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
    },
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
    step: async () => undefined,
    reconnect: async () => undefined,
    resume: async () => undefined,
    refresh: async () => undefined,
    duplicateLast: async () => undefined,
    staleCursor: async () => undefined,
    edit: async (request) => blocked("edit", request.idempotencyKey),
    reset: async (request) => blocked("reset", request.idempotencyKey),
    simulateConcurrentUpdate: async () => undefined,
    dispose: () => undefined,
  };
}

function normalizeRequestedMode(value: string | undefined): IncidentRequestedTransportMode {
  if (value === "fixture" || value === "fixture-edit") return "fixture-edit";
  if (value === "replay") return "replay";
  if (value === "cloud" || value === "live") return "live";
  return "auto";
}

function normalizeQueryKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSensitiveQueryKey(name: string): boolean {
  const normalized = normalizeQueryKey(name);
  return [...SENSITIVE_QUERY_KEY_TOKENS].some(
    (candidate) => normalized === candidate || normalized.endsWith(`_${candidate}`),
  );
}

function sanitizedPublicUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Incident endpoint must use HTTP(S).");
  if (url.username || url.password) throw new Error("Incident endpoint must not contain credentials.");
  for (const key of url.searchParams.keys()) {
    if (isSensitiveQueryKey(key)) {
      throw new Error("Incident endpoint must not contain credential query parameters.");
    }
  }
  url.hash = "";
  return url.href.replace(/\/$/, "");
}
