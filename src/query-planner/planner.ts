import type { AggregationSpec } from "../contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import { compileGeoServicesQuery } from "./geoservices.js";
import { createQueryIr, deepFreeze } from "./ir.js";
import {
  type CanonicalQuery,
  type ExplainQueryOptions,
  HonuaQueryPlanningError,
  MAX_LOCAL_MATERIALIZATION_ROWS,
  QUERY_PLAN_KIND,
  QUERY_PLAN_VERSION,
  type QueryExecutionPlanV1,
  type QueryFallbackPolicy,
  type QueryPlanStep,
} from "./types.js";

export function explainQuery<T>(options: ExplainQueryOptions<T>): QueryExecutionPlanV1 {
  const ir = createQueryIr(options);
  const capabilityPolicy = options.capabilityPolicy ?? "strict";
  const fallback = normalizeFallback(options.fallback);
  const estimates = normalizeEstimates(options.estimates);
  let steps: readonly QueryPlanStep[];
  let pushdown: QueryExecutionPlanV1["pushdown"];
  const warnings: string[] = [];

  if (ir.query.aggregation && !ir.source.capabilities.includes("queryAggregate")) {
    if (capabilityPolicy !== "degraded" || fallback.mode === "disabled") {
      throw new HonuaQueryPlanningError(
        capabilityPolicy === "degraded" ? "fallback-disabled" : "capability-not-supported",
        `Source "${ir.source.id}" does not support queryAggregate; select degraded policy with an explicit bounded-local fallback to proceed`,
      );
    }
    if (!ir.source.capabilities.includes("query")) {
      throw new HonuaQueryPlanningError(
        "capability-not-supported",
        `Source "${ir.source.id}" cannot run the bounded fallback because it does not support query`,
      );
    }
    rejectUnsafeEstimate(fallback, estimates.rows, estimates.bytes);
    const inputQuery = localAggregateInputQuery(
      ir.query,
      ir.query.aggregation,
      fallback.maxRows,
      options.descriptor.schema?.primaryKey,
    );
    steps = [
      {
        id: "remote-input",
        engine: "remote",
        operation: "queryAll",
        pushdown: "partial",
        fidelity: "exact",
        reason: `Push filters and projection to GeoServices, fetching at most ${fallback.maxRows + 1} rows as an overflow sentinel.`,
        requests: estimates.requests ?? 1,
        query: inputQuery,
        compiled: compileGeoServicesQuery(ir.source, inputQuery),
      },
      {
        id: "local-aggregate",
        engine: "client",
        operation: "aggregate",
        pushdown: "none",
        fidelity: "exact",
        reason: `queryAggregate is unavailable; compute only after enforcing the ${fallback.maxRows}-row local ceiling.`,
        inputStepId: "remote-input",
        aggregation: ir.query.aggregation,
        maxRows: fallback.maxRows,
        ...(fallback.maxBytes !== undefined ? { maxBytes: fallback.maxBytes } : {}),
      },
    ];
    pushdown = "partial";
    warnings.push("Execution is degraded and will be rejected if the bounded input ceiling is exceeded.");
  } else {
    const capability = ir.query.aggregation ? "queryAggregate" : "query";
    if (!ir.source.capabilities.includes(capability)) {
      throw new HonuaQueryPlanningError(
        "capability-not-supported",
        `Source "${ir.source.id}" does not support ${capability}`,
      );
    }
    steps = [
      {
        id: "remote-query",
        engine: "remote",
        operation: ir.query.aggregation ? "queryAggregate" : "query",
        pushdown: "full",
        fidelity: "exact",
        reason: "GeoServices can execute the complete canonical query remotely.",
        requests: estimates.requests ?? 1,
        query: ir.query,
        compiled: compileGeoServicesQuery(ir.source, ir.query),
      },
    ];
    pushdown = "full";
  }

  const unsigned = {
    kind: QUERY_PLAN_KIND,
    version: QUERY_PLAN_VERSION,
    ir,
    capabilityPolicy,
    fallback,
    pushdown,
    fidelity: "exact" as const,
    cache: "bypass" as const,
    estimates,
    steps,
    warnings,
  };
  const fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
  return deepFreeze({
    ...unsigned,
    id: `plan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
    fingerprint,
  });
}

export function hashQueryPlan(plan: QueryExecutionPlanV1): `sha256:${string}` {
  const { id: _id, fingerprint: _fingerprint, ...unsigned } = plan;
  return sha256(canonicalStringify(toJsonValue(unsigned)));
}

function normalizeFallback(fallback?: QueryFallbackPolicy): QueryFallbackPolicy {
  if (!fallback || fallback.mode === "disabled") return deepFreeze({ mode: "disabled" });
  if (!Number.isSafeInteger(fallback.maxRows) || fallback.maxRows < 1) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      "bounded-local maxRows must be a positive safe integer",
    );
  }
  if (fallback.maxRows > MAX_LOCAL_MATERIALIZATION_ROWS) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      `bounded-local maxRows ${fallback.maxRows} exceeds the SDK safety ceiling ${MAX_LOCAL_MATERIALIZATION_ROWS}`,
    );
  }
  if (fallback.maxBytes !== undefined && (!Number.isSafeInteger(fallback.maxBytes) || fallback.maxBytes < 1)) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      "bounded-local maxBytes must be a positive safe integer",
    );
  }
  return deepFreeze({
    mode: "bounded-local",
    maxRows: fallback.maxRows,
    ...(fallback.maxBytes !== undefined ? { maxBytes: fallback.maxBytes } : {}),
  });
}

function normalizeEstimates(estimates?: ExplainQueryOptions["estimates"]): QueryExecutionPlanV1["estimates"] {
  const out: { rows?: number; bytes?: number; requests?: number } = {};
  for (const key of ["rows", "bytes", "requests"] as const) {
    const value = estimates?.[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new HonuaQueryPlanningError("invalid-query", `estimates.${key} must be a finite non-negative number`);
    }
    out[key] = value;
  }
  return deepFreeze(out);
}

function rejectUnsafeEstimate(
  fallback: Extract<QueryFallbackPolicy, { mode: "bounded-local" }>,
  rows?: number,
  bytes?: number,
): void {
  if (rows !== undefined && rows > fallback.maxRows) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      `Estimated input ${rows} rows exceeds bounded-local maxRows ${fallback.maxRows}`,
    );
  }
  if (fallback.maxBytes !== undefined && bytes !== undefined && bytes > fallback.maxBytes) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      `Estimated input ${bytes} bytes exceeds bounded-local maxBytes ${fallback.maxBytes}`,
    );
  }
}

function localAggregateInputQuery(
  query: CanonicalQuery,
  aggregation: AggregationSpec,
  maxRows: number,
  primaryKey?: string,
): CanonicalQuery {
  if (aggregation.histogram || aggregation.timeSeries) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "The first bounded-local compiler supports metrics and groupBy; histogram/timeSeries remain follow-on work",
    );
  }
  const requiredFields = new Set<string>(aggregation.groupBy ?? []);
  for (const metric of aggregation.metrics) {
    if (metric.field !== "*") requiredFields.add(metric.field);
  }
  if (requiredFields.size === 0 && primaryKey) requiredFields.add(primaryKey);
  const {
    aggregation: _aggregation,
    orderBy: _orderBy,
    pagination: _pagination,
    outFields: _outFields,
    ...base
  } = query;
  return deepFreeze({
    ...base,
    ...(requiredFields.size > 0 ? { outFields: [...requiredFields].sort() } : {}),
    returnGeometry: false,
    pagination: { offset: 0, limit: maxRows + 1 },
  });
}
