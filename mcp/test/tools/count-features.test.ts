import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/count-features.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("honua_count_features", () => {
  it("returns count from response", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 42 }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(42);
  });

  it("passes returnCountOnly in extraParams", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 10 }),
    });
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        extraParams: { returnCountOnly: true },
        returnGeometry: false,
      }),
    );
  });

  it("maps spatialRel for count queries", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 5 }),
    });
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0, spatialRel: "within" }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ spatialRel: "esriSpatialRelWithin" }));
  });

  it("includes inferred geometryType in query", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 5 }),
    });
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        geometry: {
          rings: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ geometryType: "esriGeometryPolygon" }));
  });

  it("uses explicit geometryType when provided", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 5 }),
    });
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        geometry: { x: 1, y: 2 },
        geometryType: "esriGeometryEnvelope",
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ geometryType: "esriGeometryEnvelope" }));
  });

  it("throws if response does not include numeric count", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({}),
    });
    await expect(execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }))).rejects.toThrow(
      "Count query did not return a numeric count",
    );
  });

  it("throws for non-finite or non-numeric count values", async () => {
    const badCountMock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: Number.POSITIVE_INFINITY }),
    });
    await expect(execute(asClient(badCountMock), schema.parse({ serviceId: "Parks", layerId: 0 }))).rejects.toThrow(
      "Count query did not return a numeric count",
    );

    const nonNumericStringMock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: "not-a-number" }),
    });
    await expect(
      execute(asClient(nonNumericStringMock), schema.parse({ serviceId: "Parks", layerId: 0 })),
    ).rejects.toThrow("Count query did not return a numeric count");
  });

  it("accepts a numeric string count (large counts past Number.MAX_SAFE_INTEGER)", async () => {
    // The grpc-web transport returns counts beyond Number.MAX_SAFE_INTEGER as
    // strings to preserve precision; the tool must surface them, not throw.
    const big = "9007199254740993"; // 2^53 + 1
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: big }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(big);
  });

  it("accepts a small numeric string count", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: "42" }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe("42");
  });

  it("rejects negative layerId", () => {
    expect(() => schema.parse({ serviceId: "Parks", layerId: -1 })).toThrow();
  });
});
