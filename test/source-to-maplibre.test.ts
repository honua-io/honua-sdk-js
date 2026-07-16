import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaMapLibreSourceAdapterError, mountSourceToMapLibre, projectSourceToMapLibre } from "../src/map/index.js";
import {
  type QueryExecutionPlanV1,
  canonicalStringify,
  explainQuery,
  sha256,
  toJsonValue,
} from "../src/query-planner/index.js";

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

  it("rejects re-fingerprinted v1 GeoParquet plans with credential-bearing locators", () => {
    const hostile = structuredClone(plan);
    const sourceIdentity = hostile.ir.source as unknown as {
      protocol: string;
      geoparquet?: { sources: string[] };
    };
    sourceIdentity.protocol = "geoparquet";
    sourceIdentity.geoparquet = {
      sources: ["https://user:secret@example.test/parcels.parquet?X-Amz-Signature=secret"],
    };
    resignPlan(hostile);

    expect(() => projectSourceToMapLibre(fakeSource([mixedResult]), hostile, mixedResult)).toThrowError(
      expect.objectContaining({ code: "invalid-plan" }),
    );
  });

  it("rejects aggregate plans and unexpected aggregate result shapes", async () => {
    const aggregateDescriptor = { ...descriptor, capabilities: capabilities(["query", "queryAggregate"]) };
    const aggregatePlan = explainQuery({
      descriptor: aggregateDescriptor,
      query: { aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] } },
      ...context,
    });
    const aggregateSource = fakeSource(
      [{ features: [], exceededTransferLimit: false, aggregateRows: [{ count: 3 }] }],
      aggregateDescriptor,
    );
    expect(() =>
      projectSourceToMapLibre(aggregateSource, aggregatePlan, {
        features: [],
        exceededTransferLimit: false,
        aggregateRows: [{ count: 3 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-plan" }));
    await expect(mountSourceToMapLibre(fakeMap(), aggregateSource, aggregatePlan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "unsupported-plan" }),
    );
    expect(aggregateSource.query).not.toHaveBeenCalled();

    const source = fakeSource([mixedResult]);
    expect(() =>
      projectSourceToMapLibre(source, plan, { features: [], exceededTransferLimit: false, aggregateRows: [] }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-plan" }));

    const attributeOnlyPlan = explainQuery({
      descriptor,
      query: { pagination: { limit: 10 }, returnGeometry: false },
      ...context,
    });
    await expect(mountSourceToMapLibre(fakeMap(), source, attributeOnlyPlan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "unsupported-plan" }),
    );
    expect(source.query).not.toHaveBeenCalled();
  });

  it("validates GeoJSON type names and reports explicit geometry mismatches", () => {
    const source = fakeSource([mixedResult]);
    const invalid: Result<Record<string, unknown>> = {
      features: [{ attributes: { OBJECTID: 1 }, geometry: { type: "NotGeoJSON", coordinates: [1, 2] } }],
      exceededTransferLimit: false,
    };
    const invalidProjection = projectSourceToMapLibre(source, plan, invalid);
    expect(
      (invalidProjection.source.data as { features: Array<{ geometry: unknown }> }).features[0]?.geometry,
    ).toBeNull();
    expect(invalidProjection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "geometry-unsupported", detail: { unsupportedGeometryCount: 1 } }),
    );

    const missing = projectSourceToMapLibre(source, plan, {
      features: [{ attributes: { OBJECTID: 2 } }],
      exceededTransferLimit: false,
    });
    expect(missing.state).toBe("degraded");
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ code: "geometry-unsupported", detail: { unsupportedGeometryCount: 1 } }),
    );

    const lineOnly: Result<Record<string, unknown>> = {
      features: [mixedResult.features[1] as (typeof mixedResult.features)[number]],
      exceededTransferLimit: false,
    };
    const mismatch = projectSourceToMapLibre(source, plan, lineOnly, { geometry: "point" });
    expect(mismatch.state).toBe("degraded");
    expect(mismatch.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "geometry-mismatch",
        fidelity: "unsupported",
        detail: { requestedGeometry: "point", mismatchedGeometryCount: 1, renderedGeometryCount: 0 },
      }),
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

  it("normalizes long uncontrolled source ids with linear dash trimming", () => {
    const longDescriptor = { ...descriptor, id: `${"-".repeat(50_000)}Parcels${"-".repeat(50_000)}` };
    const longPlan = explainQuery({ descriptor: longDescriptor, query: { pagination: { limit: 1 } }, ...context });
    const source = fakeSource([{ features: [], exceededTransferLimit: false }], longDescriptor);
    expect(projectSourceToMapLibre(source, longPlan, { features: [], exceededTransferLimit: false }).sourceId).toBe(
      "honua-parcels",
    );
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

  it("serializes concurrent refreshes so late completion cannot overwrite newer intent", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    const mounted = await mountSourceToMapLibre(map, source, plan, context);
    const first = deferred<Result<Record<string, unknown>>>();
    const second = deferred<Result<Record<string, unknown>>>();
    source.query.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const firstRefresh = mounted.refresh();
    const secondRefresh = mounted.refresh();
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledTimes(2));
    expect(source.query).toHaveBeenCalledTimes(2);
    first.resolve(pointResult(10));
    await firstRefresh;
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledTimes(3));
    second.resolve(pointResult(20));
    await secondRefresh;

    expect(map.setDataFeatureIds).toEqual([10, 20]);
    mounted.dispose();
  });

  it("checks effective cancellation after an ignoring source resolves and before setData", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    const mounted = await mountSourceToMapLibre(map, source, plan, context);
    const pending = deferred<Result<Record<string, unknown>>>();
    source.query.mockImplementationOnce(() => pending.promise);
    const controller = new AbortController();
    const refresh = mounted.refresh({ signal: controller.signal });
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledTimes(2));
    controller.abort();
    pending.resolve(pointResult(30));

    await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
    expect(map.setDataFeatureIds).toEqual([]);
    mounted.dispose();
  });

  it("checks initial cancellation after an ignoring source resolves and before map mutation", async () => {
    const pending = deferred<Result<Record<string, unknown>>>();
    const source = fakeSource([mixedResult]);
    source.query.mockImplementationOnce(() => pending.promise);
    const map = fakeMap();
    const controller = new AbortController();
    const mounting = mountSourceToMapLibre(map, source, plan, { ...context, signal: controller.signal });
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve(pointResult(40));

    await expect(mounting).rejects.toMatchObject({ name: "AbortError" });
    expect(map.operations).toEqual([]);
  });

  it.each(["throw", "mutate-then-throw"] as const)(
    "wraps setData %s failures and restores the previous projection",
    async (failureMode) => {
      const source = fakeSource([mixedResult, pointResult(50)]);
      const map = fakeMap();
      const mounted = await mountSourceToMapLibre(map, source, plan, context);
      map.failNextSetData = failureMode;

      await expect(mounted.refresh()).rejects.toThrowError(
        expect.objectContaining({
          code: "map-mutation-failed",
          detail: expect.objectContaining({ rollbackSucceeded: true }),
          cause: expect.any(Error),
        }),
      );
      expect(mounted.state).toBe("degraded");
      expect(mounted.diagnostics.at(-1)).toMatchObject({
        code: "incremental-update-failed",
        detail: { rollbackSucceeded: true },
      });
      expect(map.currentSourceFeatureId("honua-mixed-parcels")).toBe(1);
      mounted.dispose();
    },
  );

  it("reports a mutate-then-throw setData restoration failure as partial mutation", async () => {
    const source = fakeSource([mixedResult, pointResult(60)]);
    const map = fakeMap();
    const mounted = await mountSourceToMapLibre(map, source, plan, context);
    map.failNextSetData = "mutate-then-throw";
    map.failRollbackSetData = true;

    await expect(mounted.refresh()).rejects.toThrowError(
      expect.objectContaining({
        code: "map-mutation-failed",
        detail: expect.objectContaining({
          rollbackSucceeded: false,
          rollbackFailure: "renderer rejected setData restoration",
        }),
      }),
    );
    expect(mounted.state).toBe("degraded");
    expect(mounted.diagnostics.at(-1)).toMatchObject({
      code: "incremental-update-failed",
      detail: { rollbackSucceeded: false },
    });
    expect(map.currentSourceFeatureId("honua-mixed-parcels")).toBe(60);
    mounted.dispose();
  });

  it("rejects runtime/descriptor capability drift and source conflicts before query effects", async () => {
    const noQuery = fakeSource([mixedResult], { ...descriptor, capabilities: capabilities([]) });
    await expect(mountSourceToMapLibre(fakeMap(), noQuery, plan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "plan-context-mismatch" }),
    );
    expect(noQuery.query).not.toHaveBeenCalled();

    const runtimeDrift = fakeSource([mixedResult], descriptor, capabilities(["query", "queryAggregate"]));
    await expect(mountSourceToMapLibre(fakeMap(), runtimeDrift, plan, context)).rejects.toThrowError(
      expect.objectContaining({ code: "plan-context-mismatch" }),
    );
    expect(runtimeDrift.query).not.toHaveBeenCalled();

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
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledTimes(2));
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

  it("rolls back a layer when the renderer mutates and then throws", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    map.mutateThenFailLayerId = "honua-mixed-parcels-features-line";
    await expect(mountSourceToMapLibre(map, source, plan, context)).rejects.toThrowError(
      expect.objectContaining({
        code: "map-mutation-failed",
        detail: expect.objectContaining({ rollbackFailureCount: 0 }),
      }),
    );
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.operations).toEqual([
      "addSource:honua-mixed-parcels",
      "addLayer:honua-mixed-parcels-features-point",
      "addLayer:honua-mixed-parcels-features-line",
      "removeLayer:honua-mixed-parcels-features-line",
      "removeLayer:honua-mixed-parcels-features-point",
      "removeSource:honua-mixed-parcels",
    ]);
  });

  it("surfaces rollback failures instead of hiding incomplete cleanup", async () => {
    const source = fakeSource([mixedResult]);
    const map = fakeMap();
    map.mutateThenFailLayerId = "honua-mixed-parcels-features-line";
    map.failRemoveLayerId = "honua-mixed-parcels-features-line";
    await expect(mountSourceToMapLibre(map, source, plan, context)).rejects.toThrowError(
      expect.objectContaining({
        code: "map-mutation-failed",
        detail: expect.objectContaining({
          rollbackFailureCount: 1,
          rollbackFailures: ["renderer rejected removal"],
        }),
      }),
    );
    expect(map.layers.has("honua-mixed-parcels-features-line")).toBe(true);
    expect(map.sources.size).toBe(0);
  });
});

function resignPlan(value: QueryExecutionPlanV1): void {
  const { id: _id, fingerprint: _fingerprint, ...unsigned } = value;
  (value as { fingerprint: `sha256:${string}` }).fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
}

function pointResult(objectId: number): Result<Record<string, unknown>> {
  return {
    features: [{ attributes: { OBJECTID: objectId }, geometry: { x: -157.8, y: 21.3 } }],
    exceededTransferLimit: false,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeSource(
  results: readonly Result<Record<string, unknown>>[],
  sourceDescriptor: SourceDescriptor = descriptor,
  runtimeCapabilities = sourceDescriptor.capabilities,
): Source<Record<string, unknown>> & { query: ReturnType<typeof vi.fn> } {
  let index = 0;
  const query = vi.fn(
    async (_request?: Query<Record<string, unknown>>) => results[Math.min(index++, results.length - 1)],
  );
  return {
    descriptor: sourceDescriptor,
    capabilities: runtimeCapabilities,
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
    mutateThenFailLayerId: undefined as string | undefined,
    failRemoveLayerId: undefined as string | undefined,
    failNextSetData: undefined as "throw" | "mutate-then-throw" | undefined,
    failRollbackSetData: false,
    setDataFeatureIds: [] as Array<string | number | undefined>,
    currentSourceFeatureId(id: string): string | number | undefined {
      const handle = sources.get(id) as { currentData?: { features?: Array<{ id?: string | number }> } } | undefined;
      return handle?.currentData?.features?.[0]?.id;
    },
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, specification: unknown) => {
      operations.push(`addSource:${id}`);
      sources.set(id, {
        specification,
        currentData: (specification as { data: unknown }).data,
        setData(data: unknown) {
          operations.push(`setData:${id}`);
          const failureMode = map.failNextSetData;
          if (failureMode) {
            map.failNextSetData = undefined;
            if (failureMode === "mutate-then-throw") {
              (this as { currentData: unknown }).currentData = data;
              const features = (data as { features?: Array<{ id?: string | number }> }).features ?? [];
              map.setDataFeatureIds.push(features[0]?.id);
            }
            throw new Error(`renderer ${failureMode} setData`);
          }
          if (map.failRollbackSetData) {
            map.failRollbackSetData = false;
            throw new Error("renderer rejected setData restoration");
          }
          (this as { currentData: unknown }).currentData = data;
          const features = (data as { features?: Array<{ id?: string | number }> }).features ?? [];
          map.setDataFeatureIds.push(features[0]?.id);
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
      if (id === map.mutateThenFailLayerId) throw new Error("renderer mutated then rejected layer");
    },
    removeLayer: (id: string) => {
      if (id === map.failRemoveLayerId) throw new Error("renderer rejected removal");
      operations.push(`removeLayer:${id}`);
      layers.delete(id);
    },
  };
  return map;
}
