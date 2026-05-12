/**
 * Provider-neutral analytics source primitives for warehouse and indexed data.
 *
 * These descriptors are serializable contract objects. They describe table,
 * SQL query, tileset, and indexed spatial sources without embedding
 * credentials or binding callers to a warehouse vendor SDK.
 *
 * @module
 */

import type { HonuaExtent } from "../core/types.js";
import type { Capability, DegradedReason, SourceFreshnessContract, SourceId } from "./types.js";

export const ANALYTICS_SOURCE_SCHEMA_VERSION = "honua.analytics-source.v1" as const;

export type AnalyticsSourceSchemaVersion = typeof ANALYTICS_SOURCE_SCHEMA_VERSION;
export type AnalyticsSourceKind =
  | "warehouse-table"
  | "warehouse-query"
  | "warehouse-tileset"
  | "indexed-spatial"
  | "h3-index"
  | "quadbin-index";
export type AnalyticsWarehouseProvider =
  | "bigquery"
  | "snowflake"
  | "redshift"
  | "postgres"
  | "duckdb"
  | "carto"
  | "honua"
  | "custom";
export type AnalyticsSourcePushdownCapability =
  | "sql"
  | "tiles"
  | "widgets"
  | "spatialAggregate"
  | "crossfilter"
  | "metadata";
export type AnalyticsSourceFallbackMode = "disabled" | "server-degraded" | "client-bounded";
export type AnalyticsIndexHierarchy = "parent-child" | "flat" | "unknown";
export type AnalyticsIndexCoverageKind = "global" | "bounded" | "sparse" | "viewport";

export interface AnalyticsSourceRelationDescriptor {
  readonly project?: string;
  readonly dataset?: string;
  readonly schema?: string;
  readonly table: string;
  readonly catalog?: string;
}

export interface AnalyticsSourceSqlDescriptor {
  /** SQL text or a stable server-side query id. Never put secrets here. */
  readonly text: string;
  readonly dialect?: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AnalyticsSourceTilesetDescriptor {
  readonly id: string;
  readonly url?: string;
  readonly tileMatrixSet?: string;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly sourceLayer?: string;
}

export interface AnalyticsIndexCoverageDescriptor {
  readonly kind: AnalyticsIndexCoverageKind;
  readonly extent?: HonuaExtent;
  readonly cellCount?: number;
  readonly complete?: boolean;
}

export interface AnalyticsIndexDescriptor {
  readonly modelId: "h3" | "quadbin" | string;
  readonly cellIdField: string;
  readonly resolution?: number;
  readonly minResolution?: number;
  readonly maxResolution?: number;
  readonly hierarchy?: AnalyticsIndexHierarchy;
  readonly coverage?: AnalyticsIndexCoverageDescriptor;
  readonly parentField?: string;
  readonly geometryField?: string;
}

export interface AnalyticsSourceCapabilityMetadata {
  readonly pushdown: readonly AnalyticsSourcePushdownCapability[];
  readonly unsupported?: readonly AnalyticsSourcePushdownCapability[];
  readonly maxClientRows?: number;
  readonly realtime?: boolean;
  readonly freshness?: SourceFreshnessContract;
}

export interface AnalyticsSourceCacheIdentity {
  readonly sourceVersion?: string;
  readonly authorizationScope?: string;
  readonly filters?: unknown;
  readonly indexResolution?: number;
  readonly projection?: unknown;
  readonly widgetProjection?: unknown;
  readonly styleProjection?: unknown;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface AnalyticsSourceCachePolicy {
  readonly metadataCacheable?: boolean;
  readonly resultCacheable?: boolean;
  readonly ttlMs?: number;
  readonly key?: AnalyticsSourceCacheIdentity;
}

export interface AnalyticsSourceFallbackPolicy {
  readonly mode: AnalyticsSourceFallbackMode;
  readonly reason?: string;
}

export interface AnalyticsSourceProtocolEscapeHatch {
  readonly provider: string;
  readonly protocol: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface AnalyticsSourceDescriptorBase {
  readonly schemaVersion?: AnalyticsSourceSchemaVersion;
  readonly kind: AnalyticsSourceKind;
  readonly id: SourceId;
  readonly title?: string;
  readonly description?: string;
  readonly provider?: AnalyticsWarehouseProvider | string;
  readonly sourceId?: SourceId;
  readonly capabilities?: AnalyticsSourceCapabilityMetadata;
  readonly cache?: AnalyticsSourceCachePolicy;
  readonly fallback?: AnalyticsSourceFallbackPolicy;
  readonly protocol?: AnalyticsSourceProtocolEscapeHatch;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WarehouseTableSourceDescriptor extends AnalyticsSourceDescriptorBase {
  readonly kind: "warehouse-table";
  readonly relation: AnalyticsSourceRelationDescriptor;
}

export interface WarehouseQuerySourceDescriptor extends AnalyticsSourceDescriptorBase {
  readonly kind: "warehouse-query";
  readonly sql: AnalyticsSourceSqlDescriptor;
}

export interface WarehouseTilesetSourceDescriptor extends AnalyticsSourceDescriptorBase {
  readonly kind: "warehouse-tileset";
  readonly tileset: AnalyticsSourceTilesetDescriptor;
  readonly relation?: AnalyticsSourceRelationDescriptor;
  readonly sql?: AnalyticsSourceSqlDescriptor;
}

export interface IndexedSpatialSourceDescriptor extends AnalyticsSourceDescriptorBase {
  readonly kind: "indexed-spatial" | "h3-index" | "quadbin-index";
  readonly relation?: AnalyticsSourceRelationDescriptor;
  readonly sql?: AnalyticsSourceSqlDescriptor;
  readonly index: AnalyticsIndexDescriptor;
}

export type AnalyticsSourceDescriptor =
  | WarehouseTableSourceDescriptor
  | WarehouseQuerySourceDescriptor
  | WarehouseTilesetSourceDescriptor
  | IndexedSpatialSourceDescriptor;

export interface AnalyticsSourceCacheKeyOptions {
  readonly cache?: AnalyticsSourceCacheIdentity;
  readonly prefix?: string;
  readonly operation?: "tiles" | "widget" | "spatialAggregate" | "sql" | string;
}

export interface AnalyticsSourcePushdownAssessment {
  readonly sourceId: SourceId;
  readonly capability: AnalyticsSourcePushdownCapability;
  readonly supported: boolean;
  readonly cacheKey: string;
  readonly degraded?: readonly DegradedReason[];
}

export function defineWarehouseTableSource(
  descriptor: Omit<WarehouseTableSourceDescriptor, "kind">,
): WarehouseTableSourceDescriptor {
  return normalizeAnalyticsSourceDescriptor({ ...descriptor, kind: "warehouse-table" });
}

export function defineWarehouseQuerySource(
  descriptor: Omit<WarehouseQuerySourceDescriptor, "kind">,
): WarehouseQuerySourceDescriptor {
  return normalizeAnalyticsSourceDescriptor({ ...descriptor, kind: "warehouse-query" });
}

export function defineWarehouseTilesetSource(
  descriptor: Omit<WarehouseTilesetSourceDescriptor, "kind">,
): WarehouseTilesetSourceDescriptor {
  return normalizeAnalyticsSourceDescriptor({ ...descriptor, kind: "warehouse-tileset" });
}

export function defineIndexedSpatialSource(
  descriptor: Omit<IndexedSpatialSourceDescriptor, "kind"> & {
    readonly kind?: IndexedSpatialSourceDescriptor["kind"];
  },
): IndexedSpatialSourceDescriptor {
  const modelId = descriptor.index?.modelId;
  const kind =
    descriptor.kind ?? (modelId === "h3" ? "h3-index" : modelId === "quadbin" ? "quadbin-index" : "indexed-spatial");
  return normalizeAnalyticsSourceDescriptor({ ...descriptor, kind });
}

export function normalizeAnalyticsSourceDescriptor<T extends AnalyticsSourceDescriptor>(descriptor: T): T {
  if (!isRecord(descriptor)) {
    throw new Error("AnalyticsSourceDescriptor must be an object");
  }
  if (!descriptor.id || typeof descriptor.id !== "string") {
    throw new Error("AnalyticsSourceDescriptor.id is required");
  }
  if (!isAnalyticsSourceKind(descriptor.kind)) {
    throw new Error("AnalyticsSourceDescriptor.kind is required");
  }
  if (descriptor.kind === "warehouse-table" && !isRelationDescriptor(descriptor.relation)) {
    throw new Error("warehouse table sources require relation.table");
  }
  if (descriptor.kind === "warehouse-query" && !isSqlDescriptor(descriptor.sql)) {
    throw new Error("warehouse query sources require sql.text");
  }
  if (descriptor.kind === "warehouse-tileset" && !isTilesetDescriptor(descriptor.tileset)) {
    throw new Error("warehouse tileset sources require tileset.id");
  }
  if (
    (descriptor.kind === "indexed-spatial" || descriptor.kind === "h3-index" || descriptor.kind === "quadbin-index") &&
    !isIndexDescriptor(descriptor.index)
  ) {
    throw new Error("indexed spatial sources require index.modelId and index.cellIdField");
  }
  const capabilities = isCapabilitiesMetadata(descriptor.capabilities) ? descriptor.capabilities : undefined;
  const fallback = isFallbackPolicy(descriptor.fallback) ? descriptor.fallback : undefined;
  return {
    ...descriptor,
    schemaVersion: descriptor.schemaVersion ?? ANALYTICS_SOURCE_SCHEMA_VERSION,
    sourceId: descriptor.sourceId ?? descriptor.id,
    capabilities: {
      pushdown: capabilities?.pushdown ?? defaultPushdown(descriptor),
      ...(capabilities?.unsupported ? { unsupported: capabilities.unsupported } : {}),
      ...(capabilities?.maxClientRows !== undefined ? { maxClientRows: capabilities.maxClientRows } : {}),
      ...(capabilities?.realtime !== undefined ? { realtime: capabilities.realtime } : {}),
      ...(capabilities?.freshness ? { freshness: capabilities.freshness } : {}),
    },
    fallback: fallback ?? { mode: "disabled" },
  } as T;
}

export function analyticsSourceId(descriptor: AnalyticsSourceDescriptor): SourceId {
  return normalizeAnalyticsSourceDescriptor(descriptor).sourceId ?? descriptor.id;
}

export function isAnalyticsSourceDescriptor(value: unknown): value is AnalyticsSourceDescriptor {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0 || !isAnalyticsSourceKind(value.kind)) return false;
  switch (value.kind) {
    case "warehouse-table":
      return isRelationDescriptor(value.relation);
    case "warehouse-query":
      return isSqlDescriptor(value.sql);
    case "warehouse-tileset":
      return isTilesetDescriptor(value.tileset);
    case "indexed-spatial":
    case "h3-index":
    case "quadbin-index":
      return isIndexDescriptor(value.index);
  }
}

export function buildAnalyticsSourceCacheKey(
  descriptor: AnalyticsSourceDescriptor,
  options: AnalyticsSourceCacheKeyOptions = {},
): string {
  const normalized = normalizeAnalyticsSourceDescriptor(descriptor);
  const cache = { ...(normalized.cache?.key ?? {}), ...(options.cache ?? {}) };
  return `${options.prefix ?? "honua-analytics-source"}:${stableStringify({
    v: 1,
    schemaVersion: normalized.schemaVersion,
    operation: options.operation,
    kind: normalized.kind,
    id: normalized.id,
    sourceId: normalized.sourceId,
    provider: normalized.provider,
    relation: relationForCache(normalized),
    sql: sqlForCache(normalized),
    tileset: tilesetForCache(normalized),
    index: indexForCache(normalized, cache.indexResolution),
    sourceVersion: cache.sourceVersion,
    authorizationScope: cache.authorizationScope,
    filters: cache.filters,
    projection: cache.projection,
    widgetProjection: cache.widgetProjection,
    styleProjection: cache.styleProjection,
    extra: cache.extra,
  })}`;
}

export function assessAnalyticsSourcePushdown(
  descriptor: AnalyticsSourceDescriptor,
  capability: AnalyticsSourcePushdownCapability,
  options: AnalyticsSourceCacheKeyOptions = {},
): AnalyticsSourcePushdownAssessment {
  const normalized = normalizeAnalyticsSourceDescriptor(descriptor);
  const supported = normalized.capabilities?.pushdown.includes(capability) === true;
  const degraded = supported
    ? undefined
    : [
        analyticsSourceDegradedReason(
          normalized,
          capabilityToContractCapability(capability),
          `Analytics source "${normalized.id}" does not advertise ${capability} server pushdown.`,
        ),
      ];
  return {
    sourceId: analyticsSourceId(normalized),
    capability,
    supported,
    cacheKey: buildAnalyticsSourceCacheKey(normalized, { ...options, operation: options.operation ?? capability }),
    ...(degraded ? { degraded } : {}),
  };
}

export function analyticsSourceDegradedReason(
  descriptor: AnalyticsSourceDescriptor,
  capability: Capability,
  reason?: string,
): DegradedReason {
  const normalized = normalizeAnalyticsSourceDescriptor(descriptor);
  return {
    capability,
    reason: reason ?? normalized.fallback?.reason ?? `Analytics source "${normalized.id}" requires degraded execution.`,
    sourceId: analyticsSourceId(normalized),
  };
}

function defaultPushdown(descriptor: AnalyticsSourceDescriptor): readonly AnalyticsSourcePushdownCapability[] {
  switch (descriptor.kind) {
    case "warehouse-table":
    case "warehouse-query":
      return ["sql", "widgets", "spatialAggregate", "metadata"];
    case "warehouse-tileset":
      return ["tiles", "metadata"];
    case "h3-index":
    case "quadbin-index":
    case "indexed-spatial":
      return ["tiles", "widgets", "spatialAggregate", "crossfilter", "metadata"];
  }
}

function capabilityToContractCapability(capability: AnalyticsSourcePushdownCapability): Capability {
  if (capability === "tiles") return "tiles";
  if (capability === "sql") return "sql";
  if (capability === "spatialAggregate") return "spatialAggregate";
  return "queryAggregate";
}

function isAnalyticsSourceKind(value: unknown): value is AnalyticsSourceKind {
  return (
    value === "warehouse-table" ||
    value === "warehouse-query" ||
    value === "warehouse-tileset" ||
    value === "indexed-spatial" ||
    value === "h3-index" ||
    value === "quadbin-index"
  );
}

function isRelationDescriptor(value: unknown): value is AnalyticsSourceRelationDescriptor {
  return isRecord(value) && typeof value.table === "string" && value.table.length > 0;
}

function isSqlDescriptor(value: unknown): value is AnalyticsSourceSqlDescriptor {
  return isRecord(value) && typeof value.text === "string" && value.text.length > 0;
}

function isTilesetDescriptor(value: unknown): value is AnalyticsSourceTilesetDescriptor {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function isIndexDescriptor(value: unknown): value is AnalyticsIndexDescriptor {
  return (
    isRecord(value) &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    typeof value.cellIdField === "string" &&
    value.cellIdField.length > 0
  );
}

function isCapabilitiesMetadata(value: unknown): value is AnalyticsSourceCapabilityMetadata {
  if (!isRecord(value)) return false;
  return (
    (!("pushdown" in value) || isPushdownCapabilityArray(value.pushdown)) &&
    (!("unsupported" in value) || isPushdownCapabilityArray(value.unsupported)) &&
    (!("maxClientRows" in value) || typeof value.maxClientRows === "number") &&
    (!("realtime" in value) || typeof value.realtime === "boolean")
  );
}

function isPushdownCapabilityArray(value: unknown): value is readonly AnalyticsSourcePushdownCapability[] {
  return Array.isArray(value) && value.every(isPushdownCapability);
}

function isPushdownCapability(value: unknown): value is AnalyticsSourcePushdownCapability {
  return (
    value === "sql" ||
    value === "tiles" ||
    value === "widgets" ||
    value === "spatialAggregate" ||
    value === "crossfilter" ||
    value === "metadata"
  );
}

function isFallbackPolicy(value: unknown): value is AnalyticsSourceFallbackPolicy {
  return (
    isRecord(value) &&
    (value.mode === "disabled" || value.mode === "server-degraded" || value.mode === "client-bounded")
  );
}

function relationForCache(descriptor: AnalyticsSourceDescriptor): AnalyticsSourceRelationDescriptor | undefined {
  return "relation" in descriptor ? descriptor.relation : undefined;
}

function sqlForCache(descriptor: AnalyticsSourceDescriptor): AnalyticsSourceSqlDescriptor | undefined {
  return "sql" in descriptor ? descriptor.sql : undefined;
}

function tilesetForCache(descriptor: AnalyticsSourceDescriptor): AnalyticsSourceTilesetDescriptor | undefined {
  return "tileset" in descriptor ? descriptor.tileset : undefined;
}

function indexForCache(
  descriptor: AnalyticsSourceDescriptor,
  overrideResolution: number | undefined,
): AnalyticsIndexDescriptor | undefined {
  if (!("index" in descriptor)) return undefined;
  return {
    ...descriptor.index,
    resolution: overrideResolution ?? descriptor.index.resolution,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
