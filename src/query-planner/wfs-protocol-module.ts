/**
 * First-party WFS 2.0 query-capable protocol module.
 *
 * Discovery is synchronous and network-isolated. Runtime authority, WFS
 * capabilities evidence, negotiated output format, advertised DCP URLs, and
 * cancellation stay on the explicitly discovered handle; compiled artifacts
 * carry only credential-free endpoint/type identity and deterministic wire
 * intent.
 *
 * @module
 */
import type {
  ProtocolModuleDiscoverOptions,
  ProtocolModuleHandle,
  ProtocolModuleQueryBinding,
  ProtocolModuleQueryExecuteInput,
  ProtocolModuleQueryOperation,
  QueryCapableProtocolModule,
} from "../contract/protocol-module.js";
import type { Capabilities, Protocol, Result, SourceDescriptor } from "../contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../contract/types.js";
import type { HonuaClient } from "../core/client.js";
import { isHonuaSdkError } from "../core/error-envelope.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type {
  WfsCapabilitiesFeatureType,
  WfsCapabilitiesOperation,
  WfsCapabilitiesSnapshot,
} from "../core/wfs-capabilities.js";
import { HonuaWfsProtocolError, type WfsProtocolErrorReason } from "../core/wfs-protocol-error.js";
import type { HonuaWfsFeatureType, OutputFormatChoice } from "../core/wfs.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import { queryIrAuthorityFingerprint } from "./ir.js";
import type { CanonicalQuery, QueryIrSourceIdentity, WfsProtocolCompiledQueryV1 } from "./types.js";
import { wfsProtocolMethodForFilter, wfsProtocolQueryCompiler, wfsRuntimeEndpointIdentity } from "./wfs-v1.js";

/** Runtime-only WFS execution context. */
export interface WfsProtocolExecutionQuery {
  /** Caller-visible queryAll ceiling, before the compiler-owned lookahead row. */
  readonly logicalLimit?: number;
}

/** Exact compiler/executor types carried by the WFS protocol module. */
export interface WfsProtocolQueryBinding extends ProtocolModuleQueryBinding {
  readonly source: QueryIrSourceIdentity;
  readonly compileQuery: CanonicalQuery;
  readonly compiled: WfsProtocolCompiledQueryV1;
  readonly executeQuery: WfsProtocolExecutionQuery;
}

export type WfsProtocolModule = QueryCapableProtocolModule<"wfs", HonuaWfsFeatureType, WfsProtocolQueryBinding>;

export { HonuaWfsProtocolError };
export type { WfsProtocolErrorReason };

interface WfsNamespaceBinding {
  readonly prefix: string;
  readonly uri: string;
}

interface WfsExecutionEvidence {
  readonly methods: readonly ("GET" | "POST")[];
  readonly featureTypeName: string;
  readonly format: Readonly<OutputFormatChoice>;
  readonly namespace?: WfsNamespaceBinding;
  readonly supportedCrs: readonly string[];
}

interface WfsHandleState {
  readonly sourceId: string;
  readonly endpoint: string;
  readonly authorityFingerprint: `sha256:${string}`;
  readonly typeName: string;
  readonly adapter: HonuaWfsFeatureType;
  readonly descriptor: SourceDescriptor;
  readonly lifecycleController: AbortController;
  evidence?: {
    readonly snapshot: WfsCapabilitiesSnapshot;
    readonly value: WfsExecutionEvidence;
  };
  disposed: boolean;
}

const WFS_PAGE_FINGERPRINTS = new WeakMap<object, `sha256:${string}`>();

/** Construct the first-party query-capable WFS protocol module. */
export function wfsProtocolModule(client: HonuaClient): WfsProtocolModule {
  const handles = new WeakMap<object, WfsHandleState>();
  return Object.freeze({
    kind: "wfs" as const,
    environments: Object.freeze(["browser", "node", "worker"] as const),
    capabilities(descriptor: SourceDescriptor): Capabilities {
      return descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.wfs;
    },
    discover(
      descriptor: SourceDescriptor,
      options?: ProtocolModuleDiscoverOptions,
    ): ProtocolModuleHandle<HonuaWfsFeatureType> {
      const { endpointUrl, endpoint, typeName } = requireWfsLocator(descriptor);
      const root = client.wfs(endpointUrl);
      const adapter = root.featureType(typeName);
      const state: WfsHandleState = {
        sourceId: descriptor.id,
        endpoint,
        authorityFingerprint: queryIrAuthorityFingerprint(endpointUrl, options?.authorizationScope),
        typeName,
        adapter,
        descriptor,
        lifecycleController: new AbortController(),
        disposed: false,
      };
      const handle: ProtocolModuleHandle<HonuaWfsFeatureType> = Object.freeze({
        descriptor,
        capabilities: descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.wfs,
        adapter,
        diagnostics: Object.freeze([]),
        dispose(): void {
          if (state.disposed) return;
          state.disposed = true;
          state.evidence = undefined;
          state.lifecycleController.abort();
        },
      });
      handles.set(handle, state);
      return handle;
    },
    compile: wfsProtocolQueryCompiler.compile,
    async execute<TRecord>(
      handle: ProtocolModuleHandle<HonuaWfsFeatureType, "wfs" | Protocol>,
      input: ProtocolModuleQueryExecuteInput<WfsProtocolCompiledQueryV1, WfsProtocolExecutionQuery>,
    ): Promise<Result<TRecord>> {
      const operation = input.operation;
      const state = handles.get(handle);
      if (!state) {
        throw new TypeError("wfs: protocol handle was not discovered by this module instance");
      }
      if (state.disposed) {
        throw new TypeError("wfs: protocol handle has been disposed");
      }
      const signal = input.signal
        ? AbortSignal.any([input.signal, state.lifecycleController.signal])
        : state.lifecycleController.signal;
      const compiled = executableWfsArtifactSnapshot(state, input.compiled, operation);
      if (operation === "queryAggregate") {
        throw new HonuaCapabilityNotSupportedError("queryAggregate", handle.descriptor.protocol, handle.descriptor.id);
      }
      if (operation === "query" && compiled.count === 0) {
        return { features: [], exceededTransferLimit: false };
      }

      const logicalLimit =
        operation === "queryAll" ? resolveWfsQueryAllLogicalLimit(compiled, input.query.logicalLimit) : undefined;
      const evidence = await resolveWfsExecutionEvidence(state, compiled, signal);
      if (operation === "query") {
        return executeWfsPage<TRecord>(state.adapter, compiled, evidence, signal);
      }

      const target = typeof logicalLimit === "number" ? logicalLimit + 1 : Number.POSITIVE_INFINITY;
      const pageSize = typeof logicalLimit === "number" ? Math.max(1, Math.min(logicalLimit + 1, 2000)) : 2000;
      const collected: HonuaTypedFeature<TRecord>[] = [];
      const seenPages = new Set<string>();
      let totalCount: number | undefined;
      let offset = compiled.startIndex ?? 0;
      while (collected.length < target) {
        const requestedPageSize = Number.isFinite(target) ? Math.min(pageSize, target - collected.length) : pageSize;
        const page = await executeWfsPage<TRecord>(state.adapter, compiled, evidence, signal, {
          count: requestedPageSize,
          startIndex: offset,
        });
        totalCount = consistentWfsTotalCount(totalCount, page.totalCount);
        const pageEnd = checkedWfsPageEnd(offset, page.features.length);
        if (totalCount !== undefined && pageEnd > totalCount) {
          throw new HonuaWfsProtocolError(
            "invalid-feature-response",
            "WFS GetFeature returned more rows than numberMatched permits",
          );
        }
        if (page.features.length === 0) {
          if (totalCount !== undefined && offset < totalCount) {
            throw new HonuaWfsProtocolError(
              "paging-stalled",
              `WFS GetFeature returned no rows at startIndex ${offset} while numberMatched=${totalCount}`,
            );
          }
          break;
        }
        assertWfsPageProgress(page, seenPages, offset);
        collected.push(...page.features);
        offset = pageEnd;
        if (totalCount !== undefined && offset >= totalCount) break;
      }
      const { features, exceededTransferLimit } = applyLimit(collected, logicalLimit);
      const returnedEnd = checkedWfsPageEnd(compiled.startIndex ?? 0, features.length);
      return {
        features,
        exceededTransferLimit:
          exceededTransferLimit ||
          (totalCount !== undefined && typeof logicalLimit === "number" && totalCount > returnedEnd),
        ...(totalCount !== undefined ? { totalCount } : {}),
      };
    },
  });
}

function requireWfsLocator(descriptor: SourceDescriptor): {
  endpointUrl: string;
  endpoint: string;
  typeName: string;
} {
  if (descriptor.protocol !== "wfs") {
    throw new TypeError(`wfs: cannot discover protocol "${descriptor.protocol}"`);
  }
  const { url, typeName } = descriptor.locator;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`createDataset: source "${descriptor.id}" (wfs) requires locator.url`);
  }
  if (typeof typeName !== "string" || typeName.length === 0) {
    throw new Error(`createDataset: source "${descriptor.id}" (wfs) requires locator.typeName`);
  }
  return {
    endpointUrl: url,
    endpoint: wfsRuntimeEndpointIdentity(url),
    typeName,
  };
}

const WFS_PROTOCOL_ARTIFACT_KEYS = new Set([
  "compiler",
  "operation",
  "sourceId",
  "endpoint",
  "authorityFingerprint",
  "typeName",
  "method",
  "filter",
  "bbox",
  "propertyName",
  "sortBy",
  "startIndex",
  "count",
  "filterSrsName",
  "srsName",
]);

function executableWfsArtifactSnapshot(
  state: WfsHandleState,
  value: WfsProtocolCompiledQueryV1,
  operation: ProtocolModuleQueryOperation,
): WfsProtocolCompiledQueryV1 {
  if (operation !== "query" && operation !== "queryAll" && operation !== "queryAggregate") {
    throw new TypeError("wfs: requested protocol operation is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("wfs: compiled GetFeature artifact is invalid");
  }
  if (Object.keys(value).some((key) => !WFS_PROTOCOL_ARTIFACT_KEYS.has(key))) {
    throw new TypeError("wfs: compiled GetFeature artifact contains unsupported fields");
  }
  const compiler = value.compiler;
  const compiledOperation = value.operation;
  const sourceId = value.sourceId;
  const endpoint = value.endpoint;
  const authorityFingerprint = value.authorityFingerprint;
  const typeName = value.typeName;
  const method = value.method;
  const filter = value.filter;
  const bbox = value.bbox;
  const propertyName = value.propertyName;
  const sortBy = value.sortBy;
  const startIndex = value.startIndex;
  const count = value.count;
  const filterSrsName = value.filterSrsName;
  const srsName = value.srsName;
  if (
    propertyName !== undefined &&
    (!Array.isArray(propertyName) ||
      propertyName.length === 0 ||
      propertyName.some((name) => typeof name !== "string" || name.length === 0))
  ) {
    throw new TypeError("wfs: compiled propertyName is invalid");
  }
  const compiled: WfsProtocolCompiledQueryV1 = Object.freeze({
    compiler,
    operation: compiledOperation,
    sourceId,
    endpoint,
    authorityFingerprint,
    typeName,
    method,
    ...(filter !== undefined ? { filter } : {}),
    ...(bbox !== undefined ? { bbox } : {}),
    ...(propertyName !== undefined ? { propertyName: Object.freeze([...propertyName]) } : {}),
    ...(sortBy !== undefined ? { sortBy } : {}),
    ...(startIndex !== undefined ? { startIndex } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(filterSrsName !== undefined ? { filterSrsName } : {}),
    ...(srsName !== undefined ? { srsName } : {}),
  });
  if (compiled.compiler !== "wfs-2.0-protocol-query-v1") {
    throw new TypeError("wfs: protocol module requires a wfs-2.0-protocol-query-v1 artifact");
  }
  if (compiled.operation !== operation) {
    throw new TypeError("wfs: compiled operation does not match the requested protocol operation");
  }
  if (typeof compiled.sourceId !== "string" || compiled.sourceId.length === 0 || compiled.sourceId !== state.sourceId) {
    throw new TypeError("wfs: compiled source id does not match the discovered protocol handle");
  }
  if (
    typeof compiled.authorityFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(compiled.authorityFingerprint) ||
    compiled.authorityFingerprint !== state.authorityFingerprint
  ) {
    throw new TypeError("wfs: compiled authority does not match the discovered protocol handle");
  }
  let normalizedEndpoint: string;
  try {
    normalizedEndpoint = wfsRuntimeEndpointIdentity(compiled.endpoint);
  } catch {
    throw new TypeError("wfs: compiled endpoint identity is invalid");
  }
  if (
    normalizedEndpoint !== compiled.endpoint ||
    normalizedEndpoint !== state.endpoint ||
    compiled.typeName !== state.typeName
  ) {
    throw new TypeError("wfs: compiled identity does not match the discovered protocol handle");
  }
  if (compiled.method !== "GET" && compiled.method !== "POST") {
    throw new TypeError("wfs: compiled GetFeature method is invalid");
  }
  assertOptionalNonEmptyString(compiled.filter, "filter");
  assertOptionalNonEmptyString(compiled.bbox, "bbox");
  assertOptionalNonEmptyString(compiled.sortBy, "sortBy");
  assertOptionalNonEmptyString(compiled.filterSrsName, "filterSrsName");
  assertOptionalNonEmptyString(compiled.srsName, "srsName");
  if (compiled.filter !== undefined && compiled.bbox !== undefined) {
    throw new TypeError("wfs: compiled GetFeature request cannot contain both filter and bbox");
  }
  const expectedMethod = wfsProtocolMethodForFilter(compiled.filter);
  if (compiled.method !== expectedMethod) {
    throw new TypeError("wfs: compiled GetFeature method does not match the filter budget");
  }
  if (compiled.method === "POST" && compiled.filter === undefined) {
    throw new TypeError("wfs: compiled POST GetFeature request requires a filter");
  }
  assertCompiledSpatialCrsBinding(compiled);
  assertOptionalNonNegativeInteger(compiled.startIndex, "startIndex");
  assertOptionalNonNegativeInteger(compiled.count, "count");
  return compiled;
}

function assertOptionalNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`wfs: compiled ${name} must be a non-negative safe integer`);
  }
}

function assertOptionalNonEmptyString(value: string | undefined, name: string): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`wfs: compiled ${name} must be a non-empty string`);
  }
}

function assertCompiledSpatialCrsBinding(compiled: WfsProtocolCompiledQueryV1): void {
  if (compiled.bbox !== undefined) {
    const suffix = compiled.filterSrsName ? `,${compiled.filterSrsName}` : "";
    if (suffix && !compiled.bbox.endsWith(suffix)) {
      throw new TypeError("wfs: compiled bbox does not match the filter geometry CRS");
    }
    const coordinates = (suffix ? compiled.bbox.slice(0, -suffix.length) : compiled.bbox).split(",");
    if (coordinates.length !== 4 || coordinates.some((value) => !Number.isFinite(Number(value)))) {
      throw new TypeError("wfs: compiled bbox is invalid");
    }
  }
  if (compiled.filter !== undefined) {
    const advertised = [...compiled.filter.matchAll(/\ssrsName="([^"]*)"/g)].map((match) => match[1]);
    const filterSrsName = compiled.filterSrsName;
    if (filterSrsName === undefined && advertised.length > 0) {
      throw new TypeError("wfs: compiled filter carries an unbound geometry CRS");
    }
    if (
      filterSrsName !== undefined &&
      (advertised.length === 0 || advertised.some((value) => value !== escapeXmlAttr(filterSrsName)))
    ) {
      throw new TypeError("wfs: compiled filter does not match the filter geometry CRS");
    }
  } else if (compiled.filterSrsName !== undefined && compiled.bbox === undefined) {
    throw new TypeError("wfs: compiled filter geometry CRS has no spatial predicate");
  }
}

async function resolveWfsExecutionEvidence(
  state: WfsHandleState,
  compiled: WfsProtocolCompiledQueryV1,
  signal: AbortSignal | undefined,
): Promise<WfsExecutionEvidence> {
  if (signal?.aborted) throw new HonuaAbortError();
  let snapshot: WfsCapabilitiesSnapshot;
  try {
    snapshot = await state.adapter.root.capabilities(signal ? { signal } : undefined);
  } catch (error) {
    if (isHonuaSdkError(error)) throw error;
    throw invalidCapabilities("WFS GetCapabilities returned a malformed or invalid document", error);
  }
  if (signal?.aborted) throw new HonuaAbortError();
  if (state.disposed) throw new TypeError("wfs: protocol handle has been disposed");
  const cached = state.evidence;
  const evidence = cached?.snapshot === snapshot ? cached.value : validateWfsCapabilities(state, snapshot);
  if (cached?.snapshot !== snapshot) {
    state.evidence = { snapshot, value: evidence };
  }
  if (!evidence.methods.includes(compiled.method)) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      state.descriptor.protocol,
      `${state.descriptor.id} (GetFeature does not advertise ${compiled.method})`,
    );
  }
  assertAdvertisedCrs(evidence, compiled.filterSrsName, "filter geometry");
  assertAdvertisedCrs(evidence, compiled.srsName, "response");
  return evidence;
}

function validateWfsCapabilities(state: WfsHandleState, snapshot: WfsCapabilitiesSnapshot): WfsExecutionEvidence {
  if (snapshot.version !== "2.0.0") {
    throw invalidCapabilities(
      `WFS GetCapabilities must advertise exact version 2.0.0, got ${snapshot.version ?? "none"}`,
    );
  }
  const operation = snapshot.operations.get("GetFeature");
  if (
    !operation ||
    !Array.isArray(operation.methods) ||
    operation.methods.length === 0 ||
    operation.methods.some((method) => method !== "GET" && method !== "POST")
  ) {
    throw invalidCapabilities("WFS GetCapabilities does not advertise a GetFeature HTTP binding");
  }
  const methods = Object.freeze([...new Set(operation.methods)]);
  for (const method of methods) {
    assertSameOriginDcp(state, operation, method);
  }
  const featureType = snapshot.featureTypes.find((candidate) => candidate.name === state.typeName);
  if (!featureType) {
    throw invalidCapabilities(`WFS GetCapabilities does not advertise feature type "${state.typeName}"`);
  }
  if (!featureType.defaultCrs) {
    throw invalidCapabilities(`WFS feature type "${state.typeName}" does not advertise DefaultCRS`);
  }
  const defaultCrs = canonicalWfsCrs(featureType.defaultCrs);
  if (!defaultCrs) {
    throw invalidCapabilities(`WFS feature type "${state.typeName}" advertises an unsupported DefaultCRS`);
  }
  const supportedCrs = Object.freeze([
    ...new Set(
      [defaultCrs, ...(featureType.otherCrs ?? []).map((value) => canonicalWfsCrs(value))].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ]);
  const namespace = namespaceBinding(state, snapshot, featureType);
  const advertisedFormats = snapshot.outputFormatsByOp.get("GetFeature") ?? [];
  if (
    !Array.isArray(advertisedFormats) ||
    (advertisedFormats.length > 0 &&
      advertisedFormats.some((value) => typeof value !== "string" || value.length === 0))
  ) {
    throw invalidCapabilities("WFS GetFeature does not advertise an outputFormat");
  }
  const negotiatedFormat = state.adapter.root.negotiateOutputFormat(snapshot);
  if (!negotiatedFormat || negotiatedFormat.kind !== "json" || !advertisedFormats.includes(negotiatedFormat.format)) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      state.descriptor.protocol,
      `${state.descriptor.id} (GetFeature does not advertise a recognized GeoJSON output format)`,
    );
  }
  const format = Object.freeze({ kind: "json" as const, format: negotiatedFormat.format });
  return Object.freeze({
    methods,
    featureTypeName: featureType.name,
    format,
    ...(namespace ? { namespace } : {}),
    supportedCrs,
  });
}

function namespaceBinding(
  state: WfsHandleState,
  snapshot: WfsCapabilitiesSnapshot,
  featureType: WfsCapabilitiesFeatureType,
): WfsNamespaceBinding | undefined {
  const separator = state.typeName.indexOf(":");
  if (separator < 0) return undefined;
  const prefix = state.typeName.slice(0, separator);
  const elementBinding = featureType.namespace;
  const uri =
    elementBinding === undefined
      ? snapshot.namespaces.get(prefix)
      : elementBinding.prefix === prefix
        ? elementBinding.uri
        : undefined;
  if (!uri) {
    throw invalidCapabilities(
      `WFS GetCapabilities does not bind namespace prefix "${prefix}" for feature type "${state.typeName}"`,
    );
  }
  const descriptorNamespace = state.descriptor.locator.featureNamespace;
  if (descriptorNamespace !== undefined && descriptorNamespace !== uri) {
    throw invalidCapabilities(
      `WFS descriptor namespace for prefix "${prefix}" does not match GetCapabilities evidence`,
    );
  }
  return Object.freeze({ prefix, uri });
}

function assertSameOriginDcp(state: WfsHandleState, operation: WfsCapabilitiesOperation, method: "GET" | "POST"): void {
  const root = state.adapter.root;
  const configured = new URL(root.endpointUrl, root.client.serverBaseUrl);
  const advertised = new URL(
    method === "GET" ? (operation.getUrl ?? root.endpointUrl) : (operation.postUrl ?? root.endpointUrl),
    root.client.serverBaseUrl,
  );
  if (advertised.username || advertised.password || advertised.origin !== configured.origin) {
    throw invalidCapabilities(`WFS GetFeature ${method} DCP authority is not bound to the configured endpoint`);
  }
}

function assertAdvertisedCrs(evidence: WfsExecutionEvidence, value: string | undefined, role: string): void {
  if (value === undefined) return;
  const canonical = canonicalWfsCrs(value);
  if (!canonical || !evidence.supportedCrs.includes(canonical)) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "wfs",
      `${evidence.featureTypeName} (${role} CRS is not advertised)`,
    );
  }
}

function canonicalWfsCrs(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^(?:OGC:)?CRS:?84$/i.test(trimmed)) return "ogc:crs84";
  const urn = trimmed.match(/^urn:(?:ogc|x-ogc):def:crs:(EPSG|OGC):[^:]*:([^:\s]+)$/i);
  const http = trimmed.match(/^https?:\/\/www\.opengis\.net\/def\/crs\/(EPSG|OGC)\/[^/]+\/([^/?#]+)\/?$/i);
  const legacyEpsgHttp = trimmed.match(/^https?:\/\/www\.opengis\.net\/gml\/srs\/epsg\.xml#(\d+)$/i);
  const short = trimmed.match(/^EPSG:(\d+)$/i);
  const numeric = trimmed.match(/^(\d+)$/);
  const shorthandCode = short?.[1] ?? numeric?.[1] ?? legacyEpsgHttp?.[1];
  if (shorthandCode) return canonicalEpsgCode(shorthandCode);
  const authority = (urn?.[1] ?? http?.[1])?.toUpperCase();
  const code = urn?.[2] ?? http?.[2];
  if (authority === "EPSG" && code && /^\d+$/.test(code)) return canonicalEpsgCode(code);
  if (authority === "OGC" && code && /^CRS:?84$/i.test(code)) return "ogc:crs84";
  return undefined;
}

function canonicalEpsgCode(code: string): string | undefined {
  const numeric = Number(code);
  return Number.isSafeInteger(numeric) && numeric > 0 ? `epsg:${numeric}` : undefined;
}

function invalidCapabilities(message: string, cause?: unknown): HonuaWfsProtocolError {
  return new HonuaWfsProtocolError("invalid-capabilities", message, cause === undefined ? {} : { cause });
}

async function executeWfsPage<TRecord>(
  adapter: HonuaWfsFeatureType,
  compiled: WfsProtocolCompiledQueryV1,
  evidence: WfsExecutionEvidence,
  signal: AbortSignal | undefined,
  paging?: { readonly count: number; readonly startIndex: number },
): Promise<Result<TRecord>> {
  const count = paging?.count ?? compiled.count;
  const startIndex = paging?.startIndex ?? compiled.startIndex;
  const params: Parameters<HonuaWfsFeatureType["getFeature"]>[0] = {
    method: compiled.method,
    outputFormat: evidence.format.format,
    ...(evidence.namespace ? { namespace: evidence.namespace } : {}),
    ...(compiled.method === "GET" && compiled.filter !== undefined ? { filter: compiled.filter } : {}),
    ...(compiled.bbox !== undefined ? { bbox: compiled.bbox } : {}),
    ...(compiled.propertyName !== undefined ? { propertyName: [...compiled.propertyName] } : {}),
    ...(compiled.sortBy !== undefined ? { sortBy: compiled.sortBy } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(startIndex !== undefined && startIndex > 0 ? { startIndex } : {}),
    ...(compiled.srsName !== undefined ? { srsName: compiled.srsName } : {}),
    ...(signal ? { signal } : {}),
  };
  if (compiled.method === "POST" && compiled.filter !== undefined) {
    params.body = buildWfsPostGetFeatureBody({
      typeName: compiled.typeName,
      filter: compiled.filter,
      count,
      startIndex: startIndex !== undefined && startIndex > 0 ? startIndex : undefined,
      outputFormat: evidence.format.format,
      ...(evidence.namespace ? { namespace: evidence.namespace } : {}),
      ...(compiled.propertyName !== undefined ? { propertyNames: compiled.propertyName } : {}),
      ...(compiled.sortBy !== undefined ? { sortBy: compiled.sortBy } : {}),
      ...(compiled.srsName !== undefined ? { srsName: compiled.srsName } : {}),
    });
  }
  let response: Awaited<ReturnType<HonuaWfsFeatureType["getFeature"]>>;
  try {
    response = await adapter.getFeature(params);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("WFS GetFeature returned non-JSON output despite Accept negotiation:")
    ) {
      throw new HonuaWfsProtocolError(
        "invalid-feature-response",
        "WFS GetFeature returned malformed JSON despite GeoJSON negotiation",
      );
    }
    throw error;
  }
  if (response.kind !== "json") {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "wfs",
      `WFS GetFeature returned ${response.contentType}; canonical surface only carries JSON. Reach raw output through Source.protocol("wfs")`,
    );
  }
  const result = wfsProtocolResultFromGeoJson<TRecord>(response.data);
  if (count !== undefined && result.features.length > count) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature returned more rows than the requested count permits",
    );
  }
  const pageEnd = checkedWfsPageEnd(startIndex ?? 0, result.features.length);
  if (result.totalCount !== undefined && pageEnd > result.totalCount) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature returned more rows than numberMatched permits",
    );
  }
  if (result.totalCount === undefined) return result;
  return copyWfsPageFingerprint(result, {
    ...result,
    exceededTransferLimit: pageEnd < result.totalCount,
  });
}

function resolveWfsQueryAllLogicalLimit(
  compiled: WfsProtocolCompiledQueryV1,
  requestedLimit: number | undefined,
): number | undefined {
  if (requestedLimit !== undefined && (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0)) {
    throw new TypeError("wfs: queryAll logical limit must be a non-negative safe integer");
  }
  if (compiled.count === undefined) {
    if (requestedLimit !== undefined) {
      throw new TypeError("wfs: queryAll compiled count does not match the logical limit");
    }
    return undefined;
  }
  if (!Number.isSafeInteger(compiled.count) || compiled.count < 1) {
    throw new TypeError("wfs: queryAll compiled count must contain one lookahead row");
  }
  const compiledLogicalLimit = compiled.count - 1;
  if (requestedLimit !== undefined && requestedLimit !== compiledLogicalLimit) {
    throw new TypeError("wfs: queryAll compiled count does not match the logical limit");
  }
  return requestedLimit ?? compiledLogicalLimit;
}

/** Project one GeoJSON FeatureCollection into the protocol-neutral Result envelope. */
export function wfsProtocolResultFromGeoJson<TRecord>(data: unknown): Result<TRecord> {
  if (!isPlainRecord(data) || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature did not return a GeoJSON FeatureCollection with a features array",
    );
  }
  const features: HonuaTypedFeature<TRecord>[] = data.features.map((feature, index) => {
    if (
      !isPlainRecord(feature) ||
      feature.type !== "Feature" ||
      (feature.properties !== null && !isPlainRecord(feature.properties)) ||
      (feature.geometry !== null && !isGeoJsonGeometry(feature.geometry))
    ) {
      throw new HonuaWfsProtocolError(
        "invalid-feature-response",
        `WFS GetFeature returned an invalid GeoJSON feature at index ${index}`,
      );
    }
    return {
      attributes: (feature.properties ?? {}) as TRecord,
      geometry: feature.geometry as Record<string, unknown> | null,
    };
  });
  const totalCount = parseGeoJsonCount(data.numberMatched, "numberMatched");
  const numberReturned = parseGeoJsonCount(data.numberReturned, "numberReturned");
  if (numberReturned !== undefined && numberReturned !== features.length) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature numberReturned does not match the GeoJSON features array",
    );
  }
  let pageFingerprint: `sha256:${string}`;
  try {
    pageFingerprint = sha256(canonicalStringify(toJsonValue(data.features)));
  } catch (error) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature features must contain only finite, acyclic JSON values",
      { cause: error },
    );
  }
  const result: Result<TRecord> = {
    features,
    exceededTransferLimit: totalCount !== undefined && features.length < totalCount,
    ...(totalCount !== undefined ? { totalCount } : {}),
  };
  WFS_PAGE_FINGERPRINTS.set(result, pageFingerprint);
  return result;
}

function parseGeoJsonCount(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "unknown") return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      `WFS GetFeature ${name} must be a non-negative safe integer or "unknown"`,
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isGeoJsonGeometry(value: unknown): value is Record<string, unknown> {
  return validateGeoJsonGeometry(value, 0, {
    geometryObjects: 0,
    coordinateContainers: 0,
    positions: 0,
    coordinateValues: 0,
  });
}

const WFS_GEOJSON_MAX_GEOMETRY_DEPTH = 32;
const WFS_GEOJSON_MAX_GEOMETRY_OBJECTS = 12_000;
const WFS_GEOJSON_MAX_COORDINATE_CONTAINERS = 1_100_000;
const WFS_GEOJSON_MAX_POSITIONS = 1_000_000;
const WFS_GEOJSON_MAX_COORDINATE_VALUES = 8_000_000;
const WFS_GEOJSON_MAX_POSITION_DIMENSIONS = 8;

interface GeoJsonGeometryBudget {
  geometryObjects: number;
  coordinateContainers: number;
  positions: number;
  coordinateValues: number;
}

function validateGeoJsonGeometry(value: unknown, depth: number, budget: GeoJsonGeometryBudget): boolean {
  if (
    depth > WFS_GEOJSON_MAX_GEOMETRY_DEPTH ||
    !isPlainRecord(value) ||
    ++budget.geometryObjects > WFS_GEOJSON_MAX_GEOMETRY_OBJECTS
  ) {
    return false;
  }
  switch (value.type) {
    case "Point":
      return isEmptyCoordinates(value.coordinates, budget) || isGeoJsonPosition(value.coordinates, budget);
    case "MultiPoint":
      return isGeoJsonPositionArray(value.coordinates, budget, 0);
    case "LineString":
      return isGeoJsonPositionArray(value.coordinates, budget, 2);
    case "MultiLineString":
      return isGeoJsonLineArray(value.coordinates, budget);
    case "Polygon":
      return isGeoJsonPolygonCoordinates(value.coordinates, budget);
    case "MultiPolygon":
      return isGeoJsonMultiPolygonCoordinates(value.coordinates, budget);
    case "GeometryCollection":
      if (!Array.isArray(value.geometries) || !consumeCoordinateContainer(budget)) return false;
      return value.geometries.every((geometry) => validateGeoJsonGeometry(geometry, depth + 1, budget));
    default:
      return false;
  }
}

function isEmptyCoordinates(value: unknown, budget: GeoJsonGeometryBudget): boolean {
  return Array.isArray(value) && value.length === 0 && consumeCoordinateContainer(budget);
}

function isGeoJsonPosition(value: unknown, budget: GeoJsonGeometryBudget): boolean {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > WFS_GEOJSON_MAX_POSITION_DIMENSIONS ||
    !consumeCoordinateContainer(budget) ||
    ++budget.positions > WFS_GEOJSON_MAX_POSITIONS ||
    budget.coordinateValues + value.length > WFS_GEOJSON_MAX_COORDINATE_VALUES
  ) {
    return false;
  }
  budget.coordinateValues += value.length;
  return value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}

function isGeoJsonPositionArray(value: unknown, budget: GeoJsonGeometryBudget, minimumLength: number): boolean {
  if (!Array.isArray(value) || !consumeCoordinateContainer(budget) || value.length > WFS_GEOJSON_MAX_POSITIONS) {
    return false;
  }
  if (value.length === 0) return true;
  return value.length >= minimumLength && value.every((position) => isGeoJsonPosition(position, budget));
}

function isGeoJsonLineArray(value: unknown, budget: GeoJsonGeometryBudget): boolean {
  if (!Array.isArray(value) || !consumeCoordinateContainer(budget)) return false;
  return value.every((line) => isGeoJsonPositionArray(line, budget, 2));
}

function isGeoJsonLinearRing(value: unknown, budget: GeoJsonGeometryBudget): boolean {
  if (!Array.isArray(value) || value.length < 4 || !consumeCoordinateContainer(budget)) return false;
  const first = value[0];
  const last = value[value.length - 1];
  if (
    !Array.isArray(first) ||
    !Array.isArray(last) ||
    first.length !== last.length ||
    !first.every((coordinate, index) => coordinate === last[index])
  ) {
    return false;
  }
  return value.every((position) => isGeoJsonPosition(position, budget));
}

function isGeoJsonPolygonCoordinates(value: unknown, budget: GeoJsonGeometryBudget): boolean {
  if (!Array.isArray(value) || !consumeCoordinateContainer(budget)) return false;
  if (value.length === 0) return true;
  return value.every((ring) => isGeoJsonLinearRing(ring, budget));
}

function isGeoJsonMultiPolygonCoordinates(value: unknown, budget: GeoJsonGeometryBudget): boolean {
  if (!Array.isArray(value) || !consumeCoordinateContainer(budget)) return false;
  return value.every((polygon) => isGeoJsonPolygonCoordinates(polygon, budget));
}

function consumeCoordinateContainer(budget: GeoJsonGeometryBudget): boolean {
  budget.coordinateContainers += 1;
  return budget.coordinateContainers <= WFS_GEOJSON_MAX_COORDINATE_CONTAINERS;
}

function copyWfsPageFingerprint<T extends object>(source: object, target: T): T {
  const fingerprint = WFS_PAGE_FINGERPRINTS.get(source);
  if (fingerprint !== undefined) WFS_PAGE_FINGERPRINTS.set(target, fingerprint);
  return target;
}

/** @internal Fail closed when a WFS server repeats a page instead of advancing. */
export function assertWfsPageProgress<T>(result: Result<T>, seenPages: Set<string>, startIndex: number): void {
  const fingerprint = WFS_PAGE_FINGERPRINTS.get(result);
  if (fingerprint === undefined) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature page identity was not retained by the protocol module",
    );
  }
  if (seenPages.has(fingerprint)) {
    throw new HonuaWfsProtocolError(
      "paging-stalled",
      `WFS GetFeature repeated a prior page at startIndex ${startIndex}`,
    );
  }
  seenPages.add(fingerprint);
}

function consistentWfsTotalCount(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  if (current !== undefined && current !== next) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature numberMatched changed while paging one query",
    );
  }
  return next;
}

/** @internal Reject paging arithmetic that cannot remain exact in JavaScript. */
export function checkedWfsPageEnd(startIndex: number, returnedRows: number): number {
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isSafeInteger(returnedRows) ||
    returnedRows < 0 ||
    !Number.isSafeInteger(startIndex + returnedRows)
  ) {
    throw new HonuaWfsProtocolError(
      "invalid-feature-response",
      "WFS GetFeature paging exceeded the safe-integer range",
    );
  }
  return startIndex + returnedRows;
}

function applyLimit<T>(
  features: readonly HonuaTypedFeature<T>[],
  limit: number | undefined,
): { features: HonuaTypedFeature<T>[]; exceededTransferLimit: boolean } {
  if (typeof limit !== "number" || limit < 0) {
    return { features: [...features], exceededTransferLimit: false };
  }
  return {
    features: features.slice(0, limit),
    exceededTransferLimit: features.length > limit,
  };
}

/** @internal Shared by the module executor and legacy non-query WFS drains. */
export function buildWfsPostGetFeatureBody(options: {
  typeName: string;
  filter: string;
  count: number | undefined;
  startIndex: number | undefined;
  outputFormat: string;
  propertyNames?: readonly string[];
  sortBy?: string;
  srsName?: string;
  namespace?: WfsNamespaceBinding;
}): string {
  const countAttr = typeof options.count === "number" ? ` count="${options.count}"` : "";
  const startAttr = typeof options.startIndex === "number" ? ` startIndex="${options.startIndex}"` : "";
  const outputAttr = ` outputFormat="${escapeXmlAttr(options.outputFormat)}"`;
  const queryAttrs = options.srsName !== undefined ? ` srsName="${escapeXmlAttr(options.srsName)}"` : "";
  if (options.namespace !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(options.namespace.prefix)) {
    throw new TypeError("wfs: POST namespace prefix is invalid");
  }
  const namespaceAttr =
    options.namespace !== undefined
      ? ` xmlns:${options.namespace.prefix}="${escapeXmlAttr(options.namespace.uri)}"`
      : "";
  const propertyXml =
    options.propertyNames && options.propertyNames.length > 0
      ? options.propertyNames.map((name) => `<wfs:PropertyName>${escapeXmlText(name)}</wfs:PropertyName>`).join("")
      : "";
  const sortByXml = options.sortBy !== undefined ? buildSortByXml(options.sortBy) : "";
  return `<wfs:GetFeature xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0"${namespaceAttr} service="WFS" version="2.0.0"${outputAttr}${countAttr}${startAttr}><wfs:Query typeNames="${escapeXmlAttr(options.typeName)}"${queryAttrs}>${propertyXml}${options.filter}${sortByXml}</wfs:Query></wfs:GetFeature>`;
}

function buildSortByXml(sortBy: string): string {
  const entries = sortBy
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return "";
  const properties = entries.map((entry) => {
    const parts = entry.split(/\s+/);
    const field = parts[0] ?? "";
    const direction = parts[1]?.toUpperCase() === "D" ? "DESC" : "ASC";
    return `<fes:SortProperty><fes:ValueReference>${escapeXmlText(field)}</fes:ValueReference><fes:SortOrder>${direction}</fes:SortOrder></fes:SortProperty>`;
  });
  return `<fes:SortBy>${properties.join("")}</fes:SortBy>`;
}

function escapeXmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
