import type { RealtimeFeatureEvent, RealtimeFeatureState } from "@honua/sdk-js/realtime";

import type { IncidentExecutionLane } from "./safe-edit.js";
import type { IncidentFeature } from "./types.js";

export type IncidentReconnectOutcome = "not-attempted" | "backoff" | "resumed" | "failed";
export type IncidentReconciliationOutcome =
  | "waiting-for-snapshot"
  | "snapshot-replaced"
  | "upsert-applied"
  | "delete-applied"
  | "delta-applied"
  | "heartbeat-observed"
  | "duplicate-or-stale-ignored"
  | "status-updated"
  | "stream-error";

export interface IncidentRealtimeDiagnostics {
  readonly lane: IncidentExecutionLane;
  readonly snapshotAt?: number;
  readonly observationAt?: number;
  readonly eventTime?: string;
  readonly lagMs?: number;
  readonly cursor?: string;
  readonly sequence?: number;
  readonly reconnectAttempt: number;
  readonly retryAfterMs?: number;
  readonly reconnectOutcome: IncidentReconnectOutcome;
  readonly ignoredEventCount: number;
  readonly reconciliationOutcome: IncidentReconciliationOutcome;
}

export function initialIncidentRealtimeDiagnostics(lane: IncidentExecutionLane): IncidentRealtimeDiagnostics {
  return {
    lane,
    reconnectAttempt: 0,
    reconnectOutcome: "not-attempted",
    ignoredEventCount: 0,
    reconciliationOutcome: "waiting-for-snapshot",
  };
}

export function reconcileIncidentDiagnostics(
  previous: IncidentRealtimeDiagnostics,
  state: RealtimeFeatureState<IncidentFeature>,
  event: RealtimeFeatureEvent<IncidentFeature> | undefined,
): IncidentRealtimeDiagnostics {
  if (!event) {
    return {
      ...previous,
      cursor: state.cursor,
      sequence: state.lastSequence,
      ignoredEventCount: state.ignoredEventCount,
    };
  }
  const observationAt = event.receivedAt ?? Date.now();
  const observedEventTime = event.timestamp ?? inferFeatureTime(event);
  const eventTime = observedEventTime ?? previous.eventTime;
  const parsedEventTime = observedEventTime ? Date.parse(observedEventTime) : Number.NaN;
  const lagMs = Number.isFinite(parsedEventTime) ? Math.max(0, observationAt - parsedEventTime) : previous.lagMs;
  const ignored = state.ignoredEventCount > previous.ignoredEventCount;
  return {
    ...previous,
    snapshotAt: event.type === "snapshot" ? observationAt : previous.snapshotAt,
    observationAt,
    eventTime,
    lagMs,
    cursor: state.cursor,
    sequence: state.lastSequence,
    reconnectAttempt: state.reconnectAttempt ?? previous.reconnectAttempt,
    retryAfterMs: state.retryAfterMs,
    reconnectOutcome: reconnectOutcome(state, event, previous.reconnectOutcome),
    ignoredEventCount: state.ignoredEventCount,
    reconciliationOutcome: ignored ? "duplicate-or-stale-ignored" : reconciliationOutcome(event),
  };
}

function inferFeatureTime(event: RealtimeFeatureEvent<IncidentFeature>): string | undefined {
  if (event.type === "upsert") return event.feature.updatedAt ?? event.feature.feature.updatedAt;
  if (event.type === "snapshot") return event.features[0]?.updatedAt ?? event.features[0]?.feature.updatedAt;
  return undefined;
}

function reconnectOutcome(
  state: RealtimeFeatureState<IncidentFeature>,
  event: RealtimeFeatureEvent<IncidentFeature>,
  previous: IncidentReconnectOutcome,
): IncidentReconnectOutcome {
  if (event.type === "error") return event.terminal ? "failed" : "backoff";
  if (event.type === "status" && event.status === "reconnecting") return "backoff";
  if (event.type === "status" && event.status === "error") return "failed";
  if (state.status === "live" && (previous === "backoff" || state.reconnectAttempt)) return "resumed";
  return previous;
}

function reconciliationOutcome(event: RealtimeFeatureEvent<IncidentFeature>): IncidentReconciliationOutcome {
  switch (event.type) {
    case "snapshot":
      return "snapshot-replaced";
    case "upsert":
      return "upsert-applied";
    case "delete":
      return "delete-applied";
    case "delta":
      return "delta-applied";
    case "heartbeat":
      return "heartbeat-observed";
    case "status":
      return "status-updated";
    case "error":
      return "stream-error";
  }
}
