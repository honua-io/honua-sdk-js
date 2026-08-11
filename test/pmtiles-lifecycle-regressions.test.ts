import { describe, expect, it } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import {
  type HonuaPmtilesLifecycleError,
  createHonuaPmtilesLifecycle,
  registerPmtilesSource,
} from "../src/pmtiles/index.js";

describe("PMTiles lifecycle regressions", () => {
  it("preserves the configured server prefix for receipts and RangeProxy sources", async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input));
      const method = init?.method ?? request?.method ?? "GET";
      expect(url.pathname.startsWith("/prefix/api/v1/")).toBe(true);

      if (method === "POST" && url.pathname === "/prefix/api/v1/admin/tile-operations/jobs") {
        return json(
          {
            jobId: "job-prefix",
            message: "accepted",
            statusUrl: "/api/v1/admin/tile-operations/jobs/job-prefix",
            cancelUrl: "/api/v1/admin/tile-operations/jobs/job-prefix/cancel",
          },
          202,
        );
      }
      if (method === "GET" && url.pathname === "/prefix/api/v1/admin/tile-operations/jobs/job-prefix") {
        return json({
          jobId: "job-prefix",
          operation: "publish",
          status: "completed",
          totalTiles: 1,
          processedTiles: 1,
          successfulTiles: 1,
          failedTiles: 0,
          archiveSizeBytes: 128,
          publishedArtifact: {
            artifactId: "artifact-prefix",
            storageProvider: "Local",
            bucket: "pmtiles",
            objectKey: "artifact-prefix.pmtiles",
            contentType: "application/vnd.pmtiles",
            sizeBytes: 128,
            urlStrategy: "RangeProxy",
            accessUrl: "/api/v1/tiles/pmtiles/artifact-prefix",
            publishedAt: "2026-08-11T00:00:00.000Z",
            minZoom: 0,
            maxZoom: 14,
          },
          startedAt: "2026-08-11T00:00:00.000Z",
          completedAt: "2026-08-11T00:00:01.000Z",
          warnings: [],
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    };
    const lifecycle = createHonuaPmtilesLifecycle(
      new HonuaClient({ baseUrl: "https://honua.example.test/prefix", apiKey: "test-key", fetchFn }),
    );

    const job = await lifecycle.submitPublish({ serviceId: "parcels", layerId: 0 });
    expect(job.receipt.statusUrl).toBe("/prefix/api/v1/admin/tile-operations/jobs/job-prefix");
    expect(job.receipt.cancelUrl).toBe("/prefix/api/v1/admin/tile-operations/jobs/job-prefix/cancel");
    const progress = await job.poll();
    const source = lifecycle.registerSource({ publishedArtifact: progress.publishedArtifact });
    expect(source.archiveUrl).toBe("https://honua.example.test/prefix/api/v1/tiles/pmtiles/artifact-prefix");
    expect(source.maplibreUrl).toBe("pmtiles://https://honua.example.test/prefix/api/v1/tiles/pmtiles/artifact-prefix");
    expect(source.maplibreSource.url).toBe(source.maplibreUrl);
  });

  it("rejects an already-expired direct signed URL", () => {
    expect(() =>
      registerPmtilesSource({
        honuaBaseUrl: "https://honua.example.test",
        directArchiveUrl: "https://assets.example.test/archive.pmtiles?signature=test",
        directAccessUrlExpiresAt: "2026-08-10T00:00:00.000Z",
        now: new Date("2026-08-11T00:00:00.000Z"),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<HonuaPmtilesLifecycleError>>({ lifecycleCode: "access-url-expired" }),
    );
  });

  it("rejects inverted direct zoom bounds", () => {
    expect(() =>
      registerPmtilesSource({
        honuaBaseUrl: "https://honua.example.test",
        directArchiveUrl: "https://assets.example.test/archive.pmtiles",
        directMinZoom: 12,
        directMaxZoom: 4,
      }),
    ).toThrowError(expect.objectContaining<Partial<HonuaPmtilesLifecycleError>>({ lifecycleCode: "invalid-request" }));
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
