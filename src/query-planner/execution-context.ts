import type { Source } from "../contract/types.js";
import { canonicalStringify, toJsonValue } from "./canonical.js";
import { createPlanValidity, createQueryPlanProvenance } from "./diagnostics.js";
import { queryIrSourceIdentity } from "./ir.js";
import {
  type ExecuteQueryPlanOptions,
  HonuaQueryPlanExecutionError,
  type QueryExecutionPlanV1,
  type QueryIrSourceIdentity,
} from "./types.js";

/** @internal Shared lightweight accepted-plan context boundary for v1 consumers. */
export function assertQueryPlanExecutionContextV1<T>(
  plan: QueryExecutionPlanV1,
  source: Source<T>,
  options: ExecuteQueryPlanOptions,
): void {
  const current = queryIrSourceIdentity(source.descriptor, options);
  const executionMode = options.executionMode ?? plan.validity.executionMode;
  const currentIr = { ...plan.ir, source: current };
  const currentProvenance = createQueryPlanProvenance(source.descriptor, current, options);
  // Representation is plan-bound, not source-bound: it is re-asserted here so
  // the validity fingerprint recomputes identically, never re-decided.
  const currentValidity = createPlanValidity(
    currentIr,
    currentProvenance,
    plan.capabilityPolicy,
    plan.fallback,
    executionMode,
    plan.validity.representation,
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

function sameForeignSourceIdentity(current: QueryIrSourceIdentity, planned: QueryIrSourceIdentity): boolean {
  const omitMutableBindings = (value: QueryIrSourceIdentity): Record<string, unknown> => {
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
