import { describe, expect, it, vi } from "vitest";
import {
  COLUMNAR_WORKER_PROTOCOL_VERSION,
  COLUMNAR_WORKER_REQUEST_KIND,
  type ColumnarBatchV1,
  type ColumnarWorkerFaultEvent,
  type ColumnarWorkerMessageEvent,
  type ColumnarWorkerOperation,
  type ColumnarWorkerTransport,
  type CreateColumnarBatchInput,
  type HonuaColumnarWorkerError,
  createColumnarBatch,
  createColumnarWorkerSession,
  inspectColumnarBatch,
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

  emitError(error: unknown): void {
    for (const listener of this.errors) listener({ error, message: "loopback fault" });
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

function input(data = new ArrayBuffer(32), id = "batch-0"): CreateColumnarBatchInput {
  return {
    id,
    sequence: 0,
    rowCount: 4,
    schema: {
      id: "points-v1",
      fields: [{ name: "geometry", type: { name: "geoarrow.point" }, nullable: false }],
      metadata: { crs: "EPSG:4326" },
    },
    buffers: [{ id: "xy", field: "geometry", role: "geometry", data, byteOffset: 0, byteLength: 32 }],
  };
}

function expectCode(error: unknown, code: HonuaColumnarWorkerError["code"]): void {
  expect(error).toMatchObject({ name: "HonuaColumnarWorkerError", code });
}

function hostedFactory(
  operation: ColumnarWorkerOperation,
  created: LoopbackTransport[] = [],
): () => ColumnarWorkerTransport {
  return () => {
    const [client, worker] = pair();
    created.push(client);
    startColumnarWorkerHost({ transport: worker, operations: { transform: operation } });
    return client;
  };
}

describe("columnar worker session", () => {
  it("lazily transfers a batch through a registered operation with monotonic progress", async () => {
    const created: LoopbackTransport[] = [];
    const progress: number[] = [];
    const source = new ArrayBuffer(32);
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory((batch, context) => {
        context.reportProgress(0.25, "decode");
        context.reportProgress(1, "complete");
        return batch;
      }, created),
    });

    expect(created).toHaveLength(0);
    const result = await session.execute("transform", createColumnarBatch(input(source)), {
      onProgress: (event) => progress.push(event.fraction),
    });

    expect(created).toHaveLength(1);
    expect(progress).toEqual([0.25, 1]);
    expect(source.byteLength).toBe(0);
    expect(result.batch.buffers[0]?.data.byteLength).toBe(32);
    expect(result.inputMetrics).toMatchObject({ backingBytes: 32, copiedBytes: 0 });
    expect(result.outputMetrics).toMatchObject({ backingBytes: 32, copiedBytes: 0 });
    expect(session.state).toBe("idle");
    session.dispose();
  });

  it("serializes work, bounds the queue, and leaves a cancelled queued batch owned", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const session = createColumnarWorkerSession({
      maxPendingRequests: 2,
      createWorker: hostedFactory(async (batch) => {
        calls += 1;
        if (calls === 1) await gate;
        return batch;
      }),
    });
    const first = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "first")));
    const queuedBuffer = new ArrayBuffer(32);
    const controller = new AbortController();
    const queued = session.execute("transform", createColumnarBatch(input(queuedBuffer, "queued")), {
      signal: controller.signal,
    });
    const overflow = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "overflow")));

    await expect(overflow).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "queue-full");
      return true;
    });
    controller.abort();
    await expect(queued).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "aborted");
      return true;
    });
    expect(queuedBuffer.byteLength).toBe(32);
    release?.();
    await expect(first).resolves.toMatchObject({ operation: "transform" });
    expect(calls).toBe(1);
    session.dispose();
  });

  it("rejects an invalid batch before creating or mutating a worker", async () => {
    const createWorker = vi.fn(() => pair()[0]);
    const session = createColumnarWorkerSession({ createWorker });
    const malformed = {
      ...createColumnarBatch(input()),
      kind: "future.columnar-batch",
    } as unknown as ColumnarBatchV1;

    await expect(session.execute("transform", malformed)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "invalid-request");
      return true;
    });
    expect(createWorker).not.toHaveBeenCalled();
    session.dispose();
  });

  it("snapshots foreign execution options exactly once before enqueue", async () => {
    let rowLimitReads = 0;
    const foreignOptions = {
      get maxRows() {
        rowLimitReads += 1;
        return rowLimitReads === 1 ? 4 : 0;
      },
    };
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory((batch) => batch),
    });

    await expect(session.execute("transform", createColumnarBatch(input()), foreignOptions)).resolves.toMatchObject({
      operation: "transform",
    });
    expect(rowLimitReads).toBe(1);
    session.dispose();
  });

  it("retires a non-cooperative active worker on cancellation and recreates lazily", async () => {
    const created: LoopbackTransport[] = [];
    let invocation = 0;
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory(async (batch) => {
        invocation += 1;
        if (invocation === 1) await new Promise<void>(() => undefined);
        return batch;
      }, created),
    });
    const controller = new AbortController();
    const first = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "first")), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const second = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "second")));
    controller.abort();

    await expect(first).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "aborted");
      return true;
    });
    await expect(second).resolves.toMatchObject({ operation: "transform" });
    expect(created).toHaveLength(2);
    expect(created[0]?.disposeCalls).toBe(1);
    session.dispose();
  });

  it("reports unknown operations and non-monotonic operator progress as typed failures", async () => {
    const [client, worker] = pair();
    startColumnarWorkerHost({
      transport: worker,
      operations: {
        badProgress(batch, context) {
          context.reportProgress(0.8);
          context.reportProgress(0.2);
          return batch;
        },
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });

    await expect(session.execute("missing", createColumnarBatch(input()))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "unknown-operation");
      return true;
    });
    await expect(session.execute("badProgress", createColumnarBatch(input()))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "operation-failed");
      return true;
    });
    session.dispose();
  });

  it("ignores a valid late response without settling the active request", async () => {
    const [client, worker] = pair();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const requestIds: string[] = [];
    worker.addEventListener("message", (event: ColumnarWorkerMessageEvent) => {
      const value = event.data as { readonly kind?: string; readonly requestId?: string };
      if (value.kind === COLUMNAR_WORKER_REQUEST_KIND && value.requestId) requestIds.push(value.requestId);
    });
    startColumnarWorkerHost({
      transport: worker,
      operations: {
        async transform(batch) {
          call += 1;
          if (call === 2) await gate;
          return batch;
        },
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });
    await session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "first")));
    const second = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "second")));
    await vi.waitFor(() => expect(requestIds).toHaveLength(2));
    worker.postMessage(
      {
        kind: "honua.columnar-worker.error",
        version: COLUMNAR_WORKER_PROTOCOL_VERSION,
        requestId: requestIds[0],
        code: "operation-failed",
        message: "late response",
      },
      [],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.pendingRequests).toBe(1);
    release?.();
    await expect(second).resolves.toMatchObject({ requestId: requestIds[1] });
    session.dispose();
  });

  it("fails closed on future responses and transport faults", async () => {
    const [client, worker] = pair();
    worker.addEventListener("message", (event: ColumnarWorkerMessageEvent) => {
      const request = event.data as { readonly requestId: string };
      worker.postMessage(
        {
          kind: "honua.columnar-worker.progress",
          version: "2.0",
          requestId: request.requestId,
          fraction: 0.5,
        },
        [],
      );
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });
    await expect(session.execute("transform", createColumnarBatch(input()))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "invalid-response");
      return true;
    });
    expect(client.disposed).toBe(true);

    const [faultyClient] = pair();
    const faulty = createColumnarWorkerSession({ createWorker: () => faultyClient });
    const pending = faulty.execute("transform", createColumnarBatch(input()));
    await vi.waitFor(() => expect(faultyClient.errors.size).toBe(1));
    faultyClient.emitError(new Error("worker crashed"));
    await expect(pending).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "worker-failed");
      return true;
    });
    faulty.dispose();
  });

  it("settles active and queued requests on idempotent disposal", async () => {
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory(async () => new Promise<ColumnarBatchV1>(() => undefined)),
    });
    const active = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "active")));
    const queued = session.execute("transform", createColumnarBatch(input(new ArrayBuffer(32), "queued")));
    await vi.waitFor(() => expect(session.state).toBe("running"));
    session.dispose();
    session.dispose();

    await expect(active).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "disposed");
      return true;
    });
    await expect(queued).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "disposed");
      return true;
    });
    expect(session).toMatchObject({ state: "disposed", pendingRequests: 0 });
  });

  it("rejects malformed host requests without invoking an operation", async () => {
    const [client, worker] = pair();
    const operation = vi.fn((batch: ColumnarBatchV1) => batch);
    startColumnarWorkerHost({ transport: worker, operations: { transform: operation } });
    const response = new Promise<unknown>((resolve) =>
      client.addEventListener("message", (event: ColumnarWorkerMessageEvent) => resolve(event.data)),
    );
    client.postMessage(
      {
        kind: COLUMNAR_WORKER_REQUEST_KIND,
        version: COLUMNAR_WORKER_PROTOCOL_VERSION,
        requestId: "request-1",
        operation: "transform",
        batch: { kind: "not-a-batch", version: "1.0" },
        metrics: {},
      },
      [],
    );
    await expect(response).resolves.toMatchObject({
      kind: "honua.columnar-worker.error",
      requestId: "request-1",
      code: "invalid-request",
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("settles safely when a hostile signal changes or throws across queue setup", async () => {
    let abortedReads = 0;
    const hostileSignal = {
      get aborted() {
        abortedReads += 1;
        if (abortedReads === 4) throw new Error("hostile aborted getter");
        return false;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const createWorker = vi.fn(() => pair()[0]);
    const session = createColumnarWorkerSession({ createWorker });

    await expect(
      session.execute("transform", createColumnarBatch(input()), { signal: hostileSignal }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "invalid-request");
      return true;
    });
    expect(session.pendingRequests).toBe(0);
    expect(createWorker).not.toHaveBeenCalled();

    const brokenSubscription = {
      aborted: false,
      addEventListener() {
        throw new Error("listener install failed");
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(
      session.execute("transform", createColumnarBatch(input()), { signal: brokenSubscription }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "invalid-request");
      return true;
    });
    expect(session.pendingRequests).toBe(0);
    session.dispose();
  });

  it("snapshots host options, limits, and transport methods before async operations", async () => {
    const [client, worker] = pair();
    const methodReads = { post: 0, add: 0, remove: 0, dispose: 0 };
    const stableTransport = {
      get postMessage() {
        methodReads.post += 1;
        return (message: unknown, transfer: readonly ArrayBuffer[]) => worker.postMessage(message, transfer);
      },
      get addEventListener() {
        methodReads.add += 1;
        return (type: "message" | "error", listener: MessageListener | ErrorListener) =>
          worker.addEventListener(type, listener);
      },
      get removeEventListener() {
        methodReads.remove += 1;
        return (type: "message" | "error", listener: MessageListener | ErrorListener) =>
          worker.removeEventListener(type, listener);
      },
      get dispose() {
        methodReads.dispose += 1;
        return () => worker.dispose();
      },
    } as ColumnarWorkerTransport;
    const limits = { maxRows: 4 };
    const hostOptions = {
      transport: stableTransport,
      operations: { transform: (batch: ColumnarBatchV1) => batch },
      batchLimits: limits,
    };
    const host = startColumnarWorkerHost(hostOptions);
    hostOptions.transport = {
      postMessage() {
        throw new Error("mutated transport must not be used");
      },
      addEventListener() {},
      removeEventListener() {},
      dispose() {},
    };
    limits.maxRows = 0;
    const session = createColumnarWorkerSession({ createWorker: () => client });

    await expect(session.execute("transform", createColumnarBatch(input()))).resolves.toMatchObject({
      operation: "transform",
    });
    expect(methodReads).toEqual({ post: 1, add: 1, remove: 1, dispose: 1 });
    session.dispose();
    host.dispose();
  });

  it("contains host delivery failures without unhandled rejections or stranded activity", async () => {
    let messageListener: MessageListener | undefined;
    const throwingTransport: ColumnarWorkerTransport = {
      postMessage() {
        throw new Error("closed transport");
      },
      addEventListener(type, listener) {
        if (type === "message") messageListener = listener as MessageListener;
      },
      removeEventListener() {},
      dispose() {},
    };
    const host = startColumnarWorkerHost({
      transport: throwingTransport,
      operations: {
        transform(batch, context) {
          context.reportProgress(0.5);
          return batch;
        },
      },
    });
    const batch = createColumnarBatch(input());
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      messageListener?.({ data: null });
      messageListener?.({
        data: {
          kind: COLUMNAR_WORKER_REQUEST_KIND,
          version: COLUMNAR_WORKER_PROTOCOL_VERSION,
          requestId: "request-progress-failure",
          operation: "transform",
          batch,
          metrics: inspectColumnarBatch(batch),
        },
      });
      await vi.waitFor(() => expect(host.activeRequests).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      host.dispose();
    }
  });

  it("rolls back and closes a transport after partial listener registration", () => {
    const removeMessage = vi.fn();
    const removeError = vi.fn();
    const dispose = vi.fn();
    const transport: ColumnarWorkerTransport = {
      postMessage() {},
      addEventListener(type) {
        if (type === "error") throw new Error("second listener failed");
      },
      removeEventListener(type) {
        if (type === "message") removeMessage();
        else removeError();
      },
      dispose,
    };

    expect(() => startColumnarWorkerHost({ transport, operations: { transform: (batch) => batch } })).toThrowError(
      expect.objectContaining({ name: "HonuaColumnarWorkerError", code: "worker-failed" }),
    );
    expect(removeMessage).toHaveBeenCalledOnce();
    expect(removeError).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("completes every host disposal action when listener removal throws", () => {
    const removeMessage = vi.fn(() => {
      throw new Error("message removal failed");
    });
    const removeError = vi.fn();
    const dispose = vi.fn();
    const transport: ColumnarWorkerTransport = {
      postMessage() {},
      addEventListener() {},
      removeEventListener(type) {
        if (type === "message") removeMessage();
        else removeError();
      },
      dispose,
    };
    const host = startColumnarWorkerHost({ transport, operations: { transform: (batch) => batch } });

    expect(() => host.dispose()).toThrowError(
      expect.objectContaining({ name: "HonuaColumnarWorkerError", code: "worker-failed" }),
    );
    expect(removeMessage).toHaveBeenCalledOnce();
    expect(removeError).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(host).toMatchObject({ disposed: true, activeRequests: 0 });
    expect(() => host.dispose()).not.toThrow();
  });
});
