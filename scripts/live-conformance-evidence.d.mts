/**
 * Typed surface of the live-conformance runner for the deterministic offline
 * lane (`test/live-conformance-evidence.test.ts`). Mirrors
 * `schemas/live-conformance-evidence.v1.json`.
 */

export type LiveConformanceJourney = "query" | "raster-tiles" | "ogc-tile" | "ogc-map" | "process-discovery";
export type LiveConformanceTargetStatus = "executed" | "degraded" | "failed" | "skipped";
export type LiveConformanceDegradationState =
  | "none"
  | "unavailable"
  | "capability-gap"
  | "semantic-regression"
  | "muted"
  | "unexpected";

export interface LiveConformanceBudgets {
  readonly runTimeoutMs: number;
  readonly targetTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRequestsPerTarget: number;
  readonly maxResponseBytes: number;
  readonly maxTotalResponseBytes: number;
  readonly maxRetriesPerRequest: number;
  readonly maxPageSize: number;
}

export interface LiveConformanceEndpointTarget {
  readonly id: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly provider: string;
  readonly attribution: string;
  readonly reliability: string;
  readonly owner: string;
  readonly reviewedAt: string;
  readonly reviewExpiresAt: string;
  readonly enabled?: boolean;
  readonly skip?: {
    readonly reasonCode: string;
    readonly reason: string;
    readonly owner: string;
    readonly expiresAt: string;
    readonly tracking?: string;
  };
  readonly discovery?: {
    readonly collectionId?: string;
    readonly typeName?: string;
    readonly styleId?: string;
    readonly tileMatrixSetId?: string;
  };
  readonly sourceId?: string;
  readonly journey: LiveConformanceJourney;
  readonly expect: {
    readonly capabilities: readonly string[];
    readonly conformanceEvidence: string;
    readonly conformanceClasses?: readonly string[];
    readonly protocolVersion?: string;
    readonly minItemCount?: number;
    readonly geometry?: boolean;
    readonly tileFormats?: readonly string[];
    readonly operationMediaTypes?: readonly string[];
    readonly tile?: {
      readonly tileMatrixSetId?: string;
      readonly z: number;
      readonly x: number;
      readonly y: number;
      readonly format?: string;
    };
    readonly map?: { readonly format: string; readonly width: number; readonly height: number };
    readonly processId?: string;
  };
  readonly notes: string;
}

export interface LiveConformanceEndpointManifest {
  readonly format: "honua.sdk.live-conformance-endpoints.v1";
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly manifestEvidenceId: string;
  readonly artifact: {
    readonly format: "honua.sdk.live-conformance-evidence.v1";
    readonly schema: string;
    readonly defaultPath: string;
  };
  readonly defaults: { readonly owner: string; readonly authMode: "anonymous"; readonly reviewCadenceDays: number };
  readonly budgets: LiveConformanceBudgets;
  readonly targets: readonly LiveConformanceEndpointTarget[];
}

export interface LiveConformanceDegradationReason {
  readonly code: string;
  readonly message: string;
  readonly owner: string;
  readonly expiresAt: string;
  readonly tracking: string | null;
}

export interface LiveConformanceAssertion {
  readonly id: string;
  readonly outcome: "pass" | "fail";
  readonly detail?: string | null;
}

export interface LiveConformanceTargetEvidence {
  readonly id: string;
  readonly protocol: string;
  readonly status: LiveConformanceTargetStatus;
  readonly journey: LiveConformanceJourney;
  readonly endpoint: { readonly identity: string; readonly origin: string; readonly path: string };
  readonly provider: string;
  readonly attribution: string;
  readonly reliability: string;
  readonly owner: string;
  readonly reviewedAt: string;
  readonly reviewExpiresAt: string;
  readonly observedAt: string;
  readonly timing: {
    readonly totalMs: number | null;
    readonly discoveryMs: number | null;
    readonly operationMs: number | null;
  };
  readonly traffic: {
    readonly requests: number;
    readonly responseBytes: number;
    readonly ledger: readonly {
      readonly method: "GET" | "HEAD";
      readonly path: string;
      readonly status: number | null;
      readonly bytes: number;
      readonly mediaType?: string | null;
      readonly parameters: readonly { readonly name: string; readonly value: string | null }[];
    }[];
  };
  readonly discovery: {
    readonly protocol: string;
    readonly cacheStatus: string;
    readonly sourceId: string | null;
    readonly sourceCount: number;
    readonly discoveryState: string;
    readonly protocolVersion?: string | null;
    readonly capabilities: readonly string[];
    readonly capabilityDecisions: readonly {
      readonly capability: string;
      readonly effective: boolean;
      readonly code: string;
      readonly evidenceKinds: readonly string[];
    }[];
    readonly conformance: {
      readonly kind: string;
      readonly classes: readonly string[];
      readonly operations: readonly {
        readonly name: string;
        readonly available: boolean;
        readonly formats?: readonly string[];
        readonly reason?: string | null;
      }[];
    };
    readonly diagnostics: readonly { readonly code: string; readonly severity: "info" | "warning" }[];
    readonly partialReasons?: readonly string[];
  } | null;
  readonly operation: {
    readonly kind: "source-query" | "maplibre-raster-tile" | "ogc-tile" | "ogc-map" | "process-discovery";
    readonly capability: string;
    readonly outcome: string;
    readonly itemCount?: number | null;
    readonly attributeCount?: number | null;
    readonly geometryPresent?: boolean | null;
    readonly exceededTransferLimit?: boolean | null;
    readonly requestedLimit?: number | null;
    readonly mediaType?: string;
    readonly bytes?: number;
    readonly signature?: "png" | "jpeg" | "webp" | "unknown";
    readonly tileMatrixSetId?: string;
    readonly tile?: { readonly z: number; readonly x: number; readonly y: number };
    readonly width?: number;
    readonly height?: number;
    readonly processCount?: number;
    readonly processId?: string;
    readonly degradedReasons?: readonly string[];
    readonly plan?: {
      readonly available: boolean;
      readonly capabilityPolicy: string;
      readonly fidelity: string | null;
      readonly lossCount: number | null;
      readonly requestUpperBound: number | null;
      readonly pushdown: readonly string[];
      readonly reason: string | null;
    } | null;
    readonly raster?: {
      readonly strategy: string;
      readonly tileSize: number;
      readonly tile: { readonly z: number; readonly x: number; readonly y: number };
      readonly mediaType: string;
      readonly bytes: number;
      readonly signature?: "png" | "jpeg" | "webp" | "unknown";
    } | null;
    readonly capabilityGuard?: {
      readonly capability: string;
      readonly errorName: string;
      readonly sdkCode: string;
    } | null;
    readonly sourceBoundary?: {
      readonly errorName: string;
      readonly sdkCode: string;
      readonly requestDelta: number;
    } | null;
  } | null;
  readonly assertions: readonly LiveConformanceAssertion[];
  readonly degradation: {
    readonly state: LiveConformanceDegradationState;
    readonly reasons: readonly LiveConformanceDegradationReason[];
  };
}

export interface LiveConformanceEvidence {
  readonly $schema?: string;
  readonly format: "honua.sdk.live-conformance-evidence.v1";
  readonly schemaVersion: 1;
  readonly manifestEvidenceId: string;
  readonly lane: "live-conformance";
  readonly status: LiveConformanceTargetStatus;
  readonly reason: string | null;
  readonly observedAt: string;
  readonly authMode: "anonymous";
  readonly redacted: true;
  readonly sdk: { readonly package: string; readonly version: string; readonly gitCommit: string | null };
  readonly runner: { readonly path: string; readonly sha256: string };
  readonly endpointManifest: {
    readonly path: string;
    readonly format: string;
    readonly schemaVersion: 1;
    readonly revision: string;
    readonly sha256: string;
  };
  readonly budgets: LiveConformanceBudgets;
  readonly totals: {
    readonly targets: number;
    readonly executed: number;
    readonly degraded: number;
    readonly failed: number;
    readonly skipped: number;
    readonly assertions: number;
    readonly requests: number;
    readonly responseBytes: number;
  };
  readonly targets: readonly LiveConformanceTargetEvidence[];
}

/**
 * Injected public SDK surface; the runner never reaches into internals. The
 * signatures stay intentionally loose so the runner can be handed either the
 * built `dist/` entry points or the TypeScript sources under test.
 */
export interface LiveConformanceSdk {
  readonly connect: (options: any) => Promise<any>;
  readonly discoverOgcProcesses: (options: any) => Promise<any>;
  readonly explainQuery: (options: any) => any;
  readonly HonuaClient: new (options: any) => any;
  readonly projectRasterSourceToMapLibre: (descriptor: any, options?: any) => any;
}

export interface CollectLiveConformanceEvidenceOptions {
  readonly manifest?: LiveConformanceEndpointManifest;
  readonly manifestSha256?: string;
  readonly projectRoot?: string;
  readonly observedAt?: string;
  readonly sourceRevision?: string | null;
  readonly enabled?: boolean;
  readonly allowLoopback?: boolean;
  readonly budgets?: Partial<LiveConformanceBudgets>;
  readonly sdk?: LiveConformanceSdk;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}

export const LIVE_CONFORMANCE_EVIDENCE_FORMAT: "honua.sdk.live-conformance-evidence.v1";
export const LIVE_CONFORMANCE_ENDPOINT_MANIFEST_FORMAT: "honua.sdk.live-conformance-endpoints.v1";
export const LIVE_CONFORMANCE_RUNNER_PATH: "scripts/live-conformance-evidence.mjs";
export const LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH: "config/live-conformance-endpoints.v1.json";
export const LIVE_CONFORMANCE_EVIDENCE_SCHEMA_PATH: "schemas/live-conformance-evidence.v1.json";
export const LIVE_CONFORMANCE_NETWORK_GATES: readonly string[];
export const LIVE_CONFORMANCE_JOURNEYS: readonly LiveConformanceJourney[];

export function isLiveConformanceEnabled(env?: Record<string, string | undefined>): boolean;
export function liveConformanceSourceRevision(
  env?: Record<string, string | undefined>,
  projectRoot?: string,
): string | null;
export function validateLiveConformanceEndpoint(value: string, options?: { allowLoopback?: boolean }): string;
export function redactLiveConformanceEndpoint(value: string): {
  readonly identity: string;
  readonly origin: string;
  readonly path: string;
};
export function isCredentialQueryParameter(name: string): boolean;
export function redactQueryParameters(
  searchParams: URLSearchParams,
): readonly { readonly name: string; readonly value: string | null }[];
export function assertLiveConformanceEvidenceRedacted<T>(evidence: T): T;
export function normalizeLiveConformanceBudgets(value: Partial<LiveConformanceBudgets>): LiveConformanceBudgets;
export function loadLiveConformanceEndpointManifest(options?: {
  projectRoot?: string;
  allowLoopback?: boolean;
}): { readonly manifest: LiveConformanceEndpointManifest; readonly sha256: string; readonly path: string };
export function validateLiveConformanceEndpointManifest(
  manifest: unknown,
  options?: { allowLoopback?: boolean },
): LiveConformanceEndpointManifest;
export function createBoundedLiveConformanceFetch(options: {
  targetUrl: string;
  budgets: LiveConformanceBudgets;
  fetchFn?: typeof fetch;
  producerSignal?: AbortSignal;
  allowLoopback?: boolean;
  allowImages?: boolean;
  allowedMediaTypes?: readonly string[];
  ledger?: unknown[];
  /** Per-target byte and request accounting. */
  state?: { requests: number; responseBytes: number };
  /** Shared run-level accounting that enforces `maxTotalResponseBytes`. */
  runState?: { requests: number; responseBytes: number };
}): typeof fetch;
export function availabilityStatusCode(
  status: number,
): "endpoint-rate-limited" | "endpoint-timeout" | "endpoint-server-error" | null;
export function imageSignatureOf(bytes: Uint8Array): "png" | "jpeg" | "webp" | "unknown";
export function imageSignatureMatchesMediaType(
  signature: "png" | "jpeg" | "webp" | "unknown",
  mediaType: string,
): boolean;
export function isStructurallyValidMvt(bytes: Uint8Array): boolean;
export function classifyLiveConformanceFailure(error: unknown): { readonly code: string; readonly message: string };
export function runLiveConformanceTarget(context: {
  target: LiveConformanceEndpointTarget;
  budgets: LiveConformanceBudgets;
  sdk: LiveConformanceSdk;
  now: string;
  observedAt?: string;
  allowLoopback?: boolean;
  fetchFn?: typeof fetch;
  producerSignal?: AbortSignal;
  runState?: { requests: number; responseBytes: number };
}): Promise<LiveConformanceTargetEvidence>;
export function collectLiveConformanceEvidence(
  options?: CollectLiveConformanceEvidenceOptions,
): Promise<LiveConformanceEvidence>;
export function validateLiveConformanceEvidence<T>(evidence: T, options?: { now?: string }): T;
export function summarizeLiveConformanceEvidence(
  evidence: LiveConformanceEvidence,
  options?: { strict?: boolean; allowDegraded?: boolean },
): { readonly status: string; readonly exitCode: number; readonly lines: readonly string[] };
export function parseLiveConformanceArguments(argv: readonly string[]): {
  readonly output: string | null;
  readonly strict: boolean;
  readonly allowDegraded: boolean;
};
