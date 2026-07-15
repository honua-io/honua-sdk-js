export interface MigrationWorkbenchArtifactBuildOptions {
  repositoryRoot?: string;
  temporaryRoot?: string;
  keepWorkspace?: boolean;
  testHooks?: MigrationWorkbenchMaterializationTestHooks;
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
  guards: {
    preparedSdk: MigrationWorkbenchPreparedSdkIdentity;
    liveSourceIdentity: MigrationWorkbenchLiveSourceIdentity;
  };
  workspace: MigrationWorkbenchArtifactWorkspace;
}

export interface MigrationWorkbenchPreparedSdkIdentity {
  format: string;
  runId: string;
  inputs: {
    sha256: string;
    fileCount: number;
  };
  dist: {
    sha256: string;
    fileCount: number;
  };
  distSrc: {
    sha256: string;
    fileCount: number;
  };
}

export interface MigrationWorkbenchLiveSourceIdentity {
  fixtureEntries: readonly MigrationWorkbenchTreeEntry[];
  fixtureTreeSha256: string;
  expectedBehaviorBytes: Buffer;
  expectedBehaviorSha256: string;
  combinedSha256: string;
}

export interface MigrationWorkbenchPatchVerification {
  applyCheckCommand: {
    executable: "git";
    argv: string[];
    exitCode: 0;
  };
  applyCommand: {
    executable: "git";
    argv: string[];
    exitCode: 0;
  };
  applyCheckPassed: true;
  targetTreeEqual: true;
  directEntryComparisonPassed: true;
  sourceTreeSha256: string;
  targetTreeSha256: string;
  appliedTreeSha256: string;
}

export interface MigrationWorkbenchTreeEntry {
  relativePath: string;
  type: "file" | "directory";
  executable: boolean;
  byteLength: number;
  contentSha256: string;
  bytes: Buffer;
}

export interface MigrationWorkbenchMaterializationTestHooks {
  afterCommand?(
    commandId: string,
    repositoryRoot: string,
    sourceSnapshot: Readonly<{
      sourceSnapshotRoot: string;
      fixturePath: string;
      expectedBehaviorPath: string;
    }>,
  ): void;
  afterReplacement?(replacementCount: number, repositoryPath: string): void;
  beforePublication?(repositoryRoot: string, transactionRoot?: string): void;
  beforeCleanup?(transactionRoot: string, repositoryRoot: string): void;
}

export const MIGRATION_WORKBENCH_ARTIFACT_PATHS: readonly string[];

export function defaultRepositoryRoot(): string;

export function buildMigrationWorkbenchArtifacts(
  options?: MigrationWorkbenchArtifactBuildOptions,
): Promise<MigrationWorkbenchArtifactBuildResult>;

export function materializeMigrationWorkbenchArtifacts(options: {
  mode: "write" | "check";
  repositoryRoot?: string;
  testHooks?: MigrationWorkbenchMaterializationTestHooks;
}): Promise<{
  mode: "write" | "check";
  artifactCount: number;
  paths: string[];
}>;

export function materializeArtifactSet(options: {
  mode: "write" | "check";
  repositoryRoot: string;
  artifacts: Map<string, Buffer>;
  testHooks?: MigrationWorkbenchMaterializationTestHooks;
  publicationGuard?: () => void;
}): {
  mode: "write" | "check";
  artifactCount: number;
  paths: string[];
};

export function verifyMigrationPatch(options: {
  sourceTreePath: string;
  targetTreePath: string;
  patchBytes: Buffer;
  temporaryRoot: string;
}): MigrationWorkbenchPatchVerification;

export function compareUtf8(left: string, right: string): number;

export function captureRegularTree(rootPath: string): readonly MigrationWorkbenchTreeEntry[];

export function digestTreeSnapshot(entries: readonly MigrationWorkbenchTreeEntry[]): string;

export function hashRegularTree(rootPath: string): string;

export function regularTreeSnapshotsEqual(
  left: readonly MigrationWorkbenchTreeEntry[],
  right: readonly MigrationWorkbenchTreeEntry[],
): boolean;

export function executeIsolatedGeneratedModule(options: {
  repositoryRoot: string;
  generatedTargetBytes: Buffer;
  timeoutMs?: number;
}): {
  value: unknown;
  evidence: Record<string, unknown>;
};

export function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    encoding?: "utf8" | "buffer";
    label: string;
    timeoutMs: number;
    maxBuffer?: number;
    acceptedStatuses?: readonly number[];
    input?: string | Buffer;
  },
): {
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
};
