export interface MigrationWorkbenchArtifactBuildOptions {
  repositoryRoot?: string;
  temporaryRoot?: string;
  keepWorkspace?: boolean;
}

export interface MigrationWorkbenchArtifactWorkspace {
  temporaryRoot: string;
  sourceTreePath: string;
  targetTreePath: string;
}

export interface MigrationWorkbenchArtifactBuildResult {
  artifacts: Map<string, Buffer>;
  manifest: Record<string, unknown>;
  commands: readonly Record<string, unknown>[];
  workspace: MigrationWorkbenchArtifactWorkspace;
}

export interface MigrationWorkbenchPatchVerification {
  applyCheckPassed: true;
  targetTreeEqual: true;
  sourceTreeSha256: string;
  targetTreeSha256: string;
  appliedTreeSha256: string;
}

export const MIGRATION_WORKBENCH_ARTIFACT_PATHS: readonly string[];

export function defaultRepositoryRoot(): string;

export function buildMigrationWorkbenchArtifacts(
  options?: MigrationWorkbenchArtifactBuildOptions,
): Promise<MigrationWorkbenchArtifactBuildResult>;

export function materializeMigrationWorkbenchArtifacts(options: {
  mode: "write" | "check";
  repositoryRoot?: string;
}): Promise<{
  mode: "write" | "check";
  artifactCount: number;
  paths: string[];
}>;

export function verifyMigrationPatch(options: {
  sourceTreePath: string;
  targetTreePath: string;
  patchBytes: Buffer;
  temporaryRoot: string;
}): MigrationWorkbenchPatchVerification;
