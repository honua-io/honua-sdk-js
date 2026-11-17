import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advertisedLayerKey, certify } from "../../src/certification/certifier.js";
import { buildRoundTripInputs, resolveRoundTripEnv } from "../../src/certification/fixtures.js";
import { firstPublishedLayer } from "../../src/certification/round-trip-target.js";
import { type CertificationTarget, openCertificationTarget } from "../../src/certification/target.js";

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

type ListedTool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };

/** Advertise serviceLayerIndex on honua_query_features and record the arguments each query call sends. */
function advertisingServiceLayerIndex(client: Client, queryArgs: Record<string, unknown>[]): Client {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "listTools") {
        return async (...args: unknown[]) => {
          const listed = await (target.listTools as (...a: unknown[]) => Promise<{ tools: ListedTool[] }>)(...args);
          const tools = listed.tools.map((tool) =>
            tool.name === "honua_query_features"
              ? {
                  ...tool,
                  inputSchema: {
                    ...tool.inputSchema,
                    properties: { ...tool.inputSchema?.properties, serviceLayerIndex: { type: "integer" } },
                  },
                }
              : tool,
          );
          return { ...listed, tools };
        };
      }
      if (prop === "callTool") {
        return async (req: { name: string; arguments?: Record<string, unknown> }, ...rest: unknown[]) => {
          if (req.name === "honua_query_features") queryArgs.push(req.arguments ?? {});
          return (target.callTool as (...a: unknown[]) => unknown)(req, ...rest);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("certify against a target that advertises serviceLayerIndex", () => {
  let target: CertificationTarget;
  beforeAll(async () => {
    target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "offline" } as NodeJS.ProcessEnv);
  }, 30_000);
  afterAll(async () => {
    await target.close();
  });

  it("sends serviceLayerIndex in the query round trip and the pagination contract", async () => {
    const queryArgs: Record<string, unknown>[] = [];
    await certify({
      client: advertisingServiceLayerIndex(target.client, queryArgs),
      targetMode: target.mode,
      backend: target.backend,
      surface: target.serverLabel,
      env: { ...process.env, HONUA_MCP_SERVICE_ID: "svc-parks", HONUA_MCP_LAYER_ID: "0" } as NodeJS.ProcessEnv,
    });

    // The invalid-args contract omits the layer on purpose; every other query addresses one.
    const layerAddressed = queryArgs.filter((args) => "serviceLayerIndex" in args || "layerId" in args);
    expect(layerAddressed.length).toBeGreaterThanOrEqual(2);
    for (const args of layerAddressed) {
      expect(args).toMatchObject({ serviceLayerIndex: 0 });
      expect(args).not.toHaveProperty("layerId");
    }
  }, 30_000);
});
