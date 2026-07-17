import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type CloudNativeAnalysisRejectedError,
  explainCloudNativeAnalysis,
  runCloudNativeAnalysis,
} from "../examples/overture-geoparquet/src/cloud-native-analysis.js";
import { planOvertureQuery } from "../examples/overture-geoparquet/src/planner.js";
import { fixtureRangeEvidence } from "../examples/overture-geoparquet/src/range-evidence.js";
import { FIXTURE_MANIFEST, OVERTURE_POLICY } from "../examples/overture-geoparquet/src/source-manifests.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor } from "../src/contract/types.js";
import type { DuckDbDriver } from "../src/geoparquet/driver.js";
import { GeoparquetRuntime, geoparquetSource } from "../src/geoparquet/index.js";
// @ts-expect-error — .mjs test helper has no declaration and test fixtures are excluded from tsc.
import { createNodeDuckDbDriver } from "./helpers/geoparquet-node-driver.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL("../examples/overture-geoparquet/public/overture-places.parquet", import.meta.url),
);
const AOI = [-158.3, 21.2, -157.65, 21.6] as const;

function workflowPlan(limit = 100) {
  return planOvertureQuery({ lane: "fixture", aoi: AOI, category: "all", limit }, OVERTURE_POLICY);
}

function descriptor(): SourceDescriptor {
  return {
    id: "overture-fixture-places",
    protocol: "geoparquet",
    locator: {
      url: "honua-resource://opaque",
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "native", bboxColumn: "bbox" },
    },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  };
}

function fixtureRows(count = 2): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `08f2a3c1d4e5f6${String(index + 1).padStart(2, "0")}`,
    name: `Fixture place ${index + 1}`,
    category: "civic",
    confidence: 0.99 - index / 100,
    bbox: { xmin: -157.86, ymin: 21.3, xmax: -157.86, ymax: 21.3 },
  }));
}

function harness(query: DuckDbDriver["query"]) {
  const sql: string[] = [];
  let closeCalls = 0;
  const driver: DuckDbDriver = {
    async run() {},
    async query(statement, options) {
      sql.push(statement);
      return query(statement, options);
    },
    async registerFileBuffer() {},
    async close() {
      closeCalls += 1;
    },
  };
  const runtime = new GeoparquetRuntime({ driverFactory: async () => driver });
  const source = geoparquetSource(descriptor(), { runtime });
  return { source, runtime, sql, closeCalls: () => closeCalls };
}

describe("Cloud-Native Spatial Analysis S1", () => {
  it("executes the committed raw GeoParquet fixture through the headless public runtime", async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const runtime = new GeoparquetRuntime({ driverFactory: createNodeDuckDbDriver });
    await runtime.registerFileBuffer(FIXTURE_MANIFEST.objects[0]?.url ?? "", new Uint8Array(bytes));
    const source = geoparquetSource(descriptor(), { runtime });
    const run = await runCloudNativeAnalysis({
      workflowPlan: workflowPlan(8),
      manifest: FIXTURE_MANIFEST,
      range: fixtureRangeEvidence(bytes.byteLength),
      source,
      runtime,
    });

    expect(run.result.features).toHaveLength(8);
    expect(run.result.features.map((feature) => feature.attributes.id)).toEqual([
      "08f2a3c1d4e5f601",
      "08f2a3c1d4e5f602",
      "08f2a3c1d4e5f603",
      "08f2a3c1d4e5f604",
      "08f2a3c1d4e5f605",
      "08f2a3c1d4e5f606",
      "08f2a3c1d4e5f607",
      "08f2a3c1d4e5f608",
    ]);
    expect(run.evidence.rows.returned).toMatchObject({ fidelity: "exact", value: 8 });
    expect(run.evidence.worker).toMatchObject({
      boundedExecution: { fidelity: "exact", value: true },
      cleanup: { fidelity: "exact", value: true },
    });
  });

  it("pins the raw fixture and returns a versioned, truth-qualified public-SDK receipt", async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    expect(bytes.byteLength).toBe(FIXTURE_MANIFEST.objects[0]?.bytes);
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(FIXTURE_MANIFEST.objects[0]?.etag);

    const execution = harness(async () => fixtureRows());
    const ticks = [10, 12, 20, 27];
    const run = await runCloudNativeAnalysis({
      workflowPlan: workflowPlan(),
      manifest: FIXTURE_MANIFEST,
      range: fixtureRangeEvidence(bytes.byteLength),
      source: execution.source,
      runtime: execution.runtime,
      now: () => ticks.shift() ?? 27,
    });

    expect(execution.closeCalls()).toBe(1);
    expect(execution.sql).toHaveLength(2);
    expect(execution.sql[0]).toBe("SET memory_limit='256MB'; SET threads=1; SET preserve_insertion_order=false;");
    expect(execution.sql[1]).toContain("read_parquet('overture-places.parquet'");
    expect(execution.sql[1]).toContain('"bbox".xmax');
    expect(run.result.features).toHaveLength(2);
    expect(run.evidence).toMatchObject({
      format: "honua.sdk.cloud-native-analysis-evidence.v1",
      schemaVersion: 1,
      workflow: "bounded-aoi-geoparquet",
      source: {
        lane: "fixture",
        release: "fixture-places-v1",
        schemaVersion: "fixture-v1",
        objectKey: "public/overture-places.parquet",
      },
      query: {
        aoi: AOI,
        limit: 100,
        plan: { version: "2.0", pushdown: "full", fidelity: "exact" },
      },
      io: {
        rangeBytes: { fidelity: "exact", value: bytes.byteLength },
        rangeRequests: { fidelity: "exact", value: 1 },
        filesSelected: { fidelity: "exact", value: 1 },
        filesExcluded: { fidelity: "exact", value: 0 },
      },
      pruning: {
        selectedObjectRows: { fidelity: "exact", value: 8 },
        candidateRowGroups: { fidelity: "exact", value: 1 },
        rowGroupsPruned: { fidelity: "unsupported", value: null },
      },
      rows: {
        returned: { fidelity: "exact", value: 2 },
        scanned: { fidelity: "unsupported", value: null },
      },
      memory: {
        engineCeilingBytes: { fidelity: "exact", value: 256 * 1024 * 1024 },
        resultCeilingBytes: { fidelity: "exact", value: 1024 * 1024 },
        observedPeakBytes: { fidelity: "unsupported", value: null },
      },
      cache: { policy: "bypass" },
      resultFidelity: { fidelity: "exact", value: "exact" },
      timing: { sdkPlanMs: 2, sourceProbeMs: 0, engineExecutionMs: 7, totalMs: 9 },
      worker: {
        boundedExecution: { fidelity: "exact", value: true },
        cleanup: { fidelity: "exact", value: true },
      },
      presentation: { fidelity: "unsupported", value: null },
    });
    expect(run.evidence.query.plan.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.evidence.cache.identity).toBe(`honua-query-plan:2.0:${run.evidence.query.plan.fingerprint}`);
    expect(JSON.stringify(run.evidence.query.plan)).not.toContain(FIXTURE_MANIFEST.objects[0]?.url);
    expect(JSON.stringify(run.evidence)).not.toContain("rows scanned: 8");
  });

  it("produces the same credential-free planner identity before execution", () => {
    const plan = workflowPlan();
    const first = explainCloudNativeAnalysis(plan, FIXTURE_MANIFEST, descriptor());
    const second = explainCloudNativeAnalysis(plan, FIXTURE_MANIFEST, descriptor());
    expect(second).toEqual(first);
    expect(first).toMatchObject({ version: "2.0", pushdown: "full", fidelity: "exact" });
    expect(JSON.stringify(first)).not.toContain(FIXTURE_MANIFEST.objects[0]?.url);
  });

  it("preserves adapter degradation as approximate instead of claiming exact fidelity", async () => {
    const execution = harness(async () => fixtureRows(1));
    const source = new Proxy(execution.source, {
      get(target, property, receiver) {
        if (property !== "protocol") return Reflect.get(target, property, receiver);
        return () => ({
          runtime: execution.runtime,
          async executeResolvedQuery() {
            return {
              features: [{ attributes: fixtureRows(1)[0]!, geometry: undefined }],
              exceededTransferLimit: false,
              degraded: [
                {
                  capability: "query" as const,
                  protocol: "geoparquet" as const,
                  sourceId: descriptor().id,
                  reason: "Fixture adapter reduced an exact predicate to its envelope.",
                },
              ],
            };
          },
        });
      },
    });
    const run = await runCloudNativeAnalysis({
      workflowPlan: workflowPlan(),
      manifest: FIXTURE_MANIFEST,
      range: fixtureRangeEvidence(FIXTURE_MANIFEST.objects[0]?.bytes ?? 0),
      source,
      runtime: execution.runtime,
    });

    expect(run.evidence.resultFidelity).toEqual({
      fidelity: "approximate",
      value: "approximate",
      reason: "Fixture adapter reduced an exact predicate to its envelope.",
    });
  });

  it("fails closed on unsupported ranges and output overflow and still cleans up", async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const unsupportedExecution = harness(async () => {
      throw new Error("engine must not start");
    });
    await expect(
      runCloudNativeAnalysis({
        workflowPlan: workflowPlan(),
        manifest: FIXTURE_MANIFEST,
        range: {
          ...fixtureRangeEvidence(bytes.byteLength),
          status: "unsupported",
          limitation: "Range transport is unavailable.",
        },
        source: unsupportedExecution.source,
        runtime: unsupportedExecution.runtime,
      }),
    ).rejects.toMatchObject({ code: "unsupported-range-io" });
    expect(unsupportedExecution.sql).toEqual([]);

    const overflowExecution = harness(async () => fixtureRows(3));
    await expect(
      runCloudNativeAnalysis({
        workflowPlan: workflowPlan(2),
        manifest: FIXTURE_MANIFEST,
        range: fixtureRangeEvidence(bytes.byteLength),
        source: overflowExecution.source,
        runtime: overflowExecution.runtime,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CloudNativeAnalysisRejectedError>>({
        code: "unsafe-materialization",
      }),
    );
    expect(overflowExecution.closeCalls()).toBe(1);

    const bytesExecution = harness(async () => [{ id: "one", name: "x".repeat(OVERTURE_POLICY.maxResultBytes) }]);
    await expect(
      runCloudNativeAnalysis({
        workflowPlan: workflowPlan(1),
        manifest: FIXTURE_MANIFEST,
        range: fixtureRangeEvidence(bytes.byteLength),
        source: bytesExecution.source,
        runtime: bytesExecution.runtime,
      }),
    ).rejects.toMatchObject({ code: "unsafe-materialization" });
    expect(bytesExecution.closeCalls()).toBe(1);
  });

  it("propagates cancellation through the accepted plan and closes the worker runtime", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execution = harness((statement, options) =>
      statement.startsWith("SET memory_limit")
        ? Promise.resolve([])
        : new Promise((_resolve, reject) => {
            markStarted();
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          }),
    );
    const controller = new AbortController();
    const pending = runCloudNativeAnalysis({
      workflowPlan: workflowPlan(),
      manifest: FIXTURE_MANIFEST,
      range: fixtureRangeEvidence(FIXTURE_MANIFEST.objects[0]?.bytes ?? 0),
      source: execution.source,
      runtime: execution.runtime,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "HonuaAbortError" });
    expect(execution.closeCalls()).toBe(1);
  });
});
