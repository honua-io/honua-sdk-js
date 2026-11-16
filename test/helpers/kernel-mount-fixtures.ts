import type { HonuaConnection } from "../../src/connect.js";
import type { SourceDiscoveryInspection } from "../../src/contract/discovery.js";
import type { Dataset, Result, Source, SourceDescriptor, SourceId } from "../../src/contract/types.js";
import type { MapLibreRendererMap } from "../../src/runtime/index.js";

export class FakeMap implements MapLibreRendererMap {
  readonly sources = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly calls: string[] = [];
  failLayerAfterMutation = false;
  failRemoveLayer = false;
  removeCount = 0;
  fullyLoaded = true;
  styleLoaded = true;

  loaded(): boolean {
    return this.fullyLoaded;
  }

  isStyleLoaded(): boolean {
    return this.styleLoaded;
  }

  getStyle(): unknown {
    return { version: 8, sources: {}, layers: [] };
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

function fixtureInspection(descriptor: SourceDescriptor): SourceDiscoveryInspection {
  return {
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
}

export function fixture<T>(
  descriptor: SourceDescriptor,
  query: Source<T>["query"],
): { readonly connection: HonuaConnection; readonly source: Source<T> } {
  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    query,
    queryAll: query,
  } as unknown as Source<T>;
  const inspection = fixtureInspection(descriptor);
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

export function emptyResult<T>(): Result<T> {
  return { features: [], exceededTransferLimit: false };
}
