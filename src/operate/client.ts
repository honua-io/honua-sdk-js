import { honuaCacheValidatorFromHeaders } from "../core/cache-state.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaHttpError } from "../core/errors.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import type { QueryMethod } from "../core/types.js";
import {
  HONUA_OPERATE_BASE_PATH,
  type HonuaAlert,
  type HonuaAlertActionRequest,
  type HonuaAlertRule,
  type HonuaAlertRuleTestResult,
  type HonuaAlertRuleWriteRequest,
  type HonuaGeofenceZone,
  type HonuaGeofenceZoneWriteRequest,
  type HonuaInvestigation,
  type HonuaInvestigationCreateRequest,
  type HonuaInvestigationPinRequest,
  type HonuaJobActionRequest,
  type HonuaJobArtifact,
  type HonuaJobLog,
  type HonuaJobRunDetail,
  type HonuaJobRunSummary,
  type HonuaLogRecord,
  type HonuaObservabilityTarget,
  type HonuaOperateCapability,
  type HonuaOperateListOptions,
  type HonuaOperatePage,
  type HonuaOperateRawRequest,
  type HonuaOperateRequestOptions,
  type HonuaOperateResult,
  type HonuaOperationalEvent,
  type HonuaProblemDetails,
  type HonuaServerTelemetryStatus,
} from "./types.js";

export interface HonuaOperateClientOptions {
  readonly client: HonuaClient;
  readonly basePath?: string;
}

export function createHonuaOperate(options: HonuaOperateClientOptions): HonuaOperateClient {
  return new HonuaOperateClient(options);
}

/**
 * Experimental Operate observability client.
 *
 * Exposes telemetry status, the event/log viewers, alerts and realtime alert
 * rules, geofence zones, investigations, and the job viewer over `/api/v1/operate`.
 * Missing providers degrade to typed {@link HonuaOperateUnsupported} results.
 */
export class HonuaOperateClient {
  readonly #client: HonuaClient;
  readonly #basePath: string;

  public readonly telemetry: HonuaTelemetryClient;
  public readonly events: HonuaEventsClient;
  public readonly logs: HonuaLogsClient;
  public readonly alerts: HonuaAlertsClient;
  public readonly alertRules: HonuaAlertRulesClient;
  public readonly geofences: HonuaGeofencesClient;
  public readonly investigations: HonuaInvestigationsClient;
  public readonly jobs: HonuaJobsClient;

  public constructor(options: HonuaOperateClientOptions) {
    this.#client = options.client;
    this.#basePath = normalizeBasePath(options.basePath ?? HONUA_OPERATE_BASE_PATH);
    this.telemetry = new HonuaTelemetryClient(this);
    this.events = new HonuaEventsClient(this);
    this.logs = new HonuaLogsClient(this);
    this.alerts = new HonuaAlertsClient(this);
    this.alertRules = new HonuaAlertRulesClient(this);
    this.geofences = new HonuaGeofencesClient(this);
    this.investigations = new HonuaInvestigationsClient(this);
    this.jobs = new HonuaJobsClient(this);
  }

  public get basePath(): string {
    return this.#basePath;
  }

  public async raw<T = unknown>(request: HonuaOperateRawRequest): Promise<HonuaOperateResult<T>> {
    return this.requestJson<T>("raw", request.method ?? "GET", request.path, request.body, {
      signal: request.signal,
      headers: request.headers,
      okStatuses: request.okStatuses,
    });
  }

  public async requestJson<T>(
    capability: HonuaOperateCapability,
    method: QueryMethod,
    path: string,
    body?: unknown,
    options: HonuaOperateRequestOptions & { okStatuses?: readonly number[] } = {},
  ): Promise<HonuaOperateResult<T>> {
    try {
      const response = await this.#client.pipelineFetch(
        method,
        this.resolvePath(path),
        {
          headers: jsonHeaders(options.headers),
          body: body === undefined ? null : JSON.stringify(body),
        },
        options.signal,
        options.okStatuses ? { okStatuses: options.okStatuses } : {},
      );
      if (response.status === 204) return supported(undefined as T);
      const value = (await readJson(response)) as T;
      return supported(value);
    } catch (error) {
      return unsupportedFromError(capability, error);
    }
  }

  public async requestPage<T>(
    capability: HonuaOperateCapability,
    path: string,
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<T>>> {
    try {
      const hasValidator = Boolean(options.validator?.etag || options.validator?.lastModified);
      const response = await this.#client.pipelineFetch(
        "GET",
        this.resolvePath(withListQuery(path, options)),
        { headers: listHeaders(options) },
        options.signal,
        { okStatuses: hasValidator ? [304, 404, 501] : [404, 501] },
      );
      if (response.status === 404 || response.status === 501) {
        return unsupportedFromStatus(capability, response.status, await readJson(response));
      }
      const value = normalizePage<T>(response.status === 304 ? undefined : await readJson(response), response, {
        fallbackValidator: options.validator,
      });
      return supported(value);
    } catch (error) {
      return unsupportedFromError(capability, error);
    }
  }

  public resolvePath(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized === this.#basePath || normalized.startsWith(`${this.#basePath}/`)) return normalized;
    return `${this.#basePath}${normalized}`;
  }
}

export class HonuaTelemetryClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public listTargets(
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<HonuaObservabilityTarget>>> {
    return this.#operate.requestPage("telemetry", "/targets", options);
  }

  public status(
    targetId: string,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaServerTelemetryStatus>> {
    return this.#operate.requestJson(
      "telemetry",
      "GET",
      `/targets/${encodeURIComponent(targetId)}/telemetry`,
      undefined,
      options,
    );
  }
}

export class HonuaEventsClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public query(
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<HonuaOperationalEvent>>> {
    return this.#operate.requestPage("events", "/events", options);
  }
}

export class HonuaLogsClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public query(options: HonuaOperateListOptions = {}): Promise<HonuaOperateResult<HonuaOperatePage<HonuaLogRecord>>> {
    return this.#operate.requestPage("logs", "/logs", options);
  }
}

export class HonuaAlertsClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public query(options: HonuaOperateListOptions = {}): Promise<HonuaOperateResult<HonuaOperatePage<HonuaAlert>>> {
    return this.#operate.requestPage("alerts", "/alerts", options);
  }

  public get(alertId: string, options: HonuaOperateRequestOptions = {}): Promise<HonuaOperateResult<HonuaAlert>> {
    return this.#operate.requestJson("alerts", "GET", `/alerts/${encodeURIComponent(alertId)}`, undefined, options);
  }

  public act(
    alertId: string,
    request: HonuaAlertActionRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaAlert>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson("alerts", "POST", `/alerts/${encodeURIComponent(alertId)}/actions`, body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }
}

export class HonuaAlertRulesClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public list(options: HonuaOperateListOptions = {}): Promise<HonuaOperateResult<HonuaOperatePage<HonuaAlertRule>>> {
    return this.#operate.requestPage("alert-rules", "/alert-rules", options);
  }

  public get(ruleId: string, options: HonuaOperateRequestOptions = {}): Promise<HonuaOperateResult<HonuaAlertRule>> {
    return this.#operate.requestJson(
      "alert-rules",
      "GET",
      `/alert-rules/${encodeURIComponent(ruleId)}`,
      undefined,
      options,
    );
  }

  public create(
    request: HonuaAlertRuleWriteRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaAlertRule>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson("alert-rules", "POST", "/alert-rules", body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }

  public update(
    ruleId: string,
    request: HonuaAlertRuleWriteRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaAlertRule>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson("alert-rules", "PUT", `/alert-rules/${encodeURIComponent(ruleId)}`, body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }

  public delete(ruleId: string, options: HonuaOperateRequestOptions = {}): Promise<HonuaOperateResult<void>> {
    return this.#operate.requestJson("alert-rules", "DELETE", `/alert-rules/${encodeURIComponent(ruleId)}`, undefined, {
      ...options,
      okStatuses: [204],
    });
  }

  public test(
    ruleId: string,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaAlertRuleTestResult>> {
    return this.#operate.requestJson(
      "alert-rules",
      "POST",
      `/alert-rules/${encodeURIComponent(ruleId)}/test`,
      {},
      options,
    );
  }
}

export class HonuaGeofencesClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public list(options: HonuaOperateListOptions = {}): Promise<HonuaOperateResult<HonuaOperatePage<HonuaGeofenceZone>>> {
    return this.#operate.requestPage("geofences", "/geofences", options);
  }

  public get(zoneId: string, options: HonuaOperateRequestOptions = {}): Promise<HonuaOperateResult<HonuaGeofenceZone>> {
    return this.#operate.requestJson(
      "geofences",
      "GET",
      `/geofences/${encodeURIComponent(zoneId)}`,
      undefined,
      options,
    );
  }

  public create(
    request: HonuaGeofenceZoneWriteRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaGeofenceZone>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson("geofences", "POST", "/geofences", body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }

  public update(
    zoneId: string,
    request: HonuaGeofenceZoneWriteRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaGeofenceZone>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson("geofences", "PUT", `/geofences/${encodeURIComponent(zoneId)}`, body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }

  public delete(zoneId: string, options: HonuaOperateRequestOptions = {}): Promise<HonuaOperateResult<void>> {
    return this.#operate.requestJson("geofences", "DELETE", `/geofences/${encodeURIComponent(zoneId)}`, undefined, {
      ...options,
      okStatuses: [204],
    });
  }
}

export class HonuaInvestigationsClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public list(
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<HonuaInvestigation>>> {
    return this.#operate.requestPage("investigations", "/investigations", options);
  }

  public get(
    investigationId: string,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaInvestigation>> {
    return this.#operate.requestJson(
      "investigations",
      "GET",
      `/investigations/${encodeURIComponent(investigationId)}`,
      undefined,
      options,
    );
  }

  public create(
    request: HonuaInvestigationCreateRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaInvestigation>> {
    return this.#operate.requestJson("investigations", "POST", "/investigations", request, options);
  }

  public pin(
    investigationId: string,
    request: HonuaInvestigationPinRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaInvestigation>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson(
      "investigations",
      "POST",
      `/investigations/${encodeURIComponent(investigationId)}/pins`,
      body,
      { ...options, headers: withIfMatch(options.headers, ifMatch) },
    );
  }
}

export class HonuaJobsClient {
  readonly #operate: HonuaOperateClient;

  public constructor(operate: HonuaOperateClient) {
    this.#operate = operate;
  }

  public query(
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<HonuaJobRunSummary>>> {
    return this.#operate.requestPage("jobs", "/jobs", options);
  }

  public get(jobId: string, options: HonuaOperateRequestOptions = {}): Promise<HonuaOperateResult<HonuaJobRunDetail>> {
    return this.#operate.requestJson("jobs", "GET", `/jobs/${encodeURIComponent(jobId)}`, undefined, options);
  }

  public logs(
    jobId: string,
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<HonuaJobLog>>> {
    return this.#operate.requestPage("jobs", `/jobs/${encodeURIComponent(jobId)}/logs`, options);
  }

  public artifacts(
    jobId: string,
    options: HonuaOperateListOptions = {},
  ): Promise<HonuaOperateResult<HonuaOperatePage<HonuaJobArtifact>>> {
    return this.#operate.requestPage("jobs", `/jobs/${encodeURIComponent(jobId)}/artifacts`, options);
  }

  public act(
    jobId: string,
    request: HonuaJobActionRequest,
    options: HonuaOperateRequestOptions = {},
  ): Promise<HonuaOperateResult<HonuaJobRunDetail>> {
    const { ifMatch, ...body } = request;
    return this.#operate.requestJson("jobs", "POST", `/jobs/${encodeURIComponent(jobId)}/actions`, body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBasePath(basePath: string): string {
  const normalized = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return trimTrailingSlashes(normalized);
}

function supported<T>(value: T): HonuaOperateResult<T> {
  return { supported: true, value };
}

function unsupportedFromError<T>(capability: HonuaOperateCapability, error: unknown): HonuaOperateResult<T> {
  if (error instanceof HonuaHttpError && (error.statusCode === 404 || error.statusCode === 501)) {
    return unsupportedFromStatus(capability, error.statusCode, error.body);
  }
  throw error;
}

function unsupportedFromStatus<T>(
  capability: HonuaOperateCapability,
  statusCode: number,
  body: unknown,
): HonuaOperateResult<T> {
  const problem = toProblemDetails(body);
  return {
    supported: false,
    capability,
    statusCode,
    reason:
      problem?.detail ?? problem?.title ?? `Operate capability "${capability}" is not available on this deployment.`,
    ...(problem ? { problem } : {}),
  };
}

function withListQuery(path: string, options: HonuaOperateListOptions): string {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.targetId) params.set("targetId", options.targetId);
  if (options.q) params.set("q", options.q);
  if (options.since) params.set("since", options.since);
  if (options.until) params.set("until", options.until);
  const query = params.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

function jsonHeaders(headers: HeadersInit | undefined): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...headersToRecord(headers),
  };
}

function listHeaders(options: HonuaOperateListOptions): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...headersToRecord(options.headers),
  };
  if (options.validator?.etag) headers["If-None-Match"] = options.validator.etag;
  if (options.validator?.lastModified) headers["If-Modified-Since"] = options.validator.lastModified;
  return headers;
}

function withIfMatch(headers: HeadersInit | undefined, ifMatch: string | undefined): HeadersInit | undefined {
  if (!ifMatch) return headers;
  return { ...headersToRecord(headers), "If-Match": ifMatch };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  return JSON.parse(text);
}

function normalizePage<T>(
  body: unknown,
  response: Response,
  options: { readonly fallbackValidator?: HonuaOperateListOptions["validator"] } = {},
): HonuaOperatePage<T> {
  const value = isRecord(body) ? body : {};
  const items = (Array.isArray(value.items) ? value.items : Array.isArray(value.data) ? value.data : []) as T[];
  const pagination = isRecord(value.pagination) ? value.pagination : value;
  const validator = honuaCacheValidatorFromHeaders(response.headers) ?? options.fallbackValidator;
  const sourceUpdatedAt = response.headers.get("last-modified") ?? undefined;
  return {
    items,
    pagination: {
      nextCursor: stringValue(pagination.nextCursor ?? pagination.next),
      previousCursor: stringValue(pagination.previousCursor ?? pagination.previous),
      limit: numberValue(pagination.limit),
      total: numberValue(pagination.total),
    },
    ...(validator ? { validator } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

function toProblemDetails(body: unknown): HonuaProblemDetails | undefined {
  if (!isRecord(body)) return undefined;
  const candidate = isRecord(body.problem) ? body.problem : body;
  return candidate as HonuaProblemDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
