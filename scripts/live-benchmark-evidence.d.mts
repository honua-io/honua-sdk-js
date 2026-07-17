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
    error?: string;
    endpoint: string;
    protocolVersion?: string | null;
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
