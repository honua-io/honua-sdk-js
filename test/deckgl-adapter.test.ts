import { describe, expect, it, vi } from "vitest";

import {
  DECK_GL_CAPABILITIES,
  type DeckGlLayer,
  type DeckGlProjectionRequest,
  HonuaDeckGlAdapterError,
  createDeckGlAdapter,
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

  it("attempts to remove every owned layer when one host fails disposal", () => {
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: FakeScatterplotLayer } });
    const first = {
      addLayer: vi.fn(),
      removeLayer: vi.fn(() => {
        throw new Error("host gone");
      }),
    };
    const second = { addLayer: vi.fn(), removeLayer: vi.fn() };
    adapter.project(request()).mount(first);
    adapter.project({ ...request(), layerId: "second" }).mount(second);

    expect(() => adapter.dispose()).toThrow(AggregateError);
    expect(first.removeLayer).toHaveBeenCalledOnce();
    expect(second.removeLayer).toHaveBeenCalledOnce();
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
});
