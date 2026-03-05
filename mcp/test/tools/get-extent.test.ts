import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/get-extent.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("honua_get_extent", () => {
  it("returns extent and count from response", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        extent: { xmin: -120, ymin: 30, xmax: -110, ymax: 40 },
        count: 15,
      }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.extent).toEqual({ xmin: -120, ymin: 30, xmax: -110, ymax: 40 });
    expect(parsed.count).toBe(15);
  });

  it("passes returnExtentOnly in extraParams", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: {}, count: 0 }),
    });
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        extraParams: { returnExtentOnly: true },
        returnGeometry: false,
      }),
    );
  });

  it("maps spatialRel and inferred geometryType", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: {}, count: 0 }),
    });
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        spatialRel: "contains",
        geometry: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        spatialRel: "esriSpatialRelContains",
        geometryType: "esriGeometryEnvelope",
      }),
    );
  });

  it("uses explicit geometryType when provided", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: {}, count: 0 }),
    });
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        geometry: { x: 1, y: 2 },
        geometryType: "esriGeometryPoint",
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ geometryType: "esriGeometryPoint" }));
  });

  it("returns null extent when backend returns count-only payload", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 0 }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({ extent: null, count: 0 });
  });

  it("returns null extent when backend returns explicit null extent", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: null, count: 0 }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({ extent: null, count: 0 });
  });

  it("throws if extent payload is missing", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({}),
    });
    await expect(execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }))).rejects.toThrow(
      "Extent query did not return an extent payload",
    );
  });

  it("throws for invalid extent payload types", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: 42 }),
    });
    await expect(execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }))).rejects.toThrow(
      "Extent query returned an invalid extent payload",
    );
  });

  it("rejects negative layerId", () => {
    expect(() => schema.parse({ serviceId: "Parks", layerId: -1 })).toThrow();
  });
});
