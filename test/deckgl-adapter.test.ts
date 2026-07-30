import { describe, expect, it, vi } from "vitest";

import {
  DECK_GL_CAPABILITIES,
  type DeckGlLayer,
  type DeckGlProjectionRequest,
  HonuaDeckGlAdapterError,
  createDeckGlAdapter,
  loadDeckGlAdapter,
  loadDeckGlPeers,
} from "../src/deckgl/index.js";

class FakeScatterplotLayer implements DeckGlLayer {
  public readonly id: string | undefined;

  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
  }
}

function request(rows = 2): DeckGlProjectionRequest {
  return {
    layer: "scatterplot",
    layerId: "incidents",
    data: {
      length: rows,
      attributes: {
        getPosition: { value: new Float32Array(rows * 2), size: 2 },
        getRadius: { value: new Float32Array(rows), size: 1 },
      },
    },
    identity: {
      sourceId: "incidents-live",
      planId: "plan:sha256:123",
      sourceVersion: "42",
      featureIds: new Uint32Array(Array.from({ length: rows }, (_, index) => 100 + index)),
    },
    props: { radiusUnits: "meters" },
  };
}

describe("deck.gl adapter", () => {
  it("projects binary typed arrays without copying payload bytes", () => {
    const input = request();
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const projection = adapter.project(input);
    const layer = projection.layer as FakeScatterplotLayer;
    const data = layer.props.data as DeckGlProjectionRequest["data"];

    expect(data.attributes.getPosition.value).toBe(input.data.attributes.getPosition.value);
    expect(data.attributes.getRadius.value).toBe(input.data.attributes.getRadius.value);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.attributes)).toBe(true);
    expect(Object.isFrozen(data.attributes.getPosition)).toBe(true);
    expect(projection.metrics).toEqual({
      rows: 2,
      attributes: 2,
      logicalViewBytes: 24,
      uniqueBackingBytes: 24,
      copiedBytes: 0,
    });
    expect(projection.diagnostic).toMatchObject({
      strategy: "gpu-binary",
      precision: "input-array",
      fallback: "none",
    });
    expect(layer.props).toMatchObject({ id: "incidents", pickable: true, radiusUnits: "meters" });
  });

  it("counts shared backing allocations once", () => {
    const backing = new ArrayBuffer(48);
    const input = request();
    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project({
      ...input,
      data: {
        length: 2,
        attributes: {
          getPosition: { value: new Float32Array(backing, 0, 4), size: 2 },
          getRadius: { value: new Float32Array(backing, 16, 2), size: 1 },
        },
      },
    });

    expect(projection.metrics.logicalViewBytes).toBe(24);
    expect(projection.metrics.uniqueBackingBytes).toBe(48);
  });

  it("returns stable source and plan identity for a picked row", () => {
    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project(request());

    expect(projection.selectionForPick(1)).toEqual({
      sourceId: "incidents-live",
      planId: "plan:sha256:123",
      sourceVersion: "42",
      featureId: 101,
      rowIndex: 1,
    });
    expect(() => projection.selectionForPick(2)).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("mounts and removes a layer exactly once", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const projection = adapter.project(request());
    const host = { addLayer: vi.fn(), removeLayer: vi.fn() };
    const mounted = projection.mount(host);

    expect(host.addLayer).toHaveBeenCalledOnce();
    mounted.dispose();
    mounted.dispose();
    expect(mounted.disposed).toBe(true);
    expect(host.removeLayer).toHaveBeenCalledOnce();
  });

  it("cascades disposal to all adapter-owned mounts", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const host = { addLayer: vi.fn(), removeLayer: vi.fn() };
    adapter.project(request()).mount(host);
    adapter.project({ ...request(), layerId: "second" }).mount(host);

    adapter.dispose();
    adapter.dispose();

    expect(host.removeLayer).toHaveBeenCalledTimes(2);
    expect(adapter.disposed).toBe(true);
    expect(() => adapter.project(request())).toThrowError(expect.objectContaining({ code: "disposed" }));
  });

  it("does not allow an existing projection to mount after adapter disposal", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const projection = adapter.project(request());
    const host = { addLayer: vi.fn(), removeLayer: vi.fn() };

    adapter.dispose();

    expect(() => projection.mount(host)).toThrowError(expect.objectContaining({ code: "disposed" }));
    expect(host.addLayer).not.toHaveBeenCalled();
  });

  it("publishes typed GPU-layer evidence after validating the optional peer result", () => {
    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project(request(3));

    expect(projection.gpuContract).toEqual({
      contractVersion: "1.0",
      layer: "scatterplot",
      peer: "ScatterplotLayer",
      execution: "gpu-binary",
      fallback: "none",
      layerId: "incidents",
      featureCount: 3,
      vertexCount: 3,
      attributes: 2,
      copiedBytes: 0,
    });
    expect(Object.isFrozen(projection.gpuContract)).toBe(true);
  });

  it("fails closed when an optional peer does not return the requested layer identity", () => {
    class InvalidLayer {
      public readonly id = "different-layer";
    }

    expect(() => createDeckGlAdapter({ peers: { ScatterplotLayer: InvalidLayer } }).project(request(1))).toThrowError(
      expect.objectContaining({ code: "invalid-layer" }),
    );
  });

  it("retains failed removals for retry while disposing every other mount", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    let removalAttempts = 0;
    const first = {
      addLayer: vi.fn(),
      removeLayer: vi.fn(() => {
        removalAttempts += 1;
        if (removalAttempts === 1) throw new Error("host gone");
      }),
    };
    const second = { addLayer: vi.fn(), removeLayer: vi.fn() };
    adapter.project(request()).mount(first);
    adapter.project({ ...request(), layerId: "second" }).mount(second);

    expect(() => adapter.dispose()).toThrowError(
      expect.objectContaining({ code: "dispose-failed", detail: { failures: 1, remainingMounts: 1 } }),
    );
    expect(first.removeLayer).toHaveBeenCalledOnce();
    expect(second.removeLayer).toHaveBeenCalledOnce();
    expect(adapter.disposed).toBe(true);

    expect(() => adapter.dispose()).not.toThrow();
    expect(first.removeLayer).toHaveBeenCalledTimes(2);
    expect(second.removeLayer).toHaveBeenCalledOnce();
  });

  it("keeps a manually failed removal retryable", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const removeLayer = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transient");
      })
      .mockImplementationOnce(() => undefined);
    const mounted = adapter.project(request()).mount({ addLayer: vi.fn(), removeLayer });

    expect(() => mounted.dispose()).toThrowError(expect.objectContaining({ code: "dispose-failed" }));
    expect(mounted.disposed).toBe(false);
    expect(() => mounted.dispose()).not.toThrow();
    expect(mounted.disposed).toBe(true);
    expect(removeLayer).toHaveBeenCalledTimes(2);
  });

  it("rolls back a provisional mount when its host synchronously disposes the adapter", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const removeLayer = vi.fn();
    const addLayer = vi.fn(() => adapter.dispose());
    const projection = adapter.project(request());

    expect(() => projection.mount({ addLayer, removeLayer })).toThrowError(
      expect.objectContaining({ code: "disposed" }),
    );
    expect(addLayer).toHaveBeenCalledOnce();
    expect(removeLayer).toHaveBeenCalledOnce();
    expect(adapter.disposed).toBe(true);
  });

  it("rejects rows, attributes, and unique backing bytes beyond configured limits", () => {
    const peers = { ScatterplotLayer: FakeScatterplotLayer };
    expect(() => createDeckGlAdapter({ peers, limits: { maxRows: 1 } }).project(request())).toThrowError(
      expect.objectContaining({ code: "limit-exceeded" }),
    );
    expect(() => createDeckGlAdapter({ peers, limits: { maxAttributes: 1 } }).project(request())).toThrowError(
      expect.objectContaining({ code: "limit-exceeded" }),
    );
    expect(() => createDeckGlAdapter({ peers, limits: { maxBackingBytes: 8 } }).project(request())).toThrowError(
      expect.objectContaining({ code: "limit-exceeded" }),
    );
  });

  it("rejects malformed binary layouts before constructing a peer layer", () => {
    const layerConstructor = vi.fn();
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: layerConstructor } });
    const input = request();

    expect(() =>
      adapter.project({
        ...input,
        data: { length: 3, attributes: { getPosition: { value: new Float32Array(4), size: 2 } } },
        identity: { ...input.identity, featureIds: new Uint32Array(3) },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
    expect(layerConstructor).not.toHaveBeenCalled();
  });

  it("captures every foreign descriptor getter once before peer construction", () => {
    const calls = new Map<string, number>();
    const once = <T>(name: string, value: T) => ({
      enumerable: true,
      get() {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return value;
      },
    });
    const positions = new Float32Array(4);
    const attribute = Object.defineProperties(
      {},
      {
        value: once("attribute.value", positions),
        size: once("attribute.size", 2),
        offset: once("attribute.offset", undefined),
        stride: once("attribute.stride", undefined),
        normalized: once("attribute.normalized", false),
      },
    );
    const attributes = Object.defineProperty({}, "getPosition", once("attributes.getPosition", attribute));
    const data = Object.defineProperties(
      {},
      {
        length: once("data.length", 2),
        attributes: once("data.attributes", attributes),
      },
    );
    const ids = Object.defineProperties(
      {},
      {
        length: once("ids.length", 2),
        0: once("ids.0", "a"),
        1: once("ids.1", "b"),
      },
    );
    const identity = Object.defineProperties(
      {},
      {
        sourceId: once("identity.sourceId", "source"),
        planId: once("identity.planId", "plan"),
        sourceVersion: once("identity.sourceVersion", "v1"),
        featureIds: once("identity.featureIds", ids),
      },
    );
    const props = Object.defineProperty({}, "radiusUnits", once("props.radiusUnits", "meters"));
    const foreign = Object.defineProperties(
      {},
      {
        layer: once("request.layer", "scatterplot"),
        layerId: once("request.layerId", "layer"),
        data: once("request.data", data),
        identity: once("request.identity", identity),
        props: once("request.props", props),
      },
    ) as DeckGlProjectionRequest;

    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project(foreign);

    expect(projection.selectionForPick(1).featureId).toBe("b");
    expect(calls.size).toBe(21);
    expect([...calls.values()]).not.toContain(2);
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
  });

  it("bounds attribute keys before reading any attribute value", () => {
    let valueReads = 0;
    const attributes: Record<string, unknown> = {};
    for (let index = 0; index < 3; index += 1) {
      Object.defineProperty(attributes, `get${index}`, {
        enumerable: true,
        get() {
          valueReads += 1;
          return { value: new Float32Array(2), size: 1 };
        },
      });
    }
    const input = request(1);

    expect(() =>
      createDeckGlAdapter({
        peers: { ScatterplotLayer: FakeScatterplotLayer },
        limits: { maxAttributes: 2 },
      }).project({ ...input, data: { length: 1, attributes } } as DeckGlProjectionRequest),
    ).toThrowError(expect.objectContaining({ code: "limit-exceeded" }));
    expect(valueReads).toBe(0);
  });

  it("wraps hostile getters and proxy enumeration in typed diagnostics", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const getterCause = new Error("getter failed");
    const getterRequest = Object.defineProperty({}, "layer", {
      get() {
        throw getterCause;
      },
    }) as DeckGlProjectionRequest;
    expect(() => adapter.project(getterRequest)).toThrowError(
      expect.objectContaining({ code: "invalid-data", cause: getterCause }),
    );

    const proxyCause = new Error("ownKeys failed");
    const input = request();
    const attributes = new Proxy(input.data.attributes, {
      ownKeys() {
        throw proxyCause;
      },
    });
    expect(() => adapter.project({ ...input, data: { ...input.data, attributes } })).toThrowError(
      expect.objectContaining({ code: "invalid-data", cause: proxyCause }),
    );
  });

  it("uses intrinsic typed-array metadata when a subclass falsifies public getters", () => {
    class MisleadingFloat32Array extends Float32Array {
      public get byteLength(): number {
        return 1;
      }

      public get buffer(): ArrayBuffer {
        return new ArrayBuffer(1);
      }

      public get BYTES_PER_ELEMENT(): number {
        return 1;
      }
    }
    const positions = new MisleadingFloat32Array(4);
    const input = request();
    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project({
      ...input,
      data: { length: 2, attributes: { getPosition: { value: positions, size: 2 } } },
    });

    expect(projection.metrics).toMatchObject({ logicalViewBytes: 16, uniqueBackingBytes: 16 });
  });

  it("cannot be made to swap attribute arrays through a foreign proxy", () => {
    const first = new Float32Array(4);
    const second = new Float32Array(20);
    let reads = 0;
    const attributes = new Proxy(
      { getPosition: { value: first, size: 2 as const } },
      {
        get(target, property, receiver) {
          if (property !== "getPosition") return Reflect.get(target, property, receiver);
          reads += 1;
          return reads === 1 ? target.getPosition : { value: second, size: 2 as const };
        },
      },
    );
    const input = request();
    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project({
      ...input,
      data: { length: 2, attributes },
    });
    const layer = projection.layer as FakeScatterplotLayer;
    const projected = layer.props.data as DeckGlProjectionRequest["data"];

    expect(reads).toBe(1);
    expect(projected.attributes.getPosition.value).toBe(first);
    expect(projection.metrics.uniqueBackingBytes).toBe(16);
  });

  it("captures row and selection identity independently of caller mutation", () => {
    const input = request();
    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project(input);
    const mutableIdentity = input.identity as {
      sourceId: string;
      planId: string;
      sourceVersion?: string;
      featureIds: Uint32Array;
    };
    const mutableData = input.data as { length: number };
    mutableIdentity.sourceId = "mutated-source";
    mutableIdentity.planId = "mutated-plan";
    mutableIdentity.sourceVersion = "mutated-version";
    mutableIdentity.featureIds[1] = 999;
    mutableData.length = 100;

    expect(projection.selectionForPick(1)).toEqual({
      sourceId: "incidents-live",
      planId: "plan:sha256:123",
      sourceVersion: "42",
      featureId: 101,
      rowIndex: 1,
    });
    expect(() => projection.selectionForPick(2)).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("rejects unaligned offsets and strides plus non-boolean normalization", () => {
    const input = request(1);
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const invalid = (attribute: Record<string, unknown>) => ({
      ...input,
      data: {
        length: 1,
        attributes: { getPosition: { value: new Float32Array(4), size: 2, ...attribute } },
      },
      identity: { ...input.identity, featureIds: new Uint32Array([1]) },
    });

    expect(() => adapter.project(invalid({ offset: 2 }) as DeckGlProjectionRequest)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
    expect(() => adapter.project(invalid({ stride: 6 }) as DeckGlProjectionRequest)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
    expect(() => adapter.project(invalid({ normalized: "yes" }) as DeckGlProjectionRequest)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
    expect(() =>
      adapter.project(invalid({ offset: 4, stride: 8, normalized: true }) as DeckGlProjectionRequest),
    ).not.toThrow();
  });

  it("reserves peer-owned layer props", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });

    expect(() => adapter.project({ ...request(), props: { data: [] } })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("publishes explicit supported and unsupported capability mappings", () => {
    expect(DECK_GL_CAPABILITIES.find(({ layer }) => layer === "scatterplot")).toMatchObject({
      supported: true,
      execution: "gpu-binary",
    });
    expect(DECK_GL_CAPABILITIES.find(({ layer }) => layer === "feature-path")).toMatchObject({
      supported: true,
      execution: "gpu-binary",
    });
    expect(DECK_GL_CAPABILITIES.find(({ layer }) => layer === "feature-polygon")).toMatchObject({
      supported: true,
      execution: "gpu-binary",
    });
    expect(DECK_GL_CAPABILITIES.find(({ layer }) => layer === "trips")).toMatchObject({
      supported: false,
      execution: "not-implemented",
    });
    expect(() =>
      createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } }).project({
        ...request(),
        layer: "trips",
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-layer" }));
  });

  it("loads the optional peer through an injectable module importer", async () => {
    const importModule = vi.fn(async () => ({ ScatterplotLayer: FakeScatterplotLayer }));

    await expect(loadDeckGlPeers({ importModule })).resolves.toEqual({ ScatterplotLayer: FakeScatterplotLayer });
    expect(importModule).toHaveBeenCalledWith("@deck.gl/layers");
  });

  it("creates an adapter lazily from the optional peer and forwards projection limits", async () => {
    const importModule = vi.fn(async () => ({ ScatterplotLayer: FakeScatterplotLayer }));

    const adapter = await loadDeckGlAdapter({ importModule, limits: { maxRows: 7 } });

    expect(importModule).toHaveBeenCalledOnce();
    expect(adapter.limits.maxRows).toBe(7);
    expect(adapter.capabilities).toBe(DECK_GL_CAPABILITIES);
    adapter.dispose();
  });

  it("reports an actionable typed error when the optional peer cannot load", async () => {
    const cause = new Error("not installed");
    const promise = loadDeckGlPeers({
      importModule: async () => {
        throw cause;
      },
    });

    await expect(promise).rejects.toBeInstanceOf(HonuaDeckGlAdapterError);
    await expect(promise).rejects.toMatchObject({
      code: "missing-peer",
      cause,
      detail: { package: "@deck.gl/layers" },
    });
  });

  it("loads PathLayer and SolidPolygonLayer from the module when present", async () => {
    class InjectedPathLayer implements DeckGlLayer {
      public readonly id: string | undefined;
      public constructor(public readonly props: Readonly<Record<string, unknown>>) {
        this.id = typeof props.id === "string" ? props.id : undefined;
      }
    }
    class InjectedSolidPolygonLayer implements DeckGlLayer {
      public readonly id: string | undefined;
      public constructor(public readonly props: Readonly<Record<string, unknown>>) {
        this.id = typeof props.id === "string" ? props.id : undefined;
      }
    }
    const importModule = vi.fn(async () => ({
      ScatterplotLayer: FakeScatterplotLayer,
      PathLayer: InjectedPathLayer,
      SolidPolygonLayer: InjectedSolidPolygonLayer,
    }));

    await expect(loadDeckGlPeers({ importModule })).resolves.toEqual({
      ScatterplotLayer: FakeScatterplotLayer,
      PathLayer: InjectedPathLayer,
      SolidPolygonLayer: InjectedSolidPolygonLayer,
    });
  });
});

class FakePathLayer implements DeckGlLayer {
  public readonly id: string | undefined;

  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
  }
}

class FakeSolidPolygonLayer implements DeckGlLayer {
  public readonly id: string | undefined;

  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
  }
}

function pathRequest(
  paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  featureIds?: readonly number[],
): DeckGlProjectionRequest {
  const flat = paths.flat();
  const position = new Float64Array(flat.length * 2);
  flat.forEach(([x, y], index) => {
    position[index * 2] = x;
    position[index * 2 + 1] = y;
  });
  const startIndices = new Uint32Array(paths.length + 1);
  let cursor = 0;
  paths.forEach((path, index) => {
    startIndices[index] = cursor;
    cursor += path.length;
  });
  startIndices[paths.length] = cursor;
  return {
    layer: "feature-path",
    layerId: "routes",
    data: {
      length: flat.length,
      attributes: { getPath: { value: position, size: 2 } },
      startIndices,
    },
    identity: {
      sourceId: "routes-live",
      planId: "plan:sha256:routes",
      featureIds: featureIds ?? new Uint32Array(Array.from({ length: paths.length }, (_, index) => index)),
    },
  };
}

function polygonRequest(
  rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  featureIds?: readonly number[],
): DeckGlProjectionRequest {
  const flat = rings.flat();
  const position = new Float64Array(flat.length * 2);
  flat.forEach(([x, y], index) => {
    position[index * 2] = x;
    position[index * 2 + 1] = y;
  });
  const startIndices = new Uint32Array(rings.length + 1);
  let cursor = 0;
  rings.forEach((ring, index) => {
    startIndices[index] = cursor;
    cursor += ring.length;
  });
  startIndices[rings.length] = cursor;
  return {
    layer: "feature-polygon",
    layerId: "parcels",
    data: {
      length: flat.length,
      attributes: { getPolygon: { value: position, size: 2 } },
      startIndices,
    },
    identity: {
      sourceId: "parcels-live",
      planId: "plan:sha256:parcels",
      featureIds: featureIds ?? new Uint32Array(Array.from({ length: rings.length }, (_, index) => index)),
    },
  };
}

describe("deck.gl adapter: feature-path (PathLayer)", () => {
  const square: readonly [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];
  const triangle: readonly [number, number][] = [
    [2, 2],
    [3, 2],
  ];

  it("projects a binary path request with zero-copy getPath and startIndices, forcing _pathType open", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer },
    });
    const input = pathRequest([square, triangle]);
    const projection = adapter.project(input);
    const layer = projection.layer as FakePathLayer;
    const data = layer.props.data as DeckGlProjectionRequest["data"];

    expect(data.attributes.getPath.value).toBe(input.data.attributes.getPath.value);
    // startIndices is bookkeeping (like identity.featureIds), snapshotted into a
    // plain frozen array rather than forwarded by typed-array reference.
    expect(data.startIndices).toEqual(Array.from(input.data.startIndices as ArrayLike<number>));
    expect(layer.props).toMatchObject({ id: "routes", pickable: true, _pathType: "open" });
    expect(projection.metrics).toMatchObject({ rows: 2, copiedBytes: 0 });
    expect(projection.selectionForPick(1)).toEqual({
      sourceId: "routes-live",
      planId: "plan:sha256:routes",
      featureId: 1,
      rowIndex: 1,
    });
    expect(() => projection.selectionForPick(2)).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("requires PathLayer to be supplied to project a feature-path request", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    expect(() => adapter.project(pathRequest([square]))).toThrowError(
      expect.objectContaining({ code: "missing-peer", detail: expect.objectContaining({ peer: "PathLayer" }) }),
    );
  });

  it("requires data.startIndices for feature-path and rejects it for scatterplot", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer },
    });
    const input = pathRequest([square]);
    const { startIndices, ...dataWithoutStartIndices } = input.data as DeckGlProjectionRequest["data"] & {
      startIndices: unknown;
    };
    expect(() => adapter.project({ ...input, data: dataWithoutStartIndices })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );

    expect(() => adapter.project({ ...request(), data: { ...request().data, startIndices: [0, 1] } })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("rejects malformed startIndices (non-zero start, decreasing, or wrong end)", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer },
    });
    const input = pathRequest([square, triangle]);

    for (const bad of [new Uint32Array([1, 3, 5]), new Uint32Array([0, 3, 2]), new Uint32Array([0, 3, 99])]) {
      expect(() => adapter.project({ ...input, data: { ...input.data, startIndices: bad } })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }
  });

  it("requires identity.featureIds length to equal the path count, not the vertex count", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer },
    });
    const input = pathRequest([square, triangle]);
    expect(() =>
      adapter.project({ ...input, identity: { ...input.identity, featureIds: new Uint32Array(5) } }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("requires a getPath binary attribute", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer },
    });
    const input = pathRequest([square]);
    expect(() =>
      adapter.project({
        ...input,
        data: { length: input.data.length, attributes: {}, startIndices: input.data.startIndices },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("rejects a caller-supplied _pathType prop as reserved", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, PathLayer: FakePathLayer },
    });
    const input = pathRequest([square]);
    expect(() => adapter.project({ ...input, props: { _pathType: "loop" } })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});

describe("deck.gl adapter: feature-polygon (SolidPolygonLayer)", () => {
  const ring: readonly [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 0],
  ];

  it("projects a binary polygon request with zero-copy getPolygon and startIndices, forcing _normalize false", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, SolidPolygonLayer: FakeSolidPolygonLayer },
    });
    const input = polygonRequest([ring]);
    const projection = adapter.project(input);
    const layer = projection.layer as FakeSolidPolygonLayer;
    const data = layer.props.data as DeckGlProjectionRequest["data"];

    expect(data.attributes.getPolygon.value).toBe(input.data.attributes.getPolygon.value);
    // startIndices is bookkeeping (like identity.featureIds), snapshotted into a
    // plain frozen array rather than forwarded by typed-array reference.
    expect(data.startIndices).toEqual(Array.from(input.data.startIndices as ArrayLike<number>));
    expect(layer.props).toMatchObject({ id: "parcels", pickable: true, _normalize: false });
    expect(projection.metrics).toMatchObject({ rows: 1, copiedBytes: 0 });
  });

  it("requires SolidPolygonLayer to be supplied to project a feature-polygon request", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    expect(() => adapter.project(polygonRequest([ring]))).toThrowError(
      expect.objectContaining({
        code: "missing-peer",
        detail: expect.objectContaining({ peer: "SolidPolygonLayer" }),
      }),
    );
  });

  it("rejects a caller-supplied _normalize prop as reserved", () => {
    const adapter = createDeckGlAdapter({
      peers: { ScatterplotLayer: FakeScatterplotLayer, SolidPolygonLayer: FakeSolidPolygonLayer },
    });
    const input = polygonRequest([ring]);
    expect(() => adapter.project({ ...input, props: { _normalize: true } })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});
