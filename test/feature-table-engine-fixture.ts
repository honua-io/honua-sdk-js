import type { Capability, Query, Result, SortSpec, SourceDescriptor } from "../src/contract/index.js";
import type { FilterClause } from "../src/filter-registry/index.js";
import type { HonuaFeatureTable, HonuaFeatureTableQuerySource } from "../src/web-components/index.js";
import { createHonuaFeatureTable } from "../src/web-components/index.js";

export type Row = { OBJECTID: number; NAME: string; STATUS: string; SEVERITY: number };

export const TOTAL_ROWS = 5_000;

export interface Fixture {
  readonly source: HonuaFeatureTableQuerySource<Row>;
  readonly requests: Query<Row>[];
  rowsServed: number;
}

export function descriptor(capabilities: readonly Capability[] = ["query", "stream"]): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://example.test/FeatureServer/0" },
    capabilities: new Set(capabilities),
    schema: { primaryKey: "OBJECTID" },
  };
}

export function makeRow(index: number): Row {
  return {
    OBJECTID: index + 1,
    NAME: `Incident ${index + 1}`,
    STATUS: index % 3 === 0 ? "open" : "closed",
    SEVERITY: (index % 5) + 1,
  };
}

/** Materializes only the page it is asked for — never the whole fixture. */
export function makeFixture(
  options: {
    readonly totalRows?: number;
    readonly reportTotalCount?: boolean;
    readonly rows?: (index: number) => Row;
    readonly capabilities?: readonly Capability[];
  } = {},
): Fixture {
  const total = options.totalRows ?? TOTAL_ROWS;
  const build = options.rows ?? makeRow;
  const requests: Query<Row>[] = [];
  const fixture: Fixture = {
    requests,
    rowsServed: 0,
    source: {
      descriptor: descriptor(options.capabilities),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        requests.push(request ?? {});
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const features = [];
        for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
          features.push({ attributes: build(index) });
        }
        fixture.rowsServed += features.length;
        return {
          features,
          exceededTransferLimit: offset + features.length < total,
          ...(options.reportTotalCount === false ? {} : { totalCount: total }),
        };
      },
      async *stream(request?: Query<Row>): AsyncGenerator<Result<Row>, void, undefined> {
        const limit = request?.pagination?.limit ?? 10;
        for (let offset = 0; offset < total; offset += limit) {
          const features = [];
          for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
            features.push({ attributes: build(index) });
          }
          fixture.rowsServed += features.length;
          yield { features, exceededTransferLimit: offset + features.length < total };
        }
      },
    },
  };
  return fixture;
}

export const COLUMNS = [
  { field: "OBJECTID", label: "ID", type: "integer" as const },
  { field: "NAME", label: "Name", type: "string" as const },
  { field: "STATUS", label: "Status", type: "string" as const },
  { field: "SEVERITY", label: "Severity", type: "number" as const },
];

export function makeTable(fixture: Fixture, overrides: Record<string, unknown> = {}): HonuaFeatureTable<Row> {
  return createHonuaFeatureTable<Row>({
    source: fixture.source,
    sourceId: "incidents",
    columns: COLUMNS,
    budgets: { pageSize: 50, maxCachedRows: 150, windowOverscan: 0 },
    ...overrides,
  });
}

export function statusFilter(value: string): FilterClause {
  return {
    id: "status",
    owner: { kind: "table", id: "grid" },
    field: "STATUS",
    operator: "=",
    value,
    effect: "filter",
  };
}

export function locatingFixture(): Fixture {
  const total = TOTAL_ROWS;
  const requests: Query<Row>[] = [];
  const fixture: Fixture = {
    requests,
    rowsServed: 0,
    source: {
      descriptor: descriptor(),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        requests.push(request ?? {});
        const matched: Row[] = [];
        for (let index = 0; index < total; index += 1) {
          const row = makeRow(index);
          if (matchesWhere(request?.where, row)) matched.push(row);
        }
        matched.sort((left, right) => compareRows(left, right, request?.orderBy));
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const page = matched.slice(offset, offset + limit);
        fixture.rowsServed += page.length;
        return {
          features: page.map((attributes) => ({ attributes })),
          exceededTransferLimit: offset + page.length < matched.length,
          totalCount: matched.length,
        };
      },
    },
  };
  return fixture;
}

export function openSortedIndex(id: number): number {
  const rows: Row[] = [];
  for (let index = 0; index < TOTAL_ROWS; index += 1) {
    const row = makeRow(index);
    if (row.STATUS === "open") rows.push(row);
  }
  rows.sort((left, right) =>
    compareRows(left, right, [
      { field: "SEVERITY", direction: "asc" },
      { field: "OBJECTID", direction: "asc" },
    ]),
  );
  return rows.findIndex((row) => row.OBJECTID === id);
}

function compareRows(left: Row, right: Row, orderBy: readonly SortSpec[] | undefined): number {
  for (const key of orderBy ?? []) {
    const direction = key.direction === "desc" ? -1 : 1;
    const leftValue = left[key.field as keyof Row];
    const rightValue = right[key.field as keyof Row];
    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return 1 * direction;
  }
  return left.OBJECTID - right.OBJECTID;
}

export function tiedRow(id: number): Row {
  return { OBJECTID: id, NAME: `Incident ${id}`, STATUS: "open", SEVERITY: 1 };
}

export function matchesWhere(where: string | undefined, row: Readonly<Record<string, unknown>>): boolean {
  if (!where) return true;
  return parseWhere(where, { index: 0 }, row);
}

type WhereCursor = { index: number };

function skipWhereSpace(where: string, cursor: WhereCursor): void {
  while (where[cursor.index] === " ") cursor.index += 1;
}

function parseWhere(where: string, cursor: WhereCursor, row: Readonly<Record<string, unknown>>): boolean {
  return parseWhereOr(where, cursor, row);
}

function parseWhereOr(where: string, cursor: WhereCursor, row: Readonly<Record<string, unknown>>): boolean {
  let value = parseWhereAnd(where, cursor, row);
  for (;;) {
    skipWhereSpace(where, cursor);
    const index = cursor.index;
    if (where.slice(index, index + 2) !== "OR") break;
    const next = where[index + 2];
    if (next !== " " && next !== "(") break;
    cursor.index = index + 2;
    value = parseWhereAnd(where, cursor, row) || value;
  }
  return value;
}

function parseWhereAnd(where: string, cursor: WhereCursor, row: Readonly<Record<string, unknown>>): boolean {
  let value = parseWherePrimary(where, cursor, row);
  for (;;) {
    skipWhereSpace(where, cursor);
    const index = cursor.index;
    if (where.slice(index, index + 3) !== "AND") break;
    const next = where[index + 3];
    if (next !== " " && next !== "(") break;
    cursor.index = index + 3;
    value = parseWherePrimary(where, cursor, row) && value;
  }
  return value;
}

function parseWherePrimary(where: string, cursor: WhereCursor, row: Readonly<Record<string, unknown>>): boolean {
  skipWhereSpace(where, cursor);
  const index = cursor.index;
  if (where[index] === "(") {
    cursor.index = index + 1;
    const value = parseWhereOr(where, cursor, row);
    skipWhereSpace(where, cursor);
    if (where[cursor.index] === ")") cursor.index = cursor.index + 1;
    return value;
  }
  return parseWhereComparison(where, cursor, row);
}

function parseWhereComparison(where: string, cursor: WhereCursor, row: Readonly<Record<string, unknown>>): boolean {
  skipWhereSpace(where, cursor);
  const fieldStart = cursor.index;
  let fieldEnd = fieldStart;
  while (/[A-Za-z0-9_]/.test(where[fieldEnd] ?? "")) fieldEnd += 1;
  const field = where.slice(fieldStart, fieldEnd);
  cursor.index = fieldEnd;
  skipWhereSpace(where, cursor);
  const operators = ["<>", "<=", ">=", "=", "<", ">"] as const;
  const operator = operators.find((candidate) => where.startsWith(candidate, cursor.index));
  if (!operator) throw new Error(`Unsupported locate predicate: ${where.slice(cursor.index)}`);
  cursor.index = cursor.index + operator.length;
  skipWhereSpace(where, cursor);
  const literal = parseWhereLiteral(where, cursor);
  const actual = row[field];
  if (operator === "=") return actual === literal;
  if (operator === "<>") return actual !== literal;
  if (typeof actual !== "number" && typeof actual !== "string") return false;
  if (typeof literal !== "number" && typeof literal !== "string") return false;
  if (operator === "<") return actual < literal;
  if (operator === ">") return actual > literal;
  if (operator === "<=") return actual <= literal;
  return actual >= literal;
}

function parseWhereLiteral(where: string, cursor: WhereCursor): string | number | boolean {
  const index = cursor.index;
  if (where[index] === "'") return parseQuotedLiteral(where, cursor, index);
  if (where.startsWith("TRUE", index)) {
    cursor.index = index + 4;
    return true;
  }
  if (where.startsWith("FALSE", index)) {
    cursor.index = index + 5;
    return false;
  }
  const match = /^-?\d+(?:\.\d+)?/.exec(where.slice(index));
  if (!match) throw new Error(`Unsupported locate literal: ${where.slice(index)}`);
  cursor.index = index + match[0].length;
  return Number(match[0]);
}

function parseQuotedLiteral(where: string, cursor: WhereCursor, index: number): string {
  let value = "";
  let next = index + 1;
  while (next < where.length) {
    if (where[next] === "'" && where[next + 1] === "'") {
      value += "'";
      next += 2;
      continue;
    }
    if (where[next] === "'") {
      cursor.index = next + 1;
      return value;
    }
    value += where[next];
    next += 1;
  }
  throw new Error("Unclosed string in locate predicate");
}
