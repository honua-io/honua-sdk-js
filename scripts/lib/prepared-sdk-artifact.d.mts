export interface PreparedTreeEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PreparedTreeSnapshot {
  sha256: string;
  fileCount: number;
  entries: PreparedTreeEntry[];
}

export interface PreparedSdkManifest {
  format: string;
  runId: string;
  preparedAt: string;
  inputs: PreparedTreeSnapshot;
  dist: PreparedTreeSnapshot;
}

export const PREPARED_SDK_ARTIFACT_FORMAT: string;
export const PREPARED_SDK_RUN_ID_ENV: string;
export const PREPARED_SDK_MANIFEST_PATH: string;

export function manifestPathFor(projectRoot: string): string;
export function snapshotBuildInputs(projectRoot: string): PreparedTreeSnapshot;
export function snapshotDistTree(projectRoot: string): PreparedTreeSnapshot;
export function readPreparedSdkManifest(projectRoot: string): PreparedSdkManifest;
export function verifyPreparedSdkArtifact(options: {
  projectRoot: string;
  expectedRunId?: string;
  expectedInputSha256?: string;
  expectedDistSha256?: string;
  verifyTrees?: boolean;
}): PreparedSdkManifest;
export function verifyManifestArtifact(
  projectRoot: string,
  manifest: PreparedSdkManifest,
  relativePath: string,
): string;
export function prepareSdkArtifact(options: {
  projectRoot: string;
  mode?: "build-if-needed" | "force-build" | "already-prepared" | "capture" | "adopt-additions";
  runBuild?: () => void;
}): PreparedSdkManifest;
export function publishPreparedSdkManifest(
  projectRoot: string,
  inputs: PreparedTreeSnapshot,
  dist: PreparedTreeSnapshot,
): PreparedSdkManifest;
export function removePreparedSdkManifest(projectRoot: string): void;
