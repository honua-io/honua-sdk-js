import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { ExtentSchema, GeometryType, QueryFeaturesResponseSchema } from "../../src/gen/geospatial/v1/index.js";

interface ExtentRpcRequest {
  returnCountOnly: boolean;
  returnExtentOnly: boolean;
}

function grpcSource(
  extentReply: Record<string, unknown> = { extent: create(ExtentSchema, { xmin: -1, ymin: -2, xmax: 3, ymax: 4 }) },
  count = 3n,
) {
  const fetchFn = vi.fn(() => {
    throw new Error("REST fallback is forbidden");
  });
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    transport: "grpc-web",
    apiKey: "fixture-key",
    fetchFn,
  });
  // A Honua server answers count-only before extent-only and omits the extent.
  const rpc = vi.fn(async (request: ExtentRpcRequest) =>
    create(QueryFeaturesResponseSchema, request.returnCountOnly ? { count } : extentReply),
  );
  Object.defineProperty(client, "connectClient", { value: { queryFeatures: rpc }, configurable: true });
  const source = createDataset({
    id: "fixture",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "source",
        protocol: "grpc",
        locator: { url: client.serverBaseUrl, serviceId: "published", layerId: 10 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.grpc,
      },
    ],
  }).source("source")!;
  return { source, rpc, fetchFn };
}

describe("gRPC queryExtent", () => {
  it("reads the extent without count-only, then the exact count", async () => {
    const { source, rpc, fetchFn } = grpcSource();
    const result = await source.queryExtent({ where: "VALUE > 2" });
    expect(result).toMatchObject({ extent: { xmin: -1, ymin: -2, xmax: 3, ymax: 4 }, count: 3 });
    expect(rpc.mock.calls[0][0]).toMatchObject({ where: "VALUE > 2", returnExtentOnly: true, returnCountOnly: false });
    expect(rpc.mock.calls[1][0]).toMatchObject({ where: "VALUE > 2", returnExtentOnly: false, returnCountOnly: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns a null extent and zero count for an empty layer", async () => {
    // The server sets response metadata but no extent when nothing matches.
    const { source, rpc } = grpcSource({ objectIdFieldName: "OBJECTID", geometryType: GeometryType.POINT }, 0n);
    const result = await source.queryExtent({ outSr: 3857 });
    expect(result).toEqual({ extent: null, count: 0 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][0]).toMatchObject({ outSr: { wkid: 3857 } });
    expect(rpc.mock.calls[1][0]).toMatchObject({ outSr: { wkid: 3857 } });
  });
});
