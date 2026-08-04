export const REALTIME_CONFORMANCE_RUN_TOKEN_HEADER: "X-Honua-Conformance-Run-Token";
export const REALTIME_CONFORMANCE_OPERATIONS: readonly ["insert", "update", "touch", "delete"];
export const REALTIME_CONFORMANCE_RUNS_PATH: "/api/v1/streaming/conformance/runs";
export const REALTIME_CONFORMANCE_RESPONSE_MAX_BYTES: 65536;

export type ConformanceOperation = "insert" | "update" | "touch" | "delete";

/** A named, fail-closed refusal carrying the deployment's own detail verbatim. */
export class ConformanceRunRefusal extends Error {
  constructor(code: string, reason: string, status?: number | null);
  readonly code: string;
  readonly reason: string;
  readonly status: number | null;
}

export function isConformanceAvailabilityRefusal(error: unknown): boolean;

export interface ConformanceCapability {
  readonly present: boolean;
  readonly enabled: boolean;
  readonly serviceId?: string | null;
  readonly layerId?: number | null;
  readonly runIdField?: string | null;
  readonly maxMutationsPerRun?: number | null;
  readonly maxRecordsPerRun?: number | null;
  readonly operations?: readonly string[] | null;
}

export function readConformanceCapability(payload: unknown): ConformanceCapability;

/** Lease summary. Deliberately excludes the per-run ownership token. */
export interface ConformanceLease {
  readonly runId: string;
  readonly runMarker: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly runIdField: string;
  readonly deploymentRevision: string;
  readonly baselineDigest: string;
  readonly baselineRecordCount: number;
  readonly remainingMutations: number;
  readonly maxRecords: number;
  readonly expiresAt: string | null;
}

export interface ConformanceMutation {
  readonly operation: ConformanceOperation;
  readonly objectId: number;
  readonly runMarker: string;
  readonly mutationOrdinal: number;
  readonly remainingMutations: number;
  readonly ownedRecords: number;
}

export interface ConformanceCleanup {
  readonly runId: string;
  readonly deletedRecords: number;
  readonly leaseDigest: string;
  readonly cleanupDigest: string;
  readonly baselineRecordCount: number;
  readonly baselineRestored: boolean;
  readonly digestVerified: boolean;
}

export interface ConformanceRunClient {
  readonly lease: ConformanceLease | undefined;
  readonly appliedOperations: readonly string[];
  open(request?: {
    readonly clientLabel?: string;
    readonly expectedDeploymentRevision?: string;
    readonly expectedServiceId?: string;
    readonly ttlSeconds?: number;
  }): Promise<ConformanceLease>;
  mutate(request: {
    readonly operation: string;
    readonly objectId?: number;
    readonly label?: string;
  }): Promise<ConformanceMutation>;
  release(): Promise<ConformanceCleanup>;
}

export function createConformanceRunClient(options: {
  readonly baseUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): ConformanceRunClient;
