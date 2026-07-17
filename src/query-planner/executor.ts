import type { Query, Result, Source } from "../contract/types.js";
import { HonuaAbortError } from "../core/errors.js";
import { canonicalStringify, toJsonValue } from "./canonical.js";
import { createPlanValidity, createQueryPlanProvenance } from "./diagnostics.js";
import { queryFromCanonical, queryIrSourceIdentity, queryIrSourceIdentityV2 } from "./ir.js";
import { aggregateLocally } from "./local-aggregate.js";
import { validateQueryPlanSnapshot } from "./planner.js";
import { parseGeoParquetResourceHandle, resolveGeoParquetResource } from "./resource.js";
import {
  type ExecuteQueryPlanOptions,
  type GeoParquetRemoteQueryPlanStepV2,
  HonuaQueryPlanExecutionError,
  type LocalAggregatePlanStep,
  type QueryExecutionPlan,
  type QueryExecutionPlanV2,
  type QueryPlanExecution,
  type RemoteQueryPlanStep,
} from "./types.js";

/** Execute an already-reviewed plan. This function validates; it never replans. */
export async function executeQueryPlan<T>(
  plan: QueryExecutionPlan,
  source: Source<T>,
  options: ExecuteQueryPlanOptions = {},
): Promise<QueryPlanExecution<T>> {
  const acceptedPlan = validateQueryPlanSnapshot(plan);
  assertPlanContext(acceptedPlan, source, options);
  const remote = acceptedPlan.steps[0];
  if (!remote || remote.engine !== "remote") {
    throw new HonuaQueryPlanExecutionError("invalid-plan", "A query plan must begin with a remote step");
  }
  const remoteResult =
    acceptedPlan.version === "2.0"
      ? await executeGeoParquetRemote(acceptedPlan, remote as GeoParquetRemoteQueryPlanStepV2, source, options)
      : await executeRemote(remote as RemoteQueryPlanStep, source, options.signal);
  const local = acceptedPlan.steps[1];
  const result = local ? executeLocal(acceptedPlan, local, remoteResult) : remoteResult;
  return { planId: acceptedPlan.id, fingerprint: acceptedPlan.fingerprint, result };
}

function assertPlanContext<T>(plan: QueryExecutionPlan, source: Source<T>, options: ExecuteQueryPlanOptions): void {
  const current =
    plan.version === "2.0"
      ? queryIrSourceIdentityV2(source.descriptor, plan.ir.source.geoparquet.resource, options)
      : queryIrSourceIdentity(source.descriptor, options);
  const executionMode = options.executionMode ?? plan.validity.executionMode;
  const currentIr = { ...plan.ir, source: current } as QueryExecutionPlan["ir"];
  const currentProvenance = createQueryPlanProvenance(source.descriptor, current, options);
  const currentValidity = createPlanValidity(
    currentIr,
    currentProvenance,
    plan.capabilityPolicy,
    plan.fallback,
    executionMode,
  );
  if (currentValidity.fingerprint === plan.validity.fingerprint) return;

  if (!sameForeignSourceIdentity(current, plan.ir.source)) {
    throw planContextError("foreign-plan", "source-identity-changed");
  }
  if (!sameJson(current.authorizationScope, plan.ir.source.authorizationScope)) {
    throw planContextError("foreign-plan", "authorization-scope-changed");
  }
  if (executionMode !== plan.validity.executionMode) {
    throw planContextError("foreign-plan", "execution-mode-changed");
  }
  if (current.sourceVersion !== plan.ir.source.sourceVersion) {
    throw planContextError("stale-plan", "source-version-changed");
  }
  if (
    current.schemaVersion !== plan.ir.source.schemaVersion ||
    !sameJson(currentProvenance.schema, plan.provenance.schema)
  ) {
    throw planContextError("stale-plan", "schema-changed");
  }
  if (!sameJson(current.capabilities, plan.ir.source.capabilities)) {
    throw planContextError("stale-plan", "capabilities-changed");
  }
  if (!sameJson(currentProvenance.discovery, plan.provenance.discovery)) {
    throw planContextError("stale-plan", "discovery-changed");
  }
  throw planContextError("stale-plan", "source-identity-changed");
}

function sameForeignSourceIdentity(
  current: QueryExecutionPlan["ir"]["source"],
  planned: QueryExecutionPlan["ir"]["source"],
): boolean {
  const omitMutableBindings = (value: QueryExecutionPlan["ir"]["source"]): Record<string, unknown> => {
    const {
      authorizationScope: _authorizationScope,
      capabilities: _capabilities,
      schemaVersion: _schemaVersion,
      sourceVersion: _sourceVersion,
      ...identity
    } = value;
    return identity;
  };
  return sameJson(omitMutableBindings(current), omitMutableBindings(planned));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalStringify(toJsonValue(left)) === canonicalStringify(toJsonValue(right));
}

function planContextError(
  code: "stale-plan" | "foreign-plan",
  reason: NonNullable<HonuaQueryPlanExecutionError["reason"]>,
): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError(
    code,
    `${code === "stale-plan" ? "Query plan context is stale" : "Query plan belongs to a foreign context"}; explain a replacement plan`,
    { context: { reason } },
    reason,
  );
}

interface ResolvedGeoParquetPlanInput<T> {
  readonly sources: readonly string[];
  readonly operation: GeoParquetRemoteQueryPlanStepV2["operation"];
  readonly query: Query<T>;
  readonly sourceId: string;
  readonly geometry?: {
    readonly column: string;
    readonly encoding: "wkb" | "native" | "geojson";
    readonly bboxColumn?: string;
  };
}

async function executeGeoParquetRemote<T>(
  plan: QueryExecutionPlanV2,
  step: GeoParquetRemoteQueryPlanStepV2,
  source: Source<T>,
  options: ExecuteQueryPlanOptions,
): Promise<Result<T>> {
  const handle = parseGeoParquetResourceHandle(plan.ir.source.geoparquet.resource);
  if (
    typeof options.authorizationContextId !== "string" ||
    options.authorizationContextId !== handle.authorizationContextId ||
    typeof options.geoParquetResourceResolver !== "function"
  ) {
    throw new HonuaQueryPlanExecutionError("resource-unavailable", "GeoParquet resource is unavailable");
  }
  const resolved = await resolveGeoParquetResource(handle, options.geoParquetResourceResolver, {
    authorizationContextId: options.authorizationContextId,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (signalAborted(options.signal)) throw new HonuaAbortError();

  let adapterValue: unknown;
  try {
    adapterValue = source.protocol("geoparquet");
  } catch {
    throw resourceExecutionFailed();
  }
  const executeResolvedQuery = safeAdapterMethod(adapterValue, "executeResolvedQuery");
  if (!executeResolvedQuery) throw resourceExecutionFailed();
  const geometryColumn = plan.ir.source.geoparquet.geometryColumn;
  try {
    const result = (await Reflect.apply(executeResolvedQuery, adapterValue, [
      {
        sources: resolved.sources,
        operation: step.operation,
        query: queryFromCanonical<T>(step.query, options.signal),
        sourceId: plan.ir.source.id,
        ...(geometryColumn
          ? {
              geometry: {
                column: geometryColumn,
                encoding: plan.ir.source.geoparquet.geometryEncoding ?? "wkb",
                ...(plan.ir.source.geoparquet.bboxColumn ? { bboxColumn: plan.ir.source.geoparquet.bboxColumn } : {}),
              },
            }
          : {}),
      } satisfies ResolvedGeoParquetPlanInput<T>,
    ])) as Result<T>;
    if (signalAborted(options.signal)) throw new HonuaAbortError();
    return result;
  } catch {
    if (signalAborted(options.signal)) throw new HonuaAbortError();
    throw resourceExecutionFailed();
  }
}

const MAX_ADAPTER_PROTOTYPE_DEPTH = 16;

/** Resolve a data-method without invoking accessors or unbounded prototype traps. */
function safeAdapterMethod(value: unknown, key: string): ((...args: unknown[]) => unknown) | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const visited = new Set<object>();
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < MAX_ADAPTER_PROTOTYPE_DEPTH; depth += 1) {
      if (visited.has(current)) return undefined;
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (!signal) return false;
  try {
    return signal.aborted;
  } catch {
    return true;
  }
}

function resourceExecutionFailed(): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError("resource-execution-failed", "GeoParquet resource execution failed");
}

function executeRemote<T>(step: RemoteQueryPlanStep, source: Source<T>, signal?: AbortSignal): Promise<Result<T>> {
  const query = queryFromCanonical<T>(step.query, signal);
  switch (step.operation) {
    case "query":
      return source.query(query);
    case "queryAll":
      return source.queryAll(query);
    case "queryAggregate":
      if (!query.aggregation) {
        throw new HonuaQueryPlanExecutionError("invalid-plan", "queryAggregate step is missing aggregation intent");
      }
      return source.queryAggregate({ ...query, aggregation: query.aggregation });
  }
}

function executeLocal<T>(
  plan: QueryExecutionPlan,
  step: LocalAggregatePlanStep | RemoteQueryPlanStep | GeoParquetRemoteQueryPlanStepV2,
  remoteResult: Result<T>,
): Result<T> {
  if (step.engine !== "client" || step.operation !== "aggregate" || plan.steps.length !== 2) {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "The first planner version supports one bounded local aggregate step",
    );
  }
  if (step.inputStepId !== plan.steps[0]?.id) {
    throw new HonuaQueryPlanExecutionError("invalid-plan", "Local aggregate input does not reference the remote step");
  }
  if (remoteResult.features.length > step.maxRows || remoteResult.exceededTransferLimit) {
    throw new HonuaQueryPlanExecutionError(
      "unsafe-materialization",
      `Bounded-local input exceeded ${step.maxRows} rows; use server pushdown or a columnar execution engine`,
    );
  }
  if (step.maxBytes !== undefined) {
    const actualBytes = new TextEncoder().encode(JSON.stringify(remoteResult.features)).byteLength;
    if (actualBytes > step.maxBytes) {
      throw new HonuaQueryPlanExecutionError(
        "unsafe-materialization",
        `Bounded-local input measured ${actualBytes} bytes, exceeding maxBytes ${step.maxBytes}`,
      );
    }
  }
  const aggregateRows = aggregateLocally(remoteResult.features, step.aggregation, plan.ir.query);
  return {
    features: [],
    exceededTransferLimit: false,
    aggregateRows,
    degraded: [
      {
        capability: "queryAggregate",
        reason: `queryAggregate executed locally after enforcing a ${step.maxRows}-row materialization ceiling.`,
        protocol: plan.ir.source.protocol,
        sourceId: plan.ir.source.id,
      },
    ],
  };
}
