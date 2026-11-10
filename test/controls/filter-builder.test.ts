import { describe, expect, test } from "vitest";
import { capabilities } from "../../src/contract/index.js";
import { applyFilterBuilder, compileFilterBuilder } from "../../src/controls/filter-builder.js";
import {
  createFilterRegistry,
  parseFilterRegistry,
  projectFilterRegistryToQuery,
  serializeFilterRegistry,
} from "../../src/filter-registry/index.js";

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
    { rows: [{ field: "observed", operator: "eq", value: "2026-02-30T00:00:00Z" }] },
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

test("escapes untyped host extent values before rendering", async () => {
  const { filterBuilderMarkup } = await import("../../src/controls/filter-builder-view.js");
  const markup = filterBuilderMarkup(
    {
      ...options,
      rows: [],
      extent: ['" autofocus onfocus="window.__x=1', 0, 0, 0] as unknown as [number, number, number, number],
    },
    "",
    "",
  );
  expect(markup).not.toContain('value="" autofocus');
  expect(markup).toContain("&quot;");
});

test("shared datetime ranges and rows retain typed literals after serialization", () => {
  const registry = createFilterRegistry();
  applyFilterBuilder(registry, {
    ...options,
    rows: [{ field: "observed", operator: "gte", value: "2026-01-01T00:00:00Z" }],
    time: { field: "observed", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
  });
  const restored = parseFilterRegistry(serializeFilterRegistry(registry.snapshot));
  const query = projectFilterRegistryToQuery(restored, { sourceId: "parcels" }).query;
  expect(query.where).toContain("observed >= TIMESTAMP('2026-01-01T00:00:00Z')");
  expect(query.where).toContain(
    "observed BETWEEN TIMESTAMP('2026-01-01T00:00:00Z') AND TIMESTAMP('2026-02-01T00:00:00Z')",
  );
});

test("projects temporal registry clauses into GeoServices SQL syntax", () => {
  const registry = createFilterRegistry();
  applyFilterBuilder(registry, {
    ...options,
    rows: [{ field: "observed", operator: "gte", value: "2026-01-01T00:00:00Z" }],
  });
  const { query } = projectFilterRegistryToQuery(registry.snapshot, {
    sourceId: "parcels",
    source: { id: "parcels", protocol: "geoservices-feature-service", capabilities: capabilities(["query", "sql"]) },
  });
  expect(query.where).toBe("(observed >= TIMESTAMP '2026-01-01T00:00:00Z')");
});

test.each(["stac", "ogc-records", "odata"] as const)("uses the %s temporal dialect", (protocol) => {
  const registry = createFilterRegistry();
  applyFilterBuilder(registry, {
    ...options,
    rows: [{ field: "observed", operator: "gte", value: "2026-01-01T00:00:00Z" }],
  });
  const { query } = projectFilterRegistryToQuery(registry.snapshot, {
    sourceId: "parcels",
    source: { id: "parcels", protocol, capabilities: capabilities(["query", "sql"]) },
  });
  expect(query.where).toBe(
    protocol === "odata" ? "(observed ge 2026-01-01T00:00:00Z)" : "(observed >= TIMESTAMP('2026-01-01T00:00:00Z'))",
  );
});

test.each(["ogc-features", "stac", "ogc-records", "odata", "geoservices-feature-service"] as const)(
  "preserves qualified datetime fields for %s",
  (protocol) => {
    const registry = createFilterRegistry();
    registry.upsert({
      id: "observed",
      owner: { kind: "control", id: "test" },
      field: "events.observed",
      fieldType: "datetime",
      operator: ">=",
      value: "2026-01-01T00:00:00Z",
    });
    const { query } = projectFilterRegistryToQuery(registry.snapshot, {
      sourceId: "parcels",
      source: { id: "parcels", protocol, capabilities: capabilities(["query", "sql"]) },
    });
    expect(query.where).toContain("events.observed");
    expect(query.where).toContain("2026-01-01T00:00:00Z");
  },
);

test("binds both qualified fields in an OData datetime range", () => {
  const registry = createFilterRegistry();
  registry.upsert({
    id: "range",
    owner: { kind: "control", id: "test" },
    field: "events.observed",
    fieldType: "datetime",
    operator: "between",
    value: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
  });
  const { query } = projectFilterRegistryToQuery(registry.snapshot, {
    sourceId: "parcels",
    source: { id: "parcels", protocol: "odata", capabilities: capabilities(["query", "sql"]) },
  });
  expect(query.where).toBe("((events.observed ge 2026-01-01T00:00:00Z and events.observed le 2026-02-01T00:00:00Z))");
});
