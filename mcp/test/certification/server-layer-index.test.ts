import { describe, expect, it } from "vitest";
import { advertisedLayerKey } from "../../src/certification/certifier.js";
import { buildRoundTripInputs, resolveRoundTripEnv } from "../../src/certification/fixtures.js";
import { firstPublishedLayer } from "../../src/certification/round-trip-target.js";

// honua-server's MCP map tools (MapToolModels.cs) address a layer as serviceId + serviceLayerIndex.
const env = resolveRoundTripEnv({ HONUA_MCP_SERVICE_ID: "svc-parks", HONUA_MCP_LAYER_ID: "2" });
const serverQueryTool = {
  name: "honua_query_features",
  inputSchema: { properties: { serviceId: {}, serviceLayerIndex: {}, limit: {} } },
};
const referenceQueryTool = {
  name: "honua_query_features",
  inputSchema: { properties: { serviceId: {}, layerId: {}, limit: {} } },
};

describe("live honua-server layer addressing", () => {
  it("discovers a layer from the server's honua_list_layers rows", () => {
    const rows = { layers: [{ serviceId: "svc-parks", serviceName: "Parks", serviceLayerIndex: 2 }] };

    expect(firstPublishedLayer(rows)).toEqual({ serviceId: "svc-parks", layerId: 2 });
  });

  it("takes the layer argument name from the advertised input schema", () => {
    expect(advertisedLayerKey([serverQueryTool])).toBe("serviceLayerIndex");
    expect(advertisedLayerKey([referenceQueryTool])).toBe("layerId");
    expect(advertisedLayerKey([])).toBe("layerId");
  });

  it("sends serviceLayerIndex to a server that advertises it", () => {
    const inputs = buildRoundTripInputs({ ...env, layerKey: advertisedLayerKey([serverQueryTool]) });

    expect(inputs.honua_describe_layer).toEqual({ serviceId: "svc-parks", serviceLayerIndex: 2 });
    expect(inputs.honua_query_features).toEqual({ serviceId: "svc-parks", serviceLayerIndex: 2, limit: 1 });
    expect(inputs.honua_render_map.layers).toEqual([{ serviceId: "svc-parks", serviceLayerIndex: 2 }]);
  });

  it("keeps layerId for a target on the reference schemas", () => {
    const inputs = buildRoundTripInputs({ ...env, layerKey: advertisedLayerKey([referenceQueryTool]) });

    expect(inputs.honua_describe_layer).toEqual({ serviceId: "svc-parks", layerId: 2 });
    expect(inputs.honua_render_map.layers).toEqual([{ serviceId: "svc-parks", layerId: 2 }]);
  });
});
