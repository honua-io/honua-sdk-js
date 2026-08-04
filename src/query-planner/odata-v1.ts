/**
 * Lightweight deterministic OData v4 compiler.
 *
 * Kept separate from the semantic OData compiler so importing the public
 * `odataProtocolModule()` does not pull the larger semantic compiler graph
 * into contract-only bundles.
 */
import type { ProtocolModuleQueryCompileInput, ProtocolModuleQueryOperation } from "../contract/protocol-module.js";
import { type QueryFilterContext, compileQueryFilterToOData } from "../contract/query-filter.js";
import { buildOdataSpatialFilter, rewriteWhereToOdataFilter } from "../core/odata.js";
import { canonicalFilterParts, refuseCanonicalFilter } from "./canonical-filter.js";
import type {
  CanonicalQuery,
  OdataCompiledQueryV1,
  OdataProtocolCompiledQueryV1,
  QueryIrSourceIdentity,
} from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

/** Compile canonical query IR to a deterministic OData v4 entity-set request. */
export function compileOdataQuery(source: QueryIrSourceIdentity, query: CanonicalQuery): OdataCompiledQueryV1 {
  if (source.protocol !== "odata") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `odata-v4-query-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  if (!source.entitySet) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.entitySet for OData planning`,
    );
  }
  if (query.aggregation) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "Canonical OData aggregation is not portable; use the typed $apply escape hatch",
    );
  }
  if (query.outSr !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "OData v4 has no portable output-CRS query option; omit outSr or use the typed OData escape hatch",
    );
  }

  const ctx: QueryFilterContext = {
    protocol: source.protocol,
    sourceId: source.id,
    ...(source.geometryProperty !== undefined ? { geometryProperty: source.geometryProperty } : {}),
  };
  const parts = canonicalFilterParts(query, ctx);
  if (parts.protocolTime) {
    refuseCanonicalFilter(
      "Query.temporalFilter without a field",
      "OData v4",
      "the protocol has no time parameter; name the temporal field so the predicate stays exact",
    );
  }
  const filterParts: string[] = [];
  try {
    if (query.where) {
      assertSupportedWhere(query.where.expression);
      const rewritten = rewriteWhereToOdataFilter(query.where.expression);
      if (rewritten) filterParts.push(rewritten);
    }
    if (parts.expression) {
      filterParts.push(
        compileQueryFilterToOData(parts.expression, ctx, (node) => {
          if (!source.geometryProperty) {
            throw new Error("descriptor schema does not identify the OData geometry column");
          }
          if (node.operator !== "intersects" && node.operator !== "bbox-intersects") {
            throw new Error(`OData v4 has no standard ${node.operator} geo function`);
          }
          return buildOdataSpatialFilter(
            {
              geometry: node.geometry.geometry,
              geometryType: node.geometry.geometryType,
              spatialRel: "esriSpatialRelIntersects",
            },
            { geometryColumn: source.geometryProperty },
          );
        }),
      );
    }
    if (query.spatialFilter) {
      if (!source.geometryProperty) {
        throw new Error("descriptor schema does not identify the OData geometry column");
      }
      filterParts.push(
        buildOdataSpatialFilter(
          {
            geometry: query.spatialFilter.geometry as Record<string, unknown>,
            geometryType: query.spatialFilter.geometryType,
            ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
          },
          { geometryColumn: source.geometryProperty },
        ),
      );
    }
  } catch (error) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `OData query cannot preserve the requested predicate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let projection: { select: readonly string[]; expand: readonly string[] } | undefined;
  if (query.outFields && query.outFields.length > 0) {
    projection = splitProjection(query.outFields, query.returnGeometry === false ? source.geometryProperty : undefined);
    if (
      query.returnGeometry !== false &&
      source.geometryProperty &&
      !projection.select.includes(source.geometryProperty)
    ) {
      projection = { ...projection, select: [...projection.select, source.geometryProperty] };
    }
  } else if (query.returnGeometry === false) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "Metadata-free OData planning requires explicit outFields to prove returnGeometry=false on the wire",
    );
  }

  return {
    compiler: "odata-v4-query-v1",
    entitySet: source.entitySet,
    ...(filterParts.length > 0 ? { filter: filterParts.join(" and ") } : {}),
    ...(projection && projection.select.length > 0 ? { select: projection.select } : {}),
    ...(projection && projection.expand.length > 0 ? { expand: projection.expand } : {}),
    ...(query.orderBy && query.orderBy.length > 0
      ? { orderBy: query.orderBy.map((sort) => `${sort.field}${sort.direction === "desc" ? " desc" : ""}`) }
      : {}),
    ...(query.pagination?.offset !== undefined ? { skip: query.pagination.offset } : {}),
    ...(query.pagination?.limit !== undefined ? { top: query.pagination.limit } : {}),
  };
}

/**
 * The deterministic compiler hook installed on the first-party OData
 * ProtocolModule. Planner dispatch and module consumers call this exact
 * object, while runtime authority remains outside the compiler.
 */
export const odataProtocolQueryCompiler = Object.freeze({
  kind: "odata" as const,
  compile(input: ProtocolModuleQueryCompileInput<QueryIrSourceIdentity, CanonicalQuery>): OdataProtocolCompiledQueryV1 {
    return bindOdataProtocolQueryOperation(compileOdataQuery(input.source, input.query), input.operation);
  },
});

/** Bind a legacy wire request to the exact operation authorized to execute it. */
export function bindOdataProtocolQueryOperation(
  compiled: OdataCompiledQueryV1,
  operation: ProtocolModuleQueryOperation,
): OdataProtocolCompiledQueryV1 {
  let top = compiled.top;
  if (operation === "queryAll" && top !== undefined) {
    if (!Number.isSafeInteger(top) || top < 0 || top >= Number.MAX_SAFE_INTEGER) {
      throw new HonuaQueryPlanningError(
        "invalid-query",
        "OData queryAll pagination.limit must leave room for one lookahead row",
      );
    }
    top += 1;
  }
  return Object.freeze({
    compiler: "odata-v4-protocol-query-v1",
    operation,
    entitySet: compiled.entitySet,
    ...(compiled.filter !== undefined ? { filter: compiled.filter } : {}),
    ...(compiled.select !== undefined ? { select: compiled.select } : {}),
    ...(compiled.expand !== undefined ? { expand: compiled.expand } : {}),
    ...(compiled.orderBy !== undefined ? { orderBy: compiled.orderBy } : {}),
    ...(compiled.skip !== undefined ? { skip: compiled.skip } : {}),
    ...(top !== undefined ? { top } : {}),
  });
}

function assertSupportedWhere(where: string): void {
  const code = outsideQuotedStrings(where);
  if (code === undefined) throw new Error("unterminated OData string literal");
  const unsupported = [
    { expression: /\bLIKE\b/i, name: "LIKE" },
    { expression: /\bBETWEEN\b/i, name: "BETWEEN" },
    { expression: /==/, name: "==" },
    { expression: /!=/, name: "!=" },
    { expression: /;/, name: ";" },
  ];
  for (const candidate of unsupported) {
    if (candidate.expression.test(code)) {
      throw new Error(`operator ${candidate.name} is not translated by the OData compiler`);
    }
  }
}

/** Return only non-literal spans, or undefined for an unterminated literal. */
function outsideQuotedStrings(input: string): string | undefined {
  let output = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== "'") {
      if (!quoted) output += character;
      continue;
    }
    if (quoted && input[index + 1] === "'") {
      index += 1;
      continue;
    }
    quoted = !quoted;
  }
  return quoted ? undefined : output;
}

function splitProjection(
  fields: readonly string[],
  excludedGeometry: string | undefined,
): { select: readonly string[]; expand: readonly string[] } {
  type Node = { select: string[]; children: Map<string, Node> };
  const root: Node = { select: [], children: new Map() };
  for (const field of fields) {
    if (excludedGeometry && field === excludedGeometry) continue;
    const segments = field.split(".").filter(Boolean);
    if (segments.length === 0) continue;
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (!segment) continue;
      let child = cursor.children.get(segment);
      if (!child) {
        child = { select: [], children: new Map() };
        cursor.children.set(segment, child);
      }
      cursor = child;
    }
    const leaf = segments.at(-1);
    if (leaf) cursor.select.push(leaf);
  }
  const serialize = (node: Node): string => {
    const parts: string[] = [];
    if (node.select.length > 0) parts.push(`$select=${node.select.join(",")}`);
    if (node.children.size > 0) {
      const children = [...node.children.entries()].map(([name, child]) => {
        const inner = serialize(child);
        return inner ? `${name}(${inner})` : name;
      });
      parts.push(`$expand=${children.join(",")}`);
    }
    return parts.join(";");
  };
  return {
    select: root.select,
    expand: [...root.children.entries()].map(([name, child]) => {
      const inner = serialize(child);
      return inner ? `${name}(${inner})` : name;
    }),
  };
}
