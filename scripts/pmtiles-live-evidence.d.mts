export interface PmtilesLiveEvidenceEnvelope {
  readonly format: "honua.sdk.pmtiles-direct-live-evidence.v1";
  readonly schemaVersion: 1;
  readonly status: "executed" | "failed" | "skipped";
  readonly reason: string | null;
  readonly observedAt: string;
  readonly lane: "scheduled-only";
  readonly authMode: "anonymous";
  readonly sdk: {
    readonly package: string;
    readonly version: string;
    readonly gitCommit: string;
  };
  readonly scope: {
    readonly directInspection: true;
    readonly managedPublicationLifecycle: false;
  };
  readonly [key: string]: unknown;
}

export interface ResolvedPmtilesArchive {
  readonly manifestUrl: string;
  readonly manifestFormat: "honua.demo-services.v1";
  readonly manifestSchemaVersion: string;
  readonly serviceId: string;
  readonly archiveId: string | null;
  readonly archiveUrl: string;
}

export function isPmtilesLiveEvidenceEnabled(env?: Readonly<Record<string, string | undefined>>): boolean;

export function resolvePmtilesArchive(
  manifest: unknown,
  manifestUrl: string,
  serviceId?: string,
): ResolvedPmtilesArchive;

export function runPmtilesLiveEvidence(options?: {
  readonly observedAt?: string;
  readonly enabled?: boolean;
  readonly fetchFn?: typeof fetch;
  readonly manifestUrl?: string;
  readonly serviceId?: string;
  readonly sourceRevision?: string;
  readonly timeoutMs?: number;
}): Promise<PmtilesLiveEvidenceEnvelope>;
