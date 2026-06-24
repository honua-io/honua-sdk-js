import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/query-features.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("honua_query_features", () => {
  it("returns features with returnedCount", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.returnedCount).toBe(2);
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].attributes.NAME).toBe("Park A");
    expect(parsed.exceededTransferLimit).toBe(false);
  });

  it("returns stable null/false fallbacks for optional response metadata", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        features: [{ attributes: { OBJECTID: 1 } }],
      }),
    });
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.objectIdFieldName).toBeNull();
    expect(parsed.geometryType).toBeNull();
    expect(parsed.spatialReference).toBeNull();
    expect(parsed.exceededTransferLimit).toBe(false);
  });

  it("omits geometry when returnGeometry is false", async () => {
    const mock = createMockClient();
    const result = await execute(
      asClient(mock),
      schema.parse({ serviceId: "Parks", layerId: 0, returnGeometry: false }),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.features[0].geometry).toBeUndefined();
  });

  it("includes geometry when returnGeometry is true", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 10, y: 20 } }],
      }),
    });
    const result = await execute(
      asClient(mock),
      schema.parse({ serviceId: "Parks", layerId: 0, returnGeometry: true }),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.features[0].geometry).toEqual({ x: 10, y: 20 });
  });

  it("maps spatialRel to Esri enum", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0, spatialRel: "contains" }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ spatialRel: "esriSpatialRelContains" }));
  });

  it("maps geometryType from geometry payload when not explicitly provided", async () => {
    const mock = createMockClient();
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        geometry: { x: 10, y: 20 },
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ geometryType: "esriGeometryPoint" }));
  });

  it("prefers explicit geometryType over inferred value", async () => {
    const mock = createMockClient();
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        geometry: { x: 10, y: 20 },
        geometryType: "esriGeometryEnvelope",
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ geometryType: "esriGeometryEnvelope" }));
  });

  it("clamps limit to 2000", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0, limit: 5000 }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ resultRecordCount: 2000 }));
  });

  it("defaults limit to 100", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ resultRecordCount: 100 }));
  });

  it("maps orderBy to orderByFields", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0, orderBy: "NAME ASC" }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ orderByFields: "NAME ASC" }));
  });

  it("maps where/outFields/geometry/offset into query request", async () => {
    const mock = createMockClient();
    const geometry = { xmin: -120, ymin: 30, xmax: -110, ymax: 40 };
    await execute(
      asClient(mock),
      schema.parse({
        serviceId: "Parks",
        layerId: 0,
        where: "VALUE > 100",
        outFields: ["OBJECTID", "NAME"],
        geometry,
        offset: 25,
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        where: "VALUE > 100",
        outFields: ["OBJECTID", "NAME"],
        geometry,
        resultOffset: 25,
      }),
    );
  });

  it("defaults outFields to all fields when omitted", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ outFields: "*" }));
  });

  it("treats an empty outFields array as all fields (not OBJECTID-only)", async () => {
    // An empty array is a natural "no specific fields" from an agent; Esri
    // FeatureServer would otherwise treat "" as OBJECTID-only.
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0, outFields: [] }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ outFields: "*" }));
  });

  it("rejects invalid negative paging/layer inputs", () => {
    expect(() => schema.parse({ serviceId: "Parks", layerId: -1 })).toThrow();
    expect(() => schema.parse({ serviceId: "Parks", layerId: 0, offset: -1 })).toThrow();
    expect(() => schema.parse({ serviceId: "Parks", layerId: 0, limit: 0 })).toThrow();
  });
});
