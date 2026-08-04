import { describe, expect, it, vi } from "vitest";
import { execute, schema } from "../../src/tools/statistics.js";
import { asClient, createMockClient } from "../test-helpers.js";

const NEUTRAL = { source: "geoservices-feature-service:Parks/0" };

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("honua_statistics", () => {
  it("builds outStatistics and returns grouped results", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        features: [{ attributes: { STATE: "CA", avg_VALUE: 150 } }, { attributes: { STATE: "NY", avg_VALUE: 200 } }],
      }),
    });

    const parsed = parse(
      await execute(
        asClient(mock),
        schema.parse({ ...NEUTRAL, statisticType: "avg", onField: "VALUE", groupBy: "STATE" }),
      ),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        outStatistics: [{ statisticType: "avg", onStatisticField: "VALUE", outStatisticFieldName: "avg_VALUE" }],
        groupByFieldsForStatistics: "STATE",
      }),
    );
    expect(parsed.statistic).toBe("avg_VALUE");
    expect(parsed.statistics).toHaveLength(2);
    expect(parsed.statistics[0].attributes).toEqual({ STATE: "CA", avg_VALUE: 150 });
  });

  it("accepts an array groupBy", async () => {
    const mock = createMockClient({ queryFeatures: vi.fn().mockResolvedValue({ features: [] }) });
    await execute(
      asClient(mock),
      schema.parse({ ...NEUTRAL, statisticType: "sum", onField: "VALUE", groupBy: ["STATE", "CITY"] }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ groupByFieldsForStatistics: "STATE,CITY" }),
    );
  });

  it("supplies the GeoServices tautology when no filter is given", async () => {
    const mock = createMockClient({ queryFeatures: vi.fn().mockResolvedValue({ features: [] }) });
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, statisticType: "count", onField: "OBJECTID" }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ where: "1=1" }));
  });

  it("uses the typed filter instead of the tautology when one is given", async () => {
    const mock = createMockClient({ queryFeatures: vi.fn().mockResolvedValue({ features: [] }) });
    await execute(
      asClient(mock),
      schema.parse({
        ...NEUTRAL,
        statisticType: "sum",
        onField: "VALUE",
        filter: { op: "eq", field: "STATE", value: "CA" },
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ where: "STATE = 'CA'" }));
  });

  it("accepts the deprecated serviceId/layerId pair", async () => {
    const mock = createMockClient({ queryFeatures: vi.fn().mockResolvedValue({ features: [] }) });
    const parsed = parse(
      await execute(
        asClient(mock),
        schema.parse({ serviceId: "Parks", layerId: 0, statisticType: "count", onField: "OBJECTID" }),
      ),
    );

    expect(parsed.source).toBe("geoservices-feature-service:Parks/0");
    expect(parsed.statistics).toEqual([]);
  });

  it("returns a structured validation error when no source is addressed", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({ statisticType: "count", onField: "OBJECTID" }));

    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe("ValidationFailed");
  });
});
