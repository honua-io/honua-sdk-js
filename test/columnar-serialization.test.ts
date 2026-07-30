import { describe, expect, it } from "vitest";
import {
  COLUMNAR_SERIALIZATION_MAGIC,
  COLUMNAR_SERIALIZATION_VERSION,
  HonuaColumnarSerializationError,
  createColumnarBatch,
  deserializeColumnarBatch,
  serializeColumnarBatch,
} from "../src/query-planner/index.js";

function makeBatch() {
  const backing = new ArrayBuffer(16);
  new Uint32Array(backing).set([10, 20, 30, 40]);
  return createColumnarBatch({
    id: "batch-1",
    sequence: 3,
    rowOffset: 8,
    rowCount: 2,
    schema: {
      id: "schema-1",
      fields: [{ name: "value", type: { name: "uint32" }, nullable: false }],
      metadata: { crs: "OGC:CRS84" },
    },
    buffers: [
      { id: "value-a", role: "values", field: "value", data: backing, byteOffset: 0, byteLength: 8 },
      { id: "value-b", role: "values", field: "value", data: backing, byteOffset: 8, byteLength: 8 },
    ],
  });
}

describe("bounded columnar serialization", () => {
  it("round-trips a versioned batch and preserves shared backing views", () => {
    const serialized = serializeColumnarBatch(makeBatch());
    const bytes = new Uint8Array(serialized.bytes);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe(COLUMNAR_SERIALIZATION_MAGIC);
    expect(serialized.metrics.backingBuffers).toBe(1);

    const restored = deserializeColumnarBatch(serialized.bytes);
    expect(restored.batch).toMatchObject({ id: "batch-1", sequence: 3, rowOffset: 8, rowCount: 2 });
    expect(restored.metrics.backingBuffers).toBe(1);
    expect(restored.batch.buffers[0]!.data).toBe(restored.batch.buffers[1]!.data);
    expect(restored.batch.buffers.map(({ byteOffset, byteLength }) => [byteOffset, byteLength])).toEqual([
      [0, 8],
      [8, 8],
    ]);
  });

  it("rejects future versions and truncated payloads before allocation", () => {
    const serialized = serializeColumnarBatch(makeBatch());
    const future = serialized.bytes.slice(0);
    new Uint8Array(future).set(new TextEncoder().encode("HONUACB2"), 0);
    expect(() => deserializeColumnarBatch(future)).toThrowError(HonuaColumnarSerializationError);
    expect(() => deserializeColumnarBatch(serialized.bytes.slice(0, 11))).toThrowError(
      expect.objectContaining({ code: "invalid-batch" }),
    );
    expect(COLUMNAR_SERIALIZATION_VERSION).toBe("1.0");
  });

  it("enforces an explicit serialized byte ceiling", () => {
    expect(() => serializeColumnarBatch(makeBatch(), { maxSerializedBytes: 32 })).toThrowError(
      expect.objectContaining({ code: "size-limit-exceeded" }),
    );
  });
});
