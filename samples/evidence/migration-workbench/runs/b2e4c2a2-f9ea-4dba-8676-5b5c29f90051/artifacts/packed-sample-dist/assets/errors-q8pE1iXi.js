//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/error-classifications.js
/** @internal */
var HONUA_ERROR_RUNTIME_CLASSIFICATIONS = Object.freeze({
	"core.http.transient": runtimeClassification("core", "protocol", true),
	"core.http.rejected": runtimeClassification("core", "protocol", false),
	"core.timeout": runtimeClassification("core", "timeout", true),
	"core.network": runtimeClassification("core", "network", true),
	"core.cancelled": runtimeClassification("core", "cancellation", false),
	"core.grpc.transient": runtimeClassification("core", "protocol", true),
	"core.grpc.rejected": runtimeClassification("core", "protocol", false),
	"pmtiles.lifecycle.invalid-request": runtimeClassification("pmtiles", "validation", false),
	"pmtiles.lifecycle.invalid-response": runtimeClassification("pmtiles", "validation", false),
	"pmtiles.lifecycle.response-too-large": runtimeClassification("pmtiles", "validation", false),
	"pmtiles.lifecycle.job-poll-timeout": runtimeClassification("pmtiles", "timeout", true),
	"pmtiles.lifecycle.job-failed": runtimeClassification("pmtiles", "protocol", false),
	"pmtiles.lifecycle.job-cancelled": runtimeClassification("pmtiles", "cancellation", false),
	"pmtiles.lifecycle.access-url-expired": runtimeClassification("pmtiles", "validation", false),
	"pmtiles.lifecycle.manual-cleanup-unsupported": runtimeClassification("pmtiles", "capability", false),
	"core.geometry.unknown-geometry": runtimeClassification("core", "validation", false),
	"core.geometry.malformed-geometry": runtimeClassification("core", "validation", false),
	"core.auth.interaction-required": runtimeClassification("core", "authentication", false),
	"core.auth.refresh-failed": runtimeClassification("core", "authentication", true),
	"core.auth.invalid-grant": runtimeClassification("core", "authentication", false),
	"core.capability-not-supported": runtimeClassification("core", "capability", false),
	"core.exploration-context": runtimeClassification("core", "validation", false),
	"core.wfs-exception": runtimeClassification("core", "protocol", false),
	"core.job-failed": runtimeClassification("core", "protocol", false),
	"core.wms-capabilities-parse": runtimeClassification("core", "protocol", false),
	"core.wmts-capabilities-parse": runtimeClassification("core", "protocol", false),
	"core.coverage.invalid-request": runtimeClassification("core", "validation", false),
	"core.coverage.invalid-response": runtimeClassification("core", "protocol", false),
	"core.coverage.response-too-large": runtimeClassification("core", "validation", false),
	"core.coverage.unsupported-format": runtimeClassification("core", "capability", false),
	"core.coverage.service-error": runtimeClassification("core", "protocol", false),
	"core.coverage.wcs-exception": runtimeClassification("core", "protocol", false),
	"core.zarr.invalid-request": runtimeClassification("core", "validation", false),
	"core.zarr.invalid-response": runtimeClassification("core", "protocol", false),
	"core.zarr.response-too-large": runtimeClassification("core", "validation", false),
	"core.zarr.metadata-pending": runtimeClassification("core", "capability", false),
	"core.zarr.missing-spatial-extent": runtimeClassification("core", "capability", false),
	"core.zarr.no-tileable-variable": runtimeClassification("core", "capability", false),
	"core.zarr.missing-spatial-reference": runtimeClassification("core", "capability", false),
	"core.zarr.spatial-reference-mismatch": runtimeClassification("core", "capability", false),
	"core.zarr.unsupported-version": runtimeClassification("core", "capability", false),
	"core.zarr.unsupported-codec": runtimeClassification("core", "capability", false),
	"core.zarr.unsupported-dtype": runtimeClassification("core", "capability", false),
	"core.zarr.ambiguous-dimensions": runtimeClassification("core", "validation", false),
	"core.zarr.service-error": runtimeClassification("core", "protocol", false),
	"discovery.ambiguous-protocol": runtimeClassification("discovery", "validation", false),
	"discovery.ambiguous-source": runtimeClassification("discovery", "validation", false),
	"discovery.invalid-cloud-native-input": runtimeClassification("discovery", "validation", false),
	"discovery.invalid-cloud-native-manifest": runtimeClassification("discovery", "validation", false),
	"discovery.invalid-endpoint": runtimeClassification("discovery", "validation", false),
	"discovery.invalid-cache-identity": runtimeClassification("discovery", "validation", false),
	"discovery.invalid-discovery-cache": runtimeClassification("discovery", "validation", false),
	"discovery.invalid-capability": runtimeClassification("discovery", "validation", false),
	"discovery.cloud-native-operation-unavailable": runtimeClassification("discovery", "capability", false),
	"discovery.unsupported-protocol": runtimeClassification("discovery", "capability", false),
	"discovery.protocol-mismatch": runtimeClassification("discovery", "validation", false),
	"query.planning.invalid-query": runtimeClassification("query", "validation", false),
	"query.planning.unsupported-compiler": runtimeClassification("query", "capability", false),
	"query.planning.unsupported-query": runtimeClassification("query", "capability", false),
	"query.planning.capability-not-supported": runtimeClassification("query", "capability", false),
	"query.planning.fallback-disabled": runtimeClassification("query", "capability", false),
	"query.planning.unsafe-materialization": runtimeClassification("query", "validation", false),
	"query.execution.invalid-plan": runtimeClassification("query", "validation", false),
	"query.execution.wfs-protocol": runtimeClassification("query", "protocol", false),
	"query.execution.plan-context-mismatch": runtimeClassification("query", "validation", false),
	"query.execution.unsafe-materialization": runtimeClassification("query", "validation", false),
	"query.execution.invalid-resource-handle": runtimeClassification("query", "validation", false),
	"query.execution.resource-unavailable": runtimeClassification("query", "authentication", false),
	"query.execution.resource-expired": runtimeClassification("query", "authentication", false),
	"query.execution.resource-resolution-failed": runtimeClassification("query", "internal", false),
	"query.execution.resource-execution-failed": runtimeClassification("query", "internal", false),
	"map.source-adapter.disposed": runtimeClassification("map", "validation", false),
	"map.source-adapter.source-conflict": runtimeClassification("map", "validation", false),
	"map.source-adapter.layer-conflict": runtimeClassification("map", "validation", false),
	"map.source-adapter.unsupported-plan": runtimeClassification("map", "capability", false),
	"map.source-adapter.invalid-option": runtimeClassification("map", "validation", false),
	"map.source-adapter.map-mutation-failed": runtimeClassification("map", "internal", false),
	"map.data-bridge.invalid-option": runtimeClassification("map", "validation", false),
	"map.data-bridge.disposed": runtimeClassification("map", "validation", false),
	"map.data-bridge.source-conflict": runtimeClassification("map", "validation", false),
	"map.data-bridge.layer-conflict": runtimeClassification("map", "validation", false),
	"map.data-bridge.map-mutation-failed": runtimeClassification("map", "internal", false),
	"map.data-bridge.interaction-unsupported": runtimeClassification("map", "capability", false),
	"map.data-bridge.filter-unsupported": runtimeClassification("map", "capability", false),
	"map.automatic-strategy.no-eligible-strategy": runtimeClassification("map", "capability", false),
	"map.automatic-strategy.stale-plan": runtimeClassification("map", "validation", false),
	"map.automatic-strategy.source-conflict": runtimeClassification("map", "validation", false),
	"map.automatic-strategy.layer-conflict": runtimeClassification("map", "validation", false),
	"map.automatic-strategy.map-mutation-failed": runtimeClassification("map", "internal", false),
	"map.automatic-strategy.cancelled": runtimeClassification("map", "cancellation", false),
	"map.automatic-strategy.disposed": runtimeClassification("map", "validation", false),
	"map.raster-strategy.unsupported-strategy": runtimeClassification("map", "capability", false),
	"map.raster-strategy.capability-mismatch": runtimeClassification("map", "capability", false),
	"map.raster-strategy.missing-metadata": runtimeClassification("map", "validation", false),
	"map.raster-strategy.invalid-option": runtimeClassification("map", "validation", false),
	"map.raster-strategy.source-conflict": runtimeClassification("map", "validation", false),
	"map.raster-strategy.layer-conflict": runtimeClassification("map", "validation", false),
	"map.raster-strategy.map-mutation-failed": runtimeClassification("map", "internal", false),
	"map.automatic-integration.disposed": runtimeClassification("map", "validation", false),
	"map.automatic-integration.invalid-target": runtimeClassification("map", "validation", false),
	"map.temporal-playback.invalid-option": runtimeClassification("map", "validation", false),
	"runtime.map-package.fetch": runtimeClassification("runtime", "network", true),
	"runtime.map-package.load": runtimeClassification("runtime", "internal", false),
	"runtime.map-package.validate": runtimeClassification("runtime", "validation", false),
	"runtime.map-package.export": runtimeClassification("runtime", "validation", false),
	"runtime.map-package.import": runtimeClassification("runtime", "validation", false),
	"runtime.map-package.update": runtimeClassification("runtime", "internal", false),
	"runtime.map-package.style-compose": runtimeClassification("runtime", "validation", false),
	"runtime.map-package.source-bind": runtimeClassification("runtime", "internal", false),
	"runtime.map-package.view": runtimeClassification("runtime", "internal", false),
	"runtime.map-package.popup": runtimeClassification("runtime", "validation", false),
	"runtime.map-package.dispose": runtimeClassification("runtime", "internal", true),
	"runtime.diagnostic": runtimeClassification("runtime", "validation", false),
	"runtime.query-tiles.transient": runtimeClassification("runtime", "protocol", true),
	"runtime.query-tiles.rejected": runtimeClassification("runtime", "protocol", false),
	"realtime.cancelled": runtimeClassification("realtime", "cancellation", false),
	"realtime.transport.reconnectable": runtimeClassification("realtime", "network", true),
	"realtime.checkpoint.invalid": runtimeClassification("realtime", "validation", false),
	"realtime.sequence.gap": runtimeClassification("realtime", "protocol", true),
	"realtime.protocol.terminal": runtimeClassification("realtime", "protocol", false),
	"realtime.reconciliation.disposed": runtimeClassification("realtime", "validation", false),
	"realtime.reconciliation.invalid-option": runtimeClassification("realtime", "validation", false),
	"offline.region.validation": runtimeClassification("offline", "validation", false),
	"offline.region.quota": runtimeClassification("offline", "validation", false),
	"offline.region.integrity": runtimeClassification("offline", "protocol", false),
	"offline.region.miss": runtimeClassification("offline", "validation", false),
	"offline.cancelled": runtimeClassification("offline", "cancellation", false),
	"offline.transport.failure": runtimeClassification("offline", "network", false),
	"offline.transport.transient": runtimeClassification("offline", "network", true),
	"offline.storage.concurrent": runtimeClassification("offline", "internal", true),
	"offline.storage.failure": runtimeClassification("offline", "internal", false),
	"offline.replica-sync.capability": runtimeClassification("offline", "capability", false),
	"offline.replica-sync.validation": runtimeClassification("offline", "validation", false),
	"offline.replica-sync.permission-denied": runtimeClassification("offline", "authentication", false),
	"plugin.registry.validation": runtimeClassification("plugin", "validation", false),
	"plugin.compatibility": runtimeClassification("plugin", "capability", false),
	"plugin.execution.policy-denied": runtimeClassification("plugin", "capability", false),
	"plugin.capability-unavailable": runtimeClassification("plugin", "capability", false),
	"plugin.lifecycle.activation": runtimeClassification("plugin", "internal", false),
	"plugin.execution.validation": runtimeClassification("plugin", "validation", false),
	"plugin.lifecycle.cleanup": runtimeClassification("plugin", "internal", false),
	"plugin.cancelled": runtimeClassification("plugin", "cancellation", false),
	"plugin.internal": runtimeClassification("plugin", "internal", false),
	"agent.tool.unknown-tool": runtimeClassification("agent", "validation", false),
	"agent.tool.missing-runtime": runtimeClassification("agent", "validation", false),
	"agent.tool.unqualified-selection": runtimeClassification("agent", "validation", false),
	"agent.tool.missing-runtime-method": runtimeClassification("agent", "capability", false),
	"agent.tool.internal": runtimeClassification("agent", "internal", false),
	"agent.safety.aborted": runtimeClassification("agent", "cancellation", false),
	"agent.safety.invalid-input": runtimeClassification("agent", "validation", false),
	"agent.safety.policy-denied": runtimeClassification("agent", "capability", false),
	"agent.safety.integrity-failed": runtimeClassification("agent", "protocol", false),
	"agent.safety.approval-expired": runtimeClassification("agent", "authentication", false),
	"agent.safety.context-mismatch": runtimeClassification("agent", "validation", false),
	"agent.safety.signature-invalid": runtimeClassification("agent", "validation", false),
	"agent.safety.execution-failed": runtimeClassification("agent", "internal", false),
	"agent.safety.audit-failed": runtimeClassification("agent", "internal", false),
	"agent.safety.receipt-failed": runtimeClassification("agent", "internal", false),
	"app.unsupported-profile": runtimeClassification("app", "capability", false),
	"app.unsupported-widget": runtimeClassification("app", "capability", false),
	"app.missing-manifest": runtimeClassification("app", "validation", false),
	"app.missing-manifest-artifact": runtimeClassification("app", "validation", false),
	"app.missing-map-package": runtimeClassification("app", "validation", false),
	"app.map-package-mismatch": runtimeClassification("app", "validation", false),
	"app.missing-widget": runtimeClassification("app", "validation", false),
	"app.missing-binding": runtimeClassification("app", "validation", false),
	"app.map-load-failed": runtimeClassification("app", "internal", false),
	"app.data-load-failed": runtimeClassification("app", "internal", false),
	"app.render-failed": runtimeClassification("app", "internal", false),
	"app.disposed": runtimeClassification("app", "validation", false),
	"app.export-unsafe": runtimeClassification("app", "validation", false),
	"app.export-failed": runtimeClassification("app", "internal", false)
});
function runtimeClassification(domain, category, retryable) {
	return Object.freeze([
		domain,
		category,
		retryable
	]);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/error-envelope.js
/**
* Shared, serialization-safe error contract for public Honua SDK failures.
*
* Error instances retain their original `message`, `cause`, and legacy detail
* fields for local debugging. Use {@link serializeHonuaError} at telemetry or
* process boundaries: it emits only registered classifications and sanitized
* context, never messages, stacks, response bodies, or cause payloads.
*/
var HONUA_ERROR_KIND = "honua.sdk.error.v1";
/** Base class for every migrated public SDK error. */
var HonuaSdkError = class extends Error {
	kind = HONUA_ERROR_KIND;
	domain;
	/** Globally unique registry code. Legacy subclasses may retain a separate `.code`. */
	sdkCode;
	category;
	retryable;
	operationId;
	requestId;
	context;
	constructor(code, message, options = {}) {
		const [domain, category, retryable] = errorCodeClassification(code);
		super(message, "cause" in options ? { cause: options.cause } : void 0);
		this.name = "HonuaSdkError";
		this.domain = domain;
		this.sdkCode = code;
		this.category = category;
		this.retryable = retryable;
		this.operationId = sanitizeIdentifier(options.operationId);
		this.requestId = sanitizeIdentifier(options.requestId);
		this.context = sanitizeHonuaErrorContext(options.context);
	}
	/** Safe JSON projection. Raw messages, stacks, details, bodies, and causes are intentionally omitted. */
	toJSON() {
		return serializeHonuaError(this);
	}
};
/** Cross-realm type guard backed by the public tag and registered code. */
function isHonuaSdkError(error) {
	try {
		if (!isRecord(error) || Array.isArray(error)) return false;
		const kind = ownDataProperty(error, "kind");
		const sdkCode = ownDataProperty(error, "sdkCode");
		if (kind !== "honua.sdk.error.v1" || typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return false;
		const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
		const context = ownDataProperty(error, "context");
		const name = ownDataProperty(error, "name");
		return ownDataProperty(error, "domain") === domain && ownDataProperty(error, "retryable") === retryable && ownDataProperty(error, "category") === category && typeof name === "string" && isRecord(context) && !Array.isArray(context);
	} catch {
		return false;
	}
}
/** Serialize a tagged SDK error without crossing its redaction boundary. */
function serializeHonuaError(error) {
	const sdkCode = ownDataProperty(error, "sdkCode");
	if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) throw new TypeError("Cannot serialize an SDK error with an unregistered code");
	const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
	const cause = serializeCause(ownDataProperty(error, "cause"));
	const operationId = sanitizeIdentifier(asOptionalString(ownDataProperty(error, "operationId")));
	const requestId = sanitizeIdentifier(asOptionalString(ownDataProperty(error, "requestId")));
	const context = ownDataProperty(error, "context");
	return {
		kind: HONUA_ERROR_KIND,
		name: sanitizeErrorName(ownDataProperty(error, "name")),
		domain,
		code: sdkCode,
		category,
		retryable,
		...operationId ? { operationId } : {},
		...requestId ? { requestId } : {},
		context: isRecord(context) && !Array.isArray(context) ? sanitizeHonuaErrorContext(context) : emptyContext(),
		...cause ? { cause } : {}
	};
}
/** Redact structured context before it is stored on an SDK error. */
function sanitizeHonuaErrorContext(context) {
	if (!context) return emptyContext();
	try {
		const sanitized = sanitizeRecord(context, /* @__PURE__ */ new WeakSet(), 0);
		return Object.freeze(sanitized);
	} catch {
		return frozenRecord("value", "[UNSERIALIZABLE]");
	}
}
/** Merge context inputs without invoking enumerable accessors or honoring prototype-manipulation keys. */
function mergeHonuaErrorContext(...contexts) {
	const merged = Object.create(null);
	let unsafeKeyCount = 0;
	for (const context of contexts) {
		if (!context) continue;
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(context))) {
			if (!descriptor.enumerable) continue;
			if (UNSAFE_PROPERTY_KEY.test(key)) {
				unsafeKeyCount += 1;
				continue;
			}
			merged[key] = "value" in descriptor ? descriptor.value : "[ACCESSOR]";
		}
	}
	if (unsafeKeyCount > 0) merged.__redacted_keys__ = unsafeKeyCount;
	return merged;
}
function isHonuaErrorCode(code) {
	return Object.hasOwn(HONUA_ERROR_RUNTIME_CLASSIFICATIONS, code);
}
function errorCodeClassification(code) {
	if (!isHonuaErrorCode(code)) throw new TypeError(`Unregistered Honua SDK error code: ${code}`);
	return HONUA_ERROR_RUNTIME_CLASSIFICATIONS[code];
}
var REDACTED = "[REDACTED]";
var TRUNCATED = "[TRUNCATED]";
var MAX_DEPTH = 6;
var MAX_PROPERTIES = 100;
var MAX_ARRAY_ITEMS = 100;
var MAX_STRING_LENGTH = 2048;
var SENSITIVE_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|credential|password|passwd|secret|token|api[-_]?key|access[-_]?key|access[-_]?id|signature|cursor|resume[-_]?token|where|filter|query|sql|cql|body|payload|form|parameters?)/i;
var STORAGE_LOCATOR_KEY = /^(?:local[-_]?storage|storage|cache(?:[-_]?file)?|file|filesystem)[-_]?(?:path|directory|url|uri|location)$/i;
var URL_KEY = /(?:url|uri|href|endpoint|location)$/i;
function sanitizeRecord(value, seen, depth) {
	if (depth >= MAX_DEPTH) return frozenRecord("value", TRUNCATED);
	if (seen.has(value)) return frozenRecord("value", "[CIRCULAR]");
	seen.add(value);
	const output = Object.create(null);
	const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) => descriptor.enumerable).slice(0, MAX_PROPERTIES);
	let unsafeKeyCount = 0;
	for (const [key, descriptor] of descriptors) {
		if (UNSAFE_PROPERTY_KEY.test(key)) {
			unsafeKeyCount += 1;
			continue;
		}
		const item = "value" in descriptor ? descriptor.value : "[ACCESSOR]";
		output[key] = SENSITIVE_KEY.test(key) || STORAGE_LOCATOR_KEY.test(key) ? REDACTED : sanitizeValue(item, key, seen, depth + 1);
	}
	if (unsafeKeyCount > 0) output.__redacted_keys__ = unsafeKeyCount;
	if (Reflect.ownKeys(value).length > descriptors.length) output.__truncated__ = TRUNCATED;
	seen.delete(value);
	return Object.freeze(output);
}
function sanitizeValue(value, key, seen, depth) {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "string") return sanitizeString(value, URL_KEY.test(key));
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return "[UNDEFINED]";
	if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";
	if (value instanceof Error) return frozenRecord("name", errorNameWithoutGetters(value));
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[BINARY]";
	if (value instanceof Date) {
		const time = Date.prototype.getTime.call(value);
		return Number.isNaN(time) ? "[INVALID_DATE]" : Date.prototype.toISOString.call(value);
	}
	if (Array.isArray(value)) {
		if (depth >= MAX_DEPTH) return TRUNCATED;
		if (seen.has(value)) return "[CIRCULAR]";
		seen.add(value);
		const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, seen, depth + 1));
		if (value.length > result.length) result.push(TRUNCATED);
		seen.delete(value);
		return Object.freeze(result);
	}
	if (isRecord(value)) return sanitizeRecord(value, seen, depth);
	return "[UNSERIALIZABLE]";
}
function sanitizeString(value, urlExpected) {
	const bounded = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : value;
	if (urlExpected || /^https?:\/\//i.test(bounded)) try {
		const url = new URL(bounded);
		url.username = "";
		url.password = "";
		for (const key of [...url.searchParams.keys()]) if (isSensitiveQueryParameter(key)) url.searchParams.set(key, REDACTED);
		url.hash = "";
		return url.toString();
	} catch {
		if (urlExpected) return REDACTED;
	}
	return bounded.replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`).replace(/\b(access_token|refresh_token|api[-_]?key|password|passwd|secret|token|cursor|resume[-_]?token)\s*[:=]\s*([^\s,;&]+)/gi, (_match, name) => `${name}=${REDACTED}`);
}
function sanitizeIdentifier(value) {
	if (value === void 0) return void 0;
	return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : REDACTED;
}
function asOptionalString(value) {
	return typeof value === "string" ? value : void 0;
}
function serializeCause(cause) {
	if (cause === void 0) return void 0;
	try {
		if (isHonuaSdkError(cause)) {
			const sdkCode = ownDataProperty(cause, "sdkCode");
			if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return { name: "Error" };
			const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
			return {
				name: sanitizeErrorName(ownDataProperty(cause, "name")),
				domain,
				code: sdkCode,
				category,
				retryable
			};
		}
		if (cause instanceof Error) return { name: errorNameWithoutGetters(cause) };
		return { name: typeof cause };
	} catch {
		return { name: "Error" };
	}
}
function isRecord(value) {
	return value !== null && typeof value === "object";
}
function ownDataProperty(value, key) {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : void 0;
}
function sanitizeErrorName(value) {
	return typeof value === "string" && SAFE_ERROR_NAMES.has(value) ? value : "Error";
}
function errorNameWithoutGetters(error) {
	try {
		const ownName = ownDataProperty(error, "name");
		if (typeof ownName === "string") return sanitizeErrorName(ownName);
		const prototype = Object.getPrototypeOf(error);
		return prototype ? sanitizeErrorName(ownDataProperty(prototype, "name")) : "Error";
	} catch {
		return "Error";
	}
}
function isSensitiveQueryParameter(key) {
	const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
	return normalized === "key" || /(?:accesstoken|refreshtoken|securitytoken|accesskeyid|accessid|credential|authorization|apikey|signature|password|passwd|secret|cursor|resumetoken|continuationtoken|filter|where|query|sql|cql|auth|sig)$/.test(normalized);
}
var UNSAFE_PROPERTY_KEY = /^(?:__proto__|prototype|constructor)$/;
var SAFE_ERROR_NAMES = new Set([
	"AbortError",
	"AggregateError",
	"ConnectError",
	"DOMException",
	"Error",
	"EvalError",
	"HonuaAbortError",
	"HonuaAgentExecutionError",
	"HonuaAgentSafetyError",
	"HonuaAgentToolError",
	"HonuaAuthError",
	"HonuaAutomaticMapLibreIntegrationError",
	"HonuaAutomaticMapLibreStrategyError",
	"HonuaCapabilityNotSupportedError",
	"HonuaDataToMapBridgeError",
	"HonuaDiscoveryError",
	"HonuaExplorationContextError",
	"HonuaGeneratedAppError",
	"HonuaGrpcError",
	"HonuaHttpError",
	"HonuaJobFailedError",
	"HonuaMapLibreRasterStrategyError",
	"HonuaMapLibreSourceAdapterError",
	"HonuaMapPackageError",
	"HonuaNetworkError",
	"HonuaOfflineRegionError",
	"HonuaOfflineEditQueueError",
	"HonuaPluginRegistryError",
	"HonuaQueryPlanExecutionError",
	"HonuaQueryPlanningError",
	"HonuaRealtimeResumeError",
	"HonuaReplicaSyncError",
	"HonuaRuntimeDiagnosticError",
	"HonuaSdkError",
	"HonuaTemporalPlaybackError",
	"HonuaTimeoutError",
	"HonuaWfsExceptionError",
	"HonuaWfsProtocolError",
	"HonuaWmsCapabilitiesParseError",
	"HonuaWmtsCapabilitiesParseError",
	"NetworkError",
	"QueryTileServerResponseError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TimeoutError",
	"TypeError",
	"URIError"
]);
function emptyContext() {
	return Object.freeze(Object.create(null));
}
function frozenRecord(key, value) {
	const record = Object.create(null);
	record[key] = value;
	return Object.freeze(record);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/errors.js
/**
* Tagged hierarchy for the migrated Honua SDK error domains. The common
* `isHonuaError(error)` guard also recognizes migrated query, map, runtime,
* realtime, offline, and plugin subclasses. See
* [`docs/errors.md`](../../docs/errors.md) for exact coverage, residual domains,
* recovery hints, and the retryability classification.
*
* @example
* ```ts
* import {
*   HonuaHttpError,
*   HonuaTimeoutError,
*   HonuaCapabilityNotSupportedError,
*   isHonuaError,
* } from "@honua/sdk-js";
*
* try {
*   await dataset.source("parcels")!.queryAll({ pagination: { limit: 100 } });
* } catch (error) {
*   if (!isHonuaError(error)) throw error;
*   if (error instanceof HonuaCapabilityNotSupportedError) return fallback();
*   if (error instanceof HonuaHttpError && error.statusCode === 401) {
*     await refreshCredentials();
*     return retry();
*   }
*   if (error instanceof HonuaTimeoutError) return notifyUser("Server slow");
*   throw error;
* }
* ```
*
* @packageDocumentation
*/
/**
* Thrown when the server returns a non-2xx HTTP status. Branch on
* `.statusCode` to decide recovery: refresh credentials on 401/403, respect
* `Retry-After` on 429, back off on 5xx, etc.
*
* @see [`docs/errors.md`](../../docs/errors.md)
*/
var HonuaHttpError = class extends HonuaSdkError {
	statusCode;
	body;
	constructor(statusCode, message, body, options = {}) {
		super(HTTP_RETRYABLE_STATUSES.has(statusCode) ? "core.http.transient" : "core.http.rejected", `HTTP ${statusCode}: ${message}`, {
			...options,
			context: mergeHonuaErrorContext(options.context, { statusCode })
		});
		this.name = "HonuaHttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
};
/** Thrown when a request exceeds the configured timeout. */
var HonuaTimeoutError = class extends HonuaSdkError {
	timeoutMs;
	constructor(timeoutMs, options = {}) {
		super("core.timeout", `Request timed out after ${timeoutMs}ms`, {
			...options,
			context: mergeHonuaErrorContext(options.context, { timeoutMs })
		});
		this.name = "HonuaTimeoutError";
		this.timeoutMs = timeoutMs;
	}
};
/** Thrown when a network-level failure occurs (DNS, connection refused, etc.). */
var HonuaNetworkError = class extends HonuaSdkError {
	cause;
	constructor(message, cause, metadata = {}) {
		super("core.network", message, {
			...metadata,
			cause
		});
		this.name = "HonuaNetworkError";
		this.cause = cause;
	}
};
/** Thrown when a request is aborted via a caller-provided AbortSignal. */
var HonuaAbortError = class extends HonuaSdkError {
	constructor(message = "Request was aborted", options = {}) {
		super("core.cancelled", message, options);
		this.name = "HonuaAbortError";
	}
};
/** Thrown when a gRPC-Web request fails, wrapping the underlying ConnectError. */
var HonuaGrpcError = class extends HonuaSdkError {
	code;
	details;
	constructor(code, message, details, options = {}) {
		super(GRPC_RETRYABLE_CODES.has(code) ? "core.grpc.transient" : "core.grpc.rejected", message, {
			...options,
			context: mergeHonuaErrorContext(options.context, { grpcCode: code })
		});
		this.code = code;
		this.name = "HonuaGrpcError";
		this.details = details;
	}
};
/**
* Thrown when a `Source` is asked to perform an operation that the underlying
* protocol or server does not support and the active capability policy is
* `strict`. The `capability` field names the missing capability so callers can
* decide whether to swap protocols, fall back to a degraded strategy, or
* surface the limitation to the user.
*/
var HonuaCapabilityNotSupportedError = class extends HonuaSdkError {
	capability;
	protocol;
	sourceId;
	constructor(capability, protocol, sourceId, options = {}) {
		const message = sourceId ? `Capability "${capability}" is not supported by protocol "${protocol}" on source "${sourceId}"` : `Capability "${capability}" is not supported by protocol "${protocol}"`;
		super("core.capability-not-supported", message, {
			...options,
			context: mergeHonuaErrorContext(options.context, {
				capability,
				protocol,
				sourceId
			})
		});
		this.name = "HonuaCapabilityNotSupportedError";
		this.capability = capability;
		this.protocol = protocol;
		this.sourceId = sourceId;
	}
};
/**
* Thrown when a WFS server replies with an `ows:ExceptionReport`. Carries the
* structured exception metadata so callers can distinguish capability misses
* (for example `OperationProcessingFailed`, `InvalidParameterValue`) from
* transport / timeout failures. The XML payload is consumed by
* `src/core/wfs-capabilities.ts`; raw access lives behind the `protocol("wfs")`
* escape hatch.
*/
var HonuaWfsExceptionError = class extends HonuaSdkError {
	exceptionCode;
	locator;
	constructor(exceptionCode, message, locator, options = {}) {
		const formattedMessage = locator ? `WFS ExceptionReport ${exceptionCode} (${locator}): ${message}` : `WFS ExceptionReport ${exceptionCode}: ${message}`;
		super("core.wfs-exception", formattedMessage, {
			...options,
			context: mergeHonuaErrorContext(options.context, {
				exceptionCode,
				locator
			})
		});
		this.name = "HonuaWfsExceptionError";
		this.exceptionCode = exceptionCode;
		this.locator = locator;
	}
};
var HTTP_RETRYABLE_STATUSES = new Set([
	408,
	429,
	500,
	502,
	503,
	504
]);
var GRPC_RETRYABLE_CODES = new Set([
	4,
	8,
	10,
	14
]);
//#endregion
export { HonuaNetworkError as a, HonuaSdkError as c, HonuaHttpError as i, HonuaCapabilityNotSupportedError as n, HonuaTimeoutError as o, HonuaGrpcError as r, HonuaWfsExceptionError as s, HonuaAbortError as t };
