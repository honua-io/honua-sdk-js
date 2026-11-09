import { describe, expect, test } from "vitest";
import { applyFilterBuilder, compileFilterBuilder } from "../../src/controls/filter-builder.js";
import { createFilterRegistry, projectFilterRegistryToQuery } from "../../src/filter-registry/index.js";

const fields = [
  { name: "population", type: "number" as const },
  { name: "name", type: "string" as const },
  { name: "observed", type: "datetime" as const },
];
const options = { fields, sourceId: "parcels", ownerId: "analysis" };

describe("visual filter builder projection", () => {
  test("compiles typed rows and escapes text through the canonical compiler", () => {
    const result = compileFilterBuilder({
      ...options,
      rows: [
        { field: "population", operator: "gte", value: "42" },
        { field: "name", operator: "eq", value: "O'Brien" },
      ],
    });
    expect(result.cql2).toContain("population >= 42");
    expect(result.cql2).toContain("name = 'O''Brien'");
    expect(result.query.filter).toMatchObject({ kind: "boolean", operator: "and" });
  });

  test("combines attribute, WGS84 extent and time clauses in the query and registry", () => {
    const registry = createFilterRegistry();
    registry.upsert({
      id: "chart",
      owner: { kind: "chart", id: "scatter" },
      field: "population",
      operator: "<=",
      value: 100,
    });
    const result = applyFilterBuilder(registry, {
      ...options,
      rows: [{ field: "name", operator: "eq", value: "Town" }],
      extent: [-158, 20, -157, 22],
      time: { field: "observed", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
    });
    expect(result.cql2).toContain("S_INTERSECTS");
    expect(result.cql2).toContain("observed BETWEEN");
    const query = projectFilterRegistryToQuery(registry.snapshot, { sourceId: "parcels" }).query;
    expect(query.where).toContain("population <= 100");
    expect(query.where).toContain("observed BETWEEN");
    expect(query.spatialFilter?.geometry).toMatchObject({ xmin: -158, ymax: 22 });
    applyFilterBuilder(registry, { ...options, rows: [] });
    expect(registry.snapshot.clauses.map((clause) => clause.id)).toEqual(["chart"]);
  });

  test.each([
    { rows: [{ field: "population", operator: "eq", value: "NaN" }] },
    { rows: [{ field: "unknown", operator: "eq", value: "x" }] },
    { rows: [{ field: "population", operator: "like", value: "x" }] },
    { rows: [], extent: [-157, 20, -158, 22] },
    { rows: [], extent: [-190, 20, -158, 22] },
    { rows: [], time: { field: "observed", start: "2026-02-01T00:00:00Z", end: "2026-01-01T00:00:00Z" } },
    { rows: [], time: { field: "name", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" } },
  ])("rejects invalid input without changing shared filters: %j", (draft) => {
    const registry = createFilterRegistry();
    registry.upsert({
      id: "existing",
      owner: { kind: "control", id: "analysis" },
      field: "name",
      operator: "=",
      value: "Town",
    });
    const before = registry.snapshot;
    expect(() =>
      applyFilterBuilder(registry, { ...options, ...draft } as Parameters<typeof compileFilterBuilder>[0]),
    ).toThrow();
    expect(registry.snapshot).toEqual(before);
  });

  test("empty input means no builder filter", () => {
    expect(compileFilterBuilder({ ...options, rows: [] })).toMatchObject({ query: {}, cql2: "", clauses: [] });
  });

  test("source-scopes clauses and refuses source capability mismatches", () => {
    const result = compileFilterBuilder({ ...options, rows: [{ field: "population", operator: "eq", value: "0" }] });
    expect(result.clauses[0].sourceScope).toEqual(["parcels"]);
    expect(() =>
      compileFilterBuilder({
        ...options,
        context: { protocol: "ogc-api", supportedFilterOperators: ["eq"] },
        rows: [{ field: "population", operator: "gt", value: "1" }],
      }),
    ).toThrow();
  });
});
