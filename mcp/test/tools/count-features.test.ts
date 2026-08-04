import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/count-features.js";
import { asClient, createMockClient } from "../test-helpers.js";

const NEUTRAL = { source: "geoservices-feature-service:Parks/0" };

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** A GeoServices layer answers an extent-only query with an exact count. */
function countingClient(count: unknown) {
  return createMockClient({
    queryFeatures: vi.fn().mockResolvedValue({ count, extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } }),
  });
}

describe("honua_count_features", () => {
  it("counts through the canonical queryExtent path on a GeoServices source", async () => {
    const mock = countingClient(42);
    const parsed = parse(await execute(asClient(mock), schema.parse(NEUTRAL)));

    expect(parsed.count).toBe(42);
    expect(parsed.countStrategy).toBe("queryExtent");
    expect(parsed.source).toBe("geoservices-feature-service:Parks/0");
    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ extraParams: expect.objectContaining({ returnExtentOnly: true }) }),
    );
  });

  it("accepts the deprecated serviceId/layerId pair", async () => {
    const mock = countingClient(7);
    const parsed = parse(await execute(asClient(mock), schema.parse({ serviceId: "Parks", layerId: 0 })));

    expect(parsed.count).toBe(7);
  });

  it("compiles the typed filter into the counted request", async () => {
    const mock = countingClient(3);
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, filter: { op: "gte", field: "Seats", value: 20 } }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ where: "Seats >= 20" }));
  });

  it("still accepts the deprecated source-native where clause", async () => {
    const mock = countingClient(3);
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, where: "Seats >= 20" }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ where: "Seats >= 20" }));
  });

  it("refuses with a structured capability error when no path yields a count", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({ features: [] }),
    });
    const result = await execute(asClient(mock), schema.parse(NEUTRAL));

    expect(result.isError).toBe(true);
    const parsed = parse(result);
    expect(parsed.code).toBe("capability_not_supported");
    expect(parsed.error.capability).toBe("count");
    // The honest outcome is a refusal, never a fabricated zero.
    expect(parsed.count).toBeUndefined();
  });

  it("ignores a non-finite count and refuses rather than reporting it", async () => {
    const mock = countingClient(Number.NaN);
    const result = await execute(asClient(mock), schema.parse(NEUTRAL));

    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe("capability_not_supported");
  });

  it("returns a structured validation error for an unknown protocol token", async () => {
    const mock = countingClient(1);
    const result = await execute(asClient(mock), schema.parse({ source: "nope:thing" }));

    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe("ValidationFailed");
  });
});
