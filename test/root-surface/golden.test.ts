import { describe, expect, it, vi } from "vitest";

import {
  type Query,
  type Result,
  type Source,
  type SourceDescriptor,
  type SourceToMapLibreMap,
  capabilities,
  createHonua,
  explainQuery,
  mountSourceToMapLibre,
} from "../../src/index.js";

interface Incident {
  OBJECTID: number;
  status: string;
}

describe("final root golden workflow", () => {
  it("creates and idempotently disposes an isolated application kernel", async () => {
    const honua = createHonua();
    const first = honua.dispose();
    expect(honua.dispose()).toBe(first);
    await first;
  });

  it("executes the accepted query exactly once on the canonical explain-to-mount path", async () => {
    const descriptor: SourceDescriptor = {
      id: "incidents",
      protocol: "geoservices-feature-service",
      locator: { url: "https://example.test/FeatureServer", serviceId: "incidents", layerId: 0 },
      capabilities: capabilities(["query"]),
      schema: { primaryKey: "OBJECTID" },
    };
    const result: Result<Incident> = {
      features: [
        {
          attributes: { OBJECTID: 1, status: "open" },
          geometry: { x: -157.8, y: 21.3 },
        },
      ],
      exceededTransferLimit: false,
    };
    const queryOnce = vi.fn(async () => result);
    const source = {
      descriptor,
      capabilities: descriptor.capabilities,
      query: queryOnce,
      queryAll: queryOnce,
      queryAggregate: vi.fn(),
    } as unknown as Source<Incident>;
    const query: Query<Incident> = {
      where: "status = 'open'",
      pagination: { limit: 100 },
      returnGeometry: true,
    };
    const plan = explainQuery({ descriptor, query });
    const map = inMemoryMap();

    const mounted = await mountSourceToMapLibre(map, source, plan);

    expect(queryOnce).toHaveBeenCalledOnce();
    expect(map.getSource("honua-incidents")).toBeDefined();
    mounted.dispose();
  });
});

function inMemoryMap(): SourceToMapLibreMap {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  return {
    getSource: (id) => sources.get(id),
    addSource: (id, source) => sources.set(id, source),
    removeSource: (id) => {
      sources.delete(id);
    },
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => {
      const id = (layer as { id: string }).id;
      layers.set(id, layer);
    },
    removeLayer: (id) => {
      layers.delete(id);
    },
  };
}
