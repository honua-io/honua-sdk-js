export interface ImageryTerrainLiveEvidenceEnvelope {
  readonly format: "honua.sdk.sample-evidence.v1";
  readonly sampleId: "imagery-cog-quickstart";
  readonly lane: "live";
  readonly status: "executed" | "failed" | "skipped" | "credential-unavailable";
  readonly reason: string | null;
  readonly authMode: "anonymous";
  readonly semantics: {
    readonly operation: string;
    readonly outcome: string | null;
    readonly itemCount: number | null;
    readonly assertions: readonly string[];
  };
  readonly degradation: {
    readonly state: "none" | "expected" | "unexpected" | "unavailable";
    readonly reasons: readonly string[];
  };
  readonly [key: string]: unknown;
}

export const IMAGERY_TERRAIN_LIVE_TARGET: Readonly<{
  provider: string;
  itemId: string;
  collectionId: string;
  acquiredAt: string;
  itemUrl: string;
  assetUrl: string;
  licenseUrl: string;
  mediaType: string;
  epsg: number;
  cloudCover: number;
  bbox: readonly [number, number, number, number];
  objectBytes: number;
  etag: string;
  lastModified: string;
}>;

export const IMAGERY_TERRAIN_LIVE_PRODUCER_ARTIFACT: Readonly<{
  kind: "producer-generator";
  path: "scripts/imagery-terrain-live-evidence.mjs";
  sha256: string;
}>;

export function validatePinnedLiveUrl(value: string, label?: string): string;

export function collectImageryTerrainLiveEvidence(options?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly packageJson?: Readonly<{ name: string; version: string }>;
  readonly now?: () => number;
}): Promise<ImageryTerrainLiveEvidenceEnvelope>;
