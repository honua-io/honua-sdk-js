export interface CogLiveEvidenceEnvelope {
  readonly format: "honua.sdk.sample-evidence.v1";
  readonly sampleId: "imagery-cog-quickstart";
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

export interface CogPublicContract {
  readonly format: "honua.sdk.cog-public-contract.v1";
  readonly schemaVersion: 1;
  readonly [key: string]: unknown;
}

export function validateCogPublicContract<T extends CogPublicContract>(contract: T): T;

export function runCogLiveEvidence(options?: {
  readonly contract?: CogPublicContract;
  readonly observedAt?: string;
  readonly enabled?: boolean;
  readonly strict?: boolean;
  readonly fetchFn?: typeof fetch;
}): Promise<CogLiveEvidenceEnvelope>;
