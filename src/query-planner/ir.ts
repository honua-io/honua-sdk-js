import type { AggregationSpec, Query, SourceDescriptor } from "../contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import {
  type CanonicalQuery,
  type ExplainQueryOptions,
  HonuaQueryPlanningError,
  type JsonValue,
  QUERY_IR_KIND,
  QUERY_IR_VERSION,
  type QueryIrSourceIdentity,
  type QueryIrV1,
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

export function hashQueryIr(ir: QueryIrV1): `sha256:${string}` {
  return sha256(canonicalStringify(toJsonValue(ir)));
}

export function canonicalizeQuery<T>(query?: Readonly<Query<T>>): CanonicalQuery {
  if (!query) return deepFreeze({});
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
          spatialFilter: {
            geometry: query.spatialFilter.geometry as Record<string, unknown>,
            geometryType: query.spatialFilter.geometryType,
            ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
          },
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

export function queryIrSourceIdentity(
  descriptor: SourceDescriptor,
  context: Pick<ExplainQueryOptions, "authorizationScope" | "schemaVersion" | "sourceVersion"> = {},
): QueryIrSourceIdentity {
  const authorizationScope = [...new Set(context.authorizationScope ?? [])].sort();
  const geometryProperty = descriptor.schema?.fields?.find((field) => field.type === "esriFieldTypeGeometry")?.name;
  const geoparquet =
    descriptor.protocol === "geoparquet" ? geoparquetIdentity(descriptor, geometryProperty) : undefined;
  return deepFreeze({
    id: descriptor.id,
    protocol: descriptor.protocol,
    endpoint: credentialFreeEndpoint(descriptor.locator.url),
    ...(descriptor.locator.serviceId !== undefined ? { serviceId: descriptor.locator.serviceId } : {}),
    ...(descriptor.locator.layerId !== undefined ? { layerId: descriptor.locator.layerId } : {}),
    ...(descriptor.locator.collectionId !== undefined ? { collectionId: descriptor.locator.collectionId } : {}),
    ...(descriptor.locator.typeName !== undefined ? { typeName: descriptor.locator.typeName } : {}),
    ...(descriptor.locator.entitySet !== undefined ? { entitySet: descriptor.locator.entitySet } : {}),
    ...(geometryProperty ? { geometryProperty } : {}),
    ...(descriptor.locator.srsName !== undefined ? { srsName: String(descriptor.locator.srsName) } : {}),
    ...(context.schemaVersion !== undefined ? { schemaVersion: context.schemaVersion } : {}),
    ...(context.sourceVersion !== undefined ? { sourceVersion: context.sourceVersion } : {}),
    ...(geoparquet ? { geoparquet } : {}),
    authorizationScope,
    capabilities: [...descriptor.capabilities].sort(),
  });
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
  return {
    sources,
    ...(geometryColumn ? { geometryColumn } : {}),
    ...(geoparquet?.geometryEncoding ? { geometryEncoding: geoparquet.geometryEncoding } : {}),
    ...(geoparquet?.bboxColumn ? { bboxColumn: geoparquet.bboxColumn } : {}),
  };
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
  const invalidEndpoint = "[invalid-endpoint]";
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.username && !parsed.password && hasOpaqueSchemeUserInfo(rawUrl)) return invalidEndpoint;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    const path = rawUrl.split(/[?#]/, 1)[0] ?? rawUrl;
    const malformedAuthority = hasSchemeAuthorityPrefix(rawUrl) || startsWithDoubleSlash(rawUrl);
    const bareUserInfo = hasBareUserInfo(rawUrl);
    let unsafeCharacters = false;
    for (const character of rawUrl) {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0x20 || codePoint === 0x7f || character.trim() === "") {
        unsafeCharacters = true;
        break;
      }
    }
    return malformedAuthority || bareUserInfo || unsafeCharacters ? invalidEndpoint : path;
  }
}

function hasSchemeAuthorityPrefix(value: string): boolean {
  const colon = value.indexOf(":");
  if (colon < 1 || !asciiAlpha(value.charCodeAt(0))) return false;
  for (let index = 1; index < colon; index += 1) {
    const code = value.charCodeAt(index);
    if (!(asciiAlpha(code) || (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46)) {
      return false;
    }
  }
  return isSlash(value.charCodeAt(colon + 1)) && isSlash(value.charCodeAt(colon + 2));
}

function startsWithDoubleSlash(value: string): boolean {
  return isSlash(value.charCodeAt(0)) && isSlash(value.charCodeAt(1));
}

function hasOpaqueSchemeUserInfo(value: string): boolean {
  const colon = value.indexOf(":");
  if (colon < 1 || !asciiAlpha(value.charCodeAt(0))) return false;
  for (let index = 1; index < colon; index += 1) {
    const code = value.charCodeAt(index);
    if (!(asciiAlpha(code) || (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46)) {
      return false;
    }
  }
  for (let index = colon + 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 64) return true;
    if (endpointDelimiter(code, false)) return false;
  }
  return false;
}

function hasBareUserInfo(value: string): boolean {
  let colon = -1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (endpointDelimiter(code, true)) return false;
    if (code === 58 && colon === -1) {
      if (index === 0) return false;
      colon = index;
    } else if (code === 64) {
      return colon !== -1;
    }
  }
  return false;
}

function endpointDelimiter(code: number, backslash: boolean): boolean {
  return code <= 32 || code === 47 || code === 63 || code === 35 || (backslash && code === 92);
}

function asciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSlash(code: number): boolean {
  return code === 47 || code === 92;
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
