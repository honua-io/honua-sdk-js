import type { DatasetImportTaskClientOptions } from "./client.js";
import { DatasetImportWorkspaceTransport, validId } from "./transport.js";
import type {
  DatasetImportServerJobSource,
  DescribeServerJobImportSource,
  ListServerJobImportSources,
  ServerJobImportSourcePage,
} from "./types.js";

/**
 * Optional preview Server-job source APIs. Requires an installed Server that
 * advertises these capabilities. Discovery is metadata-only; describe verifies
 * the original output without returning its bytes or storage location. Server
 * authorization remains authoritative on every observation and transfer.
 */
export class DatasetImportServerJobSourceClient {
  private readonly transport: DatasetImportWorkspaceTransport;
  private readonly targetId: string;

  constructor(options: DatasetImportTaskClientOptions) {
    this.transport = new DatasetImportWorkspaceTransport(options);
    this.targetId = options.targetId;
  }

  async list(request: ListServerJobImportSources, signal?: AbortSignal): Promise<ServerJobImportSourcePage | null> {
    const { jobId, offset = 0, resultPackageId = null } = request;
    validId(jobId);
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && resultPackageId === null))
      throw new TypeError("Continuation requires a nonnegative offset and the original result package.");
    if (resultPackageId !== null) validPackage(jobId, resultPackageId);
    const value = await this.transport.request<ServerJobImportSourcePage>(
      "/dataset-import-sources/server-job-artifacts",
      "POST",
      JSON.stringify({ jobId, offset, resultPackageId }),
      signal,
      true,
    );
    if (value === null) return null;
    if (value.targetId !== this.targetId || value.jobId !== jobId)
      throw new Error("The job source page changed deployment or job identity.");
    validPackage(jobId, value.resultPackageId);
    if (resultPackageId !== null && value.resultPackageId !== resultPackageId)
      throw new Error("The job source page changed the original result version.");
    // AgentWorkspaceJsonContext omits null members on the wire.
    const nextOffset = value.nextOffset ?? null;
    if (
      !Number.isSafeInteger(value.totalArtifacts) ||
      value.totalArtifacts < offset ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length !== Math.min(50, value.totalArtifacts - offset) ||
      nextOffset !== (offset + value.artifacts.length < value.totalArtifacts ? offset + value.artifacts.length : null)
    )
      throw new Error("The job source page has an inconsistent bounded continuation.");
    const artifacts = value.artifacts.map((choice, index) => {
      if (
        !choice ||
        choice.artifactId !== `${jobId}:artifact:${offset + index + 1}` ||
        typeof choice.kind !== "string" ||
        !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(choice.kind) ||
        typeof choice.label !== "string" ||
        !/^[A-Za-z0-9 _.\-]{1,128}$/.test(choice.label) ||
        typeof choice.canDescribeForImport !== "boolean"
      )
        throw new Error("The job source page contains an invalid artifact identity or metadata.");
      return {
        artifactId: choice.artifactId,
        kind: choice.kind,
        label: choice.label,
        canDescribeForImport: choice.canDescribeForImport,
      };
    });
    // Project only the supported metadata: never propagate unexpected bulk or
    // storage-location members to an agent through a loosely typed JSON object.
    return {
      targetId: value.targetId,
      jobId,
      resultPackageId: value.resultPackageId,
      artifacts,
      totalArtifacts: value.totalArtifacts,
      nextOffset,
    };
  }

  async describe(request: DescribeServerJobImportSource, signal?: AbortSignal): Promise<DatasetImportServerJobSource | null> {
    const { jobId, resultPackageId, artifactId } = request;
    validId(jobId);
    validPackage(jobId, resultPackageId);
    validArtifact(jobId, artifactId);
    const source = await this.transport.request<DatasetImportServerJobSource>(
      "/dataset-import-sources/server-job-artifact",
      "POST",
      JSON.stringify({ jobId, resultPackageId, artifactId }),
      signal,
      true,
    );
    if (source === null) return null;
    const output = source.serverJobArtifact;
    const reference = output?.reference;
    if (
      source.kind !== "server-job-artifact" ||
      source.fileName !== "job-artifact.geojson" ||
      !positiveInteger(source.totalBytes) ||
      !digest(source.expectedSha256) ||
      source.artifact != null ||
      source.browserSelectionId != null ||
      !reference ||
      reference.targetId !== this.targetId ||
      reference.jobId !== jobId ||
      reference.resultPackageId !== resultPackageId ||
      reference.artifactId !== artifactId ||
      !digest(reference.referenceSha256) ||
      !positiveInteger(output.featureCount) ||
      (output.crsState === "known"
        ? !positiveInteger(output.sourceSrid) || output.sourceSrid > 2147483647
        : output.crsState !== "unknown" || output.sourceSrid != null)
    )
      throw new Error("The job source description changed its original identity or content/coordinate contract.");
    if (!principalText(output.producerActorId, 2048) ||
      (output.producerTenantId != null && !principalText(output.producerTenantId, 512, true)))
      throw new Error("The job source producer identity is outside the Server contract.");
    return {
      kind: "server-job-artifact",
      fileName: source.fileName,
      totalBytes: source.totalBytes,
      expectedSha256: source.expectedSha256,
      serverJobArtifact: {
        reference: { targetId: this.targetId, jobId, resultPackageId, artifactId, referenceSha256: reference.referenceSha256 },
        producerActorId: output.producerActorId,
        producerTenantId: output.producerTenantId ?? null,
        crsState: output.crsState,
        sourceSrid: output.sourceSrid ?? null,
        featureCount: output.featureCount,
      },
    };
  }
}

function validPackage(jobId: string, value: string): void {
  validId(value);
  if (!value.startsWith(`${jobId}:v`) || !/^[1-9][0-9]*$/.test(value.slice(jobId.length + 2)))
    throw new TypeError("The original versioned job result package is required.");
}

function validArtifact(jobId: string, value: string): void {
  validId(value);
  const prefix = `${jobId}:artifact:`;
  if (!value.startsWith(prefix) || !/^[1-9][0-9]*$/.test(value.slice(prefix.length)))
    throw new TypeError("The original job artifact identity is required.");
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

// Principal identifiers have different Server bounds from workspace/job IDs.
function principalText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maximum &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && (code < 127 || code > 159);
    });
}
