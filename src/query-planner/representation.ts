/**
 * Deterministic result-representation selection for the query planner.
 *
 * The planner's {@link QueryPlanExecutionMode} axis answers *when* rows are
 * delivered (`snapshot` vs `delta`). This module adds the orthogonal axis that
 * answers *what shape* they arrive in: protocol-neutral `Result` feature
 * objects, or a `ColumnarBatchV1`.
 *
 * Selection is metadata-only and reproducible by inspection. It reads the
 * declared source identity (protocol plus physical geometry encoding) and the
 * caller's {@link QueryPlanningEstimates}; it never reads result data, never
 * constructs a worker, and never performs I/O. Two callers who explain the same
 * query against the same declared source get the same decision, and therefore
 * the same plan fingerprint.
 *
 * Capability honesty is the governing rule: a source that cannot serve columnar
 * plans `object` and records why, and an explicit unsatisfiable pin throws
 * {@link HonuaCapabilityNotSupportedError}. There is no silent fallback that
 * would report a representation execution cannot deliver.
 *
 * @module
 */

import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  type CanonicalQuery,
  type DuckDbGeometryEncoding,
  HonuaQueryPlanningError,
  QUERY_PLAN_DIAGNOSTICS_VERSION,
  type QueryIrSourceIdentity,
  type QueryIrSourceIdentityV2,
  type QueryIrV1,
  type QueryIrV2,
  type QueryPlanRepresentation,
  type QueryPlanRepresentationDecisionV1,
  type QueryPlanRepresentationInputsV1,
  type QueryPlanRepresentationReason,
  type QueryPlanRepresentationRequest,
  type QueryPlanningEstimates,
} from "./types.js";

/**
 * Estimated rows at or above which `representation: "auto"` selects columnar.
 *
 * Set at the SDK's bounded-local materialization ceiling
 * (`MAX_LOCAL_MATERIALIZATION_ROWS`): below it a result is small enough that
 * feature objects stay affordable, at or above it the per-row object cost is
 * exactly the problem a columnar batch exists to remove.
 */
export const COLUMNAR_REPRESENTATION_MIN_ROWS = 100_000;

/** Estimated payload bytes at or above which `representation: "auto"` selects columnar. */
export const COLUMNAR_REPRESENTATION_MIN_BYTES = 8 * 1024 * 1024;

/**
 * Physical geometry encodings with an executable columnar producer today.
 *
 * These are the GeoParquet 1.1 native encodings that map 1:1 onto a Honua
 * GeoArrow geometry kind, so a batch can be produced without inventing a
 * geometry type. The multi-part encodings (`geoarrow-multipoint`,
 * `geoarrow-multilinestring`, `geoarrow-multipolygon`) are deliberately absent:
 * this SDK's dependency-free GeoArrow mapping has no multi-part kind, and
 * re-labelling their parts as a single-part column would misreport the
 * geometry.
 */
export const COLUMNAR_REPRESENTATION_ENCODINGS: readonly DuckDbGeometryEncoding[] = Object.freeze([
  "geoarrow-linestring",
  "geoarrow-point",
  "geoarrow-polygon",
]);

/** True for a declared geometry encoding that has an executable columnar producer. */
export function isColumnarRepresentationEncoding(
  encoding: DuckDbGeometryEncoding | undefined,
): encoding is DuckDbGeometryEncoding {
  return encoding !== undefined && COLUMNAR_REPRESENTATION_ENCODINGS.includes(encoding);
}

/** Validate a caller-supplied representation request; `undefined` means `auto`. */
export function normalizeRepresentationRequest(value: unknown): QueryPlanRepresentationRequest {
  if (value === undefined) return "auto";
  if (value !== "auto" && value !== "object" && value !== "columnar") {
    throw new HonuaQueryPlanningError("invalid-query", "representation is invalid");
  }
  return value;
}

type SourceIdentity = QueryIrSourceIdentity | QueryIrSourceIdentityV2;

interface ColumnarCapability {
  readonly supported: boolean;
  /** Why columnar is unavailable; unused when `supported` is true. */
  readonly reason: QueryPlanRepresentationReason;
  readonly geometryEncoding?: DuckDbGeometryEncoding;
}

function declaredGeometryEncoding(source: SourceIdentity): DuckDbGeometryEncoding | undefined {
  return source.protocol === "geoparquet" ? source.geoparquet?.geometryEncoding : undefined;
}

/**
 * Decide whether this source and query can be served columnar, from declared
 * metadata alone. Reasons are ordered most-fundamental first so the recorded
 * reason names the constraint a caller would have to change first.
 */
function columnarCapability(source: SourceIdentity, query: CanonicalQuery): ColumnarCapability {
  const geometryEncoding = declaredGeometryEncoding(source);
  const encoded = geometryEncoding === undefined ? {} : { geometryEncoding };
  if (source.protocol !== "geoparquet") {
    return { supported: false, reason: "protocol-not-columnar", ...encoded };
  }
  if (!isColumnarRepresentationEncoding(geometryEncoding)) {
    return { supported: false, reason: "encoding-not-columnar", ...encoded };
  }
  if (query.aggregation !== undefined) {
    return { supported: false, reason: "aggregation-not-columnar", ...encoded };
  }
  if (query.returnGeometry === false) {
    return { supported: false, reason: "geometry-not-requested", ...encoded };
  }
  return { supported: true, reason: "workload-above-threshold", ...encoded };
}

function meetsColumnarThreshold(estimates: QueryPlanningEstimates): boolean {
  if (estimates.rows !== undefined && estimates.rows >= COLUMNAR_REPRESENTATION_MIN_ROWS) return true;
  return estimates.bytes !== undefined && estimates.bytes >= COLUMNAR_REPRESENTATION_MIN_BYTES;
}

/**
 * Select the plan's result representation.
 *
 * @throws HonuaCapabilityNotSupportedError when `requested` is `"columnar"` and
 *   the declared source or query cannot serve it. Failing closed here is the
 *   point: an unsatisfiable pin must never quietly become object execution.
 */
export function createQueryPlanRepresentationDecision(
  ir: QueryIrV1 | QueryIrV2,
  estimates: QueryPlanningEstimates,
  requested: QueryPlanRepresentationRequest,
): QueryPlanRepresentationDecisionV1 {
  const capability = columnarCapability(ir.source, ir.query);
  if (requested === "columnar" && !capability.supported) {
    throw new HonuaCapabilityNotSupportedError("columnar-execution", ir.source.protocol, ir.source.id, {
      context: { representation: "columnar", reason: capability.reason },
    });
  }
  const inputs: QueryPlanRepresentationInputsV1 = {
    ...(capability.geometryEncoding === undefined ? {} : { geometryEncoding: capability.geometryEncoding }),
    rowThreshold: COLUMNAR_REPRESENTATION_MIN_ROWS,
    byteThreshold: COLUMNAR_REPRESENTATION_MIN_BYTES,
    ...(estimates.rows === undefined ? {} : { estimatedRows: estimates.rows }),
    ...(estimates.bytes === undefined ? {} : { estimatedBytes: estimates.bytes }),
  };
  const available: readonly QueryPlanRepresentation[] = capability.supported
    ? Object.freeze(["object", "columnar"] as const)
    : Object.freeze(["object"] as const);
  const { selected, reason } = selectRepresentation(capability, estimates, requested);
  return Object.freeze({
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    requested,
    selected,
    available,
    reason,
    inputs: Object.freeze(inputs),
  });
}

function selectRepresentation(
  capability: ColumnarCapability,
  estimates: QueryPlanningEstimates,
  requested: QueryPlanRepresentationRequest,
): { readonly selected: QueryPlanRepresentation; readonly reason: QueryPlanRepresentationReason } {
  if (requested !== "auto") return { selected: requested, reason: "explicit-pin" };
  if (!capability.supported) return { selected: "object", reason: capability.reason };
  if (estimates.rows === undefined && estimates.bytes === undefined) {
    return { selected: "object", reason: "estimate-unavailable" };
  }
  return meetsColumnarThreshold(estimates)
    ? { selected: "columnar", reason: "workload-above-threshold" }
    : { selected: "object", reason: "workload-below-threshold" };
}
