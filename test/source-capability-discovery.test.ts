import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectDiscoverySnapshot } from "../src/connect.js";
import type { SourceDescriptor } from "../src/contract/types.js";
import { createCapabilitySourceEndpointFingerprint } from "../src/source-capabilities.js";
import {
  type SourceCapabilityConnectOptions,
  type SourceCapabilityEvaluationOptions,
  connectWithSourceCapabilities,
  sourceCapabilityEndpointIdentity,
} from "../src/source-capability-discovery.js";

const OBSERVED_AT = "2026-07-15T00:00:00.000Z";
const EVALUATED_AT = "2026-07-15T00:01:00Z";
const WMS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wms/capabilities.xml", import.meta.url),
  "utf8",
);
const WMTS_CAPABILITIES = readFileSync(
  new URL("./fixtures/backend-agnostic/wmts/capabilities.xml", import.meta.url),
  "utf8",
);

afterEach(() => vi.useRealTimers());

describe("capability discovery endpoint binding", () => {
  it("canonicalizes base and already-resolved GeoServices descriptors to one layer identity", () => {
    const base = geoDescriptor("https://example.test/arcgis", "Public/Parcels & Lots", 7);
    const resolved = geoDescriptor(
      "https://example.test/arcgis/rest/services/Public/Parcels%20%26%20Lots/FeatureServer/7",
      "Public/Parcels & Lots",
      7,
    );

    expect(sourceCapabilityEndpointIdentity(base)).toEqual({
      endpoint: "https://example.test/arcgis/rest/services/Public/Parcels%20%26%20Lots/FeatureServer/7",
      protocol: "geoservices-feature-service",
      sourceId: "7",
    });
    expect(createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(base))).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(resolved)),
    );
  });

  it("binds OData entity sets and rejects contradictory or credential-bearing replay coordinates", () => {
    const odata: Pick<SourceDescriptor, "id" | "protocol" | "locator"> = {
      id: "Work Orders",
      protocol: "odata",
      locator: { url: "https://example.test/v4/", entitySet: "Work Orders" },
    };
    expect(sourceCapabilityEndpointIdentity(odata)).toEqual({
      endpoint: "https://example.test/v4/Work%20Orders",
      protocol: "odata",
      sourceId: "Work Orders",
    });

    const originOnly = {
      ...odata,
      locator: { ...odata.locator, url: "https://example.test" },
    };
    const explicitDefaultPath = {
      ...odata,
      locator: { ...odata.locator, url: "https://example.test/odata" },
    };
    expect(sourceCapabilityEndpointIdentity(originOnly)).toEqual({
      endpoint: "https://example.test/odata/Work%20Orders",
      protocol: "odata",
      sourceId: "Work Orders",
    });
    expect(createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(originOnly))).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(explicitDefaultPath)),
    );

    const layerScoped = {
      ...odata,
      id: "1",
      locator: { url: "https://example.test", layerId: 1 },
    };
    expect(sourceCapabilityEndpointIdentity(layerScoped)).toEqual({
      endpoint: "https://example.test/odata/Layers(1)/Features",
      protocol: "odata",
      sourceId: "1",
    });
    expect(createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(layerScoped))).toBe(
      createCapabilitySourceEndpointFingerprint(
        sourceCapabilityEndpointIdentity({
          ...layerScoped,
          locator: { url: "https://example.test/odata", layerId: 1 },
        }),
      ),
    );

    expect(() =>
      sourceCapabilityEndpointIdentity(
        geoDescriptor("https://example.test/rest/services/Public/Parcels/FeatureServer/8", "Public/Parcels", 7),
      ),
    ).toThrow(/layer contradicts/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...odata,
        locator: { ...odata.locator, url: "https://u:p@example.test/v4" },
      }),
    ).toThrow(/credentials/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...odata,
        locator: { ...odata.locator, url: "https://example.test/v4?sig=x" },
      }),
    ).toThrow(/query or fragment/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...odata,
        locator: { ...odata.locator, url: "file:///tmp/v4" },
      }),
    ).toThrow(/HTTP/);
    for (const entitySet of [".", ".."] as const) {
      expect(() =>
        sourceCapabilityEndpointIdentity({
          ...odata,
          locator: { ...odata.locator, entitySet },
        }),
      ).toThrow(/routable path identifier/);
    }
  });

  it("binds WMS and WMTS service/layer identities without retaining operation URLs", () => {
    const wms = rasterDescriptor("wms", "https://example.test/ogc/wms", "parcels");
    const wmts = rasterDescriptor("wmts", "https://example.test/ogc/wmts", "imagery");

    expect(sourceCapabilityEndpointIdentity(wms)).toEqual({
      endpoint: "https://example.test/ogc/wms",
      protocol: "wms",
      sourceId: "parcels",
    });
    expect(sourceCapabilityEndpointIdentity(wmts)).toEqual({
      endpoint: "https://example.test/ogc/wmts",
      protocol: "wmts",
      sourceId: "imagery",
    });
    expect(() => sourceCapabilityEndpointIdentity({ ...wms, id: "roads" })).toThrow(/must match locator\.typeName/);
    expect(() =>
      sourceCapabilityEndpointIdentity({
        ...wmts,
        locator: { ...wmts.locator, url: "https://example.test/ogc/wmts?token=secret" },
      }),
    ).toThrow(/query or fragment/);
  });
});

describe("connectWithSourceCapabilities", () => {
  it("projects GeoServices metadata once and exposes one schema/endpoint-bound effective profile", async () => {
    useDiscoveryClock();
    let cached: ConnectDiscoverySnapshot | undefined;
    const fetchFn = vi.fn(async () =>
      json({
        id: 0,
        name: "Parcels",
        capabilities: "Query,Create,Update,Delete",
        supportsStatistics: true,
        advancedQueryCapabilities: {
          supportsPagination: true,
          supportsReturningQueryExtent: true,
        },
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "STATUS", type: "esriFieldTypeString" },
        ],
      }),
    );
    const connection = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer/0",
        protocol: "auto",
        authorizationScopeFingerprint: "role:editor:v1",
        clientOptions: { fetchFn },
        cache: {
          get: () => undefined,
          set: (_identity, snapshot) => {
            cached = snapshot;
          },
        },
      },
      {
        evaluatedAt: EVALUATED_AT,
        policy: { deny: ["applyEdits"] },
        environment: "browser",
      },
    );

    const source = connection.source();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(source.descriptor.schemaV2.fingerprint).toBe(source.capabilityProfile.sourceFingerprint);
    expect(source.capabilityProfile.sourceEndpointFingerprint).toBe(
      createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(source.descriptor)),
    );
    expect(capability(source, "query")).toMatchObject({
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    });
    expect(capability(source, "applyEdits")).toMatchObject({
      observed: "supported",
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(source.supports("query")).toBe(true);
    expect(source.supports("applyEdits")).toBe(false);
    expect([...source.capabilities]).toEqual([...connection.inspection.sources[0]!.descriptor.capabilities]);
    expect(connection.dataset.sourceDescriptors[0]).toBe(connection.inspection.sources[0]!.descriptor);
    expect(JSON.stringify(source.capabilityProfile)).not.toContain("https://example.test");
    expect(cached?.sources[0]).not.toHaveProperty("capabilityProfile");
  });

  it("does not reuse a stale discovery policy when evaluation omits policy", async () => {
    useDiscoveryClock();
    const reusedOptions = {
      ...odataOptions("https://example.test/odata"),
      capabilityPolicy: { deny: ["query"] },
    } as unknown as SourceCapabilityConnectOptions;
    const connection = await connectWithSourceCapabilities(reusedOptions, { evaluatedAt: EVALUATED_AT });

    expect(capability(connection.source(), "query")).toMatchObject({
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    });
    expect(connection.source().supports("query")).toBe(true);
    expect(connection.source().capabilities.has("query")).toBe(true);
  });

  it("produces equivalent OData decisions across facade and third-party roots while retaining endpoint identity", async () => {
    useDiscoveryClock();
    const facade = await connectWithSourceCapabilities(odataOptions("https://facade.test/odata"), {
      evaluatedAt: EVALUATED_AT,
      environment: "node",
      availablePeers: ["maplibre-gl"],
    });
    const thirdParty = await connectWithSourceCapabilities(odataOptions("https://vendor.test/v4"), {
      evaluatedAt: EVALUATED_AT,
      environment: "node",
      availablePeers: ["maplibre-gl"],
    });

    expect(facade.source().descriptor.schemaV2.fingerprint).toBe(thirdParty.source().descriptor.schemaV2.fingerprint);
    expect(facade.source().capabilityProfile.entries).toEqual(thirdParty.source().capabilityProfile.entries);
    expect(facade.source().capabilityProfile.context).toEqual(thirdParty.source().capabilityProfile.context);
    expect(facade.source().capabilityProfile.sourceEndpointFingerprint).not.toBe(
      thirdParty.source().capabilityProfile.sourceEndpointFingerprint,
    );
    expect(capability(facade.source(), "queryObjectIds")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
    });
    expect(capability(facade.source(), "tiles")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
    });
  });

  it("records unavailable GeoServices metadata as unknown instead of restoring adapter defaults", async () => {
    useDiscoveryClock();
    const connection = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/rest/services/Parcels/FeatureServer/0",
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(async () =>
            json({
              id: 0,
              name: "Parcels",
              fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
            }),
          ),
        },
      },
      { evaluatedAt: EVALUATED_AT },
    );

    expect(capability(connection.source(), "query")).toMatchObject({
      claimed: "supported",
      observed: "unknown",
      effective: "unknown",
      reasons: ["observation-unknown"],
    });
    expect(connection.source().supports("query")).toBe(false);
    expect([...connection.source().capabilities]).toEqual([]);
  });

  it("projects WMS/WMTS schema authority and operation-aware capability truth", async () => {
    useDiscoveryClock();
    const wms = await connectWithSourceCapabilities(
      rasterOptions("wms", "https://maps.example/ogc/wms", "parcels", WMS_CAPABILITIES),
      { evaluatedAt: EVALUATED_AT, policy: { deny: ["tiles"] } },
    );
    const wmts = await connectWithSourceCapabilities(
      rasterOptions("wmts", "https://tiles.example/ogc/wmts", "imagery", WMTS_CAPABILITIES),
      { evaluatedAt: EVALUATED_AT },
    );

    expect(wms.source().descriptor.schemaV2).toMatchObject({
      fields: [],
      key: { state: "none" },
      geometry: { state: "unknown", reason: "metadata-unavailable" },
      openContent: "unknown",
    });
    expect(wmts.source().descriptor.schemaV2).toMatchObject({
      fields: [],
      key: { state: "none" },
      geometry: { state: "none", reason: "no-geometry-fields" },
      openContent: "closed",
    });
    for (const connection of [wms, wmts]) {
      const source = connection.source();
      expect(source.descriptor.schemaV2.fingerprint).toBe(source.capabilityProfile.sourceFingerprint);
      expect(source.capabilityProfile.sourceEndpointFingerprint).toBe(
        createCapabilitySourceEndpointFingerprint(sourceCapabilityEndpointIdentity(source.descriptor)),
      );
      expect(JSON.stringify(source.capabilityProfile)).not.toContain("https://");
    }
    expect(capability(wms.source(), "render")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(wms.source(), "tiles")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(capability(wms.source(), "query")).toMatchObject({
      claimed: "supported",
      observed: "unsupported",
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
    expect(wms.source().supports("render")).toBe(true);
    expect(wms.source().supports("tiles")).toBe(false);
    expect(wms.source().supports("query")).toBe(false);
    expect(capability(wmts.source(), "render")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(wmts.source(), "tiles")).toMatchObject({
      claimed: "supported",
      observed: "supported",
      effective: "supported",
    });
    expect(capability(wmts.source(), "query")).toMatchObject({
      claimed: "unsupported",
      observed: "not-observed",
      effective: "unsupported",
      reasons: ["unsupported-by-claim"],
    });
  });

  it("retains canonical Honua WMS FeatureInfo truth and reapplies policy after a raw cache hit", async () => {
    useDiscoveryClock();
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const canonicalOptions = rasterOptions(
      "wms",
      "https://maps.example/rest/services/Public/Map/MapServer/WMS",
      "parcels",
      WMS_CAPABILITIES,
    );
    const first = await connectWithSourceCapabilities(
      {
        ...canonicalOptions,
        cache: {
          get: () => undefined,
          set: (_identity, value) => {
            snapshot = value;
          },
        },
      },
      { evaluatedAt: EVALUATED_AT },
    );
    expect(capability(first.source(), "query")).toMatchObject({
      observed: "supported",
      effective: "supported",
    });
    if (!snapshot) throw new Error("expected WMS discovery snapshot");
    expect(snapshot.sources[0]).not.toHaveProperty("capabilityProfile");

    const fetchFn = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const replay = await connectWithSourceCapabilities(
      {
        endpoint: canonicalOptions.endpoint,
        protocol: "wms",
        typeName: "parcels",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => structuredClone(snapshot), set: vi.fn() },
      },
      { evaluatedAt: EVALUATED_AT, policy: { deny: ["query"] } },
    );

    expect(replay.inspection.cacheStatus).toBe("hit");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(capability(replay.source(), "query")).toMatchObject({
      observed: "supported",
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(replay.source().supports("query")).toBe(false);
  });

  it("re-evaluates policy and freshness after a raw cache hit without fetching or caching evaluated truth", async () => {
    useDiscoveryClock();
    let snapshot: ConnectDiscoverySnapshot | undefined;
    const first = await connectWithSourceCapabilities(
      {
        ...odataOptions("https://example.test/odata"),
        cache: {
          get: () => undefined,
          set: (_identity, value) => {
            snapshot = value;
          },
        },
      },
      { evaluatedAt: EVALUATED_AT, observationTtlMs: 120_000 },
    );
    if (!snapshot) throw new Error("expected discovery snapshot");
    expect(capability(first.source(), "query").effective).toBe("supported");
    expect(snapshot.sources[0]).not.toHaveProperty("capabilityProfile");

    const fetchFn = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const denied = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => structuredClone(snapshot), set: vi.fn() },
      },
      {
        evaluatedAt: "2026-07-15T00:01:30Z",
        observationTtlMs: 120_000,
        policy: { deny: ["query"] },
      },
    );
    expect(denied.inspection.cacheStatus).toBe("hit");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(capability(denied.source(), "query")).toMatchObject({
      observed: "supported",
      effective: "policy-disabled",
    });
    expect(denied.source().supports("query")).toBe(false);

    const stale = await connectWithSourceCapabilities(
      {
        endpoint: "https://example.test/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => structuredClone(snapshot), set: vi.fn() },
      },
      { evaluatedAt: "2026-07-15T00:02:00Z", observationTtlMs: 120_000 },
    );
    expect(capability(stale.source(), "query")).toMatchObject({
      effective: "unknown",
      reasons: ["evidence-stale"],
    });
    expect(stale.source().supports("query")).toBe(false);
  });

  it("fails before network access for unsupported protocols or invalid dynamic freshness input", async () => {
    const fetchFn = vi.fn();
    await expect(
      connectWithSourceCapabilities(
        {
          endpoint: "https://example.test/collections",
          protocol: "ogc-features",
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn },
        } as unknown as SourceCapabilityConnectOptions,
        { evaluatedAt: EVALUATED_AT },
      ),
    ).rejects.toThrow(/currently certified for GeoServices, OData, WMS, and WMTS/);
    await expect(
      connectWithSourceCapabilities(odataOptions("https://example.test/odata"), {
        evaluatedAt: EVALUATED_AT,
        observationTtlMs: 0,
      }),
    ).rejects.toThrow(/positive safe integer/);
    const validationOptions: SourceCapabilityConnectOptions = {
      endpoint: "https://example.test/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    };
    await expect(
      connectWithSourceCapabilities(validationOptions, {
        evaluatedAt: EVALUATED_AT,
        environment: "" as never,
      }),
    ).rejects.toThrow(/environment/);
    await expect(
      connectWithSourceCapabilities(validationOptions, {
        evaluatedAt: EVALUATED_AT,
        observationTtlMs: null as never,
      }),
    ).rejects.toThrow(/positive safe integer/);
    const accessorEvaluation = Object.defineProperty({ evaluatedAt: EVALUATED_AT }, "environment", {
      enumerable: true,
      get: () => "browser",
    }) as SourceCapabilityEvaluationOptions;
    await expect(connectWithSourceCapabilities(validationOptions, accessorEvaluation)).rejects.toThrow(/data property/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

function geoDescriptor(
  url: string,
  serviceId: string,
  layerId: number,
): Pick<SourceDescriptor, "id" | "protocol" | "locator"> {
  return {
    id: String(layerId),
    protocol: "geoservices-feature-service",
    locator: { url, serviceId, layerId },
  };
}

function rasterDescriptor(
  protocol: "wms" | "wmts",
  url: string,
  typeName: string,
): Pick<SourceDescriptor, "id" | "protocol" | "locator"> {
  return { id: typeName, protocol, locator: { url, typeName } };
}

function rasterOptions(
  protocol: "wms" | "wmts",
  endpoint: string,
  typeName: string,
  capabilities: string,
): SourceCapabilityConnectOptions {
  return {
    endpoint,
    protocol,
    typeName,
    authorizationScopeFingerprint: "anonymous",
    clientOptions: {
      fetchFn: vi.fn(
        async () =>
          new Response(capabilities, {
            status: 200,
            headers: { "Content-Type": "application/xml", ETag: '"capabilities-v1"' },
          }),
      ),
    },
  };
}

function odataOptions(endpoint: string): SourceCapabilityConnectOptions {
  return {
    endpoint,
    protocol: "odata",
    authorizationScopeFingerprint: "anonymous",
    clientOptions: {
      fetchFn: vi.fn(
        async () => new Response(odataMetadata(), { status: 200, headers: { "Content-Type": "application/xml" } }),
      ),
    },
  };
}

function odataMetadata(): string {
  return `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Example">
      <EntityType Name="Asset">
        <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container"><EntitySet Name="Assets" EntityType="Example.Asset"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

function capability(
  source: { readonly capabilityProfile: { readonly entries: readonly { readonly id: string }[] } },
  id: string,
) {
  const entry = source.capabilityProfile.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing capability ${id}`);
  return entry as (typeof source.capabilityProfile.entries)[number] & Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function useDiscoveryClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(OBSERVED_AT));
}
