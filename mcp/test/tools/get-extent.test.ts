import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/get-extent.js";
import { asClient, createMockClient } from "../test-helpers.js";

const NEUTRAL = { source: "geoservices-feature-service:Parks/0" };

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("honua_get_extent", () => {
  it("returns extent and count through the canonical queryExtent surface", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        extent: { xmin: -120, ymin: 30, xmax: -110, ymax: 40 },
        count: 15,
      }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse(NEUTRAL)));

    expect(parsed.extent).toEqual({ xmin: -120, ymin: 30, xmax: -110, ymax: 40 });
    expect(parsed.count).toBe(15);
    expect(parsed.source).toBe("geoservices-feature-service:Parks/0");
    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ extraParams: expect.objectContaining({ returnExtentOnly: true }) }),
    );
  });

  it("reports a server-side extent capability for a GeoServices source", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, count: 1 }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse(NEUTRAL)));

    expect(parsed.extentCapability).toBe("server");
  });

  it("accepts the deprecated serviceId/layerId pair", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: null, count: 0 }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 })));

    expect(parsed.extent).toBeNull();
    expect(parsed.count).toBe(0);
  });

  it("returns a null extent when the backend reports a count-only payload", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ count: 4 }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse(NEUTRAL)));

    expect(parsed.extent).toBeNull();
    expect(parsed.count).toBe(4);
  });

  it("filters the extent query with the typed filter", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, count: 2 }),
    });
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, filter: { op: "eq", field: "STATE", value: "CA" } }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ where: "STATE = 'CA'" }));
  });

  it("returns a structured validation error when no source is addressed", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({}));

    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe("ValidationFailed");
  });
});
