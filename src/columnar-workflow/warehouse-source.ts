import type {
  AggregationSpec,
  Capabilities,
  Capability,
  CapabilityAwareSource,
  Query,
  Result,
  SourceDescriptor,
  SourceFreshnessContract,
} from "../contract/types.js";
import { capabilities } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaExtent } from "../core/types.js";
import {
  GOVERNED_WAREHOUSE_PROVIDERS,
  type GovernedWarehouseProvider,
  HonuaWarehouseError,
  assertNoRawVendorSql,
  assertNoWarehouseSecrets,
  assertOpaqueGovernedIdentifier,
  isGovernedWarehouseProvider,
  isPlainRecord,
  stableWarehouseJson,
} from "./warehouse-security.js";

export const WAREHOUSE_SOURCE_CAPABILITY_SCHEMA_VERSION = "honua.warehouse-source-capabilities.v1" as const;

export type WarehouseOutputFormat = "format.geoparquet" | "format.geoarrow" | "format.geojson" | "format.mvt";

export type WarehouseSpatialPredicate =
  | "bbox-intersects"
  | "intersects"
  | "within"
  | "contains"
  | "disjoint"
  | "touches"
  | "overlaps"
  | "crosses"
  | "within-distance";

export type WarehouseAvailabilityStatus = "available" | "degraded" | "unavailable";

export interface WarehouseSourceAvailability {
  readonly status: WarehouseAvailabilityStatus;
  readonly reason?: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface WarehouseSourcePolicyMetadata {
  readonly policyScopeFingerprint: string;
  readonly tenantScope?: string;
  readonly readOnly: boolean;
  readonly rowPolicyActive: boolean;
  readonly fieldMaskingActive: boolean;
}

export interface WarehouseSourceCrsCapabilities {
  readonly storageCrs: string;
  readonly supportsReprojection: boolean;
  readonly geometryModel: "planar" | "geodetic" | "mixed";
}

export interface WarehouseSourceQueryLimits {
  readonly maxScannedRows?: number;
  readonly maxScannedBytes?: number;
  readonly maxReturnedRows?: number;
  readonly maxReturnedBytes?: number;
  readonly deadlineMs?: number;
  readonly costHintAvailable: boolean;
}

export interface WarehouseSourceRelation {
  readonly catalog?: string;
  readonly schema?: string;
  readonly table: string;
}

export interface WarehouseSourceFieldSchema {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface WarehouseSourceOperationFlags {
  readonly query: boolean;
  readonly queryAggregate: boolean;
  readonly spatialAggregate: boolean;
  readonly h3Aggregation: boolean;
  readonly queryExtent: boolean;
  readonly stream: boolean;
  readonly temporalFilter: boolean;
  readonly widgets: boolean;
}

/**
 * Credential-free effective source capability descriptor discovered from Honua Server.
 * Capabilities are taken strictly from this payload, never inferred from provider name.
 */
export interface WarehouseEffectiveSourceCapabilities {
  readonly schemaVersion: typeof WAREHOUSE_SOURCE_CAPABILITY_SCHEMA_VERSION;
  readonly sourceId: string;
  readonly connectionId: string;
  readonly provider: GovernedWarehouseProvider;
  readonly relation?: WarehouseSourceRelation;
  readonly governedQueryId?: string;
  readonly sourceVersion: string;
  readonly schemaVersionToken: string;
  readonly geometryField?: string;
  readonly temporalField?: string;
  readonly fields: readonly WarehouseSourceFieldSchema[];
  readonly availability: WarehouseSourceAvailability;
  readonly policy: WarehouseSourcePolicyMetadata;
  readonly crs: WarehouseSourceCrsCapabilities;
  readonly limits: WarehouseSourceQueryLimits;
  readonly formats: readonly WarehouseOutputFormat[];
  readonly spatialPredicates: readonly WarehouseSpatialPredicate[];
  readonly capabilities: WarehouseSourceOperationFlags;
  readonly freshness?: SourceFreshnessContract;
  readonly diagnostics?: Readonly<Record<string, string | number | boolean>>;
}

export type WarehouseRequiredCapability =
  | keyof WarehouseSourceOperationFlags
  | WarehouseOutputFormat
  | "applyEdits"
  | `spatial:${WarehouseSpatialPredicate}`;

export interface WarehouseCapabilityCheckOptions {
  readonly now?: () => Date;
}

export interface WarehouseTransportQueryRequest<T = Record<string, unknown>> {
  readonly sourceId: string;
  readonly connectionId: string;
  readonly provider: GovernedWarehouseProvider;
  readonly relation?: WarehouseSourceRelation;
  readonly governedQueryId?: string;
  readonly policyScopeFingerprint: string;
  readonly query: Query<T>;
  readonly format?: WarehouseOutputFormat;
}

export interface WarehouseSourceTransport<T = Record<string, unknown>> {
  query(request: WarehouseTransportQueryRequest<T>): Promise<Result<T>>;
  queryAggregate?(
    request: WarehouseTransportQueryRequest<T> & { readonly aggregation: AggregationSpec },
  ): Promise<Result<T>>;
  queryExtent?(
    request: WarehouseTransportQueryRequest<T>,
  ): Promise<{ readonly extent: HonuaExtent | null; readonly count?: number }>;
  stream?(request: WarehouseTransportQueryRequest<T>): AsyncIterable<Result<T>>;
}

export interface GovernedWarehouseSource<T = Record<string, unknown>> extends CapabilityAwareSource<T> {
  readonly warehouseCapabilities: WarehouseEffectiveSourceCapabilities;
  supportsFormat(format: WarehouseOutputFormat): boolean;
  assertFormat(format: WarehouseOutputFormat): void;
  supportsSpatialPredicate(predicate: WarehouseSpatialPredicate): boolean;
  cacheKey(extra?: Readonly<Record<string, unknown>>): string;
}

const VALID_FORMATS = new Set<string>(["format.geoparquet", "format.geoarrow", "format.geojson", "format.mvt"]);
const VALID_AVAILABILITY = new Set<string>(["available", "degraded", "unavailable"]);
const VALID_GEOMETRY_MODELS = new Set<string>(["planar", "geodetic", "mixed"]);

function requirePositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new HonuaWarehouseError("invalid-descriptor", `${label} must be a positive safe integer.`, { label });
  }
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HonuaWarehouseError("invalid-descriptor", `${label} must be a valid ISO timestamp.`, { label });
  }
  return value;
}

function validateRelation(relation: unknown): WarehouseSourceRelation | undefined {
  if (relation === undefined) return undefined;
  if (!isPlainRecord(relation) || typeof relation.table !== "string" || relation.table.trim().length === 0) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse relation requires a non-empty table name.");
  }
  assertNoRawVendorSql(relation.table, "relation.table");
  return Object.freeze({
    ...(typeof relation.catalog === "string" && relation.catalog ? { catalog: relation.catalog } : {}),
    ...(typeof relation.schema === "string" && relation.schema ? { schema: relation.schema } : {}),
    table: relation.table,
  });
}

function validateAvailability(value: unknown): WarehouseSourceAvailability {
  if (!isPlainRecord(value) || !VALID_AVAILABILITY.has(String(value.status))) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse source availability status is invalid.");
  }
  const observedAt = requireIsoTimestamp(value.observedAt, "availability.observedAt");
  const expiresAt = requireIsoTimestamp(value.expiresAt, "availability.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new HonuaWarehouseError("invalid-descriptor", "availability.expiresAt must be after observedAt.");
  }
  return Object.freeze({
    status: value.status as WarehouseAvailabilityStatus,
    ...(typeof value.reason === "string" && value.reason ? { reason: value.reason } : {}),
    observedAt,
    expiresAt,
  });
}

function validatePolicy(value: unknown): WarehouseSourcePolicyMetadata {
  if (!isPlainRecord(value)) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse source policy metadata is required.");
  }
  const policyScopeFingerprint = assertOpaqueGovernedIdentifier(
    value.policyScopeFingerprint,
    "policy.policyScopeFingerprint",
  );
  if (
    typeof value.readOnly !== "boolean" ||
    typeof value.rowPolicyActive !== "boolean" ||
    typeof value.fieldMaskingActive !== "boolean"
  ) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse policy flags must be booleans.");
  }
  return Object.freeze({
    policyScopeFingerprint,
    ...(typeof value.tenantScope === "string" && value.tenantScope ? { tenantScope: value.tenantScope } : {}),
    readOnly: value.readOnly,
    rowPolicyActive: value.rowPolicyActive,
    fieldMaskingActive: value.fieldMaskingActive,
  });
}

function validateCrs(value: unknown): WarehouseSourceCrsCapabilities {
  if (
    !isPlainRecord(value) ||
    typeof value.storageCrs !== "string" ||
    value.storageCrs.trim().length === 0 ||
    typeof value.supportsReprojection !== "boolean" ||
    !VALID_GEOMETRY_MODELS.has(String(value.geometryModel))
  ) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse CRS capabilities are invalid.");
  }
  return Object.freeze({
    storageCrs: value.storageCrs,
    supportsReprojection: value.supportsReprojection,
    geometryModel: value.geometryModel as WarehouseSourceCrsCapabilities["geometryModel"],
  });
}

function validateFormats(value: unknown): readonly WarehouseOutputFormat[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !VALID_FORMATS.has(item))) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse formats must be valid format.* identifiers.");
  }
  return Object.freeze([...new Set(value as WarehouseOutputFormat[])]);
}

function validateFlags(value: unknown): WarehouseSourceOperationFlags {
  if (!isPlainRecord(value)) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse capability flags are required.");
  }
  const keys: (keyof WarehouseSourceOperationFlags)[] = [
    "query",
    "queryAggregate",
    "spatialAggregate",
    "h3Aggregation",
    "queryExtent",
    "stream",
    "temporalFilter",
    "widgets",
  ];
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      throw new HonuaWarehouseError("invalid-descriptor", `capabilities.${key} must be a boolean.`);
    }
  }
  return Object.freeze({
    query: value.query as boolean,
    queryAggregate: value.queryAggregate as boolean,
    spatialAggregate: value.spatialAggregate as boolean,
    h3Aggregation: value.h3Aggregation as boolean,
    queryExtent: value.queryExtent as boolean,
    stream: value.stream as boolean,
    temporalFilter: value.temporalFilter as boolean,
    widgets: value.widgets as boolean,
  });
}

/** Validate and freeze a credential-free effective warehouse source capability descriptor. */
export function validateWarehouseSourceCapabilities(input: unknown): WarehouseEffectiveSourceCapabilities {
  if (!isPlainRecord(input)) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse source capability descriptor must be an object.");
  }
  assertNoWarehouseSecrets(input);
  if ("sql" in input || "rawSql" in input) {
    throw new HonuaWarehouseError(
      "invalid-descriptor",
      "Warehouse source descriptors must use opaque governedQueryId instead of raw vendor SQL.",
    );
  }
  if (!isGovernedWarehouseProvider(input.provider)) {
    throw new HonuaCapabilityNotSupportedError(
      `provider.${String(input.provider ?? "unknown")}`,
      "warehouse",
      typeof input.sourceId === "string" ? input.sourceId : undefined,
      { context: { supportedProviders: GOVERNED_WAREHOUSE_PROVIDERS.join(",") } },
    );
  }
  const sourceId = assertOpaqueGovernedIdentifier(input.sourceId, "sourceId");
  const connectionId = assertOpaqueGovernedIdentifier(input.connectionId, "connectionId");
  const sourceVersion = assertOpaqueGovernedIdentifier(input.sourceVersion, "sourceVersion");
  const schemaVersionToken = assertOpaqueGovernedIdentifier(input.schemaVersionToken, "schemaVersionToken");
  const relation = validateRelation(input.relation);
  const governedQueryId =
    input.governedQueryId === undefined
      ? undefined
      : assertOpaqueGovernedIdentifier(input.governedQueryId, "governedQueryId");
  if (!relation && !governedQueryId) {
    throw new HonuaWarehouseError(
      "invalid-descriptor",
      "Warehouse source descriptor requires either relation.table or governedQueryId.",
    );
  }
  if (!Array.isArray(input.fields)) {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse source descriptor requires fields array.");
  }
  const limitsRaw = isPlainRecord(input.limits) ? input.limits : undefined;
  if (!limitsRaw || typeof limitsRaw.costHintAvailable !== "boolean") {
    throw new HonuaWarehouseError("invalid-descriptor", "Warehouse source limits with costHintAvailable are required.");
  }
  return Object.freeze({
    schemaVersion: WAREHOUSE_SOURCE_CAPABILITY_SCHEMA_VERSION,
    sourceId,
    connectionId,
    provider: input.provider,
    ...(relation ? { relation } : {}),
    ...(governedQueryId ? { governedQueryId } : {}),
    sourceVersion,
    schemaVersionToken,
    ...(typeof input.geometryField === "string" && input.geometryField ? { geometryField: input.geometryField } : {}),
    ...(typeof input.temporalField === "string" && input.temporalField ? { temporalField: input.temporalField } : {}),
    fields: Object.freeze(input.fields.map((field) => Object.freeze({ ...(field as WarehouseSourceFieldSchema) }))),
    availability: validateAvailability(input.availability),
    policy: validatePolicy(input.policy),
    crs: validateCrs(input.crs),
    limits: Object.freeze({
      maxScannedRows: requirePositiveInt(limitsRaw.maxScannedRows, "limits.maxScannedRows"),
      maxScannedBytes: requirePositiveInt(limitsRaw.maxScannedBytes, "limits.maxScannedBytes"),
      maxReturnedRows: requirePositiveInt(limitsRaw.maxReturnedRows, "limits.maxReturnedRows"),
      maxReturnedBytes: requirePositiveInt(limitsRaw.maxReturnedBytes, "limits.maxReturnedBytes"),
      deadlineMs: requirePositiveInt(limitsRaw.deadlineMs, "limits.deadlineMs"),
      costHintAvailable: limitsRaw.costHintAvailable,
    }),
    formats: validateFormats(input.formats),
    spatialPredicates: Object.freeze(
      Array.isArray(input.spatialPredicates) ? [...(input.spatialPredicates as WarehouseSpatialPredicate[])] : [],
    ),
    capabilities: validateFlags(input.capabilities),
    ...(isPlainRecord(input.freshness)
      ? { freshness: Object.freeze({ ...(input.freshness as unknown as SourceFreshnessContract) }) }
      : {}),
    ...(isPlainRecord(input.diagnostics)
      ? { diagnostics: Object.freeze({ ...(input.diagnostics as Record<string, string | number | boolean>) }) }
      : {}),
  });
}

export function isWarehouseAvailabilityCurrent(
  availability: WarehouseSourceAvailability,
  now: () => Date = () => new Date(),
): boolean {
  return availability.status !== "unavailable" && now().getTime() < Date.parse(availability.expiresAt);
}

/** Fail closed with HonuaCapabilityNotSupportedError when a capability, format, or availability check fails. */
export function assertWarehouseCapability(
  descriptor: WarehouseEffectiveSourceCapabilities,
  required: WarehouseRequiredCapability,
  options: WarehouseCapabilityCheckOptions = {},
): void {
  const protocol = `warehouse:${descriptor.provider}`;
  const now = options.now ?? (() => new Date());
  if (descriptor.availability.status === "unavailable") {
    throw new HonuaCapabilityNotSupportedError(required, protocol, descriptor.sourceId, {
      context: { reason: descriptor.availability.reason ?? "source-unavailable", status: "unavailable" },
    });
  }
  if (now().getTime() >= Date.parse(descriptor.availability.expiresAt)) {
    throw new HonuaCapabilityNotSupportedError(required, protocol, descriptor.sourceId, {
      context: { reason: "capability-evidence-expired", expiresAt: descriptor.availability.expiresAt },
    });
  }
  if (required === "applyEdits") {
    throw new HonuaCapabilityNotSupportedError("applyEdits", protocol, descriptor.sourceId, {
      context: { reason: "governed-warehouse-read-only", readOnly: descriptor.policy.readOnly },
    });
  }
  if (required.startsWith("format.")) {
    if (!descriptor.formats.includes(required as WarehouseOutputFormat)) {
      throw new HonuaCapabilityNotSupportedError(required, protocol, descriptor.sourceId, {
        context: { availableFormats: descriptor.formats.join(",") },
      });
    }
    return;
  }
  if (required.startsWith("spatial:")) {
    const predicate = required.slice("spatial:".length) as WarehouseSpatialPredicate;
    if (!descriptor.spatialPredicates.includes(predicate)) {
      throw new HonuaCapabilityNotSupportedError(required, protocol, descriptor.sourceId, {
        context: { predicate },
      });
    }
    return;
  }
  const flag = descriptor.capabilities[required as keyof WarehouseSourceOperationFlags];
  if (flag !== true) {
    throw new HonuaCapabilityNotSupportedError(required, protocol, descriptor.sourceId, {
      context: { provider: descriptor.provider },
    });
  }
}

/** Deterministic, authorization-scoped cache identity for a governed warehouse source. */
export function buildWarehouseSourceCacheKey(
  descriptor: WarehouseEffectiveSourceCapabilities,
  extra?: Readonly<Record<string, unknown>>,
): string {
  if (extra) assertNoWarehouseSecrets(extra, "cache.extra");
  return `honua-warehouse:${stableWarehouseJson({
    v: 1,
    sourceId: descriptor.sourceId,
    connectionId: descriptor.connectionId,
    provider: descriptor.provider,
    relation: descriptor.relation,
    governedQueryId: descriptor.governedQueryId,
    sourceVersion: descriptor.sourceVersion,
    schemaVersionToken: descriptor.schemaVersionToken,
    policyScopeFingerprint: descriptor.policy.policyScopeFingerprint,
    freshness: descriptor.freshness,
    extra,
  })}`;
}

function deriveContractCapabilities(descriptor: WarehouseEffectiveSourceCapabilities): Capabilities {
  const active: Capability[] = [];
  if (descriptor.capabilities.query) active.push("query");
  if (descriptor.capabilities.queryAggregate) active.push("queryAggregate");
  if (descriptor.capabilities.spatialAggregate) active.push("spatialAggregate");
  if (descriptor.capabilities.queryExtent) active.push("queryExtent");
  if (descriptor.capabilities.stream) active.push("stream");
  return capabilities(active);
}

function unsupportedMethod(descriptor: WarehouseEffectiveSourceCapabilities, capability: string): () => Promise<never> {
  return async () => {
    throw new HonuaCapabilityNotSupportedError(capability, `warehouse:${descriptor.provider}`, descriptor.sourceId);
  };
}

function baseTransportRequest<T>(
  descriptor: WarehouseEffectiveSourceCapabilities,
  query: Query<T> | undefined,
): WarehouseTransportQueryRequest<T> {
  return {
    sourceId: descriptor.sourceId,
    connectionId: descriptor.connectionId,
    provider: descriptor.provider,
    ...(descriptor.relation ? { relation: descriptor.relation } : {}),
    ...(descriptor.governedQueryId ? { governedQueryId: descriptor.governedQueryId } : {}),
    policyScopeFingerprint: descriptor.policy.policyScopeFingerprint,
    query: query ?? {},
  };
}

/** Project a server-discovered governed warehouse source into the protocol-neutral SDK Source contract. */
export function createGovernedWarehouseSource<T = Record<string, unknown>>(
  rawCapabilities: WarehouseEffectiveSourceCapabilities,
  transport: WarehouseSourceTransport<T>,
  options: WarehouseCapabilityCheckOptions = {},
): GovernedWarehouseSource<T> {
  const effective = validateWarehouseSourceCapabilities(rawCapabilities);
  const capSet = deriveContractCapabilities(effective);
  const descriptor: SourceDescriptor = Object.freeze({
    id: effective.sourceId,
    protocol: "geoparquet",
    locator: Object.freeze({
      url: `honua-warehouse://${effective.provider}/${effective.connectionId}/${effective.sourceId}`,
    }),
    capabilities: capSet,
  });

  const requireCap = (cap: WarehouseRequiredCapability) => assertWarehouseCapability(effective, cap, options);
  const enforceQueryPredicates = (query: Query<T> | undefined) => {
    if (query?.temporalFilter) requireCap("temporalFilter");
    if (query?.spatialFilter) requireCap("spatial:bbox-intersects");
  };

  return Object.freeze({
    descriptor,
    capabilities: capSet,
    warehouseCapabilities: effective,
    supports: (capability: Capability) => capSet.has(capability),
    supportsFormat: (format: WarehouseOutputFormat) => effective.formats.includes(format),
    assertFormat: (format: WarehouseOutputFormat) => requireCap(format),
    supportsSpatialPredicate: (predicate: WarehouseSpatialPredicate) => effective.spatialPredicates.includes(predicate),
    cacheKey: (extra?: Readonly<Record<string, unknown>>) => buildWarehouseSourceCacheKey(effective, extra),
    async query(query?: Query<T>) {
      requireCap("query");
      enforceQueryPredicates(query);
      return transport.query(baseTransportRequest(effective, query));
    },
    async queryAll(query?: Query<T>) {
      requireCap("query");
      enforceQueryPredicates(query);
      return transport.query(baseTransportRequest(effective, query));
    },
    async queryAggregate(query: Query<T> & { readonly aggregation: AggregationSpec }) {
      requireCap("queryAggregate");
      enforceQueryPredicates(query);
      if (!transport.queryAggregate) {
        throw new HonuaCapabilityNotSupportedError(
          "queryAggregate",
          `warehouse:${effective.provider}`,
          effective.sourceId,
        );
      }
      return transport.queryAggregate({ ...baseTransportRequest(effective, query), aggregation: query.aggregation });
    },
    async queryExtent(query?: Query<T>) {
      requireCap("queryExtent");
      enforceQueryPredicates(query);
      if (!transport.queryExtent) {
        throw new HonuaCapabilityNotSupportedError(
          "queryExtent",
          `warehouse:${effective.provider}`,
          effective.sourceId,
        );
      }
      return transport.queryExtent(baseTransportRequest(effective, query));
    },
    async *stream(query?: Query<T>) {
      requireCap("stream");
      enforceQueryPredicates(query);
      if (!transport.stream) {
        throw new HonuaCapabilityNotSupportedError("stream", `warehouse:${effective.provider}`, effective.sourceId);
      }
      yield* transport.stream(baseTransportRequest(effective, query));
    },
    queryObjectIds: unsupportedMethod(effective, "queryObjectIds"),
    applyEdits: unsupportedMethod(effective, "applyEdits"),
    queryRelated: unsupportedMethod(effective, "queryRelated"),
    attachments: Object.freeze({
      query: unsupportedMethod(effective, "attachments"),
      list: unsupportedMethod(effective, "attachments"),
      add: unsupportedMethod(effective, "attachments"),
      update: unsupportedMethod(effective, "attachments"),
      delete: unsupportedMethod(effective, "attachments"),
    }),
    protocol: () => undefined,
    adapter: () => undefined,
  }) as unknown as GovernedWarehouseSource<T>;
}
