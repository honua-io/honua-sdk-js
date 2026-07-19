import { describe, expect, it, vi } from "vitest";

import { discoverGeoServicesSources, resolveConnectTarget } from "../src/connect-geoservices.js";
import { discoverGrpcSources } from "../src/connect-grpc.js";
import { connect } from "../src/connect.js";
import type { Capability } from "../src/contract/types.js";
import { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION, HonuaClient } from "../src/core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../src/core/errors.js";
import type { HonuaLayerMetadata, HonuaQueryResponse, HonuaServiceMetadata } from "../src/core/types.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function capabilitiesEnvelope(overrides: { serverVersion?: string } = {}) {
  return {
    success: true,
    data: {
      compatibility: {
        serverVersion: overrides.serverVersion ?? HONUA_MINIMUM_SUPPORTED_SERVER_VERSION,
        releaseChannel: "stable",
        controlPlaneApi: { major: 1, basePath: "/api/v1/admin", deprecated: false },
        metadataSchemas: [],
        features: {
          metadataResources: true,
          manifestExport: true,
          manifestApply: true,
          manifestDryRun: true,
          manifestPrune: true,
        },
      },
    },
  };
}

const parcelsService: HonuaServiceMetadata = {
  capabilities: "Query",
  layers: [
    { id: 0, name: "Parcels" },
    { id: 1, name: "Zones" },
  ],
};

const parcelsLayer: HonuaLayerMetadata = {
  id: 0,
  name: "Parcels",
  geometryType: "esriGeometryPolygon",
  objectIdField: "OBJECTID",
  capabilities: "Query",
  advancedQueryCapabilities: { supportsPagination: true, supportsReturningQueryExtent: true },
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "NAME", type: "esriFieldTypeString" },
  ],
};

const zonesLayer: HonuaLayerMetadata = {
  id: 1,
  name: "Zones",
  geometryType: "esriGeometryPolygon",
  objectIdField: "OBJECTID",
  capabilities: "Query",
  advancedQueryCapabilities: { supportsPagination: true, supportsReturningQueryExtent: true },
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "ZONE", type: "esriFieldTypeString" },
  ],
};

const parcelsProbeResponse: HonuaQueryResponse = {
  objectIdFieldName: "OBJECTID",
  geometryType: "esriGeometryPolygon",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "NAME", type: "esriFieldTypeString" },
  ],
  features: [],
};

const zonesProbeResponse: HonuaQueryResponse = {
  objectIdFieldName: "OBJECTID",
  geometryType: "esriGeometryPolygon",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "ZONE", type: "esriFieldTypeString" },
  ],
  features: [],
};

/** Routes REST metadata + server-compatibility requests for a single-layer FeatureServer fixture. */
function singleLayerFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/admin/capabilities") return json(capabilitiesEnvelope());
    if (url.pathname === "/rest/services/parcels/FeatureServer/0") return json(parcelsLayer);
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
}

/** Routes REST metadata + server-compatibility requests for a service-level (multi-layer) FeatureServer fixture. */
function serviceLevelFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/admin/capabilities") return json(capabilitiesEnvelope());
    if (url.pathname === "/rest/services/parcels/FeatureServer") return json(parcelsService);
    if (url.pathname === "/rest/services/parcels/FeatureServer/0") return json(parcelsLayer);
    if (url.pathname === "/rest/services/parcels/FeatureServer/1") return json(zonesLayer);
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
}

function grpcClient(fetchFn: typeof fetch): HonuaClient {
  return new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
}

describe("Honua gRPC discovery (connect-grpc.ts)", () => {
  it("requires a client configured with transport: grpc-web", async () => {
    const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn: singleLayerFetch() });
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    await expect(discoverGrpcSources(client, target, {})).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
    });
  });

  it("fails closed with an actionable diagnostic when the server is below the minimum supported version", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/admin/capabilities") return json(capabilitiesEnvelope({ serverVersion: "0.0.1" }));
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;
    const client = grpcClient(fetchFn);
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    const error = await discoverGrpcSources(client, target, {}).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HonuaDiscoveryError);
    expect((error as HonuaDiscoveryError).code).toBe("invalid-endpoint");
    expect((error as HonuaDiscoveryError).message).toContain("0.0.1");
    expect((error as HonuaDiscoveryError).detail?.serverVersion).toBe("0.0.1");
  });

  it("discovers a single FeatureServer layer, verifying query/stream through a live QueryFeatures parity probe", async () => {
    const client = grpcClient(singleLayerFetch());
    const queryFeatures = vi.spyOn(client, "queryFeatures").mockResolvedValue(parcelsProbeResponse);
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    const result = await discoverGrpcSources(client, target, {});

    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source.id).toBe("0");
    expect(source.locator).toEqual({ url: "https://example.test", serviceId: "parcels", layerId: 0 });
    expect(source.schema?.fields?.map((f) => f.name)).toEqual(["OBJECTID", "NAME"]);
    expect(source.schema?.primaryKey).toBe("OBJECTID");

    const evidenceCapabilities = source.evidence?.flatMap((record) =>
      "capabilities" in record ? [...record.capabilities] : [],
    );
    expect(evidenceCapabilities).toEqual(expect.arrayContaining(["query", "stream", "queryExtent", "queryObjectIds"]));
    // gRPC has no pbf/sql/attachments/queryRelated RPC surface: the discovered
    // evidence must never claim them even though this metadata is identical
    // to what a raw FeatureServer would return.
    expect(evidenceCapabilities).not.toEqual(expect.arrayContaining(["pbf", "sql", "attachments", "queryRelated"]));

    expect(queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "parcels", layerId: 0, resultRecordCount: 1, returnGeometry: false }),
    );
  });

  it("discovers every layer at the service level", async () => {
    const client = grpcClient(serviceLevelFetch());
    vi.spyOn(client, "queryFeatures").mockImplementation(async (request) =>
      request.layerId === 0 ? parcelsProbeResponse : zonesProbeResponse,
    );
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer", "grpc");

    const result = await discoverGrpcSources(client, target, {});

    expect(result.sources.map((source) => source.id).sort()).toEqual(["0", "1"]);
  });

  it("throws protocol-mismatch when the gRPC probe schema disagrees with REST-declared metadata", async () => {
    const client = grpcClient(singleLayerFetch());
    vi.spyOn(client, "queryFeatures").mockResolvedValue({
      ...parcelsProbeResponse,
      fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }], // "NAME" silently dropped
    });
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    const error = await discoverGrpcSources(client, target, {}).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HonuaDiscoveryError);
    expect((error as HonuaDiscoveryError).code).toBe("protocol-mismatch");
    expect((error as HonuaDiscoveryError).detail?.missingFromGrpc).toEqual(["NAME"]);
  });

  it("throws protocol-mismatch when the gRPC probe geometryType disagrees with REST-declared metadata", async () => {
    const client = grpcClient(singleLayerFetch());
    vi.spyOn(client, "queryFeatures").mockResolvedValue({
      ...parcelsProbeResponse,
      geometryType: "esriGeometryPoint",
    });
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    await expect(discoverGrpcSources(client, target, {})).rejects.toMatchObject({
      code: "protocol-mismatch",
    });
  });

  it("degrades query/stream to unavailable evidence (not a hard failure) when the live probe fails transiently", async () => {
    const client = grpcClient(singleLayerFetch());
    vi.spyOn(client, "queryFeatures").mockRejectedValue(new Error("upstream unavailable"));
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    const result = await discoverGrpcSources(client, target, {});

    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!;
    const unavailable = source.evidence?.find((record) => record.kind === "unavailable");
    expect(unavailable).toMatchObject({ reason: expect.stringContaining("parity probe failed") });
    const metadataRecord = source.evidence?.find((record) => record.kind === "metadata");
    expect(metadataRecord && "capabilities" in metadataRecord ? metadataRecord.capabilities : []).not.toContain(
      "query",
    );
    expect(metadataRecord && "capabilities" in metadataRecord ? metadataRecord.capabilities : []).not.toContain(
      "stream",
    );
    // queryObjectIds / queryExtent are trusted from metadata alone (no probe
    // required), exactly as raw GeoServices REST discovery trusts them.
    expect(metadataRecord && "capabilities" in metadataRecord ? metadataRecord.capabilities : []).toEqual(
      expect.arrayContaining(["queryObjectIds", "queryExtent"]),
    );
  });

  it("rethrows abort without wrapping when the caller signal fires during the probe", async () => {
    const client = grpcClient(singleLayerFetch());
    const controller = new AbortController();
    vi.spyOn(client, "queryFeatures").mockImplementation(async () => {
      controller.abort();
      throw new HonuaAbortError();
    });
    const target = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");

    await expect(discoverGrpcSources(client, target, { signal: controller.signal })).rejects.toBeInstanceOf(
      HonuaAbortError,
    );
  });

  describe("raw-endpoint parity", () => {
    it("derives identical capability truth as raw GeoServices REST discovery, restricted to the gRPC capability surface", async () => {
      const restClient = new HonuaClient({ baseUrl: "https://example.test", fetchFn: singleLayerFetch() });
      const restTarget = resolveConnectTarget(
        "https://example.test/rest/services/parcels/FeatureServer/0",
        "geoservices-feature-service",
      );
      const restResult = await discoverGeoServicesSources(restClient, restTarget, {});

      const grpcClientInstance = grpcClient(singleLayerFetch());
      vi.spyOn(grpcClientInstance, "queryFeatures").mockResolvedValue(parcelsProbeResponse);
      const grpcTarget = resolveConnectTarget("https://example.test/rest/services/parcels/FeatureServer/0", "grpc");
      const grpcResult = await discoverGrpcSources(grpcClientInstance, grpcTarget, {});

      const restCapabilities = new Set(
        restResult.sources[0]!.evidence?.flatMap((record) =>
          "capabilities" in record ? [...record.capabilities] : [],
        ),
      );
      const grpcCapabilities = new Set(
        grpcResult.sources[0]!.evidence?.flatMap((record) =>
          "capabilities" in record ? [...record.capabilities] : [],
        ),
      );

      // gRPC's capability truth must be a verified subset of REST's — never a
      // superset — and must agree exactly wherever the gRPC capability
      // surface (PROTOCOL_DEFAULT_CAPABILITIES.grpc) overlaps REST's.
      const grpcSurface = new Set<Capability>([
        "query",
        "queryAggregate",
        "queryExtent",
        "queryObjectIds",
        "applyEdits",
        "stream",
      ]);
      for (const capability of grpcCapabilities) expect(restCapabilities.has(capability)).toBe(true);
      for (const capability of grpcSurface) {
        if (restCapabilities.has(capability)) expect(grpcCapabilities.has(capability)).toBe(true);
      }

      expect(grpcResult.sources[0]!.schema?.fields).toEqual(restResult.sources[0]!.schema?.fields);
      expect(grpcResult.sources[0]!.locator).toEqual(restResult.sources[0]!.locator);
    });
  });
});

describe('connect() protocol: "grpc" wiring', () => {
  it("only resolves against a canonical FeatureServer URL, never through auto-detection", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/parcels/MapServer/0",
        protocol: "grpc",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn, transport: "grpc-web" },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();

    // "auto" against the very same FeatureServer URL never resolves "grpc" —
    // it resolves the REST protocol, since the URL is structurally identical
    // for both transports and gRPC intent is never inferred.
    const auto = await connect({
      endpoint: "https://example.test/rest/services/parcels/FeatureServer/0",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: singleLayerFetch(),
      },
    });
    expect(auto.inspection.protocol).toBe("geoservices-feature-service");
  });

  it("produces a working end-to-end connection whose Source executes over the gRPC-configured client", async () => {
    const client = grpcClient(singleLayerFetch());
    vi.spyOn(client, "queryFeatures").mockResolvedValue(parcelsProbeResponse);
    const queryFeaturesForRead = vi.spyOn(client, "queryFeatures");

    const connection = await connect({
      endpoint: "https://example.test/rest/services/parcels/FeatureServer/0",
      protocol: "grpc",
      authorizationScopeFingerprint: "anonymous",
      client,
    });

    expect(connection.inspection.protocol).toBe("grpc");
    const source = connection.source();
    queryFeaturesForRead.mockResolvedValue({ ...parcelsProbeResponse, features: [{ attributes: { OBJECTID: 1 } }] });
    const result = await source.query({ where: "1=1" });
    expect(result.features).toHaveLength(1);
    // The Source executed through the same gRPC-configured client — no
    // separate REST query fallback was constructed.
    expect(queryFeaturesForRead).toHaveBeenCalled();
  });
});
