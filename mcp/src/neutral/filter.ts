import type {
  QueryFilterExpression,
  QueryFilterGeometryOperand,
  QueryFilterSpatialPredicate,
  QueryTemporalFilter,
} from "@honua/sdk-js/contract";
import { geoJsonToEsri } from "@honua/sdk-js/geometry";
import { z } from "zod";
import { GEOMETRY_TYPES, resolveGeometryType } from "../helpers.js";

/**
 * PROTOCOL-NEUTRAL filter + geometry vocabulary for the MCP tool contract (#1005).
 *
 * The SDK's `Query.filter` is a typed semantic filter that compiles to
 * GeoServices SQL-92, CQL2 (OGC API Features / STAC), FES 2.0 (WFS), OData
 * `$filter`, and DuckDB SQL — and refuses, naming the construct and the
 * protocol, when a target cannot express a construct exactly. Exposing it on
 * the tool surface is what lets an agent write ONE filter and have it mean the
 * same thing on every backend, instead of hand-writing Esri SQL.
 *
 * The wire shape here is a flattened projection of that AST: one `op`
 * discriminator per node instead of the SDK's `kind` + `operator` pair, because
 * a flat discriminated union is markedly easier for a model to emit correctly.
 * {@link toQueryFilter} lowers it onto the canonical expression losslessly.
 *
 * Geometry is canonical **GeoJSON** (RFC 7946). Esri-JSON geometry is still
 * accepted for compatibility with existing clients and is converted on the way
 * in; nothing on the surface requires it.
 */

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Protocol-neutral spatial predicates (`QueryFilterSpatialPredicate`). */
export const SPATIAL_PREDICATES = [
  "intersects",
  "contains",
  "within",
  "crosses",
  "touches",
  "overlaps",
  "bbox-intersects",
] as const;

const TEMPORAL_PREDICATES = ["before", "after", "during", "time-intersects"] as const;

/** GeoJSON geometry accepted anywhere a spatial constraint is expressed. */
export const geoJsonGeometrySchema = z
  .object({
    type: z.enum(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]),
    coordinates: z.array(z.unknown()),
  })
  .passthrough();

/**
 * A geometry operand: GeoJSON (canonical) or Esri-JSON (accepted for
 * compatibility). Kept as a loose record so an Esri envelope / rings payload
 * from an existing client still validates.
 */
export const geometrySchema = z.record(z.unknown());

export const bboxSchema = z
  .array(z.number())
  .length(4)
  .describe(
    "Bounding box [minX, minY, maxX, maxY]. Interpreted in the source CRS (WGS84 unless bboxSrid says otherwise).",
  );

export type FilterNode =
  | { op: "and" | "or"; args: FilterNode[] }
  | { op: "not"; arg: FilterNode }
  | { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; field: string; value: string | number | boolean | null }
  | { op: "in"; field: string; values: (string | number | boolean | null)[] }
  | {
      op: "between";
      field: string;
      lower: string | number | boolean | null;
      upper: string | number | boolean | null;
    }
  | { op: "is-null" | "is-not-null"; field: string }
  | { op: "like"; field: string; pattern: string; caseSensitive?: boolean }
  | {
      op: (typeof SPATIAL_PREDICATES)[number];
      geometry?: Record<string, unknown>;
      bbox?: number[];
      field?: string;
      geometryType?: (typeof GEOMETRY_TYPES)[number];
    }
  | { op: (typeof TEMPORAL_PREDICATES)[number]; field: string; value: string | string[] };

/**
 * Recursive zod schema for {@link FilterNode}. `z.lazy` keeps `and`/`or`/`not`
 * genuinely recursive; zod-to-json-schema emits it as a `$ref`, which stays
 * well-formed JSON Schema for MCP clients and for the certification harness.
 */
export const filterSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(["and", "or"]),
      args: z.array(filterSchema).min(1),
    }),
    z.object({ op: z.literal("not"), arg: filterSchema }),
    z.object({
      op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
      field: z.string().min(1),
      value: scalarSchema,
    }),
    z.object({ op: z.literal("in"), field: z.string().min(1), values: z.array(scalarSchema).min(1) }),
    z.object({
      op: z.literal("between"),
      field: z.string().min(1),
      lower: scalarSchema,
      upper: scalarSchema,
    }),
    z.object({ op: z.enum(["is-null", "is-not-null"]), field: z.string().min(1) }),
    z.object({
      op: z.literal("like"),
      field: z.string().min(1),
      pattern: z.string(),
      caseSensitive: z.boolean().optional(),
    }),
    z.object({
      op: z.enum(SPATIAL_PREDICATES),
      geometry: geometrySchema.optional(),
      bbox: z.array(z.number()).length(4).optional(),
      field: z.string().optional(),
      geometryType: z.enum(GEOMETRY_TYPES).optional(),
    }),
    z.object({
      op: z.enum(TEMPORAL_PREDICATES),
      field: z.string().min(1),
      // An interval is a 2-element array rather than a JSON Schema tuple: the
      // draft-07 tuple form (`items: [...]`) is invalid under 2020-12, and the
      // certification harness validates advertised schemas under both dialects.
      value: z.union([z.string(), z.array(z.string()).length(2)]),
    }),
  ]),
) as z.ZodType<FilterNode>;

export class FilterInputError extends Error {
  readonly code = "INVALID_FILTER";

  constructor(message: string) {
    super(message);
    this.name = "FilterInputError";
  }
}

function isGeoJsonGeometry(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" && Array.isArray((value as { coordinates?: unknown }).coordinates);
}

/** Build an Esri envelope from a `[minX, minY, maxX, maxY]` bbox. */
export function bboxToOperand(bbox: readonly number[], srid?: number): QueryFilterGeometryOperand {
  const [xmin, ymin, xmax, ymax] = bbox;
  const geometry: Record<string, unknown> = { xmin, ymin, xmax, ymax };
  if (srid !== undefined) {
    geometry.spatialReference = { wkid: srid };
  }
  return { geometry, geometryType: "esriGeometryEnvelope" };
}

/**
 * Normalize a geometry input onto the canonical geometry operand.
 *
 * GeoJSON is the documented input; Esri-JSON is accepted so existing clients
 * keep working. The canonical operand is Esri-shaped inside the SDK — that is
 * an SDK implementation detail, not part of this tool contract.
 */
export function toGeometryOperand(
  geometry: Record<string, unknown>,
  esriGeometryType?: (typeof GEOMETRY_TYPES)[number],
  srid?: number,
): QueryFilterGeometryOperand {
  if (isGeoJsonGeometry(geometry)) {
    const converted = geoJsonToEsri(
      geometry as unknown as Parameters<typeof geoJsonToEsri>[0],
      srid !== undefined ? { wkid: srid } : undefined,
    );
    if (!converted) {
      throw new FilterInputError(
        `GeoJSON geometry of type "${String(geometry.type)}" could not be converted to a query geometry.`,
      );
    }
    const asRecord = converted as unknown as Record<string, unknown>;
    const geometryType = resolveGeometryType(asRecord, undefined);
    if (!geometryType) {
      throw new FilterInputError("Converted geometry has no recognizable geometry type.");
    }
    return { geometry: asRecord, geometryType };
  }

  const geometryType = resolveGeometryType(geometry, esriGeometryType);
  if (!geometryType) {
    throw new FilterInputError(
      'geometry is neither GeoJSON (an object with "type" and "coordinates") nor a recognizable Esri-JSON geometry. Pass GeoJSON, a bbox, or an explicit geometryType.',
    );
  }
  return { geometry, geometryType };
}

function spatialOperand(
  node: Extract<FilterNode, { op: (typeof SPATIAL_PREDICATES)[number] }>,
): QueryFilterGeometryOperand {
  if (node.geometry && node.bbox) {
    throw new FilterInputError(`filter node "${node.op}" carries both geometry and bbox; pass exactly one.`);
  }
  if (node.bbox) {
    return bboxToOperand(node.bbox);
  }
  if (node.geometry) {
    return toGeometryOperand(node.geometry, node.geometryType);
  }
  throw new FilterInputError(`filter node "${node.op}" requires either geometry (GeoJSON) or bbox.`);
}

function isSpatialOp(op: string): op is (typeof SPATIAL_PREDICATES)[number] {
  return (SPATIAL_PREDICATES as readonly string[]).includes(op);
}

function isTemporalOp(op: string): op is (typeof TEMPORAL_PREDICATES)[number] {
  return (TEMPORAL_PREDICATES as readonly string[]).includes(op);
}

/** Lower the wire filter DSL onto the SDK's canonical typed filter expression. */
export function toQueryFilter(node: FilterNode): QueryFilterExpression {
  switch (node.op) {
    case "and":
    case "or":
      return { kind: "boolean", operator: node.op, args: node.args.map(toQueryFilter) };
    case "not":
      return { kind: "not", arg: toQueryFilter(node.arg) };
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return {
        kind: "comparison",
        operator: node.op,
        left: { kind: "property", name: node.field },
        right: { kind: "literal", value: node.value },
      };
    case "in":
      return {
        kind: "list",
        operator: "in",
        operand: { kind: "property", name: node.field },
        values: node.values.map((value) => ({ kind: "literal", value }) as const),
      };
    case "between":
      return {
        kind: "range",
        operator: "between",
        operand: { kind: "property", name: node.field },
        lower: { kind: "literal", value: node.lower },
        upper: { kind: "literal", value: node.upper },
      };
    case "is-null":
    case "is-not-null":
      return { kind: "null", operator: node.op, operand: { kind: "property", name: node.field } };
    case "like":
      return {
        kind: "pattern",
        operator: "like",
        operand: { kind: "property", name: node.field },
        pattern: node.pattern,
        ...(node.caseSensitive === undefined ? {} : { caseSensitive: node.caseSensitive }),
      };
    default:
      break;
  }

  if (isSpatialOp(node.op)) {
    const spatial = node as Extract<FilterNode, { op: (typeof SPATIAL_PREDICATES)[number] }>;
    return {
      kind: "spatial",
      operator: spatial.op as QueryFilterSpatialPredicate,
      geometry: spatialOperand(spatial),
      ...(spatial.field ? { property: spatial.field } : {}),
    };
  }

  if (isTemporalOp(node.op)) {
    const temporal = node as Extract<FilterNode, { op: (typeof TEMPORAL_PREDICATES)[number] }>;
    const value = temporal.value;
    return {
      kind: "temporal",
      operator: temporal.op,
      operand: { kind: "property", name: temporal.field },
      value:
        typeof value === "string"
          ? { kind: "temporal-literal", valueType: "instant", value }
          : { kind: "temporal-literal", valueType: "interval", value: [value[0], value[1]] },
    };
  }

  throw new FilterInputError(`unknown filter operator "${String((node as { op: unknown }).op)}".`);
}

/** Conjoin filter expressions; `undefined` when nothing was supplied. */
export function andFilters(parts: readonly QueryFilterExpression[]): QueryFilterExpression | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { kind: "boolean", operator: "and", args: [...parts] };
}

/** Canonical time constraint accepted on the tool surface. */
export const temporalSchema = z
  .object({
    instant: z.string().optional().describe("RFC 3339 instant, e.g. 2026-05-01T00:00:00Z."),
    start: z.string().nullable().optional().describe("Interval start (null = open ended)."),
    end: z.string().nullable().optional().describe("Interval end (null = open ended)."),
    field: z
      .string()
      .optional()
      .describe(
        "Time column to constrain. Omit to target the source's own time dimension (GeoServices time=, OGC/STAC datetime=); OData, WFS, and GeoParquet require an explicit field.",
      ),
  })
  .describe("Protocol-neutral time constraint: either `instant`, or `start`/`end` for an interval.");

export type TemporalInput = z.infer<typeof temporalSchema>;

/** Lower the wire temporal input onto `Query.temporalFilter`. */
export function toTemporalFilter(input: TemporalInput): QueryTemporalFilter {
  const field = input.field ? { field: input.field } : {};
  if (input.instant !== undefined) {
    if (input.start !== undefined || input.end !== undefined) {
      throw new FilterInputError("temporal accepts either `instant` or `start`/`end`, not both.");
    }
    return { kind: "instant", instant: input.instant, ...field };
  }
  if (input.start === undefined && input.end === undefined) {
    throw new FilterInputError("temporal requires `instant`, or at least one of `start` / `end`.");
  }
  return {
    kind: "interval",
    start: input.start ?? null,
    end: input.end ?? null,
    ...field,
  };
}
