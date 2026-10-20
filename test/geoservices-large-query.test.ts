import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { polygon } from "../src/core/spatial-filter.js";
import type { HonuaRequestInterceptor, QueryMethod } from "../src/core/types.js";
import { createArcGisTokenInterceptor } from "../src/esri-compat/request.js";

const ring = Array.from({ length: 401 }, (_, i) => {
  const angle = ((i % 400) / 400) * Math.PI * 2;
  return [-74 + Math.cos(angle) / 100, 40.7 + Math.sin(angle) / 100];
});
const geometry = { rings: [ring], spatialReference: { wkid: 4326 } };

function fixture(
  preferBinary = false,
  enforceUrlLimit = true,
  options: { interceptors?: HonuaRequestInterceptor[]; failFirst?: number } = {},
) {
  const requests: Array<{ url: URL; init: RequestInit; params: URLSearchParams }> = [];
  const client = new HonuaClient({
    baseUrl: "https://mock.honua.test",
    apiKey: "test-key",
    preferBinary,
    interceptors: options.interceptors,
    retry: options.failFirst ? { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 } : { maxRetries: 0 },
    fetchFn: async (input, init = {}) => {
      const url = new URL(String(input));
      const params = init.method === "POST" ? new URLSearchParams(String(init.body)) : url.searchParams;
      requests.push({ url, init, params });
      if (requests.length <= (options.failFirst ?? 0)) return new Response("busy", { status: 503 });
      if (enforceUrlLimit && url.pathname.length + url.search.length > 2_000)
        return new Response("Request target too large", { status: 431 });
      const payload =
        params.get("returnIdsOnly") === "true"
          ? { objectIds: [1, 2], objectIdFieldName: "objectid" }
          : params.get("returnExtentOnly") === "true"
            ? { extent: { xmin: -74, ymin: 40, xmax: -73, ymax: 41 }, count: 2 }
            : { features: [{ attributes: { objectid: 1, record_count: 2 } }], exceededTransferLimit: false };
      return Response.json(payload);
    },
  });
  return { client, requests };
}

describe("GeoServices large query transport", () => {
  it.each([false, true])("preserves long geometry in POST with binary preference %s", async (preferBinary) => {
    const { client, requests } = fixture(preferBinary);
    const cancellation = new AbortController();
    await client.queryFeatures({
      serviceId: "Flights",
      layerId: 0,
      geometry,
      geometryType: "esriGeometryPolygon",
      spatialRel: "esriSpatialRelIntersects",
      where: "kind = 'helicopter'",
      outFields: ["objectid", "kind"],
      signal: cancellation.signal,
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.init.method).toBe("POST");
    expect(request.url.search).toBe("");
    expect(new Headers(request.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(request.init.headers).get("x-api-key")).toBe("test-key");
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.params.get("geometry")!)).toEqual(geometry);
    expect(request.params.get("where")).toBe("kind = 'helicopter'");
    expect(request.params.get("outFields")).toBe("objectid,kind");
    expect(request.params.get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(request.params.get("f")).toBe("json");
  });

  it("measures escaped Unicode and uses the same policy for MapServer", async () => {
    const { client, requests } = fixture();
    const where = `name = '${"東京".repeat(150)}'`;
    expect(where.length).toBeLessThan(2_000);
    await client.queryMapLayer({ serviceId: "Flights", layerId: 0, where });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.params.get("where")).toBe(where);
  });

  it.each(["GET", "POST"] as const)("honors an explicit %s choice", async (method: QueryMethod) => {
    const { client, requests } = fixture(false, false);
    await client.queryFeatures({ serviceId: "Flights", layerId: 0, geometry, method });
    await client.queryMapLayer({ serviceId: "Flights", layerId: 0, geometry, method });
    expect(requests.map((request) => request.init.method)).toEqual([method, method]);
    for (const request of requests) expect(JSON.parse(request.params.get("geometry")!)).toEqual(geometry);
  });

  it("retains short GET queries", async () => {
    const { client, requests } = fixture();
    await client.queryFeatures({ serviceId: "Flights", layerId: 0 });
    await client.queryMapLayer({ serviceId: "Flights", layerId: 0 });
    expect(requests.map((request) => request.init.method)).toEqual(["GET", "GET"]);
  });

  it.each(["geoservices-feature-service", "geoservices-map-service"] as const)(
    "carries canonical feature, aggregate, IDs and extent constraints through %s",
    async (protocol) => {
      const { client, requests } = fixture();
      const dataset = createDataset({
        id: "flights",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "tracks",
            protocol,
            locator: { url: "https://mock.honua.test", serviceId: "Flights", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[protocol],
          },
        ],
      });
      const source = dataset.source("tracks")!;
      const query = { spatialFilter: polygon(geometry.rings, { wkid: 4326 }), where: "kind = 'helicopter'" };
      await source.query(query);
      const result = await source.queryAggregate({
        ...query,
        aggregation: { metrics: [{ fn: "count", field: "objectid", alias: "record_count" }] },
      });
      expect(result.aggregateRows).toEqual([{ objectid: 1, record_count: 2 }]);
      expect(await source.queryObjectIds(query)).toEqual([1, 2]);
      expect(await source.queryExtent(query)).toEqual({
        extent: { xmin: -74, ymin: 40, xmax: -73, ymax: 41 },
        count: 2,
      });
      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(request.init.method).toBe("POST");
        expect(request.params.get("where")).toBe(query.where);
        expect(JSON.parse(request.params.get("geometry")!)).toEqual(geometry);
      }
    },
  );
});

describe("GeoServices large query transport with request interceptors", () => {
  const token = "t".repeat(200);
  const entryPoints = [
    ["queryFeatures", false],
    ["queryFeatures", true],
    ["queryMapLayer", false],
  ] as const;

  // Size `where` so the caller-measured GET target is 1,990 characters: under
  // the 2,000 budget until an interceptor appends the token.
  async function nearLimitWhere(entry: "queryFeatures" | "queryMapLayer", preferBinary: boolean) {
    const probe = fixture(preferBinary);
    await probe.client[entry]({ serviceId: "Flights", layerId: 0, where: "kind = ''" });
    const base = probe.requests[0]!.url;
    const where = `kind = '${"a".repeat(1_990 - (base.pathname.length + base.search.length))}'`;
    const sized = fixture(preferBinary);
    await sized.client[entry]({ serviceId: "Flights", layerId: 0, where });
    const target = sized.requests[0]!.url;
    expect(sized.requests[0]!.init.method).toBe("GET");
    expect(target.pathname.length + target.search.length).toBe(1_990);
    return where;
  }

  it.each(entryPoints)("%s (binary %s) moves an interceptor-grown target into the POST body", async (entry, binary) => {
    const where = await nearLimitWhere(entry, binary);
    const { client, requests } = fixture(binary, true, {
      interceptors: [createArcGisTokenInterceptor({ getToken: () => token })],
    });
    const response = await client[entry]({ serviceId: "Flights", layerId: 0, where });
    expect(response.features).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.init.method).toBe("POST");
    expect(request.url.search).toBe("");
    expect(new Headers(request.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request.params.get("token")).toBe(token);
    expect(request.params.get("where")).toBe(where);
    expect(request.params.get("f")).toBe("json");
  });

  it.each(entryPoints)("%s (binary %s) keeps transient retry for the converted POST", async (entry, binary) => {
    const where = await nearLimitWhere(entry, binary);
    const { client, requests } = fixture(binary, true, {
      interceptors: [createArcGisTokenInterceptor({ getToken: () => token })],
      failFirst: 1,
    });
    await client[entry]({ serviceId: "Flights", layerId: 0, where });
    expect(requests.map((request) => request.init.method)).toEqual(["POST", "POST"]);
    expect(requests[1]!.params.get("where")).toBe(where);
    expect(requests[1]!.params.get("token")).toBe(token);
  });

  it("does not grant replay when an interceptor moves the query to another endpoint", async () => {
    const where = await nearLimitWhere("queryFeatures", false);
    const rewrite: HonuaRequestInterceptor = {
      before: (context) => ({
        url: `${context.url.replace("/FeatureServer/0/query", "/FeatureServer/1/query")}&token=${token}`,
      }),
    };
    const { client, requests } = fixture(false, true, { interceptors: [rewrite], failFirst: 1 });
    await expect(client.queryFeatures({ serviceId: "Flights", layerId: 0, where })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.url.pathname).toContain("/FeatureServer/1/query");
  });

  it("leaves an explicit GET on the URL even when an interceptor grows it", async () => {
    const where = await nearLimitWhere("queryFeatures", false);
    const { client, requests } = fixture(false, false, {
      interceptors: [createArcGisTokenInterceptor({ getToken: () => token })],
    });
    await client.queryFeatures({ serviceId: "Flights", layerId: 0, where, method: "GET" });
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.url.searchParams.get("token")).toBe(token);
  });
});
