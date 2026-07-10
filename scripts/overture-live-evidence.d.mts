export interface OvertureLiveEvidenceEnvelope {
  readonly format: "honua.sdk.sample-evidence.v1";
  readonly sampleId: "overture-geoparquet";
  readonly lane: "live";
  readonly status: "executed" | "failed" | "skipped" | "credential-unavailable";
  readonly reason: string | null;
  readonly authMode: "anonymous";
  readonly degradation: {
    readonly state: "none" | "expected" | "unexpected" | "unavailable";
    readonly reasons: readonly string[];
  };
  readonly [key: string]: unknown;
}

export function collectOvertureLiveEvidence(): Promise<OvertureLiveEvidenceEnvelope>;
