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

export type SampleCoverageState = "qualified" | "partial" | "planned" | "experimental" | "unsupported";

export interface QualificationEvidenceInventory {
  format: "honua.sdk.sample-qualification-evidence.v1";
  schemaVersion: 1;
  samples: Array<{
    sampleId: string;
    receipts: Array<{
      gate: string;
      sdkMode: "source" | "packed";
      sourceRevision: string;
      sourceDigest: string;
      runRoot: string;
      observedAt: string;
      expiresAt: string;
      path: string;
      sha256: string;
      artifact: { kind: string; path: string; bytes: number; sha256: string };
    }>;
  }>;
}

export interface MatrixCoverage {
  state: SampleCoverageState;
  reason: string;
  candidateSampleIds: string[];
  qualifyingSampleIds: string[];
  evidenceBindingIds: string[];
  selectedSampleId?: string;
}

export interface MatrixReceiptEvidenceBinding {
  gate: string;
  sdkMode: "source" | "packed";
  receiptPath: string;
  receiptSha256: string;
  runRoot: string;
  observedAt: string;
  expiresAt: string;
  reportKind: string;
  reportPath: string;
  reportBytes: number;
  reportSha256: string;
}

export interface MatrixEvidenceBinding {
  id: string;
  sampleId: string;
  source: {
    repository: "honua-io/honua-sdk-js";
    path: string;
    revision: string;
    evidenceNeutralSha256: string;
    receipts: MatrixReceiptEvidenceBinding[];
  };
  packed: MatrixReceiptEvidenceBinding & { gate: "packed-build"; sdkMode: "packed" };
}

export interface CapabilitySampleMatrix {
  format: "honua.site.sdk-capability-sample-matrix.v1";
  schemaVersion: 1;
  sdk: { package: string; version: string };
  inputs: Record<string, Record<string, unknown>>;
  statusVocabulary: { coverage: SampleCoverageState[]; support: string[] };
  dimensions: Record<string, string[]>;
  goldenJourneys: Array<{
    id: string;
    title: string;
    candidateSampleId: string;
    catalogStatus: "planned" | "qualified";
    supportStatus: string;
    coverage: MatrixCoverage;
  }>;
  samples: Array<Record<string, unknown> & { id: string; qualification: { state: SampleCoverageState } }>;
  evidenceBindings: MatrixEvidenceBinding[];
  protocolOperations: Array<Record<string, unknown> & { id: string; coverage: MatrixCoverage }>;
  supportClaims: Array<Record<string, unknown> & { id: string; coverage: MatrixCoverage }>;
  packageEntrypoints: Array<Record<string, unknown> & { subpath: string; coverage: MatrixCoverage }>;
  gaps: Array<Record<string, unknown>>;
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
    qualificationBootstrapSampleId?: string;
  },
): Promise<void>;
export function effectiveCatalog(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): SampleCatalog & { sdk: { package: string; version: string } };
export function generateSiteProjection(
  catalog: SampleCatalog,
  packageJson: { name: string; version: string },
): {
  samples: ProjectedSample[];
  routes: Array<Record<string, unknown>>;
  goldenJourneys: GoldenJourney[];
  externalReplacements: Array<{ id: string; title: string; url: string }>;
};
export function collectQualificationEvidence(
  catalog: SampleCatalog,
  options?: { receiptRoot?: string },
): Promise<QualificationEvidenceInventory>;
export function generateCapabilitySampleMatrix(
  catalog: SampleCatalog,
  packageJson: Record<string, unknown>,
  supportTruth: Record<string, unknown>,
  qualificationEvidence: QualificationEvidenceInventory,
): CapabilitySampleMatrix;
export function validateCapabilitySampleMatrix(
  matrix: unknown,
  inputs?: {
    catalog?: SampleCatalog;
    packageJson?: Record<string, unknown>;
    supportTruth?: Record<string, unknown>;
    qualificationEvidence?: QualificationEvidenceInventory;
  },
): Promise<void>;
export function generateCiSelection(catalog: SampleCatalog): {
  profiles: Array<Record<string, unknown>>;
  samples: CiSelectedSample[];
};
export function validateSiteProjection(projection: unknown): Promise<void>;
export function validateCiSelection(selection: unknown): Promise<void>;
export function generatedOutputs(
  catalog: SampleCatalog,
  packageJson: Record<string, unknown> & { name: string; version: string },
  options?: {
    supportTruth?: Record<string, unknown>;
  },
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
