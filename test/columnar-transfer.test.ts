import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  COLUMNAR_BATCH_KIND,
  COLUMNAR_BATCH_VERSION,
  COLUMNAR_TRANSFER_KIND,
  type ColumnarSchemaV1,
  type ColumnarTransferMessageV1,
  type CreateColumnarBatchInput,
  DEFAULT_COLUMNAR_BATCH_MAX_ROWS,
  type HonuaColumnarTransferError,
  createColumnarBatch,
  inspectColumnarBatch,
  leaseColumnarBatch,
} from "../src/columnar/index.js";

function schema(): ColumnarSchemaV1 {
  return {
    id: "places-v1",
    fields: [
      { name: "id", type: { name: "int32" }, nullable: false },
      {
        name: "geometry",
        type: { name: "geoarrow.point", parameters: { dimensions: 2 } },
        nullable: true,
        metadata: { "ARROW:extension:name": "geoarrow.point" },
      },
    ],
    metadata: { crs: "EPSG:4326" },
  };
}

function input(data = new ArrayBuffer(32)): CreateColumnarBatchInput {
  return {
    id: "batch-0",
    schema: schema(),
    rowCount: 4,
    sequence: 0,
    rowOffset: 0,
    buffers: [
      { id: "ids", field: "id", role: "values", data, byteOffset: 0, byteLength: 16 },
      { id: "xy", field: "geometry", role: "geometry", data, byteOffset: 16, byteLength: 16 },
    ],
  };
}

function expectCode(action: () => unknown, code: HonuaColumnarTransferError["code"]): void {
  expect(action).toThrowError(expect.objectContaining({ name: "HonuaColumnarTransferError", code }));
}

describe("columnar batch contract", () => {
  it("normalizes immutable schema metadata without copying payload buffers", () => {
    const original = input();
    const batch = createColumnarBatch(original);

    expect(batch).toMatchObject({
      kind: COLUMNAR_BATCH_KIND,
      version: COLUMNAR_BATCH_VERSION,
      id: "batch-0",
      rowCount: 4,
    });
    expect(batch.buffers[0]?.data).toBe(original.buffers[0]?.data);
    expect(batch.schema).not.toBe(original.schema);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.schema.fields)).toBe(true);
    expect(Object.isFrozen(batch.schema.fields[1]?.metadata)).toBe(true);

    (original.schema.metadata as Record<string, string>).crs = "EPSG:3857";
    expect(batch.schema.metadata?.crs).toBe("EPSG:4326");
  });

  it("reports logical views and unique backing allocation bytes exactly", () => {
    const batch = createColumnarBatch(input());
    expect(inspectColumnarBatch(batch)).toEqual({
      rows: 4,
      logicalBytes: 32,
      backingBytes: 32,
      transferBytes: 32,
      copiedBytes: 0,
      bufferViews: 2,
      backingBuffers: 1,
    });
  });

  it("counts the complete backing allocation when only a small slice is referenced", () => {
    const largeBacking = new ArrayBuffer(1024);
    const value: CreateColumnarBatchInput = {
      ...input(largeBacking),
      buffers: [{ id: "slice", role: "values", data: largeBacking, byteOffset: 0, byteLength: 8 }],
    };

    expectCode(() => createColumnarBatch(value, { maxBackingBytes: 512 }), "memory-limit-exceeded");
  });

  it("enforces the default and caller row ceilings", () => {
    expectCode(
      () => createColumnarBatch({ ...input(), rowCount: DEFAULT_COLUMNAR_BATCH_MAX_ROWS + 1 }),
      "row-limit-exceeded",
    );
    expectCode(() => createColumnarBatch(input(), { maxRows: 3 }), "row-limit-exceeded");
  });

  it("rejects malformed descriptors before transport", () => {
    expectCode(
      () =>
        createColumnarBatch({
          ...input(),
          buffers: [
            { id: "same", role: "values", data: new ArrayBuffer(4), byteOffset: 0, byteLength: 4 },
            { id: "same", role: "validity", data: new ArrayBuffer(1), byteOffset: 0, byteLength: 1 },
          ],
        }),
      "invalid-batch",
    );
    expectCode(
      () =>
        createColumnarBatch({
          ...input(),
          buffers: [{ id: "bad", role: "values", data: new ArrayBuffer(4), byteOffset: 2, byteLength: 4 }],
        }),
      "invalid-batch",
    );
    expectCode(() => createColumnarBatch({ ...input(), rowCount: Number.NaN }), "invalid-batch");
    expectCode(() => createColumnarBatch({ ...input(), id: " batch-0 " }), "invalid-batch");
    const detached = new ArrayBuffer(4);
    structuredClone(null, { transfer: [detached] });
    expectCode(
      () =>
        createColumnarBatch({
          ...input(),
          buffers: [{ id: "detached", role: "values", data: detached, byteOffset: 0, byteLength: 0 }],
        }),
      "invalid-batch",
    );
    expectCode(
      () =>
        createColumnarBatch({
          ...input(),
          buffers: [
            {
              id: "unknown-field",
              field: "missing",
              role: "values",
              data: new ArrayBuffer(4),
              byteOffset: 0,
              byteLength: 4,
            },
          ],
        }),
      "invalid-batch",
    );
    expectCode(
      () => createColumnarBatch({ ...input(), rowOffset: Number.MAX_SAFE_INTEGER, rowCount: 1 }),
      "invalid-batch",
    );
    expectCode(
      () =>
        createColumnarBatch({
          ...input(),
          schema: {
            id: "duplicate-child-v1",
            fields: [
              {
                name: "parent",
                type: { name: "struct" },
                nullable: false,
                children: [
                  { name: "value", type: { name: "int32" }, nullable: false },
                  { name: "value", type: { name: "int32" }, nullable: true },
                ],
              },
            ],
          },
          buffers: [],
        }),
      "invalid-batch",
    );
  });

  it("validates foreign batch-shaped objects instead of trusting TypeScript casts", () => {
    const valid = createColumnarBatch(input());
    expectCode(() => inspectColumnarBatch({ ...valid, rowCount: -1 }), "invalid-batch");
    expectCode(() => inspectColumnarBatch({ ...valid, sequence: Number.NaN }), "invalid-batch");
    expectCode(
      () =>
        inspectColumnarBatch({
          ...valid,
          schema: { ...valid.schema, fields: [valid.schema.fields[0]!, valid.schema.fields[0]!] },
        }),
      "invalid-batch",
    );
    expectCode(
      () => inspectColumnarBatch({ ...valid, buffers: [valid.buffers[0]!, valid.buffers[0]!] }),
      "invalid-batch",
    );
    expectCode(
      () => inspectColumnarBatch({ ...valid, schema: { ...valid.schema, metadata: ["not", "a", "record"] } as never }),
      "invalid-batch",
    );
  });

  it("normalizes foreign getters exactly once and wraps getter failures", () => {
    const valid = createColumnarBatch(input());
    let rowReads = 0;
    let bufferReads = 0;
    const foreign = {
      ...valid,
      get rowCount() {
        rowReads += 1;
        return rowReads === 1 ? 4 : Number.NaN;
      },
      get buffers() {
        bufferReads += 1;
        return bufferReads === 1 ? valid.buffers : ([] as never);
      },
    };

    expect(inspectColumnarBatch(foreign)).toMatchObject({ rows: 4, backingBytes: 32 });
    expect(rowReads).toBe(1);
    expect(bufferReads).toBe(1);

    const throwing = Object.create(valid, {
      schema: {
        get() {
          throw new Error("untrusted getter");
        },
      },
    }) as typeof valid;
    expectCode(() => inspectColumnarBatch(throwing), "invalid-batch");
  });

  it("allows an empty bounded batch", () => {
    const empty = new ArrayBuffer(0);
    const batch = createColumnarBatch({
      ...input(),
      rowCount: 0,
      buffers: [{ id: "empty-values", role: "values", data: empty, byteOffset: 0, byteLength: 0 }],
    });
    expect(inspectColumnarBatch(batch)).toMatchObject({
      rows: 0,
      logicalBytes: 0,
      backingBytes: 0,
      copiedBytes: 0,
      backingBuffers: 1,
    });
  });
});

describe("columnar ownership transfer", () => {
  it("round-trips the envelope and payload through a real MessagePort transfer", async () => {
    const data = new ArrayBuffer(32);
    new Uint8Array(data).set([9, 8, 7, 6]);
    const batch = createColumnarBatch(input(data));
    const lease = leaseColumnarBatch(batch);
    const { port1, port2 } = new MessageChannel();
    const received = new Promise<ColumnarTransferMessageV1>((resolve) => port2.once("message", resolve));

    try {
      await lease.transfer((message, transfer) => port1.postMessage(message, [...transfer]));
      expect(data.byteLength).toBe(0);
      const message = await received;
      expect(message).toMatchObject({ kind: COLUMNAR_TRANSFER_KIND, metrics: { copiedBytes: 0 } });
      expect(Array.from(new Uint8Array(message.batch.buffers[0]!.data).slice(0, 4))).toEqual([9, 8, 7, 6]);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("snapshots foreign descriptors while retaining the exact payload buffers", async () => {
    const data = new ArrayBuffer(32);
    const foreignSchema = schema();
    const foreignBuffers = [...input(data).buffers];
    const foreign = {
      ...createColumnarBatch(input(data)),
      schema: foreignSchema,
      buffers: foreignBuffers,
    };
    const lease = leaseColumnarBatch(foreign);
    (foreignSchema.metadata as Record<string, string>).crs = "EPSG:3857";
    foreignBuffers.length = 0;

    await lease.transfer((message, transfer) => {
      expect(message.batch.schema.metadata?.crs).toBe("EPSG:4326");
      expect(message.batch.buffers).toHaveLength(2);
      expect(message.batch.buffers[0]?.data).not.toBe(data);
      expect(message.batch.buffers[0]?.data.byteLength).toBe(32);
      expect(transfer).toEqual([message.batch.buffers[0]?.data]);
    });
  });

  it("hands structured clone the exact backing allocation with zero payload copies", async () => {
    const data = new ArrayBuffer(32);
    new Uint8Array(data).set([1, 2, 3, 4]);
    const batch = createColumnarBatch(input(data));
    const lease = leaseColumnarBatch(batch);
    let received: ColumnarTransferMessageV1 | undefined;
    let transferCount = -1;

    const receipt = await lease.transfer((message, transfer) => {
      transferCount = transfer.length;
      expect(transfer[0]).not.toBe(data);
      received = structuredClone(message, { transfer: [...transfer] });
    });

    expect(transferCount).toBe(1);
    expect(data.byteLength).toBe(0);
    expect(received?.kind).toBe(COLUMNAR_TRANSFER_KIND);
    expect(received?.metrics).toMatchObject({ backingBytes: 32, copiedBytes: 0, backingBuffers: 1 });
    expect(Array.from(new Uint8Array(received?.batch.buffers[0]?.data as ArrayBuffer).slice(0, 4))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(receipt).toMatchObject({ batchId: "batch-0", acknowledged: true, metrics: { copiedBytes: 0 } });
    expect(lease.state).toBe("transferred");
    expectCode(() => inspectColumnarBatch(batch), "invalid-batch");
  });

  it("honors cancellation before target invocation without relinquishing ownership", async () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    const controller = new AbortController();
    controller.abort();
    const target = vi.fn();

    await expect(lease.transfer(target, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(target).not.toHaveBeenCalled();
    expect(lease.state).toBe("owned");
    expect(lease.batch.id).toBe("batch-0");
  });

  it("retains explicit raised ceilings from lease creation through transfer", async () => {
    const batch = createColumnarBatch(
      { ...input(), rowCount: DEFAULT_COLUMNAR_BATCH_MAX_ROWS + 1 },
      {
        maxRows: DEFAULT_COLUMNAR_BATCH_MAX_ROWS + 1,
      },
    );
    const lease = leaseColumnarBatch(batch, { maxRows: DEFAULT_COLUMNAR_BATCH_MAX_ROWS + 1 });

    await expect(lease.transfer(() => undefined)).resolves.toMatchObject({
      acknowledged: true,
      metrics: { rows: DEFAULT_COLUMNAR_BATCH_MAX_ROWS + 1 },
    });
  });

  it("can tighten a lease ceiling at transfer time without relinquishing ownership", async () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    const target = vi.fn();

    await expect(lease.transfer(target, { maxRows: 3 })).rejects.toMatchObject({ code: "row-limit-exceeded" });
    expect(target).not.toHaveBeenCalled();
    expect(lease.state).toBe("owned");
    expect(lease.batch.id).toBe("batch-0");
  });

  it("awaits the consumer acknowledgement as an explicit backpressure boundary", async () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    let acknowledge: (() => void) | undefined;
    const pending = lease.transfer(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );

    await Promise.resolve();
    expect(lease.state).toBe("transferred");
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge?.();
    await expect(pending).resolves.toMatchObject({ acknowledged: true });
  });

  it("does not reclaim ownership when the consumer rejects the SDK-transferred batch", async () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    await expect(
      lease.transfer(() => {
        throw new Error("port closed");
      }),
    ).rejects.toMatchObject({ code: "transport-failed", cause: expect.any(Error) });
    expect(lease.state).toBe("transferred");
    expectCode(() => lease.batch, "already-transferred");
  });

  it("transfers legitimate empty buffers before a synchronous consumer failure", async () => {
    const empty = new ArrayBuffer(0);
    const lease = leaseColumnarBatch(
      createColumnarBatch({
        ...input(),
        rowCount: 0,
        buffers: [{ id: "empty", role: "values", data: empty, byteOffset: 0, byteLength: 0 }],
      }),
    );
    await expect(
      lease.transfer(() => {
        throw new Error("consumer rejected empty batch");
      }),
    ).rejects.toMatchObject({ code: "transport-failed", cause: expect.any(Error) });
    expect(lease.state).toBe("transferred");
    expect(() => new Uint8Array(empty, 0, 0)).toThrow(TypeError);
    expectCode(() => lease.batch, "already-transferred");
  });

  it("reserves shared backing buffers across live leases", () => {
    const data = new ArrayBuffer(32);
    const first = createColumnarBatch(input(data));
    const second = createColumnarBatch({ ...input(data), id: "batch-1", sequence: 1 });
    const lease = leaseColumnarBatch(first);

    expectCode(() => leaseColumnarBatch(first), "already-leased");
    expectCode(() => leaseColumnarBatch(second), "already-leased");

    lease.dispose();
    const replacement = leaseColumnarBatch(second);
    expect(replacement.state).toBe("owned");
    replacement.dispose();
  });

  it("reports acknowledgement failure after ownership is already transferred", async () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    await expect(lease.transfer(() => Promise.reject(new Error("consumer failed")))).rejects.toMatchObject({
      code: "transport-failed",
      cause: expect.any(Error),
    });
    expect(lease.state).toBe("transferred");
    expectCode(() => lease.batch, "already-transferred");
  });

  it("rejects a second transfer deterministically", async () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    await lease.transfer(() => undefined);
    await expect(lease.transfer(() => undefined)).rejects.toMatchObject({ code: "already-transferred" });
  });

  it("disposes owned references idempotently and rejects later access", () => {
    const lease = leaseColumnarBatch(createColumnarBatch(input()));
    lease.dispose();
    lease.dispose();
    expect(lease.state).toBe("disposed");
    expectCode(() => lease.batch, "disposed");
  });

  it("keeps million-row transfer setup proportional to buffers, not rows", () => {
    const values = new ArrayBuffer(8_000_000);
    const validity = new ArrayBuffer(125_000);
    const batch = createColumnarBatch({
      ...input(),
      rowCount: 1_000_000,
      buffers: [
        { id: "coordinates", role: "geometry", data: values, byteOffset: 0, byteLength: values.byteLength },
        { id: "validity", role: "validity", data: validity, byteOffset: 0, byteLength: validity.byteLength },
      ],
    });
    const metrics = inspectColumnarBatch(batch);
    expect(metrics).toEqual({
      rows: 1_000_000,
      logicalBytes: 8_125_000,
      backingBytes: 8_125_000,
      transferBytes: 8_125_000,
      copiedBytes: 0,
      bufferViews: 2,
      backingBuffers: 2,
    });
  });
});
