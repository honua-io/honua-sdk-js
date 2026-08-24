export declare const LIVE_SKIP_REASON_CODES: {
  readonly liveProbesDisabled: "live-probes-disabled";
  readonly operatorRequested: "operator-requested-skip";
  readonly realtimeCapabilityProbeUnavailable: "realtime-capability-probe-unavailable";
  readonly realtimeCapabilityDisabled: "realtime-capability-disabled";
  readonly incidentDemoDatasetEmpty: "incident-demo-dataset-empty";
  readonly incidentDemoServiceMissing: "incident-demo-service-missing";
};

export type LiveSkipReasonCode = (typeof LIVE_SKIP_REASON_CODES)[keyof typeof LIVE_SKIP_REASON_CODES];

/**
 * One distinct reconnect outcome per skip condition. Consumers branch on this
 * string, so no condition may borrow another's outcome.
 */
export declare const INCIDENT_SKIP_RECONNECT_OUTCOMES: {
  readonly "live-probes-disabled": "not-attempted-live-probes-disabled";
  readonly "operator-requested-skip": "not-attempted-operator-skip";
  readonly "realtime-capability-probe-unavailable": "not-attempted-capability-unavailable";
  readonly "realtime-capability-disabled": "not-attempted-capability-unavailable";
  readonly "incident-demo-dataset-empty": "not-attempted-demo-dataset-empty";
  readonly "incident-demo-service-missing": "not-attempted-demo-service-missing";
};

export type IncidentReconnectOutcome =
  | "resumed-from-cursor-and-observed-delta"
  | (typeof INCIDENT_SKIP_RECONNECT_OUTCOMES)[keyof typeof INCIDENT_SKIP_RECONNECT_OUTCOMES]
  | "not-attempted";

export interface LiveEvidenceReport {
  format: "honua.sdk.benchmark-live-evidence.v1";
  schemaVersion: 1;
  generatedAt: string;
  run: {
    status: "passed" | "failed" | "skipped";
    trigger: string;
    skipReason?: string | null;
  };
  targets: Array<{
    id: string;
    status: "passed" | "failed" | "skipped";
    skipReason?: string;
    skipReasonCode?: LiveSkipReasonCode;
    error?: string;
    endpoint: string;
    protocolVersion?: string | null;
    realtime?: {
      snapshotAt: string | null;
      cursor: string | null;
      lagMs: number | null;
      observationWindowMs: number;
      reconnectOutcome: IncidentReconnectOutcome | null;
    };
    sampleEvidence: Record<string, unknown>;
  }>;
}

export function collectLiveEvidence(env?: Record<string, string | undefined>): Promise<LiveEvidenceReport>;
export function toSampleEvidence(
  target: Record<string, unknown>,
  sdk: { package: string; version: string; gitCommit: string | null },
  generatedAt: string,
  producerArtifact: { kind: "producer-generator"; path: string; sha256: string },
): Record<string, unknown>;
