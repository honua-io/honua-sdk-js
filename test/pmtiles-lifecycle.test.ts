import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/honua.js";
import {
  HonuaPmtilesLifecycleError,
  PMTILES_LIFECYCLE_CAPABILITIES,
  assertPmtilesManualCleanupSupported,
  createHonuaPmtilesLifecycle,
  pmtilesCleanupDisposition,
  registerPmtilesSource,
  requirePmtilesJobSuccess,
} from "../src/pmtiles/index.js";

const startedAt = "2026-08-08T12:00:00.000Z";
const publishedAt = "2026-08-08T12:01:00.000Z";

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactId: "maui-7-webmercatorquad",
    storageProvider: "AwsS3",
    bucket: "honua-tiles",
    objectKey: "pmtiles/maui/7/WebMercatorQuad.pmtiles",
    contentType: "application/vnd.pmtiles",
    sizeBytes: 4096,
    urlStrategy: "RangeProxy",
    accessUrl: "/api/v1/tiles/pmtiles/maui-7-webmercatorquad",
    accessUrlExpiresAt: null,
    publishedAt,
    minZoom: 0,
    maxZoom: 12,
    bounds: [-156.8, 20.5, -155.9, 21.1],
    layerId: 7,
    serviceId: "Maui",
    tileMatrixSetId: "WebMercatorQuad",
    ...overrides,
  };
}

function progress(status: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-1",
    operation: "publish",
    serviceId: "Maui",
    layerId: 7,
    tileMatrixSetId: "WebMercatorQuad",
    status,
    totalTiles: 10,
    processedTiles: status === 2 ? 10 : 4,
    successfulTiles: status === 2 ? 10 : 4,
    failedTiles: 0,
    archiveSizeBytes: status === 2 ? 4096 : 0,
    archiveFileId: null,
    downloadUrl: null,
    publishedArtifact: status === 2 ? artifact() : null,
    startedAt,
    completedAt: status === 2 ? publishedAt : null,
    errorMessage: null,
    warnings: [],
    currentPhase: status === 2 ? "Completed" : "Building archive",
    ...overrides,
  };
}

describe("Honua-managed PMTiles lifecycle", () => {
  it("submits and polls through the authenticated pipeline, then registers the durable proxy", async () => {
    const requests: Request[] = [];
    let polls = 0;
    const client = new HonuaClient({
      baseUrl: "https://honua.example.test",
      auth: {
        async getCredentials() {
          return { bearerToken: "admin-token" };
        },
      },
      fetchFn: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          expect(await request.clone().json()).toEqual({
            operation: "publish",
            serviceId: "Maui",
            layerId: 7,
            minZoom: 0,
            maxZoom: 12,
            tileMatrixSetId: "WebMercatorQuad",
            maxTiles: 5000,
          });
          return Response.json(
            {
              jobId: "job-1",
              message: "Tile operation queued.",
              statusUrl: "/api/v1/admin/tile-operations/jobs/job-1",
              cancelUrl: "/api/v1/admin/tile-operations/jobs/job-1/cancel",
            },
            { status: 202 },
          );
        }
        polls += 1;
        return Response.json(progress(polls === 1 ? 1 : 2));
      },
    });
    const lifecycle = createHonuaPmtilesLifecycle(client);
    const job = await lifecycle.submitPublish({
      serviceId: "Maui",
      layerId: 7,
      minZoom: 0,
      maxZoom: 12,
      tileMatrixSetId: "WebMercatorQuad",
      maxTiles: 5000,
    });
    const observed: string[] = [];
    job.watch((snapshot) => observed.push(snapshot.status));
    const complete = requirePmtilesJobSuccess(await job.wait({ pollIntervalMs: 0, maxAttempts: 3 }));
    const source = lifecycle.registerSource({
      honuaBaseUrl: "https://honua.example.test",
      publishedArtifact: complete.publishedArtifact,
    });
    expect(observed).toEqual(["processing", "completed"]);
    expect(source).toMatchObject({
      archiveUrl: "https://honua.example.test/api/v1/tiles/pmtiles/maui-7-webmercatorquad",
      maturity: "honua-range-proxy",
      artifactDurable: true,
      accessStable: true,
      maplibreSource: { type: "vector", minzoom: 0, maxzoom: 12 },
    });
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer admin-token")).toBe(true);
  });

  it("registers a completed archive as temporary and reports its TTL cleanup", async () => {
    const client = new HonuaClient({
      baseUrl: "https://honua.example.test",
      fetchFn: async (_input, init) =>
        init?.method === "POST"
          ? Response.json(
              {
                jobId: "archive-1",
                message: "queued",
                statusUrl: "/jobs/archive-1",
                cancelUrl: "/jobs/archive-1/cancel",
              },
              { status: 202 },
            )
          : Response.json(
              progress(2, {
                jobId: "archive-1",
                operation: "archive",
                archiveFileId: "file-1",
                downloadUrl: "/api/v1/files/file-1",
                publishedArtifact: null,
              }),
            ),
    });
    const lifecycle = createHonuaPmtilesLifecycle(client);
    const complete = await (await lifecycle.submitArchive({ layerId: 7 })).wait({ pollIntervalMs: 0, maxAttempts: 1 });
    const source = lifecycle.registerSource({ honuaBaseUrl: "https://honua.example.test", archiveJob: complete });
    expect(source.maturity).toBe("temporary-archive");
    expect(pmtilesCleanupDisposition(source)).toEqual({
      mode: "server-ttl",
      manualDeleteSupported: false,
      retentionHours: 24,
    });
    expect(() => assertPmtilesManualCleanupSupported(source)).toThrowError(HonuaPmtilesLifecycleError);
  });

  it("submits cancellation and honors a pre-aborted caller signal", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({ jobId: "job-1", message: "Cancellation requested." }),
    );
    const lifecycle = createHonuaPmtilesLifecycle(new HonuaClient({ baseUrl: "https://honua.example.test", fetchFn }));
    await expect(lifecycle.cancelJob("job-1")).resolves.toEqual({ jobId: "job-1", message: "Cancellation requested." });
    const request = new Request(fetchFn.mock.calls[0]![0], fetchFn.mock.calls[0]![1]);
    expect(request.method).toBe("POST");
    const controller = new AbortController();
    controller.abort();
    await expect(lifecycle.cancelJob("job-1", { signal: controller.signal })).rejects.toMatchObject({
      name: "HonuaAbortError",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a status response exceeds the configured ceiling", async () => {
    const fetchFn = vi.fn(
      async () => new Response("x".repeat(65), { status: 200, headers: { "Content-Length": "65" } }),
    );
    const lifecycle = createHonuaPmtilesLifecycle(new HonuaClient({ baseUrl: "https://honua.example.test", fetchFn }), {
      maxResponseBytes: 64,
    });
    await expect(lifecycle.getJob("job-1")).rejects.toMatchObject({ lifecycleCode: "response-too-large" });
  });

  it("falls back to a direct archive when managed output is absent or expired", () => {
    const directArchiveUrl = "https://cdn.example.test/maui.pmtiles";
    expect(registerPmtilesSource({ honuaBaseUrl: "https://honua.example.test", directArchiveUrl })).toMatchObject({
      maturity: "direct-archive",
      fallbackReason: "missing-published-artifact",
    });
    expect(
      registerPmtilesSource({
        honuaBaseUrl: "https://honua.example.test",
        publishedArtifact: artifact({
          urlStrategy: "SignedUrl",
          accessUrl: "https://signed.example.test/maui.pmtiles?sig=opaque",
          accessUrlExpiresAt: "2026-08-08T11:00:00.000Z",
        }) as never,
        directArchiveUrl,
        now: new Date("2026-08-08T12:00:00.000Z"),
      }),
    ).toMatchObject({ maturity: "direct-archive", fallbackReason: "expired-signed-url" });
  });

  it("keeps direct and managed maturity separate in the capability inventory", () => {
    expect(PMTILES_LIFECYCLE_CAPABILITIES).toMatchObject({
      directArchive: { client: "supported", server: "not-required", endToEnd: "fixture-qualified" },
      durableRangeProxy: { client: "experimental", server: "contract-present", endToEnd: "fixture-only" },
      manualArtifactDelete: { client: "unsupported", server: "not-exposed", endToEnd: "not-claimable" },
    });
  });
});
