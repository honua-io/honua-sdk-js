import { describe, expect, it } from "vitest";

import type { Query, Result, Source } from "../src/contract/types.js";
import { GeoparquetRuntime } from "../src/geoparquet/index.js";
import { HonuaPublicationError, PUBLICATION_LOOKUP_BUDGET } from "../src/publication/index.js";
import {
  MERGED_MULTIPART_PARCEL,
  fixtureSource,
  parquetRequests,
  publicationTestBed,
} from "./helpers/publication-fixture.js";

const { served: serveWithOptions, pairedSource, track } = publicationTestBed();
const served = (delayMs = 0) => serveWithOptions(delayMs ? { delayMs } : {});

function liveService() {
  const requests: Query[] = [];
  const server = {
    requests,
    async query(query: Query): Promise<Result> {
      requests.push(query);
      return {
        features: [
          {
            attributes: {
              tmk_txt: MERGED_MULTIPART_PARCEL,
              plat: "030",
              nhoodcode: null,
              landvalue: 410000,
              homeowner: "Y",
            },
            geometry: { type: "MultiPolygon", coordinates: [] },
          },
        ],
        exceededTransferLimit: false,
      };
    },
  };
  return server as typeof server & Source;
}

const tinyBudget = { maxBytes: 4_096, maxTimeToFirstResultMs: 10_000 };

describe("byte budget", () => {
  it("keeps a committed-fixture lookup within the confirmed byte budget, planned and actually sent", async () => {
    const server = await served();
    const source = await pairedSource(server);
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    expect(lookup.answeredBy).toBe("geoparquet");
    expect(lookup.plan.plannedBytes).toBeLessThanOrEqual(PUBLICATION_LOOKUP_BUDGET.maxBytes);
    expect(server.bytesSent("/maui/parcels.parquet")).toBeLessThanOrEqual(PUBLICATION_LOOKUP_BUDGET.maxBytes);
  });

  it("refuses an over-budget lookup with a plain limit message when no live service is configured", async () => {
    const server = await served();
    const source = await pairedSource(server, { budget: tinyBudget });
    const lookup = source.lookup(MERGED_MULTIPART_PARCEL);
    await expect(lookup).rejects.toBeInstanceOf(HonuaPublicationError);
    await expect(lookup).rejects.toMatchObject({ code: "query-budget-exceeded" });
    await expect(lookup).rejects.toThrow(
      /^Looking up 234030888 in the browser would download about 0\.1 MB, more than the 0\.0 MB limit\. Connect a live service/,
    );
    const rowGroupReads = parquetRequests(server).filter((entry) => entry.method === "GET" && entry.bytes > 20_000);
    expect(rowGroupReads).toEqual([]);
  });

  it("falls back to the live service and carries the reason in the Result", async () => {
    const live = liveService();
    const source = await pairedSource(await served(), { budget: tinyBudget, serverSource: live });
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    expect(lookup.answeredBy).toBe("server");
    expect(lookup.limit).toMatchObject({ kind: "bytes", budget: tinyBudget.maxBytes });
    expect(lookup.limit?.observed).toBe(lookup.plan.plannedBytes);
    expect(lookup.limit?.message).toMatch(/would download about .* so the live service answered instead\.$/);
    expect(lookup.result.degraded).toEqual([
      expect.objectContaining({ capability: "query", reason: lookup.limit?.message }),
    ]);
    expect(live.requests[0]?.filter).toEqual({
      kind: "comparison",
      operator: "eq",
      left: { kind: "property", name: "tmk_txt" },
      right: { kind: "literal", value: MERGED_MULTIPART_PARCEL },
    });
    expect(lookup.result.features[0]?.attributes).toEqual({
      tmk_txt: MERGED_MULTIPART_PARCEL,
      plat: "030",
      nhoodcode: null,
    });
  });
});

describe("time budget", () => {
  it("cancels a slow browser lookup, answers from the live service and sends no further range requests", async () => {
    const server = await served(250);
    const live = liveService();
    const source = await pairedSource(server, {
      budget: { maxBytes: PUBLICATION_LOOKUP_BUDGET.maxBytes, maxTimeToFirstResultMs: 400 },
      serverSource: live,
    });
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    expect(lookup.answeredBy).toBe("server");
    expect(lookup.limit).toMatchObject({ kind: "time", budget: 400 });
    expect(lookup.limit?.message).toBe(
      "Looking up 234030888 in the browser took longer than 0.4 s, so the live service answered instead.",
    );
    const afterFallback = parquetRequests(server).length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(parquetRequests(server).length).toBeLessThanOrEqual(afterFallback + 1);
  });

  it("reports a late browser answer when there is no live service to fall back to", async () => {
    const source = await pairedSource(await served(150), {
      budget: { maxBytes: PUBLICATION_LOOKUP_BUDGET.maxBytes, maxTimeToFirstResultMs: 200 },
    });
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    expect(lookup.answeredBy).toBe("geoparquet");
    expect(lookup.result.features).toHaveLength(1);
    expect(lookup.limit?.kind).toBe("time");
    expect(lookup.limit?.message).toMatch(/took longer than 0\.2 s\. Connect a live service/);
  });

  it("falls back on time even when the browser engine never finishes starting", async () => {
    const live = liveService();
    const runtime = new GeoparquetRuntime({ driverFactory: () => new Promise(() => undefined) });
    track(() => runtime.dispose());
    const source = await fixtureSource(await served(), {
      runtime,
      budget: { maxBytes: PUBLICATION_LOOKUP_BUDGET.maxBytes, maxTimeToFirstResultMs: 200 },
      serverSource: live,
    });
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    expect(lookup).toMatchObject({ answeredBy: "server", limit: { kind: "time" } });
    expect(live.requests).toHaveLength(1);
  });

  it("asks a failing live service once and reports its failure", async () => {
    let calls = 0;
    const failing = {
      async query() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw new Error("live service unavailable");
      },
    } as unknown as Source;
    const source = await pairedSource(await served(), {
      budget: { maxBytes: 4_096, maxTimeToFirstResultMs: 100 },
      serverSource: failing,
    });
    await expect(source.lookup(MERGED_MULTIPART_PARCEL)).rejects.toThrow("live service unavailable");
    expect(calls).toBe(1);
  });
});
