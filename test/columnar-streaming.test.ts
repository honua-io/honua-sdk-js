import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  COLUMNAR_WORKER_PROTOCOL_VERSION,
  COLUMNAR_WORKER_REQUEST_KIND,
  COLUMNAR_WORKER_RESULT_KIND,
  type ColumnarBatchV1,
  type ColumnarWorkerExecutionProgress,
  type ColumnarWorkerFaultEvent,
  type ColumnarWorkerHost,
  type ColumnarWorkerMessageEvent,
  type ColumnarWorkerOperation,
  type ColumnarWorkerTransport,
  type CreateColumnarBatchInput,
  type HonuaColumnarWorkerError,
  createColumnarBatch,
  createColumnarWorkerSession,
  createGeoArrowAggregateOperation,
  createGeoArrowBatch,
  createGeoArrowFilterOperation,
  createGeoArrowProjectionOperation,
  createGeoArrowReprojectOperation,
  createGeoArrowTransformOperation,
  inspectColumnarBatch,
  leaseColumnarBatch,
  startColumnarWorkerHost,
} from "../src/columnar/index.js";

type MessageListener = (event: ColumnarWorkerMessageEvent) => void;
type ErrorListener = (event: ColumnarWorkerFaultEvent) => void;

class LoopbackTransport implements ColumnarWorkerTransport {
  readonly messages = new Set<MessageListener>();
  readonly errors = new Set<ErrorListener>();
  peer?: LoopbackTransport;
  disposed = false;
  disposeCalls = 0;

  postMessage(message: unknown, transfer: readonly ArrayBuffer[]): void {
    if (this.disposed) throw new Error("transport disposed");
    const cloned = structuredClone(message, { transfer: [...transfer] });
    queueMicrotask(() => {
      if (this.disposed || !this.peer || this.peer.disposed) return;
      for (const listener of this.peer.messages) listener({ data: cloned });
    });
  }

  addEventListener(type: "message" | "error", listener: MessageListener | ErrorListener): void {
    if (type === "message") this.messages.add(listener as MessageListener);
    else this.errors.add(listener as ErrorListener);
  }

  removeEventListener(type: "message" | "error", listener: MessageListener | ErrorListener): void {
    if (type === "message") this.messages.delete(listener as MessageListener);
    else this.errors.delete(listener as ErrorListener);
  }

  dispose(): void {
    this.disposeCalls += 1;
    this.disposed = true;
    this.messages.clear();
    this.errors.clear();
  }
}

function pair(): readonly [LoopbackTransport, LoopbackTransport] {
  const client = new LoopbackTransport();
  const worker = new LoopbackTransport();
  client.peer = worker;
  worker.peer = client;
  return [client, worker];
}

/**
 * A real `MessagePort` boundary. Unlike the loopback pair this performs a real
 * structured-clone handoff with real buffer detachment and real event-loop
 * delivery, so message ordering and transfer semantics are observed rather
 * than simulated.
 */
function portTransport(port: MessagePort): ColumnarWorkerTransport {
  port.unref();
  port.start();
  return {
    postMessage(message: unknown, transfer: readonly ArrayBuffer[]) {
      port.postMessage(message, [...transfer]);
    },
    addEventListener(type: "message" | "error", listener: MessageListener | ErrorListener) {
      if (type === "message") port.addEventListener("message", listener as unknown as EventListener);
    },
    removeEventListener(type: "message" | "error", listener: MessageListener | ErrorListener) {
      if (type === "message") port.removeEventListener("message", listener as unknown as EventListener);
    },
    dispose() {
      port.close();
    },
  };
}

interface HostedSession {
  readonly clients: readonly LoopbackTransport[];
  readonly hosts: readonly ColumnarWorkerHost[];
  readonly createWorker: () => ColumnarWorkerTransport;
}

function hostedFactory(operations: Readonly<Record<string, ColumnarWorkerOperation>>): HostedSession {
  const clients: LoopbackTransport[] = [];
  const hosts: ColumnarWorkerHost[] = [];
  return {
    clients,
    hosts,
    createWorker: () => {
      const [client, worker] = pair();
      clients.push(client);
      hosts.push(startColumnarWorkerHost({ transport: worker, operations }));
      return client;
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function tagged(tag: number, byteLength = 32): ArrayBuffer {
  const data = new ArrayBuffer(byteLength);
  new Uint8Array(data)[0] = tag;
  return data;
}

function input(data: ArrayBuffer, overrides: Partial<CreateColumnarBatchInput> = {}): CreateColumnarBatchInput {
  return {
    id: "batch-0",
    sequence: 0,
    rowCount: 4,
    schema: {
      id: "points-v1",
      fields: [{ name: "geometry", type: { name: "geoarrow.point" }, nullable: false }],
      metadata: { crs: "EPSG:4326" },
    },
    buffers: [{ id: "xy", field: "geometry", role: "geometry", data, byteOffset: 0, byteLength: 32 }],
    ...overrides,
  };
}

function expectCode(error: unknown, code: HonuaColumnarWorkerError["code"]): void {
  expect(error).toMatchObject({ name: "HonuaColumnarWorkerError", code });
}

async function rejection(promise: Promise<unknown>): Promise<HonuaColumnarWorkerError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: HonuaColumnarWorkerError) => error,
  );
}

const geoIdentity = {
  sourceId: "source",
  sourceVersion: "v1",
  schemaVersion: "points-v1",
  planId: "plan-v1",
  authorizationScope: "public",
  ordering: { stable: true, keys: [{ field: "id", direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-01-01T00:00:00Z" },
} as const;

function geoBatch(): ColumnarBatchV1 {
  return createGeoArrowBatch({
    id: "operator-source",
    sequence: 3,
    rowOffset: 0,
    schemaId: "points-v1",
    identity: geoIdentity,
    geometry: { kind: "point", field: "geometry", crs: "EPSG:4326", values: [[10, 20], [30, 40], null] },
    temporal: { field: "observed", unit: "millisecond", values: [1000n, 2000n, null] },
    dictionary: { field: "class", values: ["keep", "drop", "keep"] },
    featureIds: { field: "id", values: [11, 12, 13] },
  }).batch;
}

describe("columnar cooperative cancellation", () => {
  it("aborts an operation mid-flight, keeps the transport warm, and stays reusable", async () => {
    const parked = deferred();
    let invocations = 0;
    let abortsObserved = 0;
    let completions = 0;
    const factory = hostedFactory({
      async transform(batch, context) {
        invocations += 1;
        if (invocations === 1) {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
            parked.resolve();
          });
          abortsObserved += 1;
          throw new DOMException("The operation was aborted", "AbortError");
        }
        completions += 1;
        return batch;
      },
    });
    const session = createColumnarWorkerSession({ createWorker: factory.createWorker });
    const controller = new AbortController();
    const first = session.execute("transform", createColumnarBatch(input(tagged(1), { id: "cancelled" })), {
      signal: controller.signal,
    });

    await parked.promise;
    controller.abort();
    expectCode(await rejection(first), "aborted");
    expect(abortsObserved).toBe(1);
    expect(completions).toBe(0);
    expect(session.state).toBe("idle");

    const second = await session.execute("transform", createColumnarBatch(input(tagged(2), { id: "resumed" })));
    expect(second).toMatchObject({ operation: "transform", batch: { id: "resumed" } });
    expect({ invocations, completions }).toEqual({ invocations: 2, completions: 1 });
    expect(factory.clients).toHaveLength(1);
    expect(factory.clients[0]).toMatchObject({ disposed: false, disposeCalls: 0 });
    await vi.waitFor(() => expect(factory.hosts[0]?.activeRequests).toBe(0));
    expect(session.pendingRequests).toBe(0);
    session.dispose();
  });

  it("settles the caller before the acknowledgement deadline and retires a worker that misses it", async () => {
    const factory = hostedFactory({
      async transform() {
        return new Promise<ColumnarBatchV1>(() => undefined);
      },
    });
    const session = createColumnarWorkerSession({
      cancelAcknowledgementMs: 1,
      createWorker: factory.createWorker,
    });
    const controller = new AbortController();
    const cancelled = tagged(1);
    const first = session.execute("transform", createColumnarBatch(input(cancelled, { id: "stuck" })), {
      signal: controller.signal,
    });
    let settled: string | undefined;
    void first.catch((error: HonuaColumnarWorkerError) => {
      settled = error.code;
    });
    await vi.waitFor(() => expect(cancelled.byteLength).toBe(0));

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe("aborted");
    expect(factory.clients[0]?.disposeCalls).toBe(0);

    await vi.waitFor(() => expect(factory.clients[0]?.disposeCalls).toBe(1));
    const resumed = session.execute("transform", createColumnarBatch(input(tagged(2), { id: "next" })));
    await vi.waitFor(() => expect(factory.clients).toHaveLength(2));
    session.dispose();
    expectCode(await rejection(resumed), "disposed");
  });

  it("resumes queued work when the transport faults inside the cancellation window", async () => {
    const factory = hostedFactory({
      async hold(batch, context) {
        if (context.requestId.endsWith("-1")) return new Promise<ColumnarBatchV1>(() => undefined);
        return batch;
      },
    });
    const session = createColumnarWorkerSession({ createWorker: factory.createWorker });
    const controller = new AbortController();
    const cancelled = tagged(1);
    const first = session.execute("hold", createColumnarBatch(input(cancelled, { id: "cancelled" })), {
      signal: controller.signal,
    });
    const queued = session.execute("hold", createColumnarBatch(input(tagged(2), { id: "queued" })));
    await vi.waitFor(() => expect(cancelled.byteLength).toBe(0));

    controller.abort();
    expectCode(await rejection(first), "aborted");
    factory.clients[0]?.errors.forEach((listener) => listener({ message: "worker crashed" }));

    await expect(queued).resolves.toMatchObject({ batch: { id: "queued" } });
    expect(factory.clients).toHaveLength(2);
    expect(factory.clients[0]?.disposeCalls).toBe(1);
    session.dispose();
  });

  it("discards a result that raced the cancellation instead of settling the caller with it", async () => {
    const [client, worker] = pair();
    const requests: Array<{ readonly requestId: string; readonly batch: ColumnarBatchV1 }> = [];
    worker.addEventListener("message", (event: ColumnarWorkerMessageEvent) => {
      const value = event.data as { readonly kind?: string; readonly requestId?: string; readonly batch?: unknown };
      if (value.kind !== COLUMNAR_WORKER_REQUEST_KIND || !value.requestId) return;
      requests.push({ requestId: value.requestId, batch: value.batch as ColumnarBatchV1 });
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });
    const controller = new AbortController();
    const first = session.execute("transform", createColumnarBatch(input(tagged(1), { id: "raced" })), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    controller.abort();
    const raced = requests[0]!;
    worker.postMessage(
      {
        kind: COLUMNAR_WORKER_RESULT_KIND,
        version: COLUMNAR_WORKER_PROTOCOL_VERSION,
        requestId: raced.requestId,
        batch: raced.batch,
        metrics: inspectColumnarBatch(raced.batch),
      },
      raced.batch.buffers.map((buffer) => buffer.data),
    );
    expectCode(await rejection(first), "aborted");

    worker.addEventListener("message", (event: ColumnarWorkerMessageEvent) => {
      const value = event.data as { readonly kind?: string; readonly requestId?: string; readonly batch?: unknown };
      if (value.kind !== COLUMNAR_WORKER_REQUEST_KIND || value.requestId === raced.requestId) return;
      const echoed = value.batch as ColumnarBatchV1;
      worker.postMessage(
        {
          kind: COLUMNAR_WORKER_RESULT_KIND,
          version: COLUMNAR_WORKER_PROTOCOL_VERSION,
          requestId: value.requestId,
          batch: echoed,
          metrics: inspectColumnarBatch(echoed),
        },
        echoed.buffers.map((buffer) => buffer.data),
      );
    });
    await expect(
      session.execute("transform", createColumnarBatch(input(tagged(2), { id: "after-race" }))),
    ).resolves.toMatchObject({ batch: { id: "after-race" } });
    expect(client.disposeCalls).toBe(0);
    session.dispose();
  });
});

describe("columnar worker progress", () => {
  it("reports monotonic, terminal, and staged progress through every shipped operator", async () => {
    const projectedIdentity = {
      ...geoIdentity,
      schemaVersion: "points-projected-v1",
      ordering: { ...geoIdentity.ordering, keys: [{ ...geoIdentity.ordering.keys[0], field: "class" }] },
    };
    const transformedIdentity = { ...geoIdentity, schemaVersion: "points-transformed-v1" };
    const reprojectedIdentity = { ...geoIdentity, schemaVersion: "points-reprojected-v1" };
    const factory = hostedFactory({
      filter: createGeoArrowFilterOperation({ id: "filtered", predicate: (row) => row.dictionaryValue === "keep" }),
      projection: createGeoArrowProjectionOperation({
        id: "projected",
        schemaId: "points-projected-v1",
        identity: projectedIdentity,
        columns: ["geometry", "dictionary"],
      }),
      transform: createGeoArrowTransformOperation({
        id: "transformed",
        schemaId: "points-transformed-v1",
        identity: transformedIdentity,
        scale: [2, 2],
      }),
      reproject: createGeoArrowReprojectOperation({
        schemaId: "points-reprojected-v1",
        identity: reprojectedIdentity,
        targetCrs: "EPSG:3857",
        project: ([x, y]) => [x + 1, y + 1],
      }),
      aggregate: createGeoArrowAggregateOperation({
        id: "aggregated",
        schemaId: "points-aggregated-v1",
        group: { kind: "dictionary" },
        metrics: [{ name: "features", kind: "count" }],
      }),
    });
    const session = createColumnarWorkerSession({ createWorker: factory.createWorker });
    const expectedStages: Readonly<Record<string, readonly string[]>> = {
      filter: ["filter", "filter"],
      projection: ["projection", "projection"],
      transform: ["transform", "transform"],
      reproject: ["decode", "reproject", "complete"],
      aggregate: ["inspect", "scan", "encode", "complete"],
    };

    for (const operation of ["filter", "projection", "transform", "reproject", "aggregate"]) {
      const events: ColumnarWorkerExecutionProgress[] = [];
      const result = await session.execute(operation, geoBatch(), {
        onProgress: (event) => events.push(event),
      });
      const fractions = events.map((event) => event.fraction);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((event) => event.requestId === result.requestId)).toBe(true);
      expect(fractions.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
      expect(fractions).toEqual([...fractions].sort((left, right) => left - right));
      expect(fractions.at(-1)).toBe(1);
      expect(events.map((event) => event.stage)).toEqual(expectedStages[operation]);
    }
    session.dispose();
  });

  it("delivers eight chunked progress events in order across a real MessagePort", async () => {
    const chunks = 8;
    const acknowledged = Array.from({ length: chunks }, () => deferred());
    const { port1, port2 } = new MessageChannel();
    const host = startColumnarWorkerHost({
      transport: portTransport(port2),
      operations: {
        async chunked(batch, context) {
          for (let chunk = 0; chunk < chunks; chunk += 1) {
            context.reportProgress((chunk + 1) / chunks, `chunk-${chunk}`);
            await acknowledged[chunk]!.promise;
          }
          return batch;
        },
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => portTransport(port1) });
    const observed: ColumnarWorkerExecutionProgress[] = [];

    try {
      const result = await session.execute("chunked", createColumnarBatch(input(tagged(7), { id: "chunked" })), {
        onProgress: (event) => {
          observed.push(event);
          // Releasing the next chunk only after this event was observed proves
          // the boundary neither coalesces nor drops an intermediate report.
          acknowledged[observed.length - 1]?.resolve();
        },
      });

      expect(observed.map((event) => event.fraction)).toEqual(
        Array.from({ length: chunks }, (_, chunk) => (chunk + 1) / chunks),
      );
      expect(observed.map((event) => event.stage)).toEqual(
        Array.from({ length: chunks }, (_, chunk) => `chunk-${chunk}`),
      );
      expect(result.batch.id).toBe("chunked");
    } finally {
      session.dispose();
      host.dispose();
    }
  });
});

describe("columnar multi-batch streaming", () => {
  it("completes an ordered eight-batch stream strictly FIFO with preserved batch identity", async () => {
    const batches = 8;
    const { port1, port2 } = new MessageChannel();
    const host = startColumnarWorkerHost({
      transport: portTransport(port2),
      operations: { echo: (batch) => batch },
    });
    const session = createColumnarWorkerSession({ createWorker: () => portTransport(port1) });
    const completed: string[] = [];
    let peakPending = 0;

    try {
      const pending = Array.from({ length: batches }, (_, index) => {
        const batch = createColumnarBatch(
          input(tagged(index), { id: `stream-${index}`, sequence: index, rowOffset: index * 4 }),
        );
        const execution = session.execute("echo", batch).then((result) => {
          completed.push(result.batch.id);
          return result;
        });
        peakPending = Math.max(peakPending, session.pendingRequests);
        return execution;
      });
      const results = await Promise.all(pending);

      expect(peakPending).toBe(batches);
      expect(completed).toEqual(Array.from({ length: batches }, (_, index) => `stream-${index}`));
      expect(results.map((result) => result.batch.sequence)).toEqual(Array.from({ length: batches }, (_, i) => i));
      expect(results.map((result) => result.batch.rowOffset)).toEqual(
        Array.from({ length: batches }, (_, index) => index * 4),
      );
      expect(results.map((result) => new Uint8Array(result.batch.buffers[0]!.data)[0])).toEqual(
        Array.from({ length: batches }, (_, index) => index),
      );
      expect(session.pendingRequests).toBe(0);
    } finally {
      session.dispose();
      host.dispose();
    }
  });

  it("rejects stream drift under strict ordering and leaves the drifting batch owned", async () => {
    const factory = hostedFactory({ echo: (batch) => batch });
    const session = createColumnarWorkerSession({
      streamOrdering: "strict",
      createWorker: factory.createWorker,
    });

    await expect(
      session.execute("echo", createColumnarBatch(input(tagged(0), { id: "s0", sequence: 0, rowOffset: 0 }))),
    ).resolves.toMatchObject({ batch: { sequence: 0 } });
    await expect(
      session.execute("echo", createColumnarBatch(input(tagged(1), { id: "s1", sequence: 1, rowOffset: 4 }))),
    ).resolves.toMatchObject({ batch: { sequence: 1 } });

    const drifts: Array<readonly [CreateColumnarBatchInput, string]> = [
      [input(tagged(2), { id: "decreasing", sequence: 0, rowOffset: 8 }), "sequence must increase"],
      [input(tagged(3), { id: "duplicate", sequence: 1, rowOffset: 8 }), "sequence must increase"],
      [input(tagged(4), { id: "gap", sequence: 2, rowOffset: 64 }), "rowOffset must be contiguous"],
      [input(tagged(5), { id: "undeclared", sequence: 2 }), "rowOffset must be declared"],
    ];
    for (const [drifting, reason] of drifts) {
      const owned = drifting.buffers[0]!.data;
      const error = await rejection(session.execute("echo", createColumnarBatch(drifting)));
      expectCode(error, "invalid-request");
      expect(error.message).toContain(reason);
      expect(owned.byteLength).toBe(32);
      expect(session.pendingRequests).toBe(0);
    }

    await expect(
      session.execute("echo", createColumnarBatch(input(tagged(6), { id: "s2", sequence: 2, rowOffset: 8 }))),
    ).resolves.toMatchObject({ batch: { sequence: 2, rowOffset: 8 } });
    expect(factory.clients).toHaveLength(1);
    session.dispose();
  });

  it("keeps unordered sessions independent and rejects an unsupported ordering mode", async () => {
    const factory = hostedFactory({ echo: (batch) => batch });
    const session = createColumnarWorkerSession({ createWorker: factory.createWorker });

    await expect(
      session.execute("echo", createColumnarBatch(input(tagged(0), { id: "s5", sequence: 5, rowOffset: 20 }))),
    ).resolves.toMatchObject({ batch: { sequence: 5 } });
    await expect(
      session.execute("echo", createColumnarBatch(input(tagged(1), { id: "s1", sequence: 1, rowOffset: 99 }))),
    ).resolves.toMatchObject({ batch: { sequence: 1, rowOffset: 99 } });
    session.dispose();

    expect(() =>
      createColumnarWorkerSession({
        createWorker: factory.createWorker,
        streamOrdering: "loose" as never,
      }),
    ).toThrowError(expect.objectContaining({ name: "HonuaColumnarWorkerError", code: "invalid-request" }));
  });
});

describe("columnar queue ceiling", () => {
  it("validates the pending-request ceiling before a worker exists", () => {
    const createWorker = vi.fn(() => pair()[0]);
    for (const maxPendingRequests of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createColumnarWorkerSession({ createWorker, maxPendingRequests })).toThrowError(
        expect.objectContaining({ name: "HonuaColumnarWorkerError", code: "invalid-request" }),
      );
    }
    expect(() => createColumnarWorkerSession({ createWorker, cancelAcknowledgementMs: -1 })).toThrowError(
      expect.objectContaining({ name: "HonuaColumnarWorkerError", code: "invalid-request" }),
    );
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("saturates at the exact ceiling and rejects sustained overflow without retaining it", async () => {
    const maxPendingRequests = 4;
    const gate = deferred();
    const factory = hostedFactory({
      async hold(batch) {
        await gate.promise;
        return batch;
      },
    });
    const session = createColumnarWorkerSession({ maxPendingRequests, createWorker: factory.createWorker });
    const accepted: Array<Promise<unknown>> = [];
    const acceptedBuffers: ArrayBuffer[] = [];

    for (let index = 0; index < maxPendingRequests; index += 1) {
      const data = tagged(index);
      acceptedBuffers.push(data);
      accepted.push(session.execute("hold", createColumnarBatch(input(data, { id: `accepted-${index}` }))));
    }
    expect(session.pendingRequests).toBe(maxPendingRequests);
    await vi.waitFor(() => expect(acceptedBuffers[0]?.byteLength).toBe(0));

    const overflowBuffers: ArrayBuffer[] = [];
    for (let index = 0; index < 40; index += 1) {
      const data = tagged(index);
      overflowBuffers.push(data);
      const overflow = session.execute("hold", createColumnarBatch(input(data, { id: `overflow-${index}` })));
      expect(session.pendingRequests).toBe(maxPendingRequests);
      expectCode(await rejection(overflow), "queue-full");
      expect(session.pendingRequests).toBe(maxPendingRequests);
    }

    // A saturated session transfers exactly one batch and retains nothing for
    // work it refused: every queued and every rejected backing stays attached
    // and caller-owned, so offered load cannot grow session-held memory.
    expect(overflowBuffers.every((data) => data.byteLength === 32)).toBe(true);
    expect(acceptedBuffers.filter((data) => data.byteLength === 0)).toHaveLength(1);
    expect(acceptedBuffers.filter((data) => data.byteLength === 32)).toHaveLength(maxPendingRequests - 1);

    gate.resolve();
    await expect(Promise.all(accepted)).resolves.toHaveLength(maxPendingRequests);
    expect(session.pendingRequests).toBe(0);
    expect(acceptedBuffers.every((data) => data.byteLength === 0)).toBe(true);
    session.dispose();
  });
});

describe("columnar disposal", () => {
  it("settles one active and two queued requests with per-buffer detach outcomes", async () => {
    const factory = hostedFactory({
      async hold() {
        return new Promise<ColumnarBatchV1>(() => undefined);
      },
    });
    const session = createColumnarWorkerSession({ createWorker: factory.createWorker });
    const activeBuffer = tagged(0);
    const queuedBuffers = [tagged(1), tagged(2)];
    const active = session.execute("hold", createColumnarBatch(input(activeBuffer, { id: "active" })));
    const queued = queuedBuffers.map((data, index) =>
      session.execute("hold", createColumnarBatch(input(data, { id: `queued-${index}` }))),
    );
    await vi.waitFor(() => expect(activeBuffer.byteLength).toBe(0));
    expect(session.pendingRequests).toBe(3);

    session.dispose();
    session.dispose();

    for (const settled of [active, ...queued]) expectCode(await rejection(settled), "disposed");
    expect(activeBuffer.byteLength).toBe(0);
    expect(queuedBuffers.map((data) => data.byteLength)).toEqual([32, 32]);
    expect(session).toMatchObject({ state: "disposed", pendingRequests: 0 });
    expect(factory.clients[0]?.disposeCalls).toBe(1);
    expectCode(
      await rejection(session.execute("hold", createColumnarBatch(input(tagged(3), { id: "after-dispose" })))),
      "disposed",
    );
  });

  it("disposes a lease across the transfer handoff without a double release", async () => {
    const insideTarget = leaseColumnarBatch(createColumnarBatch(input(tagged(1), { id: "inside-target" })));
    const receipt = await insideTarget.transfer((message, transfer) => {
      expect(transfer).toHaveLength(1);
      insideTarget.dispose();
      insideTarget.dispose();
      expect(message.batch.id).toBe("inside-target");
    });
    expect(receipt).toMatchObject({ batchId: "inside-target", acknowledged: true, metrics: { copiedBytes: 0 } });
    expect(insideTarget.state).toBe("disposed");
    expect(() => insideTarget.batch).toThrowError(
      expect.objectContaining({ name: "HonuaColumnarTransferError", code: "disposed" }),
    );
    await expect(insideTarget.transfer(() => undefined)).rejects.toMatchObject({ code: "disposed" });

    const duringAck = leaseColumnarBatch(createColumnarBatch(input(tagged(2), { id: "during-ack" })));
    const acknowledgement = deferred();
    const pending = duringAck.transfer(() => acknowledgement.promise);
    await Promise.resolve();
    duringAck.dispose();
    expect(duringAck.state).toBe("disposed");
    acknowledgement.resolve();
    await expect(pending).resolves.toMatchObject({ batchId: "during-ack", acknowledged: true });
    expect(() => duringAck.dispose()).not.toThrow();
    expect(duringAck.state).toBe("disposed");
  });
});
