export interface SampleCatalog {
  format: "honua.sdk.sample-catalog.v2";
  schemaVersion: 2;
  sdk: { package: string };
  samples: Array<Record<string, unknown>>;
  siteMappings: Array<Record<string, unknown>>;
  goldenJourneys: GoldenJourney[];
  qualityProfiles: Array<Record<string, unknown>>;
}

export interface GoldenJourney {
  id: string;
  title: string;
  status: "planned" | "qualified";
  candidateSampleId: string;
}

export interface ProjectedSample {
  id: string;
  track: "golden" | "recipe" | "lab" | "fixture";
  supportTier: "supported" | "experimental" | "internal" | "deprecated";
  lifecycle: Record<string, unknown>;
  validationProfile: string;
  sdk: { package: string; version: string };
}

export interface CiSelectedSample {
  id: string;
  track: "golden" | "recipe" | "lab" | "fixture";
  supportTier: "supported" | "experimental" | "internal" | "deprecated";
  validationProfile: string;
  commandPlan: {
    validation: { execution: "automatic"; commands: string[] };
    fixtureEvidence: { execution: "orchestrated"; commands: string[] };
    liveEvidence: { execution: "scheduled-only"; commands: string[] };
  };
}

export interface SiteProjection {
  format: "honua.site.sdk-sample-projection.v2";
  schemaVersion: 2;
  catalog: {
    format: "honua.sdk.sample-catalog.v2";
    schemaVersion: 2;
    package: string;
    version: string;
  };
  contract: {
    producer: string;
    consumer: string;
    executableSourceOwner: string;
    presentationOwner: string;
  };
  samples: ProjectedSample[];
  routes: Array<Record<string, unknown>>;
  goldenJourneys: GoldenJourney[];
  externalReplacements: Array<{ id: string; title: string; url: string }>;
  qualityProfiles: Array<Record<string, unknown>>;
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

export interface CapabilitySampleMatrix {
  format: "honua.site.sdk-capability-sample-matrix.v1";
  schemaVersion: 1;
  sdk: { package: string; version: string };
  samples: Array<Record<string, unknown>>;
  goldenJourneys: Array<Record<string, unknown>>;
  protocolOperations: Array<Record<string, unknown>>;
  supportClaims: Array<Record<string, unknown>>;
  entrypoints: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
}

export function parseJsonDocument<T = unknown>(source: string, label?: string): T;

export function migrateCatalogV1ToV2(
  catalog: Record<string, unknown>,
  migration: Record<string, unknown>,
): Promise<SampleCatalog>;
export function compareReleases(left: string, right: string): number;
export function isRunnableRootExampleDirectory(name: string, markers: string[]): boolean;
export function validateCatalog(
  catalog: SampleCatalog,
  packageJson: Record<string, unknown>,
  options?: {
    now?: string;
    sourceRevision?: string;
    receiptRoot?: string;
    verifyCheckout?: boolean;
  },
): Promise<void>;
export function effectiveCatalog(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): SampleCatalog & { sdk: { package: string; version: string } };
export function generateSiteProjection(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): SiteProjection;
export function generateCiSelection(catalog: SampleCatalog): {
  profiles: Array<Record<string, unknown>>;
  samples: CiSelectedSample[];
};
export function validateSiteProjection(projection: unknown): Promise<void>;
export function generateSiteVisualEvidence(
  catalog: SampleCatalog,
  projection: SiteProjection,
  options?: { now?: string; verifyCheckout?: boolean },
): Promise<Record<string, unknown>>;
export function validateSiteVisualEvidence(
  evidence: unknown,
  projection?: unknown,
  options?: { now?: string },
): Promise<void>;
export function generateCapabilitySampleMatrix(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string; exports: Record<string, unknown> },
  supportManifest: Record<string, unknown>,
  kitManifest: Record<string, unknown>,
  visualEvidence: Record<string, unknown>,
): CapabilitySampleMatrix;
export function validateCapabilitySampleMatrix(
  matrix: unknown,
  inputs?: {
    catalog?: SampleCatalog;
    packageJson?: Record<string, unknown>;
    supportManifest?: Record<string, unknown>;
    kitManifest?: Record<string, unknown>;
    visualEvidence?: Record<string, unknown>;
  },
): Promise<void>;
export function validateSiteConsumerFixture(
  fixture: unknown,
  projection?: unknown,
  visualEvidence?: unknown,
  capabilityMatrix?: unknown,
): Promise<void>;
export function validateCiSelection(selection: unknown): Promise<void>;
export function generatedOutputs(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
  options?: { now?: string; verifyCheckout?: boolean },
): Promise<Map<string, string>>;
export function generatedOutputDrift(
  expectedOutputs: Map<string, string>,
  currentOutputs: Map<string, string>,
): string[];
export function extractSampleConfiguration(
  sourcePath: string,
  exemptions?: Array<{ name: string }>,
): Promise<string[]>;
export interface SampleConfigurationInspection {
  names: string[];
  wholeEnvironmentEscapes: Array<{
    file: string;
    line: number;
    column: number;
    roots: Array<"process.env" | "import.meta.env">;
    reason: string;
  }>;
}
export function inspectSampleConfiguration(
  sourcePath: string,
  exemptions?: Array<{ name: string }>,
): Promise<SampleConfigurationInspection>;
export function validateFixtureBuildHarnessSource(source: string, file?: string, expectedBuildScript?: string): number;
export function validateFixtureBuildHarnesses(): Promise<number>;
export function classifyConfigurationName(name: string): {
  name: string;
  exposure: "browser-public" | "server-only";
  valueKind: "credential" | "non-secret";
  credentialScope?: "public-token" | "secret";
};
export function validateEvidenceEnvelope<T>(
  evidence: T,
  options?: { now?: string; maxFutureSkewSeconds?: number },
): T;
export function validateLiveEvidenceProducer(
  evidence: Record<string, unknown>,
  sample: Record<string, unknown>,
): Promise<void>;
export function buildBrowserArtifactManifest(options: {
  artifacts: Array<{ path: string; entrypoint: string; mediaType?: string }>;
  gitCommit: string;
}): Promise<BrowserArtifactManifest>;
export function verifyBrowserArtifactManifest(manifest: BrowserArtifactManifest): Promise<void>;
