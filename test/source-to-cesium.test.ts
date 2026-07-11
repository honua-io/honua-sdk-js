import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { explainQuery, hashQueryPlan } from "../src/query-planner/index.js";
import type { QueryExecutionPlanV1 } from "../src/query-planner/types.js";
import {
  type CesiumEntityCollectionTarget,
  type CesiumEntityRuntimeModule,
  mountSourceToCesium,
  projectSourceToCesium,
} from "../src/scene-workspace/index.js";

const descriptor: SourceDescriptor = {
  id: "Response Units",
  protocol: "geoservices-feature-service",
  locator: { url: "https://demo.honua.io/FeatureServer", serviceId: "units", layerId: 0 },
  capabilities: capabilities(["query"]),
  schema: { primaryKey: "unit_id" },
  attribution: "County response units",
};
const context = {
  sourceVersion: "snapshot-7",
  schemaVersion: "schema-3",
  authorizationScope: ["units:read"],
} as const;
const plan = explainQuery({
  descriptor,
  query: { pagination: { limit: 100 }, returnGeometry: true, outSr: 4326 },
  ...context,
});
const firstResult: Result<Record<string, unknown>> = {
  exceededTransferLimit: false,
  features: [
    {
      attributes: { unit_id: "medic/1", observed_at: "2026-07-10T10:00:00Z", expires_at: "2026-07-10T10:05:00Z" },
      geometry: { x: -157.8583, y: 21.3069, z: 12 },
    },
    {
      attributes: { unit_id: 2, observed_at: "invalid", expires_at: "2026-07-10T10:05:00Z" },
      geometry: { type: "Point", coordinates: [-157.8, 21.3] },
    },
    { attributes: { name: "missing-id" }, geometry: { x: -157.7, y: 21.2 } },
    { attributes: { unit_id: 4 }, geometry: { type: "MultiPoint", coordinates: [] } },
  ],
};

describe("projectSourceToCesium", () => {
  it("projects bounded WGS84 entities with stable identity, elevation, intervals, and fidelity diagnostics", () => {
    const source = fakeSource([firstResult]);
    const projection = projectSourceToCesium(source, plan, firstResult, {
      time: { startField: "observed_at", endField: "expires_at" },
      verticalDatum: "ellipsoidal-wgs84",
    });

    expect(projection).toMatchObject({
      strategy: "entity-query",
      sourceId: "honua-response-units",
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      sourceVersion: "snapshot-7",
      schemaVersion: "schema-3",
      state: "degraded",
    });
    expect(projection.entities).toEqual([
      expect.objectContaining({
        id: "honua-response-units:s:medic%2F1",
        featureId: "medic/1",
        geometry: { kind: "point", coordinates: [-157.8583, 21.3069, 12] },
        interval: { start: "2026-07-10T10:00:00.000Z", end: "2026-07-10T10:05:00.000Z" },
      }),
    ]);
    expect(projection.diagnostics.map((entry) => [entry.code, entry.fidelity])).toEqual([
      ["strategy-selected", "exact"],
      ["identity-missing", "unsupported"],
      ["geometry-unsupported", "unsupported"],
      ["time-interval-invalid", "unsupported"],
    ]);
  });

  it("rejects unbounded, oversized, non-WGS84, and identity-free plans", () => {
    const source = fakeSource([firstResult]);
    const unbounded = explainQuery({ descriptor, query: { returnGeometry: true, outSr: 4326 }, ...context });
    expect(() => projectSourceToCesium(source, unbounded, firstResult)).toThrowError(
      expect.objectContaining({ code: "unsupported-plan" }),
    );
    expect(() => projectSourceToCesium(source, plan, firstResult, { maxEntities: 10 })).toThrowError(
      expect.objectContaining({ code: "entity-limit-exceeded" }),
    );
    const webMercator = explainQuery({
      descriptor,
      query: { pagination: { limit: 10 }, returnGeometry: true, outSr: 3857 },
      ...context,
    });
    expect(() => projectSourceToCesium(source, webMercator, firstResult)).toThrowError(
      expect.objectContaining({ code: "unsupported-crs" }),
    );
    const noIdentityDescriptor = { ...descriptor, schema: undefined };
    const noIdentityPlan = explainQuery({
      descriptor: noIdentityDescriptor,
      query: { pagination: { limit: 10 }, returnGeometry: true, outSr: 4326 },
      ...context,
    });
    expect(() =>
      projectSourceToCesium(fakeSource([firstResult], noIdentityDescriptor), noIdentityPlan, firstResult),
    ).toThrowError(expect.objectContaining({ code: "invalid-option" }));
  });

  it("binds the executable remote step to the accepted canonical query", () => {
    const source = fakeSource([firstResult]);
    const mismatched = planWithStepQuery({ returnGeometry: false, outSr: 3857 });
    expect(() => projectSourceToCesium(source, mismatched, firstResult)).toThrowError(
      expect.objectContaining({ code: "invalid-plan" }),
    );
    const implicitGeometry = explainQuery({
      descriptor,
      query: { pagination: { limit: 10 }, outSr: 4326 },
      ...context,
    });
    expect(() => projectSourceToCesium(source, implicitGeometry, firstResult)).toThrowError(
      expect.objectContaining({ code: "unsupported-plan" }),
    );
  });

  it("does not guess the vertical datum for Z coordinates", () => {
    const source = fakeSource([firstResult]);
    const projection = projectSourceToCesium(source, plan, {
      exceededTransferLimit: false,
      features: [{ attributes: { unit_id: 1 }, geometry: { x: -157.8, y: 21.3, z: 25 } }],
    });
    expect(projection.entities).toEqual([]);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "vertical-datum-unsupported", fidelity: "unsupported" }),
    );
  });

  it("omits invalid coordinate ranges, Z values, and unclosed rings", () => {
    const source = fakeSource([firstResult]);
    const projection = projectSourceToCesium(
      source,
      plan,
      {
        exceededTransferLimit: false,
        features: [
          { attributes: { unit_id: 1 }, geometry: { x: 181, y: 21 } },
          { attributes: { unit_id: 2 }, geometry: { type: "Point", coordinates: [-157, 91] } },
          { attributes: { unit_id: 3 }, geometry: { type: "Point", coordinates: [-157, 21, Number.NaN] } },
          {
            attributes: { unit_id: 4 },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-158, 21],
                  [-157, 21],
                  [-157, 22],
                  [-158, 22],
                ],
              ],
            },
          },
        ],
      },
      { verticalDatum: "ellipsoidal-wgs84" },
    );
    expect(projection.entities).toEqual([]);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "geometry-unsupported", detail: { omittedFeatureCount: 4 } }),
    );
  });

  it("rejects sparse line and polygon coordinate arrays without renderer effects", async () => {
    const sparseLine = new Array<unknown>(2);
    sparseLine[0] = [-157, 21];
    const sparseRing = new Array<unknown>(4);
    sparseRing[0] = [-158, 21];
    sparseRing[1] = [-157, 21];
    sparseRing[3] = [-158, 21];
    const result: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [
        { attributes: { unit_id: 1 }, geometry: { type: "LineString", coordinates: sparseLine } },
        { attributes: { unit_id: 2 }, geometry: { type: "Polygon", coordinates: [sparseRing] } },
      ],
    };
    const source = fakeSource([result]);
    const projection = projectSourceToCesium(source, plan, result);
    expect(projection.entities).toEqual([]);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "geometry-unsupported", detail: { omittedFeatureCount: 2 } }),
    );

    const collection = fakeCollection();
    const mounted = await mountSourceToCesium(collection, source, plan, { ...context, cesium: cesiumModule });
    expect(mounted.entityIds).toEqual([]);
    expect(collection.entities.size).toBe(0);
    mounted.dispose();
  });

  it("rejects prototype-filled coordinate and attribute holes without renderer effects", async () => {
    const line = prototypeFilledArray<unknown>(2, 1, [-156, 22]);
    line[0] = [-157, 21];
    const ring = prototypeFilledArray<unknown>(4, 2, [-157, 22]);
    ring[0] = [-158, 21];
    ring[1] = [-157, 21];
    ring[3] = [-158, 21];
    const tuple = prototypeFilledArray<unknown>(2, 1, 21);
    tuple[0] = -157;
    const tags = prototypeFilledArray<unknown>(2, 1, "prototype-value");
    tags[0] = "own-value";
    const result: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [
        { attributes: { unit_id: 1 }, geometry: { type: "LineString", coordinates: line } },
        { attributes: { unit_id: 2 }, geometry: { type: "Polygon", coordinates: [ring] } },
        { attributes: { unit_id: 3 }, geometry: { type: "Point", coordinates: tuple } },
        { attributes: { unit_id: 4, tags }, geometry: { x: -157, y: 21 } },
      ],
    };
    const source = fakeSource([result]);
    const projection = projectSourceToCesium(source, plan, result);
    expect(projection.entities).toEqual([]);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "geometry-unsupported", detail: { omittedFeatureCount: 3 } }),
    );
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "attributes-unsupported", detail: { omittedFeatureCount: 1 } }),
    );

    const collection = fakeCollection();
    const mounted = await mountSourceToCesium(collection, source, plan, { ...context, cesium: cesiumModule });
    expect(mounted.entityIds).toEqual([]);
    expect(collection.entities.size).toBe(0);
    mounted.dispose();
  });

  it("accepts epoch milliseconds and offset-bearing millisecond ISO instants only", () => {
    const source = fakeSource([firstResult]);
    const result: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [
        { attributes: { unit_id: 1, start: 1_784_192_400_000, end: 1_784_192_460_000 }, geometry: { x: -157, y: 21 } },
        {
          attributes: { unit_id: 2, start: "2026-07-15T10:00:00-10:00", end: "2026-07-15T10:01:00-10:00" },
          geometry: { x: -157, y: 21 },
        },
        {
          attributes: { unit_id: 3, start: "2026-07-15T10:00:00", end: "2026-07-15T10:01:00" },
          geometry: { x: -157, y: 21 },
        },
        {
          attributes: { unit_id: 4, start: "2026-07-15T10:00:00.0001Z", end: "2026-07-15T10:01:00Z" },
          geometry: { x: -157, y: 21 },
        },
      ],
    };
    const projection = projectSourceToCesium(source, plan, result, {
      time: { startField: "start", endField: "end" },
    });
    expect(projection.entities.map((entity) => entity.featureId)).toEqual([1, 2]);
    expect(projection.entities[1]?.interval).toEqual({
      start: "2026-07-15T20:00:00.000Z",
      end: "2026-07-15T20:01:00.000Z",
    });
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "time-interval-invalid", detail: { omittedFeatureCount: 2 } }),
    );
  });

  it("deeply snapshots caller attributes and reports incomplete fidelity truthfully", () => {
    const nested = { dispatch: { priority: 1 }, tags: ["live"] };
    const source = fakeSource([firstResult]);
    const projection = projectSourceToCesium(source, plan, {
      exceededTransferLimit: true,
      degraded: [
        { capability: "query", reason: "replica lag", protocol: descriptor.protocol, sourceId: descriptor.id },
      ],
      features: [{ attributes: { unit_id: 1, nested }, geometry: { x: -157, y: 21 } }],
    });
    nested.dispatch.priority = 9;
    nested.tags.push("changed");
    expect(projection.entities[0]?.properties.nested).toEqual({ dispatch: { priority: 1 }, tags: ["live"] });
    expect(Object.isFrozen(projection.entities[0]?.properties.nested)).toBe(true);
    expect(
      projection.diagnostics.filter((entry) => entry.severity === "warning").map((entry) => entry.fidelity),
    ).toEqual(["unsupported", "unsupported"]);
    expect(Object.isFrozen(projection.diagnostics[1]?.detail)).toBe(true);
  });

  it("rejects Date and custom attribute objects instead of exposing mutable internal slots", () => {
    class CustomAttribute {
      public constructor(public value: string) {}
    }
    const source = fakeSource([firstResult]);
    const projection = projectSourceToCesium(source, plan, {
      exceededTransferLimit: false,
      features: [
        { attributes: { unit_id: 1, status: { code: "ready" } }, geometry: { x: -157, y: 21 } },
        { attributes: { unit_id: 2, observed: new Date("2026-07-15T10:00:00Z") }, geometry: { x: -157, y: 21 } },
        { attributes: { unit_id: 3, custom: new CustomAttribute("unsafe") }, geometry: { x: -157, y: 21 } },
      ],
    });
    expect(projection.entities.map((entity) => entity.featureId)).toEqual([1]);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "attributes-unsupported", detail: { omittedFeatureCount: 2 } }),
    );
  });

  it("copies and freezes authorization scope in the projection receipt", () => {
    const mutablePlan = JSON.parse(JSON.stringify(plan)) as QueryExecutionPlanV1;
    const mutableScope = mutablePlan.ir.source.authorizationScope as string[];
    const projection = projectSourceToCesium(fakeSource([firstResult]), mutablePlan, firstResult, {
      verticalDatum: "ellipsoidal-wgs84",
    });
    mutableScope.push("units:write");
    expect(projection.authorizationScope).toEqual(["units:read"]);
    expect(Object.isFrozen(projection.authorizationScope)).toBe(true);
  });

  it("projects 10k point entities within the renderer-neutral projection budget", () => {
    const source = fakeSource([firstResult]);
    const largePlan = explainQuery({
      descriptor,
      query: { pagination: { limit: 10_000 }, returnGeometry: true, outSr: 4326 },
      ...context,
    });
    const result = {
      exceededTransferLimit: false,
      features: Array.from({ length: 10_000 }, (_, index) => ({
        attributes: { unit_id: index },
        geometry: { x: -157.9 + index / 1_000_000, y: 21.3 },
      })),
    };
    const started = performance.now();
    const projection = projectSourceToCesium(source, largePlan, result);
    expect(projection.entities).toHaveLength(10_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("mountSourceToCesium", () => {
  it("reports an injected peer load failure before querying the source", async () => {
    const source = fakeSource([firstResult]);
    await expect(
      mountSourceToCesium(fakeCollection(), source, plan, {
        ...context,
        cesium: async () => {
          throw new Error("peer missing");
        },
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "peer-unavailable", cause: expect.any(Error) }));
    expect(source.query).not.toHaveBeenCalled();
  });

  it("rejects pre-aborted and malformed peers before reading the source", async () => {
    const source = fakeSource([firstResult]);
    const loader = vi.fn(async () => cesiumModule);
    const controller = new AbortController();
    controller.abort();
    await expect(
      mountSourceToCesium(fakeCollection(), source, plan, { ...context, signal: controller.signal, cesium: loader }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(loader).not.toHaveBeenCalled();
    await expect(
      mountSourceToCesium(fakeCollection(), source, plan, {
        ...context,
        cesium: async () => ({}) as CesiumEntityRuntimeModule,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "peer-unavailable" }));
    expect(source.query).not.toHaveBeenCalled();
  });

  it("snapshots mutable mount options before awaiting the peer", async () => {
    const source = fakeSource([firstResult]);
    const peer = deferred<CesiumEntityRuntimeModule>();
    const options = {
      ...context,
      featureIdField: "unit_id",
      cesium: () => peer.promise,
      verticalDatum: "ellipsoidal-wgs84" as const,
    };
    const mounting = mountSourceToCesium(fakeCollection(), source, plan, options);
    options.featureIdField = "changed_after_call";
    peer.resolve(cesiumModule);
    const mounted = await mounting;
    expect(mounted.entityIds).toContain("honua-response-units:s:medic%2F1");
    mounted.dispose();
  });

  it("uses an injected lazy peer, rebuilds by stable id, and disposes idempotently", async () => {
    const nextResult: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [{ attributes: { unit_id: "medic/1" }, geometry: { x: -157.7, y: 21.2 } }],
    };
    const source = fakeSource([firstResult, nextResult]);
    const collection = fakeCollection();
    const loader = vi.fn(async () => cesiumModule);
    const mounted = await mountSourceToCesium(collection, source, plan, {
      ...context,
      cesium: loader,
      verticalDatum: "ellipsoidal-wgs84",
    });

    expect(loader).toHaveBeenCalledOnce();
    expect(mounted.entityIds).toEqual(["honua-response-units:s:medic%2F1", "honua-response-units:n:2"]);
    expect(collection.entities.get("honua-response-units:s:medic%2F1")).toMatchObject({
      position: { longitude: -157.8583, latitude: 21.3069, height: 12 },
    });

    const refreshed = await mounted.refresh();
    expect(mounted.entityIds).toEqual(["honua-response-units:s:medic%2F1"]);
    expect(Object.isFrozen(refreshed)).toBe(true);
    expect(Object.isFrozen(refreshed.diagnostics)).toBe(true);
    expect(Object.isFrozen(mounted.diagnostics)).toBe(true);
    expect(mounted.diagnostics.at(-1)).toMatchObject({
      code: "incremental-update",
      detail: { rebuildBoundary: "entity-snapshot" },
    });

    mounted.dispose();
    mounted.dispose();
    expect(mounted.state).toBe("disposed");
    expect(collection.entities.size).toBe(0);
    await expect(mounted.refresh()).rejects.toThrowError(expect.objectContaining({ code: "disposed" }));
  });

  it("cancels before renderer mutation even when the source ignores its signal", async () => {
    const pending = deferred<Result<Record<string, unknown>>>();
    const source = fakeSource([firstResult]);
    source.query.mockImplementationOnce(() => pending.promise);
    const collection = fakeCollection();
    const controller = new AbortController();
    const mounting = mountSourceToCesium(collection, source, plan, {
      ...context,
      cesium: cesiumModule,
      signal: controller.signal,
      verticalDatum: "ellipsoidal-wgs84",
    });
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve(firstResult);
    await expect(mounting).rejects.toMatchObject({ name: "AbortError" });
    expect(collection.entities.size).toBe(0);
  });

  it("restores the prior entity snapshot when a refresh rebuild fails", async () => {
    const nextResult: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [{ attributes: { unit_id: 99 }, geometry: { x: -157.7, y: 21.2 } }],
    };
    const source = fakeSource([firstResult, nextResult]);
    const collection = fakeCollection();
    const mounted = await mountSourceToCesium(collection, source, plan, {
      ...context,
      cesium: cesiumModule,
      verticalDatum: "ellipsoidal-wgs84",
    });
    const previousIds = mounted.entityIds;
    collection.failAddId = "honua-response-units:n:99";

    await expect(mounted.refresh()).rejects.toThrowError(expect.objectContaining({ code: "renderer-mutation-failed" }));
    expect(mounted.state).toBe("degraded");
    expect(mounted.entityIds).toEqual(previousIds);
    expect([...collection.entities.keys()]).toEqual(previousIds);
    expect(mounted.diagnostics.at(-1)).toMatchObject({
      code: "incremental-update-failed",
      detail: { rollbackSucceeded: true },
    });
    collection.failAddId = undefined;
    mounted.dispose();
  });

  it("cannot resurrect entities when collection listeners dispose during refresh", async () => {
    const nextResult: Result<Record<string, unknown>> = {
      exceededTransferLimit: false,
      features: [{ attributes: { unit_id: 99 }, geometry: { x: -157.7, y: 21.2 } }],
    };
    const source = fakeSource([firstResult, nextResult]);
    const collection = fakeCollection();
    const mounted = await mountSourceToCesium(collection, source, plan, {
      ...context,
      cesium: cesiumModule,
      verticalDatum: "ellipsoidal-wgs84",
    });
    collection.onAdd = (id) => {
      if (id === "honua-response-units:n:99") mounted.dispose();
    };
    await expect(mounted.refresh()).rejects.toMatchObject({ name: "AbortError" });
    expect(mounted.state).toBe("disposed");
    expect(mounted.entityIds).toEqual([]);
    expect(collection.entities.size).toBe(0);
  });

  it("does not restore a snapshot when collection removal reenters disposal", async () => {
    const source = fakeSource([firstResult, firstResult]);
    const collection = fakeCollection();
    const mounted = await mountSourceToCesium(collection, source, plan, {
      ...context,
      cesium: cesiumModule,
      verticalDatum: "ellipsoidal-wgs84",
    });
    collection.onRemove = () => mounted.dispose();
    await expect(mounted.refresh()).rejects.toMatchObject({ name: "AbortError" });
    expect(mounted.state).toBe("disposed");
    expect(mounted.entityIds).toEqual([]);
    expect(collection.entities.size).toBe(0);
  });

  it("keeps failed disposal retryable and completes cleanup on a later call", async () => {
    const source = fakeSource([firstResult]);
    const collection = fakeCollection();
    const mounted = await mountSourceToCesium(collection, source, plan, {
      ...context,
      cesium: cesiumModule,
      verticalDatum: "ellipsoidal-wgs84",
    });
    collection.failRemoveId = "honua-response-units:s:medic%2F1";
    expect(() => mounted.dispose()).toThrowError(
      expect.objectContaining({ code: "renderer-mutation-failed", message: expect.stringContaining("may be retried") }),
    );
    expect(mounted.state).toBe("disposing");
    expect(mounted.entityIds).toEqual(["honua-response-units:s:medic%2F1"]);

    collection.failRemoveId = undefined;
    mounted.dispose();
    expect(mounted.state).toBe("disposed");
    expect(collection.entities.size).toBe(0);
  });
});

const cesiumModule: CesiumEntityRuntimeModule = {
  Cartesian3: {
    fromDegrees: (longitude, latitude, height) => ({ longitude, latitude, height }),
  },
  JulianDate: { fromIso8601: (value) => ({ iso: value }) },
  TimeInterval: class {
    constructor(public readonly options: { start: unknown; stop: unknown }) {}
  },
  TimeIntervalCollection: class {
    constructor(public readonly intervals?: readonly unknown[]) {}
  },
  PolygonHierarchy: class {
    constructor(public readonly positions: readonly unknown[]) {}
  },
};

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

function fakeCollection(): CesiumEntityCollectionTarget & {
  entities: Map<string, Readonly<Record<string, unknown>>>;
  failRemoveId?: string;
  failAddId?: string;
  onAdd?: (id: string) => void;
  onRemove?: (id: string) => void;
} {
  const entities = new Map<string, Readonly<Record<string, unknown>>>();
  const collection = {
    entities,
    failRemoveId: undefined as string | undefined,
    failAddId: undefined as string | undefined,
    onAdd: undefined as ((id: string) => void) | undefined,
    onRemove: undefined as ((id: string) => void) | undefined,
    getById: (id: string) => entities.get(id),
    add: (entity: Readonly<Record<string, unknown>>) => {
      const id = String(entity.id);
      if (entities.has(id)) throw new Error(`duplicate ${id}`);
      if (collection.failAddId === id) throw new Error(`cannot add ${id}`);
      entities.set(id, entity);
      collection.onAdd?.(id);
      return entity;
    },
    removeById: (id: string) => {
      if (collection.failRemoveId === id) throw new Error(`cannot remove ${id}`);
      const removed = entities.delete(id);
      if (removed) collection.onRemove?.(id);
      return removed;
    },
  };
  return collection;
}

function planWithStepQuery(query: QueryExecutionPlanV1["ir"]["query"]): QueryExecutionPlanV1 {
  const changed = {
    ...plan,
    steps: [{ ...plan.steps[0], query }],
  } as QueryExecutionPlanV1;
  const fingerprint = hashQueryPlan(changed);
  return { ...changed, fingerprint };
}

function prototypeFilledArray<T>(length: number, inheritedIndex: number, inheritedValue: T): T[] {
  const value = new Array<T>(length);
  const prototype = Object.create(Array.prototype) as T[];
  Object.defineProperty(prototype, inheritedIndex, {
    value: inheritedValue,
    configurable: true,
  });
  Object.setPrototypeOf(value, prototype);
  return value;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
