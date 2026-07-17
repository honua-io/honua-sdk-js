import { describe, expect, it, vi } from "vitest";

import type { HonuaConnection } from "../src/connect.js";
import type { SourceDiscoveryInspection } from "../src/contract/discovery.js";
import type { Dataset, Query, Result, Source, SourceDescriptor, SourceId } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { createHonuaKernel } from "../src/kernel/index.js";
import type { RendererAdapter } from "../src/kernel/index.js";
import type { MapLibreRendererMap } from "../src/runtime/index.js";
import { maplibreRenderer } from "../src/runtime/index.js";

class FakeMap implements MapLibreRendererMap {
  readonly sources = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly calls: string[] = [];
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
  }

  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
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
