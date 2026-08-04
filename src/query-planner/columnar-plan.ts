/**
 * Plan-derived columnar batch identity.
 *
 * `ColumnarBatchIdentityV1` is the cache-key contract shipped by #940: source
 * id, source version, schema version, plan id, authorization scope, ordering,
 * and freshness together decide whether two batches are the same answer. Until
 * now the only source-side producer minted those fields itself, so
 * `columnarBatchCacheKey` keyed on a plan id no planner ever issued.
 *
 * This module closes that: every identity field except freshness is read from
 * an accepted {@link QueryExecutionPlan}, and `planId` is the plan's own
 * `validity.fingerprint`. A plan, schema, scope, or query change therefore
 * changes the cache key by construction rather than by convention.
 *
 * Freshness is the one execution-time input. Planning stays observation-clock
 * free — an observation instant in a plan would make the plan fingerprint
 * change on every explain — so the caller supplies it when the source is
 * actually read.
 *
 * The module imports only types from `../columnar/`, so it adds no runtime edge
 * to the columnar data plane.
 *
 * @module
 */

import type { ColumnarBatchIdentityV1, ColumnarOrderingKeyV1, ColumnarOrderingV1 } from "../columnar/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import { HonuaQueryPlanningError, type QueryExecutionPlan } from "./types.js";

/** Execution-time freshness evidence for a plan-produced batch. */
export interface ColumnarBatchIdentityFromPlanOptions {
  /**
   * RFC 3339 instant at which the source result was observed. Required, and
   * supplied at execution: it is deliberately not a plan input.
   */
  readonly observedAt: string;
  /** RFC 3339 instant after which the batch must be revalidated. */
  readonly staleAfter?: string;
  /** Opaque source validator, such as an HTTP ETag. Never a credential. */
  readonly validator?: string;
  /** Opaque monotonic source generation or revision. */
  readonly generation?: string;
}

/**
 * Derive the batch identity a columnar-selected plan implies.
 *
 * Field derivation:
 * - `planId` — the plan's `validity.fingerprint` verbatim, so two plans that
 *   are interchangeable for reuse share a cache entry and two that are not,
 *   do not. The broader `plan.fingerprint` also covers cost estimates, which
 *   change nothing about which rows come back, so it is deliberately not used.
 * - `sourceId` / `sourceVersion` / `schemaVersion` — the plan's declared source
 *   identity, falling back to the plan's own descriptor and schema fingerprints
 *   when the source declares no version string. Both fallbacks are plan-derived
 *   and change whenever the underlying identity changes.
 * - `authorizationScope` — the plan's authorization-scope *fingerprint*, never
 *   the raw scope values.
 * - `ordering` — the canonical query's `orderBy`, as an ordering contract.
 * - `freshness` — from {@link ColumnarBatchIdentityFromPlanOptions}.
 *
 * @throws HonuaCapabilityNotSupportedError when the plan did not select
 *   columnar execution. A columnar identity minted from an object plan would
 *   let a batch claim provenance the planner never granted.
 */
export function columnarBatchIdentityFromPlan(
  plan: QueryExecutionPlan,
  options: ColumnarBatchIdentityFromPlanOptions,
): ColumnarBatchIdentityV1 {
  if (plan.validity.representation !== "columnar") {
    throw new HonuaCapabilityNotSupportedError("columnar-execution", plan.ir.source.protocol, plan.ir.source.id, {
      context: { representation: plan.validity.representation, reason: plan.representation.reason },
    });
  }
  const observedAt = requireText(options.observedAt, "observedAt");
  return Object.freeze({
    sourceId: plan.ir.source.id,
    sourceVersion: plan.ir.source.sourceVersion ?? plan.provenance.source.descriptorFingerprint,
    schemaVersion: plan.ir.source.schemaVersion ?? plan.validity.schemaFingerprint,
    planId: plan.validity.fingerprint,
    authorizationScope: plan.provenance.authorizationScope.fingerprint,
    ordering: planOrdering(plan),
    freshness: Object.freeze({
      observedAt,
      ...(options.staleAfter === undefined ? {} : { staleAfter: requireText(options.staleAfter, "staleAfter") }),
      ...(options.validator === undefined ? {} : { validator: requireText(options.validator, "validator") }),
      ...(options.generation === undefined ? {} : { generation: requireText(options.generation, "generation") }),
    }),
  });
}

/**
 * The ordering contract the plan's canonical query establishes.
 *
 * Null placement is declared `last` because the compiled DuckDB `ORDER BY`
 * emits no explicit `NULLS` clause and DuckDB's default null order is
 * `NULLS LAST`; the identity states the order the rows actually arrive in
 * rather than leaving it unspecified. A batch whose schema does not carry
 * every ordering key is refused when the batch is created — the identity is
 * never quietly loosened to match a narrower batch.
 */
function planOrdering(plan: QueryExecutionPlan): ColumnarOrderingV1 {
  const orderBy = plan.ir.query.orderBy ?? [];
  const keys: ColumnarOrderingKeyV1[] = orderBy.map((sort) =>
    Object.freeze({
      field: sort.field,
      direction: sort.direction === "desc" ? ("descending" as const) : ("ascending" as const),
      nulls: "last" as const,
    }),
  );
  return Object.freeze({ stable: keys.length > 0, keys: Object.freeze(keys) });
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HonuaQueryPlanningError("invalid-query", `columnar batch identity ${label} must be a non-empty string`);
  }
  return value;
}
