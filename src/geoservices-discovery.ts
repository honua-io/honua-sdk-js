/** Metadata-only discovery for the five canonical GeoServices service kinds. */

import {
  type ConnectTarget,
  discoverGeoServicesImageSources,
  discoverGeoServicesSources,
} from "./connect-geoservices.js";
import type { ConnectDiscoverySourceSnapshot } from "./connect.js";
import {
  type DiscoveryCapabilityEvidence,
  type DiscoveryProvenance,
  type SourceDiscoveryInspection,
  inspectDiscoveredSource,
  resolveDiscoveryCapabilities,
} from "./contract/discovery.js";
import type { SourceDescriptor } from "./contract/types.js";
import { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import type { HonuaClientOptions } from "./core/types.js";
import {
  type GeoServicesServiceKind,
  type GeoServicesServiceProtocol,
  type NormalizedGeoServicesEndpoint,
  normalizeGeoServicesEndpoint,
} from "./geoservices-endpoint.js";
import { type GeoServicesMetadataRequestOptions, getGeoServicesMetadata } from "./geoservices-metadata.js";

/** Whether metadata established that credentials are required. */
export type GeoServicesAuthenticationRequirement = "required" | "not-required" | "unknown";

/** Credential-free authentication evidence retained by service discovery. */
export interface GeoServicesAuthenticationDescriptor {
  readonly requirement: GeoServicesAuthenticationRequirement;
  readonly evidence: "metadata" | "http-status" | "none";
  readonly statusCode?: number;
  readonly schemes: readonly string[];
  readonly tokenServiceUrl?: string;
}

/** Normalized GeoServices spatial-reference evidence. */
export interface GeoServicesCrsDescriptor {
  /** Native ArcGIS/Esri well-known id exactly as advertised. */
  readonly wkid?: number;
  /** Newer well-known id advertised alongside a legacy native id. */
  readonly latestWkid?: number;
  /** Authority is present only when metadata establishes an EPSG identity. */
  readonly authority?: "EPSG";
  /** Authority code; never populated from an unqualified legacy Esri WKID. */
  readonly code?: number;
  readonly wkt?: string;
}

/** Formats advertised by service or task metadata. */
export interface GeoServicesFormatDescriptor {
  readonly query: readonly string[];
  readonly image: readonly string[];
  readonly input: readonly string[];
  readonly output: readonly string[];
}

/** Bounded limits advertised by service or task metadata. */
export interface GeoServicesLimitDescriptor {
  readonly maxRecordCount?: number;
  readonly maxImageWidth?: number;
  readonly maxImageHeight?: number;
  readonly maxMosaicImageCount?: number;
  readonly maxDownloadImageCount?: number;
}

export type GeoServicesOperationExecution = "synchronous" | "asynchronous" | "unknown";
export type GeoServicesOperationAvailability = "advertised" | "unavailable";

/** A metadata-only GeoServices operation. It is deliberately not a Source. */
export interface GeoServicesOperationDescriptor {
  readonly id: string;
  readonly kind: "image" | "geometry" | "process";
  readonly operation: string;
  readonly title?: string;
  readonly taskName?: string;
  readonly sourceId?: string;
  readonly href: string;
  readonly methods: readonly ("GET" | "POST")[];
  readonly availability: GeoServicesOperationAvailability;
  readonly execution: GeoServicesOperationExecution;
  readonly sdkSupported: boolean;
  readonly formats: GeoServicesFormatDescriptor;
  readonly crs: readonly GeoServicesCrsDescriptor[];
  readonly limits: GeoServicesLimitDescriptor;
  readonly jobLifecycle?: {
    readonly statusHrefTemplate: string;
    readonly resultHrefTemplate: string;
    readonly cancelHrefTemplate: string;
  };
  readonly provenance: readonly DiscoveryProvenance[];
}

/** Stable diagnostic vocabulary for service-shaped discovery. */
export type GeoServicesDiscoveryDiagnosticCode =
  | "authentication-required"
  | "metadata-unavailable"
  | "operation-metadata-unavailable"
  | "partial-discovery";

export interface GeoServicesDiscoveryDiagnostic {
  readonly code: GeoServicesDiscoveryDiagnosticCode;
  readonly severity: "warning";
  readonly message: string;
  readonly operationId?: string;
}

/** Common identity and metadata projection shared by facade and native endpoints. */
export interface GeoServicesServiceDescriptor {
  readonly kind: "geoservices-service";
  readonly serviceKind: GeoServicesServiceKind;
  readonly protocol: GeoServicesServiceProtocol;
  readonly endpoint: string;
  readonly clientBaseUrl: string;
  readonly serviceId: string;
  readonly layerId?: number;
  readonly taskName?: string;
  readonly title?: string;
  readonly description?: string;
  /** True only when the current SDK can construct an honest Source descriptor. */
  readonly sourceBacked: boolean;
  readonly formats: GeoServicesFormatDescriptor;
  readonly crs: readonly GeoServicesCrsDescriptor[];
  readonly limits: GeoServicesLimitDescriptor;
  readonly authentication: GeoServicesAuthenticationDescriptor;
}

export type GeoServicesDiscoveryState = "complete" | "partial";

/** Result of {@link discoverGeoServices}. No operation is invoked by discovery. */
export interface GeoServicesDiscoveryResult {
  readonly service: GeoServicesServiceDescriptor;
  readonly state: GeoServicesDiscoveryState;
  readonly retrievedAt: string;
  readonly sources: readonly SourceDiscoveryInspection[];
  readonly operations: readonly GeoServicesOperationDescriptor[];
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly provenance: readonly DiscoveryProvenance[];
  readonly diagnostics: readonly GeoServicesDiscoveryDiagnostic[];
}

/** Options for metadata-only GeoServices discovery. */
export interface GeoServicesDiscoveryOptions {
  readonly endpoint: string | URL;
  readonly client?: HonuaClient;
  readonly clientOptions?: Omit<HonuaClientOptions, "baseUrl">;
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
  /** Raw request cache directive; this facade does not own TTL/stale metadata caching. */
  readonly metadata?: GeoServicesMetadataRequestOptions;
}

interface InternalGeoServicesDiscovery {
  readonly service: GeoServicesServiceDescriptor;
  readonly retrievedAt: string;
  readonly sourceSnapshots: readonly ConnectDiscoverySourceSnapshot[];
  readonly operations: readonly GeoServicesOperationDescriptor[];
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly provenance: readonly DiscoveryProvenance[];
  readonly diagnostics: readonly GeoServicesDiscoveryDiagnostic[];
}

interface OperationMetadata {
  readonly name: string;
  readonly href?: string;
  readonly methods?: readonly ("GET" | "POST")[];
  readonly title?: string;
}

const EMPTY_FORMATS: GeoServicesFormatDescriptor = Object.freeze({
  query: Object.freeze([]),
  image: Object.freeze([]),
  input: Object.freeze([]),
  output: Object.freeze([]),
});
const EMPTY_LIMITS: GeoServicesLimitDescriptor = Object.freeze({});
const UNKNOWN_AUTHENTICATION: GeoServicesAuthenticationDescriptor = Object.freeze({
  requirement: "unknown",
  evidence: "none",
  schemes: Object.freeze([]),
});
const IMAGE_SDK_OPERATIONS = new Set(["query", "exportimage", "identify", "tile"]);
const GEOMETRY_SDK_OPERATIONS = new Set(["project", "buffer", "simplify", "intersect", "union", "clip", "difference"]);
const KNOWN_CANONICAL_OPERATION_IDS: Readonly<Record<string, string>> = Object.freeze({
  exportimage: "exportImage",
  submitjob: "submitJob",
});

/**
 * Discover a canonical FeatureServer, MapServer, ImageServer, GeometryServer,
 * or GPServer URL. Feature/Map/Image results may carry honest Source
 * inspections; Geometry/GP results carry operation descriptors only.
 *
 * @experimental
 */
export async function discoverGeoServices(options: GeoServicesDiscoveryOptions): Promise<GeoServicesDiscoveryResult> {
  throwIfAborted(options.signal);
  const target = normalizeGeoServicesEndpoint(options.endpoint);
  if (options.client && options.clientOptions) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Pass either client or clientOptions to discoverGeoServices(), not both.",
    );
  }
  if (options.client) assertClientEndpoint(options.client, target.clientBaseUrl);
  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: target.clientBaseUrl });
  const discovered = await discoverGeoServicesWithClient(client, target, options);
  const sources = Object.freeze(
    discovered.sourceSnapshots.map((source) => inspectSourceSnapshot(target.protocol, source, discovered.evidence)),
  );
  const sourceDiagnostics = sources.flatMap((source) =>
    source.diagnostics
      .filter((entry) => entry.code === "partial-discovery" || entry.code === "discovery-unavailable")
      .map(
        (entry): GeoServicesDiscoveryDiagnostic =>
          Object.freeze({
            code: entry.code === "partial-discovery" ? "partial-discovery" : "metadata-unavailable",
            severity: "warning",
            message: entry.message,
          }),
      ),
  );
  const diagnostics = uniqueDiagnostics([...discovered.diagnostics, ...sourceDiagnostics]);
  return Object.freeze({
    service: discovered.service,
    state: diagnostics.length > 0 ? "partial" : "complete",
    retrievedAt: discovered.retrievedAt,
    sources,
    operations: discovered.operations,
    evidence: discovered.evidence,
    provenance: discovered.provenance,
    diagnostics,
  });
}

/** @internal Shared with connect() so ImageServer discovery has one implementation. */
export async function discoverGeoServicesWithClient(
  client: HonuaClient,
  target: NormalizedGeoServicesEndpoint,
  options: Pick<GeoServicesDiscoveryOptions, "signal" | "refresh" | "metadata">,
): Promise<InternalGeoServicesDiscovery> {
  throwIfAborted(options.signal);
  if (target.protocol === "geoservices-feature-service" || target.protocol === "geoservices-map-service") {
    const discovered = await discoverGeoServicesSources(client, sourceTarget(target), options);
    const provenance = uniqueProvenance(
      discovered.sources.flatMap((source) => evidenceProvenance(source.evidence ?? [])),
    );
    return Object.freeze({
      service: baseServiceDescriptor(target, {
        sourceBacked: true,
        authentication: UNKNOWN_AUTHENTICATION,
      }),
      retrievedAt: discovered.retrievedAt,
      sourceSnapshots: discovered.sources,
      operations: Object.freeze([]),
      evidence: Object.freeze([]),
      provenance,
      diagnostics: Object.freeze([]),
    });
  }
  if (target.protocol === "geoservices-image-service") return discoverImageService(client, target, options);
  if (target.protocol === "geoservices-geometry-service") return discoverGeometryService(client, target, options);
  return discoverGpService(client, target, options);
}

function sourceTarget(target: NormalizedGeoServicesEndpoint): ConnectTarget {
  if (
    target.protocol !== "geoservices-feature-service" &&
    target.protocol !== "geoservices-map-service" &&
    target.protocol !== "geoservices-image-service"
  ) {
    throw new HonuaDiscoveryError("unsupported-protocol", `${target.protocol} is not Source-backed.`);
  }
  return {
    endpoint: target.endpoint,
    clientBaseUrl: target.clientBaseUrl,
    protocol: target.protocol,
    serviceId: target.serviceId,
    ...(target.layerId !== undefined ? { layerId: target.layerId } : {}),
  };
}

async function discoverImageService(
  client: HonuaClient,
  target: NormalizedGeoServicesEndpoint,
  options: Pick<GeoServicesDiscoveryOptions, "signal" | "refresh" | "metadata">,
): Promise<InternalGeoServicesDiscovery> {
  const discovered = await discoverGeoServicesImageSources(client, sourceTarget(target), options);
  const { retrievedAt } = discovered;
  const provenance = Object.freeze([Object.freeze({ source: discovered.metadataSource, retrievedAt })]);
  throwIfAborted(options.signal);
  if (discovered.securedStatusCode !== undefined) {
    const reason = `ImageServer metadata requires authorization (status ${discovered.securedStatusCode}); no operation support was inferred.`;
    return Object.freeze({
      service: baseServiceDescriptor(target, {
        sourceBacked: false,
        authentication: securedAuthentication(discovered.securedStatusCode),
      }),
      retrievedAt,
      sourceSnapshots: Object.freeze([]),
      operations: Object.freeze([]),
      evidence: discovered.evidence,
      provenance,
      diagnostics: Object.freeze([
        diagnostic("authentication-required", reason),
        diagnostic("partial-discovery", "ImageServer identity is known from the URL but metadata is unavailable."),
      ]),
    });
  }

  const metadata = discovered.metadata;
  if (!metadata) throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer metadata was not retained.");
  const formats = formatsFromMetadata(metadata);
  const crs = crsFromMetadata(metadata);
  const limits = limitsFromMetadata(metadata);
  const authentication = authenticationFromMetadata(metadata, target.serviceUrl);
  const operationsMetadata = readOperationMetadata(metadata);
  const source = discovered.sources[0];
  const operationNames = new Set(operationsMetadata.map((operation) => canonicalOperationId(operation.name)));
  const capabilities = metadataTokens(metadata);
  if (capabilities.has("catalog") || capabilities.has("query")) operationNames.add("query");
  if (capabilities.has("image")) {
    operationNames.add("exportImage");
    operationNames.add("identify");
  }
  if (isRecord(readOptional(metadata, "tileInfo"))) operationNames.add("tile");
  const operations = Object.freeze(
    [...operationNames].sort(compareCodeUnits).map((operation) => {
      const advertised = findOperation(operationsMetadata, operation);
      const path = operation === "tile" ? "tile/{level}/{row}/{col}" : operation;
      const template = operation === "tile";
      const href = resolveOperationHref(target.serviceUrl, advertised?.href, path, template);
      const methods = advertised?.methods ?? (template ? ["GET"] : ["GET", "POST"]);
      const adapterHref = resolveOperationHref(target.serviceUrl, undefined, path, template);
      return operationDescriptor({
        id: operation,
        kind: "image",
        operation,
        ...(source ? { sourceId: source.id } : {}),
        href,
        methods,
        execution: "synchronous",
        sdkSupported:
          IMAGE_SDK_OPERATIONS.has(operation.toLowerCase()) &&
          href === adapterHref &&
          (template ? methods.includes("GET") : methods.length > 0),
        formats,
        crs,
        limits,
        provenance,
      });
    }),
  );
  const diagnostics =
    operations.length === 0 && discovered.evidence.some((entry) => entry.kind === "unavailable")
      ? Object.freeze([
          diagnostic(
            "metadata-unavailable",
            "ImageServer metadata did not advertise source or operation support; no capabilities were inferred.",
          ),
        ])
      : Object.freeze([]);
  return Object.freeze({
    service: baseServiceDescriptor(target, {
      sourceBacked: source !== undefined,
      title: stringValue(metadata, "name"),
      description: stringValue(metadata, "serviceDescription") ?? stringValue(metadata, "description"),
      formats,
      crs,
      limits,
      authentication,
    }),
    retrievedAt,
    sourceSnapshots: discovered.sources,
    operations,
    evidence: discovered.evidence,
    provenance,
    diagnostics,
  });
}

async function discoverGeometryService(
  client: HonuaClient,
  target: NormalizedGeoServicesEndpoint,
  options: Pick<GeoServicesDiscoveryOptions, "signal" | "refresh" | "metadata">,
): Promise<InternalGeoServicesDiscovery> {
  const retrievedAt = new Date().toISOString();
  const outcome = await getMetadata(client, target, target.serviceUrl, options);
  throwIfAborted(options.signal);
  const provenance = Object.freeze([Object.freeze({ source: outcome.source, retrievedAt })]);
  if (outcome.kind === "secured") {
    const reason = `GeometryServer metadata requires authorization (HTTP ${outcome.statusCode}); operation availability is unknown.`;
    return Object.freeze({
      service: baseServiceDescriptor(target, {
        sourceBacked: false,
        authentication: securedAuthentication(outcome.statusCode),
      }),
      retrievedAt,
      sourceSnapshots: Object.freeze([]),
      operations: Object.freeze([]),
      evidence: Object.freeze([]),
      provenance,
      diagnostics: Object.freeze([
        diagnostic("authentication-required", reason),
        diagnostic("partial-discovery", "GeometryServer identity is known from the URL but metadata is unavailable."),
      ]),
    });
  }
  const metadata = outcome.value;
  const formats = formatsFromMetadata(metadata);
  const crs = crsFromMetadata(metadata);
  const limits = limitsFromMetadata(metadata);
  const advertised = readOperationMetadata(metadata);
  const operations = Object.freeze(
    advertised
      .map((operation) => {
        const id = canonicalOperationId(operation.name);
        const href = resolveOperationHref(target.serviceUrl, operation.href, id);
        const methods = operation.methods ?? ["GET", "POST"];
        const adapterHref = resolveOperationHref(target.serviceUrl, undefined, id);
        return operationDescriptor({
          id,
          kind: "geometry",
          operation: id,
          title: operation.title,
          href,
          methods,
          execution: "synchronous",
          sdkSupported:
            target.serviceId === "Utilities/Geometry" &&
            href === adapterHref &&
            methods.length > 0 &&
            GEOMETRY_SDK_OPERATIONS.has(id.toLowerCase()),
          formats,
          crs,
          limits,
          provenance,
        });
      })
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
  );
  const diagnostics =
    operations.length === 0
      ? Object.freeze([
          diagnostic(
            "metadata-unavailable",
            "GeometryServer metadata did not advertise a supportedOperations/operations list; no operations were inferred.",
          ),
        ])
      : Object.freeze([]);
  return Object.freeze({
    service: baseServiceDescriptor(target, {
      sourceBacked: false,
      title: stringValue(metadata, "name"),
      description: stringValue(metadata, "serviceDescription") ?? stringValue(metadata, "description"),
      formats,
      crs,
      limits,
      authentication: authenticationFromMetadata(metadata, target.serviceUrl),
    }),
    retrievedAt,
    sourceSnapshots: Object.freeze([]),
    operations,
    evidence: Object.freeze([]),
    provenance,
    diagnostics,
  });
}

async function discoverGpService(
  client: HonuaClient,
  target: NormalizedGeoServicesEndpoint,
  options: Pick<GeoServicesDiscoveryOptions, "signal" | "refresh" | "metadata">,
): Promise<InternalGeoServicesDiscovery> {
  const retrievedAt = new Date().toISOString();
  if (target.taskName) {
    const selected = await discoverGpTask(client, target, target.taskName, target.endpoint, options, retrievedAt);
    const diagnostics = selected.diagnostic ? Object.freeze([selected.diagnostic]) : Object.freeze([]);
    return Object.freeze({
      service: baseServiceDescriptor(target, {
        sourceBacked: false,
        authentication: selected.authentication,
      }),
      retrievedAt,
      sourceSnapshots: Object.freeze([]),
      operations: Object.freeze([selected.operation]),
      evidence: Object.freeze([]),
      provenance: selected.operation.provenance,
      diagnostics,
    });
  }

  const outcome = await getMetadata(client, target, target.serviceUrl, options);
  throwIfAborted(options.signal);
  const rootProvenance = Object.freeze([Object.freeze({ source: outcome.source, retrievedAt })]);
  if (outcome.kind === "secured") {
    const reason = `GPServer metadata requires authorization (HTTP ${outcome.statusCode}); task availability is unknown.`;
    return Object.freeze({
      service: baseServiceDescriptor(target, {
        sourceBacked: false,
        authentication: securedAuthentication(outcome.statusCode),
      }),
      retrievedAt,
      sourceSnapshots: Object.freeze([]),
      operations: Object.freeze([]),
      evidence: Object.freeze([]),
      provenance: rootProvenance,
      diagnostics: Object.freeze([
        diagnostic("authentication-required", reason),
        diagnostic("partial-discovery", "GPServer identity is known from the URL but task metadata is unavailable."),
      ]),
    });
  }

  const metadata = outcome.value;
  const tasksAdvertised = readOptional(metadata, "tasks") !== undefined;
  const tasks = readGpTasks(metadata, target.serviceUrl);
  const discoveredTasks = await mapWithConcurrency(tasks, 4, (task) =>
    discoverGpTask(client, target, task.name, task.href, options, retrievedAt),
  );
  throwIfAborted(options.signal);
  const taskDiagnostics = discoveredTasks.flatMap((task) => (task.diagnostic ? [task.diagnostic] : []));
  const diagnostics = !tasksAdvertised
    ? Object.freeze([
        diagnostic(
          "metadata-unavailable",
          "GPServer metadata did not advertise a tasks list; no task availability was inferred.",
        ),
      ])
    : taskDiagnostics.length > 0
      ? Object.freeze([
          ...taskDiagnostics,
          diagnostic("partial-discovery", "One or more advertised GPServer tasks could not be fully described."),
        ])
      : Object.freeze([]);
  const taskAuth = discoveredTasks.map((task) => task.authentication);
  return Object.freeze({
    service: baseServiceDescriptor(target, {
      sourceBacked: false,
      title: stringValue(metadata, "name"),
      description: stringValue(metadata, "serviceDescription") ?? stringValue(metadata, "description"),
      formats: formatsFromMetadata(metadata),
      crs: crsFromMetadata(metadata),
      limits: limitsFromMetadata(metadata),
      authentication: combineAuthentication(authenticationFromMetadata(metadata, target.serviceUrl), taskAuth),
    }),
    retrievedAt,
    sourceSnapshots: Object.freeze([]),
    operations: Object.freeze(discoveredTasks.map((task) => task.operation)),
    evidence: Object.freeze([]),
    provenance: uniqueProvenance([rootProvenance, ...discoveredTasks.map((task) => task.operation.provenance)].flat()),
    diagnostics,
  });
}

async function discoverGpTask(
  client: HonuaClient,
  target: NormalizedGeoServicesEndpoint,
  taskName: string,
  taskHref: string,
  options: Pick<GeoServicesDiscoveryOptions, "signal" | "refresh" | "metadata">,
  retrievedAt: string,
): Promise<{
  readonly operation: GeoServicesOperationDescriptor;
  readonly authentication: GeoServicesAuthenticationDescriptor;
  readonly diagnostic?: GeoServicesDiscoveryDiagnostic;
}> {
  const requestedProvenance = Object.freeze([Object.freeze({ source: taskHref, retrievedAt })]);
  try {
    const outcome = await getMetadata(client, target, taskHref, options);
    throwIfAborted(options.signal);
    const provenance = Object.freeze([Object.freeze({ source: outcome.source, retrievedAt })]);
    if (outcome.kind === "secured") {
      return Object.freeze({
        operation: unavailableGpTask(taskName, taskHref, provenance),
        authentication: securedAuthentication(outcome.statusCode),
        diagnostic: diagnostic(
          "operation-metadata-unavailable",
          `GPServer task "${taskName}" requires authorization (HTTP ${outcome.statusCode}).`,
          taskName,
        ),
      });
    }
    const metadata = outcome.value;
    const execution = executionFromMetadata(metadata);
    const operation = execution === "asynchronous" ? "submitJob" : execution === "synchronous" ? "execute" : "task";
    const href = operation === "task" ? taskHref : resolveOperationHref(taskHref, undefined, operation);
    const canonicalTaskHref = resolveOperationHref(target.serviceUrl, undefined, encodeURIComponent(taskName));
    const canonicalOperationHref =
      operation === "task" ? canonicalTaskHref : resolveOperationHref(canonicalTaskHref, undefined, operation);
    return Object.freeze({
      operation: operationDescriptor({
        id: taskName,
        kind: "process",
        operation,
        title: stringValue(metadata, "displayName") ?? stringValue(metadata, "name") ?? taskName,
        taskName,
        href,
        methods: Object.freeze(["POST"]),
        execution,
        sdkSupported: execution === "asynchronous" && taskHref === canonicalTaskHref && href === canonicalOperationHref,
        formats: formatsFromMetadata(metadata),
        crs: crsFromMetadata(metadata),
        limits: limitsFromMetadata(metadata),
        provenance,
        ...(execution === "asynchronous" ? { jobLifecycle: gpLifecycle(taskHref) } : {}),
      }),
      authentication: authenticationFromMetadata(metadata, taskHref),
    });
  } catch (error) {
    if (options.signal?.aborted || error instanceof HonuaAbortError) throw error;
    return Object.freeze({
      operation: unavailableGpTask(taskName, taskHref, requestedProvenance),
      authentication: UNKNOWN_AUTHENTICATION,
      diagnostic: diagnostic(
        "operation-metadata-unavailable",
        `GPServer task "${taskName}" metadata was unavailable; execution semantics were not inferred.`,
        taskName,
      ),
    });
  }
}

function unavailableGpTask(
  taskName: string,
  taskHref: string,
  provenance: readonly DiscoveryProvenance[],
): GeoServicesOperationDescriptor {
  return operationDescriptor({
    id: taskName,
    kind: "process",
    operation: "task",
    title: taskName,
    taskName,
    href: taskHref,
    methods: Object.freeze([]),
    availability: "unavailable",
    execution: "unknown",
    sdkSupported: false,
    formats: EMPTY_FORMATS,
    crs: Object.freeze([]),
    limits: EMPTY_LIMITS,
    provenance,
  });
}

function inspectSourceSnapshot(
  protocol: GeoServicesServiceProtocol,
  source: ConnectDiscoverySourceSnapshot,
  sharedEvidence: readonly DiscoveryCapabilityEvidence[],
): SourceDiscoveryInspection {
  const evidence = source.evidence ?? sharedEvidence;
  const resolution = resolveDiscoveryCapabilities(protocol, evidence);
  const descriptor: SourceDescriptor = Object.freeze({
    id: source.id,
    protocol,
    locator: source.locator,
    capabilities: resolution.capabilities,
    ...(source.schema ? { schema: source.schema } : {}),
    ...(source.schemaV2 ? { schemaV2: source.schemaV2 } : {}),
    ...(source.title ? { attribution: source.title } : {}),
  });
  return inspectDiscoveredSource(descriptor, resolution);
}

function baseServiceDescriptor(
  target: NormalizedGeoServicesEndpoint,
  values: {
    readonly sourceBacked: boolean;
    readonly title?: string;
    readonly description?: string;
    readonly formats?: GeoServicesFormatDescriptor;
    readonly crs?: readonly GeoServicesCrsDescriptor[];
    readonly limits?: GeoServicesLimitDescriptor;
    readonly authentication: GeoServicesAuthenticationDescriptor;
  },
): GeoServicesServiceDescriptor {
  return Object.freeze({
    kind: "geoservices-service" as const,
    serviceKind: target.serviceKind,
    protocol: target.protocol,
    endpoint: target.serviceUrl,
    clientBaseUrl: target.clientBaseUrl,
    serviceId: target.serviceId,
    ...(target.layerId !== undefined ? { layerId: target.layerId } : {}),
    ...(target.taskName !== undefined ? { taskName: target.taskName } : {}),
    ...(values.title ? { title: values.title } : {}),
    ...(values.description ? { description: values.description } : {}),
    sourceBacked: values.sourceBacked,
    formats: values.formats ?? EMPTY_FORMATS,
    crs: values.crs ?? Object.freeze([]),
    limits: values.limits ?? EMPTY_LIMITS,
    authentication: values.authentication,
  });
}

function operationDescriptor(
  values: Omit<GeoServicesOperationDescriptor, "availability"> & {
    readonly availability?: GeoServicesOperationAvailability;
  },
): GeoServicesOperationDescriptor {
  return Object.freeze({ ...values, availability: values.availability ?? "advertised" });
}

async function getMetadata(
  client: HonuaClient,
  target: NormalizedGeoServicesEndpoint,
  endpoint: string,
  options: Pick<GeoServicesDiscoveryOptions, "signal" | "refresh" | "metadata">,
): ReturnType<typeof getGeoServicesMetadata> {
  return getGeoServicesMetadata(client, target.clientBaseUrl, endpoint, options);
}

function readOperationMetadata(metadata: Readonly<Record<string, unknown>>): readonly OperationMetadata[] {
  const values: OperationMetadata[] = [];
  for (const key of ["supportedOperations", "operations"] as const) {
    const raw = readOptional(metadata, key);
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices ${key} metadata must be an array.`);
    }
    if (raw.length > 1_000) {
      throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices ${key} metadata exceeds the operation limit.`);
    }
    for (const entry of raw) {
      if (typeof entry === "string" && entry.trim()) {
        values.push(Object.freeze({ name: boundedString(entry, `${key} operation`) }));
        continue;
      }
      const object = requireRecord(entry, `GeoServices ${key} operation`);
      const name = stringValue(object, "name") ?? stringValue(object, "id");
      if (!name) {
        throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices ${key} operation is missing a name.`);
      }
      const href = stringValue(object, "href") ?? stringValue(object, "url");
      values.push(
        Object.freeze({
          name,
          ...(href ? { href } : {}),
          ...(stringValue(object, "title") ? { title: stringValue(object, "title") } : {}),
          ...(readMethods(object) ? { methods: readMethods(object) } : {}),
        }),
      );
    }
  }
  const unique = new Map<string, OperationMetadata>();
  for (const operation of values) unique.set(canonicalOperationId(operation.name).toLowerCase(), operation);
  return Object.freeze([...unique.values()]);
}

function readGpTasks(
  metadata: Readonly<Record<string, unknown>>,
  serviceUrl: string,
): readonly { readonly name: string; readonly href: string }[] {
  const raw = readOptional(metadata, "tasks");
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw))
    throw new HonuaDiscoveryError("invalid-endpoint", "GPServer tasks metadata must be an array.");
  if (raw.length > 1_000)
    throw new HonuaDiscoveryError("invalid-endpoint", "GPServer tasks metadata exceeds the task limit.");
  const seen = new Set<string>();
  return Object.freeze(
    raw.map((entry) => {
      const name =
        typeof entry === "string"
          ? boundedString(entry, "GPServer task name")
          : (stringValue(requireRecord(entry, "GPServer task"), "name") ??
            stringValue(requireRecord(entry, "GPServer task"), "id"));
      if (!name || seen.has(name)) {
        throw new HonuaDiscoveryError("invalid-endpoint", "GPServer task names must be unique non-empty strings.");
      }
      seen.add(name);
      const hrefValue =
        typeof entry === "string"
          ? undefined
          : (stringValue(requireRecord(entry, "GPServer task"), "href") ??
            stringValue(requireRecord(entry, "GPServer task"), "url"));
      return Object.freeze({
        name,
        href: resolveOperationHref(serviceUrl, hrefValue, encodeURIComponent(name)),
      });
    }),
  );
}

function resolveOperationHref(
  serviceUrl: string,
  advertised: string | undefined,
  fallback: string,
  template = false,
): string {
  if (!advertised && template) return `${serviceUrl.replace(/\/$/, "")}/${fallback}`;
  let resolved: URL;
  try {
    resolved = new URL(advertised ?? fallback, `${serviceUrl.replace(/\/$/, "")}/`);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata contains an invalid operation URL.");
  }
  const root = new URL(serviceUrl);
  const removableFormat = [...resolved.searchParams].every(
    ([name, value]) =>
      (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
      (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
  );
  if (
    resolved.origin !== root.origin ||
    resolved.username ||
    resolved.password ||
    resolved.hash ||
    (resolved.search && !removableFormat) ||
    (resolved.pathname !== root.pathname && !resolved.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`))
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices operation URLs must stay within the credential-free service root.",
    );
  }
  if (resolved.search) resolved.search = "";
  const normalized = resolved.toString().replace(/\/$/, "");
  if (!template) return normalized;
  const restored = normalized.replace(/%7B(level|row|col)%7D/gi, (_match, name: string) => `{${name.toLowerCase()}}`);
  if (
    !["level", "row", "col"].every((name) => restored.includes(`{${name}}`)) ||
    /%7B|%7D|[{}]/i.test(restored.replace(/\{(?:level|row|col)\}/g, ""))
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices tile operation templates require exactly the level, row, and col placeholders.",
    );
  }
  return restored;
}

function formatsFromMetadata(metadata: Readonly<Record<string, unknown>>): GeoServicesFormatDescriptor {
  return Object.freeze({
    query: stringList(metadata, ["supportedQueryFormats", "queryFormats"]),
    image: stringList(metadata, ["supportedImageFormatTypes", "imageFormats"]),
    input: stringList(metadata, ["supportedInputFormats", "inputFormats"]),
    output: stringList(metadata, ["supportedOutputFormats", "outputFormats"]),
  });
}

function crsFromMetadata(metadata: Readonly<Record<string, unknown>>): readonly GeoServicesCrsDescriptor[] {
  const candidates = [
    readOptional(metadata, "spatialReference"),
    isRecord(readOptional(metadata, "fullExtent"))
      ? readOptional(readOptional(metadata, "fullExtent") as Readonly<Record<string, unknown>>, "spatialReference")
      : undefined,
    isRecord(readOptional(metadata, "extent"))
      ? readOptional(readOptional(metadata, "extent") as Readonly<Record<string, unknown>>, "spatialReference")
      : undefined,
    isRecord(readOptional(metadata, "tileInfo"))
      ? readOptional(readOptional(metadata, "tileInfo") as Readonly<Record<string, unknown>>, "spatialReference")
      : undefined,
  ];
  const unique = new Map<string, GeoServicesCrsDescriptor>();
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const wkid = positiveIntegerValue(candidate, "wkid");
    const latestWkid = positiveIntegerValue(candidate, "latestWkid");
    const wkt = stringValue(candidate, "wkt");
    if (wkid === undefined && latestWkid === undefined && !wkt) continue;
    const epsgCode = validatedEpsgCode(candidate, wkid, latestWkid);
    const descriptor = Object.freeze({
      ...(wkid !== undefined ? { wkid } : {}),
      ...(latestWkid !== undefined ? { latestWkid } : {}),
      ...(epsgCode !== undefined ? { authority: "EPSG" as const, code: epsgCode } : {}),
      ...(wkt ? { wkt } : {}),
    });
    unique.set(JSON.stringify(descriptor), descriptor);
  }
  return Object.freeze([...unique.values()]);
}

const VERIFIED_DIRECT_EPSG_CODES = new Set([3857, 4269, 4326]);
const VERIFIED_ESRI_LEGACY_EPSG_ALIASES = new Map([
  [102100, 3857],
  [102113, 3857],
]);

function validatedEpsgCode(
  metadata: Readonly<Record<string, unknown>>,
  wkid: number | undefined,
  latestWkid: number | undefined,
): number | undefined {
  const authority = stringValue(metadata, "authority")?.toUpperCase();
  if (authority === "EPSG") return latestWkid ?? wkid;
  if (wkid !== undefined) {
    const verifiedAlias = VERIFIED_ESRI_LEGACY_EPSG_ALIASES.get(wkid);
    if (verifiedAlias !== undefined && latestWkid === verifiedAlias) return verifiedAlias;
    if (VERIFIED_DIRECT_EPSG_CODES.has(wkid) && (latestWkid === undefined || latestWkid === wkid)) return wkid;
  }
  if (wkid === undefined && latestWkid !== undefined && VERIFIED_DIRECT_EPSG_CODES.has(latestWkid)) {
    return latestWkid;
  }
  return undefined;
}

function limitsFromMetadata(metadata: Readonly<Record<string, unknown>>): GeoServicesLimitDescriptor {
  const values = {
    maxRecordCount: nonNegativeIntegerValue(metadata, "maxRecordCount"),
    maxImageWidth: nonNegativeIntegerValue(metadata, "maxImageWidth"),
    maxImageHeight: nonNegativeIntegerValue(metadata, "maxImageHeight"),
    maxMosaicImageCount: nonNegativeIntegerValue(metadata, "maxMosaicImageCount"),
    maxDownloadImageCount: nonNegativeIntegerValue(metadata, "maxDownloadImageCount"),
  };
  return Object.freeze(
    Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined)),
  );
}

function authenticationFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
  serviceUrl: string,
): GeoServicesAuthenticationDescriptor {
  const authInfo = readOptional(metadata, "authInfo");
  if (authInfo !== undefined && authInfo !== null && !isRecord(authInfo)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices authInfo metadata must be an object.");
  }
  const record = isRecord(authInfo) ? authInfo : metadata;
  const required =
    readOptional(record, "isTokenBasedSecurity") ??
    readOptional(record, "requiresToken") ??
    readOptional(record, "secured");
  if (required !== undefined && required !== null && typeof required !== "boolean") {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices authentication requirement must be boolean.");
  }
  const rawTokenUrl = stringValue(record, "tokenServicesUrl") ?? stringValue(record, "tokenServiceUrl");
  let tokenServiceUrl: string | undefined;
  if (rawTokenUrl) tokenServiceUrl = normalizeTokenServiceUrl(rawTokenUrl, serviceUrl);
  const requirement = required === true ? "required" : required === false ? "not-required" : "unknown";
  return Object.freeze({
    requirement,
    evidence: requirement === "unknown" ? "none" : "metadata",
    schemes: Object.freeze(requirement === "required" ? ["token"] : []),
    ...(tokenServiceUrl ? { tokenServiceUrl } : {}),
  });
}

function securedAuthentication(statusCode: number): GeoServicesAuthenticationDescriptor {
  return Object.freeze({
    requirement: "required",
    evidence: "http-status",
    statusCode,
    schemes: Object.freeze([]),
  });
}

function combineAuthentication(
  root: GeoServicesAuthenticationDescriptor,
  children: readonly GeoServicesAuthenticationDescriptor[],
): GeoServicesAuthenticationDescriptor {
  const all = [root, ...children];
  const required = all.find((entry) => entry.requirement === "required");
  if (required) return required;
  if (all.every((entry) => entry.requirement === "not-required")) return root;
  return all.find((entry) => entry.requirement === "unknown") ?? UNKNOWN_AUTHENTICATION;
}

function normalizeTokenServiceUrl(value: string, serviceUrl: string): string {
  let url: URL;
  try {
    url = new URL(value, `${serviceUrl.replace(/\/$/, "")}/`);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices authInfo contains an invalid token service URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices token service URLs must be credential-free absolute HTTP(S) URLs.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function executionFromMetadata(metadata: Readonly<Record<string, unknown>>): GeoServicesOperationExecution {
  const execution = stringValue(metadata, "executionType")?.toLowerCase();
  if (execution === "esriexecutiontypeasynchronous" || execution === "asynchronous" || execution === "async") {
    return "asynchronous";
  }
  if (execution === "esriexecutiontypesynchronous" || execution === "synchronous" || execution === "sync") {
    return "synchronous";
  }
  return "unknown";
}

function gpLifecycle(taskHref: string): GeoServicesOperationDescriptor["jobLifecycle"] {
  const root = taskHref.replace(/\/$/, "");
  return Object.freeze({
    statusHrefTemplate: `${root}/jobs/{jobId}`,
    resultHrefTemplate: `${root}/jobs/{jobId}/results/{resultName}`,
    cancelHrefTemplate: `${root}/jobs/{jobId}/cancel`,
  });
}

function readMethods(metadata: Readonly<Record<string, unknown>>): readonly ("GET" | "POST")[] | undefined {
  const raw = readOptional(metadata, "methods");
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw))
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices operation methods must be an array.");
  const methods = uniqueStrings(
    raw.map((value) => {
      if (typeof value !== "string" || !["GET", "POST"].includes(value.toUpperCase())) {
        throw new HonuaDiscoveryError(
          "invalid-endpoint",
          "GeoServices operation methods may contain only GET or POST.",
        );
      }
      return value.toUpperCase();
    }),
  ) as ("GET" | "POST")[];
  return Object.freeze(methods);
}

function metadataTokens(metadata: Readonly<Record<string, unknown>>): Set<string> {
  const raw = readOptional(metadata, "capabilities");
  if (raw === undefined) return new Set();
  if (typeof raw !== "string") {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices capabilities metadata must be a string.");
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function stringList(metadata: Readonly<Record<string, unknown>>, keys: readonly string[]): readonly string[] {
  const output: string[] = [];
  for (const key of keys) {
    const value = readOptional(metadata, key);
    if (value === undefined) continue;
    if (typeof value === "string") {
      output.push(
        ...value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      output.push(...value.map((entry) => entry.trim()).filter(Boolean));
      continue;
    }
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices ${key} metadata must be a string or string array.`);
  }
  return Object.freeze(uniqueStrings(output));
}

function findOperation(operations: readonly OperationMetadata[], id: string): OperationMetadata | undefined {
  const canonical = id.toLowerCase();
  return operations.find((operation) => canonicalOperationId(operation.name).toLowerCase() === canonical);
}

function canonicalOperationId(value: string): string {
  const words = boundedString(value, "operation name")
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices operation name is invalid.");
  if (words.length === 1) {
    const word = words[0] as string;
    if (word === word.toUpperCase() || word === word.toLowerCase()) {
      const normalized = word.toLowerCase();
      return KNOWN_CANONICAL_OPERATION_IDS[normalized] ?? normalized;
    }
    return `${word.charAt(0).toLowerCase()}${word.slice(1)}`;
  }
  return `${words[0]?.toLowerCase()}${words
    .slice(1)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join("")}`;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOptional(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if ("get" in descriptor) {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" must be data.`);
  }
  return descriptor.value;
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = readOptional(record, key);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" must be a string.`);
  }
  return boundedString(value, key);
}

function boundedString(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_384) {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices ${label} must be a bounded non-empty string.`);
  }
  return trimmed;
}

function finiteIntegerValue(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = readOptional(record, key);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" must be a safe integer.`);
  }
  return value as number;
}

function nonNegativeIntegerValue(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = finiteIntegerValue(record, key);
  if (value !== undefined && value < 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" cannot be negative.`);
  }
  return value;
}

function positiveIntegerValue(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = finiteIntegerValue(record, key);
  if (value !== undefined && value <= 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" must be positive.`);
  }
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceProvenance(evidence: readonly DiscoveryCapabilityEvidence[]): readonly DiscoveryProvenance[] {
  return evidence.flatMap((entry) => [...(entry.provenance ?? [])]);
}

function uniqueProvenance(values: readonly DiscoveryProvenance[]): readonly DiscoveryProvenance[] {
  const unique = new Map<string, DiscoveryProvenance>();
  for (const value of values)
    unique.set(`${value.source}\0${value.retrievedAt ?? ""}\0${value.validator ?? ""}`, value);
  return Object.freeze([...unique.values()]);
}

function diagnostic(
  code: GeoServicesDiscoveryDiagnosticCode,
  message: string,
  operationId?: string,
): GeoServicesDiscoveryDiagnostic {
  return Object.freeze({ code, severity: "warning" as const, message, ...(operationId ? { operationId } : {}) });
}

function uniqueDiagnostics(
  values: readonly GeoServicesDiscoveryDiagnostic[],
): readonly GeoServicesDiscoveryDiagnostic[] {
  const unique = new Map<string, GeoServicesDiscoveryDiagnostic>();
  for (const value of values) unique.set(`${value.code}\0${value.operationId ?? ""}\0${value.message}`, value);
  return Object.freeze([...unique.values()]);
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return output;
}

function assertClientEndpoint(client: HonuaClient, endpoint: string): void {
  const actual = new URL(client.serverBaseUrl).toString().replace(/\/$/, "");
  const expected = new URL(endpoint).toString().replace(/\/$/, "");
  if (actual !== expected) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "The injected HonuaClient base URL must exactly match the GeoServices client root.",
      { endpoint: expected, clientEndpoint: actual },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
