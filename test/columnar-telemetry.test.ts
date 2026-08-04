import { describe, expect, it, vi } from "vitest";
import {
  type ColumnarBatchIdentityV1,
  type ColumnarBatchV1,
  type ColumnarPatchV1,
  type ColumnarTelemetry,
  type ColumnarTelemetrySpan,
  type ColumnarTelemetrySpanResult,
  type ColumnarWorkerFaultEvent,
  type ColumnarWorkerMessageEvent,
  type ColumnarWorkerOperation,
  type ColumnarWorkerTransport,
  type CreateGeoArrowBatchInput,
  applyColumnarPatch,
  columnarAuthorizationScopeDigest,
  columnarBatchCacheFixtureBatch,
  columnarBatchCacheFixtureIdentity,
  columnarBatchToResult,
  columnarBatchToResultPages,
  createColumnarBatchCache,
  createColumnarPatch,
  createColumnarWorkerSession,
  createGeoArrowBatch,
  createMemoryColumnarBatchCacheStorage,
  createPatchableGeoArrowBatch,
  leaseColumnarBatch,
  startColumnarWorkerHost,
} from "../src/columnar/index.js";
import { beginColumnarSpan, columnarTelemetryDelivered } from "../src/columnar/telemetry.js";

// ── Recording sink ───────────────────────────────────────────

interface Recorded {
  readonly hook: "before" | "after" | "error";
  readonly span: ColumnarTelemetrySpanResult;
}

interface Recorder {
  readonly telemetry: ColumnarTelemetry;
  readonly recorded: Recorded[];
  trace(): string[];
  terminal(): ColumnarTelemetrySpanResult;
  reset(): void;
}

function recorder(): Recorder {
  const recorded: Recorded[] = [];
  const push = (hook: Recorded["hook"]) => (span: ColumnarTelemetrySpan | ColumnarTelemetrySpanResult) => {
    recorded.push({ hook, span: span as ColumnarTelemetrySpanResult });
  };
  return {
    telemetry: { before: push("before"), after: push("after"), error: push("error") },
    recorded,
    trace: () => recorded.map((entry) => `${entry.hook}:${entry.span.kind}`),
    terminal: () => {
      const last = recorded.at(-1);
      if (!last || last.hook === "before") throw new Error("no terminal span was recorded");
      return last.span;
    },
    reset: () => {
      recorded.length = 0;
    },
  };
}

/**
 * The first span for a previously unseen authorization scope is delivered once
 * that scope's digest resolves; every later span for the same scope is
 * delivered synchronously. Tests therefore drain deferred deliveries before
 * asserting, which is exactly the contract the module documents.
 */
const flush = columnarTelemetryDelivered;

// ── Fixtures ─────────────────────────────────────────────────

const SCOPE = "scope:telemetry-tenant";

function identity(overrides: Partial<ColumnarBatchIdentityV1> = {}): ColumnarBatchIdentityV1 {
  return {
    sourceId: "incidents",
    sourceVersion: "2026-08-03",
    schemaVersion: "incidents@1",
    planId: "plan:sha256:telemetry",
    authorizationScope: SCOPE,
    ordering: { stable: false, keys: [] },
    freshness: { observedAt: "2026-08-03T00:00:00.000Z" },
    ...overrides,
  };
}

function pointInput(rows: number, overrides: Partial<CreateGeoArrowBatchInput> = {}): CreateGeoArrowBatchInput {
  return {
    id: "incidents:0",
    sequence: 1,
    schemaId: "incidents@1",
    identity: identity(),
    geometry: {
      kind: "point",
      field: "geometry",
      values: Array.from({ length: rows }, (_, row) => [row / 8, -row / 8]),
    },
    featureIds: { field: "id", values: Array.from({ length: rows }, (_, row) => row) },
    ...overrides,
  } as CreateGeoArrowBatchInput;
}

function pointBatch(rows = 4): ColumnarBatchV1 {
  return createGeoArrowBatch(pointInput(rows)).batch;
}

function appendPatch(featureId: number, sequence = 1): ColumnarPatchV1 {
  return createColumnarPatch({
    schemaId: "incidents@1",
    geometryKind: "point",
    cursor: { cursor: `cursor-${sequence}`, sequence, observedAt: "2026-08-03T00:00:05.000Z" },
    operations: [{ op: "append", featureId, geometry: [1, 2] }],
  });
}

// ── Worker loopback transport ────────────────────────────────

type MessageListener = (event: ColumnarWorkerMessageEvent) => void;
type ErrorListener = (event: ColumnarWorkerFaultEvent) => void;

class LoopbackTransport implements ColumnarWorkerTransport {
  readonly messages = new Set<MessageListener>();
  readonly errors = new Set<ErrorListener>();
  peer?: LoopbackTransport;
  disposed = false;

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
    this.disposed = true;
    this.messages.clear();
    this.errors.clear();
  }
}

function hostedFactory(operation: ColumnarWorkerOperation): () => ColumnarWorkerTransport {
  return () => {
    const client = new LoopbackTransport();
    const worker = new LoopbackTransport();
    client.peer = worker;
    worker.peer = client;
    startColumnarWorkerHost({ transport: worker, operations: { transform: operation } });
    return client;
  };
}

// ── Surfaces ─────────────────────────────────────────────────

describe("columnar ownership transfer telemetry (#1043)", () => {
  it("emits a before/after span carrying the transfer accounting", async () => {
    const observer = recorder();
    const lease = leaseColumnarBatch(pointBatch());

    const receipt = await lease.transfer(() => {}, { telemetry: observer.telemetry });
    await flush();

    expect(observer.trace()).toEqual(["before:columnar-transfer", "after:columnar-transfer"]);
    const span = observer.terminal();
    expect(span.detail).toMatchObject({
      batchId: "incidents:0",
      rows: receipt.metrics.rows,
      logicalBytes: receipt.metrics.logicalBytes,
      backingBytes: receipt.metrics.backingBytes,
      transferBytes: receipt.metrics.transferBytes,
      copiedBytes: 0,
      bufferViews: receipt.metrics.bufferViews,
      backingBuffers: receipt.metrics.backingBuffers,
    });
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(span.finishedAt).toBeGreaterThanOrEqual(span.startedAt);
  });

  it("emits a before/error span naming the transfer failure code", async () => {
    const observer = recorder();
    const lease = leaseColumnarBatch(pointBatch());

    await expect(
      lease.transfer(
        () => {
          throw new Error("consumer refused");
        },
        { telemetry: observer.telemetry },
      ),
    ).rejects.toMatchObject({ name: "HonuaColumnarTransferError", code: "transport-failed" });
    await flush();

    expect(observer.trace()).toEqual(["before:columnar-transfer", "error:columnar-transfer"]);
    expect(observer.terminal().detail).toMatchObject({ code: "transport-failed" });
    expect(observer.terminal().error).toMatchObject({ code: "transport-failed" });
  });
});

describe("columnar worker operation telemetry (#1043)", () => {
  it("spans the operation and the dispatch handoff it performs", async () => {
    const observer = recorder();
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory((batch) => batch),
      telemetry: observer.telemetry,
    });

    const result = await session.execute("transform", pointBatch());
    await flush();

    expect(observer.trace()).toEqual([
      "before:columnar-worker-operation",
      "before:columnar-transfer",
      "after:columnar-transfer",
      "after:columnar-worker-operation",
    ]);
    const span = observer.terminal();
    expect(span.kind).toBe("columnar-worker-operation");
    expect(span.detail).toMatchObject({
      requestId: result.requestId,
      operation: "transform",
      batchId: "incidents:0",
      inputMetrics: result.inputMetrics,
      outputMetrics: result.outputMetrics,
    });
    session.dispose();
  });

  it("emits a before/error span naming the worker failure code", async () => {
    const observer = recorder();
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory(() => {
        throw new Error("operation exploded");
      }),
      telemetry: observer.telemetry,
    });

    await expect(session.execute("transform", pointBatch())).rejects.toMatchObject({
      name: "HonuaColumnarWorkerError",
      code: "operation-failed",
    });
    await flush();

    expect(observer.trace().at(0)).toBe("before:columnar-worker-operation");
    expect(observer.trace().at(-1)).toBe("error:columnar-worker-operation");
    expect(observer.terminal().detail).toMatchObject({ code: "operation-failed" });
    session.dispose();
  });

  it("refuses a telemetry value that is not an object", () => {
    expect(() =>
      createColumnarWorkerSession({
        createWorker: hostedFactory((batch) => batch),
        telemetry: "observer" as unknown as ColumnarTelemetry,
      }),
    ).toThrowError(expect.objectContaining({ name: "HonuaColumnarWorkerError", code: "invalid-request" }));
  });
});

describe("columnar batch cache telemetry (#1043)", () => {
  it("reports the read outcome and reason discriminants", async () => {
    const observer = recorder();
    const cache = createColumnarBatchCache(createMemoryColumnarBatchCacheStorage(), {
      telemetry: observer.telemetry,
    });
    const cached = columnarBatchCacheFixtureIdentity({
      authorizationScope: SCOPE,
      freshness: { observedAt: new Date().toISOString() },
    });

    const missed = await cache.read(cached);
    await cache.write(columnarBatchCacheFixtureBatch(cached));
    observer.reset();
    const hit = await cache.read(cached);
    await flush();

    expect(missed.outcome).toBe("miss");
    expect(hit.outcome).toBe("hit");
    expect(observer.trace()).toEqual(["before:columnar-cache-read", "after:columnar-cache-read"]);
    expect(observer.terminal().detail).toMatchObject({ key: hit.key, outcome: "hit", rowCount: 2 });
    cache.dispose();
  });

  it("reports the eviction a write performed and the reason a write was refused", async () => {
    const observer = recorder();
    const cache = createColumnarBatchCache(createMemoryColumnarBatchCacheStorage(), {
      maxRecords: 1,
      telemetry: observer.telemetry,
    });
    const first = columnarBatchCacheFixtureIdentity({ authorizationScope: SCOPE, planId: "plan-a" });
    const second = columnarBatchCacheFixtureIdentity({ authorizationScope: SCOPE, planId: "plan-b" });

    await cache.write(columnarBatchCacheFixtureBatch(first));
    observer.reset();
    const stored = await cache.write(columnarBatchCacheFixtureBatch(second));
    await flush();

    expect(stored.outcome).toBe("stored");
    expect(observer.trace()).toEqual(["before:columnar-cache-write", "after:columnar-cache-write"]);
    expect(observer.terminal().detail).toMatchObject({
      outcome: "stored",
      evictedRecords: 1,
      recordsAfter: 1,
    });

    observer.reset();
    const refused = await cache.write(createGeoArrowBatch(pointInput(2, { identity: undefined })).batch);
    await flush();
    expect(refused.outcome).toBe("refused");
    expect(observer.terminal().detail).toMatchObject({ outcome: "refused", reason: "invalid-batch" });
    // A batch that declares no identity binds no span identity, and the raw
    // scope is never substituted for the one it does not have.
    expect(observer.terminal().identity).toBeUndefined();
    cache.dispose();
  });

  it("keeps the onDiagnostic callback firing with its current shape", async () => {
    const observer = recorder();
    const diagnostics: unknown[] = [];
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(
      { ...storage, read: async () => Promise.reject(new Error("backend offline")) },
      {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        telemetry: observer.telemetry,
      },
    );

    const read = await cache.read(columnarBatchCacheFixtureIdentity({ authorizationScope: SCOPE }));
    await flush();

    expect(read.outcome).toBe("miss");
    expect(diagnostics).toEqual([
      {
        kind: "honua.columnar-batch-cache-diagnostic",
        version: 1,
        operation: "read",
        reason: "storage-failed",
        key: read.key,
        detail: expect.any(String),
      },
    ]);
    // The same discriminants now also reach the SDK's telemetry seam.
    expect(observer.terminal().detail).toMatchObject({
      outcome: "miss",
      reason: "storage-failed",
      key: read.key,
    });
    cache.dispose();
  });
});

describe("columnar patch telemetry (#1043)", () => {
  it("reports the in-place outcome, the cursor, and the patch accounting", async () => {
    const observer = recorder();
    const live = createPatchableGeoArrowBatch(pointInput(4), { reserve: { rows: 8 } });

    const outcome = applyColumnarPatch(live.batch, appendPatch(100), { telemetry: observer.telemetry });
    await flush();

    expect(outcome.outcome).toBe("patched-in-place");
    expect(observer.trace()).toEqual(["before:columnar-patch-apply", "after:columnar-patch-apply"]);
    expect(observer.terminal().detail).toMatchObject({
      batchId: "incidents:0",
      cursor: "cursor-1",
      sequence: 1,
      observedAt: "2026-08-03T00:00:05.000Z",
      operations: 1,
      outcome: "patched-in-place",
      bufferIdentityPreserved: true,
      appendedRows: 1,
      backingBytesAllocated: 0,
    });
  });

  it("reports a rebuild and the rule that forced it", async () => {
    const observer = recorder();
    // No declared reserve: the first append cannot fit and must rebuild.
    const outcome = applyColumnarPatch(pointBatch(), appendPatch(100), { telemetry: observer.telemetry });
    await flush();

    expect(outcome.outcome).toBe("rebuilt");
    expect(observer.terminal().detail).toMatchObject({
      outcome: "rebuilt",
      bufferIdentityPreserved: false,
      reason: "capacity",
    });
  });

  it("settles a rejection as a completed span carrying its rejection code", async () => {
    const observer = recorder();
    const drifted = createColumnarPatch({
      schemaId: "incidents@2",
      geometryKind: "point",
      cursor: { cursor: "cursor-9", sequence: 9, observedAt: "2026-08-03T00:00:09.000Z" },
      operations: [{ op: "delete", featureId: 1 }],
    });

    const outcome = applyColumnarPatch(pointBatch(), drifted, { telemetry: observer.telemetry });
    await flush();

    expect(outcome.outcome).toBe("rejected");
    expect(observer.trace()).toEqual(["before:columnar-patch-apply", "after:columnar-patch-apply"]);
    expect(observer.terminal().detail).toMatchObject({ outcome: "rejected", code: "schema-drift" });
  });
});

describe("columnar bounded conversion telemetry (#1043)", () => {
  it("reports the converted window", async () => {
    const observer = recorder();

    const result = columnarBatchToResult(pointBatch(4), { maxFeatures: 10, offset: 1, telemetry: observer.telemetry });
    await flush();

    expect(observer.trace()).toEqual(["before:columnar-result-conversion", "after:columnar-result-conversion"]);
    expect(observer.terminal().detail).toMatchObject({
      batchId: "incidents:0",
      maxFeatures: 10,
      count: result.columnar.count,
      offset: 1,
      rowOffset: result.columnar.rowOffset,
      batchRowCount: 4,
    });
  });

  it("emits one span per page and a before/error span when a window is over its ceiling", async () => {
    const observer = recorder();
    const pages = [];
    for await (const page of columnarBatchToResultPages(pointBatch(4), {
      maxFeatures: 2,
      pageSize: 2,
      telemetry: observer.telemetry,
    })) {
      pages.push(page);
    }
    await flush();

    expect(pages).toHaveLength(2);
    expect(observer.trace()).toEqual([
      "before:columnar-result-conversion",
      "after:columnar-result-conversion",
      "before:columnar-result-conversion",
      "after:columnar-result-conversion",
    ]);

    observer.reset();
    expect(() => columnarBatchToResult(pointBatch(4), { maxFeatures: 1, telemetry: observer.telemetry })).toThrowError(
      expect.objectContaining({ name: "HonuaGeoArrowError", code: "row-limit-exceeded" }),
    );
    await flush();
    expect(observer.trace()).toEqual(["before:columnar-result-conversion", "error:columnar-result-conversion"]);
    expect(observer.terminal().detail).toMatchObject({ code: "row-limit-exceeded" });
  });
});

// ── Identity binding ─────────────────────────────────────────

describe("columnar telemetry identity binding (#1043)", () => {
  it("binds every span to the batch identity as a scope digest, never a raw scope", async () => {
    const scope = "scope:leak-canary-value";
    const observer = recorder();
    const bound = identity({ authorizationScope: scope });
    const batch = createGeoArrowBatch(pointInput(4, { identity: bound })).batch;
    const cacheIdentity = columnarBatchCacheFixtureIdentity({ authorizationScope: scope });
    const cache = createColumnarBatchCache(createMemoryColumnarBatchCacheStorage(), {
      telemetry: observer.telemetry,
    });
    const session = createColumnarWorkerSession({
      createWorker: hostedFactory((worked) => worked),
      telemetry: observer.telemetry,
    });

    columnarBatchToResult(batch, { maxFeatures: 10, telemetry: observer.telemetry });
    applyColumnarPatch(batch, appendPatch(500), { telemetry: observer.telemetry });
    await cache.read(cacheIdentity);
    await cache.write(columnarBatchCacheFixtureBatch(cacheIdentity));
    await leaseColumnarBatch(createGeoArrowBatch(pointInput(4, { identity: bound })).batch).transfer(() => {}, {
      telemetry: observer.telemetry,
    });
    await session.execute("transform", createGeoArrowBatch(pointInput(4, { identity: bound })).batch);
    await flush();

    const digest = await columnarAuthorizationScopeDigest(scope);
    const kinds = new Set(observer.recorded.map((entry) => entry.span.kind));
    expect(kinds).toEqual(
      new Set([
        "columnar-result-conversion",
        "columnar-patch-apply",
        "columnar-cache-read",
        "columnar-cache-write",
        "columnar-transfer",
        "columnar-worker-operation",
      ]),
    );
    for (const entry of observer.recorded) {
      expect(entry.span.identity, `${entry.hook}:${entry.span.kind} must carry an identity`).toBeDefined();
      expect(entry.span.identity).toMatchObject({
        planId: expect.any(String),
        schemaVersion: expect.any(String),
        sourceId: expect.any(String),
        sourceVersion: expect.any(String),
        authorizationScopeDigest: digest,
      });
      expect(JSON.stringify(entry.span)).not.toContain(scope);
    }
    session.dispose();
    cache.dispose();
  });

  it("delivers synchronously once a scope digest is memoized", async () => {
    const observer = recorder();
    const bound = identity({ authorizationScope: "scope:warm-path" });
    const batch = createGeoArrowBatch(pointInput(4, { identity: bound })).batch;

    columnarBatchToResult(batch, { maxFeatures: 10, telemetry: observer.telemetry });
    await flush();
    observer.reset();

    columnarBatchToResult(batch, { maxFeatures: 10, telemetry: observer.telemetry });
    // No flush: the memoized digest makes the whole span synchronous.
    expect(observer.trace()).toEqual(["before:columnar-result-conversion", "after:columnar-result-conversion"]);
  });
});

// ── Containment ──────────────────────────────────────────────

describe("columnar telemetry containment (#1043)", () => {
  const hostile: ColumnarTelemetry = {
    before: () => {
      throw new Error("hostile before");
    },
    after: () => {
      throw new Error("hostile after");
    },
    error: () => {
      throw new Error("hostile error");
    },
  };

  it("leaves every observed outcome and typed error unchanged", async () => {
    const unobservedPatch = applyColumnarPatch(pointBatch(), appendPatch(100));
    const observedPatch = applyColumnarPatch(pointBatch(), appendPatch(100), { telemetry: hostile });
    expect(observedPatch.outcome).toBe(unobservedPatch.outcome);
    expect(observedPatch).toMatchObject({
      metrics: (unobservedPatch as { metrics: unknown }).metrics,
      bufferIdentityPreserved: (unobservedPatch as { bufferIdentityPreserved: boolean }).bufferIdentityPreserved,
    });

    const unobservedResult = columnarBatchToResult(pointBatch(4), { maxFeatures: 10 });
    const observedResult = columnarBatchToResult(pointBatch(4), { maxFeatures: 10, telemetry: hostile });
    expect(observedResult.features).toEqual(unobservedResult.features);
    expect(observedResult.columnar).toEqual(unobservedResult.columnar);

    const receipt = await leaseColumnarBatch(pointBatch()).transfer(() => {}, { telemetry: hostile });
    const unobservedReceipt = await leaseColumnarBatch(pointBatch()).transfer(() => {});
    expect(receipt.metrics).toEqual(unobservedReceipt.metrics);

    expect(() => columnarBatchToResult(pointBatch(4), { maxFeatures: 1, telemetry: hostile })).toThrowError(
      expect.objectContaining({ name: "HonuaGeoArrowError", code: "row-limit-exceeded" }),
    );
    await expect(
      leaseColumnarBatch(pointBatch()).transfer(
        () => {
          throw new Error("consumer refused");
        },
        { telemetry: hostile },
      ),
    ).rejects.toMatchObject({ name: "HonuaColumnarTransferError", code: "transport-failed" });
    await flush();
  });

  it("binds no identity when an identity member throws", async () => {
    const observer = recorder();
    const hostileIdentity = Object.defineProperty({ ...identity() }, "authorizationScope", {
      get() {
        throw new Error("hostile scope getter");
      },
    }) as ColumnarBatchIdentityV1;

    const span = beginColumnarSpan(observer.telemetry, "columnar-transfer", hostileIdentity, { batchId: "hostile" });
    expect(span).toBeDefined();
    span?.finish({ rows: 1 });
    await flush();

    expect(observer.trace()).toEqual(["before:columnar-transfer", "after:columnar-transfer"]);
    expect(observer.terminal().identity).toBeUndefined();
    expect(observer.terminal().detail).toEqual({ batchId: "hostile", rows: 1 });
  });

  it("ignores a repeated terminal call", async () => {
    const observer = recorder();
    const span = beginColumnarSpan(observer.telemetry, "columnar-transfer", identity());
    span?.finish({ rows: 1 });
    span?.fail(new Error("too late"));
    await flush();

    expect(observer.trace()).toEqual(["before:columnar-transfer", "after:columnar-transfer"]);
  });
});

// ── Zero cost when absent ────────────────────────────────────

describe("columnar telemetry is zero cost when absent (#1043)", () => {
  it("performs no digest on any hot path when no sink is configured", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      const live = createPatchableGeoArrowBatch(pointInput(4), { reserve: { rows: 8 } });
      applyColumnarPatch(live.batch, appendPatch(100));
      columnarBatchToResult(pointBatch(4), { maxFeatures: 10 });
      for await (const _page of columnarBatchToResultPages(pointBatch(4), { maxFeatures: 2, pageSize: 2 })) {
        // Drain the traversal.
      }
      await leaseColumnarBatch(pointBatch()).transfer(() => {});
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it("starts no span for a sink that is not an object", () => {
    expect(
      beginColumnarSpan(undefined as unknown as ColumnarTelemetry, "columnar-transfer", identity()),
    ).toBeUndefined();
    expect(beginColumnarSpan(null as unknown as ColumnarTelemetry, "columnar-transfer", identity())).toBeUndefined();
  });

  it("delivers nothing for a sink that declares no hooks", async () => {
    const outcome = applyColumnarPatch(pointBatch(), appendPatch(100), { telemetry: {} });
    await flush();
    expect(outcome.outcome).toBe("rebuilt");
  });
});
