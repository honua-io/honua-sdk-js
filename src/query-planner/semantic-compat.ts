import type { LegacyWhereDialectFor, LegacyWhereProtocol, NativeFilter } from "./semantic-types.js";
import { parseSemanticQuery } from "./semantic.js";
import { HonuaQueryPlanningError } from "./types.js";

const LEGACY_WHERE_DIALECT = {
  "geoservices-feature-service": "geoservices-sql92",
  "geoservices-map-service": "geoservices-sql92",
  "geoservices-image-service": "geoservices-sql92",
  "ogc-features": "cql2-text",
  "ogc-records": "cql2-text",
  stac: "cql2-text",
  odata: "odata-4.0",
  geoparquet: "duckdb-sql",
} as const satisfies Record<LegacyWhereProtocol, string>;

/**
 * Convert deprecated v1 `Query.where` text into an explicitly tagged native
 * filter. This is a migration bridge, not a protocol-neutral parser.
 *
 * @deprecated Build a typed semantic filter instead. Keep this only while a
 * v1 caller still owns protocol-native `where` text.
 */
export function legacyWhereToNativeFilter<TProtocol extends LegacyWhereProtocol>(
  protocol: TProtocol,
  where: string,
): NativeFilter<LegacyWhereDialectFor<TProtocol>> {
  const dialect =
    typeof protocol === "string" && Object.prototype.hasOwnProperty.call(LEGACY_WHERE_DIALECT, protocol)
      ? (LEGACY_WHERE_DIALECT as Record<string, string>)[protocol]
      : undefined;
  if (!dialect) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "The supplied protocol has no lossless raw-where compatibility dialect",
    );
  }
  if (typeof where !== "string" || where.trim().length === 0) {
    throw new HonuaQueryPlanningError("invalid-query", "Legacy raw where must be a non-empty string");
  }
  const query = parseSemanticQuery(
    {
      kind: "features",
      filter: { kind: "native", dialect, payload: { format: "text", text: where } },
    },
    { protocol },
  );
  return query.filter as NativeFilter<LegacyWhereDialectFor<TProtocol>>;
}
