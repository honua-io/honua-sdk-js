import type { HonuaCacheValidator } from "../core/cache-state.js";
import type { QueryMethod } from "../core/types.js";

/**
 * Operate observability SDK contracts.
 *
 * Shared, protocol-neutral shapes for the Console / MCP / Studio "Operate"
 * surfaces: server telemetry status, operational events, logs, alerts, realtime
 * alert rules, geofence zones, delivery channel bindings, investigations, and the
 * job viewer (runs, stages, logs, artifacts).
 *
 * These mirror honua-server#1168 / #1169 / #1170 and are designed so fixture data
 * can drive Console Operate screens before live endpoints land. Capability gaps
 * are represented as typed degraded results (see {@link HonuaOperateUnsupported})
 * rather than thrown errors, and action availability is carried explicitly by the
 * resource state/policy rather than inferred by the UI.
 *
 * @module
 */

export const HONUA_OPERATE_BASE_PATH = "/api/v1/operate" as const;

/**
 * Observability sub-capabilities a deployment may or may not provide.
 * Absent providers are surfaced as {@link HonuaOperateUnsupported} so clients can
 * disable the matching Console panel instead of rendering empty data.
 */
export type HonuaOperateCapability =
  | "telemetry"
  | "events"
  | "logs"
  | "metrics"
  | "alerts"
  | "alert-rules"
  | "geofences"
  | "delivery-channels"
  | "investigations"
  | "jobs"
  | "raw";

export interface HonuaProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code?: string;
  readonly errors?: Record<string, readonly string[]>;
  readonly [extra: string]: unknown;
}

export interface HonuaOperateUnsupported {
  readonly supported: false;
  readonly capability: HonuaOperateCapability;
  readonly statusCode?: number;
  readonly reason: string;
  readonly problem?: HonuaProblemDetails;
}

export interface HonuaOperateSuccess<T> {
  readonly supported: true;
  readonly value: T;
}

export type HonuaOperateResult<T> = HonuaOperateSuccess<T> | HonuaOperateUnsupported;

export interface HonuaOperateRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

export interface HonuaOperateListOptions extends HonuaOperateRequestOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly targetId?: string;
  readonly q?: string;
  readonly since?: string;
  readonly until?: string;
  readonly refresh?: boolean;
  readonly validator?: HonuaCacheValidator;
}

export interface HonuaOperatePage<T> {
  readonly items: readonly T[];
  readonly pagination: {
    readonly nextCursor?: string;
    readonly previousCursor?: string;
    readonly limit?: number;
    readonly total?: number;
  };
  readonly validator?: HonuaCacheValidator;
  readonly sourceUpdatedAt?: string;
}

export interface HonuaOperateEntityValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

/** Hyperlinks attached to Operate resources for follow-on navigation. */
export interface HonuaOperateLinks {
  readonly self?: string;
  readonly logs?: string;
  readonly artifacts?: string;
  readonly stages?: string;
  readonly investigation?: string;
  readonly alert?: string;
  readonly rule?: string;
  readonly [rel: string]: string | undefined;
}

// ---------------------------------------------------------------------------
// Observability target + telemetry status
// ---------------------------------------------------------------------------

/** A monitored unit (server, deployment, region) the Operate surfaces report on. */
export interface HonuaObservabilityTarget extends HonuaOperateEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly kind: "server" | "deployment" | "region" | "cluster" | (string & {});
  readonly environment?: "production" | "staging" | "development" | (string & {});
  readonly region?: string;
  readonly labels?: Record<string, string>;
  readonly links?: HonuaOperateLinks;
  readonly [extra: string]: unknown;
}

export type HonuaTelemetryHealth = "healthy" | "degraded" | "unhealthy" | "unknown" | (string & {});

/** Provider availability for a target. `enabled: false` means telemetry is off, not failing. */
export interface HonuaTelemetryProviderStatus {
  readonly id: string;
  readonly kind: "otlp" | "logs" | "metrics" | "alerts" | "jobs" | (string & {});
  readonly enabled: boolean;
  readonly connected?: boolean;
  readonly detail?: string;
  readonly lastSeenAt?: string;
}

export interface HonuaServerTelemetryStatus extends HonuaOperateEntityValidators {
  readonly targetId: string;
  readonly health: HonuaTelemetryHealth;
  /** True when an OTLP/telemetry pipeline is configured and active for the target. */
  readonly telemetryEnabled: boolean;
  readonly version?: string;
  readonly uptimeSeconds?: number;
  readonly startedAt?: string;
  readonly observedAt?: string;
  readonly providers?: readonly HonuaTelemetryProviderStatus[];
  readonly metrics?: readonly HonuaMetricSnapshot[];
  readonly message?: string;
  readonly problem?: HonuaProblemDetails;
  readonly [extra: string]: unknown;
}

export interface HonuaMetricSnapshot {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly observedAt?: string;
  readonly labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Operational events vs audit events
// ---------------------------------------------------------------------------

export type HonuaOperationalEventSeverity = "info" | "notice" | "warning" | "error" | "critical" | (string & {});

/**
 * An operational event in the event viewer. The {@link HonuaOperationalEvent.category}
 * discriminates `audit` events from operational ones so the UI never conflates them.
 */
export interface HonuaOperationalEvent {
  readonly id: string;
  readonly targetId?: string;
  readonly category: "operational" | "audit" | "security" | (string & {});
  readonly type: string;
  readonly severity: HonuaOperationalEventSeverity;
  readonly summary: string;
  readonly detail?: string;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly resource?: string;
  readonly correlationId?: string;
  readonly attributes?: Record<string, unknown>;
  readonly links?: HonuaOperateLinks;
}

export type HonuaLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | (string & {});

/** A single structured log line. Distinct from {@link HonuaOperationalEvent} audit records. */
export interface HonuaLogRecord {
  readonly id: string;
  readonly targetId?: string;
  readonly level: HonuaLogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly source?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly jobId?: string;
  readonly attributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type HonuaAlertSeverity = "info" | "warning" | "error" | "critical" | (string & {});
export type HonuaAlertStatus = "firing" | "acknowledged" | "resolved" | "suppressed" | (string & {});

/** Actions a viewer may take on an alert; presence reflects state + policy, not the UI's guess. */
export type HonuaAlertAction = "acknowledge" | "resolve" | "suppress" | "unsuppress" | "escalate" | (string & {});

export interface HonuaAlert extends HonuaOperateEntityValidators {
  readonly id: string;
  readonly targetId?: string;
  readonly ruleId?: string;
  readonly title: string;
  readonly description?: string;
  readonly severity: HonuaAlertSeverity;
  readonly status: HonuaAlertStatus;
  readonly firedAt: string;
  readonly updatedAt?: string;
  readonly resolvedAt?: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedBy?: string;
  /** When `status === "suppressed"`, the reason/window the suppression was applied for. */
  readonly suppression?: {
    readonly reason?: string;
    readonly until?: string;
    readonly by?: string;
  };
  /** Outcome of the most recent delivery attempt across bound channels. */
  readonly delivery?: HonuaAlertDeliveryStatus;
  /** Actions currently permitted for this alert given its state and the caller's policy. */
  readonly availableActions: readonly HonuaAlertAction[];
  readonly labels?: Record<string, string>;
  readonly links?: HonuaOperateLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaAlertDeliveryStatus {
  readonly state: "pending" | "delivered" | "failed" | "not-configured" | (string & {});
  readonly channelId?: string;
  readonly attemptedAt?: string;
  readonly error?: HonuaProblemDetails;
}

export interface HonuaAlertActionRequest {
  readonly action: HonuaAlertAction;
  readonly reason?: string;
  /** For `suppress`: how long the suppression should last. */
  readonly suppressUntil?: string;
  readonly ifMatch?: string;
}

// ---------------------------------------------------------------------------
// Realtime alert rules + geofence zones + delivery channels
// ---------------------------------------------------------------------------

export type HonuaAlertRuleKind = "threshold" | "rate" | "absence" | "geofence" | (string & {});

export interface HonuaAlertRule extends HonuaOperateEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly kind: HonuaAlertRuleKind;
  readonly enabled: boolean;
  readonly targetId?: string;
  readonly description?: string;
  readonly severity?: HonuaAlertSeverity;
  /** True when the rule is evaluated against a live stream rather than batched. */
  readonly realtime: boolean;
  readonly expression?: string;
  readonly geofenceZoneId?: string;
  readonly windowSeconds?: number;
  readonly threshold?: number;
  /** Delivery channel bindings this rule fires through, with per-binding errors. */
  readonly channelBindings?: readonly HonuaDeliveryChannelBinding[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly links?: HonuaOperateLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaAlertRuleWriteRequest {
  readonly name: string;
  readonly kind: HonuaAlertRuleKind;
  readonly enabled?: boolean;
  readonly targetId?: string;
  readonly description?: string;
  readonly severity?: HonuaAlertSeverity;
  readonly realtime?: boolean;
  readonly expression?: string;
  readonly geofenceZoneId?: string;
  readonly windowSeconds?: number;
  readonly threshold?: number;
  readonly channelIds?: readonly string[];
  readonly ifMatch?: string;
}

/** Result of a dry-run rule evaluation; no alert is persisted. */
export interface HonuaAlertRuleTestResult {
  readonly matched: boolean;
  readonly evaluatedAt: string;
  readonly observedValue?: number;
  readonly sampleEventIds?: readonly string[];
  readonly message?: string;
  readonly problem?: HonuaProblemDetails;
}

/** A polygon/circle geofence zone an alert rule of kind `geofence` references. */
export interface HonuaGeofenceZone extends HonuaOperateEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: "enter" | "exit" | "dwell" | (string & {});
  /** GeoJSON Polygon/MultiPolygon geometry, kept opaque to avoid a geometry dep here. */
  readonly geometry: Record<string, unknown>;
  readonly dwellSeconds?: number;
  readonly description?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly links?: HonuaOperateLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaGeofenceZoneWriteRequest {
  readonly name: string;
  readonly enabled?: boolean;
  readonly trigger: "enter" | "exit" | "dwell" | (string & {});
  readonly geometry: Record<string, unknown>;
  readonly dwellSeconds?: number;
  readonly description?: string;
  readonly ifMatch?: string;
}

/** Binding of an alert rule to a delivery channel, carrying the last delivery error if any. */
export interface HonuaDeliveryChannelBinding {
  readonly channelId: string;
  readonly kind: "email" | "webhook" | "slack" | "pagerduty" | "sms" | (string & {});
  readonly enabled: boolean;
  readonly target?: string;
  readonly lastDeliveryState?: HonuaAlertDeliveryStatus["state"];
  readonly lastError?: HonuaProblemDetails;
}

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

export interface HonuaInvestigation extends HonuaOperateEntityValidators {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "investigating" | "resolved" | "closed" | (string & {});
  readonly summary?: string;
  readonly targetId?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly createdBy?: string;
  readonly pinnedItemIds?: readonly string[];
  readonly timeline?: readonly HonuaInvestigationTimelineEntry[];
  readonly links?: HonuaOperateLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaInvestigationTimelineEntry {
  readonly id: string;
  readonly kind: "note" | "event" | "alert" | "log" | "job" | (string & {});
  readonly at: string;
  readonly summary: string;
  readonly refId?: string;
  readonly pinned?: boolean;
  readonly author?: string;
}

export interface HonuaInvestigationCreateRequest {
  readonly title: string;
  readonly summary?: string;
  readonly targetId?: string;
  readonly seedItemIds?: readonly string[];
}

export interface HonuaInvestigationPinRequest {
  readonly itemId: string;
  readonly pinned: boolean;
  readonly ifMatch?: string;
}

// ---------------------------------------------------------------------------
// Job viewer
// ---------------------------------------------------------------------------

export type HonuaJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "retrying" | (string & {});

/** Job lifecycle controls; availability is state/policy-driven, never inferred by the UI. */
export type HonuaJobAction = "cancel" | "retry" | "rerun" | "pause" | "resume" | (string & {});

export interface HonuaJobRunSummary extends HonuaOperateEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly targetId?: string;
  readonly state: HonuaJobState;
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly progress?: {
    readonly completed?: number;
    readonly total?: number;
    readonly message?: string;
  };
  /** Actions currently permitted for this run given its state and the caller's policy. */
  readonly availableActions: readonly HonuaJobAction[];
  readonly problem?: HonuaProblemDetails;
  readonly links?: HonuaOperateLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaJobRunDetail extends HonuaJobRunSummary {
  readonly stages?: readonly HonuaJobStage[];
  readonly artifacts?: readonly HonuaJobArtifact[];
  readonly parameters?: Record<string, unknown>;
  readonly triggeredBy?: string;
  /** Id of the prior run this run retried, when `state === "retrying"` or after a retry. */
  readonly retryOfRunId?: string;
}

export interface HonuaJobStage {
  readonly id: string;
  readonly name: string;
  readonly state: HonuaJobState;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly message?: string;
  readonly problem?: HonuaProblemDetails;
}

export interface HonuaJobLog {
  readonly id: string;
  readonly jobId: string;
  readonly stageId?: string;
  readonly level: HonuaLogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly attributes?: Record<string, unknown>;
}

export interface HonuaJobArtifact {
  readonly id: string;
  readonly jobId: string;
  readonly name: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly createdAt?: string;
  readonly href?: string;
  readonly checksum?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HonuaJobActionRequest {
  readonly action: HonuaJobAction;
  readonly reason?: string;
  readonly ifMatch?: string;
}

// ---------------------------------------------------------------------------
// Raw escape hatch
// ---------------------------------------------------------------------------

export interface HonuaOperateRawRequest extends HonuaOperateRequestOptions {
  readonly method?: QueryMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly okStatuses?: readonly number[];
}
