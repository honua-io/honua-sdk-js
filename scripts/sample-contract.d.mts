export interface SampleCatalog {
  format: "honua.sdk.sample-catalog.v1";
  schemaVersion: 1;
  sdk: { package: string; version: string };
  samples: Array<Record<string, unknown>>;
  siteMappings: Array<Record<string, unknown>>;
}

export interface BrowserArtifactManifest {
  format: "honua.sdk.browser-artifacts.v1";
  schemaVersion: 1;
  package: { name: string; version: string; gitCommit: string };
  build: { inputs: Array<{ path: string; sha256: string }> };
  compatibility: { peers: Record<string, string> };
  files: Array<{
    path: string;
    entrypoint: string;
    mediaType: string;
    bytes: number;
    integrity: string;
    sha256: string;
  }>;
}

export function validateCatalog(catalog: SampleCatalog, packageJson: Record<string, unknown>): Promise<void>;
export function generateSiteProjection(catalog: SampleCatalog): { routes: Array<Record<string, unknown>> };
export function validateEvidenceEnvelope<T>(evidence: T): T;
export function buildBrowserArtifactManifest(options: {
  artifacts: Array<{ path: string; entrypoint: string; mediaType?: string }>;
  gitCommit: string;
}): Promise<BrowserArtifactManifest>;
export function verifyBrowserArtifactManifest(manifest: BrowserArtifactManifest): Promise<void>;
