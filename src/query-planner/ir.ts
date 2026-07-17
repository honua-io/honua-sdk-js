import type { AggregationSpec, Query, SourceDescriptor } from "../contract/types.js";
import { removeUndefined } from "../core/remove-undefined.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import { parseGeoParquetResourceHandle } from "./resource.js";
import {
  type CanonicalQuery,
  type ExplainGeoParquetQueryOptions,
  type ExplainQueryOptions,
  HonuaQueryPlanningError,
  type JsonValue,
  QUERY_IR_KIND,
  QUERY_IR_V2_VERSION,
  QUERY_IR_VERSION,
  type QueryIrSourceIdentity,
  type QueryIrSourceIdentityV2,
  type QueryIrV1,
  type QueryIrV2,
} from "./types.js";

export function createQueryIr<T>(options: ExplainQueryOptions<T>): QueryIrV1 {
  try {
    const ir: QueryIrV1 = {
      kind: QUERY_IR_KIND,
      version: QUERY_IR_VERSION,
      source: queryIrSourceIdentity(options.descriptor, options),
      query: canonicalizeQuery(options.query),
    };
    return deepFreeze(ir);
  } catch (error) {
    if (error instanceof HonuaQueryPlanningError) throw error;
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Query cannot be represented by ${QUERY_IR_KIND}@${QUERY_IR_VERSION}: ${errorMessage(error)}`,
    );
  }
}

/** Build a GeoParquet v2 IR whose only resource addressing is an opaque handle. */
export function createGeoParquetQueryIr<T>(options: ExplainGeoParquetQueryOptions<T>): QueryIrV2 {
  try {
    const ir: QueryIrV2 = {
      kind: QUERY_IR_KIND,
      version: QUERY_IR_V2_VERSION,
      source: queryIrSourceIdentityV2(options.descriptor, options.geoparquetResource, options),
      query: canonicalizeQuery(options.query),
    };
    return deepFreeze(ir);
  } catch (error) {
    if (error instanceof HonuaQueryPlanningError) throw error;
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `GeoParquet query cannot be represented safely by ${QUERY_IR_KIND}@${QUERY_IR_V2_VERSION}`,
    );
  }
}

export function hashQueryIr(ir: QueryIrV1 | QueryIrV2): `sha256:${string}` {
  return sha256(canonicalStringify(toJsonValue(ir)));
}

export function canonicalizeQuery<T>(query?: Readonly<Query<T>>): CanonicalQuery {
  if (!query) return deepFreeze({});
  if (query.where !== undefined) assertSafeNativeExpression(query.where);
  const canonical: CanonicalQuery = {
    ...(query.where !== undefined ? { where: { kind: "source-native" as const, expression: query.where } } : {}),
    ...(query.spatialFilter
      ? {
          spatialFilter: {
            geometry: asJsonObject(query.spatialFilter.geometry, "$.query.spatialFilter.geometry"),
            geometryType: query.spatialFilter.geometryType,
            ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
          },
        }
      : {}),
    ...(query.outFields ? { outFields: [...query.outFields] } : {}),
    ...(query.orderBy
      ? {
          orderBy: query.orderBy.map((sort) => ({ field: sort.field, direction: sort.direction ?? "asc" })),
        }
      : {}),
    ...(query.pagination
      ? {
          pagination: {
            ...(query.pagination.offset !== undefined
              ? { offset: checkedInteger(query.pagination.offset, "offset", 0) }
              : {}),
            ...(query.pagination.limit !== undefined
              ? { limit: checkedInteger(query.pagination.limit, "limit", 0) }
              : {}),
          },
        }
      : {}),
    ...(query.aggregation ? { aggregation: canonicalizeAggregation(query.aggregation) } : {}),
    ...(query.returnGeometry !== undefined ? { returnGeometry: query.returnGeometry } : {}),
    ...(query.outSr !== undefined ? { outSr: query.outSr } : {}),
  };
  return deepFreeze(canonical);
}

export function queryFromCanonical<T>(query: CanonicalQuery, signal?: AbortSignal): Query<T> {
  return {
    ...(query.where ? { where: query.where.expression } : {}),
    ...(query.spatialFilter
      ? {
          spatialFilter: removeUndefined({
            geometry: query.spatialFilter.geometry as Record<string, unknown>,
            geometryType: query.spatialFilter.geometryType,
            spatialRel: query.spatialFilter.spatialRel,
          }),
        }
      : {}),
    ...(query.outFields ? { outFields: query.outFields } : {}),
    ...(query.orderBy ? { orderBy: query.orderBy } : {}),
    ...(query.pagination ? { pagination: query.pagination } : {}),
    ...(query.aggregation ? { aggregation: query.aggregation } : {}),
    ...(query.returnGeometry !== undefined ? { returnGeometry: query.returnGeometry } : {}),
    ...(query.outSr !== undefined ? { outSr: query.outSr } : {}),
    ...(signal ? { signal } : {}),
  };
}

/** @internal Rebuild the feature-only query shape accepted by focused renderer workflows. */
export function featureQueryFromCanonical<T>(query: CanonicalQuery, signal: AbortSignal): Query<T> {
  return removeUndefined({
    where: query.where?.expression,
    ...(query.spatialFilter
      ? {
          spatialFilter: {
            geometry: query.spatialFilter.geometry as Record<string, unknown>,
            geometryType: query.spatialFilter.geometryType,
            ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
          },
        }
      : {}),
    outFields: query.outFields,
    orderBy: query.orderBy,
    pagination: query.pagination,
    returnGeometry: query.returnGeometry,
    outSr: query.outSr,
    signal,
  }) as Query<T>;
}

export function queryIrSourceIdentity(
  descriptor: SourceDescriptor,
  context: Pick<ExplainQueryOptions, "authorizationScope" | "schemaVersion" | "sourceVersion"> = {},
): QueryIrSourceIdentity {
  return deepFreeze(queryIrSourceIdentitySnapshot(descriptor, context));
}

/** @internal Build a transient identity for comparison without retaining the recursive freezer. */
export function queryIrSourceIdentitySnapshot(
  descriptor: SourceDescriptor,
  context: Pick<ExplainQueryOptions, "authorizationScope" | "schemaVersion" | "sourceVersion">,
): QueryIrSourceIdentity {
  const authorizationScope = [...new Set(context.authorizationScope ?? [])].sort();
  if (authorizationScope.some((scope) => !isStableAuthorizationScope(scope))) {
    throw new HonuaQueryPlanningError("invalid-query", "authorization scope identity is invalid");
  }
  const geometryProperty = descriptor.schema?.fields?.find((field) => field.type === "esriFieldTypeGeometry")?.name;
  const geoparquet =
    descriptor.protocol === "geoparquet" ? geoparquetIdentity(descriptor, geometryProperty) : undefined;
  const schemaVersion = optionalPlanMetadata(context.schemaVersion, "schema version");
  const sourceVersion = optionalPlanMetadata(context.sourceVersion, "source version");
  return removeUndefined({
    id: descriptor.id,
    protocol: descriptor.protocol,
    endpoint: credentialFreeEndpoint(descriptor.locator.url),
    serviceId: descriptor.locator.serviceId,
    layerId: descriptor.locator.layerId,
    collectionId: descriptor.locator.collectionId,
    typeName: descriptor.locator.typeName,
    entitySet: descriptor.locator.entitySet,
    geometryProperty,
    srsName: descriptor.locator.srsName === undefined ? undefined : String(descriptor.locator.srsName),
    schemaVersion,
    sourceVersion,
    geoparquet,
    authorizationScope,
    capabilities: [...descriptor.capabilities].sort(),
  }) as QueryIrSourceIdentity;
}

/** Rebuild the exact credential-free source identity used by a GeoParquet v2 plan. */
export function queryIrSourceIdentityV2(
  descriptor: SourceDescriptor,
  resourceValue: unknown,
  context: Pick<ExplainQueryOptions, "authorizationScope" | "schemaVersion" | "sourceVersion"> = {},
): QueryIrSourceIdentityV2 {
  if (descriptor.protocol !== "geoparquet") {
    throw new HonuaQueryPlanningError("invalid-query", "Opaque GeoParquet resources require protocol geoparquet");
  }
  const resource = parseGeoParquetResourceHandle(resourceValue);
  const authorizationScope = [...new Set(context.authorizationScope ?? [])].sort();
  if (authorizationScope.some((scope) => !isStableAuthorizationScope(scope))) {
    throw new HonuaQueryPlanningError("invalid-query", "GeoParquet authorization scope identity is invalid");
  }
  const geometryProperty = descriptor.schema?.fields?.find((field) => field.type === "esriFieldTypeGeometry")?.name;
  const primaryKey = optionalPlanMetadata(descriptor.schema?.primaryKey, "primary key");
  const schemaVersion = optionalPlanMetadata(context.schemaVersion, "schema version");
  const sourceVersion = optionalPlanMetadata(context.sourceVersion, "source version");
  const geometryColumn = optionalPlanMetadata(
    descriptor.locator.geoparquet?.geometryColumn ?? geometryProperty,
    "geometry column",
  );
  const bboxColumn = optionalPlanMetadata(descriptor.locator.geoparquet?.bboxColumn, "bbox column");
  const geometryEncoding = descriptor.locator.geoparquet?.geometryEncoding;
  if (
    geometryEncoding !== undefined &&
    geometryEncoding !== "wkb" &&
    geometryEncoding !== "native" &&
    geometryEncoding !== "geojson"
  ) {
    throw new HonuaQueryPlanningError("invalid-query", "GeoParquet geometry encoding identity is invalid");
  }
  return deepFreeze({
    id: resource.resource.id,
    protocol: "geoparquet",
    endpoint: "[opaque-resource]",
    ...(primaryKey ? { primaryKey } : {}),
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    geoparquet: {
      resource,
      ...(geometryColumn ? { geometryColumn } : {}),
      ...(geometryEncoding ? { geometryEncoding } : {}),
      ...(bboxColumn ? { bboxColumn } : {}),
    },
    authorizationScope,
    capabilities: [...descriptor.capabilities].sort(),
  });
}

function optionalPlanMetadata(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 1_024 ||
    containsControlCharacter(value) ||
    containsCredentialMaterial(value)
  ) {
    throw new HonuaQueryPlanningError("invalid-query", `Query plan ${label} identity is invalid`);
  }
  return value;
}

const CREDENTIAL_MATERIAL =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bBasic\s+[A-Za-z0-9+/=]{8,}|\bAKIA[0-9A-Z]{16}\b|[?&;](?:access[-_]?token|id[-_]?token|refresh[-_]?token|x-amz-signature|x-goog-credential|signature|sig|token|api[-_]?key|password|secret)=[^\s&#;]*|\b(?:authorization|password|secret|token|api[-_]?key|account[-_]?key|shared[-_]?access[-_]?signature)\s*(?:=|:)\s*[^\s,;]+|[a-z][a-z0-9+.-]*:\/\/[^/\s"'<>]*@|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;

/** @internal Shared credential-material admission guard for focused plan boundaries. */
export function containsCredentialMaterial(value: string): boolean {
  return CREDENTIAL_MATERIAL.test(value);
}

/** @internal Shared control-character admission guard for focused plan boundaries. */
export function containsControlCharacter(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: This trust boundary intentionally rejects ASCII controls.
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isStableAuthorizationScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/.test(value) &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    !value.split("/").some((segment) => segment === "." || segment === "..") &&
    !/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)
  );
}

function assertSafeNativeExpression(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 65_536 || containsControlCharacter(value)) {
    throw new HonuaQueryPlanningError("invalid-query", "query.where is invalid");
  }
  const sensitive =
    /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bBasic\s+[A-Za-z0-9+/=]{8,}|\bAKIA[0-9A-Z]{16}\b|\b(?:authorization|password|secret|token|api[-_]?key)\s*(?:=|eq)\s*['"][^'"]{4,}['"]|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;
  if (sensitive.test(value)) {
    throw new HonuaQueryPlanningError("invalid-query", "query.where contains sensitive native expression material");
  }
}

/**
 * Derive deterministic DuckDB/GeoParquet addressing from the descriptor so the
 * SQL compiler never needs a profiling round-trip. Mirrors the live GeoParquet
 * `Source` addressing (`locator.url` + `locator.geoparquet.urls`).
 */
function geoparquetIdentity(
  descriptor: SourceDescriptor,
  geometryProperty: string | undefined,
): QueryIrSourceIdentity["geoparquet"] {
  const { url, geoparquet } = descriptor.locator;
  const sources: string[] = [];
  if (typeof url === "string" && url.length > 0) sources.push(url);
  if (geoparquet?.urls) sources.push(...geoparquet.urls);
  const geometryColumn = geoparquet?.geometryColumn ?? geometryProperty;
  return removeUndefined({
    sources,
    geometryColumn,
    geometryEncoding: geoparquet?.geometryEncoding,
    bboxColumn: geoparquet?.bboxColumn,
  }) as QueryIrSourceIdentity["geoparquet"];
}

function canonicalizeAggregation(aggregation: AggregationSpec): AggregationSpec {
  if (aggregation.metrics.length === 0) {
    throw new HonuaQueryPlanningError("invalid-query", "aggregation.metrics must contain at least one metric");
  }
  return {
    ...(aggregation.groupBy ? { groupBy: [...aggregation.groupBy] } : {}),
    metrics: aggregation.metrics.map((metric) => ({
      fn: metric.fn,
      field: metric.field,
      ...(metric.alias !== undefined ? { alias: metric.alias } : {}),
    })),
    ...(aggregation.histogram
      ? { histogram: toJsonValue(aggregation.histogram) as unknown as AggregationSpec["histogram"] }
      : {}),
    ...(aggregation.timeSeries
      ? { timeSeries: toJsonValue(aggregation.timeSeries) as unknown as AggregationSpec["timeSeries"] }
      : {}),
  };
}

function checkedInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new HonuaQueryPlanningError("invalid-query", `pagination.${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function asJsonObject(value: unknown, path: string): { readonly [key: string]: JsonValue } {
  const json = toJsonValue(value, path);
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    throw new TypeError(`${path} must be an object`);
  }
  return json as { readonly [key: string]: JsonValue };
}

function credentialFreeEndpoint(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: This trust boundary intentionally rejects ASCII controls.
    if (!parsed.username && !parsed.password && /^[A-Za-z][A-Za-z0-9+.-]*:[^/\u0000-\u0020?#@]*@/.test(rawUrl)) {
      return "[invalid-endpoint]";
    }
    parsed.username = parsed.password = parsed.search = parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    const path = rawUrl.split(/[?#]/, 1)[0] ?? rawUrl;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: This trust boundary intentionally rejects ASCII controls.
    return /(?:^(?:(?:[A-Za-z][A-Za-z0-9+.-]*:)?[\\/]{2}|[^\\/\u0000-\u0020?#:]+:[^\\/\u0000-\u0020?#@]*@)|[\s\u0000-\u001f\u007f])/u.test(
      rawUrl,
    )
      ? "[invalid-endpoint]"
      : path;
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
