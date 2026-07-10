import { createHash } from "node:crypto";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

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
      candidateRows: 8,
      candidateRowGroups: 1,
      filePruning: "stac-bbox",
      rowGroupPruning: "bbox-predicate-planned-unverified",
      memoryLimitMiB: 256,
    });
    expect(live).toMatchObject({
      limit: 100,
      filesSelected: 1,
      filesAvailable: 16,
      candidateRows: 4_717_270,
      candidateRowGroups: 256,
      rangeReadPlan: "aws-header-and-footer-probe-plus-engine-ranges",
    });
    expect(fixture.projection).toHaveLength(OVERTURE_POLICY.maxProjectedColumns);
    expect(live.projection).toHaveLength(OVERTURE_POLICY.maxProjectedColumns);
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
      planOvertureQuery({ lane: "live", aoi: [120, 40, 120.1, 40.1], category: "all", limit: 10 }, OVERTURE_POLICY),
    ).toThrow("no object");
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
    expect(first.cacheKey).toContain(LIVE_MANIFEST.objects[0]?.etag);
  });

  it("verifies exact public range probes and blocks non-range responses", async () => {
    const object = LIVE_MANIFEST.objects[0]!;
    const requests: string[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(new Headers(init?.headers).get("range") ?? "");
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
  });

  it("streams driver batches through the runtime without forcing full materialization", async () => {
    let materialized = false;
    const driver: DuckDbDriver = {
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
      async close() {},
    };
    const runtime = new GeoparquetRuntime({ driverFactory: async () => driver });
    const controller = new AbortController();
    const batches = [];
    for await (const batch of runtime.stream("SELECT 1", { signal: controller.signal })) batches.push(batch);
    expect(batches).toEqual([[{ id: "one" }], [{ id: "two" }]]);
    expect(materialized).toBe(false);
    await runtime.dispose();
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
