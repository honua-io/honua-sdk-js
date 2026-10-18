/** Experimental canonical dataset-import task contract; transfer admission is separate. */
export interface DatasetImportDestination {
  readonly schema: string;
  readonly table: string;
}
export interface DatasetImportArtifactSource {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly runId: string;
  readonly path: string;
}
export interface DatasetImportSource {
  readonly kind: "browser-file" | "local-process-artifact";
  readonly fileName: string;
  readonly totalBytes: number;
  readonly expectedSha256?: string | null;
  readonly artifact?: DatasetImportArtifactSource | null;
}
export interface DatasetImportTaskOptions {
  /** Current new-table slice supports Append (1); occupied destinations remain unsupported. */
  readonly loadMode: 1;
  readonly targetSrid: number;
  readonly sourceSrid?: number | null;
}
export interface CreateDatasetImportTask {
  /** Persist before POST; a lost reply is recovered by this original intent ID. */
  readonly intentId: string;
  readonly viewId: string;
  readonly contextRevision: number;
  readonly destination: DatasetImportDestination;
  readonly source: DatasetImportSource;
  readonly options: DatasetImportTaskOptions;
}
export interface DatasetImportTask {
  readonly taskId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly ownerActorId: string;
  readonly tenantId?: string | null;
  readonly targetId: string;
  readonly workspaceId: string;
  readonly destination: DatasetImportDestination;
  readonly source: DatasetImportSource;
  readonly options: DatasetImportTaskOptions;
  readonly uploadAdmissionDeadline: string;
}
export interface DatasetImportTaskReference {
  readonly taskId: string;
  readonly revision: number;
  readonly contentHash: string;
}
export interface DatasetImportAuthorityDescriptor {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentHash: string;
  readonly executorActorId: string;
  readonly initiatingHumanActorId?: string | null;
  readonly originatingTurnId: string;
  readonly originalTurnHash: string;
  readonly authorityRevision: number;
  readonly authorityFingerprint: string;
  readonly policyContextFingerprint: string;
  readonly uploadAdmissionDeadline: string;
  /** Preparation is not an accepted job receipt. */
  readonly preparedOperationId?: string | null;
}
export interface RenewDatasetImportAuthority {
  /** Persist before POST. Reuse it to recover the original renewal receipt. */
  readonly renewalId: string;
  readonly expectedAuthorityRevision: number;
  readonly taskContentHash: string;
}
export interface DatasetImportAuthorityRenewal {
  readonly renewalId: string;
  readonly previousAuthorityRevision: number;
  readonly authorityRevision: number;
  readonly authorityFingerprint: string;
  readonly renewedAt: string;
}
