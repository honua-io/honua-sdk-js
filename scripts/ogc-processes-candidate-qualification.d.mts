export const OGC_PROCESSES_QUALIFICATION_FORMAT: "honua.sdk.ogc-processes-candidate-qualification.v1";

export function qualificationEnabled(env?: Record<string, string | undefined>): boolean;

export function assertCandidateEvidenceRedacted(value: unknown): void;

export interface GovernedInputRejectionProjection {
  name: string;
  statusCode: number | null;
  jobStatus: string | null;
  errorCode: string | null;
}

export function classifyGovernedInputRejection(error: unknown): {
  accepted: boolean;
  kind: "request-rejected" | "job-failed" | "unrelated-failure";
  error: GovernedInputRejectionProjection;
};

export function auditPreferHeaders(
  requests: ReadonlyArray<{ prefer: string | null | undefined }>,
): { preferValues: string[]; respondSyncSent: false };

export function assertLegalJobTransitions(statuses: readonly string[]): string[];

export function decodeWkbPoint(base64: string): [number, number];

export function assertBufferResult(
  output: unknown,
  options: { center: readonly [number, number] | number[]; distance: number; tolerance?: number },
): { geometryType: string; vertexCount: number; minRadius: number; maxRadius: number; expectedRadius: number };

export function collectOgcProcessesCandidateQualification(options: {
  sdk: { HonuaClient: new (options: Record<string, unknown>) => unknown };
  baseUrl: string;
  apiKey: string;
  identities: Record<string, unknown>;
  fetchFn?: typeof fetch;
  observedAt?: string;
}): Promise<Record<string, unknown>>;
