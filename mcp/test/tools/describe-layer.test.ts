import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/describe-layer.js";
import { asClient, createMockClient } from "../test-helpers.js";

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("honua_describe_layer", () => {
  it("returns formatted layer metadata inside the neutral envelope", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 })));

    expect(parsed.source).toBe("geoservices-feature-service:Parks/0");
    expect(parsed.protocol).toBe("geoservices-feature-service");
    expect(parsed.capabilities).toContain("query");
    expect(parsed.id).toBe(0);
    expect(parsed.name).toBe("Test Layer");
    expect(parsed.description).toBe("A test layer");
    expect(parsed.geometryType).toBe("esriGeometryPoint");
    expect(parsed.fields).toHaveLength(3);
    expect(parsed.fields[0]).toEqual({ name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" });
    expect(parsed.fields[1]).toEqual({ name: "NAME", type: "esriFieldTypeString", alias: "Feature Name" });
    expect(parsed.extent).toEqual({ xmin: -180, ymin: -90, xmax: 180, ymax: 90 });
    expect(parsed.spatialReference).toEqual({ wkid: 4326 });
    expect(parsed.relationships).toHaveLength(1);
    expect(parsed.schemaAvailable).toBe(true);
  });

  it("resolves a neutral source reference to the same layer", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ source: "geoservices-feature-service:Census/3" }));

    expect(mock.getLayerMetadata).toHaveBeenCalledWith("Census", 3);
  });

  it("passes correct serviceId and layerId to client", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ serviceId: "Census", layerId: 3 }));

    expect(mock.getLayerMetadata).toHaveBeenCalledWith("Census", 3);
  });

  it("normalizes nullable metadata fields", async () => {
    const mock = createMockClient({
      getLayerMetadata: vi.fn().mockResolvedValue({
        id: 0,
        name: "Minimal Layer",
        fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
      }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 })));

    expect(parsed.description).toBeNull();
    expect(parsed.geometryType).toBeNull();
    expect(parsed.extent).toBeNull();
    expect(parsed.spatialReference).toBeNull();
    expect(parsed.relationships).toEqual([]);
  });

  it("describes protocols with no schema document as unavailable, not as empty", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse({ source: "stac:sentinel-2-l2a" })));

    expect(parsed.protocol).toBe("stac");
    expect(parsed.fields).toEqual([]);
    expect(parsed.schemaAvailable).toBe(false);
    expect(parsed.schemaReason).toContain("stac");
  });

  it("turns an unconstructable source into a structured addressing error", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({ source: "wfs:topp:states" }));

    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe("ValidationFailed");
  });

  it("rejects negative layerId", () => {
    expect(() => schema.parse({ serviceId: "Parks", layerId: -1 })).toThrow();
  });
});
