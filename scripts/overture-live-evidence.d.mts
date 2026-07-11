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
export function summarizeOvertureRangeTraffic(
  entries: readonly {
    readonly method: string;
    readonly range: string | null;
    readonly status: number | null;
    readonly contentRange: string | null;
    readonly contentLength: string | null;
  }[],
  objectBytes: number,
  maxObservedBytes?: number,
): {
  readonly observedRequests: number;
  readonly observedBytes: number;
  readonly engineRequests: number;
  readonly engineBytes: number;
  readonly byteBudget: number;
  readonly unboundedGets: 0;
};
