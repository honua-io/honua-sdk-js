import type { Result, Source } from "../contract/types.js";
import { canonicalStringify, toJsonValue } from "./canonical.js";
import { queryFromCanonical, queryIrSourceIdentity } from "./ir.js";
import { aggregateLocally } from "./local-aggregate.js";
import { hashQueryPlan } from "./planner.js";
import {
  type ExecuteQueryPlanOptions,
  HonuaQueryPlanExecutionError,
  type LocalAggregatePlanStep,
  type QueryExecutionPlanV1,
  type QueryPlanExecution,
  type RemoteQueryPlanStep,
} from "./types.js";

/** Execute an already-reviewed plan. This function validates; it never replans. */
export async function executeQueryPlan<T>(
  plan: QueryExecutionPlanV1,
  source: Source<T>,
  options: ExecuteQueryPlanOptions = {},
): Promise<QueryPlanExecution<T>> {
  assertPlanIntegrity(plan);
  assertPlanContext(plan, source, options);
  const remote = plan.steps[0];
  if (!remote || remote.engine !== "remote") {
    throw new HonuaQueryPlanExecutionError("invalid-plan", "A query plan must begin with a remote step");
  }
  const remoteResult = await executeRemote(remote, source, options.signal);
  const local = plan.steps[1];
  const result = local ? executeLocal(plan, local, remoteResult) : remoteResult;
  return { planId: plan.id, fingerprint: plan.fingerprint, result };
}

function assertPlanIntegrity(plan: QueryExecutionPlanV1): void {
  if (hashQueryPlan(plan) !== plan.fingerprint) {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "Plan content does not match its fingerprint; explain the query again instead of executing a mutated plan",
    );
  }
}

function assertPlanContext<T>(plan: QueryExecutionPlanV1, source: Source<T>, options: ExecuteQueryPlanOptions): void {
  const current = queryIrSourceIdentity(source.descriptor, options);
  if (canonicalStringify(toJsonValue(current)) !== canonicalStringify(toJsonValue(plan.ir.source))) {
    throw new HonuaQueryPlanExecutionError(
      "plan-context-mismatch",
      "Source identity, version, capabilities, or authorization scope changed after planning; explain a replacement plan",
    );
  }
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
  plan: QueryExecutionPlanV1,
  step: LocalAggregatePlanStep | RemoteQueryPlanStep,
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
