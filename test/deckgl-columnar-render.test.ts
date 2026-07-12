import { describe, expect, it, vi } from "vitest";

import { createColumnarBatch } from "../src/columnar/transfer.js";
import type { ColumnarBatchV1, CreateColumnarBatchInput } from "../src/columnar/types.js";
import {
  type DeckGlLayer,
  HonuaDeckGlAdapterError,
  bindColumnarBatchToDeckGl,
  createDeckGlAdapter,
} from "../src/deckgl/index.js";

/** Captures the binary `data` deck.gl would receive; renders nothing. */
class CapturingLayer implements DeckGlLayer {
  public readonly id: string | undefined;
  public readonly data: {
    readonly length: number;
    readonly attributes: Readonly<Record<string, { readonly value: ArrayBufferView }>>;
  };
  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
    this.data = props.data as CapturingLayer["data"];
  }
}

interface PointBatchArrays {
  readonly position: Float32Array;
  readonly radius: Float32Array;
  readonly fillColor: Uint8Array;
  readonly id: Uint32Array;
}

function pointBatch(rows: number): { batch: ColumnarBatchV1; arrays: PointBatchArrays } {
  const position = new Float32Array(rows * 2);
  const radius = new Float32Array(rows);
  const fillColor = new Uint8Array(rows * 4);
  const id = new Uint32Array(rows);
  for (let i = 0; i < rows; i += 1) {
    position[i * 2] = -122 + i * 0.01;
    position[i * 2 + 1] = 37 + i * 0.01;
    radius[i] = 5 + i;
    fillColor.set([i & 0xff, 0x80, 0x40, 0xff], i * 4);
    id[i] = 1000 + i;
  }
  const input: CreateColumnarBatchInput = {
    id: "incidents-batch",
    schema: {
      id: "incidents-schema@1",
      fields: [
        { name: "position", type: { name: "geoarrow.point", parameters: { crs: "EPSG:4326" } }, nullable: false },
        { name: "radius", type: { name: "float32" }, nullable: false },
        { name: "fill_color", type: { name: "fixed_size_list", parameters: { size: 4 } }, nullable: false },
        { name: "id", type: { name: "uint32" }, nullable: false },
      ],
    },
    rowCount: rows,
    sequence: 0,
    buffers: [
      {
        id: "b:pos",
        role: "geometry",
        field: "position",
        data: position.buffer,
        byteOffset: 0,
        byteLength: position.byteLength,
      },
      {
        id: "b:rad",
        role: "values",
        field: "radius",
        data: radius.buffer,
        byteOffset: 0,
        byteLength: radius.byteLength,
      },
      {
        id: "b:fill",
        role: "values",
        field: "fill_color",
        data: fillColor.buffer,
        byteOffset: 0,
        byteLength: fillColor.byteLength,
      },
      { id: "b:id", role: "values", field: "id", data: id.buffer, byteOffset: 0, byteLength: id.byteLength },
    ],
  };
  return { batch: createColumnarBatch(input), arrays: { position, radius, fillColor, id } };
}

describe("deck.gl columnar renderer binding (no GeoJSON conversion)", () => {
  it("forwards columnar buffers as GPU-binary attributes that alias the batch backing memory", () => {
    const { batch, arrays } = pointBatch(4);
    // Guard: batch payload is only raw ArrayBuffers — never GeoJSON features.
    for (const buffer of batch.buffers) expect(buffer.data).toBeInstanceOf(ArrayBuffer);

    const request = bindColumnarBatchToDeckGl({
      batch,
      layerId: "incidents",
      attributes: [
        { accessor: "getPosition", bufferId: "b:pos", component: "float32", size: 2 },
        { accessor: "getRadius", bufferId: "b:rad", component: "float32", size: 1 },
        { accessor: "getFillColor", bufferId: "b:fill", component: "uint8", size: 4, normalized: true },
      ],
      identity: {
        sourceId: "incidents-live",
        planId: "plan:sha256:abc",
        sourceVersion: "7",
        featureIdColumn: { bufferId: "b:id", component: "uint32" },
      },
      props: { radiusUnits: "meters" },
    });

    // The bound attribute values must be the SAME typed-array memory as the
    // batch buffers: no per-feature object, no GeoJSON coordinate array.
    expect(request.data.attributes.getPosition.value.buffer).toBe(arrays.position.buffer);
    expect(request.data.attributes.getRadius.value.buffer).toBe(arrays.radius.buffer);
    expect(request.data.attributes.getFillColor.value.buffer).toBe(arrays.fillColor.buffer);
    expect(request.data.attributes.getFillColor.normalized).toBe(true);
    expect(request.data.length).toBe(4);

    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: CapturingLayer } });
    const projection = adapter.project(request);
    const layer = projection.layer as CapturingLayer;

    // deck.gl receives the batch's own ArrayBuffers — proven by identity, and
    // corroborated by copiedBytes === 0.
    expect(layer.data.attributes.getPosition.value.buffer).toBe(batch.buffers[0]!.data);
    expect(layer.data.attributes.getRadius.value.buffer).toBe(batch.buffers[1]!.data);
    expect(layer.data.attributes.getFillColor.value.buffer).toBe(batch.buffers[2]!.data);
    expect(projection.metrics.copiedBytes).toBe(0);
    expect(projection.metrics.rows).toBe(4);
    expect(projection.diagnostic).toMatchObject({ strategy: "gpu-binary", fallback: "none" });
  });

  it("proves no GeoJSON round-trip: JSON serialization is never invoked during binding + projection", () => {
    const { batch } = pointBatch(3);
    const jsonSpy = vi.spyOn(JSON, "stringify");
    const parseSpy = vi.spyOn(JSON, "parse");

    const request = bindColumnarBatchToDeckGl({
      batch,
      layerId: "incidents",
      attributes: [{ accessor: "getPosition", bufferId: "b:pos", component: "float32", size: 2 }],
      identity: { sourceId: "s", planId: "p" },
    });
    createDeckGlAdapter({ peers: { ScatterplotLayer: CapturingLayer } }).project(request);

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();
    jsonSpy.mockRestore();
    parseSpy.mockRestore();
  });

  it("resolves picking identity from the id column with zero copies", () => {
    const { batch, arrays } = pointBatch(3);
    const request = bindColumnarBatchToDeckGl({
      batch,
      layerId: "incidents",
      attributes: [{ accessor: "getPosition", bufferId: "b:pos", component: "float32", size: 2 }],
      identity: {
        sourceId: "incidents-live",
        planId: "plan:1",
        featureIdColumn: { bufferId: "b:id", component: "uint32" },
      },
    });
    expect((request.identity.featureIds as Uint32Array).buffer).toBe(arrays.id.buffer);

    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: CapturingLayer } }).project(request);
    expect(projection.selectionForPick(2)).toEqual({
      sourceId: "incidents-live",
      planId: "plan:1",
      featureId: 1002,
      rowIndex: 2,
    });
  });

  it("defaults picking identity to lazy sequential row indices", () => {
    const { batch } = pointBatch(5);
    const request = bindColumnarBatchToDeckGl({
      batch,
      layerId: "incidents",
      attributes: [{ accessor: "getPosition", bufferId: "b:pos", component: "float32", size: 2 }],
      identity: { sourceId: "s", planId: "p" },
    });
    expect(request.identity.featureIds.length).toBe(5);
    expect(request.identity.featureIds[3]).toBe(3);

    const projection = createDeckGlAdapter({ peers: { ScatterplotLayer: CapturingLayer } }).project(request);
    expect(projection.selectionForPick(4)).toMatchObject({ featureId: 4, rowIndex: 4 });
  });

  it("rejects an unknown buffer id", () => {
    const { batch } = pointBatch(2);
    expect(() =>
      bindColumnarBatchToDeckGl({
        batch,
        layerId: "incidents",
        attributes: [{ accessor: "getPosition", bufferId: "missing", component: "float32", size: 2 }],
        identity: { sourceId: "s", planId: "p" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });

  it("rejects a non-columnar batch", () => {
    expect(() =>
      bindColumnarBatchToDeckGl({
        batch: { kind: "not-a-batch" } as unknown as ColumnarBatchV1,
        layerId: "incidents",
        attributes: [{ accessor: "getPosition", bufferId: "b:pos", component: "float32", size: 2 }],
        identity: { sourceId: "s", planId: "p" },
      }),
    ).toThrowError(HonuaDeckGlAdapterError);
  });

  it("rejects a component-misaligned buffer view", () => {
    const backing = new ArrayBuffer(20);
    const input: CreateColumnarBatchInput = {
      id: "misaligned",
      schema: { id: "s@1", fields: [{ name: "position", type: { name: "geoarrow.point" }, nullable: false }] },
      rowCount: 2,
      sequence: 0,
      // Float32 view starting at byte offset 2 is not 4-byte aligned.
      buffers: [{ id: "b:pos", role: "geometry", field: "position", data: backing, byteOffset: 2, byteLength: 16 }],
    };
    const batch = createColumnarBatch(input);
    expect(() =>
      bindColumnarBatchToDeckGl({
        batch,
        layerId: "incidents",
        attributes: [{ accessor: "getPosition", bufferId: "b:pos", component: "float32", size: 2 }],
        identity: { sourceId: "s", planId: "p" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });
});
