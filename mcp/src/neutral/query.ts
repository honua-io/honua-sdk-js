import type { Query, QueryFilterExpression, SortSpec } from "@honua/sdk-js/contract";
import { z } from "zod";
import { GEOMETRY_TYPES, clampLimit } from "../helpers.js";
import {
  FilterInputError,
  SPATIAL_PREDICATES,
  andFilters,
  bboxToOperand,
  filterSchema,
  geometrySchema,
  temporalSchema,
  toGeometryOperand,
  toQueryFilter,
  toTemporalFilter,
} from "./filter.js";
import { isGeoServicesProtocol } from "./source-ref.js";

/**
 * PROTOCOL-NEUTRAL query vocabulary for the MCP tool contract (#1005).
 *
 * Everything here lowers onto the SDK's stable `Query` envelope, which each
 * protocol adapter translates into its own dialect. Nothing in the vocabulary
 * is Esri-shaped: the filter is the typed semantic filter, geometry is GeoJSON
 * (or a bbox), the spatial predicate is the neutral one, sorting is
 * `field`/`direction`, and paging is `limit`/`offset`.
 *
 * Two deprecated compatibility inputs remain so existing clients keep working:
 * `where` (source-native filter text, whose language depends on the backend)
 * and `geometryType` (an Esri geometry-type tag for Esri-JSON geometry). Both
 * are optional; neither is required by any tool.
 */

/** Filter + spatial + temporal fields shared by every query-family tool. */
export const queryFilterFields = {
  filter: filterSchema
    .optional()
    .describe(
      'Typed, protocol-neutral filter. Nodes are {"op": …}: comparison (eq/ne/lt/lte/gt/gte with field+value), in (field+values), between (field+lower+upper), is-null/is-not-null (field), like (field+pattern[+caseSensitive]), and/or (args), not (arg), spatial (intersects/contains/within/crosses/touches/overlaps/bbox-intersects with geometry or bbox), temporal (before/after/during/time-intersects with field+value). Compiles to SQL-92, CQL2, FES 2.0, or OData depending on the backend, and fails with a named capability error rather than silently dropping a construct.',
    ),
  where: z
    .string()
    .optional()
    .describe(
      "[DEPRECATED — use `filter`] Source-native filter text. Its language depends on the backend (GeoServices SQL-92, CQL2, OData); it is not protocol neutral.",
    ),
  bbox: z.array(z.number()).length(4).optional().describe("Spatial filter envelope [minX, minY, maxX, maxY]."),
  bboxSrid: z.number().int().optional().describe("Spatial reference (SRID/WKID) of the bbox ordinates (default 4326)."),
  geometry: geometrySchema
    .optional()
    .describe(
      "Spatial filter geometry as GeoJSON (RFC 7946). Esri-JSON geometry is still accepted for compatibility and is converted on the way in.",
    ),
  geometryType: z
    .enum(GEOMETRY_TYPES)
    .optional()
    .describe("[DEPRECATED — send GeoJSON] Esri geometry type tag, used only to disambiguate Esri-JSON geometry."),
  spatialRel: z
    .enum(SPATIAL_PREDICATES)
    .optional()
    .describe("Protocol-neutral spatial predicate applied to `geometry`/`bbox` (default: intersects)."),
  temporal: temporalSchema.optional(),
} as const;

const sortSpecSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]).optional(),
});

/** Projection / ordering / paging fields for the feature-returning tools. */
export const queryShapeFields = {
  outFields: z.array(z.string()).optional().describe("Fields to return; defaults to all."),
  orderBy: z
    .union([z.array(sortSpecSchema), z.string()])
    .optional()
    .describe('Sort order as [{"field":"NAME","direction":"desc"}], or the legacy string form "NAME DESC,VALUE ASC".'),
  limit: z.number().int().positive().optional().describe("Max features to return (default 100, max 2000)."),
  offset: z.number().int().nonnegative().optional().describe("Number of features to skip (for pagination)."),
  returnGeometry: z.boolean().optional().default(false).describe("Include geometry in results (default: false)."),
  geometryFormat: z
    .enum(["geojson", "esri-json"])
    .optional()
    .describe(
      "Geometry encoding of returned features. Defaults to `geojson` for neutrally addressed sources, and to `esri-json` when the deprecated serviceId/layerId pair was used (preserving legacy client output).",
    ),
  outSr: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Output spatial reference (WKID or CRS identifier) for returned geometry."),
} as const;

export interface NeutralQueryInput {
  filter?: unknown;
  where?: string | undefined;
  bbox?: number[] | undefined;
  bboxSrid?: number | undefined;
  geometry?: Record<string, unknown> | undefined;
  geometryType?: (typeof GEOMETRY_TYPES)[number] | undefined;
  spatialRel?: (typeof SPATIAL_PREDICATES)[number] | undefined;
  temporal?: z.infer<typeof temporalSchema> | undefined;
  outFields?: string[] | undefined;
  orderBy?: string | { field: string; direction?: "asc" | "desc" }[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  returnGeometry?: boolean | undefined;
  outSr?: string | number | undefined;
}

/** Parse the legacy `"NAME DESC,VALUE ASC"` order string into canonical sort specs. */
export function parseOrderBy(orderBy: NeutralQueryInput["orderBy"]): SortSpec[] | undefined {
  if (orderBy === undefined) return undefined;
  if (Array.isArray(orderBy)) {
    return orderBy.length > 0
      ? orderBy.map((spec) => ({ field: spec.field, direction: spec.direction ?? "asc" }))
      : undefined;
  }
  const specs = orderBy
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [field, direction] = part.split(/\s+/);
      return {
        field,
        direction: (direction ?? "asc").toLowerCase() === "desc" ? ("desc" as const) : ("asc" as const),
      };
    });
  return specs.length > 0 ? specs : undefined;
}

/**
 * Lower the spatial constraint onto whichever canonical channel the widest set
 * of protocols can serve.
 *
 * An envelope tested with `intersects` is the one spatial constraint every
 * protocol expresses natively — it is the OGC API Features / STAC `bbox`
 * parameter (Part 1, no filtering extension required) and a plain GeoServices
 * geometry parameter — so it travels as `Query.spatialFilter`. Anything richer
 * (a real polygon, `within`, `crosses`, …) becomes a typed spatial filter node,
 * which compiles to CQL2 / FES / SQL-92 where supported and fails closed,
 * naming the construct, where it is not.
 */
function spatialConstraint(input: NeutralQueryInput): {
  filterNode?: QueryFilterExpression;
  spatialFilter?: { geometry: Record<string, unknown>; geometryType: string; spatialRel: string };
} {
  if (input.geometry && input.bbox) {
    throw new FilterInputError("Pass either `geometry` or `bbox` for the spatial filter, not both.");
  }
  const operand = input.bbox
    ? bboxToOperand(input.bbox, input.bboxSrid)
    : input.geometry
      ? toGeometryOperand(input.geometry, input.geometryType, input.bboxSrid)
      : undefined;
  if (!operand) return {};

  const predicate = input.spatialRel ?? "intersects";
  const isPortableEnvelope =
    operand.geometryType === "esriGeometryEnvelope" && (predicate === "intersects" || predicate === "bbox-intersects");
  if (isPortableEnvelope) {
    return {
      spatialFilter: {
        geometry: operand.geometry,
        geometryType: operand.geometryType,
        spatialRel: predicate === "intersects" ? "esriSpatialRelIntersects" : "esriSpatialRelEnvelopeIntersects",
      },
    };
  }
  return { filterNode: { kind: "spatial", operator: predicate, geometry: operand } };
}

export interface ToQueryOptions {
  /** Protocol of the resolved source; drives protocol-quirk compensation only. */
  readonly protocol: string;
  /** Apply the default page size / cap. Off for aggregate + extent queries. */
  readonly paginate?: boolean;
}

/**
 * Lower the neutral tool input onto the SDK's canonical `Query`.
 *
 * The one protocol-specific compensation is `outFields`: a GeoServices
 * `query` with no `outFields` returns OBJECTID only, whereas every other
 * protocol returns all properties. Requesting `*` for the GeoServices family
 * keeps "omit outFields ⇒ all fields" true across protocols rather than
 * leaking an Esri default into the neutral contract.
 */
export function toQuery(input: NeutralQueryInput, options: ToQueryOptions): Query {
  const conjuncts: QueryFilterExpression[] = [];
  if (input.filter !== undefined && input.filter !== null) {
    conjuncts.push(toQueryFilter(filterSchema.parse(input.filter)));
  }
  const spatial = spatialConstraint(input);
  if (spatial.filterNode) conjuncts.push(spatial.filterNode);

  const query: Query = {};
  const filter = andFilters(conjuncts);
  if (filter) query.filter = filter;
  if (spatial.spatialFilter) query.spatialFilter = spatial.spatialFilter as Query["spatialFilter"];
  if (input.where !== undefined && input.where.trim().length > 0) query.where = input.where;
  if (input.temporal) query.temporalFilter = toTemporalFilter(input.temporal);

  const outFields =
    input.outFields && input.outFields.length > 0
      ? input.outFields
      : isGeoServicesProtocol(options.protocol)
        ? ["*"]
        : undefined;
  if (outFields) query.outFields = outFields;

  const orderBy = parseOrderBy(input.orderBy);
  if (orderBy) query.orderBy = orderBy;

  if (options.paginate !== false) {
    const pagination: { limit: number; offset?: number } = { limit: clampLimit(input.limit) };
    if (input.offset !== undefined) pagination.offset = input.offset;
    query.pagination = pagination;
  } else if (input.offset !== undefined || input.limit !== undefined) {
    const pagination: { limit?: number; offset?: number } = {};
    if (input.limit !== undefined) pagination.limit = clampLimit(input.limit);
    if (input.offset !== undefined) pagination.offset = input.offset;
    query.pagination = pagination;
  }

  if (input.returnGeometry !== undefined) query.returnGeometry = input.returnGeometry;
  if (input.outSr !== undefined) query.outSr = input.outSr;
  return query;
}
