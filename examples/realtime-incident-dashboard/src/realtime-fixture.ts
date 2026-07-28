import type {
  RealtimeFeatureObserver,
  RealtimeFeaturePatch,
  RealtimeFeatureTransport,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "@honua/sdk-js/realtime";

import { INCIDENT_SCENARIO_STEPS, INCIDENT_SOURCE_ID, INITIAL_INCIDENTS } from "./fixtures.js";
import { SAFE_DEMO_INCIDENT_ID, createSafeIncidentEditor } from "./safe-edit.js";
import type {
  IncidentEditReceipt,
  IncidentEditRequest,
  IncidentFeature,
  IncidentResetRequest,
  IncidentScenarioStep,
} from "./types.js";

export interface FixtureIncidentTransportOptions {
  readonly now?: () => number;
}

export interface FixtureIncidentTransport extends RealtimeFeatureTransport<IncidentFeature> {
  readonly currentStepIndex: number;
  readonly connectedRequest: RealtimeSubscriptionRequest | undefined;
  step(): IncidentScenarioStep | undefined;
  refresh(): void;
  reconnect(): void;
  resume(): void;
  heartbeat(): void;
  offline(): void;
  duplicateLast(): void;
  reorderLast(): void;
  staleCursor(): void;
  edit(request: IncidentEditRequest): IncidentEditReceipt;
  reset(request: IncidentResetRequest): IncidentEditReceipt;
  simulateConcurrentUpdate(): IncidentFeature;
}

export function createFixtureIncidentTransport(
  options: FixtureIncidentTransportOptions = {},
): FixtureIncidentTransport {
  const now = options.now ?? (() => Date.now());
  let observer: RealtimeFeatureObserver<IncidentFeature> | undefined;
  let request: RealtimeSubscriptionRequest | undefined;
  let sequence = 0;
  let heartbeatIndex = 0;
  let stepIndex = 0;
  let closed = false;
  let lastDataEvent: Parameters<RealtimeFeatureObserver<IncidentFeature>["next"]>[0] | undefined;
  const current = new Map<string, IncidentFeature>(INITIAL_INCIDENTS.map((incident) => [incident.id, incident]));

  function receivedAt(): number {
    return now();
  }

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  function cursor(prefix = "fixture"): string {
    return `${prefix}-${sequence}`;
  }

  function patch(incident: IncidentFeature): RealtimeFeaturePatch<IncidentFeature> {
    return {
      sourceId: INCIDENT_SOURCE_ID,
      id: incident.id,
      feature: incident,
      updatedAt: incident.updatedAt,
    };
  }

  function ensureObserver(): RealtimeFeatureObserver<IncidentFeature> | undefined {
    return closed ? undefined : observer;
  }

  function emitDataEvent(event: Parameters<RealtimeFeatureObserver<IncidentFeature>["next"]>[0]): void {
    lastDataEvent = event;
    ensureObserver()?.next(event);
  }

  function publishSafeIncident(
    incident: IncidentFeature,
    idempotencyKey: string,
    operation: "edit" | "reset" | "external",
  ): void {
    current.set(incident.id, incident);
    const eventSequence = nextSequence();
    emitDataEvent({
      type: "upsert",
      eventId: `${operation}-${idempotencyKey}`,
      cursor: cursor(operation),
      sequence: eventSequence,
      timestamp: incident.updatedAt,
      receivedAt: receivedAt(),
      feature: patch(incident),
    });
  }

  const safeBaseline = current.get(SAFE_DEMO_INCIDENT_ID);
  if (!safeBaseline) throw new Error("Incident fixture is missing its isolated demo-edit record.");
  const safeEditor = createSafeIncidentEditor({
    baseline: safeBaseline,
    now,
    publish: publishSafeIncident,
  });

  return {
    capabilities: {
      kind: "mock",
      resumeModes: ["cursor", "sequence"],
      emitsHeartbeats: true,
      emitsWatermarks: true,
    },
    get currentStepIndex() {
      return stepIndex;
    },
    get connectedRequest() {
      return request;
    },
    subscribe(nextRequest, nextObserver): RealtimeSubscriptionHandle {
      observer = nextObserver;
      request = nextRequest;
      closed = false;
      const eventSequence = nextSequence();
      const snapshotAt = receivedAt();
      emitDataEvent({
        type: "snapshot",
        eventId: `snapshot-${eventSequence}`,
        cursor: cursor("snapshot"),
        watermark: new Date(snapshotAt).toISOString(),
        timestamp: new Date(snapshotAt).toISOString(),
        sequence: eventSequence,
        receivedAt: snapshotAt,
        features: [...current.values()].map(patch),
        replace: true,
      });
      heartbeatIndex += 1;
      nextObserver.next({
        type: "heartbeat",
        eventId: `heartbeat-${heartbeatIndex}`,
        cursor: cursor("heartbeat"),
        receivedAt: receivedAt(),
      });
      return {
        close() {
          closed = true;
        },
      };
    },
    step() {
      const target = ensureObserver();
      if (!target) return undefined;
      const step = INCIDENT_SCENARIO_STEPS[stepIndex % INCIDENT_SCENARIO_STEPS.length];
      stepIndex += 1;
      const eventSequence = nextSequence();

      if (step.kind === "delete") {
        const id = String(step.id);
        current.delete(id);
        emitDataEvent({
          type: "delete",
          eventId: `step-${eventSequence}`,
          cursor: cursor("step"),
          sequence: eventSequence,
          receivedAt: receivedAt(),
          timestamp: new Date(receivedAt()).toISOString(),
          sourceId: INCIDENT_SOURCE_ID,
          id,
        });
        return step;
      }

      if (!step.incident) return step;
      current.set(step.incident.id, step.incident);
      emitDataEvent({
        type: "upsert",
        eventId: `step-${eventSequence}`,
        cursor: cursor("step"),
        sequence: eventSequence,
        receivedAt: receivedAt(),
        timestamp: new Date(receivedAt()).toISOString(),
        feature: patch(step.incident),
      });
      return step;
    },
    refresh() {
      const target = ensureObserver();
      if (!target) return;
      const eventSequence = nextSequence();
      const observedAt = receivedAt();
      emitDataEvent({
        type: "snapshot",
        eventId: `refresh-${eventSequence}`,
        cursor: cursor("refresh"),
        sequence: eventSequence,
        receivedAt: observedAt,
        features: [...current.values()].map(patch),
        timestamp: new Date(observedAt).toISOString(),
        replace: true,
      });
    },
    reconnect() {
      ensureObserver()?.next({
        type: "status",
        status: "reconnecting",
        reason: "fixture-network-interruption",
        reconnectAttempt: 1,
        retryAfterMs: 750,
        receivedAt: receivedAt(),
      });
    },
    resume() {
      const target = ensureObserver();
      if (!target) return;
      target.next({
        type: "status",
        status: "live",
        cursor: cursor("resume"),
        reason: "fixture-resume-succeeded",
        reconnectAttempt: 1,
        receivedAt: receivedAt(),
      });
      this.heartbeat();
    },
    heartbeat() {
      const target = ensureObserver();
      if (!target) return;
      heartbeatIndex += 1;
      target.next({
        type: "heartbeat",
        eventId: `heartbeat-${heartbeatIndex}`,
        cursor: cursor("heartbeat"),
        receivedAt: receivedAt(),
      });
    },
    offline() {
      ensureObserver()?.next({
        type: "status",
        status: "offline",
        receivedAt: receivedAt(),
      });
    },
    duplicateLast() {
      if (!lastDataEvent) return;
      ensureObserver()?.next({ ...lastDataEvent, receivedAt: receivedAt() });
    },
    reorderLast() {
      const target = ensureObserver();
      const incident = current.get(SAFE_DEMO_INCIDENT_ID);
      if (!target || !incident) return;
      target.next({
        type: "upsert",
        eventId: `reordered-${sequence + 1}`,
        cursor: `reordered-${Math.max(0, sequence - 1)}`,
        sequence: Math.max(0, sequence - 1),
        receivedAt: receivedAt(),
        feature: patch(incident),
      });
    },
    staleCursor() {
      ensureObserver()?.next({
        type: "error",
        code: "cursor-expired",
        error: new Error("Realtime cursor expired."),
        terminal: false,
        receivedAt: receivedAt(),
      });
    },
    edit(request) {
      return safeEditor.edit(request);
    },
    reset(request) {
      return safeEditor.reset(request);
    },
    simulateConcurrentUpdate() {
      return safeEditor.simulateConcurrentUpdate();
    },
  };
}
