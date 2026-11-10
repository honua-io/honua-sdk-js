import { describe, expect, it, vi } from "vitest";
import { type DeckGlHexbinRequest, createDeckGlAdapter, projectDeckGlHexbins } from "../src/deckgl/index.js";

class Layer {
  readonly id: string;
  constructor(readonly props: Readonly<Record<string, unknown>>) {
    this.id = props.id as string;
  }
}

function adapter(limits = {}) {
  return createDeckGlAdapter({ peers: { ScatterplotLayer: Layer, SolidPolygonLayer: Layer }, limits });
}

function request(): DeckGlHexbinRequest {
  return {
    layerId: "requests",
    positions: new Float64Array([0, 0, 0.00001, 0.00001, 1, 1]),
    radiusMeters: 100,
    identity: { sourceId: "county", planId: "status=open", sourceVersion: "2026-11", featureIds: [71, "72", 73n] },
  };
}

describe("bounded deck.gl hexbins", () => {
  it("independently counts a known central cell and keeps every original selection", () => {
    const result = projectDeckGlHexbins(adapter(), request());
    expect(result).toMatchObject({ aggregation: "count", execution: "cpu-bounded", inputRows: 3 });
    expect(result.bins.map((bin) => bin.count)).toEqual([2, 1]);
    expect(result.bins[0].center[0]).toBeCloseTo(0);
    expect(result.bins[0].center[1]).toBeCloseTo(0);
    expect(result.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3);
    expect(result.selectionsForBin(0)).toEqual([
      { sourceId: "county", planId: "status=open", sourceVersion: "2026-11", featureId: 71, rowIndex: 0 },
      { sourceId: "county", planId: "status=open", sourceVersion: "2026-11", featureId: "72", rowIndex: 1 },
    ]);
    expect(result.selectionsForBin(1)[0].featureId).toBe(73n);
    expect(result.projection.selectionForPick(0).featureId).toBe(result.bins[0].id);
  });

  it("renders closed six-sided binary polygons and count-derived RGBA colors", () => {
    const result = projectDeckGlHexbins(adapter(), { ...request(), color: (count) => [count * 10, 80, 90, 255] });
    const layer = result.projection.layer as Layer;
    const data = layer.props.data as {
      startIndices: number[];
      attributes: Record<string, { value: Float64Array | Uint8Array }>;
    };
    expect(Array.from(data.startIndices)).toEqual([0, 7, 14]);
    expect(Array.from(data.attributes.getPolygon.value.slice(0, 2))).toEqual(
      Array.from(data.attributes.getPolygon.value.slice(12, 14)),
    );
    expect(Array.from(data.attributes.getFillColor.value.slice(0, 4))).toEqual([20, 80, 90, 255]);
    expect(result.projection.gpuContract).toMatchObject({
      peer: "SolidPolygonLayer",
      featureCount: 2,
      vertexCount: 14,
    });
  });

  it("recomputes filtered inputs and freezes identity independently of caller edits", () => {
    const input = request();
    const result = projectDeckGlHexbins(adapter(), input);
    (input.identity.featureIds as (number | string | bigint)[])[0] = 999;
    expect(result.selectionsForBin(0)[0].featureId).toBe(71);
    const filtered = projectDeckGlHexbins(adapter(), {
      ...input,
      positions: input.positions.slice(4),
      identity: { ...input.identity, planId: "status=closed", featureIds: [73n] },
    });
    expect(filtered.bins.map((bin) => bin.count)).toEqual([1]);
    expect(filtered.selectionsForBin(0)[0]).toMatchObject({ featureId: 73n, planId: "status=closed", rowIndex: 0 });
  });

  it("accepts empty results and rejects invalid picks", () => {
    const result = projectDeckGlHexbins(adapter(), {
      ...request(),
      positions: new Float64Array(),
      identity: { ...request().identity, featureIds: [] },
    });
    expect(result.bins).toEqual([]);
    expect(result.projection.gpuContract.featureCount).toBe(0);
    for (const index of [-1, 0, 0.5, Number.NaN])
      expect(() => result.selectionsForBin(index)).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("derives default limits from a smaller adapter budget", () => {
    const result = projectDeckGlHexbins(adapter({ maxRows: 14 }), request());
    expect(result.bins.map((bin) => bin.count)).toEqual([2, 1]);
  });

  it("rejects row, bin, vertex and byte budget overflows", () => {
    for (const limits of [{ maxRows: 2 }, { maxBins: 1 }]) {
      expect(() => projectDeckGlHexbins(adapter(), { ...request(), limits })).toThrowError(
        expect.objectContaining({ code: "limit-exceeded" }),
      );
    }
    expect(() =>
      projectDeckGlHexbins(adapter({ maxRows: 13 }), { ...request(), limits: { maxRows: 3, maxBins: 2 } }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
    expect(() => projectDeckGlHexbins(adapter({ maxBackingBytes: 100 }), request())).toThrowError(
      expect.objectContaining({ code: "limit-exceeded" }),
    );
  });

  it.each([Number.NaN, 0, -1, 1_000_001])("rejects invalid radius %s", (radiusMeters) => {
    expect(() => projectDeckGlHexbins(adapter(), { ...request(), radiusMeters })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("rejects malformed positions, identities, colors and Mercator coordinates", () => {
    for (const positions of [
      new Float64Array([0]),
      new Float64Array([181, 0]),
      new Float64Array([0, 90]),
      new Float64Array([Number.NaN, 0]),
    ]) {
      expect(() => projectDeckGlHexbins(adapter(), { ...request(), positions })).toThrow();
    }
    expect(() =>
      projectDeckGlHexbins(adapter(), { ...request(), identity: { ...request().identity, featureIds: [1] } }),
    ).toThrow();
    expect(() => projectDeckGlHexbins(adapter(), { ...request(), color: () => [256, 0, 0, 255] })).toThrow();
  });

  it("mounts, removes and cascades idempotent disposal through the existing adapter", () => {
    const renderer = adapter();
    const result = projectDeckGlHexbins(renderer, request());
    const host = { addLayer: vi.fn(), removeLayer: vi.fn() };
    const mounted = result.projection.mount(host);
    renderer.dispose();
    mounted.dispose();
    expect(host.addLayer).toHaveBeenCalledOnce();
    expect(host.removeLayer).toHaveBeenCalledOnce();
    expect(() => projectDeckGlHexbins(renderer, request())).toThrowError(expect.objectContaining({ code: "disposed" }));
  });
});
