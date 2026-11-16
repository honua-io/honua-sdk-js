import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectDiscoveryCache, ConnectDiscoverySnapshot } from "../src/connect.js";
import { connect } from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { connectWithSourceCapabilities } from "../src/source-capability-discovery.js";

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

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("reports the transport and only gRPC capabilities on the inspection", async () => {
    const connection = await connect(base(serverFetch(grpcAnswer)));
    expect(connection.inspection.transport).toBe("grpc-web");
    const capabilities = [...(connection.inspection.sources[0]?.descriptor.capabilities ?? [])];
    expect(capabilities).toContain("query");
    expect(capabilities).not.toContain("pbf");
    expect(capabilities).not.toContain("sql");

    const rest = await connect(base(serverFetch(restOnlyAnswer)));
    expect(rest.inspection.transport).toBe("rest");
  });

  it("re-probes on refresh and records the new answer", async () => {
    const cache = memoryCache();
    await connect(base(serverFetch(grpcAnswer), cache));
    const connection = await connect({ ...base(serverFetch(restOnlyAnswer), cache), refresh: true });

    expect(connection.dataset.client.isGrpcWeb).toBe(false);
    expect([...cache.values.values()][0]?.transport).toBe("rest");
  });

  it("replays a recorded gRPC-Web choice as REST where the runtime cannot load", async () => {
    const cache = memoryCache();
    await connect(base(serverFetch(grpcAnswer), cache));
    vi.spyOn(
      HonuaClient.prototype as unknown as { loadGrpcWebRuntime: () => Promise<unknown> },
      "loadGrpcWebRuntime",
    ).mockRejectedValue(new TypeError('Failed to resolve module specifier "@connectrpc/connect-web"'));

    const offline = vi.fn<typeof fetch>();
    const connection = await connect(base(offline, cache));
    expect(connection.dataset.client.isGrpcWeb).toBe(false);
    expect(offline).not.toHaveBeenCalled();
  });

  it("rejects with HonuaAbortError when the caller aborts during the probe", async () => {
    const controller = new AbortController();
    const fetchFn: typeof fetch = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (!path.endsWith(probePath)) return serverFetch(grpcAnswer)(input, init);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        setTimeout(() => controller.abort(), 10);
      });
    };
    await expect(connect({ ...base(fetchFn), signal: controller.signal })).rejects.toBeInstanceOf(HonuaAbortError);
  });

  it("resolves decisions and capability profiles to the gRPC set on gRPC-Web", async () => {
    const connection = await connect(base(serverFetch(grpcAnswer)));
    const decisions = connection.inspection.sources[0]?.capabilityDecisions ?? [];
    expect(decisions.find((decision) => decision.capability === "pbf")).toMatchObject({
      code: "adapter-unsupported",
      effective: false,
    });
    expect(decisions.find((decision) => decision.capability === "query")).toMatchObject({ effective: true });

    const projected = await connectWithSourceCapabilities(base(serverFetch(grpcAnswer)), {
      evaluatedAt: "2026-11-16T00:00:00.000Z",
    });
    const source = projected.source();
    const pbf = source.capabilityProfile.entries.find((entry) => entry.id === "pbf");
    expect(pbf).toMatchObject({ effective: "unsupported" });
    expect(source.supports("pbf")).toBe(false);
  });
});
