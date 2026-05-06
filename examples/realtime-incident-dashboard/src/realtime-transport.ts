import {
  type RealtimeFeatureTransport,
  type RealtimeSubscriptionRequest,
  createRealtimeServerSentEventsTransport,
} from "../../../src/realtime/index.js";

import { INCIDENT_LAYER_ID, INCIDENT_SOURCE_ID } from "./fixtures.js";
import { type FixtureIncidentTransport, createFixtureIncidentTransport } from "./realtime-fixture.js";
import type { IncidentFeature, IncidentScenarioStep } from "./types.js";

export type IncidentTransportMode = "fixture" | "cloud";

export interface IncidentTransportControls {
  readonly mode: IncidentTransportMode;
  step(): IncidentScenarioStep | undefined;
  reconnect(): void;
  resume(): void;
  refresh(): void;
}

export interface IncidentTransportConfig {
  readonly mode: IncidentTransportMode;
  readonly streamUrl?: string;
}

export interface IncidentDashboardTransport {
  readonly transport: RealtimeFeatureTransport<IncidentFeature>;
  readonly controls: IncidentTransportControls;
  readonly request: RealtimeSubscriptionRequest;
}

export function createIncidentDashboardTransport(location: Location = window.location): IncidentDashboardTransport {
  const config = readIncidentTransportConfig(location);
  if (config.mode === "cloud" && config.streamUrl) {
    return {
      transport: createRealtimeServerSentEventsTransport<IncidentFeature>({
        url: config.streamUrl,
      }),
      controls: createCloudIncidentTransportControls(),
      request: createIncidentRealtimeRequest("cloud"),
    };
  }

  const fixture = createFixtureIncidentTransport();
  return {
    transport: fixture,
    controls: createFixtureIncidentTransportControls(fixture),
    request: createIncidentRealtimeRequest("fixture"),
  };
}

export function readIncidentTransportConfig(location: Location = window.location): IncidentTransportConfig {
  const params = new URLSearchParams(location.search);
  const env = (import.meta as ImportMeta & { readonly env?: Record<string, string | undefined> }).env;
  const streamUrl = params.get("streamUrl") ?? env?.VITE_HONUA_INCIDENT_STREAM_URL;
  const mode = params.get("transport") ?? env?.VITE_HONUA_INCIDENT_TRANSPORT;
  return {
    mode: mode === "cloud" && streamUrl ? "cloud" : "fixture",
    streamUrl: streamUrl || undefined,
  };
}

function createIncidentRealtimeRequest(channel: IncidentTransportMode): RealtimeSubscriptionRequest {
  return {
    requestId: "realtime-incident-dashboard",
    sourceId: INCIDENT_SOURCE_ID,
    layerId: INCIDENT_LAYER_ID,
    mode: "snapshot-then-delta",
    metadata: {
      demo: "realtime-incident-dashboard",
      channel,
    },
  };
}

function createFixtureIncidentTransportControls(fixture: FixtureIncidentTransport): IncidentTransportControls {
  return {
    mode: "fixture",
    step: () => fixture.step(),
    reconnect: () => fixture.reconnect(),
    resume: () => fixture.resume(),
    refresh: () => fixture.refresh(),
  };
}

function createCloudIncidentTransportControls(): IncidentTransportControls {
  return {
    mode: "cloud",
    step: () => undefined,
    reconnect: () => undefined,
    resume: () => undefined,
    refresh: () => undefined,
  };
}
