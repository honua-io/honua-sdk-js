import { describe, expect, it, vi } from "vitest";
import { DatasetImportServerJobSourceClient } from "../src/control-plane/dataset-import/server-job-source-client.js";
import type { DatasetImportServerJobSource, ServerJobImportSourcePage } from "../src/control-plane/dataset-import/types.js";
import { DatasetImportUploadClient } from "../src/control-plane/dataset-import/upload-client.js";

const digest = "a".repeat(64);
const options = { baseUrl: "https://honua.example/deployment", workspaceId: "workspace-original", targetId: "target-original" };
const request = { jobId: "gp-original", resultPackageId: "gp-original:v7", artifactId: "gp-original:artifact:1" };
const reference = { ...request, targetId: options.targetId, referenceSha256: digest };
const source = (): DatasetImportServerJobSource => ({
  kind: "server-job-artifact",
  fileName: "job-artifact.geojson",
  totalBytes: 2000,
  expectedSha256: digest,
  serverJobArtifact: {
    reference: { ...reference },
    producerActorId: "producer-original",
    producerTenantId: "tenant-original",
    crsState: "known",
    sourceSrid: 3857,
    featureCount: 1,
  },
});
const page = (): ServerJobImportSourcePage => ({
  targetId: options.targetId,
  jobId: request.jobId,
  resultPackageId: request.resultPackageId,
  artifacts: [{ artifactId: request.artifactId, kind: "FeatureCollection", label: "Artifact 1", canDescribeForImport: true }],
  totalArtifacts: 1,
  nextOffset: null,
});

describe("Server-owned job source handoff", () => {
  it("pins the original selection before fresh authentication and projects no storage locations or bulk bytes", async () => {
    let release!: (headers: HeadersInit) => void;
    const credentials = new Promise<HeadersInit>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => Response.json({ ...source(), uri: "file:///private/output", features: ["bulk"] }));
    const mutable = { ...request };
    const client = new DatasetImportServerJobSourceClient({ ...options, originatingTurnId: "turn-original", fetch: fetcher, headers: () => credentials });
    const pending = client.describe(mutable);
    mutable.jobId = "gp-later";
    mutable.artifactId = "gp-later:artifact:1";
    release({ Authorization: "Bearer fresh", "X-Honua-Turn": "injected" });
    expect(await pending).toEqual(source());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://honua.example/deployment/api/v1/agent/workspaces/workspace-original/dataset-import-sources/server-job-artifact");
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fresh");
    expect(new Headers(init.headers).get("X-Honua-Turn")).toBe("turn-original");
    expect(init.redirect).toBe("error");
  });

  it("continues only the original package and returns metadata without unexpected provider fields", async () => {
    const choices = [51, 52].map((ordinal) => ({ artifactId: `gp-original:artifact:${ordinal}`, kind: "FeatureCollection", label: `Artifact ${ordinal}`, canDescribeForImport: ordinal === 51, uri: "s3://private/output" }));
    let authentication = 0;
    const fetcher = vi.fn(async () => Response.json({ ...page(), artifacts: choices, totalArtifacts: 52, providerObjectKey: "private", features: ["bulk"] }));
    const client = new DatasetImportServerJobSourceClient({ ...options, fetch: fetcher, headers: () => ({ Authorization: `Bearer ${++authentication}` }) });
    const result = await client.list({ jobId: request.jobId, resultPackageId: request.resultPackageId, offset: 50 });
    expect(result?.artifacts).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/private|bulk|uri|providerObjectKey/);
    expect(result?.nextOffset).toBeNull();
    await client.list({ jobId: request.jobId, resultPackageId: request.resultPackageId, offset: 50 });
    expect(authentication).toBe(2);
    await expect(client.list({ jobId: request.jobId, offset: 50 })).rejects.toThrow("original result package");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes the Server's omitted terminal cursor and nullable producer fields", async () => {
    const wireSource = source();
    Object.assign(wireSource.serverJobArtifact, { crsState: "unknown", sourceSrid: undefined, producerTenantId: undefined });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...page(), nextOffset: undefined })).mockResolvedValueOnce(Response.json(wireSource));
    const client = new DatasetImportServerJobSourceClient({ ...options, fetch: fetcher });
    expect((await client.list({ jobId: request.jobId }))?.nextOffset).toBeNull();
    expect((await client.describe(request))?.serverJobArtifact).toMatchObject({ crsState: "unknown", sourceSrid: null, producerTenantId: null });
  });

  it.each([
    { targetId: "other-target" },
    { jobId: "other-job" },
    { resultPackageId: "gp-original:v8" },
    { nextOffset: 1 },
    { artifacts: [{ ...page().artifacts[0], artifactId: "gp-original:artifact:2" }] },
    { artifacts: [{ ...page().artifacts[0], label: "s3://private/output" }] },
  ])("refuses changed discovery identity or inconsistent metadata: %j", async (change) => {
    const client = new DatasetImportServerJobSourceClient({ ...options, fetch: vi.fn(async () => Response.json({ ...page(), ...change })) });
    await expect(client.list({ jobId: request.jobId, resultPackageId: request.resultPackageId })).rejects.toThrow();
  });

  it("preserves unknown CRS for an explicit human choice and returns null for unavailable sources", async () => {
    const unknown = source();
    Object.assign(unknown.serverJobArtifact, { crsState: "unknown", sourceSrid: null });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(unknown)).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = new DatasetImportServerJobSourceClient({ ...options, fetch: fetcher });
    expect(await client.describe(request)).toEqual(unknown);
    expect(await client.describe(request)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { reference: { ...reference, targetId: "other-target" } },
    { reference: { ...reference, artifactId: "gp-original:artifact:2" } },
    { reference: { ...reference, referenceSha256: "unverified" } },
    { crsState: "unknown", sourceSrid: 4326 },
    { crsState: "mixed", sourceSrid: null },
    { sourceSrid: 0 },
    { featureCount: 0 },
  ])("refuses an inconsistent source description: %j", async (change) => {
    const value = source();
    Object.assign(value.serverJobArtifact, change);
    const client = new DatasetImportServerJobSourceClient({ ...options, fetch: vi.fn(async () => Response.json(value)) });
    await expect(client.describe(request)).rejects.toThrow();
  });

  it("does not send a URI in place of a canonical artifact identity", async () => {
    const fetcher = vi.fn();
    const client = new DatasetImportServerJobSourceClient({ ...options, fetch: fetcher });
    await expect(client.describe({ ...request, artifactId: "file:///private/output" })).rejects.toThrow("artifact identity");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Server job transfer through the original upload", () => {
  const task = { taskId: "import-task-original", revision: 3, contentHash: digest };
  const receipt = () => ({ taskId: task.taskId, taskRevision: 3, taskContentHash: digest, uploadId: "b".repeat(32), version: 5, state: "sealed", acceptedBytes: 2000, totalBytes: 2000, chunkBytes: 65536, chunkCount: 1, expiresAt: "2026-10-21T00:00:00Z", contentSha256: digest, sourceRetention: { bytes: 2000, sha256: digest } });

  it("preserves a lost transfer reply as unknown and reads the original receipt without retrying a mutation", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("reply lost")).mockResolvedValueOnce(Response.json(receipt()));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    await expect(client.transferServerJobArtifact(task)).rejects.toThrow("reply lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.read(task)).toEqual(receipt());
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain("/dataset-import-tasks/import-task-original/versions/3/upload/server-job-artifact");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ taskContentHash: digest });
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
    expect(fetcher.mock.calls[1][0]).toContain(`contentHash=${digest}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("requires a retained canonical receipt and does not accept a different task", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(receipt())).mockResolvedValueOnce(Response.json({ ...receipt(), sourceRetention: null })).mockResolvedValueOnce(Response.json({ ...receipt(), taskRevision: 4 }));
    const client = new DatasetImportUploadClient({ ...options, fetch: fetcher });
    expect(await client.transferServerJobArtifact(task)).toEqual(receipt());
    await expect(client.transferServerJobArtifact(task)).rejects.toThrow("retained source");
    await expect(client.transferServerJobArtifact(task)).rejects.toThrow("immutable task");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
