/**
 * Lightweight deterministic WFS 2.0 compiler.
 *
 * Kept separate from the semantic WFS compiler so importing the public
 * `wfsProtocolModule()` does not pull the larger semantic compiler graph into
 * contract-only bundles.
 */
import type { ProtocolModuleQueryCompileInput, ProtocolModuleQueryOperation } from "../contract/protocol-module.js";
import { compileQueryFilterToFes } from "../contract/query-filter-fes.js";
import {
  type QueryFilterContext,
  type QueryFilterExpression,
  andQueryFilters,
  temporalFilterToExpression,
} from "../contract/query-filter.js";
import type { SpatialFilter } from "../core/spatial-filter.js";
import {
  type FesNode,
  UNSUPPORTED_FES,
  compileSpatialFilter,
  compileWhere,
  formatWfsBboxKvp,
  serializeFes,
} from "../core/wfs-filter.js";
import { queryIrAuthorityFingerprint } from "./ir.js";
import type { CanonicalQuery, QueryIrSourceIdentity, WfsCompiledQueryV1, WfsProtocolCompiledQueryV1 } from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

const WFS_GET_FILTER_BUDGET = 7000;
/**
 * Metadata-free planning fallback only. The live WFS adapter resolves the real
 * geometry property per feature type (DescribeFeatureType, or an explicit
 * `locator.geometryName`) and carries it on the IR source identity, so this
 * legacy PostGIS-via-GeoServer default is used only when a caller compiles a
 * plan without any geometry evidence at all.
 */
const DEFAULT_WFS_GEOMETRY_PROPERTY = "the_geom";

/** Compile canonical query IR to the legacy deterministic WFS 2.0 GetFeature request. */
export function compileWfsQuery(source: QueryIrSourceIdentity, query: CanonicalQuery): WfsCompiledQueryV1 {
  const typeName = requireWfsTypeName(source);
  const geometryProperty = wfsGeometryProperty(source);
  assertNoWfsAggregation(query);
  if (query.spatialFilter && query.outSr !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS planning cannot use outSr to label input filter coordinates; stamp the input geometry through the typed WFS escape hatch",
    );
  }

  const filter = compileWfsFes(typeName, query, geometryProperty);
  const propertyName = compileWfsPropertyNames(query, geometryProperty);

  return {
    compiler: "wfs-2.0-get-feature-v1",
    typeName,
    ...(filter !== undefined ? { filter } : {}),
    ...(propertyName ? { propertyName } : {}),
    ...(query.orderBy && query.orderBy.length > 0
      ? {
          sortBy: query.orderBy.map((sort) => `${sort.field} ${sort.direction === "desc" ? "DESC" : "ASC"}`).join(","),
        }
      : {}),
    ...(query.pagination?.offset !== undefined ? { startIndex: query.pagination.offset } : {}),
    ...(query.pagination?.limit !== undefined ? { count: query.pagination.limit } : {}),
    ...(query.outSr !== undefined ? { srsName: String(query.outSr) } : {}),
  };
}

/**
 * The exact deterministic compiler hook installed on the first-party WFS
 * protocol module and used by planner dispatch.
 */
export const wfsProtocolQueryCompiler = Object.freeze({
  kind: "wfs" as const,
  compile(input: ProtocolModuleQueryCompileInput<QueryIrSourceIdentity, CanonicalQuery>): WfsProtocolCompiledQueryV1 {
    const typeName = requireWfsTypeName(input.source);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/.test(typeName)) {
      throw new HonuaQueryPlanningError("invalid-query", `Source "${input.source.id}" has an invalid WFS typeName`);
    }
    assertNoWfsAggregation(input.query);
    const endpoint = requireCredentialFreeWfsCompileEndpoint(input.source.endpoint);
    const authorityFingerprint =
      input.source.authorityFingerprint ??
      queryIrAuthorityFingerprint(input.source.endpoint, input.source.authorizationScope);
    if (!/^sha256:[0-9a-f]{64}$/.test(authorityFingerprint)) {
      throw new HonuaQueryPlanningError("invalid-query", "WFS source authority fingerprint is invalid");
    }
    if (
      typeof input.source.id !== "string" ||
      input.source.id.length === 0 ||
      containsControlCharacter(input.source.id)
    ) {
      throw new HonuaQueryPlanningError("invalid-query", "WFS source id is invalid");
    }
    const srsName = wfsSrsNameFromOutSr(input.query.outSr);
    const filterSrsName = wfsSpatialFilterSrsName(input.source, input.query);
    const geometryProperty = wfsGeometryProperty(input.source);
    const bbox = wfsBboxKvp(input.query, filterSrsName);
    const filter =
      bbox === undefined ? compileWfsFes(typeName, input.query, geometryProperty, filterSrsName) : undefined;
    const method = wfsProtocolMethodForFilter(filter);
    const propertyName = compileWfsPropertyNames(input.query, geometryProperty);
    const sortBy =
      input.query.orderBy && input.query.orderBy.length > 0
        ? input.query.orderBy.map((sort) => `${sort.field}${sort.direction === "desc" ? " D" : " A"}`).join(",")
        : undefined;
    const startIndex =
      input.query.pagination?.offset !== undefined && input.query.pagination.offset > 0
        ? input.query.pagination.offset
        : undefined;
    return bindWfsProtocolQueryOperation(
      {
        sourceId: input.source.id,
        endpoint,
        authorityFingerprint,
        typeName,
        method,
        ...(filter !== undefined ? { filter } : {}),
        ...(bbox !== undefined ? { bbox } : {}),
        ...(propertyName !== undefined ? { propertyName: Object.freeze([...propertyName]) } : {}),
        ...(sortBy !== undefined ? { sortBy } : {}),
        ...(startIndex !== undefined ? { startIndex } : {}),
        ...(input.query.pagination?.limit !== undefined ? { count: input.query.pagination.limit } : {}),
        ...(filterSrsName !== undefined ? { filterSrsName } : {}),
        ...(srsName !== undefined ? { srsName } : {}),
      },
      input.operation,
    );
  },
});

type WfsProtocolRequest = Omit<WfsProtocolCompiledQueryV1, "compiler" | "operation">;

/** Bind a WFS wire request to the exact operation authorized to execute it. */
export function bindWfsProtocolQueryOperation(
  request: WfsProtocolRequest,
  operation: ProtocolModuleQueryOperation,
): WfsProtocolCompiledQueryV1 {
  if (operation !== "query" && operation !== "queryAll" && operation !== "queryAggregate") {
    throw new HonuaQueryPlanningError("invalid-query", "WFS protocol operation is invalid");
  }
  let count = request.count;
  if (operation === "queryAll" && count !== undefined) {
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) {
      throw new HonuaQueryPlanningError(
        "invalid-query",
        "WFS queryAll pagination.limit must leave room for one lookahead row",
      );
    }
    count += 1;
  }
  return Object.freeze({
    compiler: "wfs-2.0-protocol-query-v1",
    operation,
    sourceId: request.sourceId,
    endpoint: request.endpoint,
    authorityFingerprint: request.authorityFingerprint,
    typeName: request.typeName,
    method: request.method,
    ...(request.filter !== undefined ? { filter: request.filter } : {}),
    ...(request.bbox !== undefined ? { bbox: request.bbox } : {}),
    ...(request.propertyName !== undefined ? { propertyName: Object.freeze([...request.propertyName]) } : {}),
    ...(request.sortBy !== undefined ? { sortBy: request.sortBy } : {}),
    ...(request.startIndex !== undefined ? { startIndex: request.startIndex } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(request.filterSrsName !== undefined ? { filterSrsName: request.filterSrsName } : {}),
    ...(request.srsName !== undefined ? { srsName: request.srsName } : {}),
  });
}

/** Credential-free endpoint identity used to bind an executable artifact to a runtime handle. */
export function wfsRuntimeEndpointIdentity(value: string): string {
  return normalizeWfsEndpoint(value, true);
}

/** Derive the only transport method authorized by the compiled filter budget. */
export function wfsProtocolMethodForFilter(filter: string | undefined): "GET" | "POST" {
  return filter !== undefined && encodeURIComponent(filter).length > WFS_GET_FILTER_BUDGET ? "POST" : "GET";
}

function requireCredentialFreeWfsCompileEndpoint(value: string): string {
  return normalizeWfsEndpoint(value, false);
}

function normalizeWfsEndpoint(value: string, allowRuntimeAuthority: boolean): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "[invalid-endpoint]" ||
    containsControlCharacter(value)
  ) {
    throw new HonuaQueryPlanningError("invalid-query", "WFS endpoint identity is invalid");
  }
  try {
    const parsed = new URL(value);
    if (!allowRuntimeAuthority && (parsed.username || parsed.password || parsed.search || parsed.hash)) {
      throw new HonuaQueryPlanningError(
        "invalid-query",
        "WFS compile endpoint must not contain credentials, query, or fragment",
      );
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    // Match queryIrSourceIdentity(): normalize the URL serializer's single
    // terminal separator without collapsing a path that intentionally ends
    // in multiple slashes.
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof HonuaQueryPlanningError) throw error;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith("//") || value.includes("@")) {
      throw new HonuaQueryPlanningError("invalid-query", "WFS endpoint identity is invalid");
    }
    const queryIndex = value.search(/[?#]/);
    if (!allowRuntimeAuthority && queryIndex >= 0) {
      throw new HonuaQueryPlanningError(
        "invalid-query",
        "WFS compile endpoint must not contain credentials, query, or fragment",
      );
    }
    const path = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
    const normalized = path.replace(/\/$/, "");
    if (path === "/") return "/";
    if (normalized.length === 0) {
      throw new HonuaQueryPlanningError("invalid-query", "WFS endpoint identity is invalid");
    }
    return normalized;
  }
}

function wfsBboxKvp(query: CanonicalQuery, filterSrsName: string | undefined): string | undefined {
  const envelope = wfsBboxShortcutEnvelope(query);
  if (!envelope) return undefined;
  return formatWfsBboxKvp(envelope.xmin, envelope.ymin, envelope.xmax, envelope.ymax, filterSrsName);
}

function wfsBboxShortcutEnvelope(
  query: CanonicalQuery,
): { xmin: number; ymin: number; xmax: number; ymax: number } | undefined {
  const filter = query.spatialFilter;
  // The `bbox=` KVP is mutually exclusive with `FILTER=`, so any other
  // constraint that has to be expressed as FES (source-native `where`, the
  // typed filter, a temporal predicate) disables the shortcut.
  if (query.where !== undefined || query.filter !== undefined || query.temporalFilter !== undefined) return undefined;
  if (!filter || filter.geometryType !== "esriGeometryEnvelope") return undefined;
  if (
    filter.spatialRel !== undefined &&
    filter.spatialRel !== "esriSpatialRelIntersects" &&
    filter.spatialRel !== "esriSpatialRelEnvelopeIntersects"
  ) {
    return undefined;
  }
  const envelope = filter.geometry as { xmin?: unknown; ymin?: unknown; xmax?: unknown; ymax?: unknown };
  if (
    typeof envelope.xmin !== "number" ||
    typeof envelope.ymin !== "number" ||
    typeof envelope.xmax !== "number" ||
    typeof envelope.ymax !== "number"
  ) {
    return undefined;
  }
  return { xmin: envelope.xmin, ymin: envelope.ymin, xmax: envelope.xmax, ymax: envelope.ymax };
}

/**
 * @internal True when the compiled request must name the geometry property in
 * an FES spatial predicate. The `bbox=` KVP shortcut addresses the feature
 * type's default geometry positionally, so it needs no name; every other
 * spatial predicate emits `<fes:ValueReference>` and does. The live adapter
 * uses this to resolve the property (and fail closed) only when the wire
 * actually depends on it.
 */
export function wfsSpatialFilterNeedsGeometryProperty(query: CanonicalQuery): boolean {
  if (query.filter !== undefined && queryFilterContainsSpatial(query.filter)) return true;
  return query.spatialFilter !== undefined && wfsBboxShortcutEnvelope(query) === undefined;
}

/** True when the typed filter references the feature type's geometry property. */
function queryFilterContainsSpatial(filter: QueryFilterExpression): boolean {
  if (filter.kind === "spatial") return filter.property === undefined;
  if (filter.kind === "boolean") return filter.args.some(queryFilterContainsSpatial);
  if (filter.kind === "not") return queryFilterContainsSpatial(filter.arg);
  return false;
}

/** Geometry property the compiled request references by name. */
function wfsGeometryProperty(source: QueryIrSourceIdentity): string {
  return source.geometryProperty ?? DEFAULT_WFS_GEOMETRY_PROPERTY;
}

/** @internal Shared with legacy non-query WFS drains to preserve CRS parity. */
export function wfsSrsNameFromOutSr(outSr: string | number | undefined): string | undefined {
  if (typeof outSr === "string") {
    if (outSr.length === 0) return undefined;
    if (outSr.trim() !== outSr || /[\s,]/.test(outSr) || containsControlCharacter(outSr)) {
      throw new HonuaQueryPlanningError("invalid-query", "WFS CRS identifier is invalid");
    }
    return outSr;
  }
  if (typeof outSr === "number" && Number.isSafeInteger(outSr) && outSr > 0) {
    return `urn:ogc:def:crs:EPSG::${outSr}`;
  }
  if (outSr === undefined) return undefined;
  throw new HonuaQueryPlanningError("invalid-query", "WFS CRS identifier is invalid");
}

function wfsSpatialFilterSrsName(source: QueryIrSourceIdentity, query: CanonicalQuery): string | undefined {
  const spatialFilter = query.spatialFilter;
  if (!spatialFilter) return undefined;
  return wfsFilterSrsNameFromGeometry(spatialFilter.geometry, source.srsName);
}

/** @internal Resolve only the input geometry CRS; response `outSr` is separate. */
export function wfsFilterSrsNameFromGeometry(
  geometry: Readonly<Record<string, unknown>>,
  fallback: string | number | undefined,
): string | undefined {
  const spatialReference = geometry.spatialReference;
  if (spatialReference === undefined) return wfsSrsNameFromOutSr(fallback);
  if (spatialReference === null || typeof spatialReference !== "object" || Array.isArray(spatialReference)) {
    throw new HonuaQueryPlanningError("invalid-query", "WFS spatial filter geometry has an invalid spatialReference");
  }
  const reference = spatialReference as Readonly<Record<string, unknown>>;
  const keys = Object.keys(reference);
  if (keys.some((key) => key !== "wkid" && key !== "latestWkid" && key !== "wkt")) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      "WFS spatial filter geometry has an unsupported spatialReference member",
    );
  }
  if (reference.wkt !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS spatial filters require a WKID-backed CRS; WKT cannot be serialized as a portable srsName",
    );
  }
  for (const [name, value] of [
    ["wkid", reference.wkid],
    ["latestWkid", reference.latestWkid],
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
      throw new HonuaQueryPlanningError("invalid-query", `WFS spatial filter geometry has an invalid ${name}`);
    }
  }
  const wkid = reference.latestWkid ?? reference.wkid;
  if (typeof wkid !== "number") {
    throw new HonuaQueryPlanningError("invalid-query", "WFS spatial filter geometry requires a positive WKID");
  }
  return wfsSrsNameFromOutSr(wkid);
}

function requireWfsTypeName(source: QueryIrSourceIdentity): string {
  if (source.protocol !== "wfs") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `wfs-2.0-get-feature-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  if (!source.typeName) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.typeName for WFS planning`,
    );
  }
  return source.typeName;
}

function assertNoWfsAggregation(query: CanonicalQuery): void {
  if (query.aggregation) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS 2.0 has no portable remote aggregation; use degraded policy with an explicit bounded-local fallback",
    );
  }
}

function compileWfsFes(
  typeName: string,
  query: CanonicalQuery,
  geometryProperty: string,
  srsName?: string,
): string | undefined {
  const filters: FesNode[] = [];
  const typed = compileWfsTypedFilter(query, geometryProperty);
  if (typed) filters.push(typed);
  if (query.where) {
    const where = compileWhere(query.where.expression);
    if (where === UNSUPPORTED_FES) {
      throw new HonuaQueryPlanningError("unsupported-query", "The where clause is not expressible as FES 2.0");
    }
    if (where.kind !== "and" || where.operands.length > 0) filters.push(where);
  }
  if (query.spatialFilter) {
    const spatial = compileSpatialFilter(
      {
        geometry: query.spatialFilter.geometry as Record<string, unknown>,
        geometryType: query.spatialFilter.geometryType,
        ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
      } as SpatialFilter,
      {
        geometryProperty,
        ...(srsName !== undefined ? { srsName } : {}),
      },
    );
    if (spatial === UNSUPPORTED_FES) {
      throw new HonuaQueryPlanningError("unsupported-query", "The spatial predicate is not expressible as FES 2.0");
    }
    filters.push(spatial);
  }
  return filters.length > 0 ? serializeFes(filters, { typeName }) : undefined;
}

/**
 * Compile the canonical typed filter (and a field-bound temporal filter) into
 * FES 2.0. WFS has no protocol-level time parameter, so a temporal filter
 * without a field is refused instead of being applied to a guessed column.
 */
function compileWfsTypedFilter(query: CanonicalQuery, geometryProperty: string): FesNode | undefined {
  const ctx: QueryFilterContext = { protocol: "wfs", geometryProperty };
  const temporalExpression = query.temporalFilter ? temporalFilterToExpression(query.temporalFilter, ctx) : undefined;
  if (query.temporalFilter && temporalExpression === undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS has no protocol-level time parameter; Query.temporalFilter must name the temporal field",
    );
  }
  const expression = andQueryFilters(query.filter, temporalExpression);
  if (!expression) return undefined;
  return compileQueryFilterToFes(expression, ctx);
}

function compileWfsPropertyNames(query: CanonicalQuery, geometryProperty: string): readonly string[] | undefined {
  if (query.outFields && query.outFields.length > 0) {
    const fields = [...query.outFields];
    if (query.returnGeometry === false && fields.includes(geometryProperty)) {
      throw new HonuaQueryPlanningError(
        "unsupported-query",
        `WFS returnGeometry=false conflicts with outFields containing the geometry property "${geometryProperty}"`,
      );
    }
    if (query.returnGeometry !== false && !fields.includes(geometryProperty)) {
      fields.push(geometryProperty);
    }
    return fields;
  }
  if (query.returnGeometry === false) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS returnGeometry=false requires explicit outFields because propertyName cannot otherwise suppress geometry exactly",
    );
  }
  return undefined;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
