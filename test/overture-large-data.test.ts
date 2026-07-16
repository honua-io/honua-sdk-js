import { createHash } from "node:crypto";
import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { OverturePlanRejectedError, parseAoi, planOvertureQuery } from "../examples/overture-geoparquet/src/planner.js";
import { probeAwsRanges } from "../examples/overture-geoparquet/src/range-evidence.js";
import {
  FIXTURE_MANIFEST,
  LIVE_MANIFEST,
  OVERTURE_POLICY,
} from "../examples/overture-geoparquet/src/source-manifests.js";
import type { DuckDbDriver } from "../src/geoparquet/driver.js";
import { GeoparquetRuntime } from "../src/geoparquet/index.js";

describe("Overture large-data flagship", () => {
  it("plans the fixture and pinned AWS object through the same bounded policy", () => {
    const aoi = parseAoi("-158.30,21.20,-157.65,21.60");
    const fixture = planOvertureQuery({ lane: "fixture", aoi, category: "all", limit: 100 }, OVERTURE_POLICY);
    const live = planOvertureQuery({ lane: "live", aoi, category: "all", limit: 100 }, OVERTURE_POLICY);

    expect(fixture).toMatchObject({
      limit: 100,
      filesSelected: 1,
      filesAvailable: 1,
      selectedObjectRows: 8,
      selectedObjectRowGroups: 1,
      filePruning: "fixture-manifest-bbox",
      rowGroupPruning: "bbox-predicate-planned-unverified",
      memoryLimitMiB: 256,
      maxResultBytes: 1_048_576,
    });
    expect(live).toMatchObject({
      limit: 100,
      filesSelected: 1,
      filesAvailable: 16,
      selectedObjectRows: 4_717_270,
      selectedObjectRowGroups: 256,
      rangeReadPlan: "aws-fail-closed-range-io",
      allowFullHttpReads: false,
      filePruning: "pinned-stac-manifest-bbox",
    });
    expect(fixture.projection).toHaveLength(OVERTURE_POLICY.maxProjectedColumns);
    expect(live.projection).toHaveLength(OVERTURE_POLICY.maxProjectedColumns);
    expect(LIVE_MANIFEST.objects).toHaveLength(LIVE_MANIFEST.totalFiles);
    expect(live.selectedObjects.map((object) => object.id)).toEqual(["00000"]);
    expect(live.warning).toContain("not expose");
  });

  it("rejects unsafe full-world, unbounded-row, invalid, and non-intersecting requests", () => {
    expect(() =>
      planOvertureQuery({ lane: "live", aoi: [-180, -90, 180, 90], category: "all", limit: 100 }, OVERTURE_POLICY),
    ).toThrowError(OverturePlanRejectedError);
    expect(() =>
      planOvertureQuery(
        { lane: "live", aoi: [-158.3, 21.2, -157.65, 21.6], category: "all", limit: 201 },
        OVERTURE_POLICY,
      ),
    ).toThrow("between 1 and 200");
    expect(() => parseAoi("180,90,-180,-90")).toThrow("ordered CRS84");
    expect(() =>
      planOvertureQuery(
        { lane: "fixture", aoi: [120, 40, 120.1, 40.1], category: "all", limit: 10 },
        OVERTURE_POLICY,
        FIXTURE_MANIFEST,
      ),
    ).toThrow("no object");
    expect(() =>
      planOvertureQuery({ lane: "live", aoi: [-77, 28.47, -76.9, 28.48], category: "all", limit: 10 }, OVERTURE_POLICY),
    ).toThrow("requires exactly one object");
  });

  it("keys cache identity by release, object version, AOI, projection, category, and policy", () => {
    const first = planOvertureQuery(
      { lane: "live", aoi: [-158.3, 21.2, -157.65, 21.6], category: "all", limit: 100 },
      OVERTURE_POLICY,
    );
    const second = planOvertureQuery(
      { lane: "live", aoi: [-158.3, 21.2, -157.65, 21.6], category: "beach", limit: 100 },
      OVERTURE_POLICY,
    );
    expect(first.cacheKey).not.toBe(second.cacheKey);
    expect(first.cacheKey).toContain(LIVE_MANIFEST.release);
    expect(first.cacheKey).toContain(LIVE_MANIFEST.schemaVersion);
    expect(first.cacheKey).toContain(LIVE_MANIFEST.objects[0]?.etag);
  });

  it("verifies exact public range probes and blocks non-range responses", async () => {
    const object = LIVE_MANIFEST.objects[0]!;
    const requests: string[] = [];
    const credentials: RequestCredentials[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(new Headers(init?.headers).get("range") ?? "");
      credentials.push(init?.credentials ?? "same-origin");
      return new Response(new Uint8Array(requests.length === 1 ? 1 : 65_536), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-range":
            requests.length === 1
              ? `bytes 0-0/${object.bytes}`
              : `bytes ${object.bytes - 65_536}-${object.bytes - 1}/${object.bytes}`,
          etag: `"${object.etag}"`,
          "last-modified": object.lastModified,
        },
      });
    };
    const evidence = await probeAwsRanges(object, { fetchFn: fetchFn as typeof fetch });
    expect(requests).toEqual(["bytes=0-0", `bytes=${object.bytes - 65_536}-${object.bytes - 1}`]);
    expect(credentials).toEqual(["omit", "omit"]);
    expect(evidence).toMatchObject({
      status: "verified",
      bytes: 65_537,
      ranges: 2,
      acceptRanges: true,
      etag: object.etag,
    });
    expect(evidence.limitation).toContain("not exposed");

    const unsupported = await probeAwsRanges(object, {
      fetchFn: (async () => new Response(new Uint8Array(1), { status: 200 })) as typeof fetch,
    });
    expect(unsupported).toMatchObject({ status: "unsupported", ranges: 0, bytes: 0 });

    const changedObject = await probeAwsRanges(object, {
      fetchFn: (async () =>
        new Response(new Uint8Array(1), {
          status: 206,
          headers: { "content-range": `bytes 0-0/${object.bytes}`, etag: '"changed"' },
        })) as typeof fetch,
    });
    expect(changedObject).toMatchObject({ status: "unsupported" });
    expect(changedObject.limitation).toContain("identity mismatch");

    const wrongInterval = await probeAwsRanges(object, {
      fetchFn: (async () =>
        new Response(new Uint8Array(1), {
          status: 206,
          headers: { "content-range": `bytes 0-1/${object.bytes}`, etag: `"${object.etag}"` },
        })) as typeof fetch,
    });
    expect(wrongInterval).toMatchObject({ status: "unsupported", bytes: 0, ranges: 0 });
    expect(wrongInterval.limitation).toContain("exact HTTP 206 interval");

    const oversizedBody = await probeAwsRanges(object, {
      fetchFn: (async () =>
        new Response(new Uint8Array(2), {
          status: 206,
          headers: { "content-range": `bytes 0-0/${object.bytes}`, etag: `"${object.etag}"` },
        })) as typeof fetch,
    });
    expect(oversizedBody).toMatchObject({ status: "unsupported", bytes: 0, ranges: 0 });
    expect(oversizedBody.limitation).toContain("exact 1-byte probe budget");

    const truncatedBody = await probeAwsRanges(object, {
      fetchFn: (async () =>
        new Response(new Uint8Array(0), {
          status: 206,
          headers: { "content-range": `bytes 0-0/${object.bytes}`, etag: `"${object.etag}"` },
        })) as typeof fetch,
    });
    expect(truncatedBody).toMatchObject({ status: "unsupported", bytes: 0, ranges: 0 });
    expect(truncatedBody.limitation).toContain("exact 1-byte probe budget");

    await expect(
      probeAwsRanges(object, {
        timeoutMs: 1,
        fetchFn: ((_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          })) as typeof fetch,
      }),
    ).rejects.toThrow("1 ms deadline");

    await expect(
      probeAwsRanges(object, {
        timeoutMs: 1,
        fetchFn: (async () =>
          new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
            status: 206,
            headers: { "content-range": `bytes 0-0/${object.bytes}`, etag: `"${object.etag}"` },
          })) as typeof fetch,
      }),
    ).rejects.toThrow("1 ms deadline");
  });

  it("streams driver batches through the runtime without forcing full materialization", async () => {
    let materialized = false;
    let closeCalls = 0;
    let finishClose!: () => void;
    let markCloseStarted!: () => void;
    const closePending = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const driver: DuckDbDriver = {
      geometryCapabilities: { spatialExtension: true },
      async run() {},
      async query() {
        materialized = true;
        return [];
      },
      async *streamQuery(_sql, options) {
        expect(options?.signal).toBeDefined();
        yield [{ id: "one" }];
        yield [{ id: "two" }];
      },
      async registerFileBuffer() {},
      async close() {
        closeCalls += 1;
        markCloseStarted();
        await closePending;
      },
    };
    const runtime = new GeoparquetRuntime({ driverFactory: async () => driver });
    const controller = new AbortController();
    const batches = [];
    for await (const batch of runtime.stream("SELECT 1", { signal: controller.signal })) batches.push(batch);
    expect(batches).toEqual([[{ id: "one" }], [{ id: "two" }]]);
    expect(materialized).toBe(false);
    let secondDisposeFinished = false;
    const firstDispose = runtime.dispose();
    const secondDispose = runtime.dispose().then(() => {
      secondDisposeFinished = true;
    });
    await closeStarted;
    expect(closeCalls).toBe(1);
    expect(secondDisposeFinished).toBe(false);
    finishClose();
    await Promise.all([firstDispose, secondDispose]);
    expect(closeCalls).toBe(1);
  });

  it("disposes immediately while driver initialization is pending", async () => {
    let initializationSignal: AbortSignal | undefined;
    let resolveDriver!: (driver: DuckDbDriver) => void;
    const pendingDriver = new Promise<DuckDbDriver>((resolve) => {
      resolveDriver = resolve;
    });
    let closeCalls = 0;
    const runtime = new GeoparquetRuntime({
      driverFactory: ({ signal } = { signal: new AbortController().signal }) => {
        initializationSignal = signal;
        return pendingDriver;
      },
    });
    const query = runtime.query("SELECT 1");
    await Promise.resolve();
    await runtime.dispose();
    expect(initializationSignal?.aborted).toBe(true);
    resolveDriver({
      geometryCapabilities: { spatialExtension: true },
      async run() {},
      async query() {
        return [];
      },
      async registerFileBuffer() {},
      async close() {
        closeCalls += 1;
      },
    });
    await expect(query).rejects.toThrow("disposed");
    await vi.waitFor(() => expect(closeCalls).toBe(1));
  });

  it("pins the deterministic fixture and self-hosted Parquet extension by digest", () => {
    expect(digest("examples/overture-geoparquet/public/overture-places.parquet")).toBe(
      FIXTURE_MANIFEST.objects[0]?.etag.replace("sha256:", ""),
    );
    expect(digest("examples/overture-geoparquet/vendor/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm")).toBe(
      "22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55",
    );
  });
});

function digest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
