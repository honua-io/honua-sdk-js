import { describe, expect, it, vi } from "vitest";

import type { ConnectDiscoveryCache, ConnectDiscoverySnapshot } from "../src/connect.js";
import { connect } from "../src/connect.js";

const endpoint = "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer";
const probePath = "/geospatial.v1.FeatureService/DescribeService";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function serverFetch(probeAnswer: () => Response, requests: string[] = []): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    requests.push(url.pathname);
    if (url.pathname.endsWith(probePath)) return probeAnswer();
    if (url.pathname.endsWith("/FeatureServer")) {
      return json({ capabilities: "Query", layers: [{ id: 0, name: "Parcels" }], tables: [] });
    }
    if (url.pathname.endsWith("/FeatureServer/0")) {
      return json({
        id: 0,
        name: "Parcels",
        capabilities: "Query",
        advancedQueryCapabilities: { supportsPagination: true },
        fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const grpcAnswer = () =>
  new Response(null, { headers: { "content-type": "application/grpc-web+proto", "grpc-status": "3" } });
const restOnlyAnswer = () =>
  new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });

function memoryCache(): ConnectDiscoveryCache & { readonly values: Map<string, ConnectDiscoverySnapshot> } {
  const values = new Map<string, ConnectDiscoverySnapshot>();
  return {
    values,
    get: (identity) => values.get(identity.key),
    set: (identity, snapshot) => {
      values.set(identity.key, snapshot);
    },
  };
}

function base(fetchFn: typeof fetch, cache?: ConnectDiscoveryCache) {
  return {
    endpoint,
    protocol: "auto" as const,
    authorizationScopeFingerprint: "anonymous",
    clientOptions: { fetchFn },
    ...(cache ? { cache } : {}),
  };
}

describe("connect() native transport default for GeoServices feature services", () => {
  it("selects gRPC-Web where the server offers it and records the choice in the snapshot", async () => {
    const requests: string[] = [];
    const cache = memoryCache();
    const connection = await connect(base(serverFetch(grpcAnswer, requests), cache));

    expect(connection.dataset.client.isGrpcWeb).toBe(true);
    expect(requests.filter((path) => path.endsWith(probePath))).toHaveLength(1);
    expect([...cache.values.values()][0]?.transport).toBe("grpc-web");
  });

  it("replays the cached transport on a hit without any request", async () => {
    const cache = memoryCache();
    await connect(base(serverFetch(grpcAnswer), cache));

    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("offline");
    });
    const connection = await connect(base(offline, cache));
    expect(connection.dataset.client.isGrpcWeb).toBe(true);
    expect(offline).not.toHaveBeenCalled();
  });

  it("stays on REST for a server that does not answer gRPC-Web", async () => {
    const cache = memoryCache();
    const connection = await connect(base(serverFetch(restOnlyAnswer), cache));

    expect(connection.dataset.client.isGrpcWeb).toBe(false);
    expect([...cache.values.values()][0]?.transport).toBe("rest");
  });

  it("does not probe when the caller sets a transport or passes a client", async () => {
    const requests: string[] = [];
    const cache = memoryCache();
    const fetchFn = serverFetch(grpcAnswer, requests);
    const connection = await connect({ ...base(fetchFn, cache), clientOptions: { fetchFn, transport: "rest" } });

    expect(connection.dataset.client.isGrpcWeb).toBe(false);
    expect(requests.some((path) => path.endsWith(probePath))).toBe(false);
    expect([...cache.values.values()][0]?.transport).toBeUndefined();
  });

  it("replays a snapshot without a recorded transport as REST without probing", async () => {
    const cache = memoryCache();
    await connect({
      ...base(serverFetch(grpcAnswer), cache),
      clientOptions: { fetchFn: serverFetch(grpcAnswer), transport: "rest" },
    });

    const requests: string[] = [];
    const connection = await connect(base(serverFetch(grpcAnswer, requests), cache));
    expect(connection.dataset.client.isGrpcWeb).toBe(false);
    expect(requests).toEqual([]);
  });

  it("rejects a cached snapshot with an invalid transport", async () => {
    const cache = memoryCache();
    await connect(base(serverFetch(grpcAnswer), cache));
    for (const [key, snapshot] of cache.values) {
      cache.values.set(key, { ...snapshot, transport: "websocket" as never });
    }

    await expect(connect(base(serverFetch(grpcAnswer), cache))).rejects.toMatchObject({
      code: "invalid-discovery-cache",
    });
  });
});
