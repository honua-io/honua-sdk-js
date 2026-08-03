/**
 * FES 2.0 lowering for the canonical typed filter.
 *
 * Split out of `query-filter.ts` so only WFS consumers pay for the FES/GML
 * emitter: the GeoParquet, GeoServices, CQL2, and OData lowerings never reach
 * this module's import graph.
 *
 * @module
 */

import type { EsriSpatialRel } from "../core/types.js";
import { type FesLiteral, type FesNode, UNSUPPORTED_FES, compileSpatialFilter } from "../core/wfs-filter.js";
import {
  GEOSERVICES_SPATIAL_REL,
  type QueryFilterComparisonOperator,
  type QueryFilterContext,
  type QueryFilterExpression,
  type QueryFilterLiteralNode,
  type QueryFilterSpatialPredicate,
  type QueryFilterTemporalPredicate,
  assertQueryFilter,
  refuseQueryFilterConstruct,
} from "./query-filter.js";

const FES_COMPARISON: Record<QueryFilterComparisonOperator, "=" | "<>" | "<" | "<=" | ">" | ">="> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

const FES_TEMPORAL: Record<QueryFilterTemporalPredicate, "Before" | "After" | "During" | "AnyInteracts"> = {
  before: "Before",
  after: "After",
  during: "During",
  "time-intersects": "AnyInteracts",
};

/**
 * Compile to the FES 2.0 AST the WFS adapter serializes. Spatial predicates
 * name the feature type's geometry property, which the caller resolves (it is
 * server-specific) and passes through `ctx.geometryProperty`.
 */
export function compileQueryFilterToFes(filter: QueryFilterExpression, ctx: QueryFilterContext): FesNode {
  assertQueryFilter(filter, ctx);
  const emit = (node: QueryFilterExpression): FesNode => {
    switch (node.kind) {
      case "comparison": {
        if (node.right.value === null) {
          const isNull: FesNode = { kind: "isNull", property: node.left.name };
          if (node.operator === "eq") return isNull;
          if (node.operator === "ne") return { kind: "not", operand: isNull };
          return refuseQueryFilterConstruct(`filter.comparison.${node.operator}.null`, ctx);
        }
        return {
          kind: "compare",
          op: FES_COMPARISON[node.operator],
          property: node.left.name,
          value: fesLiteral(node.right, ctx),
        };
      }
      case "list":
        return {
          kind: "in",
          property: node.operand.name,
          values: node.values.map((value) => fesLiteral(value, ctx)),
        };
      case "range":
        return {
          kind: "between",
          property: node.operand.name,
          lower: fesLiteral(node.lower, ctx),
          upper: fesLiteral(node.upper, ctx),
        };
      case "null": {
        const isNull: FesNode = { kind: "isNull", property: node.operand.name };
        return node.operator === "is-null" ? isNull : { kind: "not", operand: isNull };
      }
      case "pattern":
        if (node.caseSensitive === false) refuseQueryFilterConstruct("filter.pattern.case-insensitive", ctx);
        return { kind: "like", property: node.operand.name, pattern: node.pattern };
      case "spatial": {
        const property = node.property ?? ctx.geometryProperty;
        if (property === undefined) refuseQueryFilterConstruct("filter.spatial.geometry-property", ctx);
        const compiled = compileSpatialFilter(
          {
            geometry: node.geometry.geometry,
            geometryType: node.geometry.geometryType,
            spatialRel: fesSpatialRel(node.operator, ctx),
          },
          { geometryProperty: property },
        );
        if (compiled === UNSUPPORTED_FES) refuseQueryFilterConstruct(`filter.spatial.${node.operator}`, ctx);
        return compiled;
      }
      case "temporal": {
        const value = node.value;
        const time =
          value.valueType === "instant" ? { instant: value.value } : { start: value.value[0], end: value.value[1] };
        return {
          kind: "temporal",
          op: FES_TEMPORAL[node.operator],
          property: node.operand.name,
          time,
        };
      }
      case "boolean":
        return node.operator === "and"
          ? { kind: "and", operands: node.args.map(emit) }
          : { kind: "or", operands: node.args.map(emit) };
      case "not":
        return { kind: "not", operand: emit(node.arg) };
      default:
        return refuseQueryFilterConstruct("filter.node", ctx);
    }
  };
  return emit(filter);
}

function fesSpatialRel(operator: QueryFilterSpatialPredicate, ctx: QueryFilterContext): EsriSpatialRel {
  const rel = GEOSERVICES_SPATIAL_REL[operator];
  if (!rel) refuseQueryFilterConstruct(`filter.spatial.${operator}`, ctx);
  return rel;
}

function fesLiteral(node: QueryFilterLiteralNode, ctx: QueryFilterContext): FesLiteral {
  const value = node.value;
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "boolean") return { kind: "string", value: value ? "true" : "false" };
  return refuseQueryFilterConstruct("filter.literal.null", ctx);
}
