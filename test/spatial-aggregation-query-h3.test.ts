import { describe, expect, it } from "vitest";

import {
  FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID,
  validateFeatureServerH3SpatialAggregationRequest,
} from "@honua/sdk-js/contract";
import type { SpatialAggregationRequest } from "@honua/sdk-js/contract";
import { HonuaClient } from "../src/index.js";

describe("FeatureServer queryH3 spatial aggregation adapter", () => {
  it("maps metric summaries to queryH3 outStatistics and returns protocol-neutral cells", async () => {
    let requestedUrl = "";
    let requestedMethod = "";
    let requestedBody = "";
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        requestedUrl = String(input);
        requestedMethod = String(init?.method ?? "GET");
        requestedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            spatialReference: { wkid: 4326 },
            features: [
              {
                attributes: {
                  cellIndex: "872a1072bffffff",
                  honua_1_incident_count: 12,
                  honua_2_sum_cost: "42.5",
                  honua_3_avg_score: null,
                },
                geometry: {
                  rings: [
                    [
                      [-157.9, 21.2],
                      [-157.8, 21.2],
                      [-157.8, 21.3],
                      [-157.9, 21.3],
                      [-157.9, 21.2],
                    ],
                  ],
                  spatialReference: { wkid: 4326 },
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const layer = client.featureLayer("incidents", 2);
    const result = await layer.querySpatialAggregation({
      requestId: "req-1",
      where: "status = 'open'",
      resolution: { indexResolution: 7 },
      index: { geometry: "boundary" },
      summaries: [
        { id: "incident-count", kind: "count", field: "OBJECTID" },
        { id: "sum-cost", kind: "sum", field: "COST", unit: "usd" },
        { id: "avg-score", kind: "avg", field: "SCORE" },
      ],
      kRingDistance: 1,
    });

    expect(requestedMethod).toBe("POST");
    expect(requestedUrl).toBe("https://example.test/rest/services/incidents/FeatureServer/2/queryH3?f=json");

    const params = new URLSearchParams(requestedBody);
    expect(params.get("resolution")).toBe("7");
    expect(params.get("where")).toBe("status = 'open'");
    expect(params.get("kRingDistance")).toBe("1");
    expect(JSON.parse(params.get("outStatistics") ?? "[]")).toEqual([
      {
        statisticType: "count",
        onStatisticField: "OBJECTID",
        outStatisticFieldName: "honua_1_incident_count",
      },
      {
        statisticType: "sum",
        onStatisticField: "COST",
        outStatisticFieldName: "honua_2_sum_cost",
      },
      {
        statisticType: "avg",
        onStatisticField: "SCORE",
        outStatisticFieldName: "honua_3_avg_score",
      },
    ]);

    expect(result).toMatchObject({
      schemaVersion: "honua.spatial-aggregation.v1",
      requestId: "req-1",
      sourceId: "geoservices-feature-service:incidents/2",
      index: {
        resolution: 7,
        model: {
          id: FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID,
          cellIdEncoding: "string",
        },
      },
    });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]?.id).toBe("872a1072bffffff");
    expect(result.cells[0]?.geometry).toMatchObject({ rings: expect.any(Array) });
    expect(result.cells[0]?.extent).toEqual({
      xmin: -157.9,
      ymin: 21.2,
      xmax: -157.8,
      ymax: 21.3,
      spatialReference: { wkid: 4326 },
    });
    expect(result.cells[0]?.summaries).toEqual({
      "incident-count": { kind: "count", value: 12 },
      "sum-cost": { kind: "sum", value: 42.5, unit: "usd" },
      "avg-score": { kind: "avg", value: null, unit: undefined },
    });
    expect(result.metadata.cache).toMatchObject({
      metadataCacheable: true,
      resultCacheable: false,
    });
    expect(result.metadata.widgets?.map((widget) => widget.summaryId)).toEqual([
      "incident-count",
      "sum-cost",
      "avg-score",
    ]);
  });

  it("uses the server default count column for a single count summary without outStatistics", async () => {
    let requestedUrl = "";
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            features: [
              {
                attributes: { cellIndex: "opaque-cell", count: "3" },
                geometry: {
                  rings: [
                    [
                      [0, 0],
                      [1, 0],
                      [1, 1],
                      [0, 1],
                      [0, 0],
                    ],
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.featureLayer("assets", 0).querySpatialAggregation({
      method: "GET",
      resolution: { indexResolution: 5 },
      index: { geometry: "extent" },
      summaries: [{ id: "featureCount", kind: "count" }],
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/rest/services/assets/FeatureServer/0/queryH3");
    expect(url.searchParams.get("resolution")).toBe("5");
    expect(url.searchParams.has("outStatistics")).toBe(false);

    expect(result.cells[0]?.id).toBe("opaque-cell");
    expect(result.cells[0]?.geometry).toBeUndefined();
    expect(result.cells[0]?.extent).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 1, spatialReference: undefined });
    expect(result.cells[0]?.summaries).toEqual({
      featureCount: { kind: "count", value: 3 },
    });
  });

  it("rejects summaries and request options that queryH3 cannot serve", async () => {
    const request: SpatialAggregationRequest = {
      sourceId: "incidents",
      resolution: { indexResolution: 7 },
      summaries: [{ id: "by-type", kind: "category", field: "TYPE" }],
    };

    expect(validateFeatureServerH3SpatialAggregationRequest(request)).toContainEqual({
      path: "summaries[0].kind",
      message: "category summaries are not supported by FeatureServer queryH3",
    });

    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () => new Response(JSON.stringify({ features: [] }), { status: 200 }),
    });

    await expect(client.featureLayer("incidents", 2).querySpatialAggregation(request)).rejects.toThrow(
      "category summaries are not supported by FeatureServer queryH3",
    );
  });
});
