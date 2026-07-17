import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SemanticQueryCorpusError,
  loadSemanticQueryCorpus,
  validateSemanticQueryCorpus,
} from "../conformance/semantic-query/loader.mjs";
import type { ExecutableCrsBinding, LogicalField, SourceSchemaV2 } from "../src/contract/schema.js";
import {
  compileSemanticDuckDbQuery,
  compileSemanticGeoServicesQuery,
  compileSemanticGrpcQuery,
  compileSemanticOdataQuery,
  compileSemanticOgcApiFeaturesQuery,
  compileSemanticWfsQuery,
  createGeoParquetResourceHandle,
} from "../src/query-planner/index.js";
import type { SemanticCompilationResult } from "../src/query-planner/index.js";
import { createSourceSchemaV2 } from "../src/source-schema.js";

type ProtocolId = "geoservices" | "ogc-cql2-json" | "wfs-fes-2.0" | "odata-v4" | "duckdb" | "honua-grpc";

interface CorpusProjection {
  readonly outcome: "exact" | "approximate" | "unsupported";
  readonly reason?: string;
  readonly loss?: { readonly code: string; readonly path: string };
  readonly diagnostic?: { readonly code: string; readonly path: string };
}

interface CorpusCase {
  readonly id: string;
  readonly covers: readonly string[];
  readonly query: Record<string, unknown>;
  readonly expected: { readonly rows: readonly Record<string, unknown>[] };
  readonly projections: Readonly<Record<ProtocolId, CorpusProjection>>;
}

interface Corpus {
  readonly kind: "honua.semantic-query-conformance-corpus";
  readonly version: "1.0";
  readonly frozenClock: string;
  readonly protocols: readonly ProtocolId[];
  readonly rows: readonly Record<string, unknown>[];
  readonly cases: readonly CorpusCase[];
}

const corpus = (await loadSemanticQueryCorpus()) as Corpus;

const epsg4326: ExecutableCrsBinding = {
  definition: {
    kind: "authority",
    authority: "EPSG",
    code: "4326",
    definitionAxisOrder: {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "latitude", direction: "north", unit: "degree" },
        { name: "longitude", direction: "east", unit: "degree" },
      ],
    },
  },
  coordinateOrder: {
    state: "known",
    source: "encoding",
    axes: [
      { name: "longitude", direction: "east", unit: "degree" },
      { name: "latitude", direction: "north", unit: "degree" },
    ],
  },
  provenance: { method: "declared" },
};

const epsg4326Uri = "http://www.opengis.net/def/crs/EPSG/0/4326";
const schema = semanticCorpusSchema();
const resource = createGeoParquetResourceHandle({
  resolver: "io.honua.semantic-conformance",
  id: "incidents-v1",
  authorizationContextId: "fixture:public",
  resourceVersion: "corpus:1.0",
});

const ogcConformance = [
  "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/features-filter",
  "http://www.opengis.net/spec/cql2/1.0/conf/basic-cql2",
  "http://www.opengis.net/spec/cql2/1.0/conf/cql2-json",
  "http://www.opengis.net/spec/cql2/1.0/conf/advanced-comparison-operators",
  "http://www.opengis.net/spec/cql2/1.0/conf/case-insensitive-comparison",
  "http://www.opengis.net/spec/cql2/1.0/conf/basic-spatial-functions",
  "http://www.opengis.net/spec/cql2/1.0/conf/basic-spatial-functions-plus",
  "http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions",
  "http://www.opengis.net/spec/cql2/1.0/conf/temporal-functions",
  "http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs",
] as const;

const wfsCapabilities = {
  version: "2.0.0",
  implementsAdHocQuery: true,
  implementsSorting: true,
  logicalOperators: true,
  comparisonOperators: [
    "PropertyIsBetween",
    "PropertyIsEqualTo",
    "PropertyIsGreaterThan",
    "PropertyIsGreaterThanOrEqualTo",
    "PropertyIsLessThan",
    "PropertyIsLessThanOrEqualTo",
    "PropertyIsLike",
    "PropertyIsNotEqualTo",
    "PropertyIsNull",
  ],
  geometryOperands: ["gml:Envelope", "gml:Point", "gml:Polygon"],
  spatialOperators: ["BBOX", "Contains", "Disjoint", "Equals", "Intersects", "Overlaps", "Touches", "Within"],
  temporalOperands: ["gml:TimeInstant", "gml:TimePeriod"],
  temporalOperators: ["After", "AnyInteracts", "Before", "During"],
  supportedFilterCrs: [epsg4326Uri],
  supportedOutputCrs: [epsg4326Uri],
} as const;

describe("versioned semantic query equivalence corpus", () => {
  it("loads bounded, schema-validated, immutable, credential-free fixtures", async () => {
    expect(corpus).toMatchObject({
      kind: "honua.semantic-query-conformance-corpus",
      version: "1.0",
      frozenClock: "2026-07-15T00:00:00Z",
      protocols: ["geoservices", "ogc-cql2-json", "wfs-fes-2.0", "odata-v4", "duckdb", "honua-grpc"],
    });
    expect(Object.isFrozen(corpus)).toBe(true);
    expect(Object.isFrozen(corpus.cases[0]?.query)).toBe(true);

    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "honua-semantic-corpus-"));
    try {
      const oversizedCorpus = path.join(temporaryRoot, "oversized-corpus.json");
      await writeFile(oversizedCorpus, new Uint8Array(2 * 1024 * 1024 + 1));
      await expect(loadSemanticQueryCorpus({ corpusUrl: pathToFileURL(oversizedCorpus) })).rejects.toThrow(
        "exceeds its bounded input contract",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }

    const schemaDocument = JSON.parse(
      await readFile(new URL("../conformance/semantic-query/v1/schema.json", import.meta.url), "utf8"),
    );
    const wrongType = structuredClone(corpus) as unknown as { rows: Record<string, unknown>[] };
    if (wrongType.rows[0]) wrongType.rows[0].id = "not-an-integer";
    expect(() => validateSemanticQueryCorpus(schemaDocument, wrongType)).toThrow(SemanticQueryCorpusError);

    const duplicateCase = structuredClone(corpus) as unknown as { cases: Array<{ id: string }> };
    if (duplicateCase.cases[0] && duplicateCase.cases[1]) duplicateCase.cases[1].id = duplicateCase.cases[0].id;
    expect(() => validateSemanticQueryCorpus(schemaDocument, duplicateCase)).toThrow(SemanticQueryCorpusError);

    const missingReason = structuredClone(corpus) as unknown as {
      cases: Array<{ projections: Record<string, Record<string, unknown>> }>;
    };
    const unsupported = missingReason.cases[1]?.projections["honua-grpc"];
    if (unsupported) delete unsupported.reason;
    expect(() => validateSemanticQueryCorpus(schemaDocument, missingReason)).toThrow(SemanticQueryCorpusError);

    const hostile = structuredClone(corpus) as unknown as Record<string, unknown>;
    const rows = hostile.rows as Record<string, unknown>[];
    rows[0] = { ...rows[0], status: "https://example.test/items?api_key=corpus-secret-marker" };
    let captured: unknown;
    try {
      validateSemanticQueryCorpus(schemaDocument, hostile);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(SemanticQueryCorpusError);
    expect(`${String(captured)}\n${JSON.stringify(captured)}`).not.toContain("corpus-secret-marker");
  });

  it("rejects ambiguous or ill-typed portable corpus semantics before compilation", async () => {
    const schemaDocument = JSON.parse(
      await readFile(new URL("../conformance/semantic-query/v1/schema.json", import.meta.url), "utf8"),
    );
    const attacks: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.frozenClock = "2026-07-15";
      },
      (value) => {
        const cases = value.cases as Array<{ query: Record<string, unknown> }>;
        cases[0]!.query.metrics = [{ fn: "count", field: "id", as: "count" }];
      },
      (value) => {
        const cases = value.cases as Array<{ query: Record<string, unknown> }>;
        cases[4]!.query.page = { kind: "first", offset: 999, limit: 2 };
      },
      (value) => {
        const cases = value.cases as Array<{ query: { filter: Record<string, unknown> } }>;
        cases[2]!.query.filter.value = {
          kind: "temporal-literal",
          valueType: "interval",
          value: ["not-an-instant", "still-not-an-instant"],
        };
      },
      (value) => {
        const cases = value.cases as Array<{ query: { filter: Record<string, unknown> } }>;
        cases[3]!.query.filter.bbox = { arbitrary: "object" };
      },
      (value) => {
        const cases = value.cases as Array<{
          query: { metrics: Array<Record<string, unknown>> };
          expected: { rows: Array<Record<string, unknown>> };
        }>;
        cases[5]!.query.metrics[1] = { fn: "sum", field: "status", as: "mean_score" };
        cases[5]!.expected.rows[0]!.mean_score = 0;
      },
      (value) => {
        const rows = value.rows as Array<Record<string, unknown>>;
        rows[0]!.observedAt = "2026-07-15T24:00:00Z";
      },
      (value) => {
        const schema = value.schema as { geometry: { definitionAxisOrder: string[] } };
        schema.geometry.definitionAxisOrder.push("height");
      },
      (value) => {
        const cases = value.cases as Array<{ query: { filter: Record<string, unknown> } }>;
        const bbox = cases[3]!.query.filter.bbox as {
          crs: { definition: { code: string } };
        };
        bbox.crs.definition.code = "3857";
      },
      (value) => {
        const cases = value.cases as Array<{ query: { filter: Record<string, unknown> } }>;
        const bbox = cases[3]!.query.filter.bbox as {
          crs: { coordinateOrder: { axes: Array<{ unit: string }> } };
        };
        bbox.crs.coordinateOrder.axes[0]!.unit = "radian";
      },
      (value) => {
        const cases = value.cases as Array<{ query: { filter: Record<string, unknown> } }>;
        const bbox = cases[3]!.query.filter.bbox as Record<string, unknown>;
        bbox.coordinateEpoch = 2026;
      },
    ];

    for (const attack of attacks) {
      const hostile = structuredClone(corpus) as unknown as Record<string, unknown>;
      attack(hostile);
      expect(() => validateSemanticQueryCorpus(schemaDocument, hostile)).toThrow(SemanticQueryCorpusError);
    }
  });

  it("covers the required semantic and adversarial matrix once", () => {
    const coverage = new Set(corpus.cases.flatMap((entry) => entry.covers));
    expect(coverage).toEqual(
      new Set([
        "comparison",
        "null",
        "list",
        "range",
        "pattern",
        "spatial",
        "temporal",
        "projection",
        "sort",
        "pagination",
        "grouping",
        "statistics",
        "injection",
        "unicode",
        "axis-order",
        "boundary",
        "approximate",
      ]),
    );
    expect(new Set(corpus.cases.map((entry) => entry.id)).size).toBe(corpus.cases.length);
  });

  for (const entry of corpus.cases) {
    it(`evaluates and compiles ${entry.id} across the complete protocol matrix`, () => {
      expect(evaluateReference(entry.query, corpus.rows)).toEqual(entry.expected.rows);
      expect(Object.keys(entry.projections).sort()).toEqual([...corpus.protocols].sort());

      for (const protocol of corpus.protocols) {
        const result = compileProjection(protocol, entry);
        assertProjection(result, entry.projections[protocol], `${entry.id}:${protocol}`);
      }
    });
  }
});

function compileProjection(protocol: ProtocolId, entry: CorpusCase): SemanticCompilationResult<unknown> {
  const query = entry.query as never;
  switch (protocol) {
    case "geoservices":
      return compileSemanticGeoServicesQuery({
        query,
        schema,
        source: {
          protocol: "geoservices-feature-service",
          serviceId: "semantic-conformance",
          layerId: 0,
          sourceVersion: "corpus:1.0",
          supportedSpatialRelationships: [
            "esriSpatialRelIntersects",
            "esriSpatialRelContains",
            "esriSpatialRelWithin",
            "esriSpatialRelTouches",
            "esriSpatialRelOverlaps",
            "esriSpatialRelCrosses",
          ],
          supportsAdvancedQueries: true,
          supportsPagination: true,
          supportsStatistics: true,
          supportsPaginationOnAggregatedQueries: true,
        },
      });
    case "ogc-cql2-json":
      return compileSemanticOgcApiFeaturesQuery({
        query,
        schema,
        source: { collectionId: "semantic-conformance" },
        conformance: {
          conformsTo: ogcConformance,
          supportedFilterCrs: [epsg4326Uri],
          supportedOutputCrs: [],
        },
        preferredFilterLanguage: "cql2-json",
      });
    case "wfs-fes-2.0":
      return compileSemanticWfsQuery({
        query,
        schema,
        source: {
          typeName: "inc:Incident",
          namespaces: { inc: "https://honua.io/conformance/semantic-query/v1" },
        },
        capabilities: wfsCapabilities,
      });
    case "odata-v4":
      return compileSemanticOdataQuery({
        query,
        schema,
        source: {
          entitySet: "Incidents",
          sourceVersion: "corpus:1.0",
          supportedSpatialFunctions: ["geo.intersects"],
        },
      });
    case "duckdb":
      return compileSemanticDuckDbQuery({
        query,
        schema,
        resource,
        geometry: { field: "shape", encoding: "wkb", bboxColumn: "bbox" },
        spatialStrategy: entry.id === "polygon-envelope-approximation" ? "bbox-envelope" : "exact",
      });
    case "honua-grpc":
      return compileSemanticGrpcQuery({
        query,
        schema,
        source: { serviceId: "semantic-conformance", layerId: 0 },
      });
  }
}

function assertProjection(result: SemanticCompilationResult<unknown>, expected: CorpusProjection, label: string): void {
  if (expected.outcome === "unsupported") {
    expect(result, label).toMatchObject({
      outcome: "unsupported",
      fidelity: "unsupported",
      diagnostics: [{ ...expected.diagnostic, message: expected.reason }],
    });
    return;
  }
  expect(result.outcome, `${label}:${JSON.stringify(result)}`).toBe("compiled");
  if (result.outcome !== "compiled") return;
  expect(result.fidelity, label).toBe(expected.outcome);
  if (expected.outcome === "approximate") {
    expect(result.losses, label).toContainEqual(
      expect.objectContaining({ ...expected.loss, message: expected.reason }),
    );
  } else {
    expect(result.losses, label).toEqual([]);
  }
  expect(Object.isFrozen(result), label).toBe(true);
}

function semanticCorpusSchema(): SourceSchemaV2 {
  const field = (
    name: string,
    type: LogicalField["type"],
    options: { readonly nullable?: boolean; readonly roles?: LogicalField["roles"] } = {},
  ): LogicalField => {
    const native: LogicalField["native"] = [
      { protocol: "wfs", name: `inc:${name}`, path: [`inc:${name}`] },
      ...(name === "observedAt"
        ? [
            {
              protocol: "geoservices-feature-service" as const,
              name: "esriFieldTypeDate",
              path: ["FeatureServer", "0", name],
            },
          ]
        : []),
      ...(name === "shape" ? [{ protocol: "odata" as const, name: "Edm.GeographyPoint", path: [name] }] : []),
    ];
    return {
      name,
      path: [name],
      type,
      nullability: options.nullable ? "nullable" : "non-nullable",
      mutability: "read-only",
      roles: options.roles ?? [],
      domain: { state: "none", reason: type.kind === "geometry" ? "not-applicable" : "unconstrained" },
      constraints: { state: "none" },
      native,
    };
  };

  return createSourceSchemaV2({
    fields: [
      field(
        "id",
        { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" },
        { roles: ["primary-key", "feature-id"] },
      ),
      field("status", { kind: "string" }),
      field("name", { kind: "string" }),
      field("score", { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" }),
      field("optionalNote", { kind: "string" }, { nullable: true }),
      field("observedAt", { kind: "timestamp", unit: "second", timezone: "utc" }, { roles: ["time-instant"] }),
      field("shape", { kind: "geometry" }, { roles: ["geometry"] }),
    ],
    key: { state: "known", fields: ["id"] },
    geometry: {
      state: "known",
      fields: [
        {
          field: "shape",
          geometryTypes: { state: "known", type: "Point" },
          crs: epsg4326,
          layout: "xy",
          allowsEmpty: false,
        },
      ],
      primaryField: { state: "known", field: "shape" },
    },
    temporal: { state: "instant", field: "observedAt" },
    openContent: "closed",
    provenance: [
      {
        method: "declared",
        protocol: "ogc-features",
        source: "conformance/semantic-query/v1/corpus.json",
      },
    ],
  });
}

function evaluateReference(
  query: Record<string, unknown>,
  sourceRows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  let rows = sourceRows.filter((row) => !query.filter || evaluateFilter(query.filter as Filter, row));
  if (query.kind === "aggregate") {
    rows = aggregateRows(rows, query.groupBy as string[], query.metrics as Metric[]);
  }
  const sort = (query.sort ?? []) as Sort[];
  if (sort.length > 0) rows = [...rows].sort((left, right) => compareRows(left, right, sort));
  const page = query.page as
    | { readonly kind: "first"; readonly limit: number }
    | { readonly kind: "offset"; readonly offset: number; readonly limit: number }
    | undefined;
  if (page) {
    const offset = page.kind === "offset" ? page.offset : 0;
    rows = rows.slice(offset, offset + page.limit);
  }
  if (query.kind === "features") {
    const select = query.select as string[] | undefined;
    rows = rows.map((row) => projectRow(row, select, query.geometry as string | undefined));
  }
  return structuredClone(rows);
}

interface Sort {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last" | "native";
}

interface Metric {
  readonly fn: "count" | "sum" | "avg" | "min" | "max";
  readonly field?: string;
  readonly as: string;
}

type Filter = Record<string, unknown>;

function evaluateFilter(filter: Filter, row: Record<string, unknown>): boolean {
  switch (filter.kind) {
    case "comparison": {
      const left = row[propertyName(filter.left)];
      const right = literalValue(filter.right);
      switch (filter.operator) {
        case "eq":
          return left === right;
        case "ne":
          return left !== right;
        case "lt":
          return compareScalar(left, right) < 0;
        case "lte":
          return compareScalar(left, right) <= 0;
        case "gt":
          return compareScalar(left, right) > 0;
        case "gte":
          return compareScalar(left, right) >= 0;
      }
      break;
    }
    case "list":
      return (filter.values as Filter[]).some((value) => row[propertyName(filter.operand)] === literalValue(value));
    case "range": {
      const value = row[propertyName(filter.operand)];
      return (
        compareScalar(value, literalValue(filter.lower)) >= 0 && compareScalar(value, literalValue(filter.upper)) <= 0
      );
    }
    case "null":
      return filter.operator === "is-null"
        ? row[propertyName(filter.operand)] == null
        : row[propertyName(filter.operand)] != null;
    case "pattern":
      return sqlLike(String(row[propertyName(filter.operand)]), String(filter.pattern), filter.caseSensitive !== false);
    case "boolean":
      return filter.operator === "and"
        ? (filter.args as Filter[]).every((entry) => evaluateFilter(entry, row))
        : (filter.args as Filter[]).some((entry) => evaluateFilter(entry, row));
    case "not":
      return !evaluateFilter(filter.arg as Filter, row);
    case "temporal": {
      const value = String(row[propertyName(filter.operand)]);
      const temporal = filter.value as { readonly value: string | readonly [string, string] };
      if (filter.operator === "before" || filter.operator === "after") {
        if (typeof temporal.value !== "string") throw new Error("Reference temporal instant is invalid");
        return filter.operator === "before" ? value < temporal.value : value > temporal.value;
      }
      const [start, end] = temporal.value as readonly [string, string];
      return value >= start && value <= end;
    }
    case "spatial": {
      const shape = row[propertyName(filter.property)] as {
        readonly type: "Point";
        readonly coordinates: readonly [number, number];
      };
      if (filter.operator === "bbox-intersects") {
        const bounds = ((filter.bbox as Filter).box as { readonly bounds: readonly number[] }).bounds;
        return pointInBounds(shape.coordinates, bounds);
      }
      if (filter.operator === "intersects") {
        const geometry = (filter.geometry as Filter).geometry as Filter as {
          readonly type: "Polygon";
          readonly coordinates: readonly (readonly (readonly [number, number])[])[];
        };
        return pointInPolygon(shape.coordinates, geometry.coordinates[0] ?? []);
      }
      break;
    }
  }
  throw new Error(`Reference evaluator does not implement ${String(filter.kind)}:${String(filter.operator)}`);
}

function propertyName(value: unknown): string {
  return (value as { readonly name: string }).name;
}

function literalValue(value: unknown): unknown {
  return (value as { readonly value: unknown }).value;
}

function compareScalar(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function sqlLike(value: string, pattern: string, caseSensitive: boolean): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("%", ".*")
    .replaceAll("_", ".");
  return new RegExp(`^${escaped}$`, caseSensitive ? "u" : "iu").test(value);
}

function pointInBounds(point: readonly [number, number], bounds: readonly number[]): boolean {
  return (
    point[0] >= (bounds[0] ?? Number.POSITIVE_INFINITY) &&
    point[0] <= (bounds[2] ?? Number.NEGATIVE_INFINITY) &&
    point[1] >= (bounds[1] ?? Number.POSITIVE_INFINITY) &&
    point[1] <= (bounds[3] ?? Number.NEGATIVE_INFINITY)
  );
}

function pointInPolygon(point: readonly [number, number], ring: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (!currentPoint || !previousPoint) continue;
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) / (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
): boolean {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > Number.EPSILON * 16) return false;
  return (
    point[0] >= Math.min(start[0], end[0]) &&
    point[0] <= Math.max(start[0], end[0]) &&
    point[1] >= Math.min(start[1], end[1]) &&
    point[1] <= Math.max(start[1], end[1])
  );
}

function aggregateRows(
  rows: readonly Record<string, unknown>[],
  groupBy: readonly string[],
  metrics: readonly Metric[],
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = JSON.stringify(groupBy.map((field) => row[field]));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const result: Record<string, unknown> = {};
    for (const field of groupBy) result[field] = group[0]?.[field];
    for (const metric of metrics) {
      const values = metric.field
        ? group.map((row) => row[metric.field as string]).filter((value) => value != null)
        : group;
      switch (metric.fn) {
        case "count":
          result[metric.as] = values.length;
          break;
        case "sum":
          result[metric.as] = values.reduce<number>((sum, value) => sum + Number(value), 0);
          break;
        case "avg":
          result[metric.as] = values.reduce<number>((sum, value) => sum + Number(value), 0) / values.length;
          break;
        case "min":
          result[metric.as] = values.reduce((minimum, value) => (compareScalar(value, minimum) < 0 ? value : minimum));
          break;
        case "max":
          result[metric.as] = values.reduce((maximum, value) => (compareScalar(value, maximum) > 0 ? value : maximum));
          break;
      }
    }
    return result;
  });
}

function compareRows(left: Record<string, unknown>, right: Record<string, unknown>, sort: readonly Sort[]): number {
  for (const entry of sort) {
    const compared = compareScalar(left[entry.field], right[entry.field]);
    if (compared !== 0) return entry.direction === "desc" ? -compared : compared;
  }
  return 0;
}

function projectRow(
  row: Record<string, unknown>,
  select: readonly string[] | undefined,
  geometry: string | undefined,
): Record<string, unknown> {
  if (select) return Object.fromEntries(select.map((field) => [field, row[field]]));
  if (geometry !== "omit") return row;
  const { shape: _shape, ...attributes } = row;
  return attributes;
}
