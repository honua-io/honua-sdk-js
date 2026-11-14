import { describe, expect, it } from "vitest";

import { queryFilter } from "../src/contract/query-filter.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { GeoparquetRuntime } from "../src/geoparquet/index.js";
import { openPublication, verifyPmtilesArtifact } from "../src/publication/index.js";
import {
  LEADING_ZERO_PARCEL,
  MERGED_MULTIPART_PARCEL,
  NON_PUBLIC_FIELDS as NON_PUBLIC,
  FIXTURE_DESCRIPTOR as descriptor,
  fixtureSource,
  openFixture,
  parquetRequests,
  publicationTestBed,
  rewrittenParquet,
  FIXTURE_STAMP as stamp,
} from "./helpers/publication-fixture.js";

const { served, pairedSource, track } = publicationTestBed();

describe("non-public fields", () => {
  it("refuses to query, filter, sort or aggregate by a non-public field", async () => {
    const source = await pairedSource(await served());
    for (const query of [
      { outFields: ["landvalue"] },
      { filter: queryFilter.eq("homeowner", "Y") },
      { orderBy: [{ field: "bldgvalue" }] },
    ]) {
      await expect(source.query(query)).rejects.toMatchObject({ code: "non-public-field" });
    }
    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "sum", field: "landvalue" }] } }),
    ).rejects.toMatchObject({ code: "non-public-field" });
  });

  it("never returns or exports a non-public column even when the artifact carries one", async () => {
    const leaked = await rewrittenParquet("*, 123456 AS landvalue, 'Y' AS homeowner", stamp);
    track(leaked.cleanup);
    const source = await pairedSource(await served(leaked.overrides));
    const everything = await source.queryAll({ outFields: undefined });
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    const csv = await source.exportFeatures("csv");
    const geojson = await source.exportFeatures("geojson");
    for (const name of NON_PUBLIC) {
      expect(everything.features.every((feature) => !(name in (feature.attributes as object)))).toBe(true);
      expect(Object.keys(lookup.result.features[0]?.attributes as object)).not.toContain(name);
      expect(csv.split("\r\n")[0]?.split(",")).not.toContain(name);
      expect(geojson).not.toContain(`"${name}"`);
    }
  });
});

describe("guard rails", () => {
  it("refuses raw where clauses and exposes no unrestricted adapter", async () => {
    const source = await pairedSource(await served());
    await expect(source.query({ where: "landvalue > 0" })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.exportFeatures("csv", { where: "1=1" })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(source.protocol("geoparquet")).toBeUndefined();
    expect(source.adapter("geoparquet")).toBeUndefined();
  });

  it("cancelling one lookup leaves a concurrent lookup running", async () => {
    const source = await pairedSource(await served({ delayMs: 100 }));
    const cancelled = new AbortController();
    const first = source.lookup(MERGED_MULTIPART_PARCEL, { signal: cancelled.signal });
    const second = source.lookup(LEADING_ZERO_PARCEL);
    cancelled.abort();
    await expect(first).rejects.toBeInstanceOf(HonuaAbortError);
    expect((await second).result.features[0]?.attributes).toMatchObject({ tmk_txt: LEADING_ZERO_PARCEL });
  });

  it("lets callers cancel export and planning while the engine is still starting", async () => {
    const runtime = new GeoparquetRuntime({ driverFactory: () => new Promise(() => undefined) });
    track(() => runtime.dispose());
    const source = await fixtureSource(await served(), { runtime });
    const controller = new AbortController();
    const exported = source.exportFeatures("csv", { signal: controller.signal });
    const planned = source.planLookup(MERGED_MULTIPART_PARCEL, { signal: controller.signal });
    controller.abort();
    await Promise.all([
      expect(exported).rejects.toBeInstanceOf(HonuaAbortError),
      expect(planned).rejects.toBeInstanceOf(HonuaAbortError),
    ]);
  });

  it("rejects planning for an already-cancelled signal without leaving work unobserved", async () => {
    const source = await pairedSource(await served());
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await expect(source.planLookup(MERGED_MULTIPART_PARCEL, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        HonuaAbortError,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("keeps caller headers when opening a descriptor", async () => {
    const server = await served();
    const seen: Headers[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers));
      return fetch(input, init);
    };
    await openPublication(`${server.origin}/maui/descriptor.json`, {
      fetch: recordingFetch,
      headers: new Headers({ authorization: "Bearer test-token" }),
    });
    expect(seen[0]?.get("authorization")).toBe("Bearer test-token");
    expect(seen[0]?.get("accept")).toBe("application/json");
  });
});

describe("artifact consistency", () => {
  it("rejects a GeoParquet artifact from another capture", async () => {
    const other = await rewrittenParquet("*", { ...stamp, captureId: "sha256:another-capture" });
    track(other.cleanup);
    const source = await pairedSource(await served(other.overrides));
    await expect(source.lookup(MERGED_MULTIPART_PARCEL)).rejects.toMatchObject({ code: "artifact-mismatch" });
    await expect(source.query({})).rejects.toThrow(/does not carry capture/);
  });

  it("rejects a PMTiles artifact from another capture", async () => {
    const publication = await openFixture(await served());
    const description = {
      url: publication.display.pmtilesUrl,
      tileKind: "mvt" as const,
      bounds: [0, 0, 0, 0] as [number, number, number, number],
      minZoom: 10,
      maxZoom: 15,
      center: [0, 0, 10] as [number, number, number],
      vectorLayers: [],
      metadata: { "honua:publication": { ...stamp, captureId: "sha256:another-capture" } },
    };
    await expect(verifyPmtilesArtifact(publication, { preloadedDescription: description })).rejects.toMatchObject({
      code: "artifact-mismatch",
    });
  });
});

describe("HTTP range reads", () => {
  it("reads the GeoParquet artifact only through partial range requests", async () => {
    const server = await served();
    const source = await pairedSource(server);
    await source.lookup(MERGED_MULTIPART_PARCEL);
    const reads = parquetRequests(server).filter((entry) => entry.method === "GET");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.range).toMatch(/^bytes=\d+-\d*$/);
      expect(read.status).toBe(206);
      expect(read.bytes).toBeLessThan(descriptor.artifacts.geoparquet.bytes);
    }
  });

  it("answers a CORS preflight for range requests from another origin", async () => {
    const server = await served();
    const response = await fetch(`${server.origin}/maui/parcels.parquet`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "range",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Range/);
    expect(response.headers.get("access-control-expose-headers")).toMatch(/Content-Range/);
  });

  it("stops issuing range requests once a lookup is cancelled", async () => {
    const server = await served({ delayMs: 150 });
    const source = await pairedSource(server);
    const controller = new AbortController();
    const pending = source.lookup(MERGED_MULTIPART_PARCEL, { signal: controller.signal });
    while (parquetRequests(server).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    const afterCancel = parquetRequests(server).length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(parquetRequests(server).length).toBeLessThanOrEqual(afterCancel + 1);
  });
});
