import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ColumnarWorkflowError,
  type ColumnarWorkflowSource,
  openColumnarSession,
} from "../src/columnar-workflow/index.js";
import type { ColumnarBatchMetrics, ColumnarBatchV1 } from "../src/columnar/index.js";

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
  assert.equal(results[0]?.evidence.transferBytes, 128);
});

test("fails closed before a request when the row budget is exceeded", () => {
  const session = openColumnarSession(serverSource, { budgets: { maxRows: 5 } });
  assert.throws(
    () => session.plan({ limit: 6 }),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ROW_LIMIT_EXCEEDED",
  );
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

test("keeps direct execution bounded and surfaces metadata", async () => {
  const direct: ColumnarWorkflowSource = {
    kind: "direct-geoparquet",
    id: "local-parcels",
    url: "https://example.test/parcels.parquet",
    sourceVersion: "etag-v1",
    schemaVersion: "geo-1.1",
    authorizationScope: "public",
  };
  const session = openColumnarSession(direct, {
    openDirectGeoParquet: async () => ({
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
  for await (const result of session.stream({ columns: ["zone"], limit: 2 })) results.push(result);
  assert.equal(results[0]?.evidence.execution, "browser-bounded");
});

test("provides explicit worker, render, and download handoffs", () => {
  const session = openColumnarSession(serverSource);
  assert.equal(session.worker(batch).kind, "worker");
  assert.equal(session.render(batch, "point").zeroCopyPreferred, true);
  const download = session.download({ limit: 25 });
  assert.equal(download.suggestedFileName, "bounded-parcels.arrow");
});
