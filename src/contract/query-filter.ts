/**
 * Canonical typed query filter — the protocol-neutral semantic filter AST that
 * `Source.query()` accepts on the stable surface, plus the per-protocol
 * compilers that lower it onto each wire dialect.
 *
 * The AST mirrors the experimental `/query-planner` semantic filter (comparison,
 * list, range, null, pattern, spatial, temporal, boolean composition) with two
 * deliberate contract-layer differences:
 *
 * - Spatial predicates carry the same canonical geometry value the rest of the
 *   contract uses (`SpatialFilter`-shaped `geometry` + `geometryType`, produced
 *   by `envelope()` / `point()` / `polygon()`), so a filter composes with
 *   `Query.spatialFilter` without a second geometry vocabulary.
 * - Compilation is schema-free. The planner's semantic compilers verify a
 *   `SourceSchemaV2` before emitting; the canonical surface has no verified
 *   schema at query time, so literals are typed by the value the caller wrote.
 *
 * Every compiler in this module fails closed: a construct the target protocol
 * cannot express exactly throws `HonuaCapabilityNotSupportedError` naming the
 * construct and the protocol. Nothing is silently dropped and nothing is
 * silently widened; a widening that is genuinely safe (the GeoParquet bbox
 * reduction) is reported through `Result.degraded` by its adapter.
 *
 * @module
 */

import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { SpatialFilter } from "../core/spatial-filter.js";
import type { EsriGeometryType, EsriSpatialRel } from "../core/types.js";

// ── AST ───────────────────────────────────────────────────────

/** Literal values a canonical filter may compare against. */
export type QueryFilterScalar = string | number | boolean | null;

/** Reference to a source field (attribute, geometry, or temporal column). */
export interface QueryFilterPropertyNode {
  readonly kind: "property";
  readonly name: string;
}

/** Scalar literal operand. */
export interface QueryFilterLiteralNode {
  readonly kind: "literal";
  readonly value: QueryFilterScalar;
}

export type QueryFilterComparisonOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export interface QueryFilterComparisonNode {
  readonly kind: "comparison";
  readonly operator: QueryFilterComparisonOperator;
  readonly left: QueryFilterPropertyNode;
  readonly right: QueryFilterLiteralNode;
}

export interface QueryFilterListNode {
  readonly kind: "list";
  readonly operator: "in";
  readonly operand: QueryFilterPropertyNode;
  readonly values: readonly QueryFilterLiteralNode[];
}

export interface QueryFilterRangeNode {
  readonly kind: "range";
  readonly operator: "between";
  readonly operand: QueryFilterPropertyNode;
  readonly lower: QueryFilterLiteralNode;
  readonly upper: QueryFilterLiteralNode;
}

export interface QueryFilterNullNode {
  readonly kind: "null";
  readonly operator: "is-null" | "is-not-null";
  readonly operand: QueryFilterPropertyNode;
}

export interface QueryFilterPatternNode {
  readonly kind: "pattern";
  readonly operator: "like";
  readonly operand: QueryFilterPropertyNode;
  /** SQL-style pattern using `%` (any run) and `_` (single character). */
  readonly pattern: string;
  /** Defaults to `true`. `false` requests a case-insensitive match. */
  readonly caseSensitive?: boolean;
}

/** Protocol-neutral spatial predicates. */
export type QueryFilterSpatialPredicate =
  | "intersects"
  | "contains"
  | "within"
  | "crosses"
  | "touches"
  | "overlaps"
  | "bbox-intersects";

/** Canonical geometry operand: the value the spatial-filter builders emit. */
export interface QueryFilterGeometryOperand {
  readonly geometry: Record<string, unknown>;
  readonly geometryType: EsriGeometryType;
}

export interface QueryFilterSpatialNode {
  readonly kind: "spatial";
  readonly operator: QueryFilterSpatialPredicate;
  readonly geometry: QueryFilterGeometryOperand;
  /**
   * Geometry property to test. Optional for sources with a single primary
   * geometry (GeoServices, OGC, GeoParquet); the WFS / OData compilers resolve
   * it from the adapter when omitted.
   */
  readonly property?: string;
}

export type QueryFilterTemporalPredicate = "before" | "after" | "during" | "time-intersects";

/** RFC 3339 instant, or an inclusive `[start, end]` interval of instants. */
export type QueryFilterTemporalLiteralNode =
  | { readonly kind: "temporal-literal"; readonly valueType: "instant"; readonly value: string }
  | { readonly kind: "temporal-literal"; readonly valueType: "interval"; readonly value: readonly [string, string] };

export interface QueryFilterTemporalNode {
  readonly kind: "temporal";
  readonly operator: QueryFilterTemporalPredicate;
  readonly operand: QueryFilterPropertyNode;
  readonly value: QueryFilterTemporalLiteralNode;
}

export interface QueryFilterBooleanNode {
  readonly kind: "boolean";
  readonly operator: "and" | "or";
  readonly args: readonly QueryFilterExpression[];
}

export interface QueryFilterNotNode {
  readonly kind: "not";
  readonly arg: QueryFilterExpression;
}

/** The canonical typed filter accepted by `Query.filter`. */
export type QueryFilterExpression =
  | QueryFilterComparisonNode
  | QueryFilterListNode
  | QueryFilterRangeNode
  | QueryFilterNullNode
  | QueryFilterPatternNode
  | QueryFilterSpatialNode
  | QueryFilterTemporalNode
  | QueryFilterBooleanNode
  | QueryFilterNotNode;

/**
 * Canonical temporal filter accepted by `Query.temporalFilter`.
 *
 * Without `field` the filter targets the source's own time dimension and
 * compiles to the protocol's time parameter (GeoServices `time=`, OGC / STAC
 * `datetime=`). With `field` it compiles to an explicit temporal predicate on
 * that column, which is the only form OData, WFS, and DuckDB can express.
 * `null` on either interval bound means "open ended".
 */
export type QueryTemporalFilter =
  | { readonly kind: "instant"; readonly instant: string; readonly field?: string }
  | {
      readonly kind: "interval";
      readonly start: string | null;
      readonly end: string | null;
      readonly field?: string;
    };

// ── Builders ──────────────────────────────────────────────────

function property(name: string): QueryFilterPropertyNode {
  return { kind: "property", name };
}

function literal(value: QueryFilterScalar): QueryFilterLiteralNode {
  return { kind: "literal", value };
}

/**
 * Ergonomic constructors for {@link QueryFilterExpression}. Every helper returns
 * plain data, so a filter can equally be written as an object literal, stored as
 * JSON, or produced by the experimental semantic builder.
 *
 * @example
 * ```ts
 * import { envelope, queryFilter } from "@honua/sdk-js";
 *
 * const filter = queryFilter.and(
 *   queryFilter.eq("STATUS", "open"),
 *   queryFilter.gt("SEVERITY", 3),
 *   queryFilter.spatial("intersects", envelope(-158.5, 21.2, -157.6, 21.7)),
 * );
 * ```
 */
export const queryFilter = /* @__PURE__ */ Object.freeze({
  eq: (field: string, value: QueryFilterScalar): QueryFilterComparisonNode => ({
    kind: "comparison",
    operator: "eq",
    left: property(field),
    right: literal(value),
  }),
  ne: (field: string, value: QueryFilterScalar): QueryFilterComparisonNode => ({
    kind: "comparison",
    operator: "ne",
    left: property(field),
    right: literal(value),
  }),
  lt: (field: string, value: QueryFilterScalar): QueryFilterComparisonNode => ({
    kind: "comparison",
    operator: "lt",
    left: property(field),
    right: literal(value),
  }),
  lte: (field: string, value: QueryFilterScalar): QueryFilterComparisonNode => ({
    kind: "comparison",
    operator: "lte",
    left: property(field),
    right: literal(value),
  }),
  gt: (field: string, value: QueryFilterScalar): QueryFilterComparisonNode => ({
    kind: "comparison",
    operator: "gt",
    left: property(field),
    right: literal(value),
  }),
  gte: (field: string, value: QueryFilterScalar): QueryFilterComparisonNode => ({
    kind: "comparison",
    operator: "gte",
    left: property(field),
    right: literal(value),
  }),
  isIn: (field: string, values: readonly QueryFilterScalar[]): QueryFilterListNode => ({
    kind: "list",
    operator: "in",
    operand: property(field),
    values: values.map(literal),
  }),
  between: (field: string, lower: QueryFilterScalar, upper: QueryFilterScalar): QueryFilterRangeNode => ({
    kind: "range",
    operator: "between",
    operand: property(field),
    lower: literal(lower),
    upper: literal(upper),
  }),
  isNull: (field: string): QueryFilterNullNode => ({ kind: "null", operator: "is-null", operand: property(field) }),
  isNotNull: (field: string): QueryFilterNullNode => ({
    kind: "null",
    operator: "is-not-null",
    operand: property(field),
  }),
  like: (field: string, pattern: string, options: { caseSensitive?: boolean } = {}): QueryFilterPatternNode => ({
    kind: "pattern",
    operator: "like",
    operand: property(field),
    pattern,
    ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
  }),
  spatial: (
    operator: QueryFilterSpatialPredicate,
    geometry: QueryFilterGeometryOperand,
    options: { property?: string } = {},
  ): QueryFilterSpatialNode => ({
    kind: "spatial",
    operator,
    geometry: { geometry: geometry.geometry, geometryType: geometry.geometryType },
    ...(options.property !== undefined ? { property: options.property } : {}),
  }),
  before: (field: string, instant: string): QueryFilterTemporalNode => ({
    kind: "temporal",
    operator: "before",
    operand: property(field),
    value: { kind: "temporal-literal", valueType: "instant", value: instant },
  }),
  after: (field: string, instant: string): QueryFilterTemporalNode => ({
    kind: "temporal",
    operator: "after",
    operand: property(field),
    value: { kind: "temporal-literal", valueType: "instant", value: instant },
  }),
  during: (field: string, start: string, end: string): QueryFilterTemporalNode => ({
    kind: "temporal",
    operator: "during",
    operand: property(field),
    value: { kind: "temporal-literal", valueType: "interval", value: [start, end] },
  }),
  timeIntersects: (field: string, start: string, end: string): QueryFilterTemporalNode => ({
    kind: "temporal",
    operator: "time-intersects",
    operand: property(field),
    value: { kind: "temporal-literal", valueType: "interval", value: [start, end] },
  }),
  and: (...args: readonly QueryFilterExpression[]): QueryFilterBooleanNode => ({
    kind: "boolean",
    operator: "and",
    args,
  }),
  or: (...args: readonly QueryFilterExpression[]): QueryFilterBooleanNode => ({
    kind: "boolean",
    operator: "or",
    args,
  }),
  not: (arg: QueryFilterExpression): QueryFilterNotNode => ({ kind: "not", arg }),
});

// ── Validation ────────────────────────────────────────────────

/** Structural bounds mirroring the semantic planner's parser limits. */
export const MAX_QUERY_FILTER_DEPTH = 32;
export const MAX_QUERY_FILTER_NODES = 512;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/**
 * Boolean, comparison, and set operators a filter can name. Mirrors the
 * `filterOperators` vocabulary of `CapabilityConstraints` so a capability
 * profile's allow list can gate the canonical AST without translation.
 */
export type QueryFilterOperatorId =
  | QueryFilterComparisonOperator
  | "in"
  | "between"
  | "is-null"
  | "is-not-null"
  | "like"
  | "and"
  | "or"
  | "not"
  | QueryFilterSpatialPredicate
  | QueryFilterTemporalPredicate;

/** Compilation identity used to name a refusal. */
export interface QueryFilterContext {
  /** Wire protocol the filter is being compiled for. */
  readonly protocol: string;
  /** Source id, when the compile is bound to one. */
  readonly sourceId?: string;
  /** Geometry property name, when the dialect must reference it explicitly. */
  readonly geometryProperty?: string;
  /**
   * Operator allow list evaluated for this source. When present, an operator
   * outside it is refused even if the protocol could express it — the source's
   * own capability evidence is narrower than its protocol's grammar.
   */
  readonly supportedFilterOperators?: readonly QueryFilterOperatorId[];
  /** Optional per-source predicate allow list from the capability profile. */
  readonly supportedSpatialPredicates?: readonly QueryFilterSpatialPredicate[];
  /** Optional per-source temporal predicate allow list from the capability profile. */
  readonly supportedTemporalPredicates?: readonly QueryFilterTemporalPredicate[];
  /**
   * Where the allow lists came from. `capability-profile` marks a refusal as
   * source-evidence-driven rather than protocol-driven, which the error context
   * carries so callers can tell "this server cannot" from "this protocol
   * cannot".
   */
  readonly constraintSource?: "capability-profile" | "protocol-default";
}

/** Fail closed, naming the construct and the protocol that cannot express it. */
export function refuseQueryFilterConstruct(construct: string, ctx: QueryFilterContext): never {
  throw new HonuaCapabilityNotSupportedError(construct, ctx.protocol, ctx.sourceId, {
    context: { construct, filter: true },
  });
}

/**
 * Fail closed because this source's evaluated capability evidence excludes the
 * operator, even though its protocol can express it. The refusal names the same
 * construct as a protocol refusal so callers branch on one vocabulary, and
 * stamps `constraint: "capability-profile"` so the two causes stay
 * distinguishable without parsing messages.
 */
function refuseUnsupportedOperator(construct: string, ctx: QueryFilterContext): never {
  throw new HonuaCapabilityNotSupportedError(construct, ctx.protocol, ctx.sourceId, {
    context: { construct, filter: true, constraint: ctx.constraintSource ?? "capability-profile" },
  });
}

/** Gate one operator against the source's evaluated allow list. */
function assertOperatorAllowed(operator: QueryFilterOperatorId, construct: string, ctx: QueryFilterContext): void {
  if (ctx.supportedFilterOperators && !ctx.supportedFilterOperators.includes(operator)) {
    refuseUnsupportedOperator(construct, ctx);
  }
}

const QUERY_FILTER_OPERATORS: ReadonlySet<string> = new Set<QueryFilterOperatorId>([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "between",
  "is-null",
  "is-not-null",
  "like",
  "and",
  "or",
  "not",
  "intersects",
  "contains",
  "within",
  "crosses",
  "touches",
  "overlaps",
  "bbox-intersects",
  "before",
  "after",
  "during",
  "time-intersects",
]);

const QUERY_FILTER_SPATIAL_PREDICATES: ReadonlySet<string> = new Set<QueryFilterSpatialPredicate>([
  "intersects",
  "contains",
  "within",
  "crosses",
  "touches",
  "overlaps",
  "bbox-intersects",
]);

const QUERY_FILTER_TEMPORAL_PREDICATES: ReadonlySet<string> = new Set<QueryFilterTemporalPredicate>([
  "before",
  "after",
  "during",
  "time-intersects",
]);

/**
 * Narrow the evaluated `CapabilityConstraints` of one capability into the
 * allow lists this compiler understands.
 *
 * Vocabularies that the canonical AST cannot name (distance predicates,
 * extension identifiers) are dropped rather than translated, which fails closed
 * by construction: a profile that advertises only constructs outside the AST
 * yields an empty allow list, and every node of that kind is refused. Omitted
 * constraint arrays stay `undefined` — "the evidence says nothing", not "the
 * source supports nothing".
 */
export function queryFilterConstraints(constraints: {
  readonly filterOperators?: readonly string[];
  readonly spatialPredicates?: readonly string[];
  readonly temporalPredicates?: readonly string[];
}): Pick<
  QueryFilterContext,
  "supportedFilterOperators" | "supportedSpatialPredicates" | "supportedTemporalPredicates"
> {
  const operators = constraints.filterOperators?.filter((value): value is QueryFilterOperatorId =>
    QUERY_FILTER_OPERATORS.has(value),
  );
  const spatial = constraints.spatialPredicates?.filter((value): value is QueryFilterSpatialPredicate =>
    QUERY_FILTER_SPATIAL_PREDICATES.has(value),
  );
  const temporal = constraints.temporalPredicates?.filter((value): value is QueryFilterTemporalPredicate =>
    QUERY_FILTER_TEMPORAL_PREDICATES.has(value),
  );
  return {
    ...(operators ? { supportedFilterOperators: operators } : {}),
    ...(spatial ? { supportedSpatialPredicates: spatial } : {}),
    ...(temporal ? { supportedTemporalPredicates: temporal } : {}),
  };
}

/**
 * Validate a caller-supplied filter before any dialect sees it. Rejects
 * malformed nodes, unbounded nesting, and identifiers that are not plain
 * source field names (the only identifiers every dialect can quote safely).
 */
export function assertQueryFilter(filter: QueryFilterExpression, ctx: QueryFilterContext): void {
  let nodes = 0;
  const visit = (node: QueryFilterExpression, depth: number): void => {
    nodes += 1;
    if (depth > MAX_QUERY_FILTER_DEPTH) refuseQueryFilterConstruct("filter.depth", ctx);
    if (nodes > MAX_QUERY_FILTER_NODES) refuseQueryFilterConstruct("filter.size", ctx);
    if (!node || typeof node !== "object") refuseQueryFilterConstruct("filter.node", ctx);
    switch (node.kind) {
      case "comparison":
        assertFieldName(node.left?.name, ctx);
        assertScalar(node.right, ctx);
        assertOperatorAllowed(node.operator, `filter.comparison.${node.operator}`, ctx);
        return;
      case "list":
        assertFieldName(node.operand?.name, ctx);
        if (!Array.isArray(node.values) || node.values.length === 0)
          refuseQueryFilterConstruct("filter.list.values", ctx);
        for (const value of node.values) assertScalar(value, ctx);
        assertOperatorAllowed("in", "filter.list.in", ctx);
        return;
      case "range":
        assertFieldName(node.operand?.name, ctx);
        assertScalar(node.lower, ctx);
        assertScalar(node.upper, ctx);
        assertOperatorAllowed("between", "filter.range.between", ctx);
        return;
      case "null":
        assertFieldName(node.operand?.name, ctx);
        assertOperatorAllowed(node.operator, `filter.null.${node.operator}`, ctx);
        return;
      case "pattern":
        assertFieldName(node.operand?.name, ctx);
        if (typeof node.pattern !== "string" || node.pattern.length === 0)
          refuseQueryFilterConstruct("filter.pattern.value", ctx);
        assertPrintable(node.pattern, "filter.pattern.value", ctx);
        assertOperatorAllowed("like", "filter.pattern.like", ctx);
        return;
      case "spatial":
        if (node.property !== undefined) assertFieldName(node.property, ctx, true);
        if (!node.geometry || typeof node.geometry !== "object" || typeof node.geometry.geometry !== "object") {
          refuseQueryFilterConstruct("filter.spatial.geometry", ctx);
        }
        if (ctx.supportedSpatialPredicates && !ctx.supportedSpatialPredicates.includes(node.operator)) {
          refuseUnsupportedOperator(`filter.spatial.${node.operator}`, ctx);
        }
        assertOperatorAllowed(node.operator, `filter.spatial.${node.operator}`, ctx);
        return;
      case "temporal":
        assertFieldName(node.operand?.name, ctx, true);
        assertTemporalLiteral(node.value, ctx);
        if (ctx.supportedTemporalPredicates && !ctx.supportedTemporalPredicates.includes(node.operator)) {
          refuseUnsupportedOperator(`filter.temporal.${node.operator}`, ctx);
        }
        assertOperatorAllowed(node.operator, `filter.temporal.${node.operator}`, ctx);
        return;
      case "boolean":
        if (!Array.isArray(node.args) || node.args.length === 0) refuseQueryFilterConstruct("filter.boolean.args", ctx);
        assertOperatorAllowed(node.operator, `filter.boolean.${node.operator}`, ctx);
        for (const arg of node.args) visit(arg, depth + 1);
        return;
      case "not":
        assertOperatorAllowed("not", "filter.not", ctx);
        visit(node.arg, depth + 1);
        return;
      default:
        refuseQueryFilterConstruct("filter.node", ctx);
    }
  };
  visit(filter, 1);
}

function assertFieldName(name: unknown, ctx: QueryFilterContext, qualified = false): asserts name is string {
  const pattern = qualified ? QUALIFIED_IDENTIFIER_PATTERN : IDENTIFIER_PATTERN;
  if (typeof name !== "string" || name.length === 0 || name.length > 128 || !pattern.test(name)) {
    refuseQueryFilterConstruct("filter.property.name", ctx);
  }
}

function assertScalar(node: unknown, ctx: QueryFilterContext): asserts node is QueryFilterLiteralNode {
  if (!node || typeof node !== "object" || (node as QueryFilterLiteralNode).kind !== "literal") {
    refuseQueryFilterConstruct("filter.literal", ctx);
  }
  const value = (node as QueryFilterLiteralNode).value;
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuseQueryFilterConstruct("filter.literal.number", ctx);
    return;
  }
  if (typeof value === "string") {
    assertPrintable(value, "filter.literal.text", ctx);
    return;
  }
  refuseQueryFilterConstruct("filter.literal", ctx);
}

function assertPrintable(value: string, construct: string, ctx: QueryFilterContext): void {
  if (value.length > 4096) refuseQueryFilterConstruct(construct, ctx);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) refuseQueryFilterConstruct(construct, ctx);
  }
}

function assertTemporalLiteral(
  value: unknown,
  ctx: QueryFilterContext,
): asserts value is QueryFilterTemporalLiteralNode {
  const node = value as QueryFilterTemporalLiteralNode | undefined;
  if (!node || node.kind !== "temporal-literal") refuseQueryFilterConstruct("filter.temporal.literal", ctx);
  if (node.valueType === "instant") {
    assertInstant(node.value, ctx);
    return;
  }
  if (node.valueType === "interval") {
    if (!Array.isArray(node.value) || node.value.length !== 2)
      refuseQueryFilterConstruct("filter.temporal.interval", ctx);
    assertInstant(node.value[0], ctx);
    assertInstant(node.value[1], ctx);
    return;
  }
  refuseQueryFilterConstruct("filter.temporal.literal", ctx);
}

function assertInstant(value: unknown, ctx: QueryFilterContext): asserts value is string {
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value))
    refuseQueryFilterConstruct("filter.temporal.instant", ctx);
}

/** Validate `Query.temporalFilter` independently of the filter AST. */
export function assertTemporalFilter(temporal: QueryTemporalFilter, ctx: QueryFilterContext): void {
  if (!temporal || typeof temporal !== "object") refuseQueryFilterConstruct("temporalFilter", ctx);
  if (temporal.field !== undefined) assertFieldName(temporal.field, ctx, true);
  if (temporal.kind === "instant") {
    assertInstant(temporal.instant, ctx);
    return;
  }
  if (temporal.kind === "interval") {
    if (temporal.start === null && temporal.end === null) refuseQueryFilterConstruct("temporalFilter.interval", ctx);
    if (temporal.start !== null) assertInstant(temporal.start, ctx);
    if (temporal.end !== null) assertInstant(temporal.end, ctx);
    return;
  }
  refuseQueryFilterConstruct("temporalFilter", ctx);
}

/**
 * Lower a field-bound `Query.temporalFilter` into a filter node so every
 * dialect compiles temporal intent through the same path. Returns `undefined`
 * when the filter targets the source's own time dimension (no `field`), which
 * the protocol time parameter carries instead.
 */
export function temporalFilterToExpression(
  temporal: QueryTemporalFilter,
  ctx: QueryFilterContext,
): QueryFilterExpression | undefined {
  assertTemporalFilter(temporal, ctx);
  if (temporal.field === undefined) return undefined;
  const field = temporal.field;
  if (temporal.kind === "instant") {
    return {
      kind: "temporal",
      operator: "time-intersects",
      operand: { kind: "property", name: field },
      value: { kind: "temporal-literal", valueType: "instant", value: temporal.instant },
    };
  }
  if (temporal.start !== null && temporal.end !== null) {
    return {
      kind: "temporal",
      operator: "during",
      operand: { kind: "property", name: field },
      value: { kind: "temporal-literal", valueType: "interval", value: [temporal.start, temporal.end] },
    };
  }
  // A half-open canonical interval keeps its closed bound INCLUSIVE, so it
  // lowers to an ordered comparison rather than the strict `after` / `before`
  // temporal predicates. `[start, ..)` means "at or after start".
  if (temporal.start !== null) {
    return {
      kind: "comparison",
      operator: "gte",
      left: { kind: "property", name: field },
      right: { kind: "literal", value: temporal.start },
    };
  }
  if (temporal.end !== null) {
    return {
      kind: "comparison",
      operator: "lte",
      left: { kind: "property", name: field },
      right: { kind: "literal", value: temporal.end },
    };
  }
  return refuseQueryFilterConstruct("temporalFilter.interval", ctx);
}

/** Combine a filter and a lowered temporal predicate into one expression. */
export function andQueryFilters(
  ...parts: readonly (QueryFilterExpression | undefined)[]
): QueryFilterExpression | undefined {
  const present = parts.filter((part): part is QueryFilterExpression => part !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { kind: "boolean", operator: "and", args: present };
}

// ── Shared literal helpers ────────────────────────────────────

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTimestamp(instant: string): string {
  return `TIMESTAMP ${sqlText(instant)}`;
}

function isTemporalLike(value: QueryFilterScalar): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && value.length >= 10 && value.includes("-");
}

/** SQL-92 / DuckDB scalar literal. Temporal-shaped strings become timestamps. */
function sqlLiteral(node: QueryFilterLiteralNode, temporal: boolean): string {
  const value = node.value;
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return temporal && isTemporalLike(value) ? sqlTimestamp(value) : sqlText(value);
}

const SQL_COMPARISON: Record<QueryFilterComparisonOperator, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

const ODATA_COMPARISON: Record<QueryFilterComparisonOperator, string> = {
  eq: "eq",
  ne: "ne",
  lt: "lt",
  lte: "le",
  gt: "gt",
  gte: "ge",
};

/** One side of a compiled temporal window, with the strictness the predicate implies. */
interface TemporalBound {
  readonly value: string;
  readonly inclusive: boolean;
}

/**
 * Resolve a temporal node into bounds plus their strictness.
 *
 * `before` and `after` are *strict*: that is what CQL2 `T_BEFORE` / `T_AFTER`,
 * FES `Before` / `After`, and the schema-verified planner compilers all mean, so
 * the canonical lowering agrees with them rather than quietly widening the
 * window by one instant. `during` and `time-intersects` keep both bounds
 * inclusive, which is the closed-interval reading the reference evaluator and
 * the conformance corpus use.
 */
function temporalBounds(
  node: QueryFilterTemporalNode,
  ctx: QueryFilterContext,
): { readonly start?: TemporalBound; readonly end?: TemporalBound; readonly instant?: string } {
  const value = node.value;
  if (value.valueType === "instant") {
    if (node.operator === "before") return { end: { value: value.value, inclusive: false } };
    if (node.operator === "after") return { start: { value: value.value, inclusive: false } };
    return { instant: value.value };
  }
  if (node.operator === "before") return { end: { value: value.value[0], inclusive: false } };
  if (node.operator === "after") return { start: { value: value.value[1], inclusive: false } };
  if (node.operator === "during" || node.operator === "time-intersects") {
    return {
      start: { value: value.value[0], inclusive: true },
      end: { value: value.value[1], inclusive: true },
    };
  }
  return refuseQueryFilterConstruct(`filter.temporal.${node.operator}`, ctx);
}

// ── GeoServices SQL-92 ────────────────────────────────────────

/** GeoServices carries the spatial predicate as request params, not as SQL. */
export interface CompiledSql92Filter {
  readonly where?: string;
  readonly spatialFilter?: SpatialFilter;
}

/** Esri spatial relationships the canonical predicates map onto. @internal */
export const GEOSERVICES_SPATIAL_REL: Record<QueryFilterSpatialPredicate, EsriSpatialRel | undefined> = {
  intersects: "esriSpatialRelIntersects",
  contains: "esriSpatialRelContains",
  within: "esriSpatialRelWithin",
  crosses: "esriSpatialRelCrosses",
  touches: "esriSpatialRelTouches",
  overlaps: "esriSpatialRelOverlaps",
  // `bbox-intersects` means "the feature intersects this envelope", which is an
  // ordinary intersects test against an envelope operand — the same lowering the
  // schema-verified planner compiler uses. `esriSpatialRelEnvelopeIntersects`
  // would instead compare the *feature's* envelope and return a superset.
  "bbox-intersects": "esriSpatialRelIntersects",
};

/**
 * Compile to the GeoServices `where` clause plus (at most one) spatial request
 * parameter set. GeoServices expresses exactly one geometry per `query`
 * request, and only conjunctively, so a spatial predicate nested inside `OR` /
 * `NOT` or a second spatial predicate is refused rather than approximated.
 */
export function compileQueryFilterToSql92(filter: QueryFilterExpression, ctx: QueryFilterContext): CompiledSql92Filter {
  assertQueryFilter(filter, ctx);
  const spatial: QueryFilterSpatialNode[] = [];
  const dialect = sql92Dialect(ctx);
  const where = splitConjunctiveSpatial(filter, ctx, spatial, (node) => emitSql(node, ctx, dialect));
  if (spatial.length > 1) refuseQueryFilterConstruct("filter.spatial.multiple", ctx);
  const node = spatial[0];
  return {
    ...(where !== undefined ? { where } : {}),
    ...(node ? { spatialFilter: geoServicesSpatialFilter(node, ctx) } : {}),
  };
}

function geoServicesSpatialFilter(node: QueryFilterSpatialNode, ctx: QueryFilterContext): SpatialFilter {
  const spatialRel = GEOSERVICES_SPATIAL_REL[node.operator];
  if (!spatialRel) refuseQueryFilterConstruct(`filter.spatial.${node.operator}`, ctx);
  return {
    geometry: node.geometry.geometry,
    geometryType: node.geometry.geometryType,
    spatialRel,
  };
}

/**
 * Split a top-level conjunction into "spatial predicates carried out of band"
 * and "everything else, compiled by `emit`". A spatial node under `OR` / `NOT`
 * cannot be carried out of band without changing the result set, so it throws.
 */
function splitConjunctiveSpatial(
  filter: QueryFilterExpression,
  ctx: QueryFilterContext,
  spatial: QueryFilterSpatialNode[],
  emit: (node: QueryFilterExpression) => string,
): string | undefined {
  if (filter.kind === "spatial") {
    spatial.push(filter);
    return undefined;
  }
  if (filter.kind === "boolean" && filter.operator === "and") {
    const parts: string[] = [];
    for (const arg of filter.args) {
      const compiled = splitConjunctiveSpatial(arg, ctx, spatial, emit);
      if (compiled !== undefined) parts.push(compiled);
    }
    if (parts.length === 0) return undefined;
    return parts.length === 1 ? parts[0] : parts.map((part) => `(${part})`).join(" AND ");
  }
  if (containsSpatial(filter)) refuseQueryFilterConstruct("filter.spatial.disjunction", ctx);
  return emit(filter);
}

/** True when a filter references geometry anywhere in its tree. */
export function queryFilterHasSpatial(filter: QueryFilterExpression): boolean {
  return containsSpatial(filter);
}

function containsSpatial(filter: QueryFilterExpression): boolean {
  if (filter.kind === "spatial") return true;
  if (filter.kind === "boolean") return filter.args.some(containsSpatial);
  if (filter.kind === "not") return containsSpatial(filter.arg);
  return false;
}

/**
 * Per-dialect differences between the two SQL emitters. GeoServices SQL-92 and
 * DuckDB agree on every operator this filter can express, so they share one
 * emitter: only identifier quoting, case-insensitive matching, and how a
 * spatial node is handled differ.
 */
interface SqlDialect {
  /** Quote a validated source field name. */
  readonly identifier: (name: string) => string;
  /** Emit a case-insensitive pattern match. */
  readonly caseInsensitiveLike: (field: string, pattern: string) => string;
  /** Emit (or refuse) an inline spatial predicate. */
  readonly spatial: (node: QueryFilterSpatialNode) => string;
}

function emitSql(filter: QueryFilterExpression, ctx: QueryFilterContext, dialect: SqlDialect): string {
  const field = (name: string) => dialect.identifier(name);
  switch (filter.kind) {
    case "comparison": {
      const left = field(filter.left.name);
      if (filter.right.value === null) {
        return filter.operator === "eq"
          ? `${left} IS NULL`
          : filter.operator === "ne"
            ? `${left} IS NOT NULL`
            : refuseQueryFilterConstruct(`filter.comparison.${filter.operator}.null`, ctx);
      }
      return `${left} ${SQL_COMPARISON[filter.operator]} ${sqlLiteral(filter.right, true)}`;
    }
    case "list":
      return `${field(filter.operand.name)} IN (${filter.values.map((value) => sqlLiteral(value, true)).join(", ")})`;
    case "range":
      return `${field(filter.operand.name)} BETWEEN ${sqlLiteral(filter.lower, true)} AND ${sqlLiteral(
        filter.upper,
        true,
      )}`;
    case "null":
      return `${field(filter.operand.name)} IS ${filter.operator === "is-null" ? "NULL" : "NOT NULL"}`;
    case "pattern": {
      const pattern = sqlText(filter.pattern);
      const operand = field(filter.operand.name);
      return filter.caseSensitive === false
        ? dialect.caseInsensitiveLike(operand, pattern)
        : `${operand} LIKE ${pattern}`;
    }
    case "temporal": {
      const bounds = temporalBounds(filter, ctx);
      const operand = field(filter.operand.name);
      if (bounds.instant !== undefined) return `${operand} = ${sqlTimestamp(bounds.instant)}`;
      const parts: string[] = [];
      if (bounds.start !== undefined) {
        parts.push(`${operand} ${bounds.start.inclusive ? ">=" : ">"} ${sqlTimestamp(bounds.start.value)}`);
      }
      if (bounds.end !== undefined) {
        parts.push(`${operand} ${bounds.end.inclusive ? "<=" : "<"} ${sqlTimestamp(bounds.end.value)}`);
      }
      return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
    }
    case "boolean":
      return filter.args
        .map((arg) => `(${emitSql(arg, ctx, dialect)})`)
        .join(filter.operator === "and" ? " AND " : " OR ");
    case "not":
      return `NOT (${emitSql(filter.arg, ctx, dialect)})`;
    case "spatial":
      return dialect.spatial(filter);
    default:
      return refuseQueryFilterConstruct("filter.node", ctx);
  }
}

/** GeoServices carries geometry as request parameters, never inside the SQL. */
function sql92Dialect(ctx: QueryFilterContext): SqlDialect {
  return {
    identifier: (name) => name,
    caseInsensitiveLike: (operand, pattern) => `UPPER(${operand}) LIKE UPPER(${pattern})`,
    spatial: () => refuseQueryFilterConstruct("filter.spatial.disjunction", ctx),
  };
}

// ── DuckDB SQL (GeoParquet) ───────────────────────────────────

/** Emitted SQL plus whether a spatial predicate was reduced to its bbox. */
export interface CompiledDuckDbFilter {
  readonly sql: string;
  readonly bboxApproximated: boolean;
}

/**
 * Compile to a DuckDB `WHERE` fragment. Spatial predicates are emitted through
 * `emitSpatial`, which the GeoParquet driver supplies (it owns the geometry
 * column, its encoding, and the bbox reduction that `Result.degraded` reports).
 */
export function compileQueryFilterToDuckDbSql(
  filter: QueryFilterExpression,
  ctx: QueryFilterContext,
  emitSpatial: (node: QueryFilterSpatialNode) => { readonly sql: string; readonly bboxApproximated: boolean },
): CompiledDuckDbFilter {
  assertQueryFilter(filter, ctx);
  let bboxApproximated = false;
  const sql = emitSql(filter, ctx, {
    identifier: (name) => `"${name}"`,
    caseInsensitiveLike: (operand, pattern) => `${operand} ILIKE ${pattern}`,
    spatial: (node) => {
      const compiled = emitSpatial(node);
      if (compiled.bboxApproximated) bboxApproximated = true;
      return compiled.sql;
    },
  });
  return { sql, bboxApproximated };
}

// ── CQL2 text (OGC API Features / Records / STAC) ─────────────

const CQL2_SPATIAL: Record<QueryFilterSpatialPredicate, string> = {
  intersects: "S_INTERSECTS",
  contains: "S_CONTAINS",
  within: "S_WITHIN",
  crosses: "S_CROSSES",
  touches: "S_TOUCHES",
  overlaps: "S_OVERLAPS",
  "bbox-intersects": "S_INTERSECTS",
};

/**
 * Compile to CQL2 text (OGC API — Features Part 3 / STAC filter extension).
 * `geometryToWkt` is injected so the WKT writer stays in the OData module that
 * already owns it instead of being duplicated here.
 */
export function compileQueryFilterToCql2Text(
  filter: QueryFilterExpression,
  ctx: QueryFilterContext,
  geometryToWkt: (geometry: Record<string, unknown>, geometryType: string) => string,
): string {
  assertQueryFilter(filter, ctx);
  const emit = (node: QueryFilterExpression): string => {
    switch (node.kind) {
      case "comparison": {
        if (node.right.value === null) {
          return node.operator === "eq"
            ? `${node.left.name} IS NULL`
            : node.operator === "ne"
              ? `${node.left.name} IS NOT NULL`
              : refuseQueryFilterConstruct(`filter.comparison.${node.operator}.null`, ctx);
        }
        return `${node.left.name} ${SQL_COMPARISON[node.operator]} ${cql2Literal(node.right)}`;
      }
      case "list":
        return `${node.operand.name} IN (${node.values.map(cql2Literal).join(", ")})`;
      case "range":
        return `${node.operand.name} BETWEEN ${cql2Literal(node.lower)} AND ${cql2Literal(node.upper)}`;
      case "null":
        return `${node.operand.name} IS ${node.operator === "is-null" ? "NULL" : "NOT NULL"}`;
      case "pattern":
        return node.caseSensitive === false
          ? `CASEI(${node.operand.name}) LIKE CASEI(${sqlText(node.pattern)})`
          : `${node.operand.name} LIKE ${sqlText(node.pattern)}`;
      case "spatial": {
        const wkt = geometryToWkt(node.geometry.geometry, node.geometry.geometryType);
        const property = node.property ?? ctx.geometryProperty ?? "geometry";
        return `${CQL2_SPATIAL[node.operator]}(${property}, ${wkt})`;
      }
      case "temporal": {
        const field = node.operand.name;
        const value = node.value;
        if (node.operator === "before") {
          return `T_BEFORE(${field}, ${cql2Instant(value.valueType === "instant" ? value.value : value.value[0])})`;
        }
        if (node.operator === "after") {
          return `T_AFTER(${field}, ${cql2Instant(value.valueType === "instant" ? value.value : value.value[1])})`;
        }
        if (value.valueType === "instant") {
          return `T_INTERSECTS(${field}, ${cql2Instant(value.value)})`;
        }
        const interval = `INTERVAL('${value.value[0]}', '${value.value[1]}')`;
        return node.operator === "during" ? `T_DURING(${field}, ${interval})` : `T_INTERSECTS(${field}, ${interval})`;
      }
      case "boolean":
        return node.args.map((arg) => `(${emit(arg)})`).join(node.operator === "and" ? " AND " : " OR ");
      case "not":
        return `NOT (${emit(node.arg)})`;
      default:
        return refuseQueryFilterConstruct("filter.node", ctx);
    }
  };
  return emit(filter);
}

function cql2Literal(node: QueryFilterLiteralNode): string {
  const value = node.value;
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return isTemporalLike(value) ? cql2Instant(value) : sqlText(value);
}

function cql2Instant(instant: string): string {
  return instant.length === 10 ? `DATE('${instant}')` : `TIMESTAMP('${instant}')`;
}

// ── OData v4 ($filter) ────────────────────────────────────────

/**
 * Compile to an OData `$filter` expression. Spatial predicates are emitted
 * through `emitSpatial` so the adapter's `$metadata`-aware geometry column and
 * SRID resolution stay in one place.
 */
export function compileQueryFilterToOData(
  filter: QueryFilterExpression,
  ctx: QueryFilterContext,
  emitSpatial: (node: QueryFilterSpatialNode) => string,
): string {
  assertQueryFilter(filter, ctx);
  const emit = (node: QueryFilterExpression): string => {
    switch (node.kind) {
      case "comparison":
        return `${node.left.name} ${ODATA_COMPARISON[node.operator]} ${odataLiteral(node.right)}`;
      case "list":
        return `${node.operand.name} in (${node.values.map(odataLiteral).join(",")})`;
      case "range":
        return `(${node.operand.name} ge ${odataLiteral(node.lower)} and ${node.operand.name} le ${odataLiteral(
          node.upper,
        )})`;
      case "null":
        return `${node.operand.name} ${node.operator === "is-null" ? "eq" : "ne"} null`;
      case "pattern":
        return odataPattern(node, ctx);
      case "spatial":
        return emitSpatial(node);
      case "temporal": {
        const bounds = temporalBounds(node, ctx);
        const field = node.operand.name;
        if (bounds.instant !== undefined) return `${field} eq ${bounds.instant}`;
        const parts: string[] = [];
        if (bounds.start !== undefined) {
          parts.push(`${field} ${bounds.start.inclusive ? "ge" : "gt"} ${bounds.start.value}`);
        }
        if (bounds.end !== undefined) {
          parts.push(`${field} ${bounds.end.inclusive ? "le" : "lt"} ${bounds.end.value}`);
        }
        return parts.length === 1 ? parts[0] : `(${parts.join(" and ")})`;
      }
      case "boolean":
        return node.args.map((arg) => `(${emit(arg)})`).join(node.operator === "and" ? " and " : " or ");
      case "not":
        return `not (${emit(node.arg)})`;
      default:
        return refuseQueryFilterConstruct("filter.node", ctx);
    }
  };
  return emit(filter);
}

function odataLiteral(node: QueryFilterLiteralNode): string {
  const value = node.value;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // Edm.DateTimeOffset literals are unquoted; every other string is quoted.
  return isTemporalLike(value) && value.length > 10 ? value : sqlText(value);
}

/**
 * OData has no `LIKE`. Only the three anchored shapes map exactly onto
 * `startswith` / `endswith` / `contains`; anything else (an interior wildcard,
 * a single-character `_`) is refused instead of being widened.
 */
function odataPattern(node: QueryFilterPatternNode, ctx: QueryFilterContext): string {
  if (node.caseSensitive === false) refuseQueryFilterConstruct("filter.pattern.case-insensitive", ctx);
  const pattern = node.pattern;
  if (pattern.includes("_")) refuseQueryFilterConstruct("filter.pattern.single-character-wildcard", ctx);
  const leading = pattern.startsWith("%");
  const trailing = pattern.endsWith("%");
  const core = pattern.slice(leading ? 1 : 0, trailing ? pattern.length - 1 : pattern.length);
  if (core.includes("%")) refuseQueryFilterConstruct("filter.pattern.interior-wildcard", ctx);
  const literalText = sqlText(core);
  if (leading && trailing) return `contains(${node.operand.name},${literalText})`;
  if (trailing) return `startswith(${node.operand.name},${literalText})`;
  if (leading) return `endswith(${node.operand.name},${literalText})`;
  return `${node.operand.name} eq ${literalText}`;
}

// ── Protocol time parameters ──────────────────────────────────

/**
 * GeoServices `time=` value. Instants serialize as epoch milliseconds and
 * intervals as `start,end`; an open bound serializes as `null`, which the
 * FeatureServer `time` parameter defines as "unbounded on that side".
 */
export function compileTemporalFilterToGeoServicesTime(temporal: QueryTemporalFilter, ctx: QueryFilterContext): string {
  assertTemporalFilter(temporal, ctx);
  if (temporal.kind === "instant") return String(epochMillis(temporal.instant, ctx));
  const start = temporal.start === null ? "null" : String(epochMillis(temporal.start, ctx));
  const end = temporal.end === null ? "null" : String(epochMillis(temporal.end, ctx));
  return `${start},${end}`;
}

/** OGC / STAC `datetime=` value (RFC 3339 instant or `start/end` interval). */
export function compileTemporalFilterToOgcDatetime(temporal: QueryTemporalFilter, ctx: QueryFilterContext): string {
  assertTemporalFilter(temporal, ctx);
  if (temporal.kind === "instant") return temporal.instant;
  return `${temporal.start ?? ".."}/${temporal.end ?? ".."}`;
}

function epochMillis(instant: string, ctx: QueryFilterContext): number {
  const millis = Date.parse(instant.length === 10 ? `${instant}T00:00:00Z` : instant);
  if (!Number.isFinite(millis)) refuseQueryFilterConstruct("temporalFilter.instant", ctx);
  return millis;
}
