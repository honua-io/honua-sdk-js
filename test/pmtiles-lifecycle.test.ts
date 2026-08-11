import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/honua.js";
import {
  HonuaPmtilesLifecycleError,
  PMTILES_LIFECYCLE_CAPABILITIES,
  assertPmtilesManualCleanupSupported,
  createHonuaPmtilesLifecycle,
  inspectPmtilesArchive,
  pmtilesCleanupDisposition,
  registerPmtilesSource,
  requirePmtilesJobSuccess,
} from "../src/pmtiles/index.js";

const BASE_URL = "https://honua.example.test";
const ASSET_URL = "https://assets.example.test/maps/basemap.pmtiles";
const startedAt = "2026-08-08T12:00:00.000Z";
const publishedAt = "2026-08-08T12:01:00.000Z";

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactId: "maui-7-webmercatorquad",
    storageProvider: 1,
    bucket: "honua-tiles",
    objectKey: "pmtiles/maui/7/WebMercatorQuad.pmtiles",
    contentType: "application/vnd.pmtiles",
    sizeBytes: 4096,
    urlStrategy: 2,
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
  const complete = status === 2;
  return {
    jobId: "job-1",
    operation: "publish",
    serviceId: "Maui",
    layerId: 7,
    tileMatrixSetId: "WebMercatorQuad",
    status,
    totalTiles: 10,
    processedTiles: complete ? 10 : 4,
    successfulTiles: complete ? 10 : 4,
    failedTiles: 0,
    archiveSizeBytes: complete ? 4096 : 0,
    archiveFileId: null,
    downloadUrl: null,
    publishedArtifact: complete ? artifact() : null,
    startedAt,
    completedAt: complete ? publishedAt : null,
    errorMessage: null,
    warnings: [],
    currentPhase: complete ? "Completed" : "Building archive",
    ...overrides,
  };
}

function fixtureAsset(): Uint8Array {
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/pmtiles/sample-vector.pmtiles", import.meta.url)));
  const asset = new Uint8Array(64 * 1024);
  asset.set(fixture);
  return asset;
}

function rangeFetch(asset = fixtureAsset()) {
  const requests: Request[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (!match) return new Response("missing range", { status: 400 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = asset.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Length": String(body.byteLength),
        "Content-Range": `bytes ${start}-${end}/${asset.byteLength}`,
        ETag: '"pmtiles-lifecycle-fixture"',
      },
    });
  });
  return { fetchFn, requests };
}

describe("PMTiles direct inspection and managed lifecycle", () => {
  it("inspects direct metadata through the authenticated bounded pipeline", async () => {
    const { fetchFn, requests } = rangeFetch();
    const inspection = await inspectPmtilesArchive({
      endpoint: ASSET_URL,
      authorizationScopeFingerprint: "tenant-a",
      clientOptions: { fetchFn, bearerToken: "asset-token" },
    });
    expect(inspection.cacheStatus).toBe("bypass");
    expect(inspection.metadata).toMatchObject({
      specVersion: 3,
      tileKind: "mvt",
      bounds: [-123.2, 37, -121.5, 38.2],
      transfer: { requests: 1, bytesFetched: 16_384 },
    });
    expect(inspection.rendererSource).toMatchObject({
      delivery: "direct-archive",
      maturity: "supported",
      evidence: "fixture",
      access: { cacheStrategy: "http-validator", rangeRequestsRequired: true },
      maplibreSource: { type: "vector" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer asset-token");
    expect(requests[0]?.headers.get("range")).toBe("bytes=0-16383");
  });

  it("submits and polls with auth, then registers a strict range-proxy descriptor", async () => {
    const requests: Request[] = [];
    let polls = 0;
    const client = new HonuaClient({
      baseUrl: BASE_URL,
      auth: async () => ({ bearerToken: "admin-token" }),
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
    const stop = job.watch((snapshot) => observed.push(snapshot.status));
    const complete = requirePmtilesJobSuccess(await job.wait({ pollIntervalMs: 0, maxAttempts: 3 }));
    const source = lifecycle.registerSource({ publishedArtifact: complete.publishedArtifact });
    stop();
    job.dispose();
    expect(observed).toEqual(["processing", "completed"]);
    expect(source).toMatchObject({
      archiveUrl: `${BASE_URL}/api/v1/tiles/pmtiles/maui-7-webmercatorquad`,
      delivery: "honua-range-proxy",
      maturity: "experimental",
      evidence: "contract-only",
      access: { cacheStrategy: "honua-range-proxy", urlStability: "stable", signedUrl: false },
      artifactDurable: true,
      maplibreSource: { type: "vector", minzoom: 0, maxzoom: 12 },
    });
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer admin-token")).toBe(true);
  });

  it("accepts the server's numeric and named enum encodings only", () => {
    expect(registerPmtilesSource({ honuaBaseUrl: BASE_URL, publishedArtifact: artifact() as never })).toMatchObject({
      delivery: "honua-range-proxy",
    });
    expect(
      registerPmtilesSource({
        honuaBaseUrl: BASE_URL,
        publishedArtifact: artifact({
          storageProvider: "AzureBlob",
          urlStrategy: "PublicUrl",
          accessUrl: "https://cdn.example.test/maui.pmtiles",
        }) as never,
      }),
    ).toMatchObject({ delivery: "published-public-archive", access: { urlStability: "stable" } });
    expect(() =>
      registerPmtilesSource({
        honuaBaseUrl: BASE_URL,
        publishedArtifact: artifact({ storageProvider: 99 }) as never,
      }),
    ).toThrowError(HonuaPmtilesLifecycleError);
  });

  it("reports temporary archive retention and refuses managed manual deletion", async () => {
    const lifecycle = createHonuaPmtilesLifecycle(
      new HonuaClient({
        baseUrl: BASE_URL,
        fetchFn: async (_input, init) =>
          init?.method === "POST"
            ? Response.json(
                {
                  jobId: "archive-1",
                  message: "queued",
                  statusUrl: "/api/v1/admin/tile-operations/jobs/archive-1",
                  cancelUrl: "/api/v1/admin/tile-operations/jobs/archive-1/cancel",
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
      }),
    );
    const complete = await (await lifecycle.submitArchive({ layerId: 7 })).wait({ pollIntervalMs: 0, maxAttempts: 1 });
    const source = lifecycle.registerSource({ archiveJob: complete });
    expect(source).toMatchObject({ delivery: "temporary-archive", evidence: "contract-only" });
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
    const lifecycle = createHonuaPmtilesLifecycle(new HonuaClient({ baseUrl: BASE_URL, fetchFn }));
    await expect(lifecycle.cancelJob("job-1")).resolves.toEqual({ jobId: "job-1", message: "Cancellation requested." });
    const controller = new AbortController();
    controller.abort();
    await expect(lifecycle.cancelJob("job-1", { signal: controller.signal })).rejects.toMatchObject({
      name: "HonuaAbortError",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight poll at the wait deadline and preserves caller-abort classification", async () => {
    const stalledJob = async () => {
      let requestCount = 0;
      let pollSignal: AbortSignal | undefined;
      const lifecycle = createHonuaPmtilesLifecycle(
        new HonuaClient({
          baseUrl: BASE_URL,
          fetchFn: async (_input, init) => {
            requestCount += 1;
            if (requestCount === 1) {
              return Response.json(
                {
                  jobId: "job-stalled",
                  message: "queued",
                  statusUrl: "/api/v1/admin/tile-operations/jobs/job-stalled",
                  cancelUrl: "/api/v1/admin/tile-operations/jobs/job-stalled/cancel",
                },
                { status: 202 },
              );
            }
            pollSignal = init?.signal ?? undefined;
            return await new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              const aborted = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
              if (signal?.aborted) aborted();
              else signal?.addEventListener("abort", aborted, { once: true });
            });
          },
        }),
      );
      return { job: await lifecycle.submitPublish({ layerId: 7 }), pollSignal: () => pollSignal };
    };

    const deadline = await stalledJob();
    await expect(deadline.job.wait({ deadlineMs: 20, maxAttempts: 2 })).rejects.toMatchObject({
      lifecycleCode: "job-poll-timeout",
    });
    expect(deadline.pollSignal()?.aborted).toBe(true);

    const caller = await stalledJob();
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 20);
    try {
      await expect(caller.job.wait({ deadlineMs: 10_000, signal: controller.signal })).rejects.toMatchObject({
        name: "HonuaAbortError",
      });
    } finally {
      clearTimeout(abort);
    }
  });

  it("rejects mismatched receipt routes, job identities, and progress counters", async () => {
    const badReceipt = createHonuaPmtilesLifecycle(
      new HonuaClient({
        baseUrl: BASE_URL,
        fetchFn: async () =>
          Response.json(
            {
              jobId: "job-1",
              message: "queued",
              statusUrl: "/api/v1/admin/tile-operations/jobs/other",
              cancelUrl: "/api/v1/admin/tile-operations/jobs/job-1/cancel",
            },
            { status: 202 },
          ),
      }),
    );
    await expect(badReceipt.submitPublish({ layerId: 7 })).rejects.toMatchObject({ lifecycleCode: "invalid-response" });

    const badStatus = createHonuaPmtilesLifecycle(
      new HonuaClient({ baseUrl: BASE_URL, fetchFn: async () => Response.json(progress(1, { jobId: "other" })) }),
    );
    await expect(badStatus.getJob("job-1")).rejects.toMatchObject({ lifecycleCode: "invalid-response" });

    const badCounters = createHonuaPmtilesLifecycle(
      new HonuaClient({ baseUrl: BASE_URL, fetchFn: async () => Response.json(progress(1, { processedTiles: 11 })) }),
    );
    await expect(badCounters.getJob("job-1")).rejects.toMatchObject({ lifecycleCode: "invalid-response" });
  });

  it("rejects noncanonical job and artifact route identifiers before URL resolution", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const lifecycle = createHonuaPmtilesLifecycle(new HonuaClient({ baseUrl: BASE_URL, fetchFn }));
    await expect(lifecycle.getJob("..")).rejects.toMatchObject({ lifecycleCode: "invalid-request" });
    await expect(lifecycle.cancelJob(" job-1 ")).rejects.toMatchObject({ lifecycleCode: "invalid-request" });
    expect(fetchFn).not.toHaveBeenCalled();

    const badReceipt = createHonuaPmtilesLifecycle(
      new HonuaClient({
        baseUrl: BASE_URL,
        fetchFn: async () =>
          Response.json(
            {
              jobId: "..",
              message: "queued",
              statusUrl: "/api/v1/admin/tile-operations",
              cancelUrl: "/api/v1/admin/tile-operations/cancel",
            },
            { status: 202 },
          ),
      }),
    );
    await expect(badReceipt.submitPublish({ layerId: 7 })).rejects.toMatchObject({ lifecycleCode: "invalid-response" });
    expect(() =>
      registerPmtilesSource({
        honuaBaseUrl: BASE_URL,
        publishedArtifact: artifact({ artifactId: ".." }) as never,
      }),
    ).toThrowError(expect.objectContaining({ lifecycleCode: "invalid-response" }));
  });

  it("fails closed on oversized or malformed response framing", async () => {
    const oversized = createHonuaPmtilesLifecycle(
      new HonuaClient({
        baseUrl: BASE_URL,
        fetchFn: async () => new Response("x".repeat(65), { status: 200, headers: { "Content-Length": "65" } }),
      }),
      { maxResponseBytes: 64 },
    );
    await expect(oversized.getJob("job-1")).rejects.toMatchObject({ lifecycleCode: "response-too-large" });

    const malformedLength = createHonuaPmtilesLifecycle(
      new HonuaClient({
        baseUrl: BASE_URL,
        fetchFn: async () => new Response("{}", { status: 200, headers: { "Content-Length": "NaN" } }),
      }),
    );
    await expect(malformedLength.getJob("job-1")).rejects.toMatchObject({ lifecycleCode: "response-too-large" });

    const oversizedError = createHonuaPmtilesLifecycle(
      new HonuaClient({
        baseUrl: BASE_URL,
        fetchFn: async () => new Response("x".repeat(65), { status: 500, headers: { "Content-Length": "65" } }),
      }),
      { maxResponseBytes: 64 },
    );
    await expect(oversizedError.getJob("job-1")).rejects.toMatchObject({ lifecycleCode: "response-too-large" });
  });

  it("models signed URL refresh and explicit direct fallback without leaking maturity", () => {
    const expired = artifact({
      urlStrategy: "SignedUrl",
      accessUrl: "https://signed.example.test/maui.pmtiles?sig=opaque",
      accessUrlExpiresAt: "2026-08-08T11:00:00.000Z",
    });
    expect(() =>
      registerPmtilesSource({
        honuaBaseUrl: BASE_URL,
        publishedArtifact: expired as never,
        now: new Date("2026-08-08T12:00:00.000Z"),
      }),
    ).toThrowError(HonuaPmtilesLifecycleError);
    expect(
      registerPmtilesSource({
        honuaBaseUrl: BASE_URL,
        publishedArtifact: expired as never,
        directArchiveUrl: "https://cdn.example.test/maui.pmtiles",
        directCacheValidator: 'etag:"maui-v1"',
        now: new Date("2026-08-08T12:00:00.000Z"),
      }),
    ).toMatchObject({
      delivery: "direct-archive",
      maturity: "supported",
      fallbackReason: "expired-signed-url",
      access: { cacheValidator: 'etag:"maui-v1"', refreshRequired: false },
    });
  });

  it("keeps terminal failure and lifecycle evidence explicit", () => {
    expect(() =>
      requirePmtilesJobSuccess(
        progress(3, {
          status: "failed",
          processedTiles: 4,
          successfulTiles: 3,
          failedTiles: 1,
          errorMessage: "upload failed",
        }) as never,
      ),
    ).toThrowError(HonuaPmtilesLifecycleError);
    expect(PMTILES_LIFECYCLE_CAPABILITIES).toMatchObject({
      directArchive: { client: "supported", server: "not-applicable", endToEnd: "supported", evidence: "fixture" },
      durableRangeProxy: {
        client: "experimental",
        server: "supported",
        endToEnd: "experimental",
        evidence: "contract-only",
      },
      manualArtifactDelete: {
        client: "unavailable",
        server: "unavailable",
        endToEnd: "unavailable",
        evidence: "contract-only",
      },
    });
  });
});
