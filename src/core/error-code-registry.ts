/**
 * Canonical descriptive registry for public Honua SDK error codes.
 *
 * The error base consumes a compact classification table so focused SDK
 * entrypoints do not retain these human-readable summaries. The registry
 * remains the public documentation source of truth; `check:error-codes`
 * verifies the compact table against every descriptor.
 */
export type HonuaErrorDomain =
  | "core"
  | "discovery"
  | "query"
  | "map"
  | "runtime"
  | "realtime"
  | "offline"
  | "plugin"
  | "agent"
  | "app";

export type HonuaErrorCategory =
  | "authentication"
  | "cancellation"
  | "capability"
  | "internal"
  | "network"
  | "protocol"
  | "timeout"
  | "validation";

export interface HonuaErrorCodeDescriptor {
  readonly domain: HonuaErrorDomain;
  readonly category: HonuaErrorCategory;
  readonly retryable: boolean;
  readonly summary: string;
}

/**
 * Canonical public code registry. Object keys make duplicate codes a compile
 * error; the base constructor rejects codes absent from this registry.
 */
export const HONUA_ERROR_CODE_REGISTRY = Object.freeze({
  "core.http.transient": classification("core", "protocol", true, "Retryable HTTP response failure"),
  "core.http.rejected": classification("core", "protocol", false, "Non-retryable HTTP response failure"),
  "core.timeout": classification("core", "timeout", true, "Request deadline elapsed"),
  "core.network": classification("core", "network", true, "Network transport failure"),
  "core.cancelled": classification("core", "cancellation", false, "Caller cancelled the operation"),
  "core.grpc.transient": classification("core", "protocol", true, "Retryable gRPC-Web transport failure"),
  "core.grpc.rejected": classification("core", "protocol", false, "Non-retryable gRPC-Web transport failure"),
  "core.geometry.unknown-geometry": classification(
    "core",
    "validation",
    false,
    "Geometry shape cannot be classified safely",
  ),
  "core.geometry.malformed-geometry": classification(
    "core",
    "validation",
    false,
    "Recognized geometry has invalid coordinates or structure",
  ),
  "core.auth.interaction-required": classification(
    "core",
    "authentication",
    false,
    "Interactive authentication is required",
  ),
  "core.auth.refresh-failed": classification("core", "authentication", true, "Credential refresh failed transiently"),
  "core.auth.invalid-grant": classification(
    "core",
    "authentication",
    false,
    "Authorization grant is invalid or expired",
  ),
  "core.capability-not-supported": classification(
    "core",
    "capability",
    false,
    "Requested source capability is unavailable",
  ),
  "core.exploration-context": classification("core", "validation", false, "Exploration context operation is invalid"),
  "core.wfs-exception": classification("core", "protocol", false, "WFS exception report"),
  "core.job-failed": classification("core", "protocol", false, "Remote job reached a failed terminal state"),
  "core.wms-capabilities-parse": classification("core", "protocol", false, "WMS capabilities document is invalid"),
  "core.wmts-capabilities-parse": classification("core", "protocol", false, "WMTS capabilities document is invalid"),
  "discovery.ambiguous-protocol": classification(
    "discovery",
    "validation",
    false,
    "Multiple protocols match the endpoint",
  ),
  "discovery.ambiguous-source": classification(
    "discovery",
    "validation",
    false,
    "Multiple sources match the selection",
  ),
  "discovery.invalid-endpoint": classification("discovery", "validation", false, "Discovery endpoint is invalid"),
  "discovery.invalid-cache-identity": classification(
    "discovery",
    "validation",
    false,
    "Discovery cache identity is invalid",
  ),
  "discovery.invalid-discovery-cache": classification(
    "discovery",
    "validation",
    false,
    "Discovery cache entry is invalid",
  ),
  "discovery.invalid-capability": classification(
    "discovery",
    "validation",
    false,
    "Discovered capability evidence is invalid",
  ),
  "discovery.unsupported-protocol": classification(
    "discovery",
    "capability",
    false,
    "Endpoint protocol is unsupported",
  ),
  "discovery.protocol-mismatch": classification(
    "discovery",
    "validation",
    false,
    "Endpoint protocol conflicts with its hint",
  ),
  "query.planning.invalid-query": classification("query", "validation", false, "Query is invalid"),
  "query.planning.unsupported-compiler": classification(
    "query",
    "capability",
    false,
    "No compiler supports the source protocol",
  ),
  "query.planning.unsupported-query": classification(
    "query",
    "capability",
    false,
    "Query cannot be represented by the compiler",
  ),
  "query.planning.capability-not-supported": classification(
    "query",
    "capability",
    false,
    "Query requires an unavailable capability",
  ),
  "query.planning.fallback-disabled": classification(
    "query",
    "capability",
    false,
    "Required local fallback is disabled",
  ),
  "query.planning.unsafe-materialization": classification(
    "query",
    "validation",
    false,
    "Planned local materialization exceeds its safety bound",
  ),
  "query.execution.invalid-plan": classification("query", "validation", false, "Query plan is invalid"),
  "query.execution.wfs-protocol": classification(
    "query",
    "protocol",
    false,
    "WFS protocol evidence or response is invalid",
  ),
  "query.execution.plan-context-mismatch": classification(
    "query",
    "validation",
    false,
    "Execution context does not match the accepted query plan",
  ),
  "query.execution.unsafe-materialization": classification(
    "query",
    "validation",
    false,
    "Query execution exceeded its materialization bound",
  ),
  "query.execution.invalid-resource-handle": classification(
    "query",
    "validation",
    false,
    "Query resource handle is invalid",
  ),
  "query.execution.resource-unavailable": classification(
    "query",
    "authentication",
    false,
    "Query resource is unavailable in the authorization context",
  ),
  "query.execution.resource-expired": classification(
    "query",
    "authentication",
    false,
    "Query resource authorization has expired",
  ),
  "query.execution.resource-resolution-failed": classification(
    "query",
    "internal",
    false,
    "Query resource resolution failed",
  ),
  "query.execution.resource-execution-failed": classification(
    "query",
    "internal",
    false,
    "Resolved query resource execution failed",
  ),
  "map.source-adapter.disposed": classification("map", "validation", false, "Map source adapter is disposed"),
  "map.source-adapter.source-conflict": classification(
    "map",
    "validation",
    false,
    "Map source identifier already exists",
  ),
  "map.source-adapter.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Map layer identifier already exists",
  ),
  "map.source-adapter.unsupported-plan": classification(
    "map",
    "capability",
    false,
    "Query plan cannot be rendered by the source adapter",
  ),
  "map.source-adapter.invalid-option": classification(
    "map",
    "validation",
    false,
    "Map source adapter option is invalid",
  ),
  "map.source-adapter.map-mutation-failed": classification("map", "internal", false, "Renderer mutation failed"),
  "map.data-bridge.invalid-option": classification("map", "validation", false, "Data-to-map option is invalid"),
  "map.data-bridge.disposed": classification("map", "validation", false, "Data-to-map bridge is disposed"),
  "map.data-bridge.source-conflict": classification(
    "map",
    "validation",
    false,
    "Data-to-map source identifier already exists",
  ),
  "map.data-bridge.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Data-to-map layer identifier already exists",
  ),
  "map.data-bridge.map-mutation-failed": classification(
    "map",
    "internal",
    false,
    "Data-to-map renderer mutation failed",
  ),
  "map.data-bridge.interaction-unsupported": classification(
    "map",
    "capability",
    false,
    "Renderer interaction is unsupported",
  ),
  "map.data-bridge.filter-unsupported": classification(
    "map",
    "capability",
    false,
    "Renderer filter mutation is unsupported",
  ),
  "map.automatic-strategy.no-eligible-strategy": classification(
    "map",
    "capability",
    false,
    "No exact map source strategy is eligible",
  ),
  "map.automatic-strategy.stale-plan": classification("map", "validation", false, "Map strategy plan is stale"),
  "map.automatic-strategy.source-conflict": classification(
    "map",
    "validation",
    false,
    "Automatic strategy source identifier already exists",
  ),
  "map.automatic-strategy.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Automatic strategy layer identifier already exists",
  ),
  "map.automatic-strategy.map-mutation-failed": classification(
    "map",
    "internal",
    false,
    "Automatic strategy renderer mutation failed",
  ),
  "map.automatic-strategy.cancelled": classification(
    "map",
    "cancellation",
    false,
    "Automatic map strategy was cancelled",
  ),
  "map.automatic-strategy.disposed": classification("map", "validation", false, "Automatic map strategy is disposed"),
  "map.raster-strategy.unsupported-strategy": classification(
    "map",
    "capability",
    false,
    "Raster strategy is unsupported",
  ),
  "map.raster-strategy.capability-mismatch": classification(
    "map",
    "capability",
    false,
    "Raster source lacks a required capability",
  ),
  "map.raster-strategy.missing-metadata": classification(
    "map",
    "validation",
    false,
    "Raster source metadata is incomplete",
  ),
  "map.raster-strategy.invalid-option": classification("map", "validation", false, "Raster option is invalid"),
  "map.raster-strategy.source-conflict": classification(
    "map",
    "validation",
    false,
    "Raster source identifier already exists",
  ),
  "map.raster-strategy.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Raster layer identifier already exists",
  ),
  "map.raster-strategy.map-mutation-failed": classification(
    "map",
    "internal",
    false,
    "Raster renderer mutation failed",
  ),
  "map.automatic-integration.disposed": classification(
    "map",
    "validation",
    false,
    "Automatic map integration is disposed",
  ),
  "map.automatic-integration.invalid-target": classification(
    "map",
    "validation",
    false,
    "Automatic map integration target is invalid",
  ),
  "map.temporal-playback.invalid-option": classification(
    "map",
    "validation",
    false,
    "Temporal playback option is invalid",
  ),
  "runtime.map-package.fetch": classification("runtime", "network", true, "Map package fetch failed"),
  "runtime.map-package.load": classification("runtime", "internal", false, "Map package load failed"),
  "runtime.map-package.validate": classification("runtime", "validation", false, "Map package validation failed"),
  "runtime.map-package.update": classification("runtime", "internal", false, "Map package update failed"),
  "runtime.map-package.style-compose": classification(
    "runtime",
    "validation",
    false,
    "Map package style composition failed",
  ),
  "runtime.map-package.source-bind": classification("runtime", "internal", false, "Map package source binding failed"),
  "runtime.map-package.view": classification("runtime", "internal", false, "Renderer view mutation failed"),
  "runtime.map-package.popup": classification("runtime", "validation", false, "Popup binding failed"),
  "runtime.map-package.dispose": classification("runtime", "internal", true, "Runtime disposal failed"),
  "runtime.diagnostic": classification("runtime", "validation", false, "Runtime validation diagnostic"),
  "runtime.query-tiles.transient": classification("runtime", "protocol", true, "Retryable query-tile response failure"),
  "runtime.query-tiles.rejected": classification(
    "runtime",
    "protocol",
    false,
    "Non-retryable query-tile response failure",
  ),
  "realtime.cancelled": classification("realtime", "cancellation", false, "Realtime operation was cancelled"),
  "realtime.transport.reconnectable": classification(
    "realtime",
    "network",
    true,
    "Realtime transport can reconnect or resnapshot",
  ),
  "realtime.checkpoint.invalid": classification(
    "realtime",
    "validation",
    false,
    "Realtime checkpoint or resume context is invalid",
  ),
  "realtime.sequence.gap": classification(
    "realtime",
    "protocol",
    true,
    "Realtime ordering requires a replacement snapshot",
  ),
  "realtime.protocol.terminal": classification(
    "realtime",
    "protocol",
    false,
    "Realtime delivery reached a terminal failure",
  ),
  "realtime.reconciliation.disposed": classification(
    "realtime",
    "validation",
    false,
    "Realtime reconciliation controller, cache, or adapter is disposed",
  ),
  "realtime.reconciliation.invalid-option": classification(
    "realtime",
    "validation",
    false,
    "Realtime reconciliation option is invalid",
  ),
  "offline.region.validation": classification(
    "offline",
    "validation",
    false,
    "Offline region input or lifecycle state is invalid",
  ),
  "offline.region.quota": classification(
    "offline",
    "validation",
    false,
    "Offline region exceeds a logical storage quota",
  ),
  "offline.region.integrity": classification(
    "offline",
    "protocol",
    false,
    "Offline resource integrity verification failed",
  ),
  "offline.region.miss": classification(
    "offline",
    "validation",
    false,
    "Offline region does not cover the requested read",
  ),
  "offline.cancelled": classification("offline", "cancellation", false, "Offline operation was cancelled"),
  "offline.transport.failure": classification(
    "offline",
    "network",
    false,
    "Offline resource or replica transport failed without a transient classification",
  ),
  "offline.transport.transient": classification(
    "offline",
    "network",
    true,
    "Offline resource or replica transport failed transiently",
  ),
  "offline.storage.concurrent": classification(
    "offline",
    "internal",
    true,
    "Offline storage inventory changed before commit",
  ),
  "offline.storage.failure": classification("offline", "internal", false, "Offline storage operation failed"),
  "offline.replica-sync.capability": classification(
    "offline",
    "capability",
    false,
    "Replica synchronization capability is unavailable",
  ),
  "offline.replica-sync.validation": classification(
    "offline",
    "validation",
    false,
    "Replica synchronization request or state is invalid",
  ),
  "offline.replica-sync.permission-denied": classification(
    "offline",
    "authentication",
    false,
    "Replica synchronization permission was denied",
  ),
  "plugin.registry.validation": classification(
    "plugin",
    "validation",
    false,
    "Plugin registry input or lifecycle state is invalid",
  ),
  "plugin.compatibility": classification(
    "plugin",
    "capability",
    false,
    "Plugin declaration is incompatible with the host or its dependencies",
  ),
  "plugin.execution.policy-denied": classification(
    "plugin",
    "capability",
    false,
    "Plugin execution was denied by host policy",
  ),
  "plugin.capability-unavailable": classification(
    "plugin",
    "capability",
    false,
    "Plugin execution requires an unavailable capability or dependency",
  ),
  "plugin.lifecycle.activation": classification(
    "plugin",
    "internal",
    false,
    "Plugin activation or registration failed",
  ),
  "plugin.execution.validation": classification("plugin", "validation", false, "Plugin execution input is invalid"),
  "plugin.lifecycle.cleanup": classification("plugin", "internal", false, "Plugin lifecycle cleanup failed"),
  "plugin.cancelled": classification("plugin", "cancellation", false, "Plugin registration was cancelled"),
  "plugin.internal": classification("plugin", "internal", false, "Plugin registry internal failure"),
  "agent.tool.unknown-tool": classification(
    "agent",
    "validation",
    false,
    "Requested agent tool name is not registered",
  ),
  "agent.tool.missing-runtime": classification(
    "agent",
    "validation",
    false,
    "Agent tool kit requires a runtime, controller, or generated-app runtime",
  ),
  "agent.tool.unqualified-selection": classification(
    "agent",
    "validation",
    false,
    "Agent tool selection target is not source-qualified",
  ),
  "agent.tool.missing-runtime-method": classification(
    "agent",
    "capability",
    false,
    "Adapted runtime does not implement the requested agent tool",
  ),
  "agent.tool.internal": classification("agent", "internal", false, "Agent tool executor internal failure"),
  "agent.safety.aborted": classification("agent", "cancellation", false, "Agent safety operation was aborted"),
  "agent.safety.invalid-input": classification("agent", "validation", false, "Agent safety input is invalid"),
  "agent.safety.policy-denied": classification(
    "agent",
    "capability",
    false,
    "Agent plan step was denied by host policy",
  ),
  "agent.safety.integrity-failed": classification(
    "agent",
    "protocol",
    false,
    "Agent safety evidence integrity verification failed",
  ),
  "agent.safety.approval-expired": classification("agent", "authentication", false, "Agent step approval has expired"),
  "agent.safety.context-mismatch": classification(
    "agent",
    "validation",
    false,
    "Agent execution context does not match the authorized plan",
  ),
  "agent.safety.signature-invalid": classification(
    "agent",
    "validation",
    false,
    "Agent approval or receipt signature is invalid",
  ),
  "agent.safety.execution-failed": classification("agent", "internal", false, "Agent plan step execution failed"),
  "agent.safety.audit-failed": classification(
    "agent",
    "internal",
    false,
    "Agent execution audit record could not be appended",
  ),
  "agent.safety.receipt-failed": classification(
    "agent",
    "internal",
    false,
    "Agent execution receipt could not be issued or verified",
  ),
  "app.unsupported-profile": classification("app", "capability", false, "Generated app profile is not supported"),
  "app.unsupported-widget": classification("app", "capability", false, "Generated app widget kind is not supported"),
  "app.missing-manifest": classification(
    "app",
    "validation",
    false,
    "Generated app manifest or app package is missing",
  ),
  "app.missing-manifest-artifact": classification(
    "app",
    "validation",
    false,
    "Generated app manifest artifact is missing",
  ),
  "app.missing-map-package": classification(
    "app",
    "validation",
    false,
    "Generated app map widget requires a MapPackage",
  ),
  "app.map-package-mismatch": classification(
    "app",
    "validation",
    false,
    "Generated app MapPackage does not match its manifest",
  ),
  "app.missing-widget": classification(
    "app",
    "validation",
    false,
    "Generated app manifest is missing a required widget",
  ),
  "app.missing-binding": classification(
    "app",
    "validation",
    false,
    "Generated app runtime is missing a required binding",
  ),
  "app.map-load-failed": classification("app", "internal", false, "Generated app map widget failed to load"),
  "app.data-load-failed": classification("app", "internal", false, "Generated app feature data failed to load"),
  "app.render-failed": classification("app", "internal", false, "Generated app render failed"),
  "app.disposed": classification("app", "validation", false, "Generated app runtime is disposed"),
  "app.export-unsafe": classification(
    "app",
    "validation",
    false,
    "Component export refused because the artifact could not be proven credential-free",
  ),
  "app.export-failed": classification(
    "app",
    "internal",
    false,
    "Component export adapter failed to produce an artifact",
  ),
} as const satisfies Record<string, HonuaErrorCodeDescriptor>);

export type HonuaErrorCode = keyof typeof HONUA_ERROR_CODE_REGISTRY;

function classification(
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
  summary: string,
): HonuaErrorCodeDescriptor {
  return Object.freeze({ domain, category, retryable, summary });
}
