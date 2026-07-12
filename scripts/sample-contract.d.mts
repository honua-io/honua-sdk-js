export interface SampleCatalog {
  format: "honua.sdk.sample-catalog.v1";
  schemaVersion: 1;
  sdk: { package: string };
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
export function effectiveCatalog(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): SampleCatalog & { sdk: { package: string; version: string } };
export function generateSiteProjection(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): { routes: Array<Record<string, unknown>> };
export function generatedOutputs(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): Promise<Map<string, string>>;
export function generatedOutputDrift(
  expectedOutputs: Map<string, string>,
  currentOutputs: Map<string, string>,
): string[];
export function validateEvidenceEnvelope<T>(evidence: T): T;
export function validateLiveEvidenceProducer(
  evidence: Record<string, unknown>,
  sample: Record<string, unknown>,
): Promise<void>;
export function buildBrowserArtifactManifest(options: {
  artifacts: Array<{ path: string; entrypoint: string; mediaType?: string }>;
  gitCommit: string;
}): Promise<BrowserArtifactManifest>;
export function verifyBrowserArtifactManifest(manifest: BrowserArtifactManifest): Promise<void>;
