import { describe, expect, it } from "vitest";
import { createDataset, queryFilter } from "../src/contract/index.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaGeometryError } from "../src/core/errors.js";
import { envelope } from "../src/core/spatial-filter.js";
import { jsonResponse, makeMockClient } from "./contract/shared.js";

// A Web Mercator layer: an untagged degree-sized envelope must not be interpreted
// as metres. Keep the layer CRS different from the README's query input CRS.
const WEB_MERCATOR_STATE = {
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  geometryType: "esriGeometryPoint",
  features: [
    {
      attributes: { OBJECTID: 1, NAME: "California", Total_Pop_2020: 39538223 },
      geometry: { x: -13358338.9, y: 4163881.1 },
    },
  ],
};

describe("quickstart input CRS on the GeoServices wire", () => {
  it("runs the canonical typed query against a non-WGS84 layer", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/query",
          (url) => {
            expect(url.searchParams.get("inSR")).toBe("4326");
            expect(url.searchParams.get("where")).toContain("Total_Pop_2020 > 1000000");
            return jsonResponse(WEB_MERCATOR_STATE);
          },
        ],
      ],
    });
    const source = createDataset({
      id: "states",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "states",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock.honua.test", serviceId: "states", layerId: 0 },
          capabilities: capabilities(["query"]),
        },
      ],
    }).source("states")!;
    const result = await source.queryAll({
      filter: queryFilter.and(
        queryFilter.gt("Total_Pop_2020", 1_000_000),
        queryFilter.spatial("intersects", envelope(-125, 24, -66, 50)),
      ),
      pagination: { limit: 100 },
    });
    expect(result.features).toHaveLength(1);
  });

  it.each(["GET", "POST"] as const)("preserves explicit and default CRS in %s requests", async (method) => {
    let expected = "4326";
    const client = makeMockClient({
      routes: [
        [
          "/query",
          (url, init) => {
            const params = method === "POST" ? new URLSearchParams(String(init?.body)) : url.searchParams;
            expect(params.get("inSR")).toBe(expected);
            expect(params.has("geometry")).toBe(true);
            return jsonResponse(WEB_MERCATOR_STATE);
          },
        ],
      ],
    });
    const base = { serviceId: "states", layerId: 0, method };
    await client.queryFeatures({ ...base, geometry: { xmin: -125, ymin: 24, xmax: -66, ymax: 50 } });
    expected = "26911";
    await client.queryFeatures({ ...base, ...envelope(300000, 3700000, 400000, 3800000, { wkid: 26911 }) });
    expected = "3857";
    await client.queryFeatures({
      ...base,
      geometry: JSON.stringify({ x: 0, y: 0, spatialReference: { wkid: 102100, latestWkid: 3857 } }),
    });
    expected = "26911";
    await client.queryFeatures({ ...base, geometry: "300000,3700000", extraParams: { inSR: 26911 } });
    await expect(client.queryFeatures({ ...base, geometry: { x: 1, y: 2, spatialReference: {} } })).rejects.toThrow(
      HonuaGeometryError,
    );
  });
});
