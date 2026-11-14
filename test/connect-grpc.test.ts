import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { resolveConnectTarget } from "../src/connect-geoservices.js";
import { discoverGrpcSources } from "../src/connect-grpc.js";
import { type ConnectDiscoverySnapshot, connect } from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
import {
  DescribeLayerResponseSchema,
  DescribeServiceResponseSchema,
} from "../src/gen/geospatial/v1/feature_service_pb.js";

const target = resolveConnectTarget("https://example.test", "grpc", { serviceId: "parcels" });
function fixture() {
  const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected HTTP request"));
  const client = new HonuaClient({ baseUrl: target.clientBaseUrl, transport: "grpc-web", fetchFn });
  const service = vi.spyOn(client, "describeService").mockResolvedValue(
    create(DescribeServiceResponseSchema, {
      service: { serviceId: "parcels" },
      layers: [{ layerId: 0, name: "Parcels" }],
    }),
  );
  const layer = vi.spyOn(client, "describeLayer").mockResolvedValue(
    create(DescribeLayerResponseSchema, {
      layer: {
        serviceId: "parcels",
        layerId: 0,
        name: "Parcels",
        capabilities: { query: true, queryPagination: true, queryStream: true },
      },
    }),
  );
  return { client, service, layer, fetchFn };
}

it("discovers descriptors without REST metadata or query probes", async () => {
  const f = fixture();
  const query = vi.spyOn(f.client, "queryFeatures");
  const result = await discoverGrpcSources(f.client, target, {});
  expect(result.sources[0]).toMatchObject({ title: "Parcels", locator: { serviceId: "parcels", layerId: 0 } });
  expect(result.sources[0]!.evidence?.[0]).toMatchObject({
    kind: "metadata",
    capabilities: ["query", "queryExtent", "queryObjectIds", "stream"],
  });
  expect(f.fetchFn).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it("accepts a native service and layer at the transport base URL", async () => {
  const f = fixture();
  const connection = await connect({
    endpoint: target.endpoint,
    protocol: "grpc",
    serviceId: "parcels",
    layerId: 0,
    authorizationScopeFingerprint: "anonymous",
    client: f.client,
  });
  const source = connection.dataset.source("0")!;
  const native = source.protocol("grpc");
  expect(native).toBeDefined();
  expect(source.protocol("geoservices-feature-service")).toBeUndefined();
  await native!.describe();
  expect(f.service).not.toHaveBeenCalled();
  expect(f.layer).toHaveBeenCalledWith({ serviceId: "parcels", layerId: 0 });
  expect(f.fetchFn).not.toHaveBeenCalled();
});
it("requires gRPC-Web even when native descriptors come from cache", async () => {
  const f = fixture();
  let snapshot: ConnectDiscoverySnapshot | undefined;
  const cache = {
    get: () => snapshot,
    set: (_key: unknown, value: ConnectDiscoverySnapshot) => {
      snapshot = value;
    },
  };
  const options = {
    endpoint: target.endpoint,
    protocol: "grpc" as const,
    serviceId: "parcels",
    layerId: 0,
    authorizationScopeFingerprint: "anonymous",
    cache,
  };
  await connect({ ...options, client: f.client });
  expect(snapshot).toBeDefined();
  f.layer.mockClear();
  await connect({ ...options, client: f.client });
  expect(f.layer).not.toHaveBeenCalled();
  const restClient = new HonuaClient({ baseUrl: target.clientBaseUrl, fetchFn: f.fetchFn });
  await expect(connect({ ...options, client: restClient })).rejects.toMatchObject({ code: "invalid-endpoint" });
  expect(f.fetchFn).not.toHaveBeenCalled();
});
it("follows service pages before reading each authorized layer", async () => {
  const f = fixture();
  f.service
    .mockResolvedValueOnce(
      create(DescribeServiceResponseSchema, {
        service: { serviceId: "parcels" },
        layers: [{ layerId: 0 }],
        nextPageToken: "next",
      }),
    )
    .mockResolvedValueOnce(
      create(DescribeServiceResponseSchema, { service: { serviceId: "parcels" }, layers: [{ layerId: 1 }] }),
    );
  f.layer.mockImplementation(async ({ layerId }) =>
    create(DescribeLayerResponseSchema, { layer: { serviceId: "parcels", layerId, name: `Layer ${layerId}` } }),
  );
  const result = await discoverGrpcSources(f.client, target, {});
  expect(result.sources.map((source) => source.id)).toEqual(["0", "1"]);
  expect(f.service.mock.calls[1]![0].pageToken).toBe("next");
  expect(result.sources[0]!.evidence?.[0]).toMatchObject({ kind: "unavailable" });
});
it.each(["duplicate", "loop", "mismatch", "empty"])("rejects malformed %s pagination", async (kind) => {
  const f = fixture();
  f.service.mockResolvedValue(
    create(DescribeServiceResponseSchema, {
      service: { serviceId: kind === "mismatch" ? "other" : "parcels" },
      layers: kind === "empty" ? [] : [{ layerId: 0 }],
      nextPageToken: "next",
    }),
  );
  if (kind === "loop") {
    f.service.mockResolvedValueOnce(
      create(DescribeServiceResponseSchema, {
        service: { serviceId: "parcels" },
        layers: [{ layerId: 1 }],
        nextPageToken: "next",
      }),
    );
  }
  await expect(discoverGrpcSources(f.client, target, {})).rejects.toMatchObject({ code: "protocol-mismatch" });
  expect(f.layer).not.toHaveBeenCalled();
});
it("withholds queryAll when the descriptor does not affirm pagination", async () => {
  const f = fixture();
  f.layer.mockResolvedValue(
    create(DescribeLayerResponseSchema, {
      layer: { serviceId: "parcels", name: "Parcels", capabilities: { query: true } },
    }),
  );
  const result = await discoverGrpcSources(f.client, target, {});
  expect(result.sources[0]!.evidence?.[0]).toMatchObject({
    kind: "metadata",
    capabilities: ["queryExtent", "queryObjectIds"],
  });
});
it("does not infer write capabilities from missing or false metadata", async () => {
  const f = fixture();
  f.layer.mockResolvedValue(
    create(DescribeLayerResponseSchema, { layer: { serviceId: "parcels", name: "Parcels", capabilities: {} } }),
  );
  const result = await discoverGrpcSources(f.client, target, {});
  expect(result.sources[0]!.evidence?.[0]).toMatchObject({ kind: "metadata", capabilities: [] });
});
it("rejects a mismatched layer without falling back", async () => {
  const f = fixture();
  f.layer.mockResolvedValue(create(DescribeLayerResponseSchema, { layer: { serviceId: "other", name: "Parcels" } }));
  await expect(discoverGrpcSources(f.client, target, {})).rejects.toMatchObject({ code: "protocol-mismatch" });
  expect(f.fetchFn).not.toHaveBeenCalled();
});
it("honors cancellation before any RPC", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(discoverGrpcSources(f.client, target, { signal: controller.signal })).rejects.toMatchObject({
    name: "HonuaAbortError",
  });
  expect(f.service).not.toHaveBeenCalled();
});
it("rejects native identities for other protocols and invalid layer ids", () => {
  expect(() => resolveConnectTarget(target.endpoint, "ogc-features", { serviceId: "parcels" })).toThrow();
  expect(() => resolveConnectTarget(target.endpoint, "grpc", { serviceId: "parcels", layerId: -1 })).toThrow();
});
