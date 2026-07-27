/**
 * First-party OData v4 protocol module.
 *
 * The module owns the same typed `HonuaOdataEntitySet` escape hatch exposed by
 * `Source.protocol("odata")`, the deterministic planner compiler hook, and
 * canonical query/queryAll wire execution. Runtime authority is the
 * `HonuaClient` explicitly injected into {@link odataProtocolModule}; compiled
 * artifacts carry no origin or credentials and cannot redirect a discovered
 * handle to another entity set.
 *
 * @module
 */
import type {
  ProtocolModuleHandle,
  ProtocolModuleQueryBinding,
  ProtocolModuleQueryExecuteInput,
  ProtocolModuleQueryOperation,
  QueryCapableProtocolModule,
} from "../contract/protocol-module.js";
import type { Capabilities, Protocol, Result, SourceDescriptor } from "../contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../contract/types.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import { HonuaOdataEntitySet, type HonuaOdataPage, type HonuaOdataQueryParams } from "../core/odata.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import type { HonuaFieldInfo, HonuaTypedFeature } from "../core/types.js";
import { bindOdataProtocolQueryOperation, odataProtocolQueryCompiler } from "./odata-v1.js";
import type {
  CanonicalQuery,
  OdataCompiledQueryV1,
  OdataProtocolCompiledQueryV1,
  QueryIrSourceIdentity,
} from "./types.js";

/** Runtime-only OData execution context. None of these values enter a plan fingerprint. */
export interface OdataProtocolExecutionQuery {
  readonly count: boolean;
  readonly fields: ReadonlyArray<HonuaFieldInfo>;
  readonly returnGeometry?: boolean;
  readonly geometryColumn?: string;
  readonly limit?: number;
}

/** Exact compiler/executor types carried by the OData protocol module. */
export interface OdataProtocolQueryBinding extends ProtocolModuleQueryBinding {
  readonly source: QueryIrSourceIdentity;
  readonly compileQuery: CanonicalQuery;
  readonly compiled: OdataProtocolCompiledQueryV1;
  readonly executeQuery: OdataProtocolExecutionQuery;
}

export type OdataProtocolModule = QueryCapableProtocolModule<"odata", HonuaOdataEntitySet, OdataProtocolQueryBinding>;

/**
 * Project already-negotiated OData query params onto the credential-free
 * deterministic artifact consumed by the module executor.
 *
 * `count` and `signal` are intentionally omitted: count is runtime response
 * metadata policy, and cancellation can never participate in request identity.
 */
export function createOdataProtocolCompiledQuery(
  entitySet: string,
  operation: ProtocolModuleQueryOperation,
  params: HonuaOdataQueryParams,
): OdataProtocolCompiledQueryV1 {
  const request: OdataCompiledQueryV1 = Object.freeze({
    compiler: "odata-v4-query-v1" as const,
    entitySet,
    ...(params.filter !== undefined ? { filter: params.filter } : {}),
    ...(params.select !== undefined ? { select: Object.freeze([...params.select]) } : {}),
    ...(params.expand !== undefined ? { expand: Object.freeze([...params.expand]) } : {}),
    ...(params.orderBy !== undefined ? { orderBy: Object.freeze([...params.orderBy]) } : {}),
    ...(params.skip !== undefined ? { skip: params.skip } : {}),
    ...(params.top !== undefined ? { top: params.top } : {}),
  });
  return bindOdataProtocolQueryOperation(request, operation);
}

/**
 * Construct the first-party query-capable OData protocol module.
 *
 * Discovery is synchronous and performs no I/O. `$metadata` remains lazy on
 * the returned `HonuaOdataEntitySet`, exactly as it was before the migration.
 * The client stays in this module instance's closure; there is no global
 * protocol registry or ambient authority.
 */
export function odataProtocolModule(client: HonuaClient): OdataProtocolModule {
  return Object.freeze({
    kind: "odata" as const,
    environments: Object.freeze(["browser", "node", "worker"] as const),
    capabilities(descriptor: SourceDescriptor): Capabilities {
      return descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.odata;
    },
    discover(descriptor: SourceDescriptor): ProtocolModuleHandle<HonuaOdataEntitySet> {
      const { entitySet, basePath } = requireOdataLocator(descriptor);
      const adapter = new HonuaOdataEntitySet({ client, entitySet, basePath });
      return Object.freeze({
        descriptor,
        capabilities: descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.odata,
        adapter,
        diagnostics: Object.freeze([]),
        dispose(): void {
          // HonuaOdataEntitySet retains only settled/in-flight promises and
          // opens no persistent handles. Disposal is deterministic and
          // synchronous with nothing to release.
        },
      });
    },
    compile: odataProtocolQueryCompiler.compile,
    async execute<TRecord>(
      handle: ProtocolModuleHandle<HonuaOdataEntitySet, "odata" | Protocol>,
      input: ProtocolModuleQueryExecuteInput<OdataProtocolCompiledQueryV1, OdataProtocolExecutionQuery>,
    ): Promise<Result<TRecord>> {
      assertExecutableOdataArtifact(handle.adapter, input.compiled, input.operation);
      const logicalLimit =
        input.operation === "queryAll"
          ? resolveOdataQueryAllLogicalLimit(input.compiled, input.query.limit)
          : undefined;
      const params = odataParamsFromCompiled(input.compiled, input.query.count, input.signal);
      switch (input.operation) {
        case "query": {
          const page = await handle.adapter.query<Record<string, unknown>>(params);
          return odataProtocolResultFromPage<TRecord>(
            handle.descriptor,
            page,
            input.query.fields,
            input.query.returnGeometry,
            input.query.geometryColumn,
          );
        }
        case "queryAll": {
          const drained = await handle.adapter.queryAll<Record<string, unknown>>(params);
          const allFeatures = drained.rows.map((row) =>
            odataRowToFeature<TRecord>(row, handle.descriptor, input.query.returnGeometry, input.query.geometryColumn),
          );
          const { features, exceededTransferLimit: collectedExceeded } = applyLimit(allFeatures, logicalLimit);
          const countExceeded =
            typeof drained.totalCount === "number" &&
            typeof logicalLimit === "number" &&
            drained.totalCount > features.length;
          return {
            features,
            exceededTransferLimit: collectedExceeded || countExceeded,
            ...(typeof drained.totalCount === "number"
              ? { totalCount: drained.totalCount }
              : { totalCount: features.length }),
            ...(input.query.fields.length > 0 ? { fields: input.query.fields } : {}),
          };
        }
        case "queryAggregate":
          throw new HonuaCapabilityNotSupportedError(
            "queryAggregate",
            handle.descriptor.protocol,
            handle.descriptor.id,
          );
      }
    },
  });
}

function requireOdataLocator(descriptor: SourceDescriptor): {
  entitySet: string;
  basePath: string;
} {
  const { entitySet, url, layerId } = descriptor.locator;
  let resolvedEntitySet: string | undefined;
  if (typeof entitySet === "string" && entitySet !== "") {
    resolvedEntitySet = entitySet;
  } else if (typeof layerId === "number" && Number.isFinite(layerId)) {
    resolvedEntitySet = `Layers(${layerId})/Features`;
  }
  if (resolvedEntitySet === undefined) {
    throw new Error(`createDataset: source "${descriptor.id}" (odata) requires locator.entitySet or locator.layerId`);
  }
  const basePath = url ? extractOdataBasePath(url) : "/odata";
  return { entitySet: resolvedEntitySet, basePath };
}

function extractOdataBasePath(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = trimTrailingSlashes(parsed.pathname);
    return pathname === "" ? "/odata" : pathname;
  } catch {
    return url.startsWith("/") ? trimTrailingSlashes(url) || "/odata" : `/${trimTrailingSlashes(url)}`;
  }
}

function assertExecutableOdataArtifact(
  adapter: HonuaOdataEntitySet,
  compiled: OdataProtocolCompiledQueryV1,
  operation: ProtocolModuleQueryOperation,
): void {
  if (compiled.compiler !== "odata-v4-protocol-query-v1") {
    throw new TypeError("odata: protocol module requires an odata-v4-protocol-query-v1 artifact");
  }
  if (compiled.entitySet !== adapter.entitySet) {
    throw new TypeError("odata: compiled entitySet does not match the discovered protocol handle");
  }
  if (compiled.operation !== operation) {
    throw new TypeError("odata: compiled operation does not match the requested protocol operation");
  }
}

/**
 * Recover the caller-visible queryAll ceiling from the compiler-owned
 * lookahead row and reject any runtime context that does not describe the
 * same bounded request. This runs before the adapter performs I/O.
 */
function resolveOdataQueryAllLogicalLimit(
  compiled: OdataProtocolCompiledQueryV1,
  requestedLimit: number | undefined,
): number | undefined {
  if (requestedLimit !== undefined && (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0)) {
    throw new TypeError("odata: queryAll logical limit must be a non-negative safe integer");
  }
  if (compiled.top === undefined) {
    if (requestedLimit !== undefined) {
      throw new TypeError("odata: queryAll compiled top does not match the logical limit");
    }
    return undefined;
  }
  if (!Number.isSafeInteger(compiled.top) || compiled.top < 1) {
    throw new TypeError("odata: queryAll compiled top must contain one lookahead row");
  }
  const compiledLogicalLimit = compiled.top - 1;
  if (requestedLimit !== undefined && requestedLimit !== compiledLogicalLimit) {
    throw new TypeError("odata: queryAll compiled top does not match the logical limit");
  }
  return requestedLimit ?? compiledLogicalLimit;
}

function odataParamsFromCompiled(
  compiled: OdataProtocolCompiledQueryV1,
  count: boolean,
  signal: AbortSignal | undefined,
): HonuaOdataQueryParams {
  return {
    ...(compiled.filter !== undefined ? { filter: compiled.filter } : {}),
    ...(compiled.select !== undefined ? { select: compiled.select } : {}),
    ...(compiled.expand !== undefined ? { expand: compiled.expand } : {}),
    ...(compiled.orderBy !== undefined ? { orderBy: compiled.orderBy } : {}),
    ...(compiled.skip !== undefined ? { skip: compiled.skip } : {}),
    ...(compiled.top !== undefined ? { top: compiled.top } : {}),
    ...(count ? { count: true } : {}),
    ...(signal ? { signal } : {}),
  };
}

/** Internal shared result projection used by query execution and OData streaming. */
export function odataProtocolResultFromPage<T>(
  descriptor: SourceDescriptor,
  page: HonuaOdataPage<Record<string, unknown>>,
  fields: ReadonlyArray<HonuaFieldInfo>,
  returnGeometry: boolean | undefined,
  geometryColumn: string | undefined,
): Result<T> {
  const features = page.rows.map((row) => odataRowToFeature<T>(row, descriptor, returnGeometry, geometryColumn));
  const exceededTransferLimit =
    typeof page.totalCount === "number" ? features.length < page.totalCount : Boolean(page.nextLink);
  return {
    features,
    exceededTransferLimit,
    ...(typeof page.totalCount === "number" ? { totalCount: page.totalCount } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

function odataRowToFeature<T>(
  row: Record<string, unknown>,
  descriptor: SourceDescriptor,
  returnGeometry: boolean | undefined,
  geometryColumn: string | undefined,
): HonuaTypedFeature<T> {
  const geometryKey =
    geometryColumn ??
    descriptor.schema?.fields?.find((field) => field.type === "esriFieldTypeGeometry")?.name ??
    findGeometryKey(row);
  if (geometryKey && row[geometryKey] !== undefined) {
    const { [geometryKey]: geometry, ...attributes } = row;
    return {
      attributes: attributes as T,
      geometry: returnGeometry === false ? null : ((geometry ?? null) as Record<string, unknown> | null),
    };
  }
  return { attributes: row as T, geometry: null };
}

function findGeometryKey(row: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(row)) {
    const lower = key.toLowerCase();
    if (lower === "geometry" || lower === "geography" || lower === "shape") return key;
  }
  return undefined;
}

function applyLimit<T>(
  features: ReadonlyArray<T>,
  limit: number | undefined,
): { features: ReadonlyArray<T>; exceededTransferLimit: boolean } {
  if (typeof limit !== "number" || limit < 0 || features.length <= limit) {
    return { features, exceededTransferLimit: false };
  }
  return { features: features.slice(0, limit), exceededTransferLimit: true };
}
