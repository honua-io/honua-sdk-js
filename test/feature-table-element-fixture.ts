import type { Query, Result, SourceDescriptor } from "../src/contract/index.js";
import type { HonuaFeatureTable, HonuaFeatureTableElement } from "../src/web-components/index.js";
import { createHonuaFeatureTable, defineHonuaWebComponents } from "../src/web-components/index.js";

export type Row = { OBJECTID: number; NAME: string; SEVERITY: number };

export const TOTAL = 400;

export function orderedSource(total: number) {
  return {
    descriptor: descriptor(),
    async query(request?: Query<Row>): Promise<Result<Row>> {
      const ids = Array.from({ length: total }, (_, index) => index + 1);
      const where = request?.where;
      const matched = ids.filter((id) => idMatches(where, id));
      const offset = request?.pagination?.offset ?? 0;
      const limit = request?.pagination?.limit ?? 10;
      const page = matched.slice(offset, offset + limit);
      return {
        features: page.map((id) => ({ attributes: { OBJECTID: id, NAME: `Incident ${id}`, SEVERITY: 1 } })),
        exceededTransferLimit: offset + page.length < matched.length,
        totalCount: matched.length,
      };
    },
  };
}

function idMatches(where: string | undefined, id: number): boolean {
  if (!where) return true;
  const cursor = { index: 0 };
  const skip = () => {
    while (where[cursor.index] === " ") cursor.index += 1;
  };
  const parseOr = (): boolean => {
    let value = parseAnd();
    for (;;) {
      skip();
      if (!where.startsWith("OR", cursor.index)) break;
      const next = where[cursor.index + 2];
      if (next !== " " && next !== "(") break;
      cursor.index += 2;
      value = parseAnd() || value;
    }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parsePrimary();
    for (;;) {
      skip();
      if (!where.startsWith("AND", cursor.index)) break;
      const next = where[cursor.index + 3];
      if (next !== " " && next !== "(") break;
      cursor.index += 3;
      value = parsePrimary() && value;
    }
    return value;
  };
  const parsePrimary = (): boolean => {
    skip();
    if (where[cursor.index] === "(") {
      cursor.index += 1;
      const value = parseOr();
      skip();
      if (where[cursor.index] === ")") cursor.index += 1;
      return value;
    }
    skip();
    const fieldEnd = where.indexOf(" ", cursor.index);
    cursor.index = fieldEnd + 1;
    skip();
    const operators = [">=", "<=", "<>", "=", ">", "<"] as const;
    const operator = operators.find((candidate) => where.startsWith(candidate, cursor.index));
    if (!operator) return true;
    cursor.index += operator.length;
    skip();
    const literal = Number(where.slice(cursor.index).match(/^-?\d+/)?.[0] ?? "NaN");
    cursor.index += String(literal).length;
    if (operator === "=") return id === literal;
    if (operator === ">") return id > literal;
    if (operator === "<") return id < literal;
    if (operator === ">=") return id >= literal;
    if (operator === "<=") return id <= literal;
    return id !== literal;
  };
  return parseOr();
}

export function descriptor(): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://example.test/FeatureServer/0" },
    capabilities: new Set(["query"]),
    schema: { primaryKey: "OBJECTID" },
  };
}

export function makeEngine(): HonuaFeatureTable<Row> {
  return createHonuaFeatureTable<Row>({
    source: {
      descriptor: descriptor(),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const features = [];
        for (let index = offset; index < Math.min(offset + limit, TOTAL); index += 1) {
          features.push({ attributes: { OBJECTID: index + 1, NAME: `Incident ${index + 1}`, SEVERITY: index % 5 } });
        }
        return { features, exceededTransferLimit: offset + features.length < TOTAL, totalCount: TOTAL };
      },
    },
    sourceId: "incidents",
    columns: [
      { field: "OBJECTID", label: "ID", type: "integer" },
      { field: "NAME", label: "Name", type: "string" },
      { field: "SEVERITY", label: "Severity", type: "number" },
    ],
    budgets: { pageSize: 20, windowOverscan: 0 },
  });
}

export function mount(): HonuaFeatureTableElement<Row> {
  defineHonuaWebComponents();
  const element = document.createElement("honua-feature-table") as HonuaFeatureTableElement<Row>;
  document.body.append(element);
  return element;
}

export function shadow(element: HonuaFeatureTableElement<Row>): ShadowRoot {
  const root = element.shadowRoot;
  if (!root) throw new Error("missing shadow root");
  return root;
}
