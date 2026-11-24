import { expect, it, vi } from "vitest";
import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Result,
  type SearchSource,
  findSources,
  identifySources,
  queryFilter,
} from "../../src/contract/index.js";

function source(id: string, result: Result = { features: [], exceededTransferLimit: false }) {
  return {
    descriptor: {
      id,
      protocol: "grpc",
      locator: { url: "https://native.example", serviceId: "inspection", layerId: 0 },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.grpc,
    },
    query: vi.fn<SearchSource["query"]>().mockResolvedValue(result),
  } satisfies SearchSource;
}

it("identifies using an input-CRS envelope and preserves each bounded result", async () => {
  const result: Result = { features: [], exceededTransferLimit: true, totalCount: 123 };
  const parcels = source("parcels", result);
  const roads = source("roads");
  const controller = new AbortController();
  const filter = queryFilter.eq("status", "open");
  const found = await identifySources([parcels, roads], {
    x: 100,
    y: 200,
    tolerance: 5,
    spatialReference: { wkid: 3857 },
    limit: 20,
    query: { filter, signal: controller.signal, outFields: ["status"] },
  });
  expect(found.map((item) => item.sourceId)).toEqual(["parcels", "roads"]);
  expect(found[0].result).toBe(result);
  expect(parcels.query).toHaveBeenCalledWith(
    expect.objectContaining({
      filter,
      signal: controller.signal,
      outFields: ["status"],
      pagination: { limit: 20 },
      spatialFilter: expect.objectContaining({
        geometry: { xmin: 95, ymin: 195, xmax: 105, ymax: 205, spatialReference: { wkid: 3857 } },
      }),
    }),
  );
});

it("keeps literal search text in typed equality filters and combines an existing filter", async () => {
  const parcels = source("parcels");
  const filter = queryFilter.eq("active", true);
  const text = "O'Brien%_";
  await findSources([{ source: parcels, fields: ["name", "owner"] }], {
    search: { text },
    query: { filter },
  });
  expect(parcels.query).toHaveBeenCalledWith({
    pagination: { limit: 100 },
    filter: queryFilter.and(filter, queryFilter.or(queryFilter.eq("name", text), queryFilter.eq("owner", text))),
  });
});

it("supports explicit LIKE patterns and source-specific search fields", async () => {
  const parcels = source("parcels");
  const roads = source("roads");
  await findSources(
    [
      { source: parcels, fields: ["owner"] },
      { source: roads, fields: ["road_name"] },
    ],
    {
      search: { pattern: "%main_", caseSensitive: false },
    },
  );
  expect(roads.query).toHaveBeenCalledWith({
    pagination: { limit: 100 },
    filter: queryFilter.or(queryFilter.like("road_name", "%main_", { caseSensitive: false })),
  });
});

it("validates all targets before querying any source", async () => {
  const parcels = source("parcels");
  await expect(
    findSources(
      [
        { source: parcels, fields: ["name"] },
        { source: parcels, fields: [] },
      ],
      {
        search: { text: "main" },
      },
    ),
  ).rejects.toThrow(TypeError);
  expect(parcels.query).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid limit %s", async (limit) => {
  const parcels = source("parcels");
  await expect(identifySources([parcels], { x: 0, y: 0, tolerance: 1, limit })).rejects.toThrow(RangeError);
  expect(parcels.query).not.toHaveBeenCalled();
});

it("propagates cancellation and source failures rather than returning empty success", async () => {
  const parcels = source("parcels");
  const controller = new AbortController();
  controller.abort();
  await expect(
    findSources([{ source: parcels, fields: ["name"] }], {
      search: { text: "main" },
      query: { signal: controller.signal },
    }),
  ).rejects.toThrow();
  expect(parcels.query).not.toHaveBeenCalled();
  const failure = new Error("permission denied");
  parcels.query.mockRejectedValue(failure);
  await expect(identifySources([parcels], { x: 0, y: 0, tolerance: 1 })).rejects.toBe(failure);
});
