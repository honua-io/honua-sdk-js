import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";

/** A FeatureServer layer with `rows` features that honors offset and count like ArcGIS. */
function layerFixture(rows: number) {
  const counts: number[] = [];
  const client = new HonuaClient({
    baseUrl: "https://mock.honua.test",
    retry: { maxRetries: 0 },
    fetchFn: async (input) => {
      const params = new URL(String(input)).searchParams;
      const offset = Number(params.get("resultOffset") ?? "0");
      const count = Number(params.get("resultRecordCount") ?? "2000");
      counts.push(count);
      const end = Math.min(rows, offset + count);
      const features = Array.from({ length: Math.max(0, end - offset) }, (_, index) => ({
        attributes: { objectid: offset + index + 1 },
      }));
      return Response.json({ features, exceededTransferLimit: end < rows });
    },
  });
  return { client, counts };
}

function sourceFor(client: HonuaClient, protocol: "geoservices-feature-service" | "geoservices-map-service") {
  return createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "parcels",
        protocol,
        locator: { url: "https://mock.honua.test", serviceId: "Parcels", layerId: 0 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES[protocol],
      },
    ],
  }).source("parcels")!;
}

describe("bounded queryAll row budget", () => {
  it.each(["geoservices-feature-service", "geoservices-map-service"] as const)(
    "%s fetches one probe row past the limit, not a whole extra page",
    async (protocol) => {
      const { client, counts } = layerFixture(5_000);
      const result = await sourceFor(client, protocol).queryAll({ pagination: { limit: 100 } });
      expect(result.features).toHaveLength(100);
      expect(result.exceededTransferLimit).toBe(true);
      expect(counts).toEqual([100, 1]);
    },
  );

  it("sizes the last of several pages to the remaining budget", async () => {
    const { client, counts } = layerFixture(12_000);
    const result = await sourceFor(client, "geoservices-feature-service").queryAll({ pagination: { limit: 10_000 } });
    expect(result.features).toHaveLength(10_000);
    expect(result.exceededTransferLimit).toBe(true);
    expect(counts).toEqual([2_000, 2_000, 2_000, 2_000, 2_000, 1]);
  });

  it("reports no overflow when the layer holds exactly the limit", async () => {
    const { client, counts } = layerFixture(100);
    const result = await sourceFor(client, "geoservices-feature-service").queryAll({ pagination: { limit: 100 } });
    expect(result.features).toHaveLength(100);
    expect(result.exceededTransferLimit).toBe(false);
    expect(counts).toEqual([100, 1]);
  });

  it("keeps draining full pages without a limit", async () => {
    const { client, counts } = layerFixture(4_500);
    const result = await sourceFor(client, "geoservices-feature-service").queryAll();
    expect(result.features).toHaveLength(4_500);
    expect(counts).toEqual([2_000, 2_000, 2_000]);
  });

  it("caps queryFeaturesAll at maxRecords on the layer surface", async () => {
    const { client, counts } = layerFixture(50);
    const features = await client.featureLayer("Parcels", 0).queryFeaturesAll({ pageSize: 2, maxRecords: 3 });
    expect(features).toHaveLength(3);
    expect(counts).toEqual([2, 1]);
  });
});
