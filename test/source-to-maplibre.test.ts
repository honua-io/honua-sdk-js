import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { HonuaMapLibreSourceAdapterError, mountSourceToMapLibre, projectSourceToMapLibre } from "../src/map/index.js";
import { explainQuery } from "../src/query-planner/index.js";

const descriptor: SourceDescriptor = {
  id: "Mixed Parcels",
  protocol: "geoservices-feature-service",
  locator: { url: "https://demo.honua.io/FeatureServer", serviceId: "parcels", layerId: 0 },
  capabilities: capabilities(["query"]),
  schema: { primaryKey: "OBJECTID" },
  attribution: "City parcels",
};

const plan = explainQuery({
  descriptor,
  query: { where: "status = 'active'", pagination: { limit: 100 }, returnGeometry: true, outSr: 4326 },
  sourceVersion: "snapshot-7",
  schemaVersion: "schema-3",
  authorizationScope: ["parcels:read"],
});

const context = {
  sourceVersion: "snapshot-7",
  schemaVersion: "schema-3",
  authorizationScope: ["parcels:read"],
} as const;

const mixedResult: Result<Record<string, unknown>> = {
  exceededTransferLimit: false,
  features: [
    { attributes: { OBJECTID: 1, name: "Point" }, geometry: { x: -157.8, y: 21.3 } },
    {
      attributes: { OBJECTID: 2, name: "Line" },
      geometry: {
        paths: [
          [
            [-157.9, 21.2],
            [-157.8, 21.3],
          ],
        ],
      },
    },
    { attributes: { OBJECTID: 3, name: "Unknown" }, geometry: { opaque: true } },
  ],
};

describe("projectSourceToMapLibre", () => {
  it("projects canonical results with plan identity, attribution, stable layers, and fidelity diagnostics", () => {
    const source = fakeSource([mixedResult]);
    const projection = projectSourceToMapLibre(source, plan, mixedResult);

    expect(projection).toMatchObject({
      strategy: "geojson-query",
      sourceId: "honua-mixed-parcels",
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      sourceVersion: "snapshot-7",
      schemaVersion: "schema-3",
      authorizationScope: ["parcels:read"],
      state: "degraded",
    });
    expect(projection.source).toMatchObject({ type: "geojson", attribution: "City parcels", promoteId: "OBJECTID" });
    expect(projection.layers.map((layer) => [layer.id, layer.type])).toEqual([
      ["honua-mixed-parcels-features-point", "circle"],
      ["honua-mixed-parcels-features-line", "line"],
      ["honua-mixed-parcels-features-polygon", "fill"],
    ]);
    expect(projection.diagnostics.map((entry) => [entry.code, entry.fidelity])).toEqual([
      ["strategy-selected", "exact"],
      ["geometry-unsupported", "unsupported"],
      ["mixed-geometry", "equivalent"],
    ]);
    const data = projection.source.data as { features: Array<{ id?: string | number; geometry: unknown }> };
    expect(data.features.map((feature) => feature.id)).toEqual([1, 2, 3]);
    expect(data.features[2]?.geometry).toBeNull();
  });

  it("represents an empty exact result explicitly", () => {
    const source = fakeSource([{ features: [], exceededTransferLimit: false }]);
    const projection = projectSourceToMapLibre(source, plan, { features: [], exceededTransferLimit: false });
    expect(projection.state).toBe("empty");
    expect(projection.diagnostics.map((entry) => entry.code)).toEqual(["strategy-selected", "empty-result"]);
    expect(projection.layers).toHaveLength(3);
  });

  it("does not present transfer-limited pages as a complete ready map", () => {
    const source = fakeSource([mixedResult]);
    const partial = { ...mixedResult, exceededTransferLimit: true };
    const projection = projectSourceToMapLibre(source, plan, partial);
    expect(projection.state).toBe("degraded");
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "transfer-limit", fidelity: "equivalent", detail: { renderedRowCount: 3 } }),
    );
  });

  it("rejects clustering for non-point geometry", () => {
    const source = fakeSource([mixedResult]);
    expect(() => projectSourceToMapLibre(source, plan, mixedResult, { cluster: true })).toThrowError(
      expect.objectContaining({ code: "invalid-option" }),
    );
  });

  it("rejects tampered plans and mismatched source projection context", () => {
    const source = fakeSource([mixedResult]);
    const tampered = { ...plan, cache: "hit" as never };
    expect(() => projectSourceToMapLibre(source, tampered, mixedResult)).toThrowError(
      expect.objectContaining({ code: "invalid-plan" }),
    );

    const other = fakeSource([mixedResult], {
      ...descriptor,
      locator: { ...descriptor.locator, url: "https://other.example.test/FeatureServer" },
    });
    expect(() => projectSourceToMapLibre(other, plan, mixedResult)).toThrowError(
      expect.objectContaining({ code: "plan-context-mismatch" }),
    );
  });

  it("projects 10k point features within the renderer projection budget", () => {
    const source = fakeSource([mixedResult]);
    const features = Array.from({ length: 10_000 }, (_, index) => ({
      attributes: { OBJECTID: index, name: `parcel-${index}` },
      geometry: { x: -157.9 + index / 1_000_000, y: 21.3 },
    }));
    const started = performance.now();
    const projection = projectSourceToMapLibre(source, plan, { features, exceededTransferLimit: false });
    const durationMs = performance.now() - started;
    expect((projection.source.data as { features: unknown[] }).features).toHaveLength(10_000);
    expect(durationMs).toBeLessThan(1_000);
  });
});

describe("mountSourceToMapLibre", () => {
  it("mounts once, refreshes through setData, and disposes idempotently", async () => {
    const nextResult: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [{ attributes: { OBJECTID: 9 }, geometry: { x: -157, y: 21 } }],
    };
    const source = fakeSource([mixedResult, nextResult]);
    const map = fakeMap();
    const mounted = await mountSourceToMapLibre(map, source, plan, context);

    expect(source.query).toHaveBeenCalledOnce();
    expect(map.operations.slice(0, 4)).toEqual([
      "addSource:honua-mixed-parcels",
      "addLayer:honua-mixed-parcels-features-point",
      "addLayer:honua-mixed-parcels-features-line",
      "addLayer:honua-mixed-parcels-features-polygon",
    ]);
    expect(mounted.state).toBe("degraded");

    const refreshed = await mounted.refresh();
    expect(refreshed.state).toBe("ready");
    expect(map.operations).toContain("setData:honua-mixed-parcels");
    expect(mounted.diagnostics.at(-1)?.code).toBe("incremental-update");

    mounted.dispose();
    mounted.dispose();
    expect(mounted.state).toBe("disposed");
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    await expect(mounted.refresh(context)).rejects.toThrowError(expect.objectContaining({ code: "disposed" }));
  });

  it("rejects missing query capability and source conflicts before query effects", async () => {
    const noQuery = fakeSource([mixedResult], { ...descriptor, capabilities: capabilities([]) });
    await expect(mountSourceToMapLibre(fakeMap(), noQuery, plan, context)).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(noQuery.query).not.toHaveBeenCalled();

    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    map.sources.set("honua-mixed-parcels", {});
    await expect(mountSourceToMapLibre(map, source, plan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "source-conflict" }),
    );
    expect(source.query).not.toHaveBeenCalled();

    const layerSource = fakeSource([mixedResult]);
    const layerMap = fakeMap();
    layerMap.layers.set("honua-mixed-parcels-features-line", {});
    await expect(mountSourceToMapLibre(layerMap, layerSource, plan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "layer-conflict" }),
    );
    expect(layerSource.query).not.toHaveBeenCalled();
  });

  it("lets the query planner reject stale context before map mutation", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    await expect(mountSourceToMapLibre(map, source, plan, { ...context, sourceVersion: "stale" })).rejects.toThrow(
      /changed after planning/,
    );
    expect(source.query).not.toHaveBeenCalled();
    expect(map.operations).toEqual([]);
  });

  it("aborts an in-flight refresh when disposed", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    const mounted = await mountSourceToMapLibre(map, source, plan, context);
    source.query.mockImplementationOnce(
      (request?: Query<Record<string, unknown>>) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    const refresh = mounted.refresh();
    mounted.dispose();
    await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
    expect(mounted.state).toBe("disposed");
  });

  it("attempts complete cleanup and reaches disposed state when one renderer removal fails", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    const mounted = await mountSourceToMapLibre(map, source, plan, context);
    map.failRemoveLayerId = "honua-mixed-parcels-features-line";
    expect(() => mounted.dispose()).toThrowError(
      expect.objectContaining({ code: "map-mutation-failed", detail: { sourceId: mounted.sourceId, failureCount: 1 } }),
    );
    expect(mounted.state).toBe("disposed");
    expect(map.sources.size).toBe(0);
    expect(map.layers.has("honua-mixed-parcels-features-point")).toBe(false);
    expect(map.layers.has("honua-mixed-parcels-features-polygon")).toBe(false);
  });

  it("rolls back partial MapLibre mutations transactionally", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    map.failLayerId = "honua-mixed-parcels-features-line";
    await expect(mountSourceToMapLibre(map, source, plan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "map-mutation-failed" }),
    );
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.operations).toEqual([
      "addSource:honua-mixed-parcels",
      "addLayer:honua-mixed-parcels-features-point",
      "removeLayer:honua-mixed-parcels-features-point",
      "removeSource:honua-mixed-parcels",
    ]);
  });
});

function fakeSource(
  results: readonly Result<Record<string, unknown>>[],
  sourceDescriptor: SourceDescriptor = descriptor,
): Source<Record<string, unknown>> & { query: ReturnType<typeof vi.fn> } {
  let index = 0;
  const query = vi.fn(
    async (_request?: Query<Record<string, unknown>>) => results[Math.min(index++, results.length - 1)],
  );
  return {
    descriptor: sourceDescriptor,
    capabilities: sourceDescriptor.capabilities,
    query,
    queryAll: query,
    queryAggregate: vi.fn(),
  } as unknown as Source<Record<string, unknown>> & { query: ReturnType<typeof vi.fn> };
}

function fakeMap() {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const operations: string[] = [];
  const map = {
    sources,
    layers,
    operations,
    failLayerId: undefined as string | undefined,
    failRemoveLayerId: undefined as string | undefined,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, specification: unknown) => {
      operations.push(`addSource:${id}`);
      sources.set(id, {
        specification,
        currentData: (specification as { data: unknown }).data,
        setData(data: unknown) {
          operations.push(`setData:${id}`);
          (this as { currentData: unknown }).currentData = data;
        },
      });
    },
    removeSource: (id: string) => {
      operations.push(`removeSource:${id}`);
      sources.delete(id);
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: unknown) => {
      const id = String((layer as { id: unknown }).id);
      if (id === map.failLayerId) throw new Error("renderer rejected layer");
      operations.push(`addLayer:${id}`);
      layers.set(id, layer);
    },
    removeLayer: (id: string) => {
      if (id === map.failRemoveLayerId) throw new Error("renderer rejected removal");
      operations.push(`removeLayer:${id}`);
      layers.delete(id);
    },
  };
  return map;
}
