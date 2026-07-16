/**
 * Compile canonical query IR to deterministic DuckDB SQL over
 * `read_parquet(...)` for the GeoParquet columnar `Source`, without performing
 * any network, filesystem, or DuckDB metadata I/O.
 *
 * The heavy lifting — identifier/literal escaping, spatial predicate pushdown,
 * GeoJSON projection, and GROUP BY aggregation — is delegated to the
 * dependency-free {@link module:core/geoparquet-sql} SQL builder that the live
 * GeoParquet `Source` already uses, so the planner and the adapter emit the
 * exact same SQL for the same inputs.
 *
 * @module
 */

import { validateExecutableCrsBinding } from "../contract/schema.js";
import type {
  ExecutableCrsBinding,
  JsonPrimitive,
  JsonValue,
  LogicalField,
  SourceSchemaV2,
} from "../contract/schema.js";
import type { AggregationSpec } from "../contract/types.js";
import {
  type CompileOptions,
  type GeometryColumnPlan,
  compileAggregate,
  compileQuery,
  geometryExpr,
  parquetSourceExpr,
  quoteIdentifier,
} from "../core/geoparquet-sql.js";
import { queryFromCanonical } from "./ir.js";
import { parseGeoParquetResourceHandle } from "./resource.js";
import type { GeoParquetResourceHandleV1 } from "./resource.js";
import { hashSemanticQuery } from "./semantic-canonical.js";
import {
  type RuntimeSemanticQuery,
  type SemanticCompilationResult,
  type SemanticCompilerLoss,
  type SemanticSqlParameter,
  prepareSemanticCompilerQuery,
  runSemanticCompiler,
  sameCrsDefinition,
  sameExecutableCrs,
  semanticSchemaField,
  semanticUnsupported,
} from "./semantic-compiler.js";
import type { QueryFilter, SemanticQuery, SourceSpatiality } from "./semantic-types.js";
import type {
  CanonicalQuery,
  DuckDbCompiledQueryV1,
  DuckDbCompiledQueryV2,
  DuckDbGeometryEncoding,
  QueryIrSourceIdentity,
  QueryIrSourceIdentityV2,
} from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

const RESOURCE_SQL_PLACEHOLDER = "honua-resource://resolve-at-execution";

/** Physical GeoParquet geometry metadata required by the semantic compiler. */
export interface SemanticDuckDbGeometrySource {
  /** Logical SourceSchemaV2 field carrying the physical geometry column path. */
  readonly field: string;
  readonly encoding: DuckDbGeometryEncoding;
  /** Optional GeoParquet 1.1 bbox-covering struct column. */
  readonly bboxColumn?: string;
}

/** Pure, credential-free inputs for semantic DuckDB compilation. */
export interface SemanticDuckDbCompileOptions<
  TRecord = Record<string, unknown>,
  TSpatiality extends SourceSpatiality = SourceSpatiality,
> {
  readonly query: SemanticQuery<TRecord, "geoparquet", TSpatiality>;
  readonly schema: SourceSchemaV2;
  readonly resource: GeoParquetResourceHandleV1;
  readonly geometry?: SemanticDuckDbGeometrySource;
  /** Exact by default; bbox reduction is opt-in and always reported as approximate. */
  readonly spatialStrategy?: "exact" | "bbox-envelope";
}

export interface SemanticDuckDbSpatialCompilation {
  readonly path: string;
  readonly field: string;
  readonly encoding: DuckDbGeometryEncoding;
  readonly strategy: "exact" | "bbox-envelope";
  readonly crs: ExecutableCrsBinding;
}

/** Parameterized DuckDB artifact over an opaque #587 resource handle. */
export interface SemanticDuckDbCompiledQueryV1 {
  readonly compiler: "duckdb-semantic-query-v1";
  readonly dialect: "duckdb-sql";
  readonly schemaFingerprint: SourceSchemaV2["fingerprint"];
  readonly queryFingerprint: `sha256:${string}`;
  readonly resource: GeoParquetResourceHandleV1;
  readonly sqlTemplate: string;
  readonly parameters: readonly SemanticSqlParameter[];
  readonly spatial: readonly SemanticDuckDbSpatialCompilation[];
  readonly usesNativeFilter: boolean;
}

/**
 * Compile canonical query IR to a deterministic DuckDB `SELECT`. Reuses the
 * GeoParquet `Source` SQL builder, so the compiled SQL is byte-identical to
 * what the live adapter runs for the same descriptor + query.
 */
export function compileDuckDbQuery(source: QueryIrSourceIdentity, query: CanonicalQuery): DuckDbCompiledQueryV1 {
  if (source.protocol !== "geoparquet") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `duckdb-sql-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  const geoparquet = source.geoparquet;
  if (!geoparquet || geoparquet.sources.length === 0) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.url (a parquet file or hive glob) for DuckDB planning`,
    );
  }
  if (query.outSr !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "DuckDB/GeoParquet has no portable output-CRS query option; omit outSr and reproject downstream",
    );
  }
  if (query.spatialFilter && !geoparquet.geometryColumn) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `Source "${source.id}" has a spatialFilter but no geometry column; set locator.geoparquet.geometryColumn or a geometry schema field`,
    );
  }

  const geometry: GeometryColumnPlan | undefined = geoparquet.geometryColumn
    ? {
        column: geoparquet.geometryColumn,
        encoding: geoparquet.geometryEncoding ?? "wkb",
        ...(geoparquet.bboxColumn ? { bboxColumn: geoparquet.bboxColumn } : {}),
      }
    : undefined;

  const options: CompileOptions = {
    sources: geoparquet.sources,
    geometryAlias: "geometry",
    ...(geometry ? { geometry } : {}),
  };

  const request = queryFromCanonical(query);
  try {
    const compiled = query.aggregation
      ? compileAggregate({ ...request, aggregation: query.aggregation as AggregationSpec }, options)
      : compileQuery(request, options);
    return {
      compiler: "duckdb-sql-v1",
      sql: compiled.sql,
      sources: geoparquet.sources,
      ...(geometry ? { geometryColumn: geometry.column, geometryEncoding: geometry.encoding } : {}),
      ...(compiled.bboxApproximated ? { bboxApproximated: true } : {}),
    };
  } catch (error) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `DuckDB query cannot be compiled deterministically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Compile a credential-free template; execution recompiles with ephemeral resolved sources. */
export function compileDuckDbQueryV2(source: QueryIrSourceIdentityV2, query: CanonicalQuery): DuckDbCompiledQueryV2 {
  const geoparquet = source.geoparquet;
  if (query.outSr !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "DuckDB/GeoParquet has no portable output-CRS query option; omit outSr and reproject downstream",
    );
  }
  if (query.spatialFilter && !geoparquet.geometryColumn) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `Source "${source.id}" has a spatialFilter but no geometry column; set locator.geoparquet.geometryColumn or a geometry schema field`,
    );
  }

  const geometry: GeometryColumnPlan | undefined = geoparquet.geometryColumn
    ? {
        column: geoparquet.geometryColumn,
        encoding: geoparquet.geometryEncoding ?? "wkb",
        ...(geoparquet.bboxColumn ? { bboxColumn: geoparquet.bboxColumn } : {}),
      }
    : undefined;
  const options: CompileOptions = {
    sources: [RESOURCE_SQL_PLACEHOLDER],
    geometryAlias: "geometry",
    ...(geometry ? { geometry } : {}),
  };
  const request = queryFromCanonical(query);
  try {
    const compiled = query.aggregation
      ? compileAggregate({ ...request, aggregation: query.aggregation as AggregationSpec }, options)
      : compileQuery(request, options);
    return {
      compiler: "duckdb-sql-v2",
      sqlTemplate: compiled.sql,
      resource: geoparquet.resource,
      ...(geometry ? { geometryColumn: geometry.column, geometryEncoding: geometry.encoding } : {}),
      ...(compiled.bboxApproximated ? { bboxApproximated: true } : {}),
    };
  } catch {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "DuckDB query cannot be compiled safely for an opaque GeoParquet resource",
    );
  }
}

type RuntimeDuckDbQuery = RuntimeSemanticQuery<"geoparquet">;
type RuntimeDuckDbFilter = QueryFilter<Record<string, unknown>, "geoparquet", SourceSpatiality>;

interface DuckDbSemanticState {
  readonly schema: SourceSchemaV2;
  readonly geometry?: SemanticDuckDbGeometrySource;
  readonly spatialStrategy: "exact" | "bbox-envelope";
  readonly parameters: SemanticSqlParameter[];
  readonly spatial: SemanticDuckDbSpatialCompilation[];
  readonly losses: SemanticCompilerLoss[];
  usesNativeFilter: boolean;
}

/**
 * Compile the schema-validated semantic AST into parameterized DuckDB SQL.
 * The table address remains the fixed opaque-resource placeholder; only a
 * trusted execution boundary may resolve the attached handle to raw locators.
 */
export function compileSemanticDuckDbQuery<TRecord, TSpatiality extends SourceSpatiality>(
  options: SemanticDuckDbCompileOptions<TRecord, TSpatiality>,
): SemanticCompilationResult<SemanticDuckDbCompiledQueryV1> {
  return runSemanticCompiler(() => {
    const { query, schema } = prepareSemanticCompilerQuery(options.query, options.schema, "geoparquet");
    const resource = verifiedSemanticResource(options.resource);
    const geometry = options.geometry ? verifyDuckDbGeometrySource(options.geometry, schema) : undefined;
    const spatialStrategy = verifiedDuckDbSpatialStrategy(options.spatialStrategy);
    const state: DuckDbSemanticState = {
      schema,
      ...(geometry ? { geometry } : {}),
      spatialStrategy,
      parameters: [],
      spatial: [],
      losses: [],
      usesNativeFilter: false,
    };
    const projection = duckDbProjection(query, state);
    const filter = query.filter
      ? compileDuckDbFilter(query.filter as RuntimeDuckDbFilter, state, "$.filter")
      : undefined;
    const groupBy = query.kind === "aggregate" ? duckDbGroupBy(query, state) : "";
    const orderBy = duckDbOrderBy(query, state);
    const page = duckDbPage(query);
    const sqlTemplate = `SELECT ${projection} FROM ${parquetSourceExpr([RESOURCE_SQL_PLACEHOLDER])}${
      filter ? ` WHERE ${filter}` : ""
    }${groupBy}${orderBy}${page}`;
    const artifact: SemanticDuckDbCompiledQueryV1 = {
      compiler: "duckdb-semantic-query-v1",
      dialect: "duckdb-sql",
      schemaFingerprint: schema.fingerprint,
      queryFingerprint: hashSemanticQuery(query, { schema, protocol: "geoparquet" }),
      resource,
      sqlTemplate,
      parameters: state.parameters,
      spatial: state.spatial,
      usesNativeFilter: state.usesNativeFilter,
    };
    return { artifact, losses: state.losses };
  });
}

function verifiedDuckDbSpatialStrategy(
  value: SemanticDuckDbCompileOptions["spatialStrategy"],
): DuckDbSemanticState["spatialStrategy"] {
  if (value === undefined || value === "exact") return "exact";
  if (value === "bbox-envelope") return value;
  throw new HonuaQueryPlanningError("invalid-query", "options.spatialStrategy is invalid");
}

function verifiedSemanticResource(value: GeoParquetResourceHandleV1): GeoParquetResourceHandleV1 {
  try {
    return parseGeoParquetResourceHandle(value);
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic DuckDB compilation requires a valid resource handle");
  }
}

function verifyDuckDbGeometrySource(
  value: SemanticDuckDbGeometrySource,
  schema: SourceSchemaV2,
): SemanticDuckDbGeometrySource {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic DuckDB geometry metadata is invalid");
  }
  const field = semanticSchemaField(schema, value.field, "options.geometry.field");
  if (field.type.kind !== "geometry") {
    throw new HonuaQueryPlanningError("invalid-query", "options.geometry.field must identify a geometry field");
  }
  if (field.path.length !== 1) {
    semanticUnsupported(
      "unsupported-geometry",
      "options.geometry.field",
      "DuckDB geometry columns must have one physical path segment",
    );
  }
  if (value.encoding !== "wkb" && value.encoding !== "native" && value.encoding !== "geojson") {
    throw new HonuaQueryPlanningError("invalid-query", "options.geometry.encoding is invalid");
  }
  if (value.bboxColumn !== undefined && (typeof value.bboxColumn !== "string" || value.bboxColumn.length === 0)) {
    throw new HonuaQueryPlanningError("invalid-query", "options.geometry.bboxColumn is invalid");
  }
  return {
    field: field.name,
    encoding: value.encoding,
    ...(value.bboxColumn !== undefined ? { bboxColumn: value.bboxColumn } : {}),
  };
}

function duckDbProjection(query: RuntimeDuckDbQuery, state: DuckDbSemanticState): string {
  if (query.kind === "aggregate") {
    if (query.outputCrs) {
      semanticUnsupported(
        "unsupported-projection",
        "$.outputCrs",
        "DuckDB aggregate rows do not carry output geometry",
      );
    }
    const parts = query.groupBy.map((name, index) =>
      aliasedDuckDbField(state.schema, name as string, `$.groupBy[${index}]`),
    );
    query.metrics.forEach((metric, index) => {
      const field = metric.field
        ? semanticSchemaField(state.schema, metric.field as string, `$.metrics[${index}].field`)
        : undefined;
      const operand = field ? duckDbFieldExpression(field, `$.metrics[${index}].field`) : "*";
      const aggregate = duckDbAggregateFunction(metric.fn, operand);
      parts.push(`${aggregate} AS ${duckDbIdentifier(metric.as, `$.metrics[${index}].as`)}`);
    });
    return parts.join(", ");
  }

  const geometryField = selectedDuckDbGeometryField(query, state);
  const names =
    query.select ?? state.schema.fields.filter((field) => field.type.kind !== "geometry").map((field) => field.name);
  const parts: string[] = [];
  names.forEach((name, index) => {
    const field = semanticSchemaField(state.schema, name as string, `$.select[${index}]`);
    if (field.type.kind === "geometry") {
      if (!geometryField || field.name !== geometryField.name) {
        semanticUnsupported(
          "unsupported-projection",
          `$.select[${index}]`,
          "DuckDB semantic results expose only the selected top-level geometry",
        );
      }
      return;
    }
    parts.push(aliasedDuckDbField(state.schema, field.name, `$.select[${index}]`));
  });
  if (geometryField) {
    const geometry = requiredDuckDbGeometry(state, geometryField.name, "$.geometry");
    assertDuckDbOutputCrs(query, geometryField, state);
    parts.push(
      `ST_AsGeoJSON(${duckDbGeometryExpression(geometryField, geometry, "$.geometry")}) AS ${quoteIdentifier("geometry")}`,
    );
  } else if (query.outputCrs) {
    semanticUnsupported(
      "unsupported-projection",
      "$.outputCrs",
      "DuckDB cannot apply an output CRS when geometry is omitted",
    );
  }
  return parts.length > 0 ? parts.join(", ") : `1 AS ${quoteIdentifier("__honua_row")}`;
}

function selectedDuckDbGeometryField(
  query: Extract<RuntimeDuckDbQuery, { readonly kind: "features" }>,
  state: DuckDbSemanticState,
): LogicalField | undefined {
  if (query.geometry === "omit") return undefined;
  if (query.geometry && typeof query.geometry === "object") {
    return semanticSchemaField(state.schema, query.geometry.field, "$.geometry.field");
  }
  const geometry = state.schema.geometry;
  if (geometry.state === "known" && geometry.primaryField.state === "known") {
    return semanticSchemaField(state.schema, geometry.primaryField.field, "$.geometry");
  }
  if (query.geometry === "include") {
    semanticUnsupported(
      "unsupported-projection",
      "$.geometry",
      "DuckDB geometry inclusion requires a known primary geometry field",
    );
  }
  return undefined;
}

function assertDuckDbOutputCrs(
  query: Extract<RuntimeDuckDbQuery, { readonly kind: "features" }>,
  field: LogicalField,
  state: DuckDbSemanticState,
): void {
  if (!query.outputCrs) return;
  const geometry = sourceGeometryField(state.schema, field.name, "$.geometry");
  const sourceCrs = executableDuckDbCrs(geometry.crs, "$.geometry");
  if (!sameCrsDefinition(query.outputCrs, sourceCrs.definition)) {
    semanticUnsupported(
      "crs-transform-required",
      "$.outputCrs",
      "DuckDB semantic compilation does not silently insert a CRS transform",
    );
  }
}

function duckDbGroupBy(
  query: Extract<RuntimeDuckDbQuery, { readonly kind: "aggregate" }>,
  state: DuckDbSemanticState,
): string {
  if (query.groupBy.length === 0) return "";
  return ` GROUP BY ${query.groupBy
    .map((name, index) =>
      duckDbFieldExpression(
        semanticSchemaField(state.schema, name as string, `$.groupBy[${index}]`),
        `$.groupBy[${index}]`,
      ),
    )
    .join(", ")}`;
}

function duckDbAggregateFunction(fn: string, operand: string): string {
  switch (fn) {
    case "count":
      return `count(${operand})`;
    case "sum":
      return `sum(${operand})`;
    case "avg":
      return `avg(${operand})`;
    case "min":
      return `min(${operand})`;
    case "max":
      return `max(${operand})`;
    case "stddev":
      return `stddev_samp(${operand})`;
    case "variance":
      return `var_samp(${operand})`;
    default:
      semanticUnsupported("unsupported-node", "$.metrics", `DuckDB does not support aggregate ${JSON.stringify(fn)}`);
  }
}

function duckDbOrderBy(query: RuntimeDuckDbQuery, state: DuckDbSemanticState): string {
  if (!query.sort || query.sort.length === 0) return "";
  if (query.kind === "aggregate") {
    const groupFields = new Set(query.groupBy as readonly string[]);
    const unsupportedIndex = query.sort.findIndex((sort) => !groupFields.has(sort.field as string));
    if (unsupportedIndex >= 0) {
      semanticUnsupported(
        "unsupported-sort",
        `$.sort[${unsupportedIndex}].field`,
        "Aggregate DuckDB queries may sort only by a grouped source field",
      );
    }
  }
  const parts = query.sort.map((sort, index) => {
    const field = semanticSchemaField(state.schema, sort.field as string, `$.sort[${index}].field`);
    const nulls = sort.nulls === "first" ? " NULLS FIRST" : sort.nulls === "last" ? " NULLS LAST" : "";
    return `${duckDbFieldExpression(field, `$.sort[${index}].field`)} ${sort.direction.toUpperCase()}${nulls}`;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}

function duckDbPage(query: RuntimeDuckDbQuery): string {
  if (!query.page) return "";
  const limit = query.page.limit === undefined ? "" : ` LIMIT ${query.page.limit}`;
  const offset = query.page.kind === "offset" && query.page.offset > 0 ? ` OFFSET ${query.page.offset}` : "";
  return `${limit}${offset}`;
}

function compileDuckDbFilter(filter: RuntimeDuckDbFilter, state: DuckDbSemanticState, path: string): string {
  switch (filter.kind) {
    case "comparison": {
      const field = semanticSchemaField(state.schema, filter.left.name, `${path}.left.name`);
      const operator = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.operator];
      return `${duckDbFieldExpression(field, `${path}.left.name`)} ${operator} ${duckDbLiteralParameter(
        filter.right.value,
        field,
        state,
        `${path}.right.value`,
      )}`;
    }
    case "list": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const values = filter.values.map((literal, index) =>
        duckDbLiteralParameter(literal.value, field, state, `${path}.values[${index}].value`),
      );
      return `${duckDbFieldExpression(field, `${path}.operand.name`)} IN (${values.join(", ")})`;
    }
    case "range": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${duckDbFieldExpression(field, `${path}.operand.name`)} BETWEEN ${duckDbLiteralParameter(
        filter.lower.value,
        field,
        state,
        `${path}.lower.value`,
      )} AND ${duckDbLiteralParameter(filter.upper.value, field, state, `${path}.upper.value`)}`;
    }
    case "null": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${duckDbFieldExpression(field, `${path}.operand.name`)} IS ${filter.operator === "is-not-null" ? "NOT " : ""}NULL`;
    }
    case "pattern": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const parameter = duckDbParameter(state, filter.pattern, "literal", field);
      return `${duckDbFieldExpression(field, `${path}.operand.name`)} ${filter.caseSensitive === false ? "ILIKE" : "LIKE"} ${parameter}`;
    }
    case "boolean":
      return `(${filter.args
        .map((entry, index) => compileDuckDbFilter(entry as RuntimeDuckDbFilter, state, `${path}.args[${index}]`))
        .join(` ${filter.operator.toUpperCase()} `)})`;
    case "not":
      return `NOT (${compileDuckDbFilter(filter.arg as RuntimeDuckDbFilter, state, `${path}.arg`)})`;
    case "temporal": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      if (filter.operator === "before" || filter.operator === "after") {
        const value = filter.value.value as string;
        return `${duckDbFieldExpression(field, `${path}.operand.name`)} ${filter.operator === "before" ? "<" : ">"} ${duckDbLiteralParameter(
          value,
          field,
          state,
          `${path}.value.value`,
        )}`;
      }
      const interval = filter.value.value as readonly [string, string];
      return `${duckDbFieldExpression(field, `${path}.operand.name`)} BETWEEN ${duckDbLiteralParameter(
        interval[0],
        field,
        state,
        `${path}.value.value[0]`,
      )} AND ${duckDbLiteralParameter(interval[1], field, state, `${path}.value.value[1]`)}`;
    }
    case "spatial":
      return compileDuckDbSpatial(filter, state, path);
    case "native": {
      if (filter.dialect !== "duckdb-sql" || filter.payload.format !== "text") {
        semanticUnsupported(
          "unsupported-native-filter",
          path,
          "DuckDB native filters require a duckdb-sql text payload",
        );
      }
      state.usesNativeFilter = true;
      return `(${filter.payload.text})`;
    }
  }
}

function compileDuckDbSpatial(
  filter: Extract<RuntimeDuckDbFilter, { readonly kind: "spatial" }>,
  state: DuckDbSemanticState,
  path: string,
): string {
  const fieldName = semanticSpatialField(filter, state.schema, path);
  const field = semanticSchemaField(state.schema, fieldName, `${path}.property.name`);
  const geometry = requiredDuckDbGeometry(state, field.name, path);
  const fieldSchema = sourceGeometryField(state.schema, field.name, path);
  const sourceCrs = executableDuckDbCrs(fieldSchema.crs, `${path}.property`);
  if (fieldSchema.layout !== "xy") {
    semanticUnsupported(
      "unsupported-geometry",
      path,
      "DuckDB semantic spatial predicates currently require an xy geometry field",
    );
  }
  const sourceExpression = duckDbGeometryExpression(field, geometry, `${path}.property`);

  if (filter.operator === "bbox-intersects") {
    if (!sameExecutableCrs(filter.bbox.crs, sourceCrs)) {
      semanticUnsupported(
        "crs-transform-required",
        `${path}.bbox.crs`,
        "Spatial bbox CRS differs from the source field",
      );
    }
    if (filter.bbox.box.layout !== "xy") {
      semanticUnsupported("unsupported-geometry", `${path}.bbox`, "DuckDB bbox predicates currently require xy bounds");
    }
    const [xmin, ymin, xmax, ymax] = filter.bbox.box.bounds;
    const predicate = duckDbExactEnvelopePredicate(
      sourceExpression,
      geometry.bboxColumn,
      [xmin, ymin, xmax, ymax],
      state,
    );
    state.spatial.push({ path, field: field.name, encoding: geometry.encoding, strategy: "exact", crs: sourceCrs });
    return predicate;
  }

  if (!sameExecutableCrs(filter.geometry.crs, sourceCrs)) {
    semanticUnsupported(
      "crs-transform-required",
      `${path}.geometry.crs`,
      "Spatial geometry CRS differs from the source field",
    );
  }
  if (filter.geometry.layout !== "xy") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometry.layout`,
      "DuckDB semantic spatial predicates currently require xy literal geometry",
    );
  }

  if (state.spatialStrategy === "bbox-envelope" && filter.operator === "intersects") {
    const bounds = executableGeometryBounds(filter.geometry, `${path}.geometry`);
    const predicate = duckDbEnvelopePredicate(sourceExpression, geometry.bboxColumn, bounds, state);
    state.spatial.push({
      path,
      field: field.name,
      encoding: geometry.encoding,
      strategy: "bbox-envelope",
      crs: sourceCrs,
    });
    state.losses.push({
      code: "spatial-envelope-reduction",
      path,
      message: "The intersects operand was explicitly reduced to its bounding envelope",
    });
    return predicate;
  }

  const geometryParameter = duckDbParameter(
    state,
    JSON.stringify(filter.geometry.geometry),
    "geometry",
    field,
    "geometry-json",
  );
  const literalExpression = `ST_GeomFromGeoJSON(${geometryParameter})`;
  state.spatial.push({ path, field: field.name, encoding: geometry.encoding, strategy: "exact", crs: sourceCrs });

  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    if (filter.distance.mode !== "planar") {
      semanticUnsupported(
        "unsupported-distance",
        `${path}.distance.mode`,
        "DuckDB geometry distance does not preserve geodesic mode",
      );
    }
    assertDuckDbDistanceUnit(filter.distance.unit, sourceCrs, `${path}.distance.unit`);
    const distance = duckDbParameter(state, filter.distance.value, "distance", field, "distance");
    const dWithin = `ST_DWithin(${sourceExpression}, ${literalExpression}, ${distance})`;
    return filter.operator === "within-distance" ? dWithin : `NOT (${dWithin})`;
  }

  const fn = {
    equals: "ST_Equals",
    intersects: "ST_Intersects",
    within: "ST_Within",
    contains: "ST_Contains",
    disjoint: "ST_Disjoint",
    touches: "ST_Touches",
    overlaps: "ST_Overlaps",
    crosses: "ST_Crosses",
  }[filter.operator];
  return `${fn}(${sourceExpression}, ${literalExpression})`;
}

function semanticSpatialField(
  filter: Extract<RuntimeDuckDbFilter, { readonly kind: "spatial" }>,
  schema: SourceSchemaV2,
  path: string,
): string {
  if (filter.property) return filter.property.name;
  if (schema.geometry.state === "known" && schema.geometry.primaryField.state === "known") {
    return schema.geometry.primaryField.field;
  }
  semanticUnsupported("unsupported-geometry", `${path}.property`, "A spatial predicate requires a geometry field");
}

function requiredDuckDbGeometry(
  state: DuckDbSemanticState,
  fieldName: string,
  path: string,
): SemanticDuckDbGeometrySource {
  if (!state.geometry || state.geometry.field !== fieldName) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "DuckDB physical geometry metadata is unavailable for the requested geometry field",
    );
  }
  return state.geometry;
}

function sourceGeometryField(schema: SourceSchemaV2, fieldName: string, path: string) {
  if (schema.geometry.state !== "known") {
    semanticUnsupported("unsupported-source", path, "Source geometry metadata is unavailable");
  }
  const field = schema.geometry.fields.find((candidate) => candidate.field === fieldName);
  if (!field) semanticUnsupported("unsupported-source", path, "Source geometry field metadata is unavailable");
  return field;
}

function duckDbGeometryExpression(field: LogicalField, geometry: SemanticDuckDbGeometrySource, path: string): string {
  try {
    return geometryExpr({ column: field.path[0] as string, encoding: geometry.encoding });
  } catch {
    semanticUnsupported("unsupported-source", path, "DuckDB cannot represent the physical geometry field path");
  }
}

function duckDbEnvelopePredicate(
  sourceExpression: string,
  bboxColumn: string | undefined,
  bounds: readonly [number, number, number, number],
  state: DuckDbSemanticState,
): string {
  const [xmin, ymin, xmax, ymax] = bounds.map((value) => duckDbParameter(state, value, "bbox", undefined, "number"));
  if (bboxColumn) {
    const bbox = duckDbIdentifier(bboxColumn, "options.geometry.bboxColumn");
    // Keep placeholder appearance in the same xmin/ymin/xmax/ymax order as
    // the parameter array; anonymous DuckDB placeholders cannot be reused.
    return `(${bbox}.xmax >= ${xmin} AND ${bbox}.ymax >= ${ymin} AND ${bbox}.xmin <= ${xmax} AND ${bbox}.ymin <= ${ymax})`;
  }
  return `ST_Intersects(${sourceExpression}, ST_MakeEnvelope(${xmin}, ${ymin}, ${xmax}, ${ymax}))`;
}

function duckDbExactEnvelopePredicate(
  sourceExpression: string,
  bboxColumn: string | undefined,
  bounds: readonly [number, number, number, number],
  state: DuckDbSemanticState,
): string {
  if (!bboxColumn) return duckDbEnvelopePredicate(sourceExpression, undefined, bounds, state);
  const prefilter = duckDbEnvelopePredicate(sourceExpression, bboxColumn, bounds, state);
  const exact = duckDbEnvelopePredicate(sourceExpression, undefined, bounds, state);
  return `(${prefilter} AND ${exact})`;
}

function executableGeometryBounds(
  value: { readonly geometry: unknown },
  path: string,
): readonly [number, number, number, number] {
  const bounds = {
    xmin: Number.POSITIVE_INFINITY,
    ymin: Number.POSITIVE_INFINITY,
    xmax: Number.NEGATIVE_INFINITY,
    ymax: Number.NEGATIVE_INFINITY,
    seen: false,
  };
  collectGeometryCoordinates(value.geometry, bounds);
  if (!bounds.seen) semanticUnsupported("unsupported-geometry", path, "Geometry has no xy coordinates");
  return [bounds.xmin, bounds.ymin, bounds.xmax, bounds.ymax];
}

function executableDuckDbCrs(value: unknown, path: string): ExecutableCrsBinding {
  try {
    return validateExecutableCrsBinding(value, path);
  } catch {
    semanticUnsupported("unsupported-crs", path, "DuckDB requires a resolved source CRS and payload order");
  }
}

function collectGeometryCoordinates(
  value: unknown,
  bounds: { xmin: number; ymin: number; xmax: number; ymax: number; seen: boolean },
): void {
  if (Array.isArray(value)) {
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      bounds.seen = true;
      bounds.xmin = Math.min(bounds.xmin, value[0]);
      bounds.ymin = Math.min(bounds.ymin, value[1]);
      bounds.xmax = Math.max(bounds.xmax, value[0]);
      bounds.ymax = Math.max(bounds.ymax, value[1]);
      return;
    }
    value.forEach((entry) => collectGeometryCoordinates(entry, bounds));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as { readonly coordinates?: unknown; readonly geometries?: unknown };
  if (record.coordinates !== undefined) collectGeometryCoordinates(record.coordinates, bounds);
  if (record.geometries !== undefined) collectGeometryCoordinates(record.geometries, bounds);
}

function assertDuckDbDistanceUnit(unit: string, crs: ExecutableCrsBinding, path: string): void {
  const axisUnits = crs.coordinateOrder.axes.slice(0, 2).map((axis) => normalizeDistanceUnit(axis.unit));
  const requested = normalizeDistanceUnit(unit);
  if (axisUnits.length < 2 || axisUnits.some((axisUnit) => axisUnit !== requested)) {
    semanticUnsupported(
      "unsupported-distance",
      path,
      "DuckDB planar distance unit must match both source coordinate axes",
    );
  }
}

function normalizeDistanceUnit(unit: string): string {
  const normalized = unit
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, "-");
  if (normalized === "meter" || normalized === "meters") return "metre";
  if (normalized === "kilometer" || normalized === "kilometers" || normalized === "kilometres") return "kilometre";
  if (normalized === "feet" || normalized === "ft") return "foot";
  if (normalized === "us-survey-feet" || normalized === "us-ft") return "us-survey-foot";
  if (normalized === "miles" || normalized === "mi") return "mile";
  if (normalized === "nautical-miles") return "nautical-mile";
  if (normalized === "degrees") return "degree";
  if (normalized === "radians") return "radian";
  return normalized;
}

function duckDbLiteralParameter(
  value: JsonValue,
  field: LogicalField,
  state: DuckDbSemanticState,
  path: string,
): string {
  if (value === null || Array.isArray(value) || typeof value === "object") {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      `DuckDB does not bind ${field.type.kind} filter values as scalar parameters`,
    );
  }
  const parameter = duckDbParameter(state, value, "literal", field);
  switch (field.type.kind) {
    case "integer":
      if (field.type.jsonEncoding !== "string") return parameter;
      return `CAST(${parameter} AS ${field.type.signed ? "BIGINT" : "UBIGINT"})`;
    case "decimal":
      if (field.type.jsonEncoding !== "string") return parameter;
      return `CAST(${parameter} AS ${duckDbDecimalType(field, path)})`;
    case "uuid":
      return `CAST(${parameter} AS UUID)`;
    case "date":
      return `CAST(${parameter} AS DATE)`;
    case "time":
      if (field.type.unit === "nanosecond") {
        semanticUnsupported("unsupported-field-type", path, "DuckDB TIME cannot preserve nanosecond precision");
      }
      return `CAST(${parameter} AS TIME)`;
    case "timestamp":
      return `CAST(${parameter} AS ${duckDbTimestampType(field, path)})`;
    case "duration":
      if (field.type.unit === "nanosecond") {
        semanticUnsupported("unsupported-field-type", path, "DuckDB INTERVAL cannot preserve nanosecond precision");
      }
      return `CAST(${parameter} AS INTERVAL)`;
    case "binary":
    case "json":
    case "geometry":
    case "list":
    case "struct":
    case "union":
    case "unknown":
      return semanticUnsupported(
        "unsupported-field-type",
        path,
        `DuckDB semantic filtering does not support logical type ${field.type.kind}`,
      );
    default:
      return parameter;
  }
}

function duckDbDecimalType(field: LogicalField, path: string): string {
  if (field.type.kind !== "decimal") {
    semanticUnsupported("unsupported-field-type", path, "DuckDB decimal compilation requires decimal schema metadata");
  }
  if (field.type.precision === undefined || field.type.scale === undefined || field.type.precision > 38) {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      "DuckDB string-encoded decimals require precision and scale with precision at most 38",
    );
  }
  return `DECIMAL(${field.type.precision}, ${field.type.scale})`;
}

function duckDbTimestampType(field: LogicalField, path: string): string {
  if (field.type.kind !== "timestamp") {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      "DuckDB timestamp compilation requires timestamp schema metadata",
    );
  }
  const zoned = field.type.timezone === "utc" || field.type.timezone === "offset";
  if (zoned) {
    if (field.type.unit === "nanosecond") {
      semanticUnsupported("unsupported-field-type", path, "DuckDB TIMESTAMPTZ cannot preserve nanosecond precision");
    }
    return "TIMESTAMPTZ";
  }
  return {
    second: "TIMESTAMP_S",
    millisecond: "TIMESTAMP_MS",
    microsecond: "TIMESTAMP",
    nanosecond: "TIMESTAMP_NS",
  }[field.type.unit];
}

function duckDbParameter(
  state: DuckDbSemanticState,
  value: JsonPrimitive,
  role: SemanticSqlParameter["role"],
  field?: LogicalField,
  logicalType?: string,
): string {
  state.parameters.push({
    position: state.parameters.length + 1,
    role,
    value,
    ...(field ? { field: field.name } : {}),
    ...(logicalType || field ? { logicalType: logicalType ?? field?.type.kind } : {}),
  });
  return "?";
}

function duckDbFieldExpression(field: LogicalField, path = "$.schema.fields"): string {
  return field.path.map((segment) => duckDbIdentifier(segment, path)).join(".");
}

function duckDbIdentifier(value: string, path: string): string {
  try {
    return quoteIdentifier(value);
  } catch {
    semanticUnsupported("unsupported-source", path, "DuckDB cannot represent the physical identifier");
  }
}

function aliasedDuckDbField(schema: SourceSchemaV2, name: string, path: string): string {
  const field = semanticSchemaField(schema, name, path);
  const expression = duckDbFieldExpression(field, path);
  return `${expression} AS ${duckDbIdentifier(field.name, path)}`;
}
