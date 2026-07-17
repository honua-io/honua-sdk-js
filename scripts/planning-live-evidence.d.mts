import type { nominatimGeocodingProvider } from "../src/geocoding/index.js";
import type { HonuaClient } from "../src/honua.js";

export interface PlanningLiveEvidenceEnvelope {
  readonly format: "honua.sdk.sample-evidence.v1";
  readonly schemaVersion: 1;
  readonly sampleId: "planning-permitting-workbench";
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
  readonly provenance: Record<string, unknown> | null;
  readonly semantics: {
    readonly operation: "public-address-to-zoning-read-check";
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

export interface PlanningLiveLimits {
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly maxTotalBytes: number;
  readonly requestTimeoutMs: number;
  readonly overallTimeoutMs: number;
}

export const PLANNING_LIVE_PRODUCER_ARTIFACT: Readonly<{
  kind: "producer-generator";
  path: "scripts/planning-live-evidence.mjs";
  sha256: string;
}>;

export function isPlanningLiveEvidenceEnabled(env?: Readonly<Record<string, string | undefined>>): boolean;

export function createPlanningBoundedFetch(options?: {
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<PlanningLiveLimits>;
}): {
  readonly fetch: typeof fetch;
  readonly limits: Readonly<PlanningLiveLimits>;
  snapshot(): {
    readonly requests: readonly {
      readonly operation: string;
      readonly status: number;
      readonly bytes: number;
      readonly durationMs: number;
    }[];
    readonly totalBytes: number;
  };
};

export function loadPlanningSdk(options?: {
  readonly mode?: "source" | "packed";
  readonly sdkDir?: string;
}): Promise<{
  readonly HonuaClient: typeof HonuaClient;
  readonly nominatimGeocodingProvider: typeof nominatimGeocodingProvider;
  readonly mode: "source" | "packed";
}>;

export function runPlanningLiveEvidence(options?: {
  readonly enabled?: boolean;
  readonly fetchFn?: typeof fetch;
  readonly observedAt?: string;
  readonly sourceRevision?: string;
  readonly mode?: "source" | "packed";
  readonly sdkDir?: string;
  readonly limits?: Partial<PlanningLiveLimits>;
  readonly packageJson?: { readonly name: "@honua/sdk-js"; readonly version: string };
  readonly sdk?: {
    readonly HonuaClient: typeof HonuaClient;
    readonly nominatimGeocodingProvider: typeof nominatimGeocodingProvider;
    readonly mode?: "source" | "packed";
  };
}): Promise<PlanningLiveEvidenceEnvelope>;
