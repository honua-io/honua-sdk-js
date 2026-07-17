import { describe, expect, it, vi } from "vitest";

import type { HonuaConnection } from "../src/connect.js";
import { type SourceDiscoveryInspection, normalizeDiscoveryEndpoint } from "../src/contract/discovery.js";
import type { Dataset, Query, Result, Source, SourceDescriptor, SourceId } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { createHonuaKernel } from "../src/kernel/index.js";
import type { RendererAdapter } from "../src/kernel/index.js";
import { canonicalStringify, sha256, toJsonValue } from "../src/query-planner/canonical.js";
import { queryIrSourceIdentity } from "../src/query-planner/ir.js";
import { explainQuery, hashQueryPlanV1 } from "../src/query-planner/planner.js";
import type { QueryExecutionPlanV1 } from "../src/query-planner/types.js";
import type { MapLibreRendererMap, MapLibreRendererOptions } from "../src/runtime/index.js";
import { maplibreRenderer, resetPmtilesProtocol } from "../src/runtime/index.js";

class FakeMap implements MapLibreRendererMap {
  readonly sources = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly calls: string[] = [];
  failLayerAfterMutation = false;
  failRemoveLayer = false;
  removeCount = 0;

  loaded(): boolean {
    return true;
  }

  getSource(id: string): unknown {
    return this.sources.get(id);
  }

  addSource(id: string, source: unknown): void {
    this.calls.push(`addSource:${id}`);
    if ((source as { readonly type?: unknown } | null)?.type === "geojson") {
      const handle = {
        ...(source as Readonly<Record<string, unknown>>),
        setData: (data: unknown) => {
          handle.data = data;
        },
        data: (source as { readonly data?: unknown }).data,
      };
      this.sources.set(id, handle);
      return;
    }
    this.sources.set(id, source);
  }

  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
  }

  getLayer(id: string): unknown {
    return this.layers.get(id);
  }

  addLayer(layer: unknown): void {
    const id = String((layer as { readonly id: unknown }).id);
    this.calls.push(`addLayer:${id}`);
    this.layers.set(id, layer);
    if (this.failLayerAfterMutation) throw new Error("host failure after layer mutation");
  }

  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
    if (this.failRemoveLayer) throw new Error("host failure after layer cleanup");
  }

  once(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  triggerRepaint(): void {
    this.calls.push("triggerRepaint");
  }

  emit(event: string): void {
    const listeners = [...(this.listeners.get(event) ?? [])];
    this.listeners.delete(event);
    for (const listener of listeners) listener();
  }

  remove(): void {
    this.removeCount += 1;
    this.calls.push("removeMap");
  }
}

function fixture<T>(
  descriptor: SourceDescriptor,
  query: Source<T>["query"],
): { readonly connection: HonuaConnection; readonly source: Source<T> } {
  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    query,
    queryAll: query,
  } as unknown as Source<T>;
  const inspection: SourceDiscoveryInspection = {
    descriptor,
    discovery: "metadata",
    provenance: [
      {
        source: `${descriptor.locator.url}/metadata`,
        retrievedAt: "2026-07-16T00:00:00.000Z",
        validator: '"revision-1"',
      },
    ],
    capabilityDecisions: [...descriptor.capabilities].map((capability) => ({
      capability,
      effective: true,
      code: "enabled",
      evidence: [{ kind: "metadata", supported: true, provenance: [] }],
      adapterSupported: true,
      positiveEvidence: true,
      policyAllowed: true,
      reason: `${capability} advertised by fixture metadata`,
    })),
    diagnostics: [],
  };
  const dataset = {
    id: "mount-fixture",
    sourceDescriptors: [descriptor],
    sourceIds: () => [descriptor.id],
    source: (id: SourceId) => (id === descriptor.id ? source : undefined),
  } as unknown as Dataset;
  return {
    source,
    connection: {
      id: "mount-fixture",
      dataset,
      inspection: {
        id: "mount-fixture",
        endpoint: descriptor.locator.url,
        protocol: descriptor.protocol,
        defaultSourceId: descriptor.id,
        sources: [inspection],
        diagnostics: [],
        cacheIdentity: {
          version: 1,
          endpoint: descriptor.locator.url,
          protocol: descriptor.protocol,
          authorizationScopeDigest: `sha256:${"0".repeat(64)}`,
          key: "mount-fixture",
        },
        cacheStatus: "miss",
      },
      source: (id?: SourceId) => {
        if (id !== undefined && id !== descriptor.id) throw new Error("fixture source mismatch");
        return source;
      },
    } as unknown as HonuaConnection,
  };
}

function multiFixture<T>(
  entries: readonly {
    readonly descriptor: SourceDescriptor;
    readonly query: Source<T>["query"];
  }[],
): HonuaConnection {
  const fixtures = entries.map((entry) => fixture(entry.descriptor, entry.query));
  const sources = new Map(fixtures.map((entry) => [entry.source.descriptor.id, entry.source]));
  const descriptors = fixtures.map((entry) => entry.source.descriptor);
  const inspections = fixtures.flatMap((entry) => entry.connection.inspection.sources);
  const endpoint = descriptors[0]?.locator.url ?? "https://features.example.test/ogc";
  const protocol = descriptors[0]?.protocol ?? "ogc-features";
  const dataset = {
    id: "multi-mount-fixture",
    sourceDescriptors: descriptors,
    sourceIds: () => [...sources.keys()],
    source: (id: SourceId) => sources.get(id),
  } as unknown as Dataset;
  return {
    id: "multi-mount-fixture",
    dataset,
    inspection: {
      id: "multi-mount-fixture",
      endpoint,
      protocol,
      sources: inspections,
      diagnostics: [],
      cacheIdentity: {
        version: 1,
        endpoint,
        protocol,
        authorizationScopeDigest: `sha256:${"0".repeat(64)}`,
        key: "multi-mount-fixture",
      },
      cacheStatus: "miss",
    },
    source: (id?: SourceId) => {
      const source = id === undefined ? undefined : sources.get(id);
      if (source === undefined) throw new Error("explicit fixture source required");
      return source;
    },
  } as unknown as HonuaConnection;
}

function acceptedPlanBoundToNativeFixture(descriptor: SourceDescriptor): QueryExecutionPlanV1 {
  const authorizationScope = Object.freeze([`scope:${sha256("honua.kernel.authorization-scope.v1\0anonymous")}`]);
  const template = explainQuery({
    descriptor: {
      id: descriptor.id,
      protocol: "ogc-features",
      locator: { url: "https://planner.example.test/ogc", collectionId: descriptor.id },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    },
    query: { where: "status = 'open'", pagination: { limit: 25 }, returnGeometry: true },
    sourceVersion: "template-source-version",
    authorizationScope,
  });
  const endpoint = normalizeDiscoveryEndpoint(descriptor.locator.url);
  const { url: _url, geoparquet: _geoparquet, ...locatorCoordinates } = descriptor.locator;
  const sourceVersion = `connection-source:${sha256(
    canonicalStringify(
      toJsonValue({
        version: 3,
        connectionId: "mount-fixture",
        endpoint,
        protocol: descriptor.protocol,
        source: {
          id: descriptor.id,
          protocol: descriptor.protocol,
          locator: { ...locatorCoordinates, url: endpoint },
        },
      }),
    ),
  )}`;
  const rebound = {
    ...template,
    ir: {
      ...template.ir,
      source: queryIrSourceIdentity(descriptor, { sourceVersion, authorizationScope }),
    },
  };
  const fingerprint = hashQueryPlanV1(rebound);
  if (fingerprint === undefined) throw new Error("native fixture plan could not be hashed");
  return Object.freeze({ ...rebound, fingerprint });
}

describe("connection MapLibre mount", () => {
  it("borrows an existing map, exposes first-frame readiness/raw diagnostics, and removes only Honua resources", async () => {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect("https://tiles.example.test/imagery/{z}/{x}/{y}.png", {
      protocol: "maplibre-raster",
    });
    const map = new FakeMap();

    const mounted = await connection.mount(map, { renderer: maplibreRenderer({}) });
    let ready = false;
    void mounted.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();

    expect(ready).toBe(false);
    expect(mounted.raw("maplibre")).toBe(map);
    expect(mounted.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: "native-raster-tiles", code: "selected", severity: "info" }),
    );
    expect(map.sources.size).toBe(1);
    expect(map.layers.size).toBe(1);

    map.emit("render");
    await mounted.ready;
    expect(ready).toBe(true);

    const disposal = mounted.dispose();
    expect(mounted.dispose()).toBe(disposal);
    await disposal;
    expect(mounted.raw("maplibre")).toBeUndefined();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.removeCount).toBe(0);

    await kernel.dispose();
  });

  it("creates and owns a map for a selector target, then cascades cleanup from the connection", async () => {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/owned/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-raster" });
    const created: FakeMap[] = [];
    class InjectedMap extends FakeMap {
      constructor(readonly options: Readonly<Record<string, unknown>>) {
        super();
        created.push(this);
      }
    }

    const mounted = await connection.mount("#map", {
      renderer: maplibreRenderer({ Map: InjectedMap }),
      style: "auto",
    });
    const map = created[0]!;
    expect((map as InjectedMap).options).toMatchObject({ container: "#map", style: { version: 8 } });
    map.emit("render");
    await mounted.ready;

    await connection.dispose();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.removeCount).toBe(1);
    await expect(mounted.dispose()).resolves.toBeUndefined();
    await kernel.dispose();
  });

  it("lazily plans and executes one bounded feature query, then refreshes through the same handle", async () => {
    interface Incident {
      readonly id: number;
      readonly status: string;
    }
    const descriptor: SourceDescriptor = {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://features.example.test/ogc", collectionId: "incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
      schema: {
        primaryKey: "id",
        fields: [
          { name: "id", type: "esriFieldTypeInteger" },
          { name: "status", type: "esriFieldTypeString" },
        ],
      },
    };
    const query = vi.fn(async (request?: Query<Incident>) => {
      expect(request?.pagination?.limit).toBe(10_000);
      expect(request?.returnGeometry).toBe(true);
      return {
        features: [
          {
            attributes: { id: 1, status: "open" },
            geometry: { type: "Point", coordinates: [-157.8, 21.3] },
          },
        ],
        exceededTransferLimit: false,
      } satisfies Result<Incident>;
    });
    const data = fixture<Incident>(descriptor, query);
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect<Incident>(descriptor.locator.url, { protocol: "ogc-features" });
    const map = new FakeMap();

    const mounted = await connection.mount(map, { renderer: maplibreRenderer({}) });
    expect(query).toHaveBeenCalledOnce();
    expect(mounted.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: "geojson-query", code: "selected", severity: "info" }),
    );
    map.emit("render");
    await mounted.ready;

    const refreshed = mounted.refresh();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    map.emit("render");
    await refreshed;

    await kernel.dispose();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  it("mounts an accepted plan against its bound source on an otherwise ambiguous connection", async () => {
    interface Road {
      readonly id: number;
    }
    const endpoint = "https://features.example.test/ogc";
    const incidentsQuery = vi.fn(async () => emptyResult<Road>());
    const roadsQuery = vi.fn(async () => emptyResult<Road>());
    const connectionFixture = multiFixture<Road>([
      {
        descriptor: {
          id: "incidents",
          protocol: "ogc-features",
          locator: { url: endpoint, collectionId: "incidents" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
        query: incidentsQuery,
      },
      {
        descriptor: {
          id: "roads",
          protocol: "ogc-features",
          locator: { url: endpoint, collectionId: "roads" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
        query: roadsQuery,
      },
    ]);
    const kernel = createHonuaKernel({ connectDelegate: async () => connectionFixture });
    const connection = await kernel.connect<Road>(endpoint, { protocol: "ogc-features" });
    const plan = await connection.explain({ pagination: { limit: 25 } }, { sourceId: "roads" });
    const map = new FakeMap();

    const mounted = await connection.mount(map, { renderer: maplibreRenderer({}), query: plan });
    map.emit("render");
    await mounted.ready;

    expect(roadsQuery).toHaveBeenCalledOnce();
    expect(incidentsQuery).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it("rejects an accepted plan when an explicit mount source selects a foreign binding", async () => {
    interface Road {
      readonly id: number;
    }
    const endpoint = "https://features.example.test/ogc";
    const incidentsQuery = vi.fn(async () => emptyResult<Road>());
    const roadsQuery = vi.fn(async () => emptyResult<Road>());
    const connectionFixture = multiFixture<Road>([
      {
        descriptor: {
          id: "incidents",
          protocol: "ogc-features",
          locator: { url: endpoint, collectionId: "incidents" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
        query: incidentsQuery,
      },
      {
        descriptor: {
          id: "roads",
          protocol: "ogc-features",
          locator: { url: endpoint, collectionId: "roads" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
        query: roadsQuery,
      },
    ]);
    const kernel = createHonuaKernel({ connectDelegate: async () => connectionFixture });
    const connection = await kernel.connect<Road>(endpoint, { protocol: "ogc-features" });
    const plan = await connection.explain({ pagination: { limit: 25 } }, { sourceId: "roads" });
    const map = new FakeMap();

    await expect(
      connection.mount(map, {
        renderer: maplibreRenderer({}),
        sourceId: "incidents",
        query: plan,
      }),
    ).rejects.toMatchObject({ code: "foreign-plan", reason: "source-identity-changed" });
    expect(map.calls).toEqual([]);
    expect(roadsQuery).not.toHaveBeenCalled();
    expect(incidentsQuery).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it("uses one lifecycle for vector tiles, vector/raster PMTiles, and raster tiles", async () => {
    const scenarios: readonly {
      readonly descriptor: SourceDescriptor;
      readonly rendererOptions: MapLibreRendererOptions;
      readonly strategy: string;
    }[] = [
      {
        descriptor: {
          id: "roads",
          protocol: "maplibre-vector",
          locator: { url: "https://tiles.example.test/roads/{z}/{x}/{y}.pbf" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-vector"],
        },
        rendererOptions: { sourceLayer: "roads" },
        strategy: "vector-tiles",
      },
      {
        descriptor: {
          id: "basemap",
          protocol: "pmtiles",
          locator: { url: "https://tiles.example.test/basemap.pmtiles" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        },
        rendererOptions: { pmtilesType: "vector", sourceLayer: "land" },
        strategy: "pmtiles-vector",
      },
      {
        descriptor: {
          id: "imagery-archive",
          protocol: "pmtiles",
          locator: { url: "https://tiles.example.test/imagery.pmtiles" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        },
        rendererOptions: { pmtilesType: "raster" },
        strategy: "pmtiles-raster",
      },
      {
        descriptor: {
          id: "imagery",
          protocol: "maplibre-raster",
          locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
        },
        rendererOptions: {},
        strategy: "native-raster-tiles",
      },
    ];

    for (const scenario of scenarios) {
      resetPmtilesProtocol();
      const query = vi.fn(async () => emptyResult<Record<string, unknown>>());
      const data = fixture(scenario.descriptor, query);
      const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
      const connection = await kernel.connect(scenario.descriptor.locator.url, {
        protocol: scenario.descriptor.protocol,
      });
      const map = new FakeMap();
      const addProtocol = vi.fn();
      const removeProtocol = vi.fn();
      const mounted = await connection.mount(map, {
        renderer: maplibreRenderer(
          { addProtocol, removeProtocol },
          {
            pmtiles: {
              Protocol: class {
                readonly tile = () => undefined;
              },
            },
          },
        ),
        rendererOptions: scenario.rendererOptions,
      });
      map.emit("render");
      await mounted.ready;

      expect(mounted.diagnostics).toContainEqual(
        expect.objectContaining({ strategy: scenario.strategy, code: "selected", severity: "info" }),
      );
      expect(query).not.toHaveBeenCalled();
      await mounted.dispose();
      expect(map.sources.size).toBe(0);
      expect(map.layers.size).toBe(0);
      expect(map.removeCount).toBe(0);
      await kernel.dispose();
      resetPmtilesProtocol();
    }
  });

  it("fails closed instead of ignoring explicit query intent on native strategies", async () => {
    const scenarios: readonly {
      readonly descriptor: SourceDescriptor;
      readonly rendererOptions: MapLibreRendererOptions;
    }[] = [
      {
        descriptor: {
          id: "roads",
          protocol: "maplibre-vector",
          locator: { url: "https://tiles.example.test/roads/{z}/{x}/{y}.pbf" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-vector"],
        },
        rendererOptions: { sourceLayer: "roads" },
      },
      {
        descriptor: {
          id: "basemap",
          protocol: "pmtiles",
          locator: { url: "https://tiles.example.test/basemap.pmtiles" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        },
        rendererOptions: { pmtilesType: "vector", sourceLayer: "land" },
      },
      {
        descriptor: {
          id: "imagery",
          protocol: "maplibre-raster",
          locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
        },
        rendererOptions: {},
      },
    ];

    for (const scenario of scenarios) {
      resetPmtilesProtocol();
      const query = vi.fn(async () => emptyResult<Record<string, unknown>>());
      const data = fixture(scenario.descriptor, query);
      const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
      const connection = await kernel.connect(scenario.descriptor.locator.url, {
        protocol: scenario.descriptor.protocol,
      });
      const map = new FakeMap();
      const addProtocol = vi.fn();

      await expect(
        connection.mount(map, {
          renderer: maplibreRenderer(
            { addProtocol },
            {
              pmtiles: {
                Protocol: class {
                  readonly tile = () => undefined;
                },
              },
            },
          ),
          rendererOptions: scenario.rendererOptions,
          query: { where: "status = 'open'" },
        }),
      ).rejects.toMatchObject({ code: "no-eligible-strategy" });
      expect(map.calls).toEqual([]);
      expect(addProtocol).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      await kernel.dispose();
    }
  });

  it("rejects accepted query plans before native vector, PMTiles, or raster mutation", async () => {
    const scenarios: readonly {
      readonly descriptor: SourceDescriptor;
      readonly rendererOptions: MapLibreRendererOptions;
    }[] = [
      {
        descriptor: {
          id: "roads",
          protocol: "maplibre-vector",
          locator: { url: "https://tiles.example.test/roads.json" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-vector"],
        },
        rendererOptions: { sourceLayer: "roads" },
      },
      {
        descriptor: {
          id: "basemap",
          protocol: "pmtiles",
          locator: { url: "https://tiles.example.test/basemap.pmtiles" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        },
        rendererOptions: { pmtilesType: "vector", sourceLayer: "land" },
      },
      {
        descriptor: {
          id: "imagery",
          protocol: "maplibre-raster",
          locator: { url: "https://tiles.example.test/imagery.png" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
        },
        rendererOptions: {},
      },
    ];

    for (const scenario of scenarios) {
      resetPmtilesProtocol();
      const query = vi.fn(async () => emptyResult<Record<string, unknown>>());
      const data = fixture(scenario.descriptor, query);
      const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
      const connection = await kernel.connect(scenario.descriptor.locator.url, {
        protocol: scenario.descriptor.protocol,
      });
      const map = new FakeMap();
      const addProtocol = vi.fn();
      const plan = acceptedPlanBoundToNativeFixture(scenario.descriptor);

      await expect(
        connection.mount(map, {
          renderer: maplibreRenderer(
            { addProtocol },
            {
              pmtiles: {
                Protocol: class {
                  readonly tile = () => undefined;
                },
              },
            },
          ),
          rendererOptions: scenario.rendererOptions,
          query: plan,
        }),
      ).rejects.toMatchObject({ code: "no-eligible-strategy" });
      expect(map.calls).toEqual([]);
      expect(addProtocol).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      await kernel.dispose();
    }
  });

  it("rolls back a partial borrowed-map mutation without removing the host", async () => {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-raster" });
    const map = new FakeMap();
    map.failLayerAfterMutation = true;

    await expect(connection.mount(map, { renderer: maplibreRenderer({}) })).rejects.toMatchObject({
      code: "map-mutation-failed",
    });
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.removeCount).toBe(0);
    await kernel.dispose();
  });

  it("rejects duplicate renderer IDs without disturbing the adopted mount", async () => {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-raster" });
    const map = new FakeMap();
    const first = await connection.mount(map, { renderer: maplibreRenderer({}) });

    await expect(connection.mount(map, { renderer: maplibreRenderer({}) })).rejects.toMatchObject({
      code: "source-conflict",
    });
    expect(map.sources.size).toBe(1);
    expect(map.layers.size).toBe(1);
    map.emit("render");
    await first.ready;
    await first.dispose();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    await kernel.dispose();
  });

  it("aborts first-frame readiness and rolls back the adopted borrowed-map resources", async () => {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-raster" });
    const map = new FakeMap();
    const controller = new AbortController();
    const mounted = await connection.mount(map, {
      renderer: maplibreRenderer({}),
      signal: controller.signal,
    });
    const readiness = expect(mounted.ready).rejects.toBeInstanceOf(Error);

    controller.abort();
    await readiness;
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.removeCount).toBe(0);
    await expect(mounted.dispose()).resolves.toBeUndefined();
    await kernel.dispose();
  });

  it("rejects a discovery-stale accepted plan before renderer mutation", async () => {
    const descriptor: SourceDescriptor = {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://features.example.test/ogc", collectionId: "incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    };
    const first = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const refreshedQuery = vi.fn(async () => emptyResult<Record<string, unknown>>());
    const refreshed = fixture(descriptor, refreshedQuery);
    const refreshedInspection = refreshed.connection.inspection.sources[0]!;
    const refreshedConnection = {
      ...refreshed.connection,
      inspection: {
        ...refreshed.connection.inspection,
        cacheStatus: "refreshed",
        sources: [
          {
            ...refreshedInspection,
            provenance: [
              {
                source: `${descriptor.locator.url}/metadata`,
                retrievedAt: "2026-07-16T01:00:00.000Z",
                validator: '"revision-2"',
              },
            ],
          },
        ],
      },
    } as unknown as HonuaConnection;
    const queue = [first.connection, refreshedConnection];
    const kernel = createHonuaKernel({
      connectDelegate: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("fixture queue exhausted");
        return next;
      },
    });
    const connection = await kernel.connect<Record<string, unknown>>(descriptor.locator.url, {
      protocol: "ogc-features",
    });
    const plan = await connection.explain({ pagination: { limit: 25 } });
    await connection.inspect({ refresh: true });
    const map = new FakeMap();

    await expect(connection.mount(map, { renderer: maplibreRenderer({}), query: plan })).rejects.toMatchObject({
      code: "stale-plan",
      reason: "discovery-changed",
    });
    expect(map.calls).toEqual([]);
    expect(refreshedQuery).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it("continues native cleanup after a renderer failure and preserves the borrowed map", async () => {
    const descriptor: SourceDescriptor = {
      id: "roads",
      protocol: "maplibre-vector",
      locator: { url: "https://tiles.example.test/roads/{z}/{x}/{y}.pbf" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-vector"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-vector" });
    const map = new FakeMap();
    const mounted = await connection.mount(map, {
      renderer: maplibreRenderer({}),
      rendererOptions: { sourceLayer: "roads" },
    });
    map.emit("render");
    await mounted.ready;
    map.failRemoveLayer = true;

    const disposal = mounted.dispose();
    expect(mounted.dispose()).toBe(disposal);
    await expect(disposal).rejects.toThrow("host failure after layer cleanup");
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.removeCount).toBe(0);
    await expect(kernel.dispose()).rejects.toBeInstanceOf(AggregateError);
  });

  it.each([
    {
      intent: "style",
      options: { style: "auto" as const },
      message: "MapLibre style is an owned-host construction option",
    },
    {
      intent: "mapOptions",
      options: { rendererOptions: { mapOptions: { zoom: 4 } } },
      message: "MapLibre mapOptions are owned-host construction options",
    },
  ])("rejects borrowed-host $intent intent instead of silently ignoring it", async ({ options, message }) => {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/imagery/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-raster" });
    const map = new FakeMap();

    await expect(connection.mount(map, { renderer: maplibreRenderer({}), ...options })).rejects.toThrow(message);
    expect(map.calls).toEqual([]);
    await kernel.dispose();
  });

  it("rolls back a renderer session when first-frame readiness rejects", async () => {
    const descriptor: SourceDescriptor = {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://features.example.test/ogc", collectionId: "incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "ogc-features" });
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    const dispose = vi.fn(async () => undefined);
    const adapter = {
      kind: "test.renderer" as const,
      environments: ["browser" as const],
      peer: Object.freeze({}),
      defaultOwnership: () => "borrowed" as const,
      async mount() {
        return {
          raw: Object.freeze({ fixture: true }),
          ready,
          diagnostics: [],
          refresh: async () => undefined,
          dispose,
        };
      },
    } satisfies RendererAdapter<"test.renderer", Readonly<{ fixture: true }>>;

    const mounted = await connection.mount({}, { renderer: adapter });
    const rejected = expect(mounted.ready).rejects.toThrow("first frame failed");
    rejectReady(new Error("first frame failed"));

    await rejected;
    expect(dispose).toHaveBeenCalledOnce();
    await expect(mounted.dispose()).resolves.toBeUndefined();
    await connection.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    await kernel.dispose();
  });

  it("disposes a returned renderer candidate when session validation rejects it", async () => {
    const descriptor: SourceDescriptor = {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://features.example.test/ogc", collectionId: "incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "ogc-features" });
    const dispose = vi.fn(async () => undefined);
    const adapter = {
      kind: "test.invalid-session" as const,
      environments: ["browser" as const],
      peer: Object.freeze({}),
      defaultOwnership: () => "borrowed" as const,
      async mount() {
        return {
          raw: Object.freeze({ fixture: true }),
          diagnostics: [],
          refresh: async () => undefined,
          dispose,
        } as never;
      },
    } satisfies RendererAdapter<"test.invalid-session", Readonly<{ fixture: true }>>;

    await expect(connection.mount({}, { renderer: adapter })).rejects.toThrow(
      "Renderer session ready must be a promise.",
    );
    expect(dispose).toHaveBeenCalledOnce();
    await kernel.dispose();
  });

  it("redacts credential-bearing default-ownership failures before invoking the renderer", async () => {
    const secret = "MOUNT-ADAPTER-SECRET";
    const descriptor: SourceDescriptor = {
      id: "incidents",
      protocol: "ogc-features",
      locator: { url: "https://features.example.test/ogc", collectionId: "incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, {
      protocol: "ogc-features",
      authorizationScopeFingerprint: "tenant:mount-test",
      clientOptions: { apiKey: secret },
    });
    const mount = vi.fn(async () => {
      throw new Error("renderer mount must not run");
    });
    const adapter = {
      kind: "test.throwing-ownership" as const,
      environments: ["browser" as const],
      peer: Object.freeze({}),
      defaultOwnership: () => {
        throw new Error(`ownership exposed ${secret}`);
      },
      mount,
    } satisfies RendererAdapter<"test.throwing-ownership", Readonly<{ fixture: true }>>;

    const failure = await connection.mount({}, { renderer: adapter }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(`${(failure as Error).message} ${JSON.stringify(failure)}`).not.toContain(secret);
    expect(mount).not.toHaveBeenCalled();
    await kernel.dispose();
  });
});

function emptyResult<T>(): Result<T> {
  return { features: [], exceededTransferLimit: false };
}
