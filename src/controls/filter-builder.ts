import { compileQueryFilterToCql2Text } from "../contract/query-filter.js";
import type { QueryFilterContext, QueryFilterExpression, QueryFilterScalar } from "../contract/query-filter.js";
import type { Query } from "../contract/types.js";
import { geometryToWkt } from "../core/odata.js";
import type { FilterClause, FilterRegistry } from "../filter-registry/index.js";

export interface HonuaFilterBuilderField {
  readonly name: string;
  readonly label?: string;
  readonly type: "string" | "number" | "boolean" | "datetime";
}

export type HonuaFilterBuilderOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "like" | "is-null" | "is-not-null";

export interface HonuaFilterBuilderRow {
  readonly field: string;
  readonly operator: HonuaFilterBuilderOperator;
  readonly value?: string;
}

export interface HonuaFilterBuilderTime {
  readonly field: string;
  readonly start: string;
  readonly end: string;
}

export interface HonuaFilterBuilderDraft {
  readonly fields: readonly HonuaFilterBuilderField[];
  readonly rows: readonly HonuaFilterBuilderRow[];
  readonly sourceId: string;
  readonly ownerId: string;
  readonly extent?: readonly [number, number, number, number];
  readonly time?: HonuaFilterBuilderTime;
  readonly context?: QueryFilterContext;
}

export interface HonuaFilterBuilderProjection {
  readonly query: Query;
  readonly cql2: string;
  readonly clauses: readonly FilterClause[];
}

const REGISTRY_OPERATORS = {
  eq: "=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "like",
  "is-null": "is-null",
  "is-not-null": "is-not-null",
} as const;
export const FILTER_BUILDER_MAX_ROWS = 32;

/** Compile a bounded, schema-checked builder draft without mutating shared state. */
export function compileFilterBuilder(draft: HonuaFilterBuilderDraft): HonuaFilterBuilderProjection {
  if (!draft.ownerId || !draft.sourceId || draft.rows.length > FILTER_BUILDER_MAX_ROWS)
    throw new Error(`Choose a source and at most ${FILTER_BUILDER_MAX_ROWS} filter rows.`);
  const nodes: QueryFilterExpression[] = [];
  const clauses: FilterClause[] = [];
  const add = (node: QueryFilterExpression, clause: Partial<FilterClause>): void => {
    nodes.push(node);
    clauses.push({
      ...clause,
      id: `filter-builder:${draft.ownerId}:${clauses.length}`,
      owner: { kind: "control", id: draft.ownerId },
      sourceScope: [draft.sourceId],
    });
  };
  for (const row of draft.rows) {
    const { node, value } = compileRow(row, draft.fields);
    add(node, { field: row.field, operator: REGISTRY_OPERATORS[row.operator], value });
  }
  if (draft.extent) {
    const spatial = compileExtent(draft.extent);
    add({ kind: "spatial", operator: "intersects", geometry: spatial }, { spatialScope: { filter: spatial } });
  }
  if (draft.time) {
    const node = compileTime(draft.time, draft.fields);
    add(node, { field: draft.time.field, operator: "between", value: [draft.time.start, draft.time.end] });
  }
  const filter: QueryFilterExpression | undefined =
    nodes.length > 1 ? { kind: "boolean", operator: "and", args: nodes } : nodes[0];
  const context = {
    protocol: "ogc-api",
    fieldTypes: Object.fromEntries(draft.fields.map((field) => [field.name, field.type])),
    ...draft.context,
    sourceId: draft.sourceId,
  };
  const cql2 = filter ? compileQueryFilterToCql2Text(filter, context, geometryToWkt) : "";
  return { query: filter ? { filter } : {}, cql2, clauses };
}

/** Replace only this builder owner's clauses after the entire draft validates. */
export function applyFilterBuilder(
  registry: FilterRegistry,
  draft: HonuaFilterBuilderDraft,
): HonuaFilterBuilderProjection {
  const projection = compileFilterBuilder(draft);
  const others = registry.snapshot.clauses.filter(
    (clause) => clause.owner.kind !== "control" || clause.owner.id !== draft.ownerId,
  );
  registry.replace({ version: 1, clauses: [...others, ...projection.clauses] });
  return projection;
}

function findField(name: string, fields: readonly HonuaFilterBuilderField[]): HonuaFilterBuilderField {
  const field = fields.find((candidate) => candidate.name === name);
  if (!field || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Choose a field from the selected source.");
  return field;
}

function compileRow(
  row: HonuaFilterBuilderRow,
  fields: readonly HonuaFilterBuilderField[],
): { node: QueryFilterExpression; value?: QueryFilterScalar } {
  const field = findField(row.field, fields);
  const operand = { kind: "property" as const, name: field.name };
  if (row.operator === "is-null" || row.operator === "is-not-null")
    return { node: { kind: "null", operator: row.operator, operand } };
  if (!Object.hasOwn(REGISTRY_OPERATORS, row.operator)) throw new Error("Choose a supported operator.");
  const value = parseValue(field, row.value);
  if (row.operator === "like") {
    if (field.type !== "string") throw new Error("Like requires a text field.");
    return { node: { kind: "pattern", operator: "like", operand, pattern: String(value) }, value };
  }
  if (field.type === "boolean" && row.operator !== "eq" && row.operator !== "ne")
    throw new Error("Boolean fields support equals or differs.");
  return {
    node: { kind: "comparison", operator: row.operator, left: operand, right: { kind: "literal", value } },
    value,
  };
}

function parseValue(field: HonuaFilterBuilderField, value: string | undefined): QueryFilterScalar {
  if (value === undefined) throw new Error("Enter a value.");
  if (field.type === "number") {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number)) throw new Error("Enter a finite number.");
    return number;
  }
  if (field.type === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("Choose true or false.");
    return value === "true";
  }
  if (field.type === "datetime") assertInstant(value);
  return value;
}

function assertInstant(value: string): void {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    !isCalendarDate(value)
  )
    throw new Error("Enter a timestamp with a timezone.");
}

function isCalendarDate(value: string): boolean {
  // Check the local calendar separately: Date.parse silently normalizes February 30.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function compileTime(time: HonuaFilterBuilderTime, fields: readonly HonuaFilterBuilderField[]): QueryFilterExpression {
  if (findField(time.field, fields).type !== "datetime") throw new Error("Choose a date field for the time range.");
  assertInstant(time.start);
  assertInstant(time.end);
  if (Date.parse(time.start) > Date.parse(time.end)) throw new Error("Start time must precede end time.");
  return {
    kind: "range",
    operator: "between",
    operand: { kind: "property", name: time.field },
    lower: { kind: "literal", value: time.start },
    upper: { kind: "literal", value: time.end },
  };
}

function compileExtent(extent: readonly [number, number, number, number]) {
  const [xmin, ymin, xmax, ymax] = extent;
  if (
    extent.length !== 4 ||
    !extent.every(Number.isFinite) ||
    xmin < -180 ||
    xmax > 180 ||
    ymin < -90 ||
    ymax > 90 ||
    xmin > xmax ||
    ymin > ymax
  )
    throw new Error("Enter a valid WGS84 extent: west, south, east, north.");
  return {
    geometry: { xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } },
    geometryType: "esriGeometryEnvelope" as const,
    spatialRel: "esriSpatialRelIntersects" as const,
  };
}
