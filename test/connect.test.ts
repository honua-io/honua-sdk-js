import { describe, expect, it, vi } from "vitest";

import {
  type ConnectDiscoveryCache,
  type ConnectDiscoverySnapshot,
  HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
  connect,
} from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError } from "../src/core/errors.js";

const landing = {
  title: "Test API",
  links: [
    { rel: "data", href: "./collections" },
    { rel: "conformance", href: "./conformance" },
  ],
};
const conformance = {
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete",
  ],
};
const collections = {
  collections: [
    { id: "parcels", title: "Parcels", crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"] },
    { id: "roads", title: "Roads" },
  ],
};

const stacLanding = {
  id: "earth-search",
  conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/item-search"],
  links: [
    { rel: "data", href: "./collections" },
    { rel: "search", href: "./search", type: "application/geo+json" },
  ],
};
const stacCollections = {
  collections: [
    {
      id: "sentinel-2-l2a",
      title: "Sentinel-2 L2A",
      description: "Cloud-optimized imagery",
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
      extent: {
        spatial: { bbox: [[-180, -90, 180, 90]] },
        temporal: { interval: [["2015-06-27T00:00:00Z", null]] },
      },
    },
    { id: "landsat-c2-l2", title: "Landsat Collection 2" },
  ],
};

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function discoveryFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/api") return json(landing, { ETag: '"landing-v1"' });
    if (url.pathname === "/api/conformance") return json(conformance, { ETag: '"conf-v1"' });
    if (url.pathname === "/api/collections") return json(collections, { ETag: '"collections-v1"' });
    return new Response("not found", { status: 404 });
  });
}

function stacDiscoveryFetch(
  options: { landing?: unknown; collections?: unknown; onRequest?: (request: Request) => void } = {},
): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    options.onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/stac/v1") return json(options.landing ?? stacLanding, { ETag: '"stac-root-v1"' });
    if (url.pathname === "/stac/v1/collections") {
      return json(options.collections ?? stacCollections, { ETag: '"stac-collections-v1"' });
    }
    if (url.pathname === "/stac/v1/search") {
      return json({ type: "FeatureCollection", features: [], numberMatched: 0 });
    }
    return new Response("not found", { status: 404 });
  });
}

async function captureStacSnapshot(): Promise<ConnectDiscoverySnapshot> {
  let captured: ConnectDiscoverySnapshot | undefined;
  await connect({
    endpoint: "https://earth.example/stac/v1",
    protocol: "stac",
    authorizationScopeFingerprint: "anonymous",
    clientOptions: { fetchFn: stacDiscoveryFetch() },
    cache: {
      get: () => undefined,
      set: (_identity, snapshot) => {
        captured = snapshot;
      },
    },
  });
  if (!captured) throw new Error("Expected STAC discovery snapshot");
  return captured;
}

function wfsCapabilities(
  options: {
    version?: string;
    getFeatureMethods?: readonly ("GET" | "POST")[];
    json?: boolean;
    transaction?: boolean;
    namespace?: boolean;
    operationOrigin?: string;
    operationHrefs?: boolean;
    relativeOperationHrefs?: boolean;
    unprefixed?: boolean;
  } = {},
): string {
  const version = options.version ?? "2.0.0";
  const methods = options.getFeatureMethods ?? ["GET", "POST"];
  const origin = options.operationOrigin ?? "https://example.test";
  const operationUrl = options.relativeOperationHrefs ? "wfs" : `${origin}/geoserver/wfs`;
  const methodXml = methods
    .map(
      (method) =>
        `<ows:${method === "GET" ? "Get" : "Post"}${options.operationHrefs === false ? "" : ` xlink:href="${operationUrl}"`}/>`,
    )
    .join("");
  const transactionXml = options.transaction
    ? `<ows:Operation name="Transaction"><ows:DCP><ows:HTTP><ows:Post${options.operationHrefs === false ? "" : ` xlink:href="${operationUrl}"`}/></ows:HTTP></ows:DCP></ows:Operation>`
    : "";
  return `<?xml version="1.0"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" ${options.namespace === false ? "" : 'xmlns:parcels="https://example.test/ns/parcels"'} version="${version}">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP>${methodXml}</ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat"><ows:AllowedValues><ows:Value>${options.json === false ? "application/gml+xml; version=3.2" : "application/geo+json"}</ows:Value></ows:AllowedValues></ows:Parameter>
    </ows:Operation>
    ${transactionXml}
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType><wfs:Name>${options.unprefixed ? "lot" : "parcels:lot"}</wfs:Name><wfs:Title>Lots</wfs:Title><wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS><ows:WGS84BoundingBox><ows:LowerCorner>-158 21</ows:LowerCorner><ows:UpperCorner>-157 22</ows:UpperCorner></ows:WGS84BoundingBox></wfs:FeatureType>
    <wfs:FeatureType><wfs:Name>roads:road</wfs:Name><wfs:Title>Roads</wfs:Title></wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;
}

const odataMetadataXml = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Honua">
      <EntityType Name="IncidentEntity">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Title" Type="Edm.String"/>
        <Property Name="Location" Type="Edm.GeographyPoint" SRID="4326"/>
      </EntityType>
      <EntityType Name="StatEntity">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false"/>
        <Property Name="Count" Type="Edm.Int32"/>
      </EntityType>
      <EntityType Name="ViewEntity">
        <Property Name="Label" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Incidents" EntityType="Honua.IncidentEntity"/>
        <EntitySet Name="Stats" EntityType="Honua.StatEntity"/>
        <EntitySet Name="Views" EntityType="Honua.ViewEntity"/>
      </EntityContainer>
      <Annotations Target="Honua.Container/Stats">
        <Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">
          <Record><PropertyValue Property="Insertable" Bool="false"/></Record>
        </Annotation>
        <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">
          <Record><PropertyValue Property="Updatable" Bool="false"/></Record>
        </Annotation>
        <Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions">
          <Record><PropertyValue Property="Deletable" Bool="false"/></Record>
        </Annotation>
      </Annotations>
      <Annotations Target="Honua.Container/Views">
        <Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">
          <Record><PropertyValue Property="Insertable" Bool="false"/></Record>
        </Annotation>
        <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">
          <Record><PropertyValue Property="Updatable" Bool="false"/></Record>
        </Annotation>
        <Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions">
          <Record><PropertyValue Property="Deletable" Bool="false"/></Record>
        </Annotation>
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

function odataDiscoveryFetch(
  options: { metadata?: string; onRequest?: (request: Request) => void } = {},
): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    options.onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/odata/$metadata") {
      return new Response(options.metadata ?? odataMetadataXml, {
        status: 200,
        headers: { "Content-Type": "application/xml", ETag: '"odata-meta-v1"' },
      });
    }
    if (url.pathname === "/odata/Incidents") {
      return json({ value: [], "@odata.count": 0 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("connect", () => {
  it("discovers reviewed OGC Features descriptors without inventing adapter defaults", async () => {
    const fetchFn = discoveryFetch();
    const connection = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(connection.dataset.sourceIds()).toEqual(["parcels", "roads"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();
    expect([...connection.inspection.sources[0]!.descriptor.capabilities]).toEqual([
      "query",
      "queryObjectIds",
      "applyEdits",
    ]);
    expect(connection.inspection.sources[0]?.descriptor.capabilities.has("stream")).toBe(false);
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ validator: '"conf-v1"' })]),
    );
    expect(() => connection.source()).toThrowError(
      expect.objectContaining({ name: "HonuaDiscoveryError", code: "ambiguous-source" }),
    );
    expect(connection.source("parcels").descriptor.locator.layout).toBe("ogc-api");
  });

  it("restricts discovery to an explicitly selected collection", async () => {
    const connection = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "roads",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: discoveryFetch() },
    });

    expect(connection.inspection.defaultSourceId).toBe("roads");
    expect(connection.source().descriptor.id).toBe("roads");
    expect(connection.dataset.sourceIds()).toEqual(["roads"]);
  });

  it("discovers raw STAC API collections in two metadata requests and reuses the raw root", async () => {
    const requests: Request[] = [];
    const fetchFn = stacDiscoveryFetch({ onRequest: (request) => requests.push(request) });
    const connection = await connect({
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/stac/v1", "/stac/v1/collections"]);
    expect(connection.dataset.sourceIds()).toEqual(["sentinel-2-l2a", "landsat-c2-l2"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();
    expect([...connection.source("sentinel-2-l2a").capabilities]).toEqual(["query", "queryObjectIds", "stream"]);
    expect(connection.source("sentinel-2-l2a").descriptor.locator).toEqual({
      url: "https://earth.example/stac/v1",
      collectionId: "sentinel-2-l2a",
      layout: "stac-api",
    });
    expect(connection.inspection.sources[0]?.metadata).toMatchObject({
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
      extent: {
        spatial: { bbox: [[-180, -90, 180, 90]] },
        temporal: { interval: [["2015-06-27T00:00:00Z", null]] },
      },
    });
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "https://earth.example/stac/v1", validator: '"stac-root-v1"' }),
        expect.objectContaining({
          source: "https://earth.example/stac/v1/collections",
          validator: '"stac-collections-v1"',
        }),
      ]),
    );

    await connection.source("sentinel-2-l2a").query({ pagination: { limit: 1 } });
    expect(new URL(requests.at(-1)!.url).pathname).toBe("/stac/v1/search");
    expect(requests.some((request) => new URL(request.url).pathname.startsWith("/stac/stac"))).toBe(false);
  });

  it("normalizes the serialized slash when a STAC API is mounted at the origin root", async () => {
    const requests: Request[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/") return json(stacLanding);
      if (url.pathname === "/collections") return json(stacCollections);
      return new Response("not found", { status: 404 });
    });

    const connection = await connect({
      endpoint: "https://earth.example",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/", "/collections"]);
    expect(connection.dataset.sourceIds()).toEqual(["sentinel-2-l2a", "landsat-c2-l2"]);
  });

  it("does not apply the static traversal byte ceiling to STAC API collections", async () => {
    const largeCollections = {
      collections: [{ id: "large-api-collection", description: "x".repeat(2_048) }],
    };
    const connection = await connect({
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      stac: { maxDocumentBytes: 512 },
      clientOptions: { fetchFn: stacDiscoveryFetch({ collections: largeCollections }) },
    });

    expect(connection.dataset.sourceIds()).toEqual(["large-api-collection"]);
    expect(connection.inspection.stacStatic).toBeUndefined();
  });

  it("selects one STAC collection and partitions caller discovery cache identity", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache: ConnectDiscoveryCache = {
      get: vi.fn((identity) => values.get(identity.key)),
      set: vi.fn((identity, snapshot) => {
        values.set(identity.key, snapshot);
      }),
    };
    const fetchFn = stacDiscoveryFetch();
    const options = {
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac" as const,
      collectionId: "landsat-c2-l2",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache,
    };

    const first = await connect(options);
    const hit = await connect(options);

    expect(first.dataset.sourceIds()).toEqual(["landsat-c2-l2"]);
    expect(first.inspection.cacheIdentity.key).toContain("collectionId=landsat-c2-l2");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each(["", "   ", " sentinel-2-l2a", "sentinel-2-l2a "])(
    "rejects invalid collectionId %j before cache or network effects",
    async (collectionId) => {
      const fetchFn = stacDiscoveryFetch();
      const get = vi.fn();
      await expect(
        connect({
          endpoint: "https://earth.example/stac/v1",
          protocol: "stac",
          collectionId,
          authorizationScopeFingerprint: "anonymous",
          clientOptions: { fetchFn },
          cache: { get, set: vi.fn() },
        }),
      ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
      expect(get).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("refreshes STAC metadata and cancels between the landing and collections requests", async () => {
    const refreshed: Request[] = [];
    await connect({
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      refresh: true,
      clientOptions: { fetchFn: stacDiscoveryFetch({ onRequest: (request) => refreshed.push(request) }) },
    });
    expect(refreshed).toHaveLength(2);
    expect(refreshed.every((request) => request.headers.get("cache-control") === "no-cache")).toBe(true);

    const controller = new AbortController();
    const requestedPaths: string[] = [];
    const fetchFn = stacDiscoveryFetch({
      onRequest(request) {
        requestedPaths.push(new URL(request.url).pathname);
        controller.abort();
      },
    });
    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(requestedPaths).toEqual(["/stac/v1"]);
  });

  it("fails STAC query capabilities closed without applicable item-search evidence", async () => {
    const connection = await connect({
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: stacDiscoveryFetch({
          landing: {
            ...stacLanding,
            conformsTo: [
              "https://api.stacspec.org/v1.0.0/core",
              "https://attacker.example/api.stacspec.org/v1.0.0/item-search",
            ],
            links: [
              { rel: "data", href: "./collections" },
              { rel: "search", href: "./search" },
            ],
          },
        }),
      },
    });

    expect([...connection.source("sentinel-2-l2a").capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.capabilityDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "query", code: "not-advertised" }),
        expect.objectContaining({ capability: "queryObjectIds", code: "not-advertised" }),
        expect.objectContaining({ capability: "stream", code: "not-advertised" }),
      ]),
    );
  });

  it.each([
    {
      name: "missing Core conformance",
      landing: { ...stacLanding, conformsTo: [], links: [{ rel: "data", href: "./collections" }] },
    },
    {
      name: "spoofed Core conformance",
      landing: {
        ...stacLanding,
        conformsTo: ["https://attacker.example/api.stacspec.org/v1.0.0/core"],
        links: [{ rel: "data", href: "./collections" }],
      },
    },
    {
      name: "missing collections data link",
      landing: {
        ...stacLanding,
        links: [{ rel: "search", href: "./search" }],
      },
    },
  ])("rejects $name after only the STAC landing request", async ({ landing }) => {
    const requestedPaths: string[] = [];
    const fetchFn = stacDiscoveryFetch({
      landing,
      onRequest: (request) => requestedPaths.push(new URL(request.url).pathname),
    });

    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(requestedPaths).toEqual(["/stac/v1"]);
  });

  it("does not accept STAC conformance evidence from a non-default canonical-host port", async () => {
    const requestedPaths: string[] = [];
    const fetchFn = stacDiscoveryFetch({
      landing: {
        ...stacLanding,
        conformsTo: ["https://api.stacspec.org:444/v1.0.0/core", "https://api.stacspec.org:444/v1.0.0/item-search"],
      },
      onRequest: (request) => requestedPaths.push(new URL(request.url).pathname),
    });
    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(requestedPaths).toEqual(["/stac/v1"]);
  });

  it("rejects hostile cached accessors and proxies as typed cache failures without invoking getters", async () => {
    const snapshot = await captureStacSnapshot();
    let getterCalls = 0;
    const accessorSnapshot = { ...structuredClone(snapshot) };
    Object.defineProperty(accessorSnapshot, "evidence", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    const base = {
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac" as const,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: stacDiscoveryFetch() },
    };

    await expect(
      connect({ ...base, cache: { get: () => accessorSnapshot as ConnectDiscoverySnapshot, set: vi.fn() } }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(getterCalls).toBe(0);

    const hostileProxy = new Proxy(structuredClone(snapshot), {
      ownKeys() {
        throw new Error("hostile proxy trap");
      },
    });
    await expect(connect({ ...base, cache: { get: () => hostileProxy, set: vi.fn() } })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-discovery-cache",
    });
  });

  it.each([
    {
      name: "excessive nesting",
      mutate(snapshot: ConnectDiscoverySnapshot) {
        const root: Record<string, unknown> = {};
        let cursor = root;
        for (let depth = 0; depth < 40; depth += 1) {
          const child: Record<string, unknown> = {};
          cursor.child = child;
          cursor = child;
        }
        (snapshot as unknown as Record<string, unknown>).oversized = root;
      },
    },
    {
      name: "oversized dense array",
      mutate(snapshot: ConnectDiscoverySnapshot) {
        (snapshot as unknown as Record<string, unknown>).oversized = Array.from({ length: 10_001 }, () => 0);
      },
    },
    {
      name: "oversized string",
      mutate(snapshot: ConnectDiscoverySnapshot) {
        (snapshot as unknown as Record<string, unknown>).oversized = "x".repeat(1_000_001);
      },
    },
  ])("rejects cache data with $name without network fallback", async ({ mutate }) => {
    const snapshot = structuredClone(await captureStacSnapshot());
    mutate(snapshot);
    const fetchFn = stacDiscoveryFetch();
    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache: { get: () => snapshot, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("owns __proto__ cache keys without changing output or global prototypes", async () => {
    const snapshot = structuredClone(await captureStacSnapshot());
    Object.defineProperty(snapshot, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
      writable: true,
    });
    const fetchFn = stacDiscoveryFetch();
    const connection = await connect({
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache: { get: () => snapshot, set: vi.fn() },
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(connection.dataset.sourceIds()).toEqual(["sentinel-2-l2a", "landsat-c2-l2"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    {
      name: "malformed evidence provenance",
      mutate(snapshot: ConnectDiscoverySnapshot) {
        const evidence = snapshot.evidence as unknown as Array<Record<string, unknown>>;
        evidence[0] = { kind: "metadata", capabilities: ["query"], provenance: [{ source: 42 }] };
      },
    },
    {
      name: "malformed collection extent",
      mutate(snapshot: ConnectDiscoverySnapshot) {
        const source = snapshot.sources[0] as unknown as { extent: { spatial: { bbox: number[][] } } };
        source.extent.spatial.bbox = [[180, 90, -180, -90]];
      },
    },
  ])("rejects $name as invalid-discovery-cache", async ({ mutate }) => {
    const snapshot = structuredClone(await captureStacSnapshot());
    mutate(snapshot);
    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: stacDiscoveryFetch() },
        cache: { get: () => snapshot, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
  });

  it("owns and deeply freezes cached evidence, provenance, and extents before inspection", async () => {
    const snapshot = structuredClone(await captureStacSnapshot());
    const fetchFn = stacDiscoveryFetch();
    const connection = await connect({
      endpoint: "https://earth.example/stac/v1",
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      cache: { get: () => snapshot, set: vi.fn() },
    });
    expect(fetchFn).not.toHaveBeenCalled();

    const evidence = snapshot.evidence as unknown as Array<{
      capabilities: string[];
      provenance: Array<{ source: string }>;
    }>;
    evidence[0]!.capabilities.push("applyEdits");
    evidence[0]!.provenance[0]!.source = "https://attacker.example";
    const source = snapshot.sources[0] as unknown as { extent: { spatial: { bbox: number[][] } } };
    source.extent.spatial.bbox[0]![0] = 999;

    const inspection = connection.inspection.sources[0]!;
    expect([...inspection.descriptor.capabilities]).toEqual(["query", "queryObjectIds", "stream"]);
    expect(inspection.provenance.some((entry) => entry.source === "https://attacker.example")).toBe(false);
    expect(inspection.metadata?.extent?.spatial?.bbox[0]?.[0]).toBe(-180);
    expect(Object.isFrozen(inspection.provenance)).toBe(true);
    expect(Object.isFrozen(inspection.metadata?.extent?.spatial?.bbox[0])).toBe(true);
  });

  it("rejects unsafe or contradictory STAC discovery metadata before following links", async () => {
    const crossOriginFetch = stacDiscoveryFetch({
      landing: {
        ...stacLanding,
        links: [
          { rel: "data", href: "./collections" },
          { rel: "search", href: "https://attacker.example/search" },
        ],
      },
    });
    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: crossOriginFetch },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(crossOriginFetch).toHaveBeenCalledOnce();

    await expect(
      connect({
        endpoint: "https://earth.example/stac/v1",
        protocol: "stac",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: stacDiscoveryFetch({
            collections: { collections: [{ id: "duplicate" }, { id: "duplicate" }] },
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
  });

  it("auto-detects canonical FeatureServer URLs and projects layer metadata truth", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/arcgis/rest/services/Public/Parcels/FeatureServer") {
        return json({
          capabilities: "Query,Create,Update,Delete",
          layers: [{ id: 0, name: "Parcels" }],
          tables: [{ id: 3, name: "Owners" }],
        });
      }
      if (url.pathname.endsWith("/FeatureServer/0")) {
        return json(
          {
            id: 0,
            name: "Parcels",
            capabilities: "Query,Create,Update,Delete",
            hasAttachments: true,
            supportsStatistics: true,
            useStandardizedQueries: true,
            supportedQueryFormats: "JSON, geoJSON, PBF",
            advancedQueryCapabilities: { supportsPagination: true },
            relationships: [{ id: 1, relatedTableId: 3 }],
            fields: [
              { name: "OBJECTID", type: "esriFieldTypeOID" },
              { name: "STATUS", type: "esriFieldTypeString" },
            ],
          },
          { ETag: '"parcels-v2"' },
        );
      }
      if (url.pathname.endsWith("/FeatureServer/3")) {
        return json({
          id: 3,
          name: "Owners",
          capabilities: "Query",
          advancedQueryCapabilities: { supportsPagination: true },
          fields: [],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer?f=pjson",
      protocol: "auto",
      authorizationScopeFingerprint: "role:viewer:v1",
      clientOptions: { fetchFn },
    });

    expect(connection.inspection.protocol).toBe("geoservices-feature-service");
    expect(connection.inspection.endpoint).toBe(
      "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer",
    );
    expect(connection.dataset.client.serverBaseUrl).toBe("https://example.test/arcgis");
    expect(connection.dataset.sourceIds()).toEqual(["0", "3"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();
    expect(connection.inspection.sources[0]?.descriptor).toMatchObject({
      id: "0",
      protocol: "geoservices-feature-service",
      locator: {
        url: "https://example.test/arcgis",
        serviceId: "Public/Parcels",
        layerId: 0,
      },
      schema: { primaryKey: "OBJECTID" },
    });
    expect([...connection.inspection.sources[0]!.descriptor.capabilities]).toEqual(
      expect.arrayContaining([
        "query",
        "queryAggregate",
        "queryExtent",
        "queryObjectIds",
        "queryRelated",
        "applyEdits",
        "attachments",
        "sql",
        "stream",
        "pbf",
      ]),
    );
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ validator: '"parcels-v2"' })]),
    );
    expect(requests).toHaveLength(3);
  });

  it("auto-detects a selected MapServer layer without probing other protocols", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      return json({
        id: 2,
        name: "Cities",
        capabilities: "Map,Query",
        advancedQueryCapabilities: { supportsPagination: true },
        fields: [],
      });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Maps/Cities/MapServer/2",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests).toEqual(["/arcgis/rest/services/Maps/Cities/MapServer/2"]);
    expect(connection.inspection.protocol).toBe("geoservices-map-service");
    expect(connection.inspection.defaultSourceId).toBe("2");
    expect([...connection.source().capabilities]).toEqual(
      expect.arrayContaining(["query", "queryExtent", "queryObjectIds", "render", "stream"]),
    );
    expect(connection.source().capabilities.has("tiles")).toBe(false);
  });

  it("combines MapServer service tile-cache truth with layer capability metadata", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/MapServer")) {
        return json({
          capabilities: "Map,Query",
          singleFusedMapCache: true,
          layers: [{ id: 2, name: "Cities" }],
        });
      }
      return json({ id: 2, name: "Cities", capabilities: "Map,Query", fields: [] });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Maps/Cities/MapServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.source().capabilities.has("render")).toBe(true);
    expect(connection.source().capabilities.has("tiles")).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails canonical query and streaming closed when a layer explicitly rejects pagination", async () => {
    const fetchFn = vi.fn(async () =>
      json({
        id: 0,
        name: "Legacy parcels",
        capabilities: "Query",
        advancedQueryCapabilities: {
          supportsPagination: false,
          supportsReturningQueryExtent: true,
        },
        fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
      }),
    );
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Legacy/Parcels/FeatureServer/0",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect([...connection.source().capabilities]).toEqual(expect.arrayContaining(["queryExtent", "queryObjectIds"]));
    expect(connection.source().capabilities.has("query")).toBe(false);
    expect(connection.source().capabilities.has("stream")).toBe(false);
    await expect(connection.source().queryAll()).rejects.toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      capability: "query",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("lets layer pagination metadata override service-root query evidence", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/FeatureServer")) {
        return json({
          capabilities: "Query",
          layers: [
            { id: 0, name: "Paged parcels" },
            { id: 1, name: "Legacy parcels" },
            { id: 2, name: "Unknown parcels" },
          ],
        });
      }
      const id = Number.parseInt(url.pathname.split("/").at(-1) ?? "", 10);
      return json({
        id,
        name: id === 0 ? "Paged parcels" : id === 1 ? "Legacy parcels" : "Unknown parcels",
        capabilities: "Query",
        ...(id === 2 ? {} : { advancedQueryCapabilities: { supportsPagination: id === 0 } }),
        fields: [],
      });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Mixed/Parcels/FeatureServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.source("0").capabilities.has("query")).toBe(true);
    expect(connection.source("0").capabilities.has("stream")).toBe(true);
    expect(connection.source("1").capabilities.has("query")).toBe(false);
    expect(connection.source("1").capabilities.has("stream")).toBe(false);
    expect(connection.source("1").capabilities.has("queryObjectIds")).toBe(true);
    expect(connection.source("2").capabilities.has("query")).toBe(false);
    expect(connection.source("2").capabilities.has("stream")).toBe(false);
    expect(connection.source("2").capabilities.has("queryObjectIds")).toBe(true);
    await expect(connection.source("1").queryAll()).rejects.toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      capability: "query",
    });
    await expect(connection.source("2").queryAll()).rejects.toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      capability: "query",
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("does not substitute adapter defaults when GeoServices capability metadata is absent", async () => {
    const connection = await connect({
      endpoint: "https://example.test/rest/services/Parcels/FeatureServer/0",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: vi.fn(async () => json({ id: 0, name: "Parcels", fields: [] })) },
    });

    expect([...connection.source().capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.discovery).toBe("unavailable");
    expect(connection.inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "discovery-unavailable" }),
    );
  });

  it("discovers WFS 2.0 feature types from one capabilities request with positive query and edit evidence", async () => {
    const requests: URL[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.searchParams.get("request") === "GetFeature") {
        return json({ type: "FeatureCollection", features: [], numberMatched: 0, numberReturned: 0 });
      }
      return new Response(wfsCapabilities({ transaction: true }), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    });
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("request")).toBe("GetCapabilities");
    expect(requests[0]?.searchParams.get("version")).toBe("2.0.0");
    expect(connection.dataset.sourceIds()).toEqual(["parcels:lot", "roads:road"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();
    const parcels = connection.source("parcels:lot");
    expect(parcels.capabilities.has("query")).toBe(true);
    expect(parcels.capabilities.has("stream")).toBe(true);
    expect(parcels.capabilities.has("applyEdits")).toBe(true);
    expect(parcels.capabilities.has("queryObjectIds")).toBe(false);
    expect(parcels.capabilities.has("queryExtent")).toBe(false);
    expect(parcels.descriptor.locator).toMatchObject({
      url: "https://example.test/geoserver/ows",
      typeName: "parcels:lot",
      featureNamespace: "https://example.test/ns/parcels",
      srsName: "urn:ogc:def:crs:EPSG::4326",
    });
    await expect(parcels.query({ pagination: { limit: 1 } })).resolves.toMatchObject({ features: [] });
    expect(requests.filter((url) => url.searchParams.get("request") === "GetCapabilities")).toHaveLength(1);
    expect(requests.filter((url) => url.searchParams.get("request") === "GetFeature")).toHaveLength(1);
  });

  it("canonicalizes relative WFS GetFeature and Transaction DCP URLs before runtime requests", async () => {
    const requests: Array<{ method: string; url: URL }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (url.searchParams.get("request") === "GetCapabilities") {
        return new Response(wfsCapabilities({ transaction: true, relativeOperationHrefs: true }), {
          headers: { "Content-Type": "application/xml" },
        });
      }
      if (url.searchParams.get("request") === "GetFeature") {
        return json({ type: "FeatureCollection", features: [], numberMatched: 0, numberReturned: 0 });
      }
      return new Response(
        '<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0"><wfs:TransactionSummary><wfs:totalInserted>0</wfs:totalInserted><wfs:totalUpdated>0</wfs:totalUpdated><wfs:totalDeleted>0</wfs:totalDeleted></wfs:TransactionSummary></wfs:TransactionResponse>',
        { headers: { "Content-Type": "application/xml" } },
      );
    });
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      typeName: "parcels:lot",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    await connection.source().query({ pagination: { limit: 1 } });
    await connection
      .source()
      .protocol("wfs")
      ?.transaction({ body: '<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs/2.0"/>' });

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", url: expect.objectContaining({ pathname: "/geoserver/wfs" }) }),
        expect.objectContaining({ method: "POST", url: expect.objectContaining({ pathname: "/geoserver/wfs" }) }),
      ]),
    );
    expect(requests.some(({ url }) => url.pathname.includes("owswfs"))).toBe(false);
  });

  it("selects one WFS type and partitions its discovery identity", async () => {
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      typeName: "roads:road",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async () => new Response(wfsCapabilities(), { headers: { "Content-Type": "text/xml" } })),
      },
    });

    expect(connection.dataset.sourceIds()).toEqual(["roads:road"]);
    expect(connection.source().descriptor.id).toBe("roads:road");
    expect(connection.inspection.cacheIdentity.key).toContain("typeName=roads%3Aroad");
  });

  it("refreshes a reused WFS root instead of serving its in-memory capabilities snapshot", async () => {
    const fetchFn = vi.fn(
      async () => new Response(wfsCapabilities(), { headers: { "Content-Type": "application/xml" } }),
    );
    const client = new HonuaClient({ baseUrl: "https://example.test/geoserver/ows", fetchFn });
    const base = {
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs" as const,
      typeName: "parcels:lot",
      authorizationScopeFingerprint: "anonymous",
      client,
    };

    await connect(base);
    await connect({ ...base, refresh: true });

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("requires both WFS GetFeature bindings even when JSON is advertised", async () => {
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      typeName: "parcels:lot",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(
          async () =>
            new Response(wfsCapabilities({ getFeatureMethods: ["GET"] }), {
              headers: { "Content-Type": "application/xml" },
            }),
        ),
      },
    });

    expect(connection.source().capabilities.has("query")).toBe(false);
    expect(connection.source().capabilities.has("stream")).toBe(false);
  });

  it("does not treat WFS method nodes without DCP hrefs as usable bindings", async () => {
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      typeName: "parcels:lot",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(
          async () =>
            new Response(wfsCapabilities({ transaction: true, operationHrefs: false }), {
              headers: { "Content-Type": "application/xml" },
            }),
        ),
      },
    });

    expect(connection.source().capabilities.has("query")).toBe(false);
    expect(connection.source().capabilities.has("stream")).toBe(false);
    expect(connection.source().capabilities.has("applyEdits")).toBe(false);
  });

  it("does not advertise WFS edits for an unprefixed type without a proven feature namespace", async () => {
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      typeName: "lot",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(
          async () =>
            new Response(wfsCapabilities({ transaction: true, unprefixed: true }), {
              headers: { "Content-Type": "application/xml" },
            }),
        ),
      },
    });

    expect(connection.source().capabilities.has("query")).toBe(true);
    expect(connection.source().capabilities.has("stream")).toBe(true);
    expect(connection.source().capabilities.has("applyEdits")).toBe(false);
  });

  it("fails WFS query and edits closed when JSON or namespace evidence is missing", async () => {
    const connection = await connect({
      endpoint: "https://example.test/geoserver/ows",
      protocol: "wfs",
      typeName: "parcels:lot",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(
          async () =>
            new Response(wfsCapabilities({ json: false, transaction: true, namespace: false }), {
              headers: { "Content-Type": "application/xml" },
            }),
        ),
      },
    });

    expect([...connection.source().capabilities]).toEqual([]);
    expect(connection.inspection.sources[0]?.capabilityDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "query", code: "not-advertised" }),
        expect.objectContaining({ capability: "queryObjectIds", code: "not-advertised" }),
        expect.objectContaining({ capability: "queryExtent", code: "not-advertised" }),
        expect.objectContaining({ capability: "applyEdits", code: "not-advertised" }),
        expect.objectContaining({ capability: "stream", code: "not-advertised" }),
      ]),
    );
  });

  it("rejects unsafe WFS metadata and unsupported versions without following operation URLs", async () => {
    const crossOriginFetch = vi.fn(
      async () =>
        new Response(wfsCapabilities({ operationOrigin: "https://attacker.test" }), {
          headers: { "Content-Type": "application/xml" },
        }),
    );
    await expect(
      connect({
        endpoint: "https://example.test/geoserver/ows",
        protocol: "wfs",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: crossOriginFetch },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(crossOriginFetch).toHaveBeenCalledOnce();

    await expect(
      connect({
        endpoint: "https://example.test/geoserver/ows",
        protocol: "wfs",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(
            async () =>
              new Response(wfsCapabilities({ version: "1.1.0" }), { headers: { "Content-Type": "text/xml" } }),
          ),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

    await expect(
      connect({
        endpoint: "https://example.test/geoserver/ows",
        protocol: "wfs",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(
            async () => new Response("<wfs:WFS_Capabilities>", { headers: { "Content-Type": "text/xml" } }),
          ),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
  });

  it("discovers OData entity sets from one $metadata request with metadata-driven capabilities", async () => {
    const requests: string[] = [];
    const fetchFn = odataDiscoveryFetch({ onRequest: (request) => requests.push(new URL(request.url).pathname) });
    const connection = await connect({
      endpoint: "https://svc.example/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(requests).toEqual(["/odata/$metadata"]);
    expect(connection.inspection.protocol).toBe("odata");
    expect(connection.inspection.endpoint).toBe("https://svc.example/odata");
    expect(connection.dataset.client.serverBaseUrl).toBe("https://svc.example");
    expect(connection.dataset.sourceIds()).toEqual(["Incidents", "Stats", "Views"]);
    expect(connection.inspection.defaultSourceId).toBeUndefined();

    // Writable set with a key + geometry: full canonical surface.
    expect([...connection.source("Incidents").capabilities]).toEqual([
      "query",
      "queryObjectIds",
      "applyEdits",
      "stream",
    ]);
    expect(connection.source("Incidents").descriptor.locator).toEqual({
      url: "https://svc.example/odata",
      entitySet: "Incidents",
    });
    expect(connection.inspection.sources[0]?.descriptor.schema?.primaryKey).toBe("Id");
    expect(connection.inspection.sources[0]?.discovery).toBe("metadata");
    expect(connection.inspection.sources[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "https://svc.example/odata/$metadata", validator: '"odata-meta-v1"' }),
      ]),
    );

    // Read-only set (insert/update/delete all restricted): no applyEdits.
    expect([...connection.source("Stats").capabilities]).toEqual(["query", "queryObjectIds", "stream"]);
    // Keyless view: no ids projection.
    expect([...connection.source("Views").capabilities]).toEqual(["query", "stream"]);
  });

  it("round-trips a discovered OData entity set query through the reviewed descriptor", async () => {
    const requests: string[] = [];
    const fetchFn = odataDiscoveryFetch({ onRequest: (request) => requests.push(new URL(request.url).pathname) });
    const connection = await connect({
      endpoint: "https://svc.example/odata",
      protocol: "odata",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    const result = await connection.source("Incidents").query({ pagination: { limit: 1 } });
    expect(result.features).toEqual([]);
    expect(requests).toContain("/odata/Incidents");
  });

  it("rejects an OData service whose $metadata advertises no entity sets", async () => {
    const emptyMetadata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Honua">
      <EntityContainer Name="Container"></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    await expect(
      connect({
        endpoint: "https://svc.example/odata",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: odataDiscoveryFetch({ metadata: emptyMetadata }) },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
  });

  it("rejects an OData hint against a canonical GeoServices URL before network or cache hooks", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Parcels/FeatureServer",
        protocol: "odata",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects mismatched GeoServices hints before auth, fetch, or cache hooks", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const auth = vi.fn(async () => "secret");
    const get = vi.fn();
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Parcels/FeatureServer",
        protocol: "geoservices-map-service",
        authorizationScopeFingerprint: "scope-a",
        clientOptions: { fetchFn, auth },
        cache: { get, set: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("retains service-level truth and diagnostics when optional layer metadata fails", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/FeatureServer")) {
        return json({ capabilities: "Query", layers: [{ id: 7, name: "Roads" }] });
      }
      return new Response("temporarily unavailable", { status: 503 });
    });
    const connection = await connect({
      endpoint: "https://example.test/arcgis/rest/services/Roads/FeatureServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.source().capabilities.has("query")).toBe(false);
    expect(connection.source().capabilities.has("stream")).toBe(false);
    expect(connection.source().capabilities.has("queryObjectIds")).toBe(true);
    expect(connection.source().capabilities.has("applyEdits")).toBe(false);
    expect(connection.inspection.sources[0]?.discovery).toBe("mixed");
    expect(connection.inspection.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["discovery-unavailable", "partial-discovery"]),
    );
  });

  it("bounds service-root layer metadata discovery to four concurrent requests", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/FeatureServer")) {
        return json({
          capabilities: "Query",
          layers: Array.from({ length: 6 }, (_, id) => ({ id, name: `Layer ${id}` })),
        });
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active -= 1;
      const id = Number.parseInt(url.pathname.split("/").at(-1) ?? "", 10);
      return json({ id, name: `Layer ${id}`, capabilities: "Query", fields: [] });
    });

    const connection = await connect({
      endpoint: "https://example.test/rest/services/Many/FeatureServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.dataset.sourceIds()).toHaveLength(6);
    expect(maxActive).toBe(4);
  });

  it("rejects ambiguous auto and unsupported protocols before auth, fetch, or cache hooks run", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const auth = vi.fn(async () => "secret");
    const get = vi.fn();
    const set = vi.fn();
    const base = {
      endpoint: "https://example.test/api",
      authorizationScopeFingerprint: "scope-a",
      clientOptions: { fetchFn, auth },
      cache: { get, set },
    };

    await expect(connect({ ...base, protocol: "auto" })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "ambiguous-protocol",
    });
    // "grpc" only resolves against a canonical FeatureServer URL (it is not
    // auto-detected, and this endpoint is not a GeoServices layout at all),
    // so it fails the same "invalid-endpoint" way "wms" / "odata" do against
    // a non-matching URL.
    await expect(connect({ ...base, protocol: "grpc" })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("keys caller cache hooks by auth scope and reapplies policy on cache hits", async () => {
    const values = new Map<string, ConnectDiscoverySnapshot>();
    const cache: ConnectDiscoveryCache = {
      get: vi.fn((identity) => values.get(identity.key)),
      set: vi.fn((identity, snapshot) => {
        values.set(identity.key, snapshot);
      }),
    };
    const fetchFn = discoveryFetch();
    const first = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "parcels",
      authorizationScopeFingerprint: "role:viewer:v1",
      clientOptions: { fetchFn },
      cache,
    });
    const hit = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "parcels",
      authorizationScopeFingerprint: "role:viewer:v1",
      clientOptions: { fetchFn },
      capabilityPolicy: { deny: ["applyEdits"] },
      cache,
    });
    const anotherScope = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      collectionId: "parcels",
      authorizationScopeFingerprint: "role:editor:v1",
      clientOptions: { fetchFn },
      cache,
    });

    expect(first.inspection.cacheIdentity.endpoint).toBe("https://example.test/api");
    expect(hit.inspection.cacheStatus).toBe("hit");
    expect(hit.source().capabilities.has("applyEdits")).toBe(false);
    expect(anotherScope.inspection.cacheStatus).toBe("miss");
    expect(first.inspection.cacheIdentity.key).not.toBe(anotherScope.inspection.cacheIdentity.key);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("skips cache reads on refresh and forwards refresh semantics to metadata requests", async () => {
    const requestHeaders: Headers[] = [];
    const cache: ConnectDiscoveryCache = { get: vi.fn(), set: vi.fn() };
    const result = await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      refresh: true,
      cache,
      clientOptions: { fetchFn: discoveryFetch((request) => requestHeaders.push(request.headers)) },
    });

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledOnce();
    expect(result.inspection.cacheStatus).toBe("refreshed");
    expect(requestHeaders.every((headers) => headers.get("cache-control") === "no-cache")).toBe(true);
  });

  it("honors cancellation before network and after asynchronous cache hooks", async () => {
    const fetchFn = discoveryFetch();
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        signal: preAborted.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();

    const duringCache = new AbortController();
    const cache: ConnectDiscoveryCache = {
      get: async () => {
        duringCache.abort();
        return undefined;
      },
      set: vi.fn(),
    };
    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        signal: duringCache.signal,
        clientOptions: { fetchFn },
        cache,
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects query-bearing endpoints and mismatched injected clients before hooks or network", async () => {
    const fetchFn = discoveryFetch();
    const cache: ConnectDiscoveryCache = { get: vi.fn(), set: vi.fn() };
    await expect(
      connect({
        endpoint: "https://example.test/api?tenant=a",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache,
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });

    const client = new HonuaClient({ baseUrl: "https://example.test/another-api", fetchFn });
    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        client,
        cache,
      }),
    ).rejects.toMatchObject({ code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("settles cancellation when a caller cache hook ignores its signal", async () => {
    const controller = new AbortController();
    const fetchFn = discoveryFetch();
    const pending = connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      signal: controller.signal,
      clientOptions: { fetchFn },
      cache: { get: () => new Promise<ConnectDiscoverySnapshot | undefined>(() => {}), set: vi.fn() },
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects stale or cross-identity cache values without touching the network", async () => {
    const fetchFn = discoveryFetch();
    const cache: ConnectDiscoveryCache = {
      get: () =>
        ({
          version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
          identityKey: "another-identity",
          endpoint: "https://example.test/api",
          protocol: "ogc-features",
          retrievedAt: new Date().toISOString(),
          evidence: [{ kind: "metadata", capabilities: ["query"] }],
          sources: [
            {
              id: "parcels",
              locator: { url: "https://example.test/api", collectionId: "parcels", layout: "ogc-api" },
            },
          ],
        }) satisfies ConnectDiscoverySnapshot,
      set: vi.fn(),
    };

    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
        cache,
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-discovery-cache" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not follow cross-origin advertised metadata links with configured credentials", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname === "/api") {
        return json({
          links: [
            { rel: "data", href: "https://attacker.test/collections" },
            { rel: "conformance", href: "https://attacker.test/conformance" },
          ],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(
      connect({
        endpoint: "https://example.test/api",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "user-a",
        clientOptions: { apiKey: "secret", fetchFn },
      }),
    ).rejects.toThrow("Cross-origin request URL is not allowed");
    expect(requests).toEqual(["https://example.test/api?f=json"]);
  });

  it("normalizes advertised format queries before metadata wire parameters are added", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname === "/api") {
        return json({
          links: [
            { rel: "data", href: "./collections?f=json" },
            { rel: "conformance", href: "./conformance?format=json" },
          ],
        });
      }
      if (url.pathname === "/api/conformance") return json(conformance);
      if (url.pathname === "/api/collections") return json(collections);
      return new Response("unexpected", { status: 500 });
    });

    await connect({
      endpoint: "https://example.test/api",
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });
    expect(requests).toHaveLength(3);
    expect(requests).toEqual(
      expect.arrayContaining([
        "https://example.test/api?f=json",
        "https://example.test/api/conformance?f=json",
        "https://example.test/api/collections?f=json",
      ]),
    );
  });
});
