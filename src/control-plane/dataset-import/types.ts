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
  readonly kind: "browser-file" | "local-process-artifact" | "server-job-artifact";
  readonly fileName: string;
  readonly totalBytes: number;
  readonly expectedSha256?: string | null;
  readonly artifact?: DatasetImportArtifactSource | null;
  /** Original human file selection captured by the immutable originating turn. */
  readonly browserSelectionId?: string | null;
  readonly serverJobArtifact?: DatasetImportServerJobArtifactSource | null;
}

/** Exact Server-owned result identity; no caller-supplied location or bulk content. */
export interface DatasetImportServerJobArtifactReference {
  readonly targetId: string;
  readonly jobId: string;
  readonly resultPackageId: string;
  readonly artifactId: string;
  readonly referenceSha256: string;
}

/** Server recomputes this description at task creation; it is not execution authority. */
export interface DatasetImportServerJobArtifactSource {
  readonly reference: DatasetImportServerJobArtifactReference;
  readonly producerActorId: string;
  readonly producerTenantId: string | null;
  readonly crsState: "known" | "unknown";
  readonly sourceSrid: number | null;
  readonly featureCount: number;
}

export interface DatasetImportServerJobSource extends DatasetImportSource {
  readonly kind: "server-job-artifact";
  readonly expectedSha256: string;
  readonly serverJobArtifact: DatasetImportServerJobArtifactSource;
}

export interface ListServerJobImportSources {
  readonly jobId: string;
  readonly offset?: number;
  /** Required for continuation, preserving the exact original result version. */
  readonly resultPackageId?: string | null;
}

export interface DescribeServerJobImportSource {
  readonly jobId: string;
  readonly resultPackageId: string;
  readonly artifactId: string;
}

export interface ServerJobImportSourceChoice {
  readonly artifactId: string;
  readonly kind: string;
  readonly label: string;
  /** Envelope eligibility only; describe still verifies content, CRS and current access. */
  readonly canDescribeForImport: boolean;
}

export interface ServerJobImportSourcePage {
  readonly targetId: string;
  readonly jobId: string;
  readonly resultPackageId: string;
  readonly artifacts: readonly ServerJobImportSourceChoice[];
  readonly totalArtifacts: number;
  readonly nextOffset: number | null;
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

/** Describes a retained receipt; it does not prove the storage object still exists. */
export interface DatasetImportSourceRetentionReceipt {
  readonly bytes: number;
  readonly sha256: string;
  readonly expiresAt?: string | null;
}
/** Task-bound transfer receipt. Sealing/retaining never accepts an import job. */
export interface DatasetImportUploadReceipt {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentHash: string;
  readonly uploadId: string;
  readonly version: number;
  readonly state: "receiving" | "sealed" | "cancelled";
  readonly acceptedBytes: number;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly chunkCount: number;
  readonly expiresAt: string;
  readonly contentSha256?: string | null;
  readonly sourceRetention?: DatasetImportSourceRetentionReceipt | null;
}
export interface DatasetImportUploadCapabilities {
  readonly chunkBytes: number;
  readonly maximumFileBytes: number;
  readonly importAcceptanceSupported: boolean;
}

/** Current authority tuple explicitly reviewed before human preparation or actual executor submission. */
export interface SubmitDatasetImport {
  readonly taskContentHash: string;
  readonly authorityRevision: number;
  readonly authorityFingerprint: string;
  readonly policyContextFingerprint: string;
}
/** Actual persisted successful provider output, never inferred from the requested destination. */
export interface DatasetImportOutputReceipt {
  readonly physicalTableName: string;
  readonly schema: string;
  readonly featureCount: number;
  readonly detectedSrid?: number | null;
}
export interface DatasetImportJobReceipt {
  readonly jobId: string;
  readonly leaseId: string;
  readonly status: "queued" | "provisioning" | "running" | "succeeded" | "failed" | "cancelled";
  /** The accepted operation is checking a durable commit decision; never permission to resubmit. */
  readonly outcomePending?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
  readonly percentComplete?: number | null;
  readonly output?: DatasetImportOutputReceipt | null;
  readonly errorCode?: string | null;
}
/** Preparation awaits the actual agent; only accepted contains a real durable job receipt. */
export interface DatasetImportSubmissionReceipt {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentHash: string;
  readonly state: "not-prepared" | "prepared" | "accepted";
  readonly operationId?: string | null;
  readonly authorityRevision?: number | null;
  readonly authorityFingerprint?: string | null;
  readonly policyContextFingerprint?: string | null;
  readonly acceptBefore?: string | null;
  readonly job?: DatasetImportJobReceipt | null;
}
