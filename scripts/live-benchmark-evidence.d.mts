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
  }>;
}

export function collectLiveEvidence(env?: Record<string, string | undefined>): Promise<LiveEvidenceReport>;
