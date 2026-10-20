export declare const REALTIME_PREVIEW_EVIDENCE_FORMAT: "honua.realtime-preview-evidence.v2";
export type AuthorizationScenario = "token-expiry" | "token-revocation" | "tenant-isolation" | "tenant-scope-change";
export type AuthorizationTransport = "sse" | "websocket" | "odata";
export type AuthorizationSurface = "feature-stream" | "sensorthings";
export declare const AUTHORIZATION_SCENARIOS: readonly AuthorizationScenario[];
export declare const AUTHORIZATION_SURFACES: readonly {
  readonly surface: AuthorizationSurface;
  readonly transport: AuthorizationTransport;
}[];
export declare const ENFORCEMENT_BOUND_MS: 5000;
export declare const LIVE_AUTHORIZATION_TOPOLOGY: {
  readonly tenants: readonly ["tenant-a", "tenant-b"];
  readonly serviceId: string;
  readonly layers: { readonly "tenant-a": number; readonly "tenant-b": number };
  readonly datastreamId: number;
  readonly readerRole: string;
  readonly editorRole: string;
};

export interface TestIssuerConfiguration {
  readonly issuer: string;
  readonly audience: string;
  /** Never retained: the receipt carries only its SHA-256 through the issuer fingerprint. */
  readonly signingKey: string;
  readonly clockSkewSeconds: number;
}

export interface LiveAuthorizationOptions {
  readonly baseUrl: string;
  readonly adminApiKey: string;
  readonly serverRevision: string;
  readonly serverImage: string;
  readonly environment: string;
  readonly deploymentFingerprint: string | null;
  readonly referer: string;
  readonly issuer: TestIssuerConfiguration;
  readonly tokenExpirationMinutes: number;
  readonly sdk: { readonly package: string; readonly version: string; readonly revision: string };
  readonly workflow: {
    readonly repository: string;
    readonly name: string;
    readonly runId: string;
    readonly runAttempt: string;
    readonly startedAt: string;
  };
  readonly runTag?: string;
  /** Overrides for an in-process candidate on a compressed clock; the live lane uses the defaults. */
  readonly timing?: {
    readonly requestTimeoutMs?: number;
    readonly deliveryTimeoutMs?: number;
    readonly negativeSettleMs?: number;
    readonly observationSettleMs?: number;
  };
  readonly fetch?: typeof fetch;
  /** A `ws`-compatible WebSocket constructor. */
  readonly WebSocket?: unknown;
}

export interface AuthorizationAssertion {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface AuthorizationObservation {
  readonly at: string;
  readonly raw: string;
}

export interface AuthorizationRow {
  readonly surface: AuthorizationSurface;
  readonly transport: AuthorizationTransport;
  readonly scenario: AuthorizationScenario;
  readonly executed: boolean;
  readonly result: "passed" | "failed";
  readonly assertions: readonly AuthorizationAssertion[];
  readonly serverRevision: string;
  readonly serverImage: string;
  readonly sdkRevision: string;
  readonly sdkPackage: string;
  readonly environment: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly authorization: {
    readonly issuerFingerprint: string;
    readonly tenantIds: readonly string[];
    readonly resourceIds: readonly string[];
    readonly mutationIds: readonly string[];
    readonly issuedAt?: string;
    readonly expiresAt?: string;
    readonly revokedAt?: string;
    readonly terminatedAt?: string;
    readonly enforcementBoundMilliseconds?: number;
    readonly terminationReason?: "authorization-ended" | "unauthorized";
    readonly observations: readonly AuthorizationObservation[];
  };
}

export interface LiveAuthorizationReceipt {
  readonly format: typeof REALTIME_PREVIEW_EVIDENCE_FORMAT;
  readonly schemaVersion: 2;
  readonly lane: "live";
  readonly generatedAt: string;
  readonly collectorFailure?: string;
  readonly candidate?: Record<string, unknown>;
  readonly server?: { readonly revision: string; readonly image: string; readonly observed: Record<string, unknown> };
  readonly sdk?: LiveAuthorizationOptions["sdk"];
  readonly workflow?: LiveAuthorizationOptions["workflow"] & { readonly completedAt: string };
  readonly issuer?: Record<string, unknown>;
  readonly coverage?: { readonly scope: "authorization"; readonly rows: number; readonly passed: number; readonly failed: readonly string[] };
  readonly rows: readonly AuthorizationRow[];
}

export declare function normalizeLiveAuthorizationEnv(
  env?: Record<string, string | undefined>,
  projectRoot?: string,
): LiveAuthorizationOptions;
export declare function mintIssuerJwt(
  issuer: Pick<TestIssuerConfiguration, "issuer" | "audience" | "signingKey">,
  claims: {
    readonly subject: string;
    readonly tenant: string | null;
    readonly roles: readonly string[];
    readonly lifetimeSeconds?: number;
    readonly now?: number;
  },
): string;
export declare function issuerFingerprint(options: {
  readonly issuer: TestIssuerConfiguration;
  readonly referer: string;
  readonly tokenExpirationMinutes: number;
  readonly deploymentFingerprint?: string | null;
}): string;
export declare function isAuthorizationTermination(raw: unknown, transport: AuthorizationTransport): boolean;
export declare function authorizationTranscriptReasons(
  row: Pick<AuthorizationRow, "transport" | "scenario" | "assertions"> & { readonly authorization: unknown },
  workflow: { readonly startedAt?: string; readonly completedAt?: string },
): string[];
export declare function assertNoRetainedCredentials(document: unknown, secrets: Iterable<string>): void;
export declare function collectLiveAuthorizationReceipt(options: LiveAuthorizationOptions): Promise<LiveAuthorizationReceipt>;
export declare function summarizeLiveAuthorizationReceipt(receipt: LiveAuthorizationReceipt): string[];
