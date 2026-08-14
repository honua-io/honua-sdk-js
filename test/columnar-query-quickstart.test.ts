import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  HONUA_ARROW_FIXTURE_BYTES,
  HONUA_ARROW_FIXTURE_SHA256,
  honuaArrowFixtureBytes,
} from "../examples/columnar-query-quickstart/src/fixture.js";
import {
  COLUMNAR_BUDGETS,
  COLUMNAR_QUERY,
  createFixtureWorkflow,
} from "../examples/columnar-query-quickstart/src/workflow.js";
import { ColumnarWorkflowError } from "../src/columnar-workflow/index.js";

describe("columnar query quickstart", () => {
  it("embeds the exact reviewed Honua Server Arrow fixture", async () => {
    const canonical = await readFile("test/fixtures/columnar/honua-server-geoarrow-02-point.arrow");
    const embedded = honuaArrowFixtureBytes();
    expect(embedded.byteLength).toBe(HONUA_ARROW_FIXTURE_BYTES);
    expect(Buffer.from(embedded)).toEqual(canonical);
    expect(createHash("sha256").update(embedded).digest("hex")).toBe(HONUA_ARROW_FIXTURE_SHA256);
  });

  it("executes a bounded server-pushdown plan and records exact resource evidence", async () => {
    const workflow = createFixtureWorkflow(0);
    try {
      const plan = workflow.session.plan(COLUMNAR_QUERY);
      expect(plan.execution).toBe("server-pushdown");
      expect(plan.pushdown).toEqual(["columns", "filter", "bbox", "limit", "orderBy"]);
      expect(plan.boundedBy).toEqual(COLUMNAR_BUDGETS);
      expect(plan.request?.url).toContain("f=arrow");
      expect(plan.request?.url).toContain("resultRecordCount=25");

      const results = [];
      for await (const result of workflow.session.stream(COLUMNAR_QUERY)) results.push(result);
      expect(results).toHaveLength(1);
      expect(results[0]?.evidence).toMatchObject({
        execution: "server-pushdown",
        rows: 1,
        batches: 1,
        transferBytes: HONUA_ARROW_FIXTURE_BYTES,
        ceilings: COLUMNAR_BUDGETS,
      });
      expect(results[0]?.evidence.peakBackingBytes).toBeGreaterThan(0);
      expect(results[0]?.evidence.peakBackingBytes).toBeLessThanOrEqual(COLUMNAR_BUDGETS.maxBackingBytes);
      expect(workflow.lastRequest).toMatchObject({ method: "GET" });
      expect(workflow.lastRequest?.url).toContain("/rest/services/Interoperability/Harbors/FeatureServer/0/query");

      const handoff = workflow.session.table(results[0]!.batch, COLUMNAR_QUERY.limit);
      expect(handoff.truncated).toBe(false);
      expect(handoff.rows).toEqual([
        {
          geometry: [-157.8583, 21.3069],
          timestamp: 1704164645000n,
          dictionaryValue: "Honolulu Harbor",
          featureId: 1,
        },
      ]);
    } finally {
      await workflow.session.dispose();
    }
  });

  it("propagates cancellation before admitting a fixture batch", async () => {
    const workflow = createFixtureWorkflow(100);
    const controller = new AbortController();
    const consume = async () => {
      for await (const _result of workflow.session.stream({ ...COLUMNAR_QUERY, signal: controller.signal })) {
        throw new Error("A cancelled run must not emit a batch.");
      }
    };
    const pending = consume();
    controller.abort(new DOMException("test cancellation", "AbortError"));
    try {
      await expect(pending).rejects.toSatisfy(
        (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ABORTED",
      );
    } finally {
      await workflow.session.dispose();
    }
  });
});
