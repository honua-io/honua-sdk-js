import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ColumnarWorkflowError,
  type ColumnarWorkflowSource,
  openColumnarSession,
} from "../src/columnar-workflow/index.js";
import { type ColumnarBatchMetrics, type ColumnarBatchV1, createGeoArrowBatch } from "../src/columnar/index.js";

const batch = Object.freeze({ kind: "fixture-columnar-batch" }) as unknown as ColumnarBatchV1;
const metrics = Object.freeze({ rowCount: 2, backingBytes: 128 }) as unknown as ColumnarBatchMetrics;

const serverSource: ColumnarWorkflowSource = {
  kind: "honua-feature-query",
  id: "bounded-parcels",
  baseUrl: "https://example.test/",
  serviceId: "Parcels",
  layerId: 0,
  format: "arrow",
  sourceVersion: "fixture-v1",
  schemaVersion: "fixture-v1",
  authorizationScope: "public",
};

const directSource: ColumnarWorkflowSource = {
  kind: "direct-geoparquet",
  id: "local-parcels",
  url: "https://example.test/parcels.parquet",
  sourceVersion: "etag-v1",
  schemaVersion: "geo-1.1",
  authorizationScope: "public",
};

test("plans bounded columns, bbox, filter, sorting, and aggregation as server pushdown", () => {
  const session = openColumnarSession(serverSource);
  const plan = session.plan({
    columns: ["zone", "value"],
    bbox: [-158.1, 21.2, -157.6, 21.8],
    filter: {
      kind: "comparison",
      operator: "gte",
      left: { kind: "property", name: "value" },
      right: { kind: "literal", value: 100 },
    },
    aggregations: [{ name: "total", operation: "sum", field: "value" }],
    orderBy: [{ field: "value", direction: "desc" }],
    limit: 250,
  });
  assert.equal(plan.execution, "server-pushdown");
  assert.deepEqual(plan.pushdown, ["columns", "filter", "bbox", "limit", "orderBy", "aggregations"]);
  assert.match(plan.request?.url ?? "", /f=arrow/);
  assert.match(plan.request?.url ?? "", /resultRecordCount=250/);
  assert.match(plan.request?.url ?? "", /outStatistics=/);
});

test("streams fixture batches through the normal request pipeline", async () => {
  const requests: Request[] = [];
  const session = openColumnarSession(serverSource, {
    clientOptions: {
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    },
    decodeServerResponse: async function* ({ response }) {
      assert.equal(response.status, 200);
      yield batch;
    },
    inspectBatch: () => metrics,
  });
  const results = [];
  for await (const result of session.stream({ columns: ["zone"], limit: 10 })) results.push(result);
  assert.equal(requests.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.evidence.rows, 2);
  assert.equal(results[0]?.evidence.transferBytes, 3);
});

test("fails closed before a request when the row budget is exceeded", () => {
  const session = openColumnarSession(serverSource, { budgets: { maxRows: 5 } });
  assert.throws(
    () => session.plan({ limit: 6 }),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ROW_LIMIT_EXCEEDED",
  );
});

test("rejects invalid offsets before planning either execution lane", () => {
  for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => openColumnarSession(serverSource).plan({ limit: 5, offset }),
      (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
    );
    assert.throws(
      () => openColumnarSession(directSource).plan({ limit: 5, offset }),
      (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
    );
  }
});

test("rejects inverted bounding boxes before planning either execution lane", () => {
  for (const bbox of [
    [10, 0, -10, 5],
    [-10, 5, 10, -5],
  ] as const) {
    assert.throws(
      () => openColumnarSession(serverSource).plan({ limit: 5, bbox }),
      (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
    );
    assert.throws(
      () => openColumnarSession(directSource).plan({ limit: 5, bbox }),
      (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
    );
  }
});

test("rejects fieldless aggregations before constructing a server request", () => {
  const session = openColumnarSession(serverSource);
  assert.throws(
    () => session.plan({ limit: 10, aggregations: [{ name: "total", operation: "count" }] }),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
  );
});

test("rejects spatial filter expressions instead of silently dropping their geometry", () => {
  const session = openColumnarSession(serverSource);
  assert.throws(
    () =>
      session.plan({
        filter: {
          kind: "spatial",
          operator: "intersects",
          geometry: {
            geometry: { xmin: -158, ymin: 21, xmax: -157, ymax: 22 },
            geometryType: "esriGeometryEnvelope",
          },
        },
        limit: 10,
      }),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
  );
});

test("preserves a deployment path prefix in planned request URLs", () => {
  const session = openColumnarSession({ ...serverSource, baseUrl: "https://example.test/honua/" });
  const plan = session.plan({ limit: 10 });
  assert.equal(new URL(plan.request?.url ?? "").pathname, "/honua/rest/services/Parcels/FeatureServer/0/query");
});

test("preserves folder-prefixed GeoServices ids in planned request URLs", () => {
  const session = openColumnarSession({ ...serverSource, serviceId: "Planning/Public Parcels" });
  const plan = session.plan({ limit: 10 });
  assert.equal(
    new URL(plan.request?.url ?? "").pathname,
    "/rest/services/Planning/Public%20Parcels/FeatureServer/0/query",
  );
});

test("trims adversarial trailing slashes in linear time when planning request URLs", () => {
  const session = openColumnarSession({
    ...serverSource,
    baseUrl: `https://example.test/honua${"/".repeat(50_000)}`,
  });
  const plan = session.plan({ limit: 10 });
  assert.equal(new URL(plan.request?.url ?? "").pathname, "/honua/rest/services/Parcels/FeatureServer/0/query");
});

test("requires an explicit decoder for server payloads", async () => {
  const session = openColumnarSession(serverSource, {
    clientOptions: { fetchFn: async () => new Response(new Uint8Array([1]), { status: 200 }) },
  });
  await assert.rejects(
    async () => {
      for await (const _result of session.stream({ limit: 1 })) {
        // Decoder check fails before emission.
      }
    },
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "DECODER_REQUIRED",
  );
});

test("discards server error bodies before the shared pipeline can parse them", async () => {
  let cancelled = false;
  const session = openColumnarSession(serverSource, {
    clientOptions: {
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 400 },
        ),
    },
    decodeServerResponse: async function* () {
      yield batch;
    },
    inspectBatch: () => metrics,
  });

  await assert.rejects(
    async () => {
      for await (const _result of session.stream({ limit: 1 })) {
        // The request fails before decode.
      }
    },
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "REQUEST_FAILED",
  );
  assert.equal(cancelled, true);
});

test("bounds successful responses before after interceptors inspect them", async () => {
  let afterCalled = false;
  let cancelled = false;
  const session = openColumnarSession(serverSource, {
    budgets: { maxTransferBytes: 8 },
    clientOptions: {
      interceptors: [
        {
          after: async ({ response }) => {
            afterCalled = true;
            await response.arrayBuffer();
          },
        },
      ],
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(16));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    },
    decodeServerResponse: async function* () {
      yield batch;
    },
    inspectBatch: () => metrics,
  });

  await assert.rejects(
    async () => {
      for await (const _result of session.stream({ limit: 2 })) {
        // Preparation rejects before after hooks or decode.
      }
    },
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "TRANSFER_LIMIT_EXCEEDED",
  );
  assert.equal(afterCalled, false);
  assert.equal(cancelled, true);
});

test("keeps prepared response bytes readable after an interceptor consumes its clone", async () => {
  const observed: number[][] = [];
  const session = openColumnarSession(serverSource, {
    budgets: { maxTransferBytes: 8, maxBackingBytes: 8 },
    clientOptions: {
      interceptors: [
        {
          after: async ({ response }) => {
            observed.push([...new Uint8Array(await response.arrayBuffer())]);
          },
        },
      ],
      fetchFn: async () => new Response(new Uint8Array([1, 2, 3])),
    },
    decodeServerResponse: async function* ({ response }) {
      observed.push([...new Uint8Array(await response.arrayBuffer())]);
      yield batch;
    },
    inspectBatch: () => ({ rowCount: 2, backingBytes: 3 }) as unknown as ColumnarBatchMetrics,
  });

  const results = [];
  for await (const result of session.stream({ limit: 2 })) results.push(result);
  assert.equal(results.length, 1);
  assert.deepEqual(observed, [
    [1, 2, 3],
    [1, 2, 3],
  ]);
});

test("honors a smaller backing ceiling while materializing a server response", async () => {
  let cancelled = false;
  const session = openColumnarSession(serverSource, {
    budgets: { maxTransferBytes: 64, maxBackingBytes: 8 },
    clientOptions: {
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(16));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    },
    decodeServerResponse: async function* () {
      yield batch;
    },
  });

  await assert.rejects(
    async () => {
      for await (const _result of session.stream({ limit: 2 })) {
        // Preparation rejects before decode.
      }
    },
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "BACKING_LIMIT_EXCEEDED",
  );
  assert.equal(cancelled, true);
});

test("keeps direct execution bounded and surfaces metadata", async () => {
  const session = openColumnarSession(directSource, {
    openDirectGeoParquet: async () => ({
      transferBytes: 96,
      describe: () => ({
        schema: [{ name: "zone", type: "VARCHAR" }],
        geometryEncoding: "geoarrow.point",
        bbox: [-158, 21, -157, 22],
        rowEstimate: 2,
        rowGroupCount: 1,
      }),
      queryColumnar: () => batch,
    }),
    inspectBatch: () => metrics,
  });
  const description = await session.inspect();
  assert.equal(description.geometryEncoding, "geoarrow.point");
  assert.deepEqual(description.bbox, [-158, 21, -157, 22]);
  assert.equal(description.rowGroupCount, 1);
  const results = [];
  for await (const result of session.stream({ limit: 2 })) results.push(result);
  assert.equal(results[0]?.evidence.execution, "browser-bounded");
  assert.equal(results[0]?.evidence.transferBytes, 96);
});

test("rejects unsupported direct column projections before opening the source", () => {
  let opened = false;
  const session = openColumnarSession(directSource, {
    openDirectGeoParquet: () => {
      opened = true;
      return { describe: () => ({}), queryColumnar: () => batch };
    },
  });
  assert.throws(
    () => session.plan({ columns: ["zone"], limit: 2 }),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
  );
  assert.equal(opened, false);
});

test("validates every configured budget before exposing a session", () => {
  const invalidBudgets = [
    { maxRows: Number.NaN },
    { maxBatches: Number.POSITIVE_INFINITY },
    { maxTransferBytes: undefined },
    { maxBackingBytes: 0 },
  ];
  for (const budgets of invalidBudgets) {
    assert.throws(
      () =>
        openColumnarSession(serverSource, {
          budgets: budgets as unknown as Partial<{
            maxRows: number;
            maxBatches: number;
            maxTransferBytes: number;
            maxBackingBytes: number;
          }>,
        }),
      (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_QUERY",
    );
  }
});

test("bounds the default direct GeoParquet network read before DuckDB can scan it", async () => {
  let cancelled = false;
  const session = openColumnarSession(directSource, {
    budgets: { maxTransferBytes: 8, maxBackingBytes: 8 },
    directFetchFn: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(16));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "16" } },
      ),
  });

  await assert.rejects(
    session.inspect(),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "TRANSFER_LIMIT_EXCEEDED",
  );
  assert.equal(cancelled, true);
});

test("shares an in-flight direct opener and closes the resulting handle once", async () => {
  let openCount = 0;
  let closeCount = 0;
  let resolveHandle: (handle: {
    describe(): Record<string, never>;
    queryColumnar(): ColumnarBatchV1;
    close(): void;
  }) => void = () => undefined;
  const pendingHandle = new Promise<{
    describe(): Record<string, never>;
    queryColumnar(): ColumnarBatchV1;
    close(): void;
  }>((resolve) => {
    resolveHandle = resolve;
  });
  const session = openColumnarSession(directSource, {
    openDirectGeoParquet: () => {
      openCount += 1;
      return pendingHandle;
    },
  });

  const first = session.inspect();
  const second = session.inspect();
  assert.equal(openCount, 1);
  resolveHandle({
    describe: () => ({}),
    queryColumnar: () => batch,
    close: () => {
      closeCount += 1;
    },
  });
  await Promise.all([first, second]);
  await session.dispose();
  assert.equal(closeCount, 1);
});

test("keeps a shared direct opener alive when one caller cancels", async () => {
  const firstController = new AbortController();
  let openerSignal: AbortSignal | undefined;
  let resolveHandle: (handle: {
    describe(): Record<string, never>;
    queryColumnar(): ColumnarBatchV1;
  }) => void = () => undefined;
  const pendingHandle = new Promise<{
    describe(): Record<string, never>;
    queryColumnar(): ColumnarBatchV1;
  }>((resolve) => {
    resolveHandle = resolve;
  });
  const session = openColumnarSession(directSource, {
    openDirectGeoParquet: (_source, signal) => {
      openerSignal = signal;
      return pendingHandle;
    },
  });

  const first = session.inspect(firstController.signal);
  const second = session.inspect();
  assert.notEqual(openerSignal, firstController.signal);
  firstController.abort(new Error("cancel only the first waiter"));
  await assert.rejects(first, (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ABORTED");
  assert.equal(openerSignal?.aborted, false);

  resolveHandle({ describe: () => ({}), queryColumnar: () => batch });
  assert.equal((await second).sourceId, directSource.id);
  await session.dispose();
  assert.equal(openerSignal?.aborted, true);
});

test("clears a rejected direct opener so a later inspection can retry", async () => {
  let openCount = 0;
  const session = openColumnarSession(directSource, {
    openDirectGeoParquet: async () => {
      openCount += 1;
      if (openCount === 1) throw new Error("temporary opener failure");
      return { describe: () => ({}), queryColumnar: () => batch };
    },
  });

  await assert.rejects(session.inspect(), /temporary opener failure/);
  assert.deepEqual(await session.inspect(), {
    sourceId: directSource.id,
    execution: "browser-bounded",
    format: "parquet",
    schema: undefined,
    geometryEncoding: undefined,
    crs: undefined,
    bbox: undefined,
    rowEstimate: undefined,
    rowGroupCount: undefined,
    raw: {},
  });
  assert.equal(openCount, 2);
});

test("propagates cancellation through direct metadata inspection", async () => {
  const direct: ColumnarWorkflowSource = { ...directSource, id: "abortable-parcels" };
  let receivedSignal: AbortSignal | undefined;
  let cancelled = false;
  let markDescribeStarted: () => void = () => undefined;
  const describeStarted = new Promise<void>((resolve) => {
    markDescribeStarted = resolve;
  });
  const session = openColumnarSession(direct, {
    openDirectGeoParquet: async () => ({
      describe: (signal) => {
        receivedSignal = signal;
        markDescribeStarted();
        return new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      queryColumnar: () => batch,
    }),
  });
  const controller = new AbortController();
  const pending = session.inspect(controller.signal);
  await describeStarted;
  controller.abort(new Error("stop inspection"));

  await assert.rejects(pending, (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ABORTED");
  assert.equal(receivedSignal, controller.signal);
  assert.equal(cancelled, true);
});

test("does not mark a table truncated when its row count exactly matches the handoff limit", () => {
  const exactBatch = createGeoArrowBatch({
    id: "table:0",
    sequence: 0,
    schemaId: "table-v1",
    identity: {
      sourceId: "table",
      sourceVersion: "v1",
      schemaVersion: "table-v1",
      planId: "table-plan",
      authorizationScope: "public",
      ordering: { stable: false, keys: [] },
      freshness: { observedAt: "2026-08-09T00:00:00Z" },
    },
    geometry: {
      kind: "point",
      values: [
        [-157.8, 21.3],
        [-157.7, 21.4],
      ],
    },
  }).batch;
  const handoff = openColumnarSession(serverSource).table(exactBatch, 2);
  assert.equal(handoff.rows.length, 2);
  assert.equal(handoff.truncated, false);
});

test("provides explicit worker, render, and download handoffs", () => {
  const session = openColumnarSession(serverSource);
  assert.equal(session.worker(batch).kind, "worker");
  assert.equal(session.worker(batch, "projection").operation, "projection");
  assert.throws(
    () => session.worker(batch, " "),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "UNSUPPORTED_HANDOFF",
  );
  assert.equal(session.render(batch, "point").zeroCopyPreferred, true);
  const download = session.download({ limit: 25 });
  assert.equal(download.suggestedFileName, "bounded-parcels.arrow");
});
