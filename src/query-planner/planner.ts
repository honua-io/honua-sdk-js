import {
  type AggregationSpec,
  CAPABILITIES,
  type Capability,
  type SourceDescriptor,
  capabilities,
} from "../contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import {
  createCacheDecision,
  createPlanValidity,
  createPlanWarnings,
  createQueryPlanProvenance,
  createStepDiagnostics,
  summarizeFidelity,
  summarizePlanBounds,
} from "./diagnostics.js";
import { compileDuckDbQuery, compileDuckDbQueryV2 } from "./duckdb.js";
import { compileGeoServicesQuery } from "./geoservices.js";
import { compileGrpcQuery } from "./grpc.js";
import { createGeoParquetQueryIr, createQueryIr, deepFreeze, queryFromCanonical } from "./ir.js";
import { compileOdataQuery } from "./odata.js";
import { compileOgcApiFeaturesQuery } from "./ogc-features.js";
import { type GeoParquetResourceHandleV1, parseGeoParquetResourceHandle } from "./resource.js";
import {
  type CanonicalQuery,
  type DuckDbCompiledQueryV2,
  type ExplainGeoParquetQueryOptions,
  type ExplainQueryOptions,
  type GeoParquetRemoteQueryPlanStepV2,
  HonuaQueryPlanExecutionError,
  HonuaQueryPlanningError,
  type LocalAggregatePlanStep,
  MAX_LOCAL_MATERIALIZATION_ROWS,
  QUERY_PLAN_DIAGNOSTICS_VERSION,
  QUERY_PLAN_KIND,
  QUERY_PLAN_V2_VERSION,
  QUERY_PLAN_VERSION,
  type QueryExecutionPlan,
  type QueryExecutionPlanV1,
  type QueryExecutionPlanV2,
  type QueryFallbackPolicy,
  type QueryIrSourceIdentity,
  type QueryIrSourceIdentityV2,
  type RemoteCompiledQueryV1,
  type RemoteQueryPlanStep,
} from "./types.js";
import { compileWfsQuery } from "./wfs.js";

export function explainQuery<T>(options: ExplainGeoParquetQueryOptions<T>): QueryExecutionPlanV2;
export function explainQuery<T>(options: ExplainQueryOptions<T>): QueryExecutionPlanV1;
export function explainQuery<T>(
  options: ExplainQueryOptions<T> | ExplainGeoParquetQueryOptions<T>,
): QueryExecutionPlan {
  const resource = ownGeoParquetResource(options);
  if (!resource && options.descriptor.protocol === "geoparquet")
    assertCredentialFreeLegacyDescriptor(options.descriptor);
  const ir = resource ? createGeoParquetQueryIr({ ...options, geoparquetResource: resource }) : createQueryIr(options);
  const capabilityPolicy = options.capabilityPolicy ?? "strict";
  const fallback = normalizeFallback(options.fallback);
  const estimates = normalizeEstimates(options.estimates);
  const executionMode = normalizeExecutionMode(options.executionMode);
  let baseSteps: readonly VersionedQueryPlanStepBase[];
  let pushdown: QueryExecutionPlan["pushdown"];

  if (ir.query.aggregation && !ir.source.capabilities.includes("queryAggregate")) {
    if (capabilityPolicy !== "degraded" || fallback.mode === "disabled") {
      throw new HonuaQueryPlanningError(
        capabilityPolicy === "degraded" ? "fallback-disabled" : "capability-not-supported",
        `Source "${ir.source.id}" does not support queryAggregate; select degraded policy with an explicit bounded-local fallback to proceed`,
      );
    }
    if (!ir.source.capabilities.includes("query")) {
      throw new HonuaQueryPlanningError(
        "capability-not-supported",
        `Source "${ir.source.id}" cannot run the bounded fallback because it does not support query`,
      );
    }
    rejectUnsafeEstimate(fallback, estimates.rows, estimates.bytes);
    const ogcFallback = ir.source.protocol === "ogc-features";
    const inputQuery = localAggregateInputQuery(
      ir.query,
      ir.query.aggregation,
      fallback.maxRows,
      options.descriptor.schema?.primaryKey,
      { preserveGeometry: ogcFallback, adapterOwnsLookahead: ogcFallback },
    );
    baseSteps = [
      {
        id: "remote-input",
        engine: "remote",
        operation: "queryAll",
        pushdown: "partial",
        reason: `Push filters and projection to ${remoteEngineName(ir.source.protocol)}, fetching at most ${fallback.maxRows + 1} rows as an overflow sentinel.`,
        requests: estimates.requests ?? 1,
        query: inputQuery,
        compiled: compileRemoteQuery(ir.source, inputQuery, "queryAll"),
      },
      {
        id: "local-aggregate",
        engine: "client",
        operation: "aggregate",
        pushdown: "none",
        reason: `queryAggregate is unavailable; compute only after enforcing the ${fallback.maxRows}-row local ceiling.`,
        inputStepId: "remote-input",
        aggregation: ir.query.aggregation,
        maxRows: fallback.maxRows,
        ...(fallback.maxBytes !== undefined ? { maxBytes: fallback.maxBytes } : {}),
      },
    ];
    pushdown = "partial";
  } else {
    const capability = ir.query.aggregation ? "queryAggregate" : "query";
    if (!ir.source.capabilities.includes(capability)) {
      throw new HonuaQueryPlanningError(
        "capability-not-supported",
        `Source "${ir.source.id}" does not support ${capability}`,
      );
    }
    if (estimates.requests !== undefined && estimates.requests !== 1) {
      throw new HonuaQueryPlanningError(
        "invalid-query",
        `estimates.requests must be 1 for the exact single-request ${capability} operation`,
      );
    }
    const spatialAggregation = ir.query.aggregation !== undefined && ir.query.spatialFilter !== undefined;
    baseSteps = [
      {
        id: "remote-query",
        engine: "remote",
        operation: ir.query.aggregation ? "queryAggregate" : "query",
        pushdown: "full",
        reason: spatialAggregation
          ? `${remoteEngineName(ir.source.protocol)} executes the spatial aggregation server-side: the spatial filter constrains the grouped statistics without materializing features.`
          : `${remoteEngineName(ir.source.protocol)} can execute the complete canonical query remotely.`,
        requests: 1,
        query: ir.query,
        compiled: compileRemoteQuery(ir.source, ir.query),
      },
    ];
    pushdown = "full";
  }

  const provenance = createQueryPlanProvenance(options.descriptor, ir.source, options);
  const steps = baseSteps.map((step) => ({ ...step, ...createStepDiagnostics(step, estimates, provenance) }));
  const { fidelity, losses } = summarizeFidelity(steps);
  const bounds = summarizePlanBounds(steps);
  const cache = createCacheDecision(options.cache);
  const validity = createPlanValidity(ir, provenance, capabilityPolicy, fallback, executionMode);
  const warnings = createPlanWarnings(baseSteps, ir.source);

  const unsigned = {
    kind: QUERY_PLAN_KIND,
    version: ir.version === "2.0" ? QUERY_PLAN_V2_VERSION : QUERY_PLAN_VERSION,
    ir,
    capabilityPolicy,
    fallback,
    pushdown,
    diagnosticsVersion: QUERY_PLAN_DIAGNOSTICS_VERSION,
    fidelity,
    losses,
    bounds,
    cache,
    provenance,
    validity,
    estimates,
    steps,
    warnings,
  };
  const fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
  return deepFreeze({
    ...unsigned,
    id: `plan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
    fingerprint,
  }) as QueryExecutionPlan;
}

function compileRemoteQuery(
  source: QueryIrSourceIdentity | QueryIrSourceIdentityV2,
  query: CanonicalQuery,
  operation: "query" | "queryAll" | "queryAggregate" = "query",
): RemoteCompiledQueryV1 | DuckDbCompiledQueryV2 {
  switch (source.protocol) {
    case "geoservices-feature-service":
      return compileGeoServicesQuery(source, query);
    case "ogc-features":
      return ogcQueryAllWireRequest(compileOgcApiFeaturesQuery(source, query), operation);
    case "wfs":
      return compileWfsQuery(source, query);
    case "odata":
      return compileOdataQuery(source, query);
    case "geoparquet":
      return isGeoParquetV2Source(source)
        ? compileDuckDbQueryV2(source, query)
        : compileDuckDbQuery(source as QueryIrSourceIdentity, query);
    case "grpc":
      return compileGrpcQuery(source, query);
    default:
      throw new HonuaQueryPlanningError(
        "unsupported-compiler",
        `No deterministic query compiler is registered for protocol "${source.protocol}"`,
      );
  }
}

type VersionedRemoteQueryPlanStepBase = Omit<
  RemoteQueryPlanStep,
  "compiled" | "fidelity" | "losses" | "bounds" | "provenance"
> & {
  readonly compiled: RemoteCompiledQueryV1 | DuckDbCompiledQueryV2;
};
type LocalAggregatePlanStepBase = Omit<LocalAggregatePlanStep, "fidelity" | "losses" | "bounds" | "provenance">;
type VersionedQueryPlanStepBase = VersionedRemoteQueryPlanStepBase | LocalAggregatePlanStepBase;

function isGeoParquetV2Source(
  source: QueryIrSourceIdentity | QueryIrSourceIdentityV2,
): source is QueryIrSourceIdentityV2 {
  return source.protocol === "geoparquet" && source.geoparquet !== undefined && "resource" in source.geoparquet;
}

function ogcQueryAllWireRequest(
  compiled: Extract<RemoteCompiledQueryV1, { compiler: "ogc-api-features-query-v1" }>,
  operation: "query" | "queryAll" | "queryAggregate",
): RemoteCompiledQueryV1 {
  if (operation !== "queryAll" || compiled.limit === undefined) return compiled;
  return deepFreeze({ ...compiled, limit: compiled.limit + 1 });
}

function remoteEngineName(protocol: QueryIrSourceIdentity["protocol"]): string {
  switch (protocol) {
    case "ogc-features":
      return "OGC API Features";
    case "geoservices-feature-service":
      return "GeoServices";
    case "wfs":
      return "WFS 2.0";
    case "odata":
      return "OData v4";
    case "geoparquet":
      return "DuckDB SQL (columnar)";
    case "grpc":
      return "Honua gRPC FeatureService";
    default:
      return protocol;
  }
}

export function hashQueryPlan(plan: QueryExecutionPlan): `sha256:${string}` {
  return persistedPlanSnapshot(plan).hash;
}

/** @internal Lightweight v1 integrity path for stable consumers that cannot execute v2 resources. */
export function hashQueryPlanV1(plan: QueryExecutionPlanV1): `sha256:${string}` | undefined {
  try {
    const detached = toJsonValue(plan) as unknown;
    if (!isPlanEnvelope(detached) || detached.version !== QUERY_PLAN_VERSION || detached.ir.version !== "1.0") {
      return undefined;
    }
    if (detached.ir.source.protocol === "geoparquet") {
      const sources = detached.ir.source.geoparquet?.sources;
      if (!sources || sources.length === 0 || sources.some((source) => !isCredentialFreeLegacySource(source))) {
        return undefined;
      }
    }
    if (containsCredentialBearingPlanMaterial(detached)) return undefined;
    const { id: _id, fingerprint: _fingerprint, ...unsigned } = detached;
    return sha256(canonicalStringify(toJsonValue(unsigned)));
  } catch {
    return undefined;
  }
}

/** Internal executor boundary: validate once and continue with an immutable detached snapshot. */
export function validateQueryPlanSnapshot(plan: QueryExecutionPlan): QueryExecutionPlan {
  const snapshot = persistedPlanSnapshot(plan);
  if (snapshot.hash !== snapshot.plan.fingerprint) throw invalidPersistedPlan();
  return snapshot.plan;
}

/** Canonical persistence boundary for accepted v1/v2 query plans. */
export function serializeQueryPlan(plan: QueryExecutionPlan): string {
  const snapshot = persistedPlanSnapshot(plan);
  if (snapshot.hash !== snapshot.plan.fingerprint) throw invalidPersistedPlan();
  return canonicalStringify(toJsonValue(snapshot.plan));
}

/** Parse a persisted plan without retaining invalid JSON or credential-bearing v1 locators. */
export function parseQueryPlan(serialized: string): QueryExecutionPlan {
  if (typeof serialized !== "string") throw invalidPersistedPlan();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalidPersistedPlan();
  }
  const snapshot = persistedPlanSnapshot(value);
  if (snapshot.hash !== snapshot.plan.fingerprint) throw invalidPersistedPlan();
  return snapshot.plan;
}

/** Stable cache identity derived only after the plan passes the persistence guard. */
export function queryPlanCacheKey(plan: QueryExecutionPlan): string {
  const snapshot = persistedPlanSnapshot(plan);
  if (snapshot.hash !== snapshot.plan.fingerprint) throw invalidPersistedPlan();
  return `honua-query-plan:${snapshot.plan.version}:${snapshot.plan.fingerprint}`;
}

/** Explicitly migrate a credential-free v1 GeoParquet plan to opaque v2 identity. */
export function migrateGeoParquetQueryPlanV1(
  legacyPlan: QueryExecutionPlanV1,
  resourceValue: unknown,
): QueryExecutionPlanV2 {
  const parsed = parseQueryPlan(serializeQueryPlan(legacyPlan));
  if (parsed.version !== QUERY_PLAN_VERSION || parsed.ir.source.protocol !== "geoparquet") {
    throw invalidPersistedPlan();
  }
  const resource = parseGeoParquetResourceHandle(resourceValue);
  const legacyGeoParquet = parsed.ir.source.geoparquet;
  if (!legacyGeoParquet) throw invalidPersistedPlan();
  const descriptor: SourceDescriptor = {
    id: resource.resource.id,
    protocol: "geoparquet",
    locator: {
      url: "honua-resource://opaque",
      geoparquet: {
        ...(legacyGeoParquet.geometryColumn ? { geometryColumn: legacyGeoParquet.geometryColumn } : {}),
        ...(legacyGeoParquet.geometryEncoding ? { geometryEncoding: legacyGeoParquet.geometryEncoding } : {}),
        ...(legacyGeoParquet.bboxColumn ? { bboxColumn: legacyGeoParquet.bboxColumn } : {}),
      },
    },
    capabilities: capabilities(parsed.ir.source.capabilities),
  };
  return explainQuery({
    descriptor,
    query: queryFromCanonical(parsed.ir.query),
    geoparquetResource: resource,
    capabilityPolicy: parsed.capabilityPolicy,
    fallback: parsed.fallback,
    ...(parsed.ir.source.schemaVersion !== undefined ? { schemaVersion: parsed.ir.source.schemaVersion } : {}),
    ...(parsed.ir.source.sourceVersion !== undefined ? { sourceVersion: parsed.ir.source.sourceVersion } : {}),
    authorizationScope: parsed.ir.source.authorizationScope,
    estimates: parsed.estimates,
  });
}

function ownGeoParquetResource<T>(
  options: ExplainQueryOptions<T> | ExplainGeoParquetQueryOptions<T>,
): GeoParquetResourceHandleV1 | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(options, "geoparquetResource");
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", "GeoParquet resource handle is invalid");
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new HonuaQueryPlanningError("invalid-query", "GeoParquet resource handle is invalid");
  }
  try {
    return parseGeoParquetResourceHandle(descriptor.value);
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", "GeoParquet resource handle is invalid");
  }
}

function assertCredentialFreeLegacyDescriptor(descriptor: SourceDescriptor): void {
  const sources = [descriptor.locator.url, ...(descriptor.locator.geoparquet?.urls ?? [])];
  if (sources.length === 0 || sources.some((source) => !isCredentialFreeLegacySource(source))) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      "Credential-bearing GeoParquet locators require an opaque resource handle",
    );
  }
}

function assertPlanPersistenceSafe(plan: QueryExecutionPlan): void {
  if (plan.version === QUERY_PLAN_VERSION) {
    if (plan.ir.version !== "1.0") throw invalidPersistedPlan();
    if (plan.ir.source.protocol === "geoparquet") {
      const sources = plan.ir.source.geoparquet?.sources;
      if (!sources || sources.length === 0 || sources.some((source) => !isCredentialFreeLegacySource(source))) {
        throw invalidPersistedPlan();
      }
      for (const step of plan.steps) {
        if (step.engine !== "remote") continue;
        if (step.compiled.compiler !== "duckdb-sql-v1") throw invalidPersistedPlan();
        const expected = compileDuckDbQuery(plan.ir.source, step.query);
        if (canonicalStringify(toJsonValue(step.compiled)) !== canonicalStringify(toJsonValue(expected))) {
          throw invalidPersistedPlan();
        }
      }
    }
    return;
  }
  if (
    plan.version !== QUERY_PLAN_V2_VERSION ||
    plan.ir.version !== "2.0" ||
    plan.ir.source.protocol !== "geoparquet" ||
    plan.ir.source.endpoint !== "[opaque-resource]"
  ) {
    throw invalidPersistedPlan();
  }
  const expected = rebuildGeoParquetQueryPlanV2(plan);
  if (canonicalStringify(toJsonValue(plan)) !== canonicalStringify(toJsonValue(expected))) throw invalidPersistedPlan();
}

/**
 * Rebuild a v2 plan through the pure planner so persistence accepts only one
 * complete canonical projection. This performs no resolution or network I/O.
 */
function rebuildGeoParquetQueryPlanV2(plan: QueryExecutionPlanV2): QueryExecutionPlanV2 {
  const source = plan.ir.source;
  const resource = parseGeoParquetResourceHandle(source.geoparquet.resource);
  const sourceCapabilities = parsePlanCapabilities(source.capabilities);
  const primaryKey = parseOptionalPlanMetadata(source.primaryKey);
  const schemaVersion = parseOptionalPlanMetadata(source.schemaVersion);
  const sourceVersion = parseOptionalPlanMetadata(source.sourceVersion);
  const geometryColumn = parseOptionalPlanMetadata(source.geoparquet.geometryColumn);
  const bboxColumn = parseOptionalPlanMetadata(source.geoparquet.bboxColumn);
  const geometryEncoding = source.geoparquet.geometryEncoding;
  if (
    geometryEncoding !== undefined &&
    geometryEncoding !== "wkb" &&
    geometryEncoding !== "native" &&
    geometryEncoding !== "geojson"
  ) {
    throw invalidPersistedPlan();
  }
  if (plan.capabilityPolicy !== "strict" && plan.capabilityPolicy !== "degraded") throw invalidPersistedPlan();

  const descriptor: SourceDescriptor = {
    id: resource.resource.id,
    protocol: "geoparquet",
    locator: {
      url: "honua-resource://opaque",
      geoparquet: {
        ...(geometryColumn ? { geometryColumn } : {}),
        ...(geometryEncoding ? { geometryEncoding } : {}),
        ...(bboxColumn ? { bboxColumn } : {}),
      },
    },
    capabilities: capabilities(sourceCapabilities),
    ...(primaryKey ? { schema: { primaryKey } } : {}),
    ...(plan.provenance.schema.state === "known" && plan.provenance.schema.basis === "schema-v2"
      ? {
          schemaV2: {
            kind: "honua.source-schema",
            version: "2.0",
            fingerprint: plan.provenance.schema.fingerprint,
          },
        }
      : {}),
  };
  return explainQuery({
    descriptor,
    geoparquetResource: resource,
    query: queryFromCanonical(plan.ir.query),
    capabilityPolicy: plan.capabilityPolicy,
    fallback: plan.fallback,
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    authorizationScope: source.authorizationScope,
    estimates: plan.estimates,
    cache: persistedCacheOptions(plan.cache),
    discovery: persistedDiscoveryContext(plan.provenance.discovery),
    executionMode: plan.validity.executionMode,
  });
}

function persistedCacheOptions(cache: QueryExecutionPlan["cache"]): NonNullable<ExplainQueryOptions["cache"]> {
  return {
    policy: cache.policy,
    freshness: cache.freshness,
    ...(cache.validator ? { validator: { kind: cache.validator.kind, fingerprint: cache.validator.fingerprint } } : {}),
  };
}

function persistedDiscoveryContext(
  discovery: QueryExecutionPlan["provenance"]["discovery"],
): NonNullable<ExplainQueryOptions["discovery"]> {
  return {
    state: discovery.state,
    ...(discovery.sourceFingerprint ? { sourceFingerprint: discovery.sourceFingerprint } : {}),
    ...(discovery.validator
      ? { validator: { kind: discovery.validator.kind, fingerprint: discovery.validator.fingerprint } }
      : {}),
  };
}

function parsePlanCapabilities(value: unknown): readonly Capability[] {
  if (
    !Array.isArray(value) ||
    value.some((capability) => typeof capability !== "string" || !CAPABILITIES.includes(capability as Capability))
  ) {
    throw invalidPersistedPlan();
  }
  return value as Capability[];
}

function parseOptionalPlanMetadata(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || containsControlCharacter(value)) {
    throw invalidPersistedPlan();
  }
  return value;
}

interface PersistedPlanSnapshot {
  readonly plan: QueryExecutionPlan;
  readonly hash: `sha256:${string}`;
}

const CREDENTIAL_BEARING_PLAN_TEXT =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bBasic\s+[A-Za-z0-9+/=]{8,}|\bAKIA[0-9A-Z]{16}\b|[?&;](?:access[-_]?token|id[-_]?token|refresh[-_]?token|x-amz-signature|x-goog-credential|signature|sig|token|api[-_]?key|password|secret)=[^\s&#;]*|\b(?:authorization|proxy[-_]?authorization|x-api-key|password|secret|token|api[-_]?key|account[-_]?key|shared[-_]?access[-_]?signature)\s*(?:=|:)\s*[^\s,;]+|[a-z][a-z0-9+.-]*:\/\/[^/\s"'<>]*@|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;

const CREDENTIAL_BEARING_PLAN_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "username",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "xapikey",
  "accesskey",
  "secretkey",
  "clientsecret",
  "credential",
  "credentials",
  "signature",
  "xamzsignature",
  "xgoogcredential",
  "accountkey",
  "sharedaccesssignature",
]);

/** Detach once so hostile accessors/proxies cannot change between validation and hashing. */
function persistedPlanSnapshot(value: unknown): PersistedPlanSnapshot {
  try {
    const plan = deepFreeze(toJsonValue(value)) as unknown;
    if (!isPlanEnvelope(plan)) throw invalidPersistedPlan();
    assertPlanPersistenceSafe(plan);
    if (containsCredentialBearingPlanMaterial(plan)) throw invalidPersistedPlan();
    const { id: _id, fingerprint: _fingerprint, ...unsigned } = plan;
    return { plan, hash: sha256(canonicalStringify(toJsonValue(unsigned))) };
  } catch {
    throw invalidPersistedPlan();
  }
}

function containsCredentialBearingPlanMaterial(value: unknown, path: readonly string[] = []): boolean {
  if (typeof value === "string") return CREDENTIAL_BEARING_PLAN_TEXT.test(value);
  if (Array.isArray(value)) {
    return value.some((child, index) => containsCredentialBearingPlanMaterial(child, [...path, String(index)]));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const parent = path
      .at(-1)
      ?.replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase();
    const sensitiveHeader =
      parent === "headers" &&
      (normalizedKey === "xauth" ||
        normalizedKey === "xauthtoken" ||
        normalizedKey === "xaccesskey" ||
        normalizedKey === "xsessiontoken");
    const sensitiveLocator = parent === "locator" && (normalizedKey === "user" || normalizedKey === "userinfo");
    const sensitiveQueryParameter =
      parent === "query" && (normalizedKey === "auth" || normalizedKey === "key" || normalizedKey === "session");
    return (
      CREDENTIAL_BEARING_PLAN_KEYS.has(normalizedKey) ||
      sensitiveHeader ||
      sensitiveLocator ||
      sensitiveQueryParameter ||
      containsCredentialBearingPlanMaterial(child, [...path, key])
    );
  });
}

function isCredentialFreeLegacySource(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || containsControlCharacter(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return !value.includes("?") && !value.includes("#") && !value.includes("@");
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPlanEnvelope(value: unknown): value is QueryExecutionPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<QueryExecutionPlan>;
  return (
    plan.kind === QUERY_PLAN_KIND &&
    (plan.version === QUERY_PLAN_VERSION || plan.version === QUERY_PLAN_V2_VERSION) &&
    plan.diagnosticsVersion === QUERY_PLAN_DIAGNOSTICS_VERSION &&
    typeof plan.id === "string" &&
    typeof plan.fingerprint === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(plan.fingerprint) &&
    plan.ir !== null &&
    typeof plan.ir === "object" &&
    Array.isArray(plan.steps) &&
    Array.isArray(plan.warnings)
  );
}

function normalizeExecutionMode(value: ExplainQueryOptions["executionMode"]): "snapshot" | "delta" {
  if (value === undefined) return "snapshot";
  if (value !== "snapshot" && value !== "delta") {
    throw new HonuaQueryPlanningError("invalid-query", "executionMode is invalid");
  }
  return value;
}

function invalidPersistedPlan(): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError("invalid-plan", "Query plan is invalid or unsafe to persist");
}

function normalizeFallback(fallback?: QueryFallbackPolicy): QueryFallbackPolicy {
  if (!fallback || fallback.mode === "disabled") return deepFreeze({ mode: "disabled" });
  if (!Number.isSafeInteger(fallback.maxRows) || fallback.maxRows < 1) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      "bounded-local maxRows must be a positive safe integer",
    );
  }
  if (fallback.maxRows > MAX_LOCAL_MATERIALIZATION_ROWS) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      `bounded-local maxRows ${fallback.maxRows} exceeds the SDK safety ceiling ${MAX_LOCAL_MATERIALIZATION_ROWS}`,
    );
  }
  if (fallback.maxBytes !== undefined && (!Number.isSafeInteger(fallback.maxBytes) || fallback.maxBytes < 1)) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      "bounded-local maxBytes must be a positive safe integer",
    );
  }
  return deepFreeze({
    mode: "bounded-local",
    maxRows: fallback.maxRows,
    ...(fallback.maxBytes !== undefined ? { maxBytes: fallback.maxBytes } : {}),
  });
}

function normalizeEstimates(estimates?: ExplainQueryOptions["estimates"]): QueryExecutionPlanV1["estimates"] {
  const out: { rows?: number; bytes?: number; requests?: number } = {};
  for (const key of ["rows", "bytes", "requests"] as const) {
    const value = estimates?.[key];
    if (value === undefined) continue;
    if (key === "requests" && (!Number.isSafeInteger(value) || value < 1)) {
      throw new HonuaQueryPlanningError("invalid-query", "estimates.requests must be a safe integer >= 1");
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new HonuaQueryPlanningError("invalid-query", `estimates.${key} must be a finite non-negative number`);
    }
    out[key] = value;
  }
  return deepFreeze(out);
}

function rejectUnsafeEstimate(
  fallback: Extract<QueryFallbackPolicy, { mode: "bounded-local" }>,
  rows?: number,
  bytes?: number,
): void {
  if (rows !== undefined && rows > fallback.maxRows) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      `Estimated input ${rows} rows exceeds bounded-local maxRows ${fallback.maxRows}`,
    );
  }
  if (fallback.maxBytes !== undefined && bytes !== undefined && bytes > fallback.maxBytes) {
    throw new HonuaQueryPlanningError(
      "unsafe-materialization",
      `Estimated input ${bytes} bytes exceeds bounded-local maxBytes ${fallback.maxBytes}`,
    );
  }
}

function localAggregateInputQuery(
  query: CanonicalQuery,
  aggregation: AggregationSpec,
  maxRows: number,
  primaryKey?: string,
  options: { preserveGeometry?: boolean; adapterOwnsLookahead?: boolean } = {},
): CanonicalQuery {
  if (aggregation.histogram || aggregation.timeSeries) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "The first bounded-local compiler supports metrics and groupBy; histogram/timeSeries remain follow-on work",
    );
  }
  const requiredFields = new Set<string>(aggregation.groupBy ?? []);
  for (const metric of aggregation.metrics) {
    if (metric.field !== "*") requiredFields.add(metric.field);
  }
  if (requiredFields.size === 0 && primaryKey) requiredFields.add(primaryKey);
  const {
    aggregation: _aggregation,
    orderBy: _orderBy,
    pagination: _pagination,
    outFields: _outFields,
    ...base
  } = query;
  return deepFreeze({
    ...base,
    ...(requiredFields.size > 0 ? { outFields: [...requiredFields].sort() } : {}),
    ...(!options.preserveGeometry ? { returnGeometry: false } : {}),
    // The OGC Source.queryAll adapter owns the overflow sentinel: a logical
    // N-row ceiling becomes an N + 1 wire request and is reported through
    // exceededTransferLimit. GeoServices retains its established explicit
    // sentinel in the canonical step for backward-compatible plan output.
    pagination: { offset: 0, limit: maxRows + (options.adapterOwnsLookahead ? 0 : 1) },
  });
}
