export interface ServiceExplorerLiveBudgets {
  readonly producerTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRequestsPerTarget: number;
  readonly maxResponseBytes: number;
  readonly maxTotalResponseBytes: number;
}

export interface ServiceExplorerLiveTarget {
  readonly id: "geoservices" | "ogc";
  readonly protocol: "geoservices-feature-service" | "ogc-features";
  readonly url: string;
  readonly sourceId: string;
  readonly collectionId?: string;
}

export interface SampleEvidenceEnvelope {
  readonly format: "honua.sdk.sample-evidence.v1";
  readonly schemaVersion: 1;
  readonly sampleId: "service-explorer";
  readonly lane: "live";
  readonly status: "executed" | "failed" | "skipped" | "credential-unavailable";
  readonly reason: string | null;
  readonly observedAt: string;
  readonly authMode: "anonymous";
  readonly sdk: {
    readonly package: "@honua/sdk-js";
    readonly version: string;
    readonly gitCommit: string | null;
  };
  readonly source: {
    readonly provider: string;
    readonly identity: string;
    readonly endpoint: string | null;
    readonly deploymentVersion: string | null;
    readonly dataVersion: string | null;
  };
  readonly provenance: {
    readonly sourceId: string;
    readonly observedAt: string;
    readonly validAt: string | null;
    readonly state: "live";
    readonly attribution: string;
  } | null;
  readonly semantics: {
    readonly operation: string;
    readonly outcome: string | null;
    readonly itemCount: number | null;
    readonly assertions: readonly string[];
  };
  readonly timing: {
    readonly totalMs: number | null;
    readonly firstSuccessfulInteractionMs: number | null;
  };
  readonly degradation: {
    readonly state: "none" | "expected" | "unexpected" | "unavailable";
    readonly reasons: readonly string[];
  };
  readonly artifacts: readonly {
    readonly kind: string;
    readonly path: string;
    readonly sha256: string;
  }[];
}

export const SERVICE_EXPLORER_LIVE_BUDGETS: Readonly<ServiceExplorerLiveBudgets>;
export const CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS: Readonly<{
  geoservices: string;
  ogc: string;
}>;

export function createServiceExplorerLiveTargets(options?: {
  readonly geoservicesUrl?: string;
  readonly ogcUrl?: string;
  readonly ogcSourceId?: string;
  readonly allowLoopback?: boolean;
}): readonly ServiceExplorerLiveTarget[];

export function validateServiceExplorerLiveEndpoint(
  value: string | URL,
  options?: { readonly allowLoopback?: boolean },
): string;

export function createBoundedServiceExplorerFetch(options: {
  readonly targetUrl: string;
  readonly allowLoopback?: boolean;
  readonly fetchFn?: typeof fetch;
  readonly budgets?: Partial<ServiceExplorerLiveBudgets>;
}): typeof fetch;

export function collectServiceExplorerLiveEvidence(options?: {
  readonly targets?: readonly ServiceExplorerLiveTarget[];
  readonly allowLoopback?: boolean;
  readonly fetchFn?: typeof fetch;
  readonly budgets?: Partial<ServiceExplorerLiveBudgets>;
  readonly observedAt?: string;
  readonly sourceRevision?: string;
  readonly sdkVersion?: string;
}): Promise<SampleEvidenceEnvelope>;

export function createNonExecutedServiceExplorerEvidence(options: {
  readonly status: "failed" | "skipped" | "credential-unavailable";
  readonly reason: string;
  readonly degradationReason: string;
  readonly observedAt?: string;
  readonly sourceRevision?: string | null;
  readonly sdkVersion?: string;
  readonly includeProducerArtifact?: boolean;
}): SampleEvidenceEnvelope;

export function serviceExplorerLiveEnabled(
  runnerEnabled: boolean,
  env?: Readonly<Record<string, string | undefined>>,
): boolean;
