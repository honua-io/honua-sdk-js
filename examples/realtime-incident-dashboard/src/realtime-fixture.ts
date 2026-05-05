import type {
  RealtimeFeatureObserver,
  RealtimeFeaturePatch,
  RealtimeFeatureTransport,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "@honua/sdk-js/realtime";

import { INCIDENT_SCENARIO_STEPS, INCIDENT_SOURCE_ID, INITIAL_INCIDENTS } from "./fixtures.js";
import type { IncidentFeature, IncidentScenarioStep } from "./types.js";

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
}

export function createFixtureIncidentTransport(
  options: FixtureIncidentTransportOptions = {},
): FixtureIncidentTransport {
  const now = options.now ?? (() => Date.now());
  let observer: RealtimeFeatureObserver<IncidentFeature> | undefined;
  let request: RealtimeSubscriptionRequest | undefined;
  let sequence = 0;
  let stepIndex = 0;
  let closed = false;
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

  return {
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
      nextObserver.next({
        type: "snapshot",
        eventId: `snapshot-${eventSequence}`,
        cursor: cursor("snapshot"),
        sequence: eventSequence,
        receivedAt: receivedAt(),
        features: [...current.values()].map(patch),
        replace: true,
      });
      nextObserver.next({
        type: "heartbeat",
        eventId: `heartbeat-${eventSequence}`,
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
        target.next({
          type: "delete",
          eventId: `step-${eventSequence}`,
          cursor: cursor("step"),
          sequence: eventSequence,
          receivedAt: receivedAt(),
          sourceId: INCIDENT_SOURCE_ID,
          id,
        });
        return step;
      }

      if (!step.incident) return step;
      current.set(step.incident.id, step.incident);
      target.next({
        type: "upsert",
        eventId: `step-${eventSequence}`,
        cursor: cursor("step"),
        sequence: eventSequence,
        receivedAt: receivedAt(),
        feature: patch(step.incident),
      });
      return step;
    },
    refresh() {
      const target = ensureObserver();
      if (!target) return;
      const eventSequence = nextSequence();
      target.next({
        type: "snapshot",
        eventId: `refresh-${eventSequence}`,
        cursor: cursor("refresh"),
        sequence: eventSequence,
        receivedAt: receivedAt(),
        features: [...current.values()].map(patch),
        replace: false,
      });
    },
    reconnect() {
      ensureObserver()?.next({
        type: "status",
        status: "reconnecting",
        receivedAt: receivedAt(),
      });
    },
    resume() {
      const target = ensureObserver();
      if (!target) return;
      target.next({
        type: "status",
        status: "live",
        cursor: request?.cursor,
        receivedAt: receivedAt(),
      });
      this.heartbeat();
    },
    heartbeat() {
      const target = ensureObserver();
      if (!target) return;
      target.next({
        type: "heartbeat",
        eventId: `heartbeat-${nextSequence()}`,
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
  };
}
