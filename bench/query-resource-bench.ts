import { performance } from "node:perf_hooks";

import { type SourceDescriptor, capabilities } from "../src/contract/types.js";
import {
  createGeoParquetResourceHandle,
  createGeoParquetResourceRegistry,
  explainQuery,
  queryPlanCacheKey,
  resolveGeoParquetResource,
  serializeQueryPlan,
} from "../src/query-planner/index.js";

const CONTEXT = "tenant:benchmark/role:reader";
const FIRST_PRIVATE_SOURCE =
  "https://AKIAIOSFODNN7EXAMPLE:benchmark-private@example.invalid/parcels.parquet?signature=first-private-value";
const ROTATED_PRIVATE_SOURCE = "https://storage.example.invalid/parcels.parquet?signature=rotated-private-value";
const PRIVATE_MARKERS = [
  "AKIAIOSFODNN7EXAMPLE",
  "benchmark-private",
  "first-private-value",
  "rotated-private-value",
] as const;

export interface QueryResourceHandleBenchmarkOptions {
  operationCount: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface QueryResourceHandleBenchmarkResult {
  samples: Array<{ totalDurationMs: number; operationsPerSecond: number }>;
  invariants: {
    checks: {
      exactOperationCount: boolean;
      planSurfacesRedacted: boolean;
      cacheStableAcrossRotation: boolean;
      scopePartitioned: boolean;
      resolverRoundTrip: boolean;
    };
    passed: boolean;
  };
}

interface QueryResourceHandleRun {
  sample: { totalDurationMs: number; operationsPerSecond: number };
  checks: QueryResourceHandleBenchmarkResult["invariants"]["checks"];
}

/** Deterministic in-process benchmark for opaque planning, persistence, cache identity, and resolution. */
export async function runQueryResourceHandleBenchmark(
  options: QueryResourceHandleBenchmarkOptions,
): Promise<QueryResourceHandleBenchmarkResult> {
  assertOptions(options);
  for (let run = 0; run < options.warmupRuns; run += 1) await runOnce(options.operationCount);
  const measured: QueryResourceHandleRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) {
    measured.push(await runOnce(options.operationCount));
  }
  const checks = {
    exactOperationCount: measured.every((run) => run.checks.exactOperationCount),
    planSurfacesRedacted: measured.every((run) => run.checks.planSurfacesRedacted),
    cacheStableAcrossRotation: measured.every((run) => run.checks.cacheStableAcrossRotation),
    scopePartitioned: measured.every((run) => run.checks.scopePartitioned),
    resolverRoundTrip: measured.every((run) => run.checks.resolverRoundTrip),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

async function runOnce(operationCount: number): Promise<QueryResourceHandleRun> {
  const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.benchmark" });
  let completed = 0;
  let planSurfacesRedacted = true;
  let cacheStableAcrossRotation = true;
  let resolverRoundTrip = true;
  try {
    const first = registry.register({
      id: "parcels:current",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:42",
      sources: [FIRST_PRIVATE_SOURCE],
    });
    const firstPlan = planFor(first, FIRST_PRIVATE_SOURCE);
    const firstCacheKey = queryPlanCacheKey(firstPlan);
    const rotated = registry.register({
      id: "parcels:current",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:42",
      sources: [ROTATED_PRIVATE_SOURCE],
    });
    const started = performance.now();
    for (let operation = 0; operation < operationCount; operation += 1) {
      const plan = planFor(rotated, ROTATED_PRIVATE_SOURCE);
      const serialized = serializeQueryPlan(plan);
      const cacheKey = queryPlanCacheKey(plan);
      const resolved = await resolveGeoParquetResource(rotated, registry.resolver, {
        authorizationContextId: CONTEXT,
      });
      planSurfacesRedacted &&= [JSON.stringify(plan), serialized, cacheKey].every((surface) =>
        PRIVATE_MARKERS.every((marker) => !surface.includes(marker)),
      );
      cacheStableAcrossRotation &&= cacheKey === firstCacheKey;
      resolverRoundTrip &&= resolved.sources.length === 1 && resolved.sources[0] === ROTATED_PRIVATE_SOURCE;
      completed += 1;
    }
    const totalDurationMs = performance.now() - started;
    const otherContext = createGeoParquetResourceHandle({
      resolver: "io.honua.benchmark",
      id: "parcels:current",
      authorizationContextId: "tenant:other/role:reader",
      resourceVersion: "snapshot:42",
    });
    const scopePartitioned = queryPlanCacheKey(planFor(otherContext, ROTATED_PRIVATE_SOURCE)) !== firstCacheKey;
    return {
      sample: {
        totalDurationMs,
        operationsPerSecond: (completed / Math.max(totalDurationMs, 0.001)) * 1_000,
      },
      checks: {
        exactOperationCount: completed === operationCount,
        planSurfacesRedacted,
        cacheStableAcrossRotation,
        scopePartitioned,
        resolverRoundTrip,
      },
    };
  } finally {
    registry.dispose();
  }
}

function planFor(handle: ReturnType<typeof createGeoParquetResourceHandle>, privateLocator: string) {
  const descriptor: SourceDescriptor = {
    id: "descriptor-id",
    protocol: "geoparquet",
    locator: {
      url: privateLocator,
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb" },
    },
    capabilities: capabilities(["query", "queryAggregate"]),
  };
  return explainQuery({
    descriptor,
    geoparquetResource: handle,
    authorizationScope: ["data:read"],
    schemaVersion: "schema:4",
    sourceVersion: "source:9",
    query: { where: "population > 10", outFields: ["id", "name"], pagination: { limit: 100 } },
  });
}

function assertOptions(options: QueryResourceHandleBenchmarkOptions): void {
  if (
    !Number.isInteger(options.operationCount) ||
    options.operationCount < 1 ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Opaque query resource benchmark options must be positive integers");
  }
}
