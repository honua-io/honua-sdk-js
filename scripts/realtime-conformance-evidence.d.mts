export type RealtimeConformanceStatus = "executed" | "unsupported" | "degraded" | "failed";
export type RealtimeConformanceTransportId = "sse" | "websocket" | "odata";
export type RealtimeConformanceRunStatus = "executed" | "skipped" | "degraded" | "failed";
/**
 * Where the immutable deployment revision in retained evidence came from.
 * `null` means none was observed, which prevents certification.
 */
export type RealtimeConformanceRevisionSource = "capabilities" | "manifest" | "fixture" | null;

/**
 * Outcome of the controlled-conformance run the live lane drove against
 * honua-server's dedicated conformance source. Never carries the per-run
 * ownership token.
 */
export interface RealtimeConformanceRun {
  readonly status: RealtimeConformanceRunStatus;
  readonly reason: { readonly code: string; readonly message: string } | null;
  readonly runId: string | null;
  readonly serviceId: string | null;
  readonly layerId: number | null;
  readonly deploymentRevision: string | null;
  readonly mutations: { readonly insert: number; readonly touch: number };
  readonly baseline: {
    readonly runId: string;
    readonly deletedRecords: number;
    readonly leaseDigest: string;
    readonly cleanupDigest: string;
    readonly baselineRecordCount: number;
    readonly baselineRestored: boolean;
    readonly digestVerified: boolean;
  } | null;
}

export interface RealtimeConformanceEvidence {
  readonly format: "honua.sdk.realtime-conformance-evidence.v1";
  readonly schemaVersion: 1;
  readonly lane: "fixture" | "live";
  readonly generatedAt: string;
  readonly sdk: {
    readonly package: "@honua/sdk-js";
    readonly version: string;
    readonly revision: string;
  };
  readonly server: {
    readonly version: string | null;
    readonly revision: string | null;
    /** Which document bound the evidence to a deployment. */
    readonly revisionSource: RealtimeConformanceRevisionSource;
    readonly capabilities: Record<RealtimeConformanceTransportId, boolean>;
  };
  readonly corpus: {
    readonly kind: "honua.realtime-cross-transport-conformance";
    readonly version: 1;
    readonly sha256: string;
  };
  readonly summary: {
    readonly status: RealtimeConformanceStatus;
    readonly transportCount: 3;
    readonly scenarioCount: number;
    readonly executionCount: number;
    readonly executed: number;
    readonly unsupported: number;
    readonly degraded: number;
    readonly failed: number;
  };
  /** Present on live documents only. */
  readonly conformance?: RealtimeConformanceRun;
  readonly transports: ReadonlyArray<{
    readonly id: RealtimeConformanceTransportId;
    readonly freshness: "push" | "poll";
    readonly advertised: boolean;
    readonly status: RealtimeConformanceStatus;
    readonly acceptedState?: {
      readonly eventCount: number;
      readonly historySha256: `sha256:${string}`;
      readonly finalStateSha256: `sha256:${string}`;
    };
    readonly baselineState?: {
      readonly eventCount: number;
      readonly historySha256: `sha256:${string}`;
      readonly finalStateSha256: `sha256:${string}`;
    };
    readonly scenarioCounts: { readonly total: number; readonly passed: number; readonly failed: number };
    readonly scenarios: ReadonlyArray<{ readonly id: string; readonly result: "passed" | "failed" }>;
    readonly diagnostics: ReadonlyArray<{
      readonly code: string;
      readonly message: string;
      readonly scenario: string | null;
    }>;
  }>;
}

export const REALTIME_CONFORMANCE_EVIDENCE_FORMAT: "honua.sdk.realtime-conformance-evidence.v1";
export const REALTIME_CONFORMANCE_EVIDENCE_SCHEMA: "schemas/realtime-conformance-evidence.v1.json";
export const REALTIME_LIVE_ENABLE_ENV: "HONUA_REALTIME_LIVE_CONFORMANCE_ENABLED";
export const REALTIME_CONFORMANCE_MUTATE_ENV: "HONUA_REALTIME_LIVE_CONFORMANCE_MUTATE";
export const REALTIME_CONFORMANCE_LABEL_ENV: "HONUA_REALTIME_LIVE_CONFORMANCE_LABEL";
export const REALTIME_CONFORMANCE_TTL_ENV: "HONUA_REALTIME_LIVE_CONFORMANCE_TTL_SECONDS";
export const REALTIME_CONFORMANCE_DEFAULT_LABEL: "honua-sdk-js-realtime-conformance";
export const REALTIME_TRANSPORTS: readonly ["sse", "websocket", "odata"];
export const REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES: 1048576;
export const REALTIME_SSE_EVENT_MAX_BYTES: 262144;
export const REALTIME_SSE_BUFFER_MAX_BYTES: 262144;
export const REALTIME_LIVE_SEMANTIC_LIMITS: Readonly<{
  readonly maxEvents: 64;
  readonly maxFeaturesPerEvent: 10000;
  readonly maxRecords: 10000;
  readonly maxDepth: 16;
  readonly maxNodes: 500000;
  readonly maxObjectKeys: 512;
  readonly maxArrayItems: 100000;
  readonly maxStringBytes: 65536;
  readonly maxGeometryPositions: 25000;
  readonly maxHistoryBytes: 16777216;
}>;

/**
 * Drops env entries whose value is a blank string. GitHub Actions renders an
 * unset input or undefined repository variable as `""`, which `??` would
 * otherwise treat as supplied.
 */
export function normalizeLiveEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function realtimeSourceRevision(env?: NodeJS.ProcessEnv, projectRoot?: string): string;
export function isRealtimeLiveEnabled(env?: NodeJS.ProcessEnv): boolean;
export function isRealtimeConformanceMutationEnabled(env?: NodeJS.ProcessEnv): boolean;
export function normalizeLiveCapabilities(payload: unknown, baseUrl: string): {
  readonly serverVersion: string | null;
  readonly serverRevision: string | null;
  readonly sse: Record<string, unknown> & { readonly advertised: boolean; readonly url: string | null };
  readonly websocket: Record<string, unknown> & { readonly advertised: boolean; readonly url: string | null };
  readonly odata: Record<string, unknown> & { readonly advertised: boolean; readonly url: string | null };
};
export function collectFixtureRealtimeConformanceEvidence(
  options?: Record<string, unknown>,
): Promise<RealtimeConformanceEvidence>;
export function collectLiveRealtimeConformanceEvidence(
  options?: Record<string, unknown>,
): Promise<RealtimeConformanceEvidence>;
/**
 * Classifies a collector crash as a `failed` document so the lane retains a
 * machine-readable reason instead of only a stderr line.
 */
export function collectorFailureRealtimeConformanceEvidence(
  lane: "fixture" | "live",
  error: unknown,
  options?: Record<string, unknown>,
): RealtimeConformanceEvidence;
export function validateRealtimeConformanceEvidence(
  evidence: RealtimeConformanceEvidence,
): RealtimeConformanceEvidence;
export function summarizeRealtimeConformanceEvidence(evidence: RealtimeConformanceEvidence): string[];
