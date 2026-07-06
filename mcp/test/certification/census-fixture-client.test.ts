import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CENSUS_ROWS, CENSUS_SERVICE_ID } from "../../src/certification/census-data.js";
import { createStandaloneFixtureClient, filterRows } from "../../src/certification/census-fixture-client.js";

/**
 * Parity + degradation guard for the platform-free census fixture (issue #369).
 *
 * The in-memory GeoServices evaluator must agree with the LIVE recordings under
 * `test/fixtures/arcgis-census/` — otherwise the semantic eval assertions that
 * ride on it would be grounded in fiction. We also assert the fixture exposes NO
 * Honua surface (the OGC API - Styles probe 404s), which drives the capability
 * degradation path in the standalone tools.
 */

function loadRaw(name: string): Record<string, unknown> {
  const url = new URL(`../fixtures/arcgis-census/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Record<string, unknown>;
}

const client = createStandaloneFixtureClient();

describe("census fixture client — recorded-data parity", () => {
  it("recorded the full apportionment layer (52 rows)", () => {
    expect(CENSUS_ROWS).toHaveLength(52);
  });

  it("count matches the live returnCountOnly recording", async () => {
    const live = loadRaw("count.json");
    const result = (await client.queryFeatures({ extraParams: { returnCountOnly: true } })) as { count: number };
    expect(result.count).toBe(52);
    expect(result.count).toBe(live.count);
  });

  it("filtered count matches the live recording (Seats_2020>=20 => 4)", async () => {
    const live = loadRaw("count-seats-ge-20.json");
    const result = (await client.queryFeatures({
      where: "Seats_2020>=20",
      extraParams: { returnCountOnly: true },
    })) as { count: number };
    expect(result.count).toBe(4);
    expect(result.count).toBe(live.count);
  });

  it("sum(population) matches the live statistic recording", async () => {
    const live = loadRaw("stat-sum-pop.json") as { features: { attributes: Record<string, number> }[] };
    const result = (await client.queryFeatures({
      outStatistics: [
        { statisticType: "sum", onStatisticField: "Total_Pop_2020", outStatisticFieldName: "sum_Total_Pop_2020" },
      ],
    })) as { features: { attributes: Record<string, number> }[] };
    expect(result.features[0].attributes.sum_Total_Pop_2020).toBe(335085841);
    expect(result.features[0].attributes.sum_Total_Pop_2020).toBe(live.features[0].attributes.sum_Total_Pop_2020);
  });

  it("sum(seats) ignores NULL delegations and equals the House size (435)", async () => {
    const result = (await client.queryFeatures({
      outStatistics: [
        { statisticType: "sum", onStatisticField: "Seats_2020", outStatisticFieldName: "sum_Seats_2020" },
      ],
    })) as { features: { attributes: Record<string, number> }[] };
    expect(result.features[0].attributes.sum_Seats_2020).toBe(435);
  });

  it("max/min population match the live recordings (California / Wyoming)", async () => {
    const max = (await client.queryFeatures({
      outStatistics: [{ statisticType: "max", onStatisticField: "Total_Pop_2020", outStatisticFieldName: "m" }],
    })) as { features: { attributes: Record<string, number> }[] };
    const min = (await client.queryFeatures({
      outStatistics: [{ statisticType: "min", onStatisticField: "Total_Pop_2020", outStatisticFieldName: "m" }],
    })) as { features: { attributes: Record<string, number> }[] };
    expect(max.features[0].attributes.m).toBe(39576757);
    expect(min.features[0].attributes.m).toBe(577719);
  });

  it("orders by population and returns the correct top/bottom row", async () => {
    const top = (await client.queryFeatures({
      orderByFields: "Total_Pop_2020 DESC",
      resultRecordCount: 1,
    })) as { features: { attributes: Record<string, unknown> }[] };
    const bottom = (await client.queryFeatures({
      orderByFields: "Total_Pop_2020 ASC",
      resultRecordCount: 1,
    })) as { features: { attributes: Record<string, unknown> }[] };
    expect(top.features[0].attributes.NAME).toBe("California");
    expect(bottom.features[0].attributes.NAME).toBe("Wyoming");
  });

  it("filters by a string WHERE clause", async () => {
    const ca = (await client.queryFeatures({ where: "STUSPS='CA'" })) as {
      features: { attributes: Record<string, unknown> }[];
    };
    expect(ca.features).toHaveLength(1);
    expect(ca.features[0].attributes.NAME).toBe("California");
    expect(ca.features[0].attributes.Total_Pop_2020).toBe(39576757);
  });

  it("returns the recorded extent for returnExtentOnly", async () => {
    const result = (await client.queryFeatures({ extraParams: { returnExtentOnly: true } })) as {
      extent: { spatialReference: { wkid: number } };
    };
    expect(result.extent.spatialReference.wkid).toBe(102100);
  });

  it("exposes the census service and a polygon layer schema", async () => {
    const services = await client.listServices();
    expect(services.services?.[0]?.name).toBe(CENSUS_SERVICE_ID);
    const layer = await client.getLayerMetadata(CENSUS_SERVICE_ID, 0);
    expect(layer.geometryType).toBe("esriGeometryPolygon");
    expect((layer.fields ?? []).map((f) => f.name)).toContain("Total_Pop_2020");
  });
});

describe("census fixture client — no Honua surface", () => {
  it("404s the OGC API - Styles probe (drives capability degradation)", async () => {
    const response = await client.pipelineFetch("GET", "/ogc/styles");
    expect(response.status).toBe(404);
  });
});

describe("filterRows helper", () => {
  it("returns all rows for 1=1 / empty", () => {
    expect(filterRows("1=1")).toHaveLength(52);
    expect(filterRows(undefined)).toHaveLength(52);
  });

  it("supports numeric comparisons and AND", () => {
    expect(filterRows("Total_Pop_2020>10000000")).toHaveLength(10);
    expect(filterRows("Seats_2020>=20 AND Total_Pop_2020>10000000")).toHaveLength(4);
  });

  it("throws on an unsupported clause rather than silently returning wrong data", () => {
    expect(() => filterRows("NAME LIKE '%California%'")).toThrow(/unsupported/i);
  });
});
