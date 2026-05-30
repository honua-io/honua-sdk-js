/**
 * Experimental Operate observability client and contracts.
 *
 * Shared, protocol-neutral SDK surface for the Console / MCP / Studio "Operate"
 * screens: server telemetry status, the event and log viewers, alerts and
 * realtime alert rules, geofence zones, delivery channel bindings,
 * investigations, and the job viewer (runs, stages, logs, artifacts).
 *
 * Designed so fixture data can drive Console Operate screens before live
 * endpoints land. Missing providers (no OTLP, no logs, no realtime, no alert
 * delivery, no job controls, no investigation store) degrade to typed
 * {@link HonuaOperateUnsupported} results instead of empty data or thrown errors.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HonuaAlertRulesClient,
  HonuaAlertsClient,
  HonuaEventsClient,
  HonuaGeofencesClient,
  HonuaInvestigationsClient,
  HonuaJobsClient,
  HonuaLogsClient,
  HonuaOperateClient,
  HonuaTelemetryClient,
  createHonuaOperate,
} from "./client.js";
export type { HonuaOperateClientOptions } from "./client.js";
export { HONUA_OPERATE_BASE_PATH } from "./types.js";
export type {
  HonuaAlert,
  HonuaAlertAction,
  HonuaAlertActionRequest,
  HonuaAlertDeliveryStatus,
  HonuaAlertRule,
  HonuaAlertRuleKind,
  HonuaAlertRuleTestResult,
  HonuaAlertRuleWriteRequest,
  HonuaAlertSeverity,
  HonuaAlertStatus,
  HonuaDeliveryChannelBinding,
  HonuaGeofenceZone,
  HonuaGeofenceZoneWriteRequest,
  HonuaInvestigation,
  HonuaInvestigationCreateRequest,
  HonuaInvestigationPinRequest,
  HonuaInvestigationTimelineEntry,
  HonuaJobAction,
  HonuaJobActionRequest,
  HonuaJobArtifact,
  HonuaJobLog,
  HonuaJobRunDetail,
  HonuaJobRunSummary,
  HonuaJobStage,
  HonuaJobState,
  HonuaLogLevel,
  HonuaLogRecord,
  HonuaMetricSnapshot,
  HonuaObservabilityTarget,
  HonuaOperateCapability,
  HonuaOperateEntityValidators,
  HonuaOperateLinks,
  HonuaOperateListOptions,
  HonuaOperatePage,
  HonuaOperateRawRequest,
  HonuaOperateRequestOptions,
  HonuaOperateResult,
  HonuaOperateSuccess,
  HonuaOperateUnsupported,
  HonuaOperationalEvent,
  HonuaOperationalEventSeverity,
  HonuaProblemDetails,
  HonuaServerTelemetryStatus,
  HonuaTelemetryHealth,
  HonuaTelemetryProviderStatus,
} from "./types.js";
