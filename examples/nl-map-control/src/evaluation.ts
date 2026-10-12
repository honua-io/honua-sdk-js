import { HonuaAskMapClarification, HonuaNlMapControlError, createNlMapControl } from "@honua/sdk-js/nl-map-control";
import { type DuckDbDriver, createBrowserDuckDbDriver } from "../../../src/geoparquet/driver.js";
import corpus from "../evaluation.v1.json" with { type: "json" };
import { CRS, FIXTURE_VERSION, ORIGIN, SCHEMA } from "./fixture.js";
import { type QueryResult, createIncidentRuntime, initializeFixture, reviewQuery } from "./map-runtime.js";
import { authenticatedLiveModel, groundedModel, recordedModel } from "./model.js";
import type { IncidentQuery, QueryContext } from "./query.js";

/** A semantically correct but late result does not meet the bounded sample gate. */
export function enforceEvaluationDeadline<T extends { passed: boolean; elapsedMs: number }>(result: T) {
  const latencyExceeded = !Number.isFinite(result.elapsedMs) || result.elapsedMs > corpus.bounds.elapsedMs;
  return { ...result, passed: result.passed && !latencyExceeded, latencyExceeded };
}

/** Semantic oracles are committed IDs/counts, never recalculated by this harness. */
export async function evaluateRecordedQueries(
  driver: DuckDbDriver,
  liveIdentity?: {
    readonly provider: string;
    readonly model: string;
    readonly sourceCommit: string;
    readonly harnessSha256: string;
  },
) {
  const engine = await driver.query("SELECT version() AS version");
  const previous = new Map<string, IncidentQuery>();
  const results = [];
  for (const entry of corpus.cases) {
    const offsets = entry.viewportOffsets ?? [-1100, -1100, 1100, 1100];
    const context: QueryContext = {
      sourceId: "incidents",
      sourceVersion: FIXTURE_VERSION,
      schemaFingerprint: SCHEMA.fingerprint,
      authorizationContextId: "public-fixture",
      mode: liveIdentity ? "live" : "recorded",
      viewport: [ORIGIN[0] + offsets[0], ORIGIN[1] + offsets[1], ORIGIN[0] + offsets[2], ORIGIN[1] + offsets[3]],
      ...(entry.selectedOffset
        ? { selectedLocation: [ORIGIN[0] + entry.selectedOffset[0], ORIGIN[1] + entry.selectedOffset[1]] as const }
        : {}),
      ...(entry.previous ? { previousQuery: previous.get(entry.previous) } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), corpus.bounds.elapsedMs);
    const runtime = createIncidentRuntime(driver, context, controller.signal);
    const recorded = recordedModel(context);
    const control = createNlMapControl({
      tools: { runtime, tools: ["runWidgetQuery"] },
      llm: groundedModel(
        context,
        liveIdentity
          ? authenticatedLiveModel("/api/ask-map/propose", liveIdentity)
          : entry.operation === "quoted-status"
            ? async () => ({
                toolCalls: [
                  {
                    name: "runWidgetQuery",
                    arguments: {
                      sourceId: "incidents",
                      kind: "count",
                      semanticQuery: {
                        kind: "features",
                        geometry: "omit",
                        select: ["id", "status", "kind"],
                        filter: {
                          kind: "comparison",
                          operator: "eq",
                          left: { kind: "property", name: "status" },
                          right: { kind: "literal", value: "open' OR 1=1 --" },
                        },
                        page: { kind: "first", limit: 100 },
                      },
                    },
                  },
                ],
              })
            : entry.operation === "polygon-intersects"
              ? async () => ({
                  toolCalls: [
                    {
                      name: "runWidgetQuery",
                      arguments: {
                        sourceId: "incidents",
                        kind: "count",
                        semanticQuery: {
                          kind: "features",
                          geometry: "omit",
                          select: ["id", "status", "kind"],
                          filter: {
                            kind: "spatial",
                            operator: "intersects",
                            geometry: {
                              state: "present",
                              layout: "xy",
                              crs: CRS,
                              geometry: {
                                type: "Polygon",
                                coordinates: [entry.polygonOffsets!.map(([x, y]) => [ORIGIN[0] + x, ORIGIN[1] + y])],
                              },
                            },
                          },
                          page: { kind: "first", limit: 100 },
                        },
                      },
                    },
                  ],
                })
              : recorded,
      ),
      policy: { maxPlanSteps: 1, maxSelfCorrections: 2 },
      validateStep(call) {
        try {
          if (call.name !== "runWidgetQuery") throw new Error("Only incident queries are admitted");
          reviewQuery(call.args, context);
          return [];
        } catch (error) {
          return [{ code: "capability-gap", message: error instanceof Error ? error.message : String(error) }];
        }
      },
    });
    const started = performance.now();
    try {
      const plan = await control.propose(entry.prompt ?? "Recorded polygon intersection", {
        signal: controller.signal,
      });
      const call = plan.steps[0]?.call;
      if (call?.name !== "runWidgetQuery") throw new Error("Unexpected tool");
      const reviewed = reviewQuery(call.args, context);
      const execution = await control.execute(plan, { signal: controller.signal });
      if (execution.outcome !== "succeeded") throw new Error("Query execution failed");
      previous.set(entry.id, reviewed.compiled.query);
      const data = (execution.results[0]?.data as { data: QueryResult }).data;
      const ids = data.features.map((row) => row.id).sort((a, b) => a - b);
      const groups = data.groups
        ? Object.fromEntries(data.groups.map((row) => [String(row.kind), row.count]))
        : undefined;
      const passed =
        JSON.stringify(ids) === JSON.stringify(entry.expectedIds) &&
        (!entry.expectedGroups ||
          (Object.entries(entry.expectedGroups).every(([key, count]) => groups?.[key] === count) &&
            Object.keys(groups ?? {}).length === Object.keys(entry.expectedGroups).length));
      results.push({
        id: entry.id,
        passed,
        outcome: "succeeded",
        ids,
        groups,
        elapsedMs: performance.now() - started,
        modelAttempts: plan.attempt,
        planFingerprint: plan.fingerprint,
        receiptDigest: execution.receipt.receiptDigest,
      });
    } catch (error) {
      const outcome =
        error instanceof HonuaAskMapClarification
          ? "clarification"
          : error instanceof HonuaNlMapControlError && error.code === "refusal"
            ? "refused"
            : "failed";
      results.push({
        id: entry.id,
        passed: entry.expectedOutcome === outcome,
        outcome,
        elapsedMs: performance.now() - started,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  const admitted = results.map(enforceEvaluationDeadline);
  const supported = admitted.filter(
    (result) => corpus.cases.find((entry) => entry.id === result.id)?.expectedIds !== undefined,
  );
  const guarded = admitted.filter(
    (result) => corpus.cases.find((entry) => entry.id === result.id)?.expectedOutcome !== undefined,
  );
  const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  return {
    schema: "honua.ask-map-evaluation-result/v1",
    metrics: {
      supportedCorrect: supported.filter((result) => result.passed).length,
      supportedTotal: supported.length,
      safeOutcomesCorrect: guarded.filter((result) => result.passed).length,
      safeOutcomesTotal: guarded.length,
      unexpectedExecutions: guarded.filter((result) => result.outcome === "succeeded").length,
      failures: admitted.filter((result) => !result.passed).map((result) => result.id),
      latencyFailures: admitted.filter((result) => result.latencyExceeded).map((result) => result.id),
      latencyMs: { median: latencies[Math.floor(latencies.length / 2)], maximum: latencies.at(-1) },
    },
    mode: liveIdentity ? "live" : "recorded",
    model: liveIdentity?.model ?? "committed-exact-responses",
    ...(liveIdentity ? { identity: liveIdentity } : {}),
    fixture: FIXTURE_VERSION,
    engine: { name: "DuckDB-WASM", version: engine[0]?.version },
    schemaFingerprint: SCHEMA.fingerprint,
    results: admitted,
    passed: admitted.every((result) => result.passed),
    liveModelEvidence: Boolean(liveIdentity),
  };
}

export async function evaluateRecordedQueriesInBrowser(liveIdentity?: {
  readonly provider: string;
  readonly model: string;
  readonly sourceCommit: string;
  readonly harnessSha256: string;
}) {
  const driver = await createBrowserDuckDbDriver({
    bundle: {
      mainModule: new URL("duckdb/duckdb-eh.wasm", document.baseURI).href,
      mainWorker: new URL("duckdb/duckdb-browser-eh.worker.js", document.baseURI).href,
    },
    extensionRepository: new URL("duckdb/extensions", document.baseURI).href,
    preloadExtensions: ["parquet"],
  });
  try {
    await initializeFixture(driver);
    return await evaluateRecordedQueries(driver, liveIdentity);
  } finally {
    await driver.close();
  }
}
