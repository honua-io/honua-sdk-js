const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./esm-BvKGtSr1.js","./esm-BLeFQxnU.js","./file-C7ic42ti.js","./esm-D_dJovGL.js","./feature_service_pb-Cta0sbku.js","./feature_service_pb-DqZYGq-R.js","./grpc-adapter-A3vUPFLv.js","./errors-q8pE1iXi.js"])))=>i.map(i=>d[i]);
import { t as __vitePreload } from "./preload-helper-CW7Fztz1.js";
import { a as HonuaNetworkError, c as HonuaSdkError, i as HonuaHttpError, n as HonuaCapabilityNotSupportedError, o as HonuaTimeoutError, s as HonuaWfsExceptionError, t as HonuaAbortError } from "./errors-q8pE1iXi.js";
function createHonuaCacheState(init) {
	return {
		scope: init.scope,
		status: init.status,
		keyFingerprint: init.keyFingerprint,
		...init.ageMs !== void 0 ? { ageMs: Math.max(0, Math.trunc(init.ageMs)) } : {},
		...init.ttlMs !== void 0 ? { ttlMs: Math.max(0, Math.trunc(init.ttlMs)) } : {},
		...init.staleIfErrorMs !== void 0 ? { staleIfErrorMs: Math.max(0, Math.trunc(init.staleIfErrorMs)) } : {},
		...init.revalidatedAt ? { revalidatedAt: init.revalidatedAt } : {},
		...init.sourceUpdatedAt ? { sourceUpdatedAt: init.sourceUpdatedAt } : {},
		...hasHonuaCacheValidator(init.validator) ? { validator: init.validator } : {},
		...init.invalidationReason ? { invalidationReason: init.invalidationReason } : {},
		...init.refreshErrorId ? { refreshErrorId: init.refreshErrorId } : {}
	};
}
function normalizeHonuaMetadataRequestOptions(options = {}) {
	const ttlMs = normalizeNonNegativeInteger(options.ttlMs) ?? 3e5;
	const staleIfErrorMs = normalizeNonNegativeInteger(options.staleIfErrorMs) ?? 36e5;
	const maxResponseBytes = normalizeMaximumResponseBytes(options.maxResponseBytes);
	return {
		...options.signal ? { signal: options.signal } : {},
		refresh: options.refresh === true,
		cache: options.cache === "bypass" ? "bypass" : "default",
		staleIfError: options.staleIfError !== false,
		ttlMs,
		staleIfErrorMs,
		...maxResponseBytes !== void 0 ? { maxResponseBytes } : {}
	};
}
function isHonuaCacheEntryFresh(cachedAtMs, now, ttlMs) {
	return ttlMs === void 0 || Math.max(0, now - cachedAtMs) < ttlMs;
}
function honuaCacheValidatorFromHeaders(headers) {
	const etag = headers.get("etag") ?? void 0;
	const lastModified = headers.get("last-modified") ?? void 0;
	return hasHonuaCacheValidator({
		etag,
		lastModified
	}) ? {
		...etag ? { etag } : {},
		...lastModified ? { lastModified } : {}
	} : void 0;
}
function honuaMetadataRequestHeaders(options) {
	const headers = { Accept: options.accept ?? "application/json" };
	if (options.bypass) {
		headers["Cache-Control"] = "no-store";
		headers.Pragma = "no-cache";
		return headers;
	}
	if (options.refresh) {
		headers["Cache-Control"] = "no-cache";
		if (options.validator?.etag) headers["If-None-Match"] = options.validator.etag;
		if (options.validator?.lastModified) headers["If-Modified-Since"] = options.validator.lastModified;
	}
	return headers;
}
function withHonuaCacheState(value, cache) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	return {
		...value,
		cache
	};
}
function withoutHonuaCacheState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const { cache: _cache, ...rest } = value;
	return rest;
}
function hasHonuaCacheValidator(value) {
	return Boolean(value?.etag || value?.lastModified);
}
function normalizeNonNegativeInteger(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return Math.max(0, Math.trunc(value));
}
function normalizeMaximumResponseBytes(value) {
	if (value === void 0) return void 0;
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("maxResponseBytes must be a positive safe integer.");
	return value;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/path-utils.js
/**
* Linear-time string trimming helpers used for URL and path normalization.
*
* These intentionally avoid regular expressions such as `\/+$` or `^\/+`.
* Anchored quantifier regexes over repeated characters can exhibit
* super-linear (polynomial) matching on adversarial input, so the helpers
* below scan from the relevant end with simple index arithmetic, which is
* always O(n) regardless of input shape.
*/
/** Remove every trailing `/` character from `value`. */
function trimTrailingSlashes(value) {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
	return end === value.length ? value : value.slice(0, end);
}
/**
* Return `value` with any `?query` suffix removed (the fragment, if present,
* is preserved). Equivalent to `value.replace(/\?.*$/, "")`.
*/
function stripQuery(value) {
	const index = value.indexOf("?");
	return index < 0 ? value : value.slice(0, index);
}
/**
* Encode an Esri-style `serviceId` for use as a URL path segment, preserving
* folder structure.
*
* Esri/GeoServices services may be folder-organized, e.g.
* `MyFolder/MyService`. Naively passing the whole id through
* `encodeURIComponent` percent-encodes the `/` separator (`%2F`), collapsing
* the folder and service into a single path segment that the server cannot
* route. This helper splits on `/`, encodes each non-empty segment
* individually, and rejoins with `/` so the folder path is preserved while
* special characters within a segment (spaces, `&`, etc.) are still encoded.
*
* A plain `serviceId` without slashes behaves exactly like
* `encodeURIComponent(serviceId)`. Empty segments produced by leading,
* trailing, or doubled slashes are dropped so the result never contains
* stray `/` runs. Use {@link encodePathSegments} instead when empty segments
* must be preserved verbatim.
*/
function encodeServiceIdPath(serviceId) {
	if (!serviceId.includes("/")) return encodeURIComponent(serviceId);
	return serviceId.split("/").filter((segment) => segment.length > 0).map((segment) => encodeURIComponent(segment)).join("/");
}
/**
* Percent-encode a path that may contain `/` separators, encoding each
* segment independently so the separators survive.
*
* `encodeURIComponent("a/b")` returns `a%2Fb`, which is wrong for
* folder-prefixed identifiers such as `myFolder/parcels` that must serialize
* as `myFolder/parcels` on the wire. Splitting on `/` and encoding each
* segment keeps the separators literal while still escaping reserved
* characters inside each segment. Empty segments (leading/trailing/double
* slashes) are preserved verbatim so callers retain full control over the
* resulting path shape. Use {@link encodeServiceIdPath} when empty segments
* should instead be dropped (e.g. routable Esri service ids).
*/
function encodePathSegments(value) {
	if (!value.includes("/")) return encodeURIComponent(value);
	return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/compatibility.js
/**
* Server compatibility contract parsing and evaluation. Decodes the
* `GET /api/v1/admin/capabilities` envelope into the typed
* {@link HonuaServerCompatibility} shape, and evaluates it against this
* SDK's supported baseline (minimum server version, control-plane API
* major/base-path, and release channel). Pure logic with no transport
* coupling; the `HonuaClient` facade owns fetching + caching and delegates
* the parse/evaluate steps here.
*
* @module
*/
var HONUA_MINIMUM_SUPPORTED_SERVER_VERSION = "1.0.0";
var MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL = "preview";
var SUPPORTED_CONTROL_PLANE_API_MAJOR = 1;
var SUPPORTED_CONTROL_PLANE_API_BASE_PATH = "/api/v1/admin";
function isObject$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseCompatibilityEnvelope(payload) {
	if (!isObject$3(payload)) throw new TypeError("Server capabilities response must be a JSON object.");
	if (payload.success === false) {
		const message = typeof payload.message === "string" ? payload.message : "Server capabilities request failed.";
		throw new Error(message);
	}
	if (!isObject$3(payload.data)) throw new TypeError("Server capabilities response is missing a data object.");
	return parseCompatibilityContract(payload.data.compatibility);
}
function parseCompatibilityContract(payload) {
	if (!isObject$3(payload)) throw new TypeError("Server capabilities response is missing data.compatibility.");
	return {
		serverVersion: requireNonEmptyString(payload.serverVersion, "data.compatibility.serverVersion"),
		releaseChannel: requireNonEmptyString(payload.releaseChannel, "data.compatibility.releaseChannel"),
		controlPlaneApi: parseControlPlaneApi(payload.controlPlaneApi),
		metadataSchemas: parseMetadataSchemas(payload.metadataSchemas),
		features: parseCompatibilityFeatures(payload.features)
	};
}
function parseControlPlaneApi(payload) {
	if (!isObject$3(payload)) throw new TypeError("Server capabilities response is missing data.compatibility.controlPlaneApi.");
	return {
		major: requireInteger(payload.major, "data.compatibility.controlPlaneApi.major"),
		basePath: requireNonEmptyString(payload.basePath, "data.compatibility.controlPlaneApi.basePath"),
		deprecated: requireBoolean(payload.deprecated, "data.compatibility.controlPlaneApi.deprecated")
	};
}
function parseMetadataSchemas(payload) {
	if (!Array.isArray(payload)) throw new TypeError("Server capabilities response is missing data.compatibility.metadataSchemas.");
	return payload.map((entry, index) => {
		if (!isObject$3(entry)) throw new TypeError(`Server capabilities response metadataSchemas[${index}] must be an object.`);
		return {
			version: requireNonEmptyString(entry.version, `data.compatibility.metadataSchemas[${index}].version`),
			deprecated: requireBoolean(entry.deprecated, `data.compatibility.metadataSchemas[${index}].deprecated`)
		};
	});
}
function parseCompatibilityFeatures(payload) {
	if (!isObject$3(payload)) throw new TypeError("Server capabilities response is missing data.compatibility.features.");
	return {
		metadataResources: requireBoolean(payload.metadataResources, "data.compatibility.features.metadataResources"),
		manifestExport: requireBoolean(payload.manifestExport, "data.compatibility.features.manifestExport"),
		manifestApply: requireBoolean(payload.manifestApply, "data.compatibility.features.manifestApply"),
		manifestDryRun: requireBoolean(payload.manifestDryRun, "data.compatibility.features.manifestDryRun"),
		manifestPrune: requireBoolean(payload.manifestPrune, "data.compatibility.features.manifestPrune")
	};
}
function requireNonEmptyString(value, fieldName) {
	if (typeof value !== "string") throw new TypeError(`${fieldName} must be a string.`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new TypeError(`${fieldName} must not be empty.`);
	return trimmed;
}
function requireBoolean(value, fieldName) {
	if (typeof value !== "boolean") throw new TypeError(`${fieldName} must be a boolean.`);
	return value;
}
function requireInteger(value, fieldName) {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${fieldName} must be an integer.`);
	return value;
}
function evaluateCompatibility(compatibility) {
	const reasons = [];
	const minimumVersion = parseVersion(HONUA_MINIMUM_SUPPORTED_SERVER_VERSION);
	const serverVersion = parseVersion(compatibility.serverVersion);
	if (!minimumVersion) {
		reasons.push(`SDK minimum supported version '${HONUA_MINIMUM_SUPPORTED_SERVER_VERSION}' is not parseable for compatibility checks.`);
		return reasons;
	}
	if (!serverVersion) reasons.push(`Server version '${compatibility.serverVersion}' is not parseable for compatibility checks.`);
	else if (compareVersions(serverVersion, minimumVersion) < 0) reasons.push(`Server version ${compatibility.serverVersion} is older than the minimum supported ${HONUA_MINIMUM_SUPPORTED_SERVER_VERSION}.`);
	if (compatibility.controlPlaneApi.major !== SUPPORTED_CONTROL_PLANE_API_MAJOR) reasons.push(`Control-plane API major ${compatibility.controlPlaneApi.major} is unsupported; expected ${SUPPORTED_CONTROL_PLANE_API_MAJOR}.`);
	if (normalizePathValue(compatibility.controlPlaneApi.basePath) !== SUPPORTED_CONTROL_PLANE_API_BASE_PATH) reasons.push(`Control-plane API base path ${compatibility.controlPlaneApi.basePath} is unsupported; expected ${SUPPORTED_CONTROL_PLANE_API_BASE_PATH}.`);
	if (compatibility.controlPlaneApi.deprecated) reasons.push(`Control-plane API major ${compatibility.controlPlaneApi.major} is marked deprecated by the server.`);
	const actualReleaseChannelRank = getReleaseChannelRank(compatibility.releaseChannel);
	const minimumReleaseChannelRank = getReleaseChannelRank("preview") ?? 0;
	if (actualReleaseChannelRank === void 0) reasons.push(`Server release channel '${compatibility.releaseChannel}' is not recognized by this SDK baseline.`);
	else if (actualReleaseChannelRank < minimumReleaseChannelRank) reasons.push(`Server release channel '${compatibility.releaseChannel}' is below the minimum supported '${MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL}'.`);
	return reasons;
}
function parseVersion(version) {
	const normalized = version.trim().replace(/^v/i, "");
	if (normalized.length === 0) return;
	const [core, prerelease = ""] = (normalized.split("+", 1)[0] ?? normalized).split("-", 2);
	const numbers = core.split(".").map((segment) => Number.parseInt(segment, 10));
	if (numbers.length === 0 || numbers.some((segment) => !Number.isFinite(segment))) return;
	return {
		numbers,
		prerelease: prerelease.length > 0 ? prerelease.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0) : []
	};
}
function compareVersions(left, right) {
	const length = Math.max(left.numbers.length, right.numbers.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = left.numbers[index] ?? 0;
		const rightPart = right.numbers[index] ?? 0;
		if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
	if (left.prerelease.length === 0) return 1;
	if (right.prerelease.length === 0) return -1;
	const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < prereleaseLength; index += 1) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === void 0) return -1;
		if (rightPart === void 0) return 1;
		if (leftPart === rightPart) continue;
		const leftNumeric = Number.parseInt(leftPart, 10);
		const rightNumeric = Number.parseInt(rightPart, 10);
		const leftIsNumeric = String(leftNumeric) === leftPart;
		const rightIsNumeric = String(rightNumeric) === rightPart;
		if (leftIsNumeric && rightIsNumeric) return leftNumeric < rightNumeric ? -1 : 1;
		if (leftIsNumeric) return -1;
		if (rightIsNumeric) return 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}
function describeCompatibilityError(error) {
	if (error instanceof HonuaHttpError && error.statusCode === 404) return "Server does not expose GET /api/v1/admin/capabilities.";
	if (error instanceof Error) return error.message;
	return String(error);
}
function normalizePathValue(path) {
	const trimmed = path.trim();
	if (trimmed.length === 0) return "";
	return trimTrailingSlashes(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
}
function getReleaseChannelRank(releaseChannel) {
	switch (releaseChannel.trim().toLowerCase()) {
		case "nightly": return 0;
		case "dev": return 1;
		case "alpha": return 2;
		case "preview": return 3;
		case "beta": return 4;
		case "rc": return 5;
		case "stable": return 6;
		case "lts": return 7;
		default: return;
	}
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/geoservices.js
/**
* Esri GeoServices wire methods: service/layer metadata plus the
* FeatureServer / MapServer operation endpoints (query, applyEdits,
* related-records, export, legend, identify, find). Concrete URL-building
* and param serialization invoked against an injected
* {@link HonuaProtocolTransport}. The `HonuaClient` facade delegates here;
* the gRPC-web fast path for `queryFeatures` is orchestrated by the client.
*
* @module
*/
async function listServices(transport, format, options = {}) {
	const path = `/rest/services?${new URLSearchParams({ f: format }).toString()}`;
	return transport.requestCachedMetadataJson(`geoservices:services:${format}`, path, options);
}
async function getLayerMetadata(transport, serviceId, layerId, options = {}) {
	const query = new URLSearchParams({ f: "json" });
	const path = `/rest/services/${encodeServiceIdPath(serviceId)}/FeatureServer/${layerId}?${query.toString()}`;
	return transport.requestCachedMetadataJson(`geoservices-feature:${serviceId}:${layerId}`, path, options);
}
async function getFeatureServiceMetadata(transport, serviceId, options = {}) {
	const query = new URLSearchParams({ f: "json" });
	const path = `/rest/services/${encodeServiceIdPath(serviceId)}/FeatureServer?${query.toString()}`;
	return transport.requestCachedMetadataJson(`geoservices-feature:${serviceId}:service`, path, options);
}
async function getMapServiceMetadata(transport, serviceId, options = {}) {
	const query = new URLSearchParams({ f: "json" });
	const path = `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer?${query.toString()}`;
	return transport.requestCachedMetadataJson(`geoservices-map:${serviceId}:service`, path, options);
}
async function getMapLayerMetadata(transport, serviceId, layerId, options = {}) {
	const query = new URLSearchParams({ f: "json" });
	const path = `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/${layerId}?${query.toString()}`;
	return transport.requestCachedMetadataJson(`geoservices-map:${serviceId}:${layerId}`, path, options);
}
/**
* REST portion of `client.queryFeatures` (the gRPC-web fast path is
* orchestrated by the client). Maps directly to the FeatureServer `query`
* endpoint, optionally negotiating a PBF response on `GET` when
* `preferBinary` is set.
*/
async function queryFeaturesRest(transport, request, preferBinary) {
	const method = request.method ?? "GET";
	const usePbf = preferBinary && method === "GET";
	const params = new URLSearchParams();
	params.set("f", usePbf ? "pbf" : "json");
	params.set("where", request.where ?? "1=1");
	params.set("outFields", normalizeOutFields(request.outFields));
	params.set("returnGeometry", String(request.returnGeometry ?? true));
	serializeQueryParams$1(params, request);
	appendQueryExtraParams(params, request);
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/query`;
	if (usePbf) return transport.requestBinaryWithJsonFallback("GET", `${path}?${params.toString()}`, params, request.signal);
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	}, request.signal);
}
async function queryMapLayer(transport, request) {
	const method = request.method ?? "GET";
	const params = new URLSearchParams();
	params.set("f", "json");
	params.set("where", request.where ?? "1=1");
	params.set("outFields", normalizeOutFields(request.outFields));
	params.set("returnGeometry", String(request.returnGeometry ?? true));
	serializeQueryParams$1(params, request);
	appendQueryExtraParams(params, request);
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/${request.layerId}/query`;
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	}, request.signal);
}
async function applyEdits(transport, request) {
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/applyEdits`;
	const params = new URLSearchParams();
	params.set("f", "json");
	params.set("rollbackOnFailure", String(request.rollbackOnFailure ?? true));
	if (request.adds !== void 0) params.set("adds", encodeFormValue(request.adds));
	if (request.updates !== void 0) params.set("updates", encodeFormValue(request.updates));
	if (request.deletes !== void 0) params.set("deletes", encodeDeletesValue(request.deletes));
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	}, request.signal);
}
async function queryRelatedRecords(transport, request) {
	const method = request.method ?? "GET";
	const params = new URLSearchParams();
	params.set("f", "json");
	params.set("relationshipId", String(request.relationshipId));
	if (request.objectIds !== void 0) params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
	params.set("where", request.where ?? "1=1");
	params.set("outFields", normalizeOutFields(request.outFields));
	params.set("returnGeometry", String(request.returnGeometry ?? true));
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/queryRelatedRecords`;
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	}, request.signal);
}
async function queryMapRelatedRecords(transport, request) {
	const method = request.method ?? "GET";
	const params = new URLSearchParams();
	params.set("f", "json");
	params.set("relationshipId", String(request.relationshipId));
	if (request.objectIds !== void 0) params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
	params.set("where", request.where ?? "1=1");
	params.set("outFields", normalizeOutFields(request.outFields));
	params.set("returnGeometry", String(request.returnGeometry ?? true));
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/${request.layerId}/queryRelatedRecords`;
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	}, request.signal);
}
async function exportMap(transport, request) {
	const method = request.method ?? "GET";
	const params = new URLSearchParams();
	params.set("f", request.responseFormat ?? "json");
	params.set("bbox", normalizeBBox(request.bbox));
	params.set("size", normalizeSize(request.size));
	if (request.format !== void 0) params.set("format", request.format);
	if (request.dpi !== void 0) params.set("dpi", String(request.dpi));
	if (request.transparent !== void 0) params.set("transparent", String(request.transparent));
	if (request.layers !== void 0) params.set("layers", request.layers);
	if (request.bboxSr !== void 0) params.set("bboxSR", String(request.bboxSr));
	if (request.imageSr !== void 0) params.set("imageSR", String(request.imageSr));
	if (request.backgroundColor !== void 0) params.set("backgroundColor", request.backgroundColor);
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/export`;
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	});
}
async function getMapLegend(transport, request) {
	const params = new URLSearchParams();
	params.set("f", request.responseFormat ?? "json");
	if (request.size !== void 0) params.set("size", normalizeLegendSize(request.size));
	if (request.dynamicLayers !== void 0) params.set("dynamicLayers", request.dynamicLayers);
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/legend`;
	return transport.requestJson("GET", `${path}?${params.toString()}`);
}
async function identifyMap(transport, request) {
	const method = request.method ?? "GET";
	const params = new URLSearchParams();
	params.set("f", request.responseFormat ?? "json");
	params.set("geometry", normalizeIdentifyGeometry(request.geometry));
	params.set("geometryType", request.geometryType ?? "esriGeometryPoint");
	params.set("mapExtent", normalizeMapExtent(request.mapExtent));
	params.set("imageDisplay", normalizeImageDisplay(request.imageDisplay));
	params.set("returnGeometry", String(request.returnGeometry ?? true));
	params.set("tolerance", String(request.tolerance ?? 3));
	if (request.sr !== void 0) params.set("sr", String(request.sr));
	if (request.layers !== void 0) params.set("layers", request.layers);
	if (request.maxAllowableOffset !== void 0) params.set("maxAllowableOffset", String(request.maxAllowableOffset));
	if (request.layerDefs !== void 0) params.set("layerDefs", request.layerDefs);
	if (request.dynamicLayers !== void 0) params.set("dynamicLayers", request.dynamicLayers);
	if (request.time !== void 0) params.set("time", request.time);
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/identify`;
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	});
}
async function findMap(transport, request) {
	const method = request.method ?? "GET";
	const params = new URLSearchParams();
	params.set("f", request.responseFormat ?? "json");
	params.set("searchText", request.searchText);
	params.set("contains", String(request.contains ?? true));
	if (request.searchFields !== void 0) params.set("searchFields", normalizeSearchFields(request.searchFields));
	if (request.layers !== void 0) params.set("layers", request.layers);
	if (request.sr !== void 0) params.set("sr", String(request.sr));
	if (request.layerDefs !== void 0) params.set("layerDefs", request.layerDefs);
	if (request.returnGeometry !== void 0) params.set("returnGeometry", String(request.returnGeometry));
	if (request.maxAllowableOffset !== void 0) params.set("maxAllowableOffset", String(request.maxAllowableOffset));
	if (request.dynamicLayers !== void 0) params.set("dynamicLayers", request.dynamicLayers);
	if (request.returnZ !== void 0) params.set("returnZ", String(request.returnZ));
	if (request.returnM !== void 0) params.set("returnM", String(request.returnM));
	if (request.gdbVersion !== void 0) params.set("gdbVersion", request.gdbVersion);
	if (request.time !== void 0) params.set("time", request.time);
	if (request.relationParam !== void 0) params.set("relationParam", request.relationParam);
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/find`;
	if (method === "GET") return transport.requestJson("GET", `${path}?${params.toString()}`);
	return transport.requestJson("POST", path, {
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString()
	});
}
function normalizeOutFields(outFields) {
	if (outFields === void 0) return "*";
	if (Array.isArray(outFields)) return outFields.length > 0 ? outFields.join(",") : "";
	return outFields;
}
function encodeFormValue(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
function encodeDeletesValue(value) {
	if (Array.isArray(value)) return value.join(",");
	return String(value);
}
function normalizeBBox(bbox) {
	return Array.isArray(bbox) ? bbox.join(",") : bbox;
}
function normalizeSize(size) {
	return Array.isArray(size) ? size.join(",") : size;
}
function normalizeLegendSize(size) {
	if (typeof size === "number") return String(size);
	if (Array.isArray(size)) return size.join(",");
	return size;
}
function normalizeIdentifyGeometry(geometry) {
	return typeof geometry === "string" ? geometry : JSON.stringify(geometry);
}
function normalizeMapExtent(mapExtent) {
	return Array.isArray(mapExtent) ? mapExtent.join(",") : mapExtent;
}
function normalizeImageDisplay(imageDisplay) {
	return Array.isArray(imageDisplay) ? imageDisplay.join(",") : imageDisplay;
}
function normalizeSearchFields(searchFields) {
	if (!searchFields) return "";
	return Array.isArray(searchFields) ? searchFields.join(",") : searchFields;
}
function serializeQueryParams$1(params, request) {
	if (request.outSr !== void 0) params.set("outSR", typeof request.outSr === "object" && request.outSr !== null ? JSON.stringify(request.outSr) : String(request.outSr));
	if (request.orderByFields !== void 0) params.set("orderByFields", request.orderByFields);
	if (request.objectIds !== void 0) params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
	if (request.geometry !== void 0) params.set("geometry", typeof request.geometry === "object" && request.geometry !== null ? JSON.stringify(request.geometry) : String(request.geometry));
	if (request.geometryType !== void 0) params.set("geometryType", request.geometryType);
	if (request.spatialRel !== void 0) params.set("spatialRel", request.spatialRel);
	if (request.returnDistinctValues !== void 0) params.set("returnDistinctValues", String(request.returnDistinctValues));
	if (request.returnCentroid !== void 0) params.set("returnCentroid", String(request.returnCentroid));
	if (request.groupByFieldsForStatistics !== void 0) params.set("groupByFieldsForStatistics", request.groupByFieldsForStatistics);
	if (request.outStatistics !== void 0) params.set("outStatistics", Array.isArray(request.outStatistics) ? JSON.stringify(request.outStatistics) : String(request.outStatistics));
	if (request.resultOffset !== void 0) params.set("resultOffset", String(request.resultOffset));
	if (request.resultRecordCount !== void 0) params.set("resultRecordCount", String(request.resultRecordCount));
}
function appendQueryExtraParams(params, request) {
	if (!request.extraParams) return;
	for (const [key, value] of Object.entries(request.extraParams)) {
		if (request.outSr !== void 0 && (key === "outSr" || key === "outSR")) continue;
		params.set(key, String(value));
	}
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/odata-key-path.js
/**
* Encode an OData key predicate without hiding its structural grammar.
*
* Quotes plus the `,` / `=` delimiters outside quoted literals remain
* visible to direct and JSON-batch OData parsers. Unsafe value characters
* are percent-encoded by Unicode code point so non-BMP string keys remain
* valid path data rather than splitting or truncating the target URL.
*
* @internal
*/
function encodeOdataKeyPredicatePath(key) {
	const raw = String(key);
	let output = "";
	let inQuote = false;
	for (const character of raw) {
		if (character === "'") {
			inQuote = !inQuote;
			output += "'";
			continue;
		}
		if (!inQuote && (character === "," || character === "=")) {
			output += character;
			continue;
		}
		output += /[A-Za-z0-9\-._~]/.test(character) ? character : encodeURIComponent(character);
	}
	return output;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/odata.js
/**
* OData v4 entity-set adapter. Wraps an OData entity set behind the shared
* `Source<T>` contract surface in `src/contract/source.ts`.
*
* Library posture is recorded in
* `docs/decisions/odata-library-selection.md`: the canonical surface is a
* thin URL/JSON serializer over `HonuaClient.pipelineFetch` /
* `pipelineRequestJson` (rather than the GeoServices-shaped
* `request()` helper, which would inject `f=json` and trip Honua
* Server's OData validators) so that the auth / retry / telemetry
* pipeline stays centralized. The dialect-specific `$batch` / `$apply`
* / `$search` / `$deltatoken` operations live behind the typed escape
* hatch returned by `Source.protocol("odata")`.
*
* @module
*/
var MAX_ODATA_METADATA_CHARACTERS = 4 * 1024 * 1024;
var ODATA_SOURCE_SCHEMA_PROJECTION_SAFETY = Symbol("honua.odata.source-schema-projection-safety");
var ODATA_SOURCE_SCHEMA_PROJECTION_DETAILS = Symbol("honua.odata.source-schema-projection-details");
/**
* Runtime handle for one OData entity set. Returned by
* `Source.protocol("odata")` so callers can reach the dialect-specific
* surface (`$batch`, `$apply`, `$search`, `$deltatoken`) without leaking
* OData-shaped types into the canonical `Source` API.
*/
var HonuaOdataEntitySet = class {
	client;
	entitySet;
	/**
	* Unqualified entity-set name used as the CSDL metadata-lookup key.
	* Equals `entitySet` for direct paths like `"Parcels"`. For
	* layer-scoped navigation paths like `"Layers(1)/Features"` it is the
	* navigation suffix `"Features"` so capability and schema lookups
	* still find the entry the server emits in `<EntitySet Name="…">`.
	*/
	entitySetName;
	basePath;
	cachedMetadata;
	inflightMetadata;
	constructor(options) {
		this.client = options.client;
		this.entitySet = options.entitySet;
		this.entitySetName = extractEntitySetName(options.entitySet);
		this.basePath = normalizeBasePath(options.basePath);
	}
	/**
	* Fetch (and cache) the `$metadata` document. The cache is per
	* `HonuaOdataEntitySet` instance so callers can pin a metadata snapshot
	* to a long-lived `Source` without re-parsing on every request.
	*/
	async metadata(options = {}) {
		const metadataOptions = normalizeHonuaMetadataRequestOptions(options);
		const bypass = metadataOptions.cache === "bypass";
		const now = Date.now();
		const freshCachedMetadata = this.cachedMetadata ? isHonuaCacheEntryFresh(this.cachedMetadata.cachedAtMs, now, metadataOptions.ttlMs) : false;
		if (!bypass && !metadataOptions.refresh && this.cachedMetadata && freshCachedMetadata) return withOdataMetadataCacheState(this.cachedMetadata, "hit", {
			now,
			ttlMs: metadataOptions.ttlMs,
			staleIfErrorMs: metadataOptions.staleIfErrorMs
		});
		if (!bypass && !metadataOptions.refresh && this.inflightMetadata) return this.inflightMetadata;
		const previous = this.cachedMetadata;
		const promise = this.fetchMetadata(metadataOptions, previous).then((entry) => {
			if (!bypass) this.cachedMetadata = entry;
			const status = bypass ? "bypass" : entry.status;
			return withOdataMetadataCacheState(entry, status, {
				now: Date.now(),
				ttlMs: metadataOptions.ttlMs,
				staleIfErrorMs: metadataOptions.staleIfErrorMs,
				...status === "refreshed" ? { revalidatedAt: (/* @__PURE__ */ new Date()).toISOString() } : {}
			});
		});
		const staleFallback = (error) => {
			if (!bypass && metadataOptions.staleIfError && previous) return withOdataMetadataCacheState(previous, "stale", {
				now: Date.now(),
				ttlMs: metadataOptions.ttlMs,
				staleIfErrorMs: metadataOptions.staleIfErrorMs,
				refreshErrorId: odataMetadataRefreshErrorId(error)
			});
			throw error;
		};
		if (!bypass && !metadataOptions.refresh) {
			const trackedPromise = promise.catch(staleFallback).finally(() => {
				if (this.inflightMetadata === trackedPromise) this.inflightMetadata = void 0;
			});
			this.inflightMetadata = trackedPromise;
			return trackedPromise;
		}
		try {
			return await promise;
		} catch (error) {
			return staleFallback(error);
		}
	}
	/** Fetch one page of the entity set. */
	async query(params = {}) {
		const path = this.entitySetPath();
		const query = serializeQueryParams(params);
		const body = await this.requestJson("GET", path, query, params.signal);
		return {
			rows: body.value ?? [],
			...typeof body["@odata.count"] === "number" ? { totalCount: body["@odata.count"] } : {},
			...typeof body["@odata.nextLink"] === "string" ? { nextLink: body["@odata.nextLink"] } : {},
			...typeof body["@odata.deltaLink"] === "string" ? { deltaLink: body["@odata.deltaLink"] } : {}
		};
	}
	/**
	* Drain server-driven `@odata.nextLink` pages. When `params.top` is
	* supplied it is treated as a hard cap on collected rows. Callers that
	* want a lookahead row to detect truncation must add it themselves; the
	* canonical `Source.queryAll` path does this with `top = limit + 1`,
	* while ids-only projections enforce their own result cap.
	* Returning `top + 1` here would double-count for callers that already
	* added the lookahead, so this helper respects `top` exactly.
	*/
	async queryAll(params = {}) {
		const cap = typeof params.top === "number" && params.top >= 0 ? params.top : void 0;
		const collected = [];
		let totalCount;
		let next;
		let firstPageParams = params;
		while (true) {
			const page = next ? await this.followNextLink(next, params.signal) : await this.query(firstPageParams ?? {});
			firstPageParams = void 0;
			if (totalCount === void 0 && typeof page.totalCount === "number") totalCount = page.totalCount;
			for (const row of page.rows) {
				if (cap !== void 0 && collected.length >= cap) break;
				collected.push(row);
				if (cap !== void 0 && collected.length >= cap) break;
			}
			if (cap !== void 0 && collected.length >= cap) break;
			if (!page.nextLink) break;
			next = page.nextLink;
		}
		return totalCount === void 0 ? { rows: collected } : {
			rows: collected,
			totalCount
		};
	}
	/** Yield one page per server response. Used by `Source.stream()`. */
	async *queryStream(params = {}) {
		let page = await this.query(params);
		yield page;
		while (page.nextLink) {
			page = await this.followNextLink(page.nextLink, params.signal);
			yield page;
		}
	}
	/** Insert a row via `POST /<entitySet>`. */
	async add(body, options = {}) {
		const path = this.entitySetPath();
		return this.requestJson("POST", path, void 0, options.signal, JSON.stringify(body), { "Content-Type": options.contentType ?? "application/json" });
	}
	/**
	* Update a row via `PATCH /<entitySet>(<key>)`. The OData server in
	* Honua Server intentionally does not implement `PUT`; the SDK issues
	* `PATCH` with the full canonical body to match a `PUT` replacement on
	* the canonical surface (documented in
	* `docs/protocol-capability-matrix.md` under the OData section).
	*/
	async update(key, body, options = {}) {
		const path = `${this.entitySetPath()}(${encodeOdataKeyPredicatePath(key)})`;
		return this.requestJson("PATCH", path, void 0, options.signal, JSON.stringify(body), { "Content-Type": options.contentType ?? "application/json" });
	}
	/** Delete a row via `DELETE /<entitySet>(<key>)`. */
	async delete(key, options = {}) {
		const path = `${this.entitySetPath()}(${encodeOdataKeyPredicatePath(key)})`;
		await this.requestJson("DELETE", path, void 0, options.signal);
	}
	/**
	* Submit a `$batch` request using the OData JSON batch format.
	* Multipart/mixed fallback is intentionally not implemented; Honua
	* Server emits both formats but the JSON envelope is sufficient for
	* the canonical surface and avoids the multipart parser.
	*
	* `atomicity: "all"` stamps the same `atomicityGroup` token on every
	* request so the server runs them in one change-set with rollback on
	* any failure (per OData v4 §11.7.7.3 and Honua Server's
	* `ODataBatchHandler`, which groups by `request.AtomicityGroup`).
	* `atomicity: "none"` (default) leaves the field unset so each request
	* runs independently.
	*/
	async batch(operations, options = {}) {
		if (operations.length === 0) return { responses: [] };
		const groupId = options.atomicity === "all" ? "g1" : void 0;
		const requests = operations.map((op, index) => ({
			id: op.id ?? String(index + 1),
			method: op.method,
			url: stripLeadingSlash(op.url),
			...op.headers ? { headers: {
				"Content-Type": "application/json",
				...op.headers
			} } : { headers: { "Content-Type": "application/json" } },
			...op.body !== void 0 ? { body: op.body } : {},
			...groupId !== void 0 ? { atomicityGroup: groupId } : {}
		}));
		return { responses: (await this.requestJson("POST", `${this.basePath}/$batch`, void 0, options.signal, JSON.stringify({ requests }), { "Content-Type": "application/json" })).responses ?? [] };
	}
	/**
	* Run an `$apply` aggregation. The OData server applies the
	* transformation pipeline (`aggregate`, `groupby`, `filter`,
	* `compute`); the SDK returns the rows unchanged so callers can shape
	* them onto the canonical `Result.aggregateRows`.
	*/
	async apply(transformations, params = {}) {
		const path = this.entitySetPath();
		const query = serializeQueryParams({
			apply: transformations,
			filter: params.filter
		});
		const body = await this.requestJson("GET", path, query, params.signal);
		return {
			rows: body.value ?? [],
			...typeof body["@odata.count"] === "number" ? { totalCount: body["@odata.count"] } : {}
		};
	}
	/**
	* Run a `$search` full-text query. Returns an `HonuaOdataPage` so the
	* canonical `Result<T>` projection is symmetric with `query()`.
	*/
	async search(text, params = {}) {
		return this.query({
			...params,
			search: text
		});
	}
	/**
	* `$deltatoken`-driven change feed. Yields `HonuaOdataDeltaPage` per
	* server response. The final page carries `deltaLink`; callers persist
	* the encoded token for the next call to `delta({ since })`.
	*/
	async *delta(options = {}) {
		const params = options.since ? { deltatoken: options.since } : {};
		if (options.signal) params.signal = options.signal;
		let page = await this.query(params);
		yield {
			rows: page.rows,
			...page.nextLink ? { nextLink: page.nextLink } : {},
			...page.deltaLink ? { deltaLink: page.deltaLink } : {}
		};
		while (page.nextLink) {
			page = await this.followNextLink(page.nextLink, options.signal);
			yield {
				rows: page.rows,
				...page.nextLink ? { nextLink: page.nextLink } : {},
				...page.deltaLink ? { deltaLink: page.deltaLink } : {}
			};
		}
	}
	/**
	* Last-resort raw passthrough — flows through `HonuaClient.pipelineFetch`
	* so auth headers, retry, timeout, interceptors, telemetry, and
	* normalized error mapping all apply. The returned `Response` is
	* unconsumed; callers pick `.json()`, `.text()`, or `.arrayBuffer()`.
	*/
	async raw(method, path, init = {}) {
		const normalized = method.toUpperCase();
		return this.client.pipelineFetch(normalized, ensureLeadingSlash(path), init);
	}
	entitySetPath() {
		return `${this.basePath}/${this.entitySet}`;
	}
	async fetchMetadata(options, cached) {
		const response = await this.client.pipelineFetch("GET", `${this.basePath}/$metadata`, { headers: honuaMetadataRequestHeaders({
			accept: "application/xml",
			refresh: options.refresh || Boolean(cached),
			bypass: options.cache === "bypass",
			validator: cached?.validator
		}) }, options.signal, { okStatuses: [304] });
		if (response.status === 304 && cached) {
			const validator = honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator;
			return {
				...cached,
				cachedAtMs: Date.now(),
				...validator ? { validator } : {},
				status: "refreshed"
			};
		}
		const xml = await response.text();
		const validator = honuaCacheValidatorFromHeaders(response.headers);
		const sourceUpdatedAt = response.headers.get("last-modified") ?? void 0;
		return {
			metadata: withoutHonuaCacheState(parseOdataMetadata(xml)),
			cachedAtMs: Date.now(),
			keyFingerprint: `metadata:odata:${this.basePath}:$metadata`,
			status: options.cache === "bypass" ? "bypass" : cached ? "refreshed" : "miss",
			...validator ? { validator } : {},
			...sourceUpdatedAt ? { sourceUpdatedAt } : {}
		};
	}
	async followNextLink(nextLink, signal) {
		const { path, query } = parseNextLink(nextLink, this.client.serverBaseUrl, this.basePath);
		const body = await this.requestJson("GET", path, query, signal);
		return {
			rows: body.value ?? [],
			...typeof body["@odata.count"] === "number" ? { totalCount: body["@odata.count"] } : {},
			...typeof body["@odata.nextLink"] === "string" ? { nextLink: body["@odata.nextLink"] } : {},
			...typeof body["@odata.deltaLink"] === "string" ? { deltaLink: body["@odata.deltaLink"] } : {}
		};
	}
	/**
	* Wrap `HonuaClient.pipelineRequestJson` with OData-shaped query
	* serialization so callers can pass parsed query bags. Critically this
	* does **not** go through `HonuaClient.request` — that helper injects
	* `f=json`, which Honua Server's OData validators reject as
	* `InvalidQueryOption`. The OData server defaults to JSON when the
	* request advertises `Accept: application/json` (the pipeline default).
	*/
	async requestJson(method, path, query, signal, body, headers) {
		const params = new URLSearchParams();
		if (query) for (const [key, value] of Object.entries(query)) params.set(key, String(value));
		const pathWithQuery = params.size > 0 ? `${path}?${params.toString()}` : path;
		return this.client.pipelineRequestJson(method, pathWithQuery, {
			...headers ? { headers } : {},
			...body !== void 0 ? { body } : {}
		}, signal);
	}
};
function withOdataMetadataCacheState(entry, status, options) {
	return withHonuaCacheState(entry.metadata, createHonuaCacheState({
		scope: "metadata",
		status,
		keyFingerprint: entry.keyFingerprint,
		ageMs: Math.max(0, options.now - entry.cachedAtMs),
		...options.ttlMs !== void 0 ? { ttlMs: options.ttlMs } : {},
		...options.staleIfErrorMs !== void 0 ? { staleIfErrorMs: options.staleIfErrorMs } : {},
		...options.revalidatedAt ? { revalidatedAt: options.revalidatedAt } : {},
		...entry.sourceUpdatedAt ? { sourceUpdatedAt: entry.sourceUpdatedAt } : {},
		...entry.validator ? { validator: entry.validator } : {},
		...options.refreshErrorId ? { refreshErrorId: options.refreshErrorId } : {}
	}));
}
function odataMetadataRefreshErrorId(error) {
	if (error instanceof Error && error.name) return error.name;
	return "unknown";
}
function normalizeBasePath(path) {
	if (path === void 0 || path === "") return "/odata";
	return path.startsWith("/") ? trimTrailingSlashes(path) || "/" : `/${trimTrailingSlashes(path)}`;
}
/**
* Extract the unqualified entity-set name from a path-shaped token.
* Direct identifiers (`"Parcels"`) round-trip unchanged; navigation paths
* (`"Layers(1)/Features"`) collapse to the trailing segment so CSDL
* metadata lookups (which key by `<EntitySet Name="…">`) still hit.
*/
function extractEntitySetName(path) {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}
function ensureLeadingSlash(path) {
	return path.startsWith("/") ? path : `/${path}`;
}
function stripLeadingSlash(path) {
	return path.startsWith("/") ? path.slice(1) : path;
}
/**
* Translate canonical query params onto the OData `$`-prefixed query
* string. Empty strings, undefined values, and zero-length lists are
* dropped so the URL stays minimal.
*/
function serializeQueryParams(params) {
	const out = {};
	if (params.filter !== void 0 && params.filter !== "") out.$filter = params.filter;
	if (params.select && params.select.length > 0) out.$select = params.select.join(",");
	if (params.orderBy && params.orderBy.length > 0) out.$orderby = params.orderBy.join(",");
	if (typeof params.top === "number" && Number.isFinite(params.top)) out.$top = params.top;
	if (typeof params.skip === "number" && Number.isFinite(params.skip) && params.skip > 0) out.$skip = params.skip;
	if (params.expand && params.expand.length > 0) out.$expand = params.expand.join(",");
	if (params.count) out.$count = "true";
	if (params.skiptoken !== void 0 && params.skiptoken !== "") out.$skiptoken = params.skiptoken;
	if (params.search !== void 0 && params.search !== "") out.$search = params.search;
	if (params.apply !== void 0 && params.apply !== "") out.$apply = params.apply;
	if (params.deltatoken !== void 0 && params.deltatoken !== "") out.$deltatoken = params.deltatoken;
	if (params.extra) Object.assign(out, params.extra);
	return out;
}
/**
* `@odata.nextLink` is either an absolute URL (preferred by spec) or a
* service-relative URL. Reduce it to the path + query bag the same fetch
* pipeline expects.
*/
function parseNextLink(link, serverBaseUrl, basePath) {
	const absolute = link.startsWith("http://") || link.startsWith("https://") ? new URL(link) : new URL(link, `${ensureTrailingSlash(serverBaseUrl)}${stripLeadingSlash(basePath)}/`);
	const path = absolute.pathname;
	const query = {};
	for (const [key, value] of absolute.searchParams) query[key] = value;
	return {
		path,
		query
	};
}
function ensureTrailingSlash(url) {
	return url.endsWith("/") ? url : `${url}/`;
}
/**
* Parse the subset of CSDL we need to power capability negotiation and
* key resolution: entity sets, entity-type keys, property names + types,
* `Edm.Geography` / `Edm.Geometry` typing, and `Capabilities.*`
* annotations. The XML is read via small regular expressions because we
* intentionally do not pull a DOM dep — the surface we read is
* well-defined by OData CSDL §6 and the Honua Server spec page.
*/
function parseOdataMetadata(xml) {
	if (xml.length > MAX_ODATA_METADATA_CHARACTERS) throw new RangeError(`OData metadata exceeds ${MAX_ODATA_METADATA_CHARACTERS} characters`);
	const entitySets = Object.create(null);
	const keys = Object.create(null);
	const fields = Object.create(null);
	const projectionFields = Object.create(null);
	const complexTypes = Object.create(null);
	const enumTypes = Object.create(null);
	const openTypes = Object.create(null);
	const capabilities = Object.create(null);
	const siblingByEntitySet = /* @__PURE__ */ new Map();
	for (const element of xmlElements(xml, "Annotations")) {
		const attrs = element.attributes;
		const target = readAttr(attrs, "Target");
		if (!target) continue;
		const slash = target.lastIndexOf("/");
		if (slash === -1) continue;
		const setName = target.slice(slash + 1);
		if (!setName) continue;
		const body = element.body;
		const existing = siblingByEntitySet.get(setName);
		siblingByEntitySet.set(setName, existing === void 0 ? body : `${existing}\n${body}`);
	}
	for (const element of xmlElements(xml, "EntitySet")) {
		const attrs = element.attributes;
		const name = readAttr(attrs, "Name");
		const type = readAttr(attrs, "EntityType");
		if (!name || !type) continue;
		entitySets[name] = stripNamespace(type);
		const inlineBody = element.body;
		capabilities[name] = parseEntitySetAnnotations(`${inlineBody}\n${siblingByEntitySet.get(name) ?? ""}`);
		siblingByEntitySet.delete(name);
	}
	for (const [setName, body] of siblingByEntitySet) capabilities[setName] = parseEntitySetAnnotations(body);
	for (const element of xmlElements(xml, "EntityType")) {
		const attrs = element.attributes;
		const body = element.body;
		const name = readAttr(attrs, "Name");
		if (!name) continue;
		if (readAttr(attrs, "OpenType")?.toLowerCase() === "true") openTypes[name] = true;
		const keyNames = [];
		const keyBlock = xmlElements(body, "Key").next();
		if (!keyBlock.done) for (const refAttrs of xmlStartTags(keyBlock.value.body, "PropertyRef")) {
			const refName = readAttr(refAttrs, "Name");
			if (refName) keyNames.push(refName);
		}
		keys[name] = keyNames;
		const richFields = parseOdataProperties(body);
		projectionFields[name] = richFields;
		fields[name] = richFields.map(legacyOdataFieldInfo);
	}
	for (const element of xmlElements(xml, "ComplexType")) {
		const name = readAttr(element.attributes, "Name");
		if (name) complexTypes[name] = parseOdataProperties(element.body);
	}
	for (const element of xmlElements(xml, "EnumType")) {
		const attrs = element.attributes;
		const name = readAttr(attrs, "Name");
		if (!name) continue;
		const underlyingType = readAttr(attrs, "UnderlyingType") ?? "Edm.Int32";
		const isFlags = readAttr(attrs, "IsFlags")?.toLowerCase() === "true";
		const declarations = [...xmlStartTags(element.body, "Member")].map((memberAttrs) => ({
			name: readAttr(memberAttrs, "Name"),
			rawValue: readAttr(memberAttrs, "Value")
		}));
		const hasExplicit = declarations.some((member) => member.rawValue !== void 0);
		const hasImplicit = declarations.some((member) => member.rawValue === void 0);
		const valueMode = hasExplicit ? hasImplicit ? "mixed" : "explicit" : "implicit";
		let declarationReason;
		const invalidate = (reason) => {
			declarationReason ??= reason;
		};
		const bounds = odataEnumBounds(underlyingType);
		if (declarations.length === 0) invalidate("empty-declaration");
		if (!bounds) invalidate("invalid-underlying-type");
		if (isFlags && hasImplicit) invalidate("flags-require-explicit-values");
		const members = [];
		const names = /* @__PURE__ */ new Set();
		let previousValue;
		for (const [index, declaration] of declarations.entries()) {
			let parsed;
			if (declaration.rawValue === void 0) {
				if (!isFlags) parsed = index === 0 ? 0n : previousValue === void 0 ? void 0 : previousValue + 1n;
			} else if (declaration.rawValue.length <= 20 && /^[+-]?\d+$/.test(declaration.rawValue)) try {
				parsed = BigInt(declaration.rawValue);
			} catch {
				parsed = void 0;
			}
			if (parsed === void 0) invalidate("invalid-member-value");
			else if (isFlags && parsed < 0n) invalidate("negative-flags-value");
			else if (bounds && (parsed < bounds.minimum || parsed > bounds.maximum)) invalidate("out-of-range");
			previousValue = parsed;
			if (!declaration.name || !odataSimpleIdentifier(declaration.name)) {
				invalidate("invalid-member-name");
				continue;
			}
			if (names.has(declaration.name)) invalidate("duplicate-member-name");
			names.add(declaration.name);
			if (parsed === void 0) continue;
			const value = underlyingType === "Edm.Int64" || !Number.isSafeInteger(Number(parsed)) ? parsed.toString() : Number(parsed);
			members.push({
				name: declaration.name,
				value
			});
		}
		enumTypes[name] = {
			underlyingType,
			isFlags,
			members,
			declaration: declarationReason ? {
				state: "invalid",
				reason: declarationReason
			} : {
				state: "valid",
				valueMode
			}
		};
	}
	const metadata = {
		entitySets,
		keys,
		fields,
		capabilities
	};
	Object.defineProperty(metadata, ODATA_SOURCE_SCHEMA_PROJECTION_DETAILS, {
		value: {
			fields: projectionFields,
			complexTypes,
			enumTypes,
			openTypes
		},
		enumerable: true
	});
	Object.defineProperty(metadata, ODATA_SOURCE_SCHEMA_PROJECTION_SAFETY, {
		value: inspectOdataSourceSchemaProjectionSafety(xml),
		enumerable: true
	});
	return metadata;
}
function inspectOdataSourceSchemaProjectionSafety(xml) {
	const edmxAttributes = firstXmlStartTagByLocalName(xml, "Edmx");
	const csdlVersion = edmxAttributes === void 0 ? void 0 : readAttr(edmxAttributes, "Version");
	const declarations = /* @__PURE__ */ new Map();
	const inheritedTypeNames = /* @__PURE__ */ new Set();
	const openComplexTypeNames = /* @__PURE__ */ new Set();
	const unqualifiedTypeNames = /* @__PURE__ */ new Set();
	for (const schema of xmlElements(xml, "Schema")) {
		const namespace = readAttr(schema.attributes, "Namespace");
		for (const kind of [
			"EntityType",
			"ComplexType",
			"EnumType"
		]) for (const attributes of xmlStartTags(schema.body, kind)) {
			const name = readAttr(attributes, "Name");
			if (!name) continue;
			const qualifiedIdentity = `${kind}:${namespace ? `${namespace}.${name}` : name}`;
			const identities = declarations.get(name) ?? /* @__PURE__ */ new Map();
			identities.set(qualifiedIdentity, (identities.get(qualifiedIdentity) ?? 0) + 1);
			declarations.set(name, identities);
			if (!namespace) unqualifiedTypeNames.add(name);
			if (kind !== "EnumType" && readAttr(attributes, "BaseType")) inheritedTypeNames.add(name);
			if (kind === "ComplexType" && readAttr(attributes, "OpenType")?.toLowerCase() === "true") openComplexTypeNames.add(name);
		}
	}
	const ambiguousTypeNames = [...declarations].filter(([, identities]) => identities.size > 1 || [...identities.values()].some((count) => count > 1)).map(([name]) => name).sort();
	return Object.freeze({
		...csdlVersion === void 0 ? {} : { csdlVersion },
		ambiguousTypeNames: Object.freeze(ambiguousTypeNames),
		inheritedTypeNames: Object.freeze([...inheritedTypeNames].sort()),
		openComplexTypeNames: Object.freeze([...openComplexTypeNames].sort()),
		unqualifiedTypeNames: Object.freeze([...unqualifiedTypeNames].sort())
	});
}
function odataEnumBounds(underlyingType) {
	switch (underlyingType) {
		case "Edm.Byte": return {
			minimum: 0n,
			maximum: 255n
		};
		case "Edm.SByte": return {
			minimum: -128n,
			maximum: 127n
		};
		case "Edm.Int16": return {
			minimum: -32768n,
			maximum: 32767n
		};
		case "Edm.Int32": return {
			minimum: -2147483648n,
			maximum: 2147483647n
		};
		case "Edm.Int64": return {
			minimum: -(1n << 63n),
			maximum: (1n << 63n) - 1n
		};
		default: return;
	}
}
function odataSimpleIdentifier(value) {
	if (value.length > 256) return false;
	let codePoints = 0;
	for (const _character of value) {
		codePoints += 1;
		if (codePoints > 128) return false;
	}
	return /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*$/u.test(value);
}
function parseOdataProperties(body) {
	const props = [];
	for (const propAttrs of xmlStartTags(body, "Property")) {
		const propName = readAttr(propAttrs, "Name");
		const propType = readAttr(propAttrs, "Type");
		if (!propName || !propType) continue;
		const nullable = readAttr(propAttrs, "Nullable");
		const maxLengthAttr = readAttr(propAttrs, "MaxLength");
		const precisionAttr = readAttr(propAttrs, "Precision");
		const scaleAttr = readAttr(propAttrs, "Scale");
		const sridAttr = readAttr(propAttrs, "SRID");
		const isSpatial = propType.startsWith("Edm.Geography") || propType.startsWith("Edm.Geometry");
		const info = {
			name: propName,
			type: propType
		};
		if (nullable !== void 0) info.nullable = nullable !== "false";
		if (maxLengthAttr?.toLowerCase() === "max") info.maxLength = "max";
		else if (maxLengthAttr !== void 0) {
			const maxLength = Number(maxLengthAttr);
			if (Number.isSafeInteger(maxLength) && maxLength >= 0) info.maxLength = maxLength;
		}
		if (precisionAttr !== void 0) {
			const precision = Number(precisionAttr);
			if (Number.isSafeInteger(precision) && precision >= 0) info.precision = precision;
		}
		if (scaleAttr?.toLowerCase() === "variable" || scaleAttr?.toLowerCase() === "floating") info.scale = scaleAttr.toLowerCase();
		else if (scaleAttr !== void 0) {
			const scale = Number(scaleAttr);
			if (Number.isSafeInteger(scale) && scale >= 0) info.scale = scale;
		}
		if (isSpatial) info.isSpatial = true;
		if (sridAttr?.toLowerCase() === "variable") info.srid = "variable";
		else if (sridAttr !== void 0) {
			const srid = Number(sridAttr);
			if (Number.isSafeInteger(srid) && srid >= 0) info.srid = srid;
		}
		props.push(info);
	}
	return props;
}
function legacyOdataFieldInfo(field) {
	return {
		name: field.name,
		type: field.type,
		...field.nullable === void 0 ? {} : { nullable: field.nullable },
		...field.isSpatial === true ? { isSpatial: true } : {},
		...typeof field.srid === "number" ? { srid: field.srid } : {}
	};
}
function parseEntitySetAnnotations(body) {
	const out = {};
	for (const element of xmlElements(body, "Annotation")) {
		const attrs = element.attributes;
		const term = readAttr(attrs, "Term");
		if (!term || !term.includes("Capabilities.")) continue;
		const inner = element.body.trim();
		const boolValue = readAttr(attrs, "Bool") ?? matchBool(inner) ?? matchPropertyValueBool(inner, "Insertable") ?? matchPropertyValueBool(inner, "Updatable") ?? matchPropertyValueBool(inner, "Deletable") ?? matchPropertyValueBool(inner, "Searchable") ?? matchPropertyValueBool(inner, "Filterable") ?? matchPropertyValueBool(inner, "Expandable") ?? matchPropertyValueBool(inner, "Selectable") ?? matchPropertyValueBool(inner, "Countable") ?? matchPropertyValueBool(inner, "Supported");
		if (term.endsWith("InsertRestrictions")) out.insert = matchPropertyValueBool(inner, "Insertable") !== "false";
		else if (term.endsWith("UpdateRestrictions")) out.update = matchPropertyValueBool(inner, "Updatable") !== "false";
		else if (term.endsWith("DeleteRestrictions")) out.delete = matchPropertyValueBool(inner, "Deletable") !== "false";
		else if (term.endsWith("BatchSupported") || term.endsWith("BatchSupport")) out.batch = boolValue !== "false";
		else if (term.endsWith("FilterRestrictions") || term.endsWith("FilterFunctions")) out.filter = boolValue !== "false";
		else if (term.endsWith("ExpandRestrictions")) out.expand = boolValue !== "false";
		else if (term.endsWith("SelectSupport")) out.select = boolValue !== "false";
		else if (term.endsWith("SearchRestrictions")) out.search = boolValue !== "false";
		else if (term.endsWith("CountRestrictions")) out.count = boolValue !== "false";
		else if (term.endsWith("ChangeTracking")) out.delta = boolValue !== "false";
		else if (term.endsWith("ApplySupported") || term.endsWith("ApplyRestrictions")) out.apply = boolValue !== "false";
	}
	return out;
}
function readAttr(attrs, name) {
	let cursor = 0;
	while (cursor < attrs.length) {
		while (cursor < attrs.length && xmlWhitespace(attrs.charCodeAt(cursor))) cursor += 1;
		if (cursor >= attrs.length || attrs.charCodeAt(cursor) === 47) return void 0;
		const nameStart = cursor;
		while (cursor < attrs.length) {
			const code = attrs.charCodeAt(cursor);
			if (xmlWhitespace(code) || code === 61 || code === 47 || code === 62) break;
			cursor += 1;
		}
		const attributeName = attrs.slice(nameStart, cursor);
		while (cursor < attrs.length && xmlWhitespace(attrs.charCodeAt(cursor))) cursor += 1;
		if (attrs.charCodeAt(cursor) !== 61) {
			cursor += 1;
			continue;
		}
		cursor += 1;
		while (cursor < attrs.length && xmlWhitespace(attrs.charCodeAt(cursor))) cursor += 1;
		const quote = attrs.charCodeAt(cursor);
		if (quote !== 34 && quote !== 39) {
			cursor += 1;
			continue;
		}
		const valueStart = ++cursor;
		while (cursor < attrs.length && attrs.charCodeAt(cursor) !== quote) cursor += 1;
		if (cursor >= attrs.length) return void 0;
		if (attributeName === name) return attrs.slice(valueStart, cursor);
		cursor += 1;
	}
}
function* xmlElements(xml, tagName) {
	const marker = `<${tagName}`;
	const closing = `</${tagName}>`;
	let cursor = 0;
	while (cursor < xml.length) {
		const start = findXmlTag(xml, marker, cursor);
		if (start === -1) return;
		const tagEnd = findXmlTagEnd(xml, start + marker.length);
		if (tagEnd === -1) return;
		const attributes = xml.slice(start + marker.length, tagEnd);
		if (xmlSelfClosing(attributes)) {
			yield {
				attributes,
				body: ""
			};
			cursor = tagEnd + 1;
			continue;
		}
		const closeStart = xml.indexOf(closing, tagEnd + 1);
		if (closeStart === -1) return;
		yield {
			attributes,
			body: xml.slice(tagEnd + 1, closeStart)
		};
		cursor = closeStart + closing.length;
	}
}
function* xmlStartTags(xml, tagName) {
	const marker = `<${tagName}`;
	let cursor = 0;
	while (cursor < xml.length) {
		const start = findXmlTag(xml, marker, cursor);
		if (start === -1) return;
		const tagEnd = findXmlTagEnd(xml, start + marker.length);
		if (tagEnd === -1) return;
		yield xml.slice(start + marker.length, tagEnd);
		cursor = tagEnd + 1;
	}
}
function firstXmlStartTagByLocalName(xml, localName) {
	let cursor = 0;
	while (cursor < xml.length) {
		const start = xml.indexOf("<", cursor);
		if (start === -1) return void 0;
		const nameStart = start + 1;
		const first = xml.charCodeAt(nameStart);
		if (first === 33 || first === 47 || first === 63) {
			cursor = nameStart + 1;
			continue;
		}
		let nameEnd = nameStart;
		while (nameEnd < xml.length) {
			const code = xml.charCodeAt(nameEnd);
			if (xmlWhitespace(code) || code === 47 || code === 62) break;
			nameEnd += 1;
		}
		const qualifiedName = xml.slice(nameStart, nameEnd);
		const colon = qualifiedName.lastIndexOf(":");
		if (qualifiedName.slice(colon + 1) === localName) {
			const tagEnd = findXmlTagEnd(xml, nameEnd);
			return tagEnd === -1 ? void 0 : xml.slice(nameEnd, tagEnd);
		}
		cursor = nameEnd > nameStart ? nameEnd : nameStart + 1;
	}
}
function findXmlTag(xml, marker, from) {
	let cursor = from;
	while (cursor < xml.length) {
		const start = xml.indexOf(marker, cursor);
		if (start === -1) return -1;
		const boundary = xml.charCodeAt(start + marker.length);
		if (xmlWhitespace(boundary) || boundary === 47 || boundary === 62) return start;
		cursor = start + marker.length;
	}
	return -1;
}
function findXmlTagEnd(xml, from) {
	let quote = 0;
	for (let cursor = from; cursor < xml.length; cursor += 1) {
		const code = xml.charCodeAt(cursor);
		if (quote !== 0) {
			if (code === quote) quote = 0;
		} else if (code === 34 || code === 39) quote = code;
		else if (code === 62) return cursor;
	}
	return -1;
}
function xmlSelfClosing(attributes) {
	let cursor = attributes.length - 1;
	while (cursor >= 0 && xmlWhitespace(attributes.charCodeAt(cursor))) cursor -= 1;
	return cursor >= 0 && attributes.charCodeAt(cursor) === 47;
}
function xmlWhitespace(code) {
	return code === 9 || code === 10 || code === 13 || code === 32;
}
function stripNamespace(name) {
	const idx = name.lastIndexOf(".");
	return idx === -1 ? name : name.slice(idx + 1);
}
function matchBool(inner) {
	const element = xmlElements(inner, "Bool").next();
	if (element.done) return void 0;
	return element.value.body === "true" || element.value.body === "false" ? element.value.body : void 0;
}
function matchPropertyValueBool(inner, property) {
	for (const attributes of xmlStartTags(inner, "PropertyValue")) {
		if (readAttr(attributes, "Property") !== property) continue;
		const value = readAttr(attributes, "Bool");
		if (value === "true" || value === "false") return value;
	}
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/ogc-endpoint-layout.js
/**
* OGC API endpoint-layout resolution.
*
* The SDK's headline claim is one typed contract against ANY standards
* server. For OGC API Features / Records that means the client must not
* assume a fixed path prefix: a Honua Server mounts the facade at
* `/ogc/features/...`, but pygeoapi, ldproxy, and GeoServer's OGC API each
* serve the landing page at their own root and advertise their collections
* and conformance URLs through the landing page's `links` array
* (OGC API - Common Requirement 5).
*
* This module produces an {@link OgcEndpointLayout} — the concrete set of
* resource paths a Features client addresses:
*
*  - {@link honuaFacadeFeaturesLayout} is the fixed facade layout and the
*    default. It performs no network round-trips, so existing callers see
*    zero behaviour change.
*  - {@link resolveOgcEndpointLayout} discovers the layout from the landing
*    page (`ogc-api` mode) or auto-detects the facade first and falls back
*    to discovery (`auto` mode).
*
* Per OGC API - Features Requirement 17 the items resource is always at
* `{collections}/{collectionId}/items`, so a single landing-page fetch is
* enough to derive every per-collection path from the discovered
* collections URL.
*
* @module
*/
var DEFAULT_FACADE_BASE = "/ogc/features";
function enc(id) {
	return encodeURIComponent(String(id));
}
function trimTrailingSlash(url) {
	let end = url.length;
	while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
	return url.slice(0, end);
}
/**
* The Honua Server facade layout (`/ogc/features/...`). No network access;
* this is the default fast path and preserves the pre-existing behaviour of
* every OGC Features caller that points at a Honua Server.
*/
function honuaFacadeFeaturesLayout(base = DEFAULT_FACADE_BASE) {
	const root = trimTrailingSlash(base) || DEFAULT_FACADE_BASE;
	return {
		mode: "honua-facade",
		landing: () => root,
		conformance: () => `${root}/conformance`,
		collections: () => `${root}/collections`,
		collection: (id) => `${root}/collections/${enc(id)}`,
		queryables: (id) => `${root}/collections/${enc(id)}/queryables`,
		items: (id) => `${root}/collections/${enc(id)}/items`,
		item: (id, featureId) => `${root}/collections/${enc(id)}/items/${enc(featureId)}`
	};
}
/**
* A raw OGC API layout built from a discovered (or configured) landing +
* collections + conformance URL triple. Per-collection paths are templated
* off the collections URL per OGC API - Features Requirement 17.
*/
function ogcApiFeaturesLayout(options) {
	const landing = trimTrailingSlash(options.landingUrl);
	const collections = trimTrailingSlash(options.collectionsUrl);
	const conformance = trimTrailingSlash(options.conformanceUrl);
	return {
		mode: "ogc-api",
		landing: () => landing,
		conformance: () => conformance,
		collections: () => collections,
		collection: (id) => `${collections}/${enc(id)}`,
		queryables: (id) => `${collections}/${enc(id)}/queryables`,
		items: (id) => `${collections}/${enc(id)}/items`,
		item: (id, featureId) => `${collections}/${enc(id)}/items/${enc(featureId)}`
	};
}
/**
* Resolve a link href to an absolute URL against a base. Absolute hrefs are
* returned unchanged; relative hrefs resolve against `${baseUrl}/`.
*/
function absolutize(href, baseUrl) {
	if (/^https?:\/\//i.test(href)) return href;
	const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	try {
		return new URL(href, root).toString();
	} catch {
		return href;
	}
}
/**
* Find the first link whose `rel` matches one of `rels` (exact or as the
* final path segment of a full OGC relation URI, e.g.
* `http://www.opengis.net/def/rel/ogc/1.0/data`).
*/
function findOgcLink(links, ...rels) {
	if (!links) return void 0;
	const wanted = new Set(rels.map((r) => r.toLowerCase()));
	for (const link of links) {
		if (typeof link.href !== "string" || link.href.length === 0) continue;
		const rel = (link.rel ?? "").toLowerCase();
		if (wanted.has(rel)) return link.href;
		const tail = rel.slice(rel.lastIndexOf("/") + 1);
		if (tail && wanted.has(tail)) return link.href;
	}
}
/**
* Discover an OGC API layout from the landing page. The client `baseUrl`
* IS the landing page root; the collections and conformance URLs are read
* from the landing `links` (falling back to the mandated relative
* `collections` / `conformance` sub-paths when a server omits them).
*/
async function discoverOgcApiLayout(transport) {
	const landing = await transport.requestCachedMetadataJson("ogc-features:layout:landing", "?f=json", {});
	const baseUrl = trimTrailingSlash(transport.baseUrl);
	const links = landing?.links;
	const dataHref = findOgcLink(links, "data");
	const conformanceHref = findOgcLink(links, "conformance");
	return ogcApiFeaturesLayout({
		landingUrl: baseUrl,
		collectionsUrl: dataHref ? absolutize(dataHref, baseUrl) : `${baseUrl}/collections`,
		conformanceUrl: conformanceHref ? absolutize(conformanceHref, baseUrl) : `${baseUrl}/conformance`
	});
}
/**
* Probe whether the Honua facade landing (`/ogc/features`) exists. Used by
* `auto` mode: a valid OGC landing document there confirms the facade
* fast path; anything else falls through to landing-page discovery.
*/
async function facadeLandingLooksValid(transport) {
	try {
		const landing = await transport.requestCachedMetadataJson("ogc-features:layout:facade-probe", `${DEFAULT_FACADE_BASE}?f=json`, {});
		return Array.isArray(landing?.links);
	} catch {
		return false;
	}
}
/**
* Resolve the endpoint layout for the requested `mode`:
*
*  - `honua-facade` (default) — the fixed facade layout, no round-trips.
*  - `ogc-api` — discover from the landing page at the client baseUrl.
*  - `auto` — probe the facade landing; use it when valid, otherwise
*    discover from the root.
*
* Discovery failures surface as {@link HonuaCapabilityNotSupportedError}
* (per the SDK convention of throwing rather than returning empty data).
*/
async function resolveOgcEndpointLayout(transport, mode = "honua-facade") {
	if (mode === "honua-facade") return honuaFacadeFeaturesLayout();
	if (mode === "auto") {
		if (await facadeLandingLooksValid(transport)) return honuaFacadeFeaturesLayout();
	}
	try {
		return await discoverOgcApiLayout(transport);
	} catch (err) {
		if (err instanceof HonuaCapabilityNotSupportedError) throw err;
		throw new HonuaCapabilityNotSupportedError("query", "ogc-features", `ogc-api layout discovery failed for ${transport.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wire-shared.js
/**
* Helpers shared across the per-protocol wire modules and the client's
* transport core: header merging and the common OGC metadata query-param
* builder plus CSV normalizers. Kept transport-agnostic so both
* `HonuaClient` and the protocol modules can import them without a cycle.
*
* @module
*/
/**
* Merge any number of `HeadersInit` values into a plain `Record<string,string>`,
* with later entries overriding earlier ones. Accepts `Headers`, tuple arrays,
* and plain objects; `undefined`/`null` object values are skipped.
*/
function mergeHeaders(...headersList) {
	const merged = {};
	for (const headers of headersList) {
		if (!headers) continue;
		if (headers instanceof Headers) {
			for (const [key, value] of headers.entries()) merged[key] = value;
			continue;
		}
		if (Array.isArray(headers)) {
			for (const [key, value] of headers) merged[key] = value;
			continue;
		}
		for (const [key, value] of Object.entries(headers)) {
			if (value === void 0 || value === null) continue;
			merged[key] = String(value);
		}
	}
	return merged;
}
/** Build the shared OGC metadata query params (`f` + caller `extraParams`). */
function createOgcMetadataParams(request) {
	const params = new URLSearchParams();
	params.set("f", request.responseFormat ?? "json");
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	return params;
}
/** Normalize a string-or-(string|number)-array value to a CSV string. */
function normalizeCsv(value) {
	if (typeof value === "string") return value;
	return Array.from(value).join(",");
}
/** Normalize a string-or-string-array value to a CSV string. */
function normalizeStringCsv(value) {
	return typeof value === "string" ? value : value.join(",");
}
/**
* True when a GeoServices/FeatureServer response advertises more pages via
* `exceededTransferLimit`. GeoServices servers clamp `resultRecordCount` to
* their `maxRecordCount` and set this flag when more rows remain, so
* offset-paginated fetch-all loops must keep paging while it is set — advancing
* by the actual returned row count, never a fixed `page * pageSize` stride that
* would skip the rows the server capped off — rather than stopping on the first
* page that comes back shorter than the requested `pageSize`.
*/
function responseExceededTransferLimit(response) {
	return typeof response === "object" && response !== null && response.exceededTransferLimit === true;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/ogc-features.js
/**
* OGC API Features wire methods. Concrete URL-building, param
* serialization, and request shaping for the OGC API Features endpoints,
* invoked against an injected {@link HonuaProtocolTransport}. The typed
* `HonuaOgcFeatures` surface (in `surfaces.ts`) and the `HonuaClient`
* facade both delegate here.
*
* @module
*/
/**
* The endpoint layout to build paths against. Defaults to the Honua facade
* fast path (`/ogc/features/...`); backend-agnostic callers thread a
* spec-discovered layout onto `request.layout`.
*/
function layoutOf(request) {
	return request.layout ?? honuaFacadeFeaturesLayout();
}
/**
* A layout key fragment for cache keys so the facade and a discovered raw
* layout never collide in the metadata cache.
*/
function layoutKey(layout) {
	return layout.mode === "honua-facade" ? "facade" : layout.collections();
}
async function getOgcFeaturesLanding(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const layout = layoutOf(request);
	return transport.requestCachedMetadataJson(`ogc-features:landing:${layoutKey(layout)}:${params.toString()}`, `${layout.landing()}?${params.toString()}`, request);
}
async function getOgcFeaturesConformance(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const layout = layoutOf(request);
	return transport.requestCachedMetadataJson(`ogc-features:conformance:${layoutKey(layout)}:${params.toString()}`, `${layout.conformance()}?${params.toString()}`, request);
}
async function listOgcCollections(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const layout = layoutOf(request);
	return transport.requestCachedMetadataJson(`ogc-features:collections:${layoutKey(layout)}:${params.toString()}`, `${layout.collections()}?${params.toString()}`, request);
}
async function getOgcCollection(transport, request) {
	const params = createOgcMetadataParams(request);
	const layout = layoutOf(request);
	return transport.requestCachedMetadataJson(`ogc-features:collection:${layoutKey(layout)}:${request.collectionId}:${params.toString()}`, `${layout.collection(request.collectionId)}?${params.toString()}`, request);
}
async function getOgcQueryables(transport, request) {
	const params = createOgcMetadataParams(request);
	const layout = layoutOf(request);
	return transport.requestCachedMetadataJson(`ogc-features:queryables:${layoutKey(layout)}:${request.collectionId}:${params.toString()}`, `${layout.queryables(request.collectionId)}?${params.toString()}`, request);
}
async function listOgcItems(transport, request) {
	const params = createOgcMetadataParams(request);
	if (request.limit !== void 0) params.set("limit", String(request.limit));
	if (request.offset !== void 0) params.set("offset", String(request.offset));
	if (request.bbox !== void 0) params.set("bbox", request.bbox);
	if (request.datetime !== void 0) params.set("datetime", request.datetime);
	if (request.filter !== void 0) params.set("filter", request.filter);
	if (request.filterLang !== void 0) params.set("filter-lang", request.filterLang);
	if (request.ids !== void 0) params.set("ids", normalizeCsv(request.ids));
	if (request.properties !== void 0) params.set("properties", normalizeCsv(request.properties));
	if (request.sortby !== void 0) params.set("sortby", request.sortby);
	if (request.crs !== void 0) params.set("crs", request.crs);
	const path = layoutOf(request).items(request.collectionId);
	return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
}
async function getOgcItem(transport, request) {
	const params = createOgcMetadataParams(request);
	if (request.crs !== void 0) params.set("crs", request.crs);
	const path = layoutOf(request).item(request.collectionId, request.featureId);
	return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
}
async function createOgcItem(transport, request) {
	const params = createOgcMetadataParams(request);
	const path = layoutOf(request).items(request.collectionId);
	return transport.requestJson("POST", `${path}?${params.toString()}`, {
		headers: mergeHeaders({ "Content-Type": "application/geo+json" }, request.headers),
		body: JSON.stringify(request.feature)
	}, request.signal);
}
async function replaceOgcItem(transport, request) {
	const params = createOgcMetadataParams(request);
	if (request.crs !== void 0) params.set("crs", request.crs);
	const path = layoutOf(request).item(request.collectionId, request.featureId);
	return transport.requestJson("PUT", `${path}?${params.toString()}`, {
		headers: mergeHeaders({ "Content-Type": "application/geo+json" }, request.headers),
		body: JSON.stringify(request.feature)
	}, request.signal);
}
async function patchOgcItem(transport, request) {
	const params = createOgcMetadataParams(request);
	if (request.crs !== void 0) params.set("crs", request.crs);
	const path = layoutOf(request).item(request.collectionId, request.featureId);
	return transport.requestJson("PATCH", `${path}?${params.toString()}`, {
		headers: mergeHeaders({ "Content-Type": "application/merge-patch+json" }, request.headers),
		body: JSON.stringify(request.patch)
	}, request.signal);
}
async function deleteOgcItem(transport, request) {
	const params = createOgcMetadataParams(request);
	if (request.crs !== void 0) params.set("crs", request.crs);
	const path = layoutOf(request).item(request.collectionId, request.featureId);
	await transport.requestJson("DELETE", `${path}?${params.toString()}`, void 0, request.signal);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/ogc-maps.js
/**
* OGC API Maps surface. Server-rendered map images at the dataset or
* collection level, with optional styled-output access. The runtime
* deliberately exposes a thin envelope (`width`, `height`, `bbox`,
* `crs`, `format`, optional `filter` / `collections`) — extension
* parameters live on `extraParams`.
*
* @module
*/
/** Honua facade path prefix for OGC API Maps. */
var MAPS_FACADE_BASE = "/ogc/maps";
/**
* Resolve the OGC API Maps path prefix: the caller-supplied raw `basePath` (a
* `connect()`-discovered third-party service root) or the Honua facade default.
* Trailing slashes are trimmed so a discovered root and the facade compose the
* same sub-paths. Mirrors the OGC API Records seam in `ogc-records.ts`.
*/
function mapsBase(request) {
	if (request.basePath === void 0) return MAPS_FACADE_BASE;
	const base = request.basePath;
	let end = base.length;
	while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
	return base.slice(0, end);
}
/** Cache-key discriminator so a discovered root never collides with the facade. */
function mapsBaseKey(request) {
	const base = mapsBase(request);
	return base === MAPS_FACADE_BASE ? "" : `${base}:`;
}
/** Top-level OGC API Maps handle. */
var HonuaOgcMaps = class {
	client;
	basePath;
	constructor(options) {
		this.client = options.client;
		this.basePath = options.basePath;
	}
	withBase(request) {
		return this.basePath !== void 0 ? {
			...request,
			basePath: this.basePath
		} : request;
	}
	collection(collectionId, styleId) {
		return new HonuaOgcCollectionMap({
			client: this.client,
			collectionId,
			styleId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
	async landing(request = {}) {
		return this.client.getOgcMapsLanding(this.withBase(request));
	}
	async conformance(request = {}) {
		return this.client.getOgcMapsConformance(this.withBase(request));
	}
	/** Render a dataset-level map (across one or more collections). */
	async map(request = {}) {
		return this.client.getOgcMapImage(this.withBase(request));
	}
};
/**
* Bound handle for a collection-level (and optionally styled) map. Drops
* the routing-discriminator fields from per-call requests.
*/
var HonuaOgcCollectionMap = class {
	client;
	collectionId;
	styleId;
	basePath;
	constructor(options) {
		this.client = options.client;
		this.collectionId = options.collectionId;
		this.styleId = options.styleId;
		this.basePath = options.basePath;
	}
	async map(request = {}) {
		return this.client.getOgcMapImage({
			...request,
			collectionId: this.collectionId,
			styleId: request.styleId ?? this.styleId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
};
async function getOgcMapsLanding(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = mapsBase(request);
	return transport.requestCachedMetadataJson(`ogc-maps:landing:${mapsBaseKey(request)}${params.toString()}`, `${base}?${params.toString()}`, request);
}
async function getOgcMapsConformance(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = mapsBase(request);
	return transport.requestCachedMetadataJson(`ogc-maps:conformance:${mapsBaseKey(request)}${params.toString()}`, `${base}/conformance?${params.toString()}`, request);
}
async function getOgcMapImage(transport, request) {
	const params = serializeOgcMapImageParams(request);
	const collectionPart = request.collectionId !== void 0 ? `/collections/${encodeURIComponent(String(request.collectionId))}` : "";
	const stylePart = request.styleId ? `/styles/${encodeURIComponent(request.styleId)}` : "";
	const path = `${mapsBase(request)}${collectionPart}${stylePart}/map${params.size > 0 ? `?${params.toString()}` : ""}`;
	const accept = ogcMapAcceptHeader(request.format) ?? "image/png";
	const response = await transport.requestBytes("GET", path, accept, void 0, request.signal);
	return {
		bytes: response.bytes,
		contentType: response.contentType
	};
}
function serializeOgcMapImageParams(request) {
	const params = new URLSearchParams();
	const f = ogcMapShortFormat(request.format);
	if (f !== void 0) params.set("f", f);
	if (request.width !== void 0) params.set("width", String(request.width));
	if (request.height !== void 0) params.set("height", String(request.height));
	if (request.bbox !== void 0) params.set("bbox", typeof request.bbox === "string" ? request.bbox : request.bbox.join(","));
	if (request.bboxCrs !== void 0) params.set("bbox-crs", request.bboxCrs);
	if (request.crs !== void 0) params.set("crs", request.crs);
	if (request.collections !== void 0 && request.collections.length > 0) params.set("collections", request.collections.join(","));
	if (request.transparent !== void 0) params.set("transparent", String(request.transparent));
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	return params;
}
var OGC_MAP_FORMAT_TO_SHORT = new Map([
	["image/png", "png"],
	["image/jpeg", "jpeg"],
	["image/jpg", "jpg"],
	["image/tiff", "tiff"],
	["image/tif", "tif"]
]);
var OGC_MAP_SHORT_TO_MEDIA = new Map([
	["png", "image/png"],
	["jpeg", "image/jpeg"],
	["jpg", "image/jpeg"],
	["tiff", "image/tiff"],
	["tif", "image/tiff"]
]);
function ogcMapShortFormat(format) {
	if (format === void 0) return void 0;
	const lower = format.toLowerCase();
	return OGC_MAP_FORMAT_TO_SHORT.get(lower) ?? lower;
}
function ogcMapAcceptHeader(format) {
	if (format === void 0) return void 0;
	const lower = format.toLowerCase();
	return OGC_MAP_SHORT_TO_MEDIA.get(lower) ?? format;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/contract/jobs.js
/**
* Canonical async-operation surface. `IJobRun` is the protocol-neutral
* vocabulary every long-running operation in the SDK speaks. It is the
* receipt returned from operations that complete asynchronously on the
* server (OGC API Processes execution, future GeoServices async export
* tickets, OData function imports, etc.).
*
* Per the ticket constraint, OGC Processes specifically must surface
* through this shared interface — there is no `OgcJobRun` top-level
* type. The implementation in `src/core/ogc-processes.ts` returns
* `IJobRun<T>` directly.
*
* @module
*/
/**
* `true` when the snapshot status is one of the terminal values
* (`successful`, `failed`, `dismissed`). Useful for stop conditions in
* watchers and tests.
*/
function isJobTerminal(status) {
	return status === "successful" || status === "failed" || status === "dismissed";
}
/**
* Thrown by {@link IJobRun.results} when the poll loop is cancelled or exhausted
* before the job reached a terminal state — i.e. the {@link JobResultsOptions}
* signal aborted, the deadline elapsed, or the attempt cap was hit. `reason`
* distinguishes the three so callers can branch (e.g. retry vs surface).
*/
var HonuaJobPollTimeoutError = class extends Error {
	reason;
	jobId;
	lastStatus;
	constructor(message, reason, jobId, lastStatus) {
		super(message);
		this.name = "HonuaJobPollTimeoutError";
		this.reason = reason;
		this.jobId = jobId;
		this.lastStatus = lastStatus;
	}
};
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/job-run-errors.js
/** Error thrown when `IJobRun.results()` observes a non-success terminal. */
var HonuaJobFailedError = class extends HonuaSdkError {
	status;
	errorCode;
	details;
	constructor(message, status, errorCode, details) {
		super("core.job-failed", message, { context: {
			status,
			errorCode
		} });
		this.name = "HonuaJobFailedError";
		this.status = status;
		this.errorCode = errorCode;
		this.details = details;
	}
};
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/job-run-lifecycle.js
var DEFAULT_JOB_DEADLINE_MS = 6e5;
/** Internal protocol-neutral state machine shared by every remote IJobRun. */
var JobRunLifecycle = class {
	options;
	currentStatus;
	currentProgress;
	terminalSnapshot;
	terminalPromise;
	cancelPromise;
	listeners = /* @__PURE__ */ new Set();
	constructor(options) {
		this.options = options;
		this.currentStatus = options.initialStatus;
		this.currentProgress = options.initialProgress;
	}
	get status() {
		return this.currentStatus;
	}
	get progress() {
		return this.currentProgress;
	}
	get terminal() {
		return this.terminalSnapshot;
	}
	watch(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async poll() {
		if (this.terminalSnapshot) return this.terminalSnapshot;
		return this.observe(await this.options.poll());
	}
	observe(snapshot) {
		this.currentStatus = snapshot.status;
		this.currentProgress = snapshot.progress;
		if (isJobTerminal(snapshot.status)) this.terminalSnapshot = snapshot;
		for (const listener of this.listeners) try {
			listener(snapshot);
		} catch {}
		return snapshot;
	}
	async cancel(cancel) {
		if (this.terminalSnapshot) return this.currentStatus;
		if (!this.cancelPromise) this.cancelPromise = cancel().then((snapshot) => {
			if (this.terminalSnapshot) return this.currentStatus;
			const status = this.observe(snapshot).status;
			if (!isJobTerminal(status)) this.cancelPromise = void 0;
			return status;
		}).catch((error) => {
			this.cancelPromise = void 0;
			throw error;
		});
		return this.cancelPromise;
	}
	results(overrides = {}) {
		if (!this.terminalPromise) {
			const options = this.resolveBudget(overrides);
			this.terminalPromise = this.runUntilTerminal(options).catch((error) => {
				this.terminalPromise = void 0;
				throw error;
			});
		}
		return this.terminalPromise;
	}
	resolveBudget(overrides) {
		const merged = {
			...this.options.pollBudget,
			...overrides
		};
		return merged.deadlineMs !== void 0 || merged.maxAttempts !== void 0 ? merged : {
			...merged,
			deadlineMs: DEFAULT_JOB_DEADLINE_MS
		};
	}
	async runUntilTerminal(options) {
		const configuredInterval = typeof this.options.pollIntervalMs === "function" ? this.options.pollIntervalMs() : this.options.pollIntervalMs;
		const baseIntervalMs = options.pollIntervalMs ?? configuredInterval;
		const maxIntervalMs = options.maxPollIntervalMs ?? Math.max(baseIntervalMs, 3e4);
		const startedAt = Date.now();
		let attempts = 0;
		while (!this.terminalSnapshot) {
			this.assertWithinBudget(options, attempts, startedAt);
			let snapshot;
			try {
				snapshot = await this.pollWithinBudget(options, startedAt);
			} catch (error) {
				if (options.signal?.aborted) this.throwTimeout("aborted", options);
				throw error;
			}
			attempts += 1;
			this.observe(snapshot);
			if (this.terminalSnapshot) break;
			this.assertWithinBudget(options, attempts, startedAt);
			const intervalMs = Math.min(maxIntervalMs, baseIntervalMs * 2 ** (attempts - 1));
			if (intervalMs > 0) await abortableDelay(intervalMs, options.signal);
		}
		const terminal = this.terminalSnapshot;
		if (terminal.status === "successful" && terminal.result) return terminal.result;
		const error = terminal.error;
		throw new HonuaJobFailedError(error?.message ?? `Job ended in non-success terminal state: ${terminal.status}`, terminal.status, error?.code, error?.details);
	}
	async pollWithinBudget(options, startedAt) {
		if (options.signal === void 0 && options.deadlineMs === void 0) return this.options.poll();
		const controller = new AbortController();
		let timer;
		let rejectBoundary;
		const boundary = new Promise((_resolve, reject) => {
			rejectBoundary = reject;
		});
		const reachBoundary = (reason) => {
			controller.abort();
			rejectBoundary(new PollBoundaryReached(reason));
		};
		const onAbort = () => reachBoundary("aborted");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.deadlineMs !== void 0) {
			const remainingMs = Math.max(0, options.deadlineMs - (Date.now() - startedAt));
			timer = setTimeout(() => reachBoundary("deadline"), remainingMs);
		}
		try {
			return await Promise.race([this.options.poll(controller.signal), boundary]);
		} catch (error) {
			if (error instanceof PollBoundaryReached) this.throwTimeout(error.reason, options);
			throw error;
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}
	assertWithinBudget(options, attempts, startedAt) {
		if (options.signal?.aborted) this.throwTimeout("aborted", options);
		if (options.maxAttempts !== void 0 && attempts >= options.maxAttempts) this.throwTimeout("max-attempts", options);
		if (options.deadlineMs !== void 0 && Date.now() - startedAt >= options.deadlineMs) this.throwTimeout("deadline", options);
	}
	throwTimeout(reason, options) {
		const suffix = reason === "aborted" ? "poll aborted" : reason === "deadline" ? `did not reach a terminal state within ${options.deadlineMs}ms` : `did not reach a terminal state within ${options.maxAttempts} poll attempt(s)`;
		throw new HonuaJobPollTimeoutError(`Job ${this.options.id} ${suffix}`, reason, this.options.id, this.currentStatus);
	}
};
var PollBoundaryReached = class extends Error {
	reason;
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
};
function abortableDelay(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/ogc-processes.js
/**
* OGC API Processes surface. Process discovery, execution, and async
* job tracking against any conformant Part 1 (Core) server — a raw
* third-party deployment discovered by `discoverOgcProcesses()` just as much
* as the Honua facade. Per the ticket constraint, executions return an
* `IJobRun` (the canonical async-operation surface) rather than an
* OGC-specific job type; a synchronous execution returns an already-terminal
* `IJobRun` so callers read results through one surface either way.
*
* Three properties keep the standalone lane honest:
*
* 1. **Nothing is assumed about the layout.** Routes template off the
*    discovered service root, and the job lifecycle prefers the server's own
*    `Location` header and `links[]` over the Core path template.
* 2. **Capability gaps fail closed.** When the server's conformance
*    declaration (or the process's `jobControlOptions`) is known and does not
*    declare what the caller asked for, the call throws
*    `HonuaCapabilityNotSupportedError` naming the missing construct rather
*    than posting and hoping.
* 3. **Polling is bounded.** `results()` always runs under a budget — the
*    caller's, the handle's, or a default deadline — and honors an
*    `AbortSignal`.
*
* @module
*/
var DEFAULT_POLL_INTERVAL_MS = 1e3;
/**
* Wall-clock ceiling applied to `results()` when neither the caller nor the
* handle set `deadlineMs` / `maxAttempts`. NFR-001: a status endpoint that
* never reaches a terminal state must not poll forever. Callers who genuinely
* want a longer wait pass their own `deadlineMs`.
*/
/** Honua facade path prefix for OGC API Processes. */
var PROCESSES_FACADE_BASE = "/ogc/processes";
/**
* OGC API — Processes Part 1 (1.0) conformance classes the SDK gates on, and
* the Core link relations the job lifecycle follows. These stay module-private
* per the `ogc-conformance` rule that conformance URIs are never top-level SDK
* types; they surface only as diagnostic strings inside capability errors, so a
* refusal can name the exact construct the server did not declare.
*/
var PROCESSES_CONFORMANCE = {
	core: "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
	dismiss: "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/dismiss"
};
/**
* Suffix matchers tolerant of a server publishing the class under a different
* host or path prefix, but *not* of a different class that merely starts with
* one of these. See {@link declaresConformanceClass}.
*/
var PROCESSES_CONFORMANCE_MATCH = {
	core: "processes-1/1.0/conf/core",
	dismiss: "processes-1/1.0/conf/dismiss"
};
var PROCESSES_LINK_REL = {
	results: "http://www.opengis.net/def/rel/ogc/1.0/results",
	status: "self"
};
/** Job-control options a process declares in its description (Core §7.9). */
var JOB_CONTROL = {
	sync: "sync-execute",
	async: "async-execute",
	dismiss: "dismiss"
};
/**
* Fail-closed refusal naming the construct the server did not declare. The
* conformance-class URI / link relation rides in the error context so telemetry
* keeps it after redaction.
*
* The context key for a class URI is `missingClass`, not `conformanceClass`:
* the error-envelope redactor drops any key matching `form` (for form bodies),
* which "con**form**anceClass" hits — the value would ship as `[REDACTED]` and
* the refusal would name nothing.
*/
function capabilityRefusal(capability, sourceId, context) {
	return new HonuaCapabilityNotSupportedError(capability, "ogc-processes", sourceId, { context });
}
/**
* `true` when the server declares exactly the named conformance class.
*
* The public `hasOgcConformanceClass()` is a documented *substring* test, which
* is the right tool for a caller probing an extension they already recognise.
* It is the wrong tool for a fail-closed gate: an unrecognised class that
* happens to extend one of ours — `…/conf/dismiss-disabled`, `…/conf/core-lite`,
* or a vendor class carrying the URI in a query string — would widen what the
* client is willing to send. So the gate anchors the match at the end of the
* class URI (ignoring a trailing slash, query, or fragment): a prefix the
* server chose is still tolerated, an unknown longer class is not.
*/
function declaresConformanceClass(conformance, classSuffix) {
	for (const uri of conformance?.conformsTo ?? []) {
		if (typeof uri !== "string") continue;
		let path = (uri.split("#")[0] ?? "").split("?")[0] ?? "";
		let end = path.length;
		while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
		path = path.slice(0, end);
		if (path.endsWith(classSuffix)) return true;
	}
	return false;
}
/** `true` when the declaration list contains `option` (case-insensitive). */
function declares(options, option) {
	if (!options) return false;
	for (const entry of options) if (typeof entry === "string" && entry.toLowerCase() === option) return true;
	return false;
}
/**
* Resolve the OGC API Processes path prefix: the caller-supplied raw `basePath`
* (a `discoverOgcProcesses()`-discovered third-party service root) or the Honua
* facade default. Trailing slashes are trimmed so a discovered root and the
* facade compose the same sub-paths. Mirrors the OGC API Records seam.
*/
function processesBase(request) {
	if (request.basePath === void 0) return PROCESSES_FACADE_BASE;
	const base = request.basePath;
	let end = base.length;
	while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
	return base.slice(0, end);
}
/**
* Cache-key discriminator so a discovered root never collides with the facade.
*
* The base path is percent-encoded because cache keys join their components
* with `:` and a service root may legally contain one. Without encoding,
* `{ basePath: "/a", processId: "b:c" }` and `{ basePath: "/a:b", processId: "c" }`
* would produce the same key for two different request URLs, so a cached
* `describe()` could answer with the wrong process's metadata.
*/
function processesBaseKey(request) {
	const base = processesBase(request);
	return base === PROCESSES_FACADE_BASE ? "" : `${encodeURIComponent(base)}:`;
}
function isAbsoluteHttpUrl$1(value) {
	return /^https?:\/\//i.test(value);
}
/**
* Absolute URL of a request the SDK issues against `baseUrl`. Link hrefs in the
* response are relative to the document that carried them, so this is the base
* a `links[]` entry resolves against.
*/
function requestUrlFor(baseUrl, path) {
	if (!isAbsoluteHttpUrl$1(baseUrl)) return void 0;
	try {
		return new URL(`${baseUrl}${path}`).toString();
	} catch {
		return;
	}
}
/**
* Reduce a server-advertised href to a same-origin request path.
*
* The SDK attaches credentials by header, so a link that leaves the configured
* origin is dropped rather than followed — the caller falls back to the Core
* route template (or, under `"strict"`, gets a fail-closed refusal). Relative
* hrefs resolve against the document that carried them.
*/
function advertisedRoutePath(href, documentUrl, baseUrl) {
	if (typeof href !== "string" || href.length === 0) return void 0;
	if (!isAbsoluteHttpUrl$1(baseUrl)) return void 0;
	let resolved;
	try {
		resolved = new URL(href, documentUrl ?? `${baseUrl}/`);
	} catch {
		return;
	}
	let origin;
	try {
		origin = new URL(baseUrl).origin;
	} catch {
		return;
	}
	if (resolved.origin !== origin) return void 0;
	return `${resolved.pathname}${resolved.search}`;
}
/** Core-mandated job route (§7.12) under a service root. */
function templatedJobPath(basePath, jobId) {
	return `${processesBase({ ...basePath !== void 0 ? { basePath } : {} })}/jobs/${encodeURIComponent(jobId)}`;
}
/**
* Append metadata params to a route that may already carry a query string —
* an advertised job link often does. The server's own query is preserved
* verbatim (never re-encoded) and a param it already declares is never
* duplicated, so following a link cannot corrupt the URL the server published.
*/
function withParams(path, params) {
	const queryIndex = path.indexOf("?");
	if (queryIndex < 0) {
		const query = params.toString();
		return query.length === 0 ? path : `${path}?${query}`;
	}
	const existing = new URLSearchParams(path.slice(queryIndex + 1));
	const additions = new URLSearchParams();
	for (const [key, value] of params) if (!existing.has(key)) additions.append(key, value);
	const query = additions.toString();
	return query.length === 0 ? path : `${path}&${query}`;
}
/**
* First same-origin path advertised under one of `rels`, if any. A relation
* matches on the full URI or on its last path segment, the same tolerance
* `findOgcLink` applies — servers publish both
* `http://www.opengis.net/def/rel/ogc/1.0/results` and a bare `results`.
*/
function linkPath(links, documentUrl, baseUrl, ...rels) {
	if (!links) return void 0;
	const wanted = /* @__PURE__ */ new Set();
	for (const rel of rels) {
		const lower = rel.toLowerCase();
		wanted.add(lower);
		wanted.add(lower.slice(lower.lastIndexOf("/") + 1));
	}
	for (const link of links) {
		const rel = (link.rel ?? "").toLowerCase();
		const tail = rel.slice(rel.lastIndexOf("/") + 1);
		if (!wanted.has(rel) && !(tail && wanted.has(tail))) continue;
		const path = advertisedRoutePath(link.href, documentUrl, baseUrl);
		if (path) return path;
	}
}
/** Top-level OGC API Processes handle. */
var HonuaOgcProcesses = class {
	client;
	basePath;
	capabilityPolicy;
	pollBudget;
	declaredConformance;
	conformancePromise;
	/**
	* `jobControlOptions` learned from `describe()` / `list()` calls made through
	* this handle. Callers that follow the natural discover → describe → execute
	* flow therefore get process-level gating for free, with no extra round trip.
	*
	* Each entry remembers which source taught it, because a later listing must
	* not be able to downgrade what a description already established.
	*/
	jobControlByProcess = /* @__PURE__ */ new Map();
	constructor(options) {
		this.client = options.client;
		this.basePath = options.basePath;
		this.capabilityPolicy = options.capabilityPolicy ?? "advertised";
		this.pollBudget = options.pollBudget;
		this.declaredConformance = options.conformance;
	}
	withBase(request) {
		return this.basePath !== void 0 ? {
			...request,
			basePath: this.basePath
		} : request;
	}
	async landing(request = {}) {
		return this.client.getOgcProcessesLanding(this.withBase(request));
	}
	async conformance(request = {}) {
		const response = await this.client.getOgcProcessesConformance(this.withBase(request));
		if (Array.isArray(response?.conformsTo)) this.declaredConformance = response;
		return response;
	}
	async list(request = {}) {
		const response = await this.client.listOgcProcesses(this.withBase(request));
		for (const process of response?.processes ?? []) if (process?.id) this.rememberJobControl(process.id, process.jobControlOptions, "summary");
		return response;
	}
	async describe(processId, request = {}) {
		const description = await this.client.getOgcProcess(this.withBase({
			...request,
			processId
		}));
		this.rememberJobControl(processId, description?.jobControlOptions, "description");
		return description;
	}
	/**
	* Record what a process advertises, keeping the more authoritative source.
	*
	* Silence is still not consent — an omitted `jobControlOptions` is stored as
	* an empty declaration, and an explicit mode against it is refused. But a
	* process summary may legally omit what the full description declares, so a
	* `list()` refresh after a `describe()` must not overwrite the description's
	* answer with the listing's silence. Refusing an execution the server did
	* declare is as wrong as permitting one it did not.
	*/
	rememberJobControl(processId, options, source) {
		if (source === "summary" && this.jobControlByProcess.get(processId)?.source === "description") return;
		this.jobControlByProcess.set(processId, {
			options: [...options ?? []],
			source
		});
	}
	/**
	* Submit a process for execution and return an `IJobRun` — always, so the
	* caller reads results through one surface whichever Core response shape the
	* server chose:
	*
	* - asynchronous (`Prefer: respond-async`, or the server's own default) →
	*   a pollable run bound to the advertised job routes.
	* - synchronous (`200` with the results document) → an already-terminal run
	*   whose `results()` resolves immediately with zero further requests.
	*
	* Before anything is posted, `mode` is gated against what the server has
	* declared: the Core conformance class when a conformance declaration is in
	* hand, and the process's `jobControlOptions` when the description is (from
	* `request.jobControlOptions`, an earlier `describe()`/`list()` on this
	* handle, or — under `capabilityPolicy: "strict"` — a cached `describe()`
	* performed here). An undeclared mode fails closed with
	* `HonuaCapabilityNotSupportedError`.
	*/
	async execute(request) {
		const executeRequest = this.withBase(request);
		const conformance = await this.assertExecutionDeclared(request);
		const accepted = await this.client.executeOgcProcess(executeRequest);
		const processId = accepted.processID ?? request.processId;
		const jobControlOptions = request.jobControlOptions ?? this.jobControlByProcess.get(request.processId)?.options;
		if (accepted.synchronous === true) return new HonuaOgcProcessSyncRun(processId, accepted.results ?? {});
		return new HonuaOgcProcessJobRun({
			client: this.client,
			jobId: accepted.jobID,
			processId,
			initialStatus: accepted.statusInfo ?? {
				jobID: accepted.jobID,
				processID: processId,
				status: accepted.status
			},
			...executeRequest.basePath !== void 0 ? { basePath: executeRequest.basePath } : {},
			...accepted.statusPath !== void 0 ? { statusPath: accepted.statusPath } : {},
			...this.pollBudget !== void 0 ? { pollBudget: this.pollBudget } : {},
			...conformance !== void 0 ? { conformance } : {},
			...jobControlOptions !== void 0 ? { jobControlOptions } : {},
			capabilityPolicy: this.capabilityPolicy
		});
	}
	/** Adopt an existing job by id (useful when reconnecting after navigation). */
	job(jobId, options = {}) {
		const { basePath } = this.withBase(options);
		const jobControlOptions = options.processId ? this.jobControlByProcess.get(options.processId)?.options : void 0;
		return new HonuaOgcProcessJobRun({
			client: this.client,
			jobId,
			processId: options.processId,
			...basePath !== void 0 ? { basePath } : {},
			...options.statusPath !== void 0 ? { statusPath: options.statusPath } : {},
			...options.resultsPath !== void 0 ? { resultsPath: options.resultsPath } : {},
			...this.pollBudget !== void 0 ? { pollBudget: this.pollBudget } : {},
			...this.declaredConformance !== void 0 ? { conformance: this.declaredConformance } : {},
			...jobControlOptions !== void 0 ? { jobControlOptions } : {},
			capabilityPolicy: this.capabilityPolicy
		});
	}
	/**
	* Resolve the conformance declaration. Under `"advertised"` only what the
	* caller already supplied (or a `conformance()` call made through this
	* handle) counts; under `"strict"` the declaration is fetched once through
	* the metadata cache so a refusal can be grounded in the server's own words.
	*/
	async resolveConformance(signal) {
		if (this.declaredConformance) return this.declaredConformance;
		if (this.capabilityPolicy !== "strict") return void 0;
		if (!this.conformancePromise) {
			const request = signal ? { signal } : {};
			this.conformancePromise = this.client.getOgcProcessesConformance(this.withBase(request)).then((response) => {
				this.declaredConformance = response;
				return response;
			}).catch((error) => {
				this.conformancePromise = void 0;
				throw error;
			});
		}
		return this.conformancePromise;
	}
	/**
	* Fail closed when the server has not declared what the caller asked for.
	* Returns the conformance declaration (when one is in hand) so the created
	* job run can reuse it to gate `cancel()`.
	*/
	async assertExecutionDeclared(request) {
		const conformance = await this.resolveConformance(request.signal);
		if ((conformance?.conformsTo !== void 0 || this.capabilityPolicy === "strict") && !declaresConformanceClass(conformance, PROCESSES_CONFORMANCE_MATCH.core)) throw capabilityRefusal("processes.execute", request.processId, {
			missingClass: PROCESSES_CONFORMANCE.core,
			construct: "execute"
		});
		const mode = request.mode ?? "auto";
		if (mode === "auto") return conformance;
		let jobControlOptions = request.jobControlOptions ?? this.jobControlByProcess.get(request.processId)?.options;
		if (!jobControlOptions && this.capabilityPolicy === "strict") jobControlOptions = (await this.describe(request.processId, request.signal ? { signal: request.signal } : {})).jobControlOptions ?? [];
		if (!jobControlOptions) return conformance;
		const required = mode === "sync" ? JOB_CONTROL.sync : JOB_CONTROL.async;
		if (!declares(jobControlOptions, required)) throw capabilityRefusal(`processes.${required}`, request.processId, {
			construct: required,
			declaredJobControlOptions: jobControlOptions.join(",")
		});
		return conformance;
	}
};
/**
* `IJobRun` implementation backed by OGC API Processes 1.0 status / result
* endpoints. Watchers receive the latest `JobSnapshot` when status,
* progress, or terminal result changes; cancel is idempotent and races
* the server's `dismissed` response against any concurrent terminal
* transition.
*/
var HonuaOgcProcessJobRun = class {
	id;
	type;
	client;
	basePath;
	pollIntervalMs;
	pollFn;
	pollBudget;
	conformance;
	jobControlOptions;
	capabilityPolicy;
	/** Server-advertised routes, refreshed from every `links[]` the job reports. */
	statusPath;
	resultsPath;
	lifecycle;
	constructor(options) {
		this.client = options.client;
		this.id = options.jobId;
		this.type = options.processId ?? options.initialStatus?.processID ?? "unknown";
		this.basePath = options.basePath;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.pollBudget = options.pollBudget;
		this.conformance = options.conformance;
		this.jobControlOptions = options.jobControlOptions;
		this.capabilityPolicy = options.capabilityPolicy ?? "advertised";
		this.statusPath = options.statusPath;
		this.resultsPath = options.resultsPath;
		this.pollFn = options.pollFn ?? ((jobId, signal) => this.fetchStatus(jobId, signal));
		const initial = options.initialStatus;
		this.absorbLinks(initial?.links);
		this.lifecycle = new JobRunLifecycle({
			id: this.id,
			initialStatus: initial?.status ?? "accepted",
			initialProgress: progressFromOgcStatus(initial),
			pollIntervalMs: () => this.pollIntervalMs,
			pollBudget: this.pollBudget,
			poll: async (signal) => this.translateOgcStatus(await this.pollFn(this.id, signal))
		});
	}
	async fetchStatus(jobId, signal) {
		if (this.capabilityPolicy === "strict" && this.statusPath === void 0) throw capabilityRefusal("processes.jobStatusLink", this.type, {
			construct: "job status route",
			linkRelation: PROCESSES_LINK_REL.status
		});
		return this.client.getOgcProcessJob({
			jobId,
			...signal ? { signal } : {},
			...this.basePath !== void 0 ? { basePath: this.basePath } : {},
			...this.statusPath !== void 0 ? { routePath: this.statusPath } : {}
		});
	}
	/**
	* Adopt the routes the server advertises on a job document. Every poll can
	* refresh them, so a server that only publishes its results link once the
	* job succeeds is still followed rather than path-guessed.
	*/
	absorbLinks(links) {
		if (!links || links.length === 0) return;
		const baseUrl = this.client.serverBaseUrl;
		const documentUrl = requestUrlFor(baseUrl, this.statusPath ?? templatedJobPath(this.basePath, this.id));
		const results = linkPath(links, documentUrl, baseUrl, PROCESSES_LINK_REL.results);
		if (results) this.resultsPath = results;
		if (this.statusPath === void 0) {
			const status = linkPath(links, documentUrl, baseUrl, PROCESSES_LINK_REL.status, "status", "monitor");
			if (status) this.statusPath = status;
		}
	}
	get status() {
		return this.lifecycle.status;
	}
	get progress() {
		return this.lifecycle.progress;
	}
	async poll() {
		return this.lifecycle.poll();
	}
	watch(listener) {
		return this.lifecycle.watch(listener);
	}
	async results(options = {}) {
		return this.lifecycle.results(options);
	}
	async cancel() {
		if (this.lifecycle.terminal) return this.lifecycle.status;
		this.assertDismissDeclared();
		return this.lifecycle.cancel(() => this.cancelSnapshot());
	}
	async cancelSnapshot() {
		try {
			const cancelled = await this.client.cancelOgcProcessJob(this.jobRequest(this.statusPath));
			return this.translateOgcStatus(cancelled);
		} catch (error) {
			const statusCode = error?.statusCode;
			if (statusCode === 404) return {
				status: this.lifecycle.status,
				progress: this.lifecycle.progress
			};
			if (statusCode === 409 && isCompletedJobConflict(error)) {
				let fresh;
				try {
					fresh = await this.pollFn(this.id);
				} catch {
					throw error;
				}
				const snapshot = await this.translateOgcStatus(fresh);
				if (!isJobTerminal(snapshot.status)) throw error;
				return snapshot;
			}
			throw error;
		}
	}
	/**
	* Translate an OGC `statusInfo` payload onto the canonical snapshot
	* surface, fire watchers, and (for `successful` terminals) fetch the
	* result document inline so the snapshot's `result.outputs` is
	* populated by the time `runUntilTerminal` / `poll` resolves.
	*/
	async translateOgcStatus(ogcStatus) {
		const status = ogcStatus.status ?? "accepted";
		const progress = progressFromOgcStatus(ogcStatus);
		this.absorbLinks(ogcStatus.links);
		if (status === "successful") try {
			if (this.capabilityPolicy === "strict" && this.resultsPath === void 0) throw capabilityRefusal("processes.jobResultsLink", this.type, {
				construct: "job results route",
				linkRelation: PROCESSES_LINK_REL.results
			});
			return {
				status: "successful",
				progress,
				result: { outputs: await this.client.getOgcProcessJobResults(this.jobRequest(this.resultsPath)) }
			};
		} catch (error) {
			if (error instanceof HonuaCapabilityNotSupportedError) throw error;
			return {
				status: "failed",
				progress,
				error: {
					code: error?.name ?? "ResultsFetchFailed",
					message: error instanceof Error ? error.message : String(error)
				}
			};
		}
		if (status === "failed" || status === "dismissed") {
			const error = terminalJobError(status, ogcStatus);
			return {
				status,
				progress,
				...error ? { error } : {}
			};
		}
		return {
			status,
			progress
		};
	}
	/**
	* Job-route envelope pinned to the root the job was created against,
	* preferring a route the server advertised over the Core path template.
	*/
	jobRequest(routePath) {
		return {
			jobId: this.id,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {},
			...routePath !== void 0 ? { routePath } : {}
		};
	}
	/**
	* Dismissal is an optional Core extension. When the server's declaration is
	* in hand and neither the Dismiss conformance class nor the process's
	* `jobControlOptions` includes `dismiss`, refuse before issuing a DELETE the
	* server never advertised.
	*
	* Under `"strict"` the absence of any declaration refuses too: a handle that
	* resolves declarations for itself has no honest reason to DELETE a job on a
	* server that never said it could be dismissed.
	*/
	assertDismissDeclared() {
		if (this.capabilityPolicy === "strict" && this.statusPath === void 0) throw capabilityRefusal("processes.jobStatusLink", this.type, {
			construct: "job status route",
			linkRelation: PROCESSES_LINK_REL.status
		});
		if (declares(this.jobControlOptions, JOB_CONTROL.dismiss)) return;
		if (!this.conformance?.conformsTo && this.capabilityPolicy !== "strict") return;
		if (declaresConformanceClass(this.conformance, PROCESSES_CONFORMANCE_MATCH.dismiss)) return;
		throw capabilityRefusal("processes.dismiss", this.type, {
			missingClass: PROCESSES_CONFORMANCE.dismiss,
			construct: JOB_CONTROL.dismiss
		});
	}
};
/**
* `IJobRun` for a synchronous execution (Core §7.11: `200` with the results
* document inline). No job resource exists on the server, so the run starts
* terminal: `results()` resolves from memory, `poll()` replays the terminal
* snapshot, and `cancel()` is a no-op that reports the outcome that already
* happened. Callers therefore read a sync and an async execution through one
* surface.
*/
var HonuaOgcProcessSyncRun = class {
	/** Empty: OGC Processes assigns no job identifier to a synchronous execution. */
	id = "";
	type;
	status = "successful";
	progress = { percent: 100 };
	snapshot;
	constructor(processId, outputs) {
		this.type = processId;
		this.snapshot = {
			status: "successful",
			progress: this.progress,
			result: { outputs }
		};
	}
	async poll() {
		return this.snapshot;
	}
	watch(listener) {
		listener(this.snapshot);
		return () => {};
	}
	async results() {
		return this.snapshot.result;
	}
	async cancel() {
		return "successful";
	}
};
/**
* Honua-server emits problem-details JSON for DELETE /jobs/{id} 409s. The
* `title` distinguishes the benign terminal race ("Cannot dismiss
* completed job") from non-benign 409s ("Dismiss could not be confirmed",
* "Cancellation not supported"). The detail text mirrors the title
* ("terminal state '...'") so we accept either as confirmation.
*/
function isCompletedJobConflict(error) {
	const body = error?.body;
	if (!body || typeof body !== "object") return false;
	const title = body.title;
	const detail = body.detail;
	if (typeof title === "string" && /cannot dismiss completed job/i.test(title)) return true;
	if (typeof detail === "string" && /terminal state/i.test(detail)) return true;
	return false;
}
function terminalJobError(status, ogcStatus) {
	if (ogcStatus.exception) return { ...ogcStatus.exception };
	if (typeof ogcStatus.message === "string" && ogcStatus.message.length > 0) return {
		code: status === "dismissed" ? "JobDismissed" : "JobFailed",
		message: ogcStatus.message
	};
}
function progressFromOgcStatus(ogcStatus) {
	if (!ogcStatus) return void 0;
	const out = {};
	if (typeof ogcStatus.progress === "number" && Number.isFinite(ogcStatus.progress)) out.percent = clampPercent(ogcStatus.progress);
	if (ogcStatus.message !== void 0) out.message = ogcStatus.message;
	if (ogcStatus.updated !== void 0) out.updatedAt = ogcStatus.updated;
	if (out.percent === void 0 && out.message === void 0 && out.updatedAt === void 0) return;
	return out;
}
function clampPercent(value) {
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}
async function getOgcProcessesLanding(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = processesBase(request);
	return transport.requestCachedMetadataJson(`ogc-processes:landing:${processesBaseKey(request)}${params.toString()}`, `${base}?${params.toString()}`, request);
}
async function getOgcProcessesConformance(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = processesBase(request);
	return transport.requestCachedMetadataJson(`ogc-processes:conformance:${processesBaseKey(request)}${params.toString()}`, `${base}/conformance?${params.toString()}`, request);
}
async function listOgcProcesses(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = processesBase(request);
	return transport.requestCachedMetadataJson(`ogc-processes:processes:${processesBaseKey(request)}${params.toString()}`, `${base}/processes?${params.toString()}`, request);
}
async function getOgcProcess(transport, request) {
	const params = createOgcMetadataParams(request);
	const base = processesBase(request);
	return transport.requestCachedMetadataJson(`ogc-processes:process:${processesBaseKey(request)}${encodeURIComponent(request.processId)}:${params.toString()}`, `${base}/processes/${encodeURIComponent(request.processId)}?${params.toString()}`, request);
}
/**
* `POST /processes/{processId}/execution` (Core §7.11).
*
* Core defines two success shapes and a conformant server may choose either:
* `200` with the results document (synchronous) or `201` + `Location` with a
* `statusInfo` body (asynchronous). This reads the response rather than
* assuming one, so the same call works against a raw third-party server and
* against the async-only Honua facade, and reports which shape came back.
*/
async function executeOgcProcess(transport, request) {
	const headers = executionHeaders(request);
	const path = `${processesBase(request)}/processes/${encodeURIComponent(request.processId)}/execution`;
	const body = JSON.stringify({
		inputs: request.inputs ?? {},
		outputs: request.outputs,
		response: "document"
	});
	const response = await transport.pipelineFetch("POST", path, {
		headers,
		body
	}, request.signal);
	const payload = await readExecutionPayload(response);
	const statusInfo = asJobStatusInfo(payload, request.processId);
	const documentUrl = requestUrlFor(transport.baseUrl, path);
	const location = advertisedRoutePath(response.headers.get("Location") ?? void 0, documentUrl, transport.baseUrl);
	if (statusInfo) {
		const statusPath = location ?? linkPath(statusInfo.links, documentUrl, transport.baseUrl, PROCESSES_LINK_REL.status, "status");
		return {
			jobID: statusInfo.jobID,
			status: statusInfo.status,
			processID: statusInfo.processID ?? request.processId,
			...statusInfo.links ? { links: [...statusInfo.links] } : {},
			statusInfo,
			...statusPath !== void 0 ? { statusPath } : {},
			synchronous: false
		};
	}
	if (location !== void 0) return {
		jobID: jobIdFromRoute(location),
		status: "accepted",
		processID: request.processId,
		statusPath: location,
		synchronous: false
	};
	return {
		jobID: "",
		status: "successful",
		processID: request.processId,
		results: payload ?? {},
		synchronous: true
	};
}
/**
* Decode an execution response body. A `204` (or empty body) yields
* `undefined`; a non-JSON body is refused rather than guessed at, because the
* SDK asked for `response: "document"` and can only project a JSON outputs map
* onto `JobResult.outputs`.
*/
async function readExecutionPayload(response) {
	if (response.status === 204) return void 0;
	const text = await response.text();
	if (text.trim().length === 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		throw capabilityRefusal("processes.documentResponse", void 0, {
			construct: "document-mode execution response",
			contentType: response.headers.get("Content-Type") ?? "unknown"
		});
	}
}
/** Recognize an async `statusInfo` body: Core requires a non-empty `jobID`. */
function asJobStatusInfo(payload, processId) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return void 0;
	const candidate = payload;
	if (typeof candidate.jobID !== "string" || candidate.jobID.length === 0) return void 0;
	return {
		...candidate,
		jobID: candidate.jobID,
		processID: candidate.processID ?? processId,
		status: candidate.status ?? "accepted"
	};
}
/** Last path segment of an advertised job route, decoded. */
function jobIdFromRoute(routePath) {
	const withoutQuery = routePath.split("?", 1)[0] ?? routePath;
	const trimmed = withoutQuery.endsWith("/") ? withoutQuery.slice(0, -1) : withoutQuery;
	const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
async function getOgcProcessJob(transport, request) {
	const params = createOgcMetadataParams(request);
	const route = request.routePath ?? `${processesBase(request)}/jobs/${encodeURIComponent(request.jobId)}`;
	return transport.requestJson("GET", withParams(route, params), void 0, request.signal);
}
async function getOgcProcessJobResults(transport, request) {
	const params = createOgcMetadataParams(request);
	const route = request.routePath ?? `${processesBase(request)}/jobs/${encodeURIComponent(request.jobId)}/results`;
	return transport.requestJson("GET", withParams(route, params), void 0, request.signal);
}
async function cancelOgcProcessJob(transport, request) {
	const params = createOgcMetadataParams(request);
	const route = request.routePath ?? `${processesBase(request)}/jobs/${encodeURIComponent(request.jobId)}`;
	return transport.requestJson("DELETE", withParams(route, params), void 0, request.signal);
}
/**
* Build the execution preference header defined by OGC API Processes 1.0.
* Requirement 25 selects synchronous execution by omitting `Prefer`; only an
* explicit asynchronous request sends the standard `respond-async` token.
* Clients remain prepared for either response shape.
*/
function executionHeaders(request) {
	const headers = new Headers(mergeHeaders({
		"Content-Type": "application/json",
		Accept: "application/json"
	}, request.headers));
	headers.delete("Prefer");
	if (request.mode === "async") headers.set("Prefer", "respond-async");
	return headers;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/ogc-records.js
/**
* OGC API Records surface. Records are catalog metadata documents about
* resources (services, collections, maps, scenes, STAC collections, source
* descriptors), not STAC imagery items and not protocol-native service
* metadata. The wire calls live on `HonuaClient`; this class is the
* request-shaping layer on top.
*
* @module
*/
/** Honua facade path prefix for OGC API Records. */
var RECORDS_FACADE_BASE = "/ogc/records";
/**
* Resolve the OGC API Records path prefix: the caller-supplied raw
* `basePath` (a `connect()`-discovered third-party service root) or the Honua
* facade default. Trailing slashes are trimmed so a discovered root and the
* facade compose the same sub-paths.
*/
function recordsBase(request) {
	if (request.basePath === void 0) return RECORDS_FACADE_BASE;
	const base = request.basePath;
	let end = base.length;
	while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
	return base.slice(0, end);
}
/** Cache-key discriminator so a discovered root never collides with the facade. */
function recordsBaseKey(request) {
	const base = recordsBase(request);
	return base === RECORDS_FACADE_BASE ? "" : `${base}:`;
}
var DEFAULT_RECORDS_PAGE_SIZE = 100;
var DEFAULT_RECORDS_MAX_PAGES = 100;
/** Top-level OGC API Records handle. */
var HonuaOgcRecords = class {
	client;
	basePath;
	constructor(options) {
		this.client = options.client;
		this.basePath = options.basePath;
	}
	withBase(request) {
		return this.basePath !== void 0 ? {
			...request,
			basePath: this.basePath
		} : request;
	}
	collection(collectionId) {
		return new HonuaOgcRecordCollection({
			client: this.client,
			collectionId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
	async landing(request = {}) {
		return this.client.getOgcRecordsLanding(this.withBase(request));
	}
	async conformance(request = {}) {
		return this.client.getOgcRecordsConformance(this.withBase(request));
	}
	async collections(request = {}) {
		return this.client.listOgcRecordCollections(this.withBase(request));
	}
	async collectionMetadata(request) {
		return this.client.getOgcRecordCollection(this.withBase(request));
	}
	async search(request) {
		return this.client.searchOgcRecords(this.withBase(request));
	}
	async record(request) {
		return this.client.getOgcRecord(this.withBase(request));
	}
	async rawSearch(request) {
		return this.client.fetchOgcRecordsRaw(this.withBase(request));
	}
	async rawRecord(request) {
		return this.client.fetchOgcRecordRaw(this.withBase(request));
	}
	async searchAll(request) {
		const pageSize = request.pageSize ?? request.limit ?? DEFAULT_RECORDS_PAGE_SIZE;
		const maxPages = request.maxPages ?? DEFAULT_RECORDS_MAX_PAGES;
		const records = [];
		let cursor = { offset: request.offset };
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.client.searchOgcRecords(this.withBase({
				...request,
				limit: pageSize,
				offset: cursor.offset
			}));
			const pageRecords = response.features ?? [];
			if (pageRecords.length === 0) break;
			records.push(...pageRecords);
			cursor = nextRecordsCursor(response.links);
			if (cursor.offset === void 0) break;
		}
		return records;
	}
	async *searchStream(request) {
		const pageSize = request.pageSize ?? request.limit ?? DEFAULT_RECORDS_PAGE_SIZE;
		const maxPages = request.maxPages ?? DEFAULT_RECORDS_MAX_PAGES;
		let cursor = { offset: request.offset };
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.client.searchOgcRecords(this.withBase({
				...request,
				limit: pageSize,
				offset: cursor.offset
			}));
			const pageRecords = response.features ?? [];
			if (pageRecords.length === 0) break;
			yield pageRecords;
			cursor = nextRecordsCursor(response.links);
			if (cursor.offset === void 0) break;
		}
	}
};
/**
* Bound handle for one Records catalog (`/collections/{catalogId}`). Drops
* the routing discriminator from per-call requests.
*/
var HonuaOgcRecordCollection = class {
	client;
	collectionId;
	basePath;
	constructor(options) {
		this.client = options.client;
		this.collectionId = options.collectionId;
		this.basePath = options.basePath;
	}
	bind(request) {
		return {
			...request,
			collectionId: this.collectionId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		};
	}
	rootHandle() {
		return new HonuaOgcRecords({
			client: this.client,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
	async metadata(request = {}) {
		return this.client.getOgcRecordCollection(this.bind(request));
	}
	async search(request = {}) {
		return this.client.searchOgcRecords(this.bind(request));
	}
	async record(request) {
		return this.client.getOgcRecord(this.bind(request));
	}
	async rawSearch(request = {}) {
		return this.client.fetchOgcRecordsRaw(this.bind(request));
	}
	async rawRecord(request) {
		return this.client.fetchOgcRecordRaw(this.bind(request));
	}
	async searchAll(request = {}) {
		return this.rootHandle().searchAll({
			...request,
			collectionId: this.collectionId
		});
	}
	searchStream(request = {}) {
		return this.rootHandle().searchStream({
			...request,
			collectionId: this.collectionId
		});
	}
};
/**
* Query-param names that may carry the next-page start offset on an OGC API
* `rel:"next"` link. `offset` is Honua Server's spelling; `startindex` is the
* OGC API – Features / Records standard name (servers also vary the casing).
*/
var RECORDS_OFFSET_PARAM_NAMES = [
	"offset",
	"startindex",
	"startIndex"
];
function nextRecordsCursor(links) {
	if (!links) return {};
	for (const link of links) {
		if (link.rel !== "next" || typeof link.href !== "string") continue;
		try {
			const offsetParam = readFirstParam(new URL(link.href, "https://placeholder.test").searchParams, RECORDS_OFFSET_PARAM_NAMES);
			if (offsetParam === null) continue;
			const offset = Number(offsetParam);
			if (Number.isFinite(offset)) return { offset };
		} catch {}
	}
	return {};
}
/** Return the first non-null value among `names` from the query string. */
function readFirstParam(params, names) {
	for (const name of names) {
		const value = params.get(name);
		if (value !== null) return value;
	}
	return null;
}
async function getOgcRecordsLanding(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = recordsBase(request);
	return transport.requestCachedMetadataJson(`ogc-records:landing:${recordsBaseKey(request)}${params.toString()}`, `${base}?${params.toString()}`, request);
}
async function getOgcRecordsConformance(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = recordsBase(request);
	return transport.requestCachedMetadataJson(`ogc-records:conformance:${recordsBaseKey(request)}${params.toString()}`, `${base}/conformance?${params.toString()}`, request);
}
async function listOgcRecordCollections(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = recordsBase(request);
	return transport.requestCachedMetadataJson(`ogc-records:collections:${recordsBaseKey(request)}${params.toString()}`, `${base}/collections?${params.toString()}`, request);
}
async function getOgcRecordCollection(transport, request) {
	const params = createOgcMetadataParams(request);
	const path = `${recordsBase(request)}/collections/${encodeURIComponent(String(request.collectionId))}`;
	return transport.requestCachedMetadataJson(`ogc-records:collection:${recordsBaseKey(request)}${request.collectionId}:${params.toString()}`, `${path}?${params.toString()}`, request);
}
async function searchOgcRecords(transport, request) {
	return transport.requestJson("GET", buildOgcRecordsSearchPath(request), void 0, request.signal);
}
async function getOgcRecord(transport, request) {
	return transport.requestJson("GET", buildOgcRecordPath(request), void 0, request.signal);
}
async function fetchOgcRecordsRaw(transport, request) {
	return transport.pipelineFetch("GET", buildOgcRecordsSearchPath(request), { headers: mergeHeaders({ Accept: request.accept ?? "application/geo+json, application/json;q=0.9" }, request.headers) }, request.signal);
}
async function fetchOgcRecordRaw(transport, request) {
	return transport.pipelineFetch("GET", buildOgcRecordPath(request), { headers: mergeHeaders({ Accept: request.accept ?? "application/geo+json, application/json;q=0.9" }, request.headers) }, request.signal);
}
function normalizeRecordsBbox(value) {
	return Array.isArray(value) ? value.join(",") : String(value);
}
function buildOgcRecordsSearchPath(request) {
	const collection = encodeURIComponent(String(request.collectionId));
	const params = serializeOgcRecordsSearchParams(request);
	return `${recordsBase(request)}/collections/${collection}/items?${params.toString()}`;
}
function buildOgcRecordPath(request) {
	const collection = encodeURIComponent(String(request.collectionId));
	const record = encodeURIComponent(String(request.recordId));
	const params = createOgcMetadataParams(request);
	if (request.profile !== void 0) params.set("profile", normalizeStringCsv(request.profile));
	return `${recordsBase(request)}/collections/${collection}/items/${record}?${params.toString()}`;
}
function serializeOgcRecordsSearchParams(request) {
	const params = createOgcMetadataParams(request);
	if (request.limit !== void 0) params.set("limit", String(request.limit));
	if (request.offset !== void 0) params.set("offset", String(request.offset));
	if (request.bbox !== void 0) params.set("bbox", normalizeRecordsBbox(request.bbox));
	if (request.datetime !== void 0) params.set("datetime", request.datetime);
	if (request.q !== void 0) params.set("q", normalizeStringCsv(request.q));
	if (request.ids !== void 0) params.set("ids", normalizeCsv(request.ids));
	if (request.type !== void 0) params.set("type", normalizeStringCsv(request.type));
	if (request.externalIds !== void 0) params.set("externalIds", normalizeStringCsv(request.externalIds));
	if (request.filter !== void 0) params.set("filter", request.filter);
	if (request.filterLang !== void 0) params.set("filter-lang", request.filterLang);
	if (request.filterCrs !== void 0) params.set("filter-crs", request.filterCrs);
	if (request.properties !== void 0) params.set("properties", normalizeStringCsv(request.properties));
	if (request.sortby !== void 0) params.set("sortby", request.sortby);
	if (request.profile !== void 0) params.set("profile", normalizeStringCsv(request.profile));
	return params;
}
/** Honua facade path prefix for OGC API Tiles. */
var TILES_FACADE_BASE = "/ogc/tiles";
/**
* Resolve the OGC API Tiles path prefix: the caller-supplied raw `basePath` (a
* `connect()`-discovered third-party service root) or the Honua facade default.
* Trailing slashes are trimmed so a discovered root and the facade compose the
* same sub-paths. Mirrors the OGC API Records seam in `ogc-records.ts`.
*/
function tilesBase(request) {
	if (request.basePath === void 0) return TILES_FACADE_BASE;
	const base = request.basePath;
	let end = base.length;
	while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
	return base.slice(0, end);
}
/** Cache-key discriminator so a discovered root never collides with the facade. */
function tilesBaseKey(request) {
	const base = tilesBase(request);
	return base === TILES_FACADE_BASE ? "" : `${base}:`;
}
/**
* Top-level OGC API Tiles handle. Mirrors `HonuaOgcFeatures` for the
* tiles conformance classes.
*/
var HonuaOgcTiles = class {
	client;
	basePath;
	constructor(options) {
		this.client = options.client;
		this.basePath = options.basePath;
	}
	withBase(request) {
		return this.basePath !== void 0 ? {
			...request,
			basePath: this.basePath
		} : request;
	}
	tileset(collectionId, tileMatrixSetId) {
		return new HonuaOgcTileset({
			client: this.client,
			collectionId,
			tileMatrixSetId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
	async landing(request = {}) {
		return this.client.getOgcTilesLanding(this.withBase(request));
	}
	async conformance(request = {}) {
		return this.client.getOgcTilesConformance(this.withBase(request));
	}
	async tileMatrixSets(request = {}) {
		return this.client.listOgcTileMatrixSets(this.withBase(request));
	}
	async tileMatrixSet(tileMatrixSetId, request = {}) {
		return this.client.getOgcTileMatrixSet(this.withBase({
			...request,
			tileMatrixSetId
		}));
	}
	async tilesets(request) {
		return this.client.listOgcCollectionTilesets(this.withBase(request));
	}
	async tilesetMetadata(request) {
		return this.client.getOgcCollectionTileset(this.withBase(request));
	}
	async tile(request) {
		return this.client.fetchOgcTile(this.withBase(request));
	}
	/**
	* Build a MapLibre-ready vector source definition for a tiled collection.
	*
	* Produces a `{ type: "vector", tiles: ["…/{z}/{y}/{x}"] }` object whose
	* tile URL points at the canonical OGC API Tiles collection-tile route on
	* the SDK's configured `baseUrl`. The MapLibre `{z}/{y}/{x}` placeholders
	* are kept literal (the braces are not percent-encoded) while the
	* collection / service identifier is encoded per path segment so
	* folder-prefixed identifiers like `myFolder/parcels` serialize correctly.
	*
	* No network request is made; this is a pure URL-template builder. Pass
	* `minzoom` / `maxzoom` to constrain the source, otherwise MapLibre's
	* defaults apply.
	*/
	getMapLibreVectorSource(serviceId, options = {}) {
		const tileMatrixSetId = options.tileMatrixSetId ?? "WebMercatorQuad";
		const baseUrl = trimTrailingSlashes(this.client.serverBaseUrl);
		const collection = encodePathSegments(serviceId);
		const matrixSet = encodeURIComponent(tileMatrixSetId);
		const source = {
			type: "vector",
			tiles: [`${baseUrl}${tilesBase({ ...this.basePath !== void 0 ? { basePath: this.basePath } : {} })}/collections/${collection}/tiles/${matrixSet}/{z}/{y}/{x}`],
			scheme: "xyz"
		};
		if (options.minzoom !== void 0) source.minzoom = options.minzoom;
		if (options.maxzoom !== void 0) source.maxzoom = options.maxzoom;
		return source;
	}
	/**
	* Resolve the `source-layer` name to use in a MapLibre layer that renders
	* the collection's vector tiles. The Honua server names the MVT layer after
	* the collection identifier; for folder-prefixed identifiers the trailing
	* segment is the layer name (the folder is a routing prefix, not part of
	* the layer name baked into the tile).
	*/
	getDefaultSourceLayer(serviceId) {
		const segments = serviceId.split("/");
		return segments[segments.length - 1] ?? serviceId;
	}
	/**
	* Convenience wrapper returning both the MapLibre vector {@link source}
	* object and the {@link sourceLayer} name to wire into a layer definition.
	*/
	getMapLibreConfig(serviceId, options = {}) {
		return {
			source: this.getMapLibreVectorSource(serviceId, options),
			sourceLayer: this.getDefaultSourceLayer(serviceId)
		};
	}
};
/**
* Bound handle for one (collection × tile-matrix-set) tileset. Drops the
* discovery params from the per-call surface so callers focus on tile
* coordinates. Styled-tile access (the OGC `/styles/{styleId}` route) is
* not exposed here because the Honua server does not currently implement
* that route; the tile path is the canonical collection tile route.
*/
var HonuaOgcTileset = class {
	client;
	collectionId;
	tileMatrixSetId;
	basePath;
	constructor(options) {
		this.client = options.client;
		this.collectionId = options.collectionId;
		this.tileMatrixSetId = options.tileMatrixSetId;
		this.basePath = options.basePath;
	}
	async metadata(request = {}) {
		return this.client.getOgcCollectionTileset({
			...request,
			collectionId: this.collectionId,
			tileMatrixSetId: this.tileMatrixSetId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
	async tile(request) {
		return this.client.fetchOgcTile({
			...request,
			collectionId: this.collectionId,
			tileMatrixSetId: this.tileMatrixSetId,
			...this.basePath !== void 0 ? { basePath: this.basePath } : {}
		});
	}
};
async function getOgcTilesLanding(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = tilesBase(request);
	return transport.requestCachedMetadataJson(`ogc-tiles:landing:${tilesBaseKey(request)}${params.toString()}`, `${base}?${params.toString()}`, request);
}
async function getOgcTilesConformance(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = tilesBase(request);
	return transport.requestCachedMetadataJson(`ogc-tiles:conformance:${tilesBaseKey(request)}${params.toString()}`, `${base}/conformance?${params.toString()}`, request);
}
async function listOgcTileMatrixSets(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = tilesBase(request);
	return transport.requestCachedMetadataJson(`ogc-tiles:tile-matrix-sets:${tilesBaseKey(request)}${params.toString()}`, `${base}/tileMatrixSets?${params.toString()}`, request);
}
async function getOgcTileMatrixSet(transport, request) {
	const params = createOgcMetadataParams(request);
	const base = tilesBase(request);
	return transport.requestCachedMetadataJson(`ogc-tiles:tile-matrix-set:${tilesBaseKey(request)}${request.tileMatrixSetId}:${params.toString()}`, `${base}/tileMatrixSets/${encodeURIComponent(request.tileMatrixSetId)}?${params.toString()}`, request);
}
async function listOgcCollectionTilesets(transport, request) {
	const params = createOgcMetadataParams(request);
	const path = `${tilesBase(request)}/collections/${encodeURIComponent(String(request.collectionId))}/tiles`;
	return transport.requestCachedMetadataJson(`ogc-tiles:tilesets:${tilesBaseKey(request)}${request.collectionId}:${params.toString()}`, `${path}?${params.toString()}`, request);
}
async function getOgcCollectionTileset(transport, request) {
	const params = createOgcMetadataParams(request);
	const path = `${tilesBase(request)}/collections/${encodeURIComponent(String(request.collectionId))}/tiles/${encodeURIComponent(request.tileMatrixSetId)}`;
	return transport.requestCachedMetadataJson(`ogc-tiles:tileset:${tilesBaseKey(request)}${request.collectionId}:${request.tileMatrixSetId}:${params.toString()}`, `${path}?${params.toString()}`, request);
}
async function fetchOgcTile(transport, request) {
	const params = new URLSearchParams();
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const collection = encodeURIComponent(String(request.collectionId));
	const matrixSet = encodeURIComponent(request.tileMatrixSetId);
	const matrix = encodeURIComponent(String(request.tileMatrix));
	const query = params.size > 0 ? `?${params.toString()}` : "";
	const path = `${tilesBase(request)}/collections/${collection}/tiles/${matrixSet}/${matrix}/${request.tileRow}/${request.tileCol}${query}`;
	return transport.requestBytes("GET", path, request.accept, void 0, request.signal);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/pbf-decoder.js
/**
* Minimal protobuf wire-format reader and Esri PBF query response decoder.
*
* Decodes `FeatureCollectionPBuffer` responses (from `f=pbf`) into the same
* JSON-compatible shape as `f=json`, making the binary format transparent
* to callers.
*
* No external protobuf library dependency. Implements only the subset of
* the wire format needed for the Esri PBF query schema.
*
* @module
*/
var WIRE_VARINT = 0;
var WIRE_64BIT = 1;
var WIRE_LENGTH_DELIMITED = 2;
var WIRE_32BIT = 5;
/**
* Thrown when a PBF feature response cannot be decoded losslessly into the
* `f=json` shape — either because it carries Z/M geometry (which the flat
* 2D fast-path decoder would silently garble) or because the coordinate
* stream is malformed (odd length / non-finite values from a truncated or
* hostile payload). `HonuaClient` treats this as a signal to fall back to a
* fresh `f=json` request, which decodes the same data correctly.
*/
var PbfDecodeError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "PbfDecodeError";
	}
};
/** Reads protobuf wire-format primitives from a byte buffer. */
var PbfReader = class PbfReader {
	view;
	bytes;
	pos;
	end;
	constructor(buffer, offset = 0, length) {
		this.bytes = buffer;
		this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		this.pos = offset;
		this.end = length !== void 0 ? offset + length : buffer.length;
	}
	/** Read an unsigned 32-bit varint. */
	readVarint() {
		let result = 0;
		let shift = 0;
		while (this.pos < this.end) {
			const byte = this.bytes[this.pos++];
			result |= (byte & 127) << shift;
			if ((byte & 128) === 0) return result >>> 0;
			shift += 7;
			if (shift > 35) throw new Error("Varint too long");
		}
		throw new Error("Unexpected end of buffer reading varint");
	}
	/** Read a 64-bit varint as a JavaScript number (safe for values < 2^53). */
	readVarint64() {
		let lo = 0;
		let hi = 0;
		let shift = 0;
		while (shift < 28 && this.pos < this.end) {
			const byte = this.bytes[this.pos++];
			lo |= (byte & 127) << shift;
			shift += 7;
			if ((byte & 128) === 0) return lo >>> 0;
		}
		while (this.pos < this.end) {
			const byte = this.bytes[this.pos++];
			hi |= (byte & 127) << shift - 28;
			shift += 7;
			if ((byte & 128) === 0) break;
			if (shift > 63) throw new Error("Varint too long");
		}
		return (hi >>> 0) * 268435456 + (lo >>> 0);
	}
	/**
	* Read a 64-bit varint as a raw {@link bigint} with no precision loss. Used
	* for attribute decoding where values may exceed `Number.MAX_SAFE_INTEGER`
	* (e.g. BigInteger / 64-bit OID fields), so the caller can preserve exact
	* values as a string instead of silently rounding.
	*/
	readVarint64Bigint() {
		let result = 0n;
		let shift = 0n;
		while (this.pos < this.end) {
			const byte = this.bytes[this.pos++];
			result |= BigInt(byte & 127) << shift;
			if ((byte & 128) === 0) return result;
			shift += 7n;
			if (shift > 63n) throw new Error("Varint too long");
		}
		throw new Error("Unexpected end of buffer reading varint");
	}
	/** Read a signed 64-bit varint (zigzag-decoded) as a JavaScript number. */
	readSVarint64() {
		const n = this.readVarint64();
		const half = Math.floor(n / 2);
		return n % 2 === 0 ? half : -(half + 1);
	}
	/** Read a signed 32-bit varint (zigzag-decoded). */
	readSVarint32() {
		const n = this.readVarint();
		return n >>> 1 ^ -(n & 1);
	}
	/** Read a little-endian 64-bit float. */
	readDouble() {
		const val = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return val;
	}
	/** Read a little-endian 32-bit float. */
	readFloat() {
		const val = this.view.getFloat32(this.pos, true);
		this.pos += 4;
		return val;
	}
	/** Read a UTF-8 string of the given byte length. */
	readString(byteLength) {
		const slice = this.bytes.subarray(this.pos, this.pos + byteLength);
		this.pos += byteLength;
		return textDecoder.decode(slice);
	}
	/** Read a boolean from a varint. */
	readBool() {
		return this.readVarint() !== 0;
	}
	/** Read a field tag, returning [fieldNumber, wireType]. */
	readTag() {
		const tag = this.readVarint();
		return [tag >>> 3, tag & 7];
	}
	/** Skip a field value based on wire type. */
	skip(wireType) {
		switch (wireType) {
			case WIRE_VARINT:
				this.readVarint64();
				break;
			case WIRE_64BIT:
				this.pos += 8;
				break;
			case WIRE_LENGTH_DELIMITED: {
				const len = this.readVarint();
				this.pos += len;
				break;
			}
			case WIRE_32BIT:
				this.pos += 4;
				break;
			default: throw new Error(`Unknown wire type: ${wireType}`);
		}
	}
	/** Create a sub-reader for a length-delimited field. */
	subReader(byteLength) {
		const sub = new PbfReader(this.bytes, this.pos, byteLength);
		this.pos += byteLength;
		return sub;
	}
	/** Read packed repeated sint64 values. */
	readPackedSInt64(byteLength) {
		const result = [];
		const end = this.pos + byteLength;
		while (this.pos < end) result.push(this.readSVarint64());
		return result;
	}
	/** Read packed repeated uint32 values. */
	readPackedUInt32(byteLength) {
		const result = [];
		const end = this.pos + byteLength;
		while (this.pos < end) result.push(this.readVarint());
		return result;
	}
};
var textDecoder = new TextDecoder();
var PBF_GEOMETRY_TYPE_NAMES = {
	0: "esriGeometryPoint",
	1: "esriGeometryMultipoint",
	2: "esriGeometryPolyline",
	3: "esriGeometryPolygon",
	4: "esriGeometryEnvelope",
	127: "esriGeometryNull"
};
function decodeScale(reader) {
	let xScale = 0;
	let yScale = 0;
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_64BIT) xScale = reader.readDouble();
		else if (field === 2 && wire === WIRE_64BIT) yScale = reader.readDouble();
		else reader.skip(wire);
	}
	return {
		xScale,
		yScale
	};
}
function decodeTranslate(reader) {
	let xTranslate = 0;
	let yTranslate = 0;
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_64BIT) xTranslate = reader.readDouble();
		else if (field === 2 && wire === WIRE_64BIT) yTranslate = reader.readDouble();
		else reader.skip(wire);
	}
	return {
		xTranslate,
		yTranslate
	};
}
function decodeTransform(reader) {
	let xScale = 1;
	let yScale = 1;
	let xTranslate = 0;
	let yTranslate = 0;
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			const s = decodeScale(reader.subReader(len));
			xScale = s.xScale;
			yScale = s.yScale;
		} else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			const t = decodeTranslate(reader.subReader(len));
			xTranslate = t.xTranslate;
			yTranslate = t.yTranslate;
		} else reader.skip(wire);
	}
	return {
		xScale,
		yScale,
		xTranslate,
		yTranslate
	};
}
function decodeField(reader) {
	let name = "";
	let fieldType = 0;
	let alias = "";
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			name = reader.readString(len);
		} else if (field === 2 && wire === WIRE_VARINT) fieldType = reader.readVarint();
		else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			alias = reader.readString(len);
		} else reader.skip(wire);
	}
	return {
		name,
		fieldType,
		alias: alias || name
	};
}
function decodeSpatialReference(reader) {
	let wkid = 0;
	let latestWkid = 0;
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_VARINT) wkid = reader.readVarint();
		else if (field === 2 && wire === WIRE_VARINT) latestWkid = reader.readVarint();
		else reader.skip(wire);
	}
	return {
		wkid,
		latestWkid: latestWkid || wkid
	};
}
var MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
var MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
var TWO_POW_64 = 1n << 64n;
/**
* Reinterpret an unsigned 64-bit value as signed two's-complement, matching how
* GeoServices PBF encodes `int64` attributes.
*/
function asInt64(unsigned) {
	return unsigned >= 1n << 63n ? unsigned - TWO_POW_64 : unsigned;
}
/**
* Preserve 64-bit integer precision: return a JS `number` when the value fits
* within the safe-integer range, otherwise a decimal string. Mirrors the gRPC
* transport's `toSafeNumberOrString` so PBF, gRPC, and `f=json` agree on large
* 64-bit ids instead of the PBF fast path silently rounding above 2^53.
*/
function safeNumberOrString(value) {
	return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
}
function decodeValue(reader) {
	let value = null;
	let fieldIndex = -1;
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		switch (field) {
			case 1:
				if (wire === WIRE_LENGTH_DELIMITED) {
					const len = reader.readVarint();
					value = reader.readString(len);
				} else reader.skip(wire);
				break;
			case 2:
				if (wire === WIRE_32BIT) value = reader.readFloat();
				else reader.skip(wire);
				break;
			case 3:
				if (wire === WIRE_64BIT) value = reader.readDouble();
				else reader.skip(wire);
				break;
			case 4:
				if (wire === WIRE_VARINT) value = reader.readSVarint32();
				else reader.skip(wire);
				break;
			case 5:
				if (wire === WIRE_VARINT) value = reader.readVarint();
				else reader.skip(wire);
				break;
			case 6:
				if (wire === WIRE_VARINT) value = safeNumberOrString(asInt64(reader.readVarint64Bigint()));
				else reader.skip(wire);
				break;
			case 7:
				if (wire === WIRE_VARINT) value = safeNumberOrString(reader.readVarint64Bigint());
				else reader.skip(wire);
				break;
			case 9:
				if (wire === WIRE_VARINT) value = reader.readBool();
				else reader.skip(wire);
				break;
			case 10:
				if (wire === WIRE_VARINT) {
					reader.readVarint();
					value = null;
				} else reader.skip(wire);
				break;
			case 11:
				if (wire === WIRE_VARINT) fieldIndex = reader.readVarint();
				else reader.skip(wire);
				break;
			default: reader.skip(wire);
		}
	}
	return {
		value,
		fieldIndex
	};
}
function decodeGeometry(reader, transform, layerGeometryType) {
	let lengths = [];
	let coords = [];
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_VARINT) reader.readVarint();
		else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			lengths = reader.readPackedUInt32(len);
		} else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			coords = reader.readPackedSInt64(len);
		} else reader.skip(wire);
	}
	if (coords.length === 0) return null;
	if (coords.length % 2 !== 0) throw new PbfDecodeError(`PBF geometry coordinate stream has an odd length (${coords.length})`);
	const xScale = transform?.xScale ?? 1;
	const yScale = transform?.yScale ?? 1;
	const xTranslate = transform?.xTranslate ?? 0;
	const yTranslate = transform?.yTranslate ?? 0;
	let prevX = 0;
	let prevY = 0;
	const worldCoords = [];
	for (let i = 0; i < coords.length; i += 2) {
		prevX += coords[i];
		prevY += coords[i + 1];
		const x = prevX * xScale + xTranslate;
		const y = prevY * yScale + yTranslate;
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PbfDecodeError("PBF geometry produced a non-finite coordinate");
		worldCoords.push([x, y]);
	}
	return buildGeoServicesGeometry(layerGeometryType, worldCoords, lengths);
}
function buildGeoServicesGeometry(geometryType, worldCoords, lengths) {
	switch (geometryType) {
		case "esriGeometryPoint": return worldCoords.length > 0 ? {
			x: worldCoords[0][0],
			y: worldCoords[0][1]
		} : {
			x: null,
			y: null
		};
		case "esriGeometryMultipoint": return { points: worldCoords };
		case "esriGeometryPolyline": {
			const paths = [];
			let offset = 0;
			for (const len of lengths) {
				paths.push(worldCoords.slice(offset, offset + len));
				offset += len;
			}
			return { paths: paths.length > 0 ? paths : [worldCoords] };
		}
		case "esriGeometryPolygon": {
			const rings = [];
			let offset = 0;
			for (const len of lengths) {
				rings.push(worldCoords.slice(offset, offset + len));
				offset += len;
			}
			return { rings: rings.length > 0 ? rings : [worldCoords] };
		}
		default: return {
			x: worldCoords[0]?.[0] ?? null,
			y: worldCoords[0]?.[1] ?? null
		};
	}
}
function decodeFeature(reader, fields, transform, geometryType) {
	const attributes = {};
	let geometry = null;
	const valueEntries = [];
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			const sub = reader.subReader(len);
			valueEntries.push(decodeValue(sub));
		} else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			geometry = decodeGeometry(reader.subReader(len), transform, geometryType);
		} else reader.skip(wire);
	}
	for (const entry of valueEntries) if (entry.fieldIndex >= 0 && entry.fieldIndex < fields.length) attributes[fields[entry.fieldIndex].name] = entry.value;
	const result = { attributes };
	if (geometry !== null) result.geometry = geometry;
	return result;
}
function decodeFeatureResult(reader) {
	let objectIdFieldName = "";
	let geometryType = "";
	let spatialReference = null;
	let exceededTransferLimit = false;
	let hasZ = false;
	let hasM = false;
	let transform = null;
	const fields = [];
	const featureReaders = [];
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		switch (field) {
			case 1:
				if (wire === WIRE_LENGTH_DELIMITED) {
					const len = reader.readVarint();
					objectIdFieldName = reader.readString(len);
				} else reader.skip(wire);
				break;
			case 7:
				if (wire === WIRE_VARINT) geometryType = PBF_GEOMETRY_TYPE_NAMES[reader.readVarint()] ?? "esriGeometryNull";
				else reader.skip(wire);
				break;
			case 8:
				if (wire === WIRE_LENGTH_DELIMITED) {
					const len = reader.readVarint();
					spatialReference = decodeSpatialReference(reader.subReader(len));
				} else reader.skip(wire);
				break;
			case 9:
				if (wire === WIRE_VARINT) exceededTransferLimit = reader.readBool();
				else reader.skip(wire);
				break;
			case 10:
				if (wire === WIRE_VARINT) hasZ = reader.readBool();
				else reader.skip(wire);
				break;
			case 11:
				if (wire === WIRE_VARINT) hasM = reader.readBool();
				else reader.skip(wire);
				break;
			case 12:
				if (wire === WIRE_LENGTH_DELIMITED) {
					const len = reader.readVarint();
					transform = decodeTransform(reader.subReader(len));
				} else reader.skip(wire);
				break;
			case 13:
				if (wire === WIRE_LENGTH_DELIMITED) {
					const len = reader.readVarint();
					fields.push(decodeField(reader.subReader(len)));
				} else reader.skip(wire);
				break;
			case 15:
				if (wire === WIRE_LENGTH_DELIMITED) {
					const len = reader.readVarint();
					featureReaders.push(reader.subReader(len));
				} else reader.skip(wire);
				break;
			default: reader.skip(wire);
		}
	}
	if (hasZ || hasM) throw new PbfDecodeError(`PBF response carries ${hasZ ? "Z" : ""}${hasZ && hasM ? "/" : ""}${hasM ? "M" : ""} geometry; falling back to f=json`);
	const features = featureReaders.map((fr) => decodeFeature(fr, fields, transform, geometryType));
	const result = {
		objectIdFieldName,
		fields: fields.map((f) => ({
			name: f.name,
			type: mapPbfFieldTypeToGeoServices(f.fieldType),
			alias: f.alias
		})),
		features
	};
	if (geometryType && geometryType !== "esriGeometryNull") result.geometryType = geometryType;
	if (spatialReference) result.spatialReference = spatialReference;
	if (hasZ) result.hasZ = true;
	if (hasM) result.hasM = true;
	if (exceededTransferLimit) result.exceededTransferLimit = true;
	return result;
}
function mapPbfFieldTypeToGeoServices(fieldType) {
	switch (fieldType) {
		case 0: return "esriFieldTypeSmallInteger";
		case 1: return "esriFieldTypeInteger";
		case 2: return "esriFieldTypeSingle";
		case 3: return "esriFieldTypeDouble";
		case 4: return "esriFieldTypeString";
		case 5: return "esriFieldTypeDate";
		case 6: return "esriFieldTypeOID";
		case 7: return "esriFieldTypeGeometry";
		case 8: return "esriFieldTypeBlob";
		case 10: return "esriFieldTypeGUID";
		case 11: return "esriFieldTypeGlobalID";
		case 12: return "esriFieldTypeXML";
		case 13: return "esriFieldTypeBigInteger";
		default: return "esriFieldTypeString";
	}
}
/**
* Decode an Esri FeatureCollectionPBuffer response into a JSON-compatible
* query response object.
*
* The returned object has the same shape as an `f=json` response:
* `{ objectIdFieldName, geometryType, spatialReference, fields, features, ... }`
*
* @param buffer - The raw PBF bytes from a `f=pbf` response.
* @returns A JSON-compatible query response object.
*/
function decodePbfQueryResponse(buffer) {
	const reader = new PbfReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
	let queryResult = {};
	while (reader.pos < reader.end) {
		const [field, wire] = reader.readTag();
		if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			reader.pos += len;
		} else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
			const len = reader.readVarint();
			const qrReader = reader.subReader(len);
			while (qrReader.pos < qrReader.end) {
				const [qrField, qrWire] = qrReader.readTag();
				if (qrField === 1 && qrWire === WIRE_LENGTH_DELIMITED) {
					const frLen = qrReader.readVarint();
					queryResult = decodeFeatureResult(qrReader.subReader(frLen));
				} else qrReader.skip(qrWire);
			}
		} else reader.skip(wire);
	}
	return queryResult;
}
/**
* Check whether a Response has a protobuf content type.
*/
function isPbfResponse(response) {
	const ct = response.headers.get("content-type") ?? "";
	return ct.includes("application/x-protobuf") || ct.includes("application/protobuf");
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/process-runner.js
var HonuaProcessRunner = class {
	adapter;
	constructor(adapter) {
		this.adapter = adapter;
	}
	get protocol() {
		return this.adapter.protocol;
	}
	execute(request) {
		return this.adapter.execute(request);
	}
	job(jobId, options = {}) {
		return this.adapter.job(jobId, options);
	}
	async validate(request) {
		if (!this.adapter.validate) throw new Error(`${this.protocol} does not expose validate through the unified process runner.`);
		return this.adapter.validate(request);
	}
	async dryRun(request) {
		if (!this.adapter.dryRun) throw new Error(`${this.protocol} does not expose dryRun through the unified process runner.`);
		return this.adapter.dryRun(request);
	}
};
function createHonuaProcessRunner(adapter) {
	return new HonuaProcessRunner(adapter);
}
function createOgcProcessesAdapter(processes) {
	return {
		protocol: "ogc-processes",
		execute(request) {
			if (!request.processId) throw new Error("OGC Processes execution requires processId.");
			return processes.execute({
				processId: request.processId,
				inputs: request.inputs,
				outputs: request.outputs,
				mode: request.mode ?? "async",
				signal: request.signal,
				...request.jobControlOptions !== void 0 ? { jobControlOptions: request.jobControlOptions } : {}
			});
		},
		job(jobId, options = {}) {
			return processes.job(jobId, { processId: options.processId });
		}
	};
}
function createGeoServicesGpAdapter(service) {
	return {
		protocol: "geoservices-gp",
		execute(request) {
			return service.submit({
				parameters: request.parameters ?? request.inputs ?? {},
				signal: request.signal
			}, { resultNames: request.resultNames });
		},
		job(jobId, options = {}) {
			return service.job(jobId, { resultNames: options.resultNames });
		}
	};
}
function createGeospatialGrpcProcessAdapter(client) {
	return {
		protocol: "geospatial-grpc",
		validate(request) {
			if (!client.validatePlan) throw new Error("geospatial-grpc ProcessService client does not expose validatePlan.");
			return client.validatePlan({ plan: requirePlan(request) });
		},
		dryRun(request) {
			if (!client.dryRunPlan) throw new Error("geospatial-grpc ProcessService client does not expose dryRunPlan.");
			return client.dryRunPlan({ plan: requirePlan(request) });
		},
		async execute(request) {
			return new GeospatialGrpcProcessJobRun({
				client,
				accepted: await client.submitJob({
					plan: requirePlan(request),
					context: request.context
				})
			});
		},
		job(jobId) {
			return new GeospatialGrpcProcessJobRun({
				client,
				accepted: {
					jobId,
					state: "JOB_STATE_UNSPECIFIED"
				}
			});
		}
	};
}
var GeospatialGrpcProcessJobRun = class {
	id;
	type = "geospatial-grpc";
	client;
	lifecycle;
	constructor(options) {
		this.client = options.client;
		this.id = readJobId(options.accepted);
		this.lifecycle = new JobRunLifecycle({
			id: this.id,
			initialStatus: geospatialGrpcJobStateToStatus(options.accepted.state),
			pollIntervalMs: 1e3,
			poll: async (signal) => this.translateJob(await this.client.getJob({
				jobId: this.id,
				signal
			}))
		});
	}
	get status() {
		return this.lifecycle.status;
	}
	get progress() {
		return this.lifecycle.progress;
	}
	async poll() {
		return this.lifecycle.poll();
	}
	watch(listener) {
		return this.lifecycle.watch(listener);
	}
	async results(options = {}) {
		return this.lifecycle.results(options);
	}
	async cancel() {
		return this.lifecycle.cancel(async () => this.translateJob(await this.client.cancelJob({ jobId: this.id })));
	}
	async translateJob(response) {
		const jobProgress = "progress" in response ? response.progress : void 0;
		const status = geospatialGrpcJobStateToStatus(response.state ?? jobProgress?.state);
		const progress = geospatialGrpcProgress(jobProgress);
		if (status === "successful") return geospatialGrpcResultSnapshot(await this.client.getJobResult({ jobId: this.id }), progress);
		if (status === "failed" || status === "dismissed") {
			const result = await this.safeGetTerminalResult();
			const error = result ? geospatialGrpcError(result) : void 0;
			return {
				status,
				progress,
				...error ? { error } : {}
			};
		}
		return {
			status,
			progress
		};
	}
	async safeGetTerminalResult() {
		try {
			return await this.client.getJobResult({ jobId: this.id });
		} catch {
			return;
		}
	}
};
function requirePlan(request) {
	if (request.plan === void 0) throw new Error("geospatial-grpc process execution requires plan.");
	return request.plan;
}
function readJobId(response) {
	const jobId = response.jobId ?? response.job_id;
	if (!jobId) throw new Error("ProcessService response did not include jobId.");
	return jobId;
}
function geospatialGrpcJobStateToStatus(value) {
	if (value === 6) return "successful";
	if (value === 7) return "failed";
	if (value === 8) return "dismissed";
	if (value === 5) return "running";
	if (value === 1 || value === 2 || value === 3 || value === 4) return "accepted";
	const normalized = String(value ?? "").toLowerCase();
	if (normalized.includes("completed") || normalized === "successful") return "successful";
	if (normalized.includes("failed")) return "failed";
	if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("dismissed")) return "dismissed";
	if (normalized.includes("draft") || normalized.includes("clarification") || normalized.includes("validated") || normalized.includes("approval") || normalized.includes("accepted")) return "accepted";
	if (normalized.includes("running")) return "running";
	return "accepted";
}
function geospatialGrpcProgress(progress) {
	if (!progress) return void 0;
	const percent = progress.progressPercent ?? progress.progress_percent;
	const updatedAt = progress.updatedAt ?? progress.updated_at;
	const out = {};
	if (typeof percent === "number" && Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, percent));
	if (progress.message) out.message = progress.message;
	if (updatedAt !== void 0) out.updatedAt = timestampToIso(updatedAt);
	return out.percent === void 0 && out.message === void 0 && out.updatedAt === void 0 ? void 0 : out;
}
function geospatialGrpcResultSnapshot(response, progress) {
	const error = geospatialGrpcError(response);
	if (error) return {
		status: "failed",
		progress,
		error
	};
	return {
		status: "successful",
		progress,
		result: { outputs: { result: response.result ?? response.outcome?.value ?? response } }
	};
}
function geospatialGrpcError(response) {
	const candidate = response.error ?? (response.outcome?.case === "error" ? response.outcome.value : void 0);
	if (!candidate) return void 0;
	return {
		code: candidate.errorCode ?? candidate.error_code ?? "GeospatialGrpcProcessError",
		message: candidate.message ?? "geospatial-grpc process execution failed.",
		details: candidate.details
	};
}
function timestampToIso(value) {
	const numeric = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
	if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
	return String(value);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/request-pipeline.js
var DEFAULT_RETRY_STATUSES = new Set([
	429,
	502,
	503,
	504
]);
var DEFAULT_RETRY_METHODS = new Set([
	"GET",
	"HEAD",
	"PUT",
	"DELETE"
]);
function normalizeTimeoutMs(timeoutMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return;
	return Math.max(1, Math.trunc(timeoutMs));
}
function normalizeRetryOptions(options) {
	if (!options) return;
	const maxRetries = typeof options.maxRetries === "number" && Number.isFinite(options.maxRetries) ? Math.max(0, Math.trunc(options.maxRetries)) : 0;
	if (maxRetries < 1) return;
	const baseDelayMs = typeof options.baseDelayMs === "number" && Number.isFinite(options.baseDelayMs) ? Math.max(1, Math.trunc(options.baseDelayMs)) : 100;
	const maxDelayMs = typeof options.maxDelayMs === "number" && Number.isFinite(options.maxDelayMs) ? Math.max(baseDelayMs, Math.trunc(options.maxDelayMs)) : 2e3;
	const retryStatuses = new Set((options.retryStatuses ?? Array.from(DEFAULT_RETRY_STATUSES)).map((status) => Math.trunc(status)).filter((status) => Number.isFinite(status) && status >= 100 && status <= 599));
	if (retryStatuses.size === 0) for (const status of DEFAULT_RETRY_STATUSES) retryStatuses.add(status);
	return {
		maxRetries,
		baseDelayMs,
		maxDelayMs,
		retryStatuses
	};
}
/**
* Parse a `Retry-After` header value (delta-seconds or HTTP-date) into a delay
* in milliseconds. Shared by the REST {@link parseRetryAfterMs} response helper
* and the gRPC-web path, which reads the same header off the Connect error
* metadata (a `Headers`-shaped object) rather than a `Response`.
*/
function parseRetryAfterHeaderMs(headers) {
	const value = headers.get("retry-after");
	if (!value) return;
	const seconds = Number.parseInt(value, 10);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
	const targetTime = Date.parse(value);
	if (!Number.isFinite(targetTime)) return;
	return Math.max(0, targetTime - Date.now());
}
function parseRetryAfterMs(response) {
	return parseRetryAfterHeaderMs(response.headers);
}
/**
* Decide whether a failed attempt should be retried. Idempotent/replay-safe
* methods (GET/PUT/DELETE) are retried on the configured retry statuses or on
* transient network/timeout errors; aborts are never retried.
*/
function shouldRetryRequest(retryOptions, method, attempt, statusCode, error) {
	if (!retryOptions || attempt >= retryOptions.maxRetries) return false;
	if (!DEFAULT_RETRY_METHODS.has(method)) return false;
	if (error instanceof HonuaAbortError) return false;
	if (statusCode !== void 0) return retryOptions.retryStatuses.has(statusCode);
	return error instanceof HonuaNetworkError || error instanceof HonuaTimeoutError;
}
/**
* Resolve the backoff delay before the next attempt. A server `Retry-After`
* header (capped by `maxDelayMs`) wins; otherwise an exponential backoff with
* full jitter in the [0.5x, 1x] band is used.
*/
function resolveRetryDelayMs(retryOptions, attempt, response) {
	const retryAfterMs = response ? parseRetryAfterMs(response) : void 0;
	if (retryAfterMs !== void 0) return Math.min(retryOptions?.maxDelayMs ?? retryAfterMs, retryAfterMs);
	if (!retryOptions) return 0;
	const exponentialDelay = retryOptions.baseDelayMs * 2 ** attempt;
	return Math.min(retryOptions.maxDelayMs, exponentialDelay) * (.5 + Math.random() * .5);
}
/**
* gRPC/Connect numeric status codes that map to the transient REST retry
* statuses in {@link DEFAULT_RETRY_STATUSES}, so the grpc-web transport retries
* the same class of transient failures as REST. Mirrors the gRPC retry
* conventions: `resource_exhausted` (~429), `unavailable` (~502/503),
* `deadline_exceeded` (~504), and the transient `aborted` concurrency code.
*/
var DEFAULT_RETRYABLE_GRPC_CODES = new Set([
	4,
	8,
	10,
	14
]);
/** Connect/gRPC `canceled` code — caller/abort-driven, never retried. */
var GRPC_CODE_CANCELED = 1;
/**
* Extract the numeric gRPC/Connect status code off a thrown error (a
* `ConnectError` carries a numeric `code`). Returns `undefined` for non-Connect
* errors so callers can treat them as non-retryable.
*/
function connectErrorCode(error) {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "number") return error.code;
}
/**
* Decide whether a failed gRPC-web call should be retried. Mirrors
* {@link shouldRetryRequest} for the Connect transport: retries only the
* transient {@link DEFAULT_RETRYABLE_GRPC_CODES} while honoring `maxRetries`,
* and never retries once the call's abort signal has fired (caller abort or the
* `timeoutMs` deadline) or for the `canceled` code.
*
* Replay-safety (unary-only, since server-streaming responses cannot be safely
* replayed mid-iteration) is enforced by the caller, mirroring the REST
* {@link DEFAULT_RETRY_METHODS} idempotency gate.
*/
function shouldRetryGrpcCall(retryOptions, attempt, error, aborted) {
	if (!retryOptions || attempt >= retryOptions.maxRetries) return false;
	if (aborted) return false;
	const code = connectErrorCode(error);
	if (code === void 0 || code === GRPC_CODE_CANCELED) return false;
	return DEFAULT_RETRYABLE_GRPC_CODES.has(code);
}
function connectErrorMetadata(error) {
	if (typeof error === "object" && error !== null && "metadata" in error) {
		const metadata = error.metadata;
		if (metadata && typeof metadata.get === "function") return metadata;
	}
}
/**
* Resolve the backoff delay before the next gRPC-web attempt. Reuses the shared
* {@link resolveRetryDelayMs} exponential-with-jitter math; a `retry-after`
* value carried on the Connect error metadata (capped by `maxDelayMs`) wins,
* mirroring the REST `Retry-After` handling.
*/
function resolveGrpcRetryDelayMs(retryOptions, attempt, error) {
	const metadata = connectErrorMetadata(error);
	const retryAfterMs = metadata ? parseRetryAfterHeaderMs(metadata) : void 0;
	if (retryAfterMs !== void 0) return Math.min(retryOptions?.maxDelayMs ?? retryAfterMs, retryAfterMs);
	return resolveRetryDelayMs(retryOptions, attempt);
}
async function sleep(ms, signal) {
	if (ms <= 0) return;
	if (signal?.aborted) throw new HonuaAbortError();
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(new HonuaAbortError());
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}
function normalizeNetworkError(error) {
	if (error instanceof Error && error.name === "AbortError") return new HonuaAbortError();
	if (error instanceof Error) return new HonuaNetworkError(error.message, error);
	return new HonuaNetworkError(String(error), error);
}
function createTimeoutSignal(existingSignal, timeoutMs) {
	if (timeoutMs === void 0) return {
		signal: existingSignal ?? void 0,
		didTimeout: false,
		dispose: () => void 0
	};
	const controller = new AbortController();
	let didTimeout = false;
	let timer;
	let onAbort;
	timer = setTimeout(() => {
		didTimeout = true;
		controller.abort();
	}, timeoutMs);
	if (existingSignal) if (existingSignal.aborted) controller.abort();
	else {
		onAbort = () => {
			controller.abort();
		};
		existingSignal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		get didTimeout() {
			return didTimeout;
		},
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
				timer = void 0;
			}
			if (existingSignal && onAbort) {
				existingSignal.removeEventListener("abort", onAbort);
				onAbort = void 0;
			}
		}
	};
}
/**
* Map a non-OK HTTP response body into a {@link HonuaHttpError}, preferring the
* server's structured error message (`error.message`, `message`, or `detail`)
* and falling back to a generic message while preserving the raw body.
*/
function toHttpError(statusCode, body) {
	const fallback = "Request failed";
	if (isObject$2(body)) {
		const error = body.error;
		if (isObject$2(error) && typeof error.message === "string") return new HonuaHttpError(statusCode, error.message, body);
		if (typeof body.message === "string") return new HonuaHttpError(statusCode, body.message, body);
		if (typeof body.detail === "string") return new HonuaHttpError(statusCode, body.detail, body);
	}
	return new HonuaHttpError(statusCode, fallback, body);
}
function isObject$2(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/stac.js
/**
* STAC API search surface. STAC builds on OGC API Features, so this
* class wraps the STAC catalog landing, collections listing, items, and
* cross-collection search endpoints. The wire calls live on
* `HonuaClient`; this class is the request-shaping layer on top.
*
* @module
*/
var DEFAULT_STAC_PAGE_SIZE = 100;
var DEFAULT_STAC_MAX_PAGES = 100;
/**
* STAC API entry point. Discovery (`landing`, `collections`,
* `collection`) plus search (`search`, `searchAll`, `searchStream`) and
* item fetch.
*/
var HonuaStacSearch = class {
	client;
	basePath;
	postSearchProbe;
	postSearchSupported;
	/**
	* Verified state of the POST search path: `undefined` until the first POST
	* attempt, `true` once one succeeded, `false` once one failed (a wrong
	* advertisement, a proxy that refuses non-GET, a blocked CORS preflight, or
	* a read-only fetch seam).
	*/
	postSearchUsable;
	constructor(options) {
		this.client = options.client;
		this.basePath = options.basePath;
	}
	/** Inject the configured STAC base path unless the caller already set one. */
	withBase(request) {
		if (this.basePath === void 0 || request.stacBasePath !== void 0) return request;
		return {
			...request,
			stacBasePath: this.basePath
		};
	}
	async landing(request = {}) {
		return this.client.getStacLanding(this.withBase(request));
	}
	async collections(request = {}) {
		return this.client.listStacCollections(this.withBase(request));
	}
	async collection(request) {
		return this.client.getStacCollection(this.withBase(request));
	}
	async item(request) {
		return this.client.getStacItem(this.withBase(request));
	}
	async search(request = {}) {
		return this.dispatchSearch(request);
	}
	/**
	* Issue one search, verifying an advertised POST path before trusting it.
	* `usePost` reflects what the landing page claims; the first attempt is the
	* proof. If it fails, the same search is replayed once as `GET /search` and
	* the instance stays on GET — an advertisement is not a guarantee, and a
	* search that works over GET must not fail because a proxy, a CORS policy,
	* or a read-only fetch seam refuses POST. Once a POST search has succeeded,
	* later failures (including mid-drain pages) surface to the caller.
	*/
	async dispatchSearch(request) {
		const wire = this.withBase(request);
		if (wire.usePost !== true) return this.client.searchStac(wire);
		const allowPostFallback = request.allowPostFallback !== false;
		if (this.postSearchUsable === false && allowPostFallback) return this.client.searchStac({
			...wire,
			usePost: false
		});
		try {
			const response = await this.client.searchStac(wire);
			this.postSearchUsable = true;
			return response;
		} catch (error) {
			if (!allowPostFallback || this.postSearchUsable !== void 0 || request.signal?.aborted === true) throw error;
			this.postSearchUsable = false;
			return this.client.searchStac({
				...wire,
				usePost: false
			});
		}
	}
	/**
	* Whether the API advertises `POST /search`.
	*
	* STAC API - Item Search requires `GET /search` and makes `POST` optional,
	* so the POST support has to be discovered rather than assumed: servers
	* list the endpoint on the landing page as a `rel="search"` link per
	* method (stac-fastapi / pgstac and stac-server emit both a `GET` and a
	* `POST` link). The probe runs at most once per instance and resolves to
	* `false` when the landing page is unreachable or advertises no POST
	* search link, so callers fall back to the universally supported `GET`.
	*/
	async supportsPostSearch(signal) {
		if (this.postSearchSupported !== void 0) return this.postSearchSupported;
		if (signal) {
			const supported = await this.probePostSearch(signal);
			this.postSearchSupported = supported;
			return supported;
		}
		this.postSearchProbe ??= this.probePostSearch();
		const supported = await this.postSearchProbe;
		this.postSearchSupported = supported;
		return supported;
	}
	async probePostSearch(signal) {
		try {
			const landing = await this.landing({ signal });
			for (const link of landing.links ?? []) {
				if (link.rel !== "search") continue;
				if (typeof link.method === "string" && link.method.toUpperCase() === "POST") return true;
			}
			return false;
		} catch (error) {
			if (signal?.aborted) throw error;
			return false;
		}
	}
	async searchAll(request = {}) {
		const pageSize = request.pageSize ?? request.limit ?? DEFAULT_STAC_PAGE_SIZE;
		const maxPages = request.maxPages ?? DEFAULT_STAC_MAX_PAGES;
		const items = [];
		let cursor = {
			offset: request.offset,
			next: request.next
		};
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.dispatchSearch({
				...request,
				limit: pageSize,
				...cursorRequest(cursor)
			});
			const pageItems = response.features ?? [];
			if (pageItems.length === 0) break;
			items.push(...pageItems);
			const advanced = nextStacCursor(response.links);
			if (!hasStacCursor(advanced) || stacCursorKey(advanced) === stacCursorKey(cursor)) break;
			cursor = advanced;
		}
		return items;
	}
	async *searchStream(request = {}) {
		const pageSize = request.pageSize ?? request.limit ?? DEFAULT_STAC_PAGE_SIZE;
		const maxPages = request.maxPages ?? DEFAULT_STAC_MAX_PAGES;
		let cursor = {
			offset: request.offset,
			next: request.next
		};
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.dispatchSearch({
				...request,
				limit: pageSize,
				...cursorRequest(cursor)
			});
			const pageItems = response.features ?? [];
			if (pageItems.length === 0) break;
			yield pageItems;
			const advanced = nextStacCursor(response.links);
			if (!hasStacCursor(advanced) || stacCursorKey(advanced) === stacCursorKey(cursor)) break;
			cursor = advanced;
		}
	}
};
/** Project a page cursor onto the paging members of a search request. */
function cursorRequest(cursor) {
	return {
		offset: cursor.offset,
		next: cursor.next,
		nextParams: cursor.params,
		nextBody: cursor.body
	};
}
function hasStacCursor(cursor) {
	return cursor.offset !== void 0 || cursor.next !== void 0 || cursor.params !== void 0 || cursor.body !== void 0;
}
/**
* Stable identity for a page cursor. A server that keeps advertising the
* same `rel=next` link (or one whose href carries no cursor at all) would
* otherwise re-request the same page until `maxPages`, duplicating items.
*/
function stacCursorKey(cursor) {
	return JSON.stringify([
		cursor.offset ?? null,
		cursor.next ?? null,
		cursor.params ?? null,
		cursor.body ?? null
	]);
}
/**
* Resolve the next-page cursor for STAC paging. honua-server emits a
* `rel=next` link with `?offset=N` on the href and some servers emit a
* `?next=…` token; both are honored as named cursors. Everything else is
* followed opaquely: a POST `rel=next` link carries its cursor in `body`
* (`{"method":"POST","body":{"token":"next:…"},"merge":true}` — the pgstac /
* stac-fastapi shape) and a GET link carries it on the href query string
* under a server-chosen name (`token`, `page`, `cursor`, …), so the whole
* query string is replayed rather than guessing the parameter name. When
* the server omits a usable `rel=next` link, return an empty cursor so the
* caller stops.
*/
function nextStacCursor(links) {
	if (!links) return {};
	for (const link of links) {
		if (link.rel !== "next") continue;
		const body = link.body;
		if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0) return { body: { ...body } };
		if (typeof link.href !== "string") continue;
		try {
			const url = new URL(link.href, "https://placeholder.test");
			const offsetParam = url.searchParams.get("offset");
			if (offsetParam !== null) {
				const offset = Number(offsetParam);
				if (Number.isFinite(offset)) return { offset };
			}
			const nextParam = url.searchParams.get("next");
			if (nextParam !== null) return { next: nextParam };
			const params = {};
			for (const [key, value] of url.searchParams) params[key] = value;
			if (Object.keys(params).length > 0) return { params };
		} catch {}
	}
	return {};
}
/**
* Path prefix the STAC endpoints are mounted under. Defaults to `/stac`
* (the Honua Server facade). Backend-agnostic callers pointing at a raw
* STAC API root pass `""` so the paths resolve directly under the client
* baseUrl (e.g. Earth Search served at `.../v1`).
*/
function stacBase(request) {
	const base = request.stacBasePath;
	if (base === void 0) return "/stac";
	let end = base.length;
	while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
	return base.slice(0, end);
}
async function getStacLanding(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = stacBase(request);
	return transport.requestCachedMetadataJson(`stac:landing:${base}:${params.toString()}`, `${base}?${params.toString()}`, request);
}
async function listStacCollections(transport, request = {}) {
	const params = createOgcMetadataParams(request);
	const base = stacBase(request);
	return transport.requestCachedMetadataJson(`stac:collections:${base}:${params.toString()}`, `${base}/collections?${params.toString()}`, request);
}
async function getStacCollection(transport, request) {
	const params = createOgcMetadataParams(request);
	const base = stacBase(request);
	return transport.requestCachedMetadataJson(`stac:collection:${base}:${request.collectionId}:${params.toString()}`, `${base}/collections/${encodeURIComponent(String(request.collectionId))}?${params.toString()}`, request);
}
async function getStacItem(transport, request) {
	const params = createOgcMetadataParams(request);
	const path = `${stacBase(request)}/collections/${encodeURIComponent(String(request.collectionId))}/items/${encodeURIComponent(String(request.itemId))}`;
	return transport.requestJson("GET", `${path}?${params.toString()}`, void 0, request.signal);
}
async function searchStac(transport, request = {}) {
	const base = stacBase(request);
	if (request.usePost) {
		const query = request.nextParams === void 0 ? "" : `?${new URLSearchParams({ ...request.nextParams }).toString()}`;
		return transport.requestJson("POST", `${base}/search${query}`, {
			headers: mergeHeaders({
				"Content-Type": "application/json",
				Accept: "application/json"
			}),
			body: JSON.stringify(stacSearchBody(request))
		}, request.signal);
	}
	const params = serializeStacSearchParams(request);
	return transport.requestJson("GET", `${base}/search?${params.toString()}`, void 0, request.signal);
}
function serializeStacSearchParams(request) {
	const params = new URLSearchParams();
	if (request.bbox !== void 0) params.set("bbox", request.bbox.join(","));
	if (request.datetime !== void 0) params.set("datetime", request.datetime);
	if (request.ids !== void 0 && request.ids.length > 0) params.set("ids", request.ids.join(","));
	if (request.collections !== void 0 && request.collections.length > 0) params.set("collections", request.collections.join(","));
	if (request.intersects !== void 0) params.set("intersects", JSON.stringify(request.intersects));
	const fields = stacFieldsCsv(request.fields);
	if (fields !== void 0) params.set("fields", fields);
	if (request.filter !== void 0) params.set("filter", typeof request.filter === "string" ? request.filter : JSON.stringify(request.filter));
	if (request.filterLang !== void 0) params.set("filter-lang", request.filterLang);
	if (request.limit !== void 0) params.set("limit", String(request.limit));
	if (request.offset !== void 0) params.set("offset", String(request.offset));
	if (request.next !== void 0) params.set("next", request.next);
	if (request.sortby !== void 0) params.set("sortby", typeof request.sortby === "string" ? request.sortby : request.sortby.map((sort) => `${sort.direction === "desc" ? "-" : "+"}${sort.field}`).join(","));
	if (request.nextParams !== void 0) for (const [key, value] of Object.entries(request.nextParams)) params.set(key, value);
	return params;
}
function stacSearchBody(request) {
	const out = {};
	if (request.bbox !== void 0) out.bbox = request.bbox;
	if (request.datetime !== void 0) out.datetime = request.datetime;
	if (request.intersects !== void 0) out.intersects = request.intersects;
	if (request.ids !== void 0) out.ids = request.ids;
	if (request.collections !== void 0) out.collections = request.collections;
	if (request.filter !== void 0) out.filter = request.filter;
	if (request.filterLang !== void 0) out["filter-lang"] = request.filterLang;
	if (request.limit !== void 0) out.limit = request.limit;
	if (request.offset !== void 0) out.offset = request.offset;
	if (request.next !== void 0) out.next = request.next;
	if (request.sortby !== void 0) out.sortby = request.sortby;
	if (request.fields !== void 0) out.fields = request.fields;
	if (request.nextBody !== void 0) Object.assign(out, request.nextBody);
	return out;
}
function stacFieldsCsv(fields) {
	if (!fields) return void 0;
	const parts = [];
	if (fields.include) {
		for (const f of fields.include) if (typeof f === "string" && f.length > 0) parts.push(f);
	}
	if (fields.exclude) {
		for (const f of fields.exclude) if (typeof f === "string" && f.length > 0) parts.push(`-${f}`);
	}
	return parts.length > 0 ? parts.join(",") : void 0;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/contract/spatial-aggregation.js
/**
* Protocol-neutral request and response shapes for indexed spatial aggregation.
*
* This module is intentionally a contract surface only. It describes the
* request envelope SDKs send to a backend that can aggregate into indexed
* cells, and the response metadata apps need to build widgets and load
* progressively. The index model id is opaque so callers can work with H3,
* Quadbin, WebMercatorQuad, or a provider-specific grid without switching on
* one implementation.
*
* @module
*/
var SPATIAL_AGGREGATION_SCHEMA_VERSION = "honua.spatial-aggregation.v1";
var SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION = "honua.spatial-aggregation.metadata.v1";
function spatialAggregationSummaryKindRequiresField(kind) {
	return kind !== "count";
}
function validateSpatialAggregationRequest(request) {
	const issues = [];
	if (!isNonEmptyString(request.sourceId)) issues.push({
		path: "sourceId",
		message: "sourceId is required"
	});
	if (request.summaries.length === 0) issues.push({
		path: "summaries",
		message: "at least one summary is required"
	});
	const summaryIds = /* @__PURE__ */ new Set();
	request.summaries.forEach((summary, index) => {
		const path = `summaries[${index}]`;
		if (!isNonEmptyString(summary.id)) issues.push({
			path: `${path}.id`,
			message: "summary id is required"
		});
		else if (summaryIds.has(summary.id)) issues.push({
			path: `${path}.id`,
			message: `duplicate summary id "${summary.id}"`
		});
		else summaryIds.add(summary.id);
		if (spatialAggregationSummaryKindRequiresField(summary.kind) && !isNonEmptyString(summary.field)) issues.push({
			path: `${path}.field`,
			message: `${summary.kind} summaries require a field`
		});
		if (summary.kind === "histogram") {
			if (summary.bins !== void 0 && !isPositiveInteger(summary.bins)) issues.push({
				path: `${path}.bins`,
				message: "histogram bins must be a positive integer"
			});
			if (summary.min !== void 0 && summary.max !== void 0 && summary.min >= summary.max) issues.push({
				path: `${path}.max`,
				message: "histogram max must be greater than min"
			});
		}
		if (summary.kind === "range") {
			if (summary.ranges.length === 0) issues.push({
				path: `${path}.ranges`,
				message: "range summaries require at least one range"
			});
			summary.ranges.forEach((range, rangeIndex) => {
				if (!isNonEmptyString(range.id)) issues.push({
					path: `${path}.ranges[${rangeIndex}].id`,
					message: "range id is required"
				});
				if (range.min !== void 0 && range.max !== void 0 && range.min >= range.max) issues.push({
					path: `${path}.ranges[${rangeIndex}].max`,
					message: "range max must be greater than min"
				});
			});
		}
	});
	request.groupBy?.forEach((group, index) => {
		if (!isNonEmptyString(group.field)) issues.push({
			path: `groupBy[${index}].field`,
			message: "group field is required"
		});
		if (group.limit !== void 0 && !isPositiveInteger(group.limit)) issues.push({
			path: `groupBy[${index}].limit`,
			message: "group limit must be a positive integer"
		});
	});
	const viewport = request.viewport;
	if (viewport) {
		if (viewport.zoom !== void 0 && !isNonNegativeFinite(viewport.zoom)) issues.push({
			path: "viewport.zoom",
			message: "viewport zoom must be a non-negative number"
		});
		if (viewport.width !== void 0 && !isPositiveFinite(viewport.width)) issues.push({
			path: "viewport.width",
			message: "viewport width must be greater than zero"
		});
		if (viewport.height !== void 0 && !isPositiveFinite(viewport.height)) issues.push({
			path: "viewport.height",
			message: "viewport height must be greater than zero"
		});
	}
	const resolution = request.resolution;
	if (resolution) {
		if (resolution.zoom !== void 0 && !isNonNegativeFinite(resolution.zoom)) issues.push({
			path: "resolution.zoom",
			message: "resolution zoom must be a non-negative number"
		});
		if (resolution.indexResolution !== void 0 && !isNonNegativeFinite(resolution.indexResolution)) issues.push({
			path: "resolution.indexResolution",
			message: "index resolution must be a non-negative number"
		});
		if (resolution.targetCellCount !== void 0 && !isPositiveInteger(resolution.targetCellCount)) issues.push({
			path: "resolution.targetCellCount",
			message: "target cell count must be a positive integer"
		});
		if (resolution.maxCellCount !== void 0 && !isPositiveInteger(resolution.maxCellCount)) issues.push({
			path: "resolution.maxCellCount",
			message: "max cell count must be a positive integer"
		});
	}
	if (request.page?.limit !== void 0 && !isPositiveInteger(request.page.limit)) issues.push({
		path: "page.limit",
		message: "page limit must be a positive integer"
	});
	return issues;
}
function spatialAggregationSummaryKindSupportedByFeatureServerH3(kind) {
	return kind === "count" || kind === "sum" || kind === "avg" || kind === "min" || kind === "max";
}
function validateFeatureServerH3SpatialAggregationRequest(request) {
	const issues = [...validateSpatialAggregationRequest(request)];
	const indexResolution = request.resolution?.indexResolution;
	if (indexResolution === void 0) issues.push({
		path: "resolution.indexResolution",
		message: "FeatureServer queryH3 requires an explicit indexResolution"
	});
	else if (!Number.isInteger(indexResolution) || indexResolution < 0 || indexResolution > 15) issues.push({
		path: "resolution.indexResolution",
		message: "FeatureServer queryH3 indexResolution must be an integer between 0 and 15"
	});
	if (request.index?.modelId !== void 0 && request.index.modelId !== "h3") issues.push({
		path: "index.modelId",
		message: "FeatureServer queryH3 only supports the H3 index model"
	});
	if (request.index?.geometry === "centroid") issues.push({
		path: "index.geometry",
		message: "FeatureServer queryH3 does not currently return cell centroids"
	});
	if (request.spatialFilter !== void 0) issues.push({
		path: "spatialFilter",
		message: "FeatureServer queryH3 does not currently accept spatialFilter input"
	});
	if (request.viewport !== void 0) issues.push({
		path: "viewport",
		message: "FeatureServer queryH3 does not currently accept viewport input"
	});
	if (request.groupBy !== void 0 && request.groupBy.length > 0) issues.push({
		path: "groupBy",
		message: "FeatureServer queryH3 does not currently support grouped summaries"
	});
	if (request.page !== void 0) issues.push({
		path: "page",
		message: "FeatureServer queryH3 does not currently support cursor paging"
	});
	const metricSummaries = request.summaries.filter((summary) => spatialAggregationSummaryKindSupportedByFeatureServerH3(summary.kind));
	request.summaries.forEach((summary, index) => {
		const path = `summaries[${index}]`;
		if (!spatialAggregationSummaryKindSupportedByFeatureServerH3(summary.kind)) {
			issues.push({
				path: `${path}.kind`,
				message: `${summary.kind} summaries are not supported by FeatureServer queryH3`
			});
			return;
		}
		if (summary.kind === "count" && summary.countDistinct === true) issues.push({
			path: `${path}.countDistinct`,
			message: "FeatureServer queryH3 does not currently support countDistinct summaries"
		});
		if (summary.kind === "count" && summary.field === void 0 && metricSummaries.length > 1) issues.push({
			path: `${path}.field`,
			message: "count summaries require a field when combined with other queryH3 metrics"
		});
	});
	return issues;
}
function assertFeatureServerH3SpatialAggregationRequest(request) {
	const issues = validateFeatureServerH3SpatialAggregationRequest(request);
	if (issues.length > 0) {
		const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
		throw new Error(`Invalid FeatureServer queryH3 spatial aggregation request: ${details}`);
	}
}
function spatialAggregationWidgets(input) {
	const metadata = "metadata" in input ? input.metadata : input;
	if (metadata.widgets && metadata.widgets.length > 0) return metadata.widgets;
	const widgets = metadata.summaries.map(summaryToWidget);
	if (metadata.groupBy && metadata.groupBy.length > 0) widgets.push({
		id: "grouped-summaries",
		kind: "grouped-table",
		title: "Grouped summaries",
		summaryIds: metadata.summaries.map((summary) => summary.id),
		groupBy: metadata.groupBy.map((group) => group.alias ?? group.field),
		interactions: ["filter", "drilldown"],
		progressive: {
			stableAcrossPages: false,
			partialValueSemantics: "refine"
		}
	});
	return widgets;
}
function summaryToWidget(summary) {
	return {
		id: `${summary.id}-widget`,
		kind: widgetKindForSummary(summary.kind),
		title: summary.title,
		summaryId: summary.id,
		field: summary.field,
		valueType: summary.valueType,
		unit: summary.unit,
		interactions: summary.kind === "count" ? ["highlight"] : ["filter", "highlight"],
		progressive: {
			stableAcrossPages: summary.kind !== "histogram" && summary.kind !== "range",
			partialValueSemantics: "refine"
		}
	};
}
function widgetKindForSummary(kind) {
	switch (kind) {
		case "category": return "category-list";
		case "histogram": return "histogram";
		case "range": return "range-list";
		default: return "stat";
	}
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isPositiveFinite(value) {
	return Number.isFinite(value) && value > 0;
}
function isNonNegativeFinite(value) {
	return Number.isFinite(value) && value >= 0;
}
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/surfaces.js
var HonuaService = class {
	client;
	serviceId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
	}
	featureLayer(layerId) {
		return new HonuaFeatureLayer({
			client: this.client,
			serviceId: this.serviceId,
			layerId
		});
	}
	layer(layerId) {
		return this.featureLayer(layerId);
	}
	async featureServiceMetadata(options = {}) {
		return this.client.getFeatureServiceMetadata(this.serviceId, options);
	}
	async mapServiceMetadata(options = {}) {
		return this.client.getMapServiceMetadata(this.serviceId, options);
	}
	async featureLayerIds() {
		return extractLayerIds(await this.featureServiceMetadata());
	}
	async featureLayers() {
		return (await this.featureLayerIds()).map((layerId) => new HonuaFeatureLayer({
			client: this.client,
			serviceId: this.serviceId,
			layerId
		}));
	}
	async mapLayerIds() {
		return extractLayerIds(await this.mapServiceMetadata());
	}
	async mapLayers() {
		return (await this.mapLayerIds()).map((layerId) => new HonuaMapLayer({
			client: this.client,
			serviceId: this.serviceId,
			layerId
		}));
	}
	async request(request) {
		return this.client.request({
			...request,
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/${normalizeServicePath(request.path)}`
		});
	}
	mapService() {
		return new HonuaMapService({
			client: this.client,
			serviceId: this.serviceId
		});
	}
	mapLayer(layerId) {
		return new HonuaMapLayer({
			client: this.client,
			serviceId: this.serviceId,
			layerId
		});
	}
};
var HonuaFeatureLayer = class {
	client;
	serviceId;
	layerId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.layerId = options.layerId;
	}
	async metadata(options = {}) {
		return this.client.getLayerMetadata(this.serviceId, this.layerId, options);
	}
	createQuery() {
		return {
			where: "1=1",
			outFields: ["*"],
			returnGeometry: true
		};
	}
	async queryFeatures(request = {}) {
		return this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			...request
		});
	}
	async queryFeaturesAll(request = {}) {
		const pageSize = typeof request.pageSize === "number" && Number.isFinite(request.pageSize) ? Math.max(1, Math.trunc(request.pageSize)) : 2e3;
		const maxPages = typeof request.maxPages === "number" && Number.isFinite(request.maxPages) ? Math.max(1, Math.trunc(request.maxPages)) : 100;
		const startingOffset = normalizeOffset(request.resultOffset);
		const features = [];
		let offset = startingOffset;
		let previousPageSignature;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryFeatures({
				...request,
				extraParams: withoutPagingExtraParams(request.extraParams),
				resultOffset: offset,
				resultRecordCount: pageSize
			});
			const pageFeatures = response.features ?? [];
			if (pageFeatures.length === 0) break;
			if (this.client.isGrpcWeb) {
				const signature = grpcPageOffsetSignature(response, pageFeatures);
				if (previousPageSignature !== void 0 && signature === previousPageSignature) throw new HonuaCapabilityNotSupportedError("queryAll", "grpc", `${this.serviceId}/${this.layerId}`, { context: {
					reason: "gRPC transport returned an identical page after resultOffset advanced; gRPC-aware pagination cannot be honored for this request.",
					resultOffset: offset
				} });
				previousPageSignature = signature;
			}
			features.push(...pageFeatures);
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
		return features;
	}
	async *queryFeaturesStream(request = {}) {
		const pageSize = typeof request.pageSize === "number" && Number.isFinite(request.pageSize) ? Math.max(1, Math.trunc(request.pageSize)) : 2e3;
		const maxPages = typeof request.maxPages === "number" && Number.isFinite(request.maxPages) ? Math.max(1, Math.trunc(request.maxPages)) : 100;
		const startingOffset = normalizeOffset(request.resultOffset);
		if (this.client.isGrpcWeb) {
			const { pageSize: _pageSize, maxPages: _maxPages, ...queryRequest } = request;
			let pageCount = 0;
			const stream = this.client.queryFeaturesStream({
				serviceId: this.serviceId,
				layerId: this.layerId,
				...queryRequest,
				resultRecordCount: queryRequest.resultRecordCount ?? pageSize
			});
			for await (const page of stream) {
				yield page;
				pageCount += 1;
				if (pageCount >= maxPages) break;
			}
			return;
		}
		let offset = startingOffset;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryFeatures({
				...request,
				extraParams: {
					...request.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = response.features ?? [];
			if (pageFeatures.length === 0) break;
			yield pageFeatures;
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
	}
	async queryFeatureCount(request = {}) {
		const response = await this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: request.where ?? "1=1",
			returnGeometry: false,
			outFields: "OBJECTID",
			method: request.method,
			extraParams: {
				returnCountOnly: true,
				...request.extraParams
			}
		});
		if (isObject$1(response) && typeof response.count === "number" && Number.isFinite(response.count)) return response.count;
		if (isObject$1(response) && Array.isArray(response.features)) return response.features.length;
		return 0;
	}
	async queryObjectIds(request = {}) {
		const response = await this.client.queryFeatures({
			...request,
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: request.where ?? "1=1",
			returnGeometry: false,
			outFields: request.outFields ?? "OBJECTID",
			extraParams: {
				returnIdsOnly: true,
				...request.extraParams
			}
		});
		if (isObject$1(response) && Array.isArray(response.objectIds)) return response.objectIds.map((value) => Number(value)).filter((value) => Number.isFinite(value));
		return [];
	}
	async queryExtent(request = {}) {
		return extractExtentFromResponse(await this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: request.where ?? "1=1",
			returnGeometry: false,
			method: request.method,
			extraParams: {
				returnExtentOnly: true,
				...request.extraParams
			}
		}));
	}
	async querySpatialAggregation(request) {
		const sourceId = request.sourceId ?? defaultFeatureLayerSourceId(this.serviceId, this.layerId);
		const normalizedRequest = {
			...request,
			sourceId
		};
		assertFeatureServerH3SpatialAggregationRequest(normalizedRequest);
		const plan = createFeatureServerH3AggregationPlan(normalizedRequest, request.kRingDistance);
		const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/queryH3`;
		const method = request.method ?? "POST";
		return featureServerH3AggregationResultFromResponse(method === "GET" ? await this.client.request({
			method,
			path,
			responseFormat: request.responseFormat ?? "json",
			query: plan.params,
			signal: request.signal
		}) : await this.client.request({
			method,
			path,
			responseFormat: request.responseFormat ?? "json",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: toFormBody(plan.params),
			signal: request.signal
		}), normalizedRequest, plan);
	}
	async queryRelatedRecords(request) {
		return this.client.queryRelatedRecords({
			serviceId: this.serviceId,
			layerId: this.layerId,
			...request
		});
	}
	async queryRelatedFeatures(request) {
		return this.queryRelatedRecords(request);
	}
	async applyEdits(request) {
		return this.client.applyEdits({
			serviceId: this.serviceId,
			layerId: this.layerId,
			...request
		});
	}
	async queryAttachments(request = {}) {
		const method = request.method ?? "GET";
		const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/queryAttachments`;
		const query = {
			...request.objectIds === void 0 ? {} : { objectIds: normalizeObjectIds(request.objectIds) },
			...request.where === void 0 ? {} : { where: request.where },
			...request.extraParams ?? {}
		};
		if (method === "GET") return this.client.request({
			method: "GET",
			path,
			responseFormat: request.responseFormat ?? "json",
			query,
			signal: request.signal
		});
		const body = toFormBody({
			f: request.responseFormat ?? "json",
			...query
		});
		return this.client.request({
			method: "POST",
			path,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: request.signal
		});
	}
	async listAttachments(request) {
		return this.client.request({
			method: "GET",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${request.objectId}/attachments`,
			responseFormat: request.responseFormat ?? "json",
			query: request.extraParams,
			signal: request.signal
		});
	}
	async deleteAttachments(request) {
		const body = toFormBody({
			f: request.responseFormat ?? "json",
			attachmentIds: normalizeObjectIds(request.attachmentIds),
			...request.extraParams ?? {}
		});
		return this.client.request({
			method: "POST",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${request.objectId}/deleteAttachments`,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: request.signal
		});
	}
	async addAttachment(request) {
		const form = buildAttachmentFormData$1(request);
		return this.client.request({
			method: "POST",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${request.objectId}/addAttachment`,
			responseFormat: request.responseFormat ?? "json",
			query: request.extraParams,
			body: form,
			signal: request.signal
		});
	}
	async updateAttachment(request) {
		const form = buildAttachmentFormData$1(request);
		form.set("attachmentId", String(request.attachmentId));
		return this.client.request({
			method: "POST",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${request.objectId}/updateAttachment`,
			responseFormat: request.responseFormat ?? "json",
			query: request.extraParams,
			body: form,
			signal: request.signal
		});
	}
	async request(request) {
		return this.client.request({
			...request,
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${normalizeLayerPath(request.path)}`
		});
	}
};
var HonuaMapService = class {
	client;
	serviceId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
	}
	async metadata(options = {}) {
		return this.client.getMapServiceMetadata(this.serviceId, options);
	}
	layer(layerId) {
		return new HonuaMapLayer({
			client: this.client,
			serviceId: this.serviceId,
			layerId
		});
	}
	async layerIds() {
		return extractLayerIds(await this.metadata());
	}
	async layers() {
		return (await this.layerIds()).map((layerId) => new HonuaMapLayer({
			client: this.client,
			serviceId: this.serviceId,
			layerId
		}));
	}
	async exportMap(request) {
		return this.client.exportMap({
			serviceId: this.serviceId,
			...request
		});
	}
	async legend(request = {}) {
		return this.client.getMapLegend({
			serviceId: this.serviceId,
			...request
		});
	}
	async getLegend(request = {}) {
		return this.legend(request);
	}
	async identify(request) {
		return this.client.identifyMap({
			serviceId: this.serviceId,
			...request
		});
	}
	async find(request) {
		return this.client.findMap({
			serviceId: this.serviceId,
			...request
		});
	}
	async queryLayer(request) {
		return this.client.queryMapLayer({
			serviceId: this.serviceId,
			...request
		});
	}
	async queryLayerRelatedRecords(request) {
		return this.client.queryMapRelatedRecords({
			serviceId: this.serviceId,
			...request
		});
	}
	async queryLayerRelatedFeatures(request) {
		return this.queryLayerRelatedRecords(request);
	}
	async queryLayerFeaturesAll(request) {
		const pageSize = typeof request.pageSize === "number" && Number.isFinite(request.pageSize) ? Math.max(1, Math.trunc(request.pageSize)) : 2e3;
		const maxPages = typeof request.maxPages === "number" && Number.isFinite(request.maxPages) ? Math.max(1, Math.trunc(request.maxPages)) : 100;
		const features = [];
		let offset = 0;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryLayer({
				...request,
				extraParams: {
					...request.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = extractFeaturesFromResponse(response);
			if (pageFeatures.length === 0) break;
			features.push(...pageFeatures);
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
		return features;
	}
	async *queryLayerFeaturesStream(request) {
		const pageSize = typeof request.pageSize === "number" && Number.isFinite(request.pageSize) ? Math.max(1, Math.trunc(request.pageSize)) : 2e3;
		const maxPages = typeof request.maxPages === "number" && Number.isFinite(request.maxPages) ? Math.max(1, Math.trunc(request.maxPages)) : 100;
		let offset = 0;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryLayer({
				...request,
				extraParams: {
					...request.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = extractFeaturesFromResponse(response);
			if (pageFeatures.length === 0) break;
			yield pageFeatures;
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
	}
	async queryLayerFeatureCount(request) {
		return extractFeatureCountFromResponse(await this.queryLayer({
			layerId: request.layerId,
			where: request.where ?? "1=1",
			returnGeometry: false,
			outFields: "OBJECTID",
			method: request.method,
			extraParams: {
				returnCountOnly: true,
				...request.extraParams
			}
		}));
	}
	async queryLayerObjectIds(request) {
		return extractObjectIdsFromResponse(await this.queryLayer({
			layerId: request.layerId,
			where: request.where ?? "1=1",
			returnGeometry: false,
			outFields: "OBJECTID",
			method: request.method,
			extraParams: {
				returnIdsOnly: true,
				...request.extraParams
			}
		}));
	}
	async queryLayerExtent(request) {
		return extractExtentFromResponse(await this.queryLayer({
			layerId: request.layerId,
			where: request.where ?? "1=1",
			returnGeometry: false,
			method: request.method,
			extraParams: {
				returnExtentOnly: true,
				...request.extraParams
			}
		}));
	}
	async exportImage(request) {
		return this.exportMap(request);
	}
	async request(request) {
		return this.client.request({
			...request,
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/MapServer/${normalizeServicePath(request.path)}`
		});
	}
};
var HonuaMapLayer = class {
	client;
	serviceId;
	layerId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.layerId = options.layerId;
	}
	async metadata(options = {}) {
		return this.client.getMapLayerMetadata(this.serviceId, this.layerId, options);
	}
	createQuery() {
		return {
			where: "1=1",
			outFields: ["*"],
			returnGeometry: true
		};
	}
	async queryFeatures(request = {}) {
		return this.client.queryMapLayer({
			serviceId: this.serviceId,
			layerId: this.layerId,
			...request
		});
	}
	async queryRelatedRecords(request) {
		return this.client.queryMapRelatedRecords({
			serviceId: this.serviceId,
			layerId: this.layerId,
			...request
		});
	}
	async queryRelatedFeatures(request) {
		return this.queryRelatedRecords(request);
	}
	async queryFeaturesAll(request = {}) {
		const pageSize = typeof request.pageSize === "number" && Number.isFinite(request.pageSize) ? Math.max(1, Math.trunc(request.pageSize)) : 2e3;
		const maxPages = typeof request.maxPages === "number" && Number.isFinite(request.maxPages) ? Math.max(1, Math.trunc(request.maxPages)) : 100;
		const startingOffset = normalizeOffset(request.resultOffset);
		const features = [];
		let offset = startingOffset;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryFeatures({
				...request,
				extraParams: {
					...request.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = extractFeaturesFromResponse(response);
			if (pageFeatures.length === 0) break;
			features.push(...pageFeatures);
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
		return features;
	}
	async *queryFeaturesStream(request = {}) {
		const pageSize = typeof request.pageSize === "number" && Number.isFinite(request.pageSize) ? Math.max(1, Math.trunc(request.pageSize)) : 2e3;
		const maxPages = typeof request.maxPages === "number" && Number.isFinite(request.maxPages) ? Math.max(1, Math.trunc(request.maxPages)) : 100;
		let offset = normalizeOffset(request.resultOffset);
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryFeatures({
				...request,
				extraParams: {
					...request.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = extractFeaturesFromResponse(response);
			if (pageFeatures.length === 0) break;
			yield pageFeatures;
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
	}
	async queryFeatureCount(request = {}) {
		return extractFeatureCountFromResponse(await this.queryFeatures({
			where: request.where ?? "1=1",
			returnGeometry: false,
			outFields: "OBJECTID",
			method: request.method,
			extraParams: {
				returnCountOnly: true,
				...request.extraParams
			}
		}));
	}
	async queryObjectIds(request = {}) {
		return extractObjectIdsFromResponse(await this.queryFeatures({
			...request,
			where: request.where ?? "1=1",
			returnGeometry: false,
			outFields: request.outFields ?? "OBJECTID",
			extraParams: {
				returnIdsOnly: true,
				...request.extraParams
			}
		}));
	}
	async queryExtent(request = {}) {
		return extractExtentFromResponse(await this.queryFeatures({
			where: request.where ?? "1=1",
			returnGeometry: false,
			method: request.method,
			extraParams: {
				returnExtentOnly: true,
				...request.extraParams
			}
		}));
	}
	async request(request) {
		return this.client.request({
			...request,
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/MapServer/${this.layerId}/${normalizeLayerPath(request.path)}`
		});
	}
};
/**
* Resolve the layout to inject onto a request. Returns `undefined` for the
* facade fast path so the wire layer keeps its zero-round-trip default.
*/
async function resolveInjectedLayout(client, mode) {
	if (mode === void 0 || mode === "honua-facade") return void 0;
	return client.resolveOgcFeaturesLayout(mode);
}
var HonuaOgcFeatures = class {
	client;
	layoutMode;
	constructor(options) {
		this.client = options.client;
		this.layoutMode = options.layout;
	}
	layout() {
		return resolveInjectedLayout(this.client, this.layoutMode);
	}
	collection(collectionId) {
		return new HonuaOgcFeatureCollection({
			client: this.client,
			collectionId,
			...this.layoutMode ? { layout: this.layoutMode } : {}
		});
	}
	async landing(request = {}) {
		const layout = await this.layout();
		return this.client.getOgcFeaturesLanding({
			...request,
			...layout ? { layout } : {}
		});
	}
	async conformance(request = {}) {
		const layout = await this.layout();
		return this.client.getOgcFeaturesConformance({
			...request,
			...layout ? { layout } : {}
		});
	}
	async collections(request = {}) {
		const layout = await this.layout();
		return this.client.listOgcCollections({
			...request,
			...layout ? { layout } : {}
		});
	}
	async getCollection(request) {
		const layout = await this.layout();
		return this.client.getOgcCollection({
			...request,
			...layout ? { layout } : {}
		});
	}
	async queryables(request) {
		const layout = await this.layout();
		return this.client.getOgcQueryables({
			...request,
			...layout ? { layout } : {}
		});
	}
	async items(request) {
		const layout = await this.layout();
		return this.client.listOgcItems({
			...request,
			...layout ? { layout } : {}
		});
	}
	async itemsAll(request) {
		const totalLimit = normalizeTotalLimit(request.limit);
		const features = [];
		for await (const page of drainOgcItemPages((pageRequest) => this.items(withOgcItemsPage(request, pageRequest)), {
			pageSize: normalizePageSize(request.pageSize, request.limit),
			maxPages: normalizeMaxPages(request.maxPages),
			startOffset: normalizeOffset(request.offset),
			...totalLimit !== void 0 ? { totalLimit } : {}
		})) features.push(...page);
		if (totalLimit !== void 0 && features.length > totalLimit) return features.slice(0, totalLimit);
		return features;
	}
	async item(request) {
		const layout = await this.layout();
		return this.client.getOgcItem({
			...request,
			...layout ? { layout } : {}
		});
	}
	async createItem(request) {
		const layout = await this.layout();
		return this.client.createOgcItem({
			...request,
			...layout ? { layout } : {}
		});
	}
	async replaceItem(request) {
		const layout = await this.layout();
		return this.client.replaceOgcItem({
			...request,
			...layout ? { layout } : {}
		});
	}
	async patchItem(request) {
		const layout = await this.layout();
		return this.client.patchOgcItem({
			...request,
			...layout ? { layout } : {}
		});
	}
	async deleteItem(request) {
		const layout = await this.layout();
		return this.client.deleteOgcItem({
			...request,
			...layout ? { layout } : {}
		});
	}
};
var HonuaOgcFeatureCollection = class {
	client;
	collectionId;
	layoutMode;
	constructor(options) {
		this.client = options.client;
		this.collectionId = options.collectionId;
		this.layoutMode = options.layout;
	}
	layout() {
		return resolveInjectedLayout(this.client, this.layoutMode);
	}
	async metadata(request = {}) {
		const layout = await this.layout();
		return this.client.getOgcCollection({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async queryables(request = {}) {
		const layout = await this.layout();
		return this.client.getOgcQueryables({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async items(request = {}) {
		const layout = await this.layout();
		return this.client.listOgcItems({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async itemsAll(request = {}) {
		const totalLimit = normalizeTotalLimit(request.limit);
		const features = [];
		for await (const page of drainOgcItemPages((pageRequest) => this.items(withOgcItemsPage(request, pageRequest)), {
			pageSize: normalizePageSize(request.pageSize, request.limit),
			maxPages: normalizeMaxPages(request.maxPages),
			startOffset: normalizeOffset(request.offset),
			...totalLimit !== void 0 ? { totalLimit } : {}
		})) features.push(...page);
		if (totalLimit !== void 0 && features.length > totalLimit) return features.slice(0, totalLimit);
		return features;
	}
	async *itemsStream(request = {}) {
		yield* drainOgcItemPages((pageRequest) => this.items(withOgcItemsPage(request, pageRequest)), {
			pageSize: normalizePageSize(request.pageSize, request.limit),
			maxPages: normalizeMaxPages(request.maxPages),
			startOffset: normalizeOffset(request.offset)
		});
	}
	async item(request) {
		const layout = await this.layout();
		return this.client.getOgcItem({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async createItem(request) {
		const layout = await this.layout();
		return this.client.createOgcItem({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async replaceItem(request) {
		const layout = await this.layout();
		return this.client.replaceOgcItem({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async patchItem(request) {
		const layout = await this.layout();
		return this.client.patchOgcItem({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
	async deleteItem(request) {
		const layout = await this.layout();
		return this.client.deleteOgcItem({
			...request,
			collectionId: this.collectionId,
			...layout ? { layout } : {}
		});
	}
};
/**
* Wrapper over a Honua ImageServer endpoint. Each operation maps to the
* server route published in
* `honua-server/docs/gis/image-server-matrix.md`. The wrapper does not
* downgrade to a generic raw call: it carries a typed request shape so
* the contract layer can negotiate capabilities and the server can
* branch on a stable method name.
*/
var HonuaImageService = class {
	client;
	serviceId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
	}
	async metadata() {
		return this.client.request({
			method: "GET",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer`,
			responseFormat: "json"
		});
	}
	async queryRasterCatalog(request = {}) {
		return this.dispatch("query", request, imageQueryParams(request));
	}
	async queryRasterCatalogObjectIds(request = {}) {
		const response = await this.dispatch("query", request, {
			...imageQueryParams(request),
			where: request.where ?? "1=1",
			returnIdsOnly: true
		});
		if (!Array.isArray(response.objectIds)) return [];
		return response.objectIds.map((v) => Number(v)).filter((v) => Number.isFinite(v));
	}
	async exportImage(request) {
		return this.dispatch("exportImage", request, imageExportParams(request));
	}
	async identify(request) {
		return this.dispatch("identify", request, imageIdentifyParams(request));
	}
	/**
	* Dispatch an ImageServer operation. POST mode sends params as a
	* form-encoded body so the server's `TryReadRequestValuesAsync` parser
	* finds them (returns "Request body is required" otherwise); GET mode
	* keeps params in the query string. Both encodings are accepted by
	* Honua Server per its ImageServer endpoint registration.
	*/
	async dispatch(op, request, params) {
		const method = request.method ?? "GET";
		const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer/${op}`;
		const responseFormat = request.responseFormat ?? "json";
		if (method === "GET") return this.client.request({
			method: "GET",
			path,
			responseFormat,
			query: params,
			signal: request.signal
		});
		return this.client.request({
			method: "POST",
			path,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: toFormBody({
				f: responseFormat,
				...params
			}),
			signal: request.signal
		});
	}
	tileUrl(level, row, col, format = "png") {
		const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer/tile/${level}/${row}/${col}`;
		return `${this.client.serverBaseUrl}${path}?f=${format}`;
	}
	async legend() {
		return this.client.request({
			method: "GET",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer/legend`,
			responseFormat: "json"
		});
	}
};
function imageQueryParams(request) {
	const params = {};
	if (request.where !== void 0) params.where = request.where;
	if (request.outFields !== void 0) params.outFields = Array.isArray(request.outFields) ? request.outFields.join(",") : String(request.outFields);
	if (request.objectIds !== void 0) params.objectIds = Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds);
	if (request.returnGeometry !== void 0) params.returnGeometry = request.returnGeometry;
	if (request.outSr !== void 0) params.outSR = String(request.outSr);
	if (request.resultOffset !== void 0) params.resultOffset = request.resultOffset;
	if (request.resultRecordCount !== void 0) params.resultRecordCount = request.resultRecordCount;
	if (request.geometry !== void 0) params.geometry = JSON.stringify(request.geometry);
	if (request.geometryType !== void 0) params.geometryType = String(request.geometryType);
	if (request.spatialRel !== void 0) params.spatialRel = String(request.spatialRel);
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function imageExportParams(request) {
	const params = {};
	if (request.bbox !== void 0) params.bbox = Array.isArray(request.bbox) ? request.bbox.join(",") : request.bbox;
	if (request.size !== void 0) params.size = Array.isArray(request.size) ? request.size.join(",") : request.size;
	if (request.format !== void 0) params.format = request.format;
	if (request.pixelType !== void 0) params.pixelType = request.pixelType;
	if (request.noData !== void 0) params.noData = request.noData;
	if (request.interpolation !== void 0) params.interpolation = request.interpolation;
	if (request.compressionQuality !== void 0) params.compressionQuality = request.compressionQuality;
	if (request.bandIds !== void 0) params.bandIds = Array.isArray(request.bandIds) ? request.bandIds.join(",") : String(request.bandIds);
	if (request.mosaicRule !== void 0) params.mosaicRule = typeof request.mosaicRule === "string" ? request.mosaicRule : JSON.stringify(request.mosaicRule);
	if (request.renderingRule !== void 0) params.renderingRule = typeof request.renderingRule === "string" ? request.renderingRule : JSON.stringify(request.renderingRule);
	if (request.imageSr !== void 0) params.imageSR = String(request.imageSr);
	if (request.bboxSr !== void 0) params.bboxSR = String(request.bboxSr);
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function imageIdentifyParams(request) {
	const params = {};
	params.geometry = typeof request.geometry === "string" ? request.geometry : JSON.stringify(request.geometry);
	if (request.geometryType !== void 0) params.geometryType = request.geometryType;
	if (request.sr !== void 0) params.sr = String(request.sr);
	if (request.mosaicRule !== void 0) params.mosaicRule = typeof request.mosaicRule === "string" ? request.mosaicRule : JSON.stringify(request.mosaicRule);
	if (request.renderingRule !== void 0) params.renderingRule = typeof request.renderingRule === "string" ? request.renderingRule : JSON.stringify(request.renderingRule);
	if (request.pixelSize !== void 0) params.pixelSize = Array.isArray(request.pixelSize) ? request.pixelSize.join(",") : request.pixelSize;
	Object.assign(params, request.extraParams ?? {});
	return params;
}
/**
* Wrapper over a Honua Geometry Service endpoint. Routes match the
* canonical paths published by Honua Server's `EndpointRegistry`
* (`/rest/services/Utilities/Geometry/GeometryServer/<op>`; see
* `honua-server/docs/gis/geometry-service-matrix.md`). Wraps the
* server-supported operations: `project`, `buffer`, `simplify`,
* `intersect`, `union`, `clip`, `difference`. Operations not
* implemented in Honua Server (autoComplete, convexHull, cut,
* areasAndLengths/lengths measurement helpers, etc.) intentionally have
* no wrapper — callers that need them go through the raw `request()`
* escape hatch and handle 404s themselves.
*
* POST mode submits form-encoded bodies so the server's
* `TryReadRequestValuesAsync` parser finds the parameters. GET mode keeps
* params in the query string (the server accepts both).
*/
var GEOMETRY_SERVICE_ROOT = "/rest/services/Utilities/Geometry/GeometryServer";
var HonuaGeometryService = class {
	client;
	constructor(options) {
		this.client = options.client;
	}
	async project(request) {
		return this.dispatch("project", request, geometryProjectParams(request));
	}
	async buffer(request) {
		return this.dispatch("buffer", request, geometryBufferParams(request));
	}
	async simplify(request) {
		return this.dispatch("simplify", request, geometrySimplifyParams(request));
	}
	async intersect(request) {
		return this.dispatch("intersect", request, geometryBinaryParams(request));
	}
	async union(request) {
		return this.dispatch("union", request, geometryUnionParams(request));
	}
	async clip(request) {
		return this.dispatch("clip", request, geometryBinaryParams(request));
	}
	async difference(request) {
		return this.dispatch("difference", request, geometryBinaryParams(request));
	}
	async dispatch(op, request, params) {
		const method = request.method ?? "POST";
		const path = `${GEOMETRY_SERVICE_ROOT}/${op}`;
		const responseFormat = request.responseFormat ?? "json";
		if (method === "GET") return this.client.request({
			method: "GET",
			path,
			responseFormat,
			query: params,
			signal: request.signal
		});
		return this.client.request({
			method: "POST",
			path,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: toFormBody({
				f: responseFormat,
				...params
			}),
			signal: request.signal
		});
	}
};
function geometryProjectParams(request) {
	const params = {
		geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
		inSR: typeof request.inSr === "string" || typeof request.inSr === "number" ? String(request.inSr) : JSON.stringify(request.inSr),
		outSR: typeof request.outSr === "string" || typeof request.outSr === "number" ? String(request.outSr) : JSON.stringify(request.outSr)
	};
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function geometryBufferParams(request) {
	const params = {
		geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
		distances: Array.isArray(request.distances) ? request.distances.join(",") : String(request.distances)
	};
	if (request.unit !== void 0) params.unit = request.unit;
	if (request.inSr !== void 0) params.inSR = typeof request.inSr === "object" ? JSON.stringify(request.inSr) : String(request.inSr);
	if (request.outSr !== void 0) params.outSR = typeof request.outSr === "object" ? JSON.stringify(request.outSr) : String(request.outSr);
	if (request.bufferSr !== void 0) params.bufferSR = typeof request.bufferSr === "object" ? JSON.stringify(request.bufferSr) : String(request.bufferSr);
	if (request.unionResults !== void 0) params.unionResults = request.unionResults;
	if (request.geodesic !== void 0) params.geodesic = request.geodesic;
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function geometrySimplifyParams(request) {
	const params = { geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries) };
	if (request.sr !== void 0) params.sr = typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr);
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function geometryBinaryParams(request) {
	const params = {
		geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
		geometry: typeof request.geometry === "string" ? request.geometry : JSON.stringify(request.geometry),
		sr: typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr)
	};
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function geometryUnionParams(request) {
	const params = {
		geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
		sr: typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr)
	};
	Object.assign(params, request.extraParams ?? {});
	return params;
}
/**
* Wrapper over a Honua GP Service task. Mirrors the routes published in
* `honua-server/docs/gis/geoprocess-framework-analysis.md`: `submitJob`,
* `jobs/{jobId}` (status), `jobs/{jobId}/cancel`, and per-result lookup
* (currently registered route, output delivery still depends on the
* execution engine — see the parity matrix).
*/
var HonuaGeoprocessingService = class {
	client;
	serviceId;
	taskName;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.taskName = options.taskName;
	}
	async submitJob(request) {
		return this.client.request({
			method: request.method ?? "POST",
			path: this.taskPath("submitJob"),
			responseFormat: request.responseFormat ?? "json",
			query: gpSubmitParams(request),
			signal: request.signal
		});
	}
	/**
	* Submit a GeoServices GP job and expose it through the canonical
	* async-operation surface. This keeps GPServer tasks interoperable with
	* OGC Processes jobs, app-workspace job state, and any future job-aware
	* UI components.
	*/
	async submit(request, options = {}) {
		const accepted = await this.submitJob(request);
		return new HonuaGeoprocessingJobRun({
			client: this.client,
			serviceId: this.serviceId,
			taskName: this.taskName,
			jobId: accepted.jobId,
			initialJob: accepted,
			resultNames: options.resultNames,
			pollIntervalMs: options.pollIntervalMs
		});
	}
	/** Adopt an existing GP job by id after navigation or reconnect. */
	job(jobId, options = {}) {
		return new HonuaGeoprocessingJobRun({
			client: this.client,
			serviceId: this.serviceId,
			taskName: this.taskName,
			jobId,
			resultNames: options.resultNames,
			pollIntervalMs: options.pollIntervalMs
		});
	}
	async jobStatus(jobId, options = {}) {
		return this.client.request({
			method: "GET",
			path: `${this.taskPath("jobs")}/${encodeURIComponent(jobId)}`,
			responseFormat: "json",
			signal: options.signal
		});
	}
	async cancelJob(jobId, options = {}) {
		return this.client.request({
			method: "POST",
			path: `${this.taskPath("jobs")}/${encodeURIComponent(jobId)}/cancel`,
			responseFormat: "json",
			signal: options.signal
		});
	}
	async jobResult(jobId, resultName, options = {}) {
		return this.client.request({
			method: "GET",
			path: `${this.taskPath("jobs")}/${encodeURIComponent(jobId)}/results/${encodeURIComponent(resultName)}`,
			responseFormat: "json",
			signal: options.signal
		});
	}
	taskPath(suffix) {
		const taskSegment = this.taskName ? `/${encodeURIComponent(this.taskName)}` : "";
		return `/rest/services/${encodeServiceIdPath(this.serviceId)}/GPServer${taskSegment}/${suffix}`;
	}
};
var DEFAULT_GP_POLL_INTERVAL_MS = 1e3;
var HonuaGeoprocessingJobRun = class {
	id;
	type;
	client;
	serviceId;
	taskName;
	resultNames;
	pollIntervalMs;
	pollFn;
	resultFn;
	cancelFn;
	lifecycle;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.taskName = options.taskName;
		this.id = options.jobId;
		this.type = options.taskName ? `${options.serviceId}/${options.taskName}` : options.serviceId;
		this.resultNames = options.resultNames ?? [];
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_GP_POLL_INTERVAL_MS;
		this.pollFn = options.pollFn ?? ((jobId, signal) => new HonuaGeoprocessingService({
			client: this.client,
			serviceId: this.serviceId,
			taskName: this.taskName
		}).jobStatus(jobId, { signal }));
		this.resultFn = options.resultFn ?? ((jobId, resultName, signal) => new HonuaGeoprocessingService({
			client: this.client,
			serviceId: this.serviceId,
			taskName: this.taskName
		}).jobResult(jobId, resultName, { signal }));
		this.cancelFn = options.cancelFn ?? ((jobId, signal) => new HonuaGeoprocessingService({
			client: this.client,
			serviceId: this.serviceId,
			taskName: this.taskName
		}).cancelJob(jobId, { signal }));
		this.lifecycle = new JobRunLifecycle({
			id: this.id,
			initialStatus: geoprocessingStatusToJobStatus(options.initialJob?.jobStatus),
			initialProgress: progressFromGeoprocessingJob(options.initialJob),
			pollIntervalMs: this.pollIntervalMs,
			poll: async (signal) => this.translateGeoprocessingJob(await this.pollFn(this.id, signal), signal)
		});
	}
	get status() {
		return this.lifecycle.status;
	}
	get progress() {
		return this.lifecycle.progress;
	}
	async poll() {
		return this.lifecycle.poll();
	}
	watch(listener) {
		return this.lifecycle.watch(listener);
	}
	async results(options = {}) {
		return this.lifecycle.results(options);
	}
	async cancel() {
		return this.lifecycle.cancel(async () => this.translateGeoprocessingJob(await this.cancelFn(this.id)));
	}
	async translateGeoprocessingJob(job, signal) {
		const status = geoprocessingStatusToJobStatus(job?.jobStatus);
		const progress = progressFromGeoprocessingJob(job);
		if (status === "successful") return {
			status,
			progress,
			result: { outputs: await this.resolveOutputs(job, signal) }
		};
		if (status === "failed" || status === "dismissed") {
			const error = geoprocessingJobError(status, job);
			return {
				status,
				progress,
				...error ? { error } : {}
			};
		}
		return {
			status,
			progress
		};
	}
	async resolveOutputs(job, signal) {
		if (this.resultNames.length === 0) return job?.results ?? {};
		const outputs = {};
		for (const resultName of this.resultNames) outputs[resultName] = await this.resultFn(this.id, resultName, signal);
		return outputs;
	}
};
function gpSubmitParams(request) {
	const params = {};
	for (const [key, value] of Object.entries(request.parameters)) params[key] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);
	Object.assign(params, request.extraParams ?? {});
	return params;
}
function geoprocessingStatusToJobStatus(value) {
	const normalized = (value ?? "esriJobSubmitted").toLowerCase();
	if (normalized.includes("succeeded") || normalized === "successful") return "successful";
	if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("dismissed")) return "dismissed";
	if (normalized.includes("failed") || normalized.includes("timedout") || normalized.includes("timed out")) return "failed";
	if (normalized.includes("submitted") || normalized.includes("waiting") || normalized.includes("accepted")) return "accepted";
	if (isJobTerminal(normalized)) return normalized;
	return "running";
}
function progressFromGeoprocessingJob(job) {
	if (!job) return void 0;
	const message = job.messages?.at(-1)?.description;
	return message === void 0 ? void 0 : { message };
}
function geoprocessingJobError(status, job) {
	const message = job?.messages?.find((entry) => /error|failed|cancel/i.test(entry.type))?.description ?? job?.messages?.at(-1)?.description;
	if (!message) return status === "dismissed" ? {
		code: "GeoServicesJobDismissed",
		message: "GeoServices GP job was dismissed."
	} : {
		code: "GeoServicesJobFailed",
		message: "GeoServices GP job failed."
	};
	return {
		code: status === "dismissed" ? "GeoServicesJobDismissed" : "GeoServicesJobFailed",
		message
	};
}
function isObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function defaultFeatureLayerSourceId(serviceId, layerId) {
	return `geoservices-feature-service:${serviceId}/${layerId}`;
}
function createFeatureServerH3AggregationPlan(request, kRingDistance) {
	const resolution = request.resolution?.indexResolution;
	if (resolution === void 0) throw new Error("FeatureServer queryH3 requires resolution.indexResolution");
	const params = { resolution };
	if (request.where !== void 0) params.where = request.where;
	const normalizedKRingDistance = normalizeH3KRingDistance(kRingDistance);
	if (normalizedKRingDistance !== void 0) params.kRingDistance = normalizedKRingDistance;
	const firstSummary = request.summaries[0];
	if (request.summaries.length === 1 && firstSummary?.kind === "count" && firstSummary.field === void 0) return {
		params,
		resolution,
		summaryBindings: [{
			summary: firstSummary,
			responseField: "count"
		}]
	};
	const outStatistics = [];
	const summaryBindings = request.summaries.map((summary, index) => {
		const responseField = outStatisticFieldName(summary, index);
		const onStatisticField = statisticInputField(summary);
		outStatistics.push({
			statisticType: summary.kind,
			onStatisticField,
			outStatisticFieldName: responseField
		});
		return {
			summary,
			responseField
		};
	});
	params.outStatistics = JSON.stringify(outStatistics);
	return {
		params,
		resolution,
		summaryBindings
	};
}
function featureServerH3AggregationResultFromResponse(response, request, plan) {
	const cells = extractFeaturesFromResponse(response).map((feature) => featureServerH3CellFromFeature(feature, request, plan));
	const extent = mergeExtents(cells.map((cell) => cell.extent).filter((value) => value !== void 0));
	const indexModel = {
		id: request.index?.modelId ?? "h3",
		title: "FeatureServer indexed cells",
		family: "h3",
		cellIdEncoding: "string",
		minResolution: 0,
		maxResolution: 15,
		supportedGeometry: [
			"none",
			"extent",
			"boundary"
		],
		hierarchy: "parent-child",
		spatialReference: response.spatialReference ?? extent?.spatialReference ?? { wkid: 4326 }
	};
	const summaries = request.summaries.map(spatialAggregationSummaryMetadataFromSpec);
	const progressive = {
		status: response.exceededTransferLimit === true ? "partial" : "complete",
		refinement: response.exceededTransferLimit === true ? "append" : void 0,
		loadedCellCount: cells.length
	};
	const metadata = {
		schemaVersion: SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION,
		sourceId: request.sourceId,
		indexModels: [indexModel],
		summaries,
		progressive,
		cache: {
			metadataCacheable: true,
			resultCacheable: false,
			cacheKeyParts: [
				"geoservices-feature-service",
				request.sourceId,
				"queryH3",
				`resolution=${plan.resolution}`,
				`where=${request.where ?? ""}`
			]
		}
	};
	return {
		schemaVersion: SPATIAL_AGGREGATION_SCHEMA_VERSION,
		requestId: request.requestId,
		sourceId: request.sourceId,
		index: {
			model: indexModel,
			resolution: plan.resolution,
			requestedResolution: request.resolution,
			cellCount: cells.length,
			extent
		},
		metadata: {
			...metadata,
			widgets: spatialAggregationWidgets(metadata)
		},
		cells,
		page: response.exceededTransferLimit === true ? { loadedCellCount: cells.length } : void 0,
		degraded: response.exceededTransferLimit === true ? [{
			capability: "spatialAggregate",
			protocol: "geoservices-feature-service",
			sourceId: request.sourceId,
			reason: "FeatureServer queryH3 response exceeded the server transfer limit; returned cells may be partial."
		}] : void 0
	};
}
function featureServerH3CellFromFeature(feature, request, plan) {
	const attributes = feature.attributes ?? {};
	const id = cellIdFromAttributes(attributes);
	const extent = extentFromGeometry(feature.geometry);
	const geometryMode = request.index?.geometry ?? "boundary";
	const cell = {
		id,
		resolution: plan.resolution,
		extent,
		summaries: spatialAggregationSummariesFromAttributes(attributes, plan)
	};
	if (geometryMode === "boundary" && isObject$1(feature.geometry)) return {
		...cell,
		geometry: feature.geometry
	};
	return cell;
}
function spatialAggregationSummariesFromAttributes(attributes, plan) {
	const summaries = {};
	for (const binding of plan.summaryBindings) summaries[binding.summary.id] = spatialAggregationSummaryValueFromAttribute(binding.summary, attributes[binding.responseField]);
	return summaries;
}
function spatialAggregationSummaryValueFromAttribute(summary, value) {
	if (summary.kind === "count") return {
		kind: "count",
		value: Math.max(0, finiteNumberOr(value, 0))
	};
	if (summary.kind === "sum" || summary.kind === "avg" || summary.kind === "min" || summary.kind === "max") return {
		kind: summary.kind,
		value: finiteNumberOrNull(value),
		unit: summary.unit
	};
	throw new Error(`FeatureServer queryH3 does not support ${summary.kind} summaries.`);
}
function spatialAggregationSummaryMetadataFromSpec(summary) {
	return {
		id: summary.id,
		kind: summary.kind,
		title: summary.title,
		field: summary.field,
		valueType: summary.valueType ?? (summary.kind === "count" ? "number" : void 0),
		unit: summary.unit
	};
}
function statisticInputField(summary) {
	if (summary.kind === "count") {
		if (summary.field === void 0) throw new Error("count summaries require a field when queryH3 uses outStatistics.");
		return summary.field;
	}
	if (summary.kind === "sum" || summary.kind === "avg" || summary.kind === "min" || summary.kind === "max") return summary.field;
	throw new Error(`FeatureServer queryH3 does not support ${summary.kind} summaries.`);
}
function outStatisticFieldName(summary, index) {
	const safeId = summary.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
	return `honua_${index + 1}_${safeId || "summary"}`.slice(0, 63);
}
function normalizeH3KRingDistance(value) {
	if (value === void 0) return;
	if (!Number.isInteger(value) || value < 0 || value > 20) throw new Error("FeatureServer queryH3 kRingDistance must be an integer between 0 and 20.");
	return value;
}
function cellIdFromAttributes(attributes) {
	for (const key of [
		"cellIndex",
		"cell_index",
		"h3Index",
		"h3_index"
	]) {
		const value = attributes[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
	}
	throw new Error("FeatureServer queryH3 response is missing a cellIndex attribute.");
}
function extentFromGeometry(geometry) {
	if (!isObject$1(geometry)) return;
	if (isFiniteNumber(geometry.xmin) && isFiniteNumber(geometry.ymin) && isFiniteNumber(geometry.xmax) && isFiniteNumber(geometry.ymax)) return {
		xmin: geometry.xmin,
		ymin: geometry.ymin,
		xmax: geometry.xmax,
		ymax: geometry.ymax,
		spatialReference: isObject$1(geometry.spatialReference) ? geometry.spatialReference : void 0
	};
	const coordinates = [];
	collectCoordinatePairs(geometry.rings, coordinates);
	collectCoordinatePairs(geometry.paths, coordinates);
	collectCoordinatePairs(geometry.points, coordinates);
	if (isFiniteNumber(geometry.x) && isFiniteNumber(geometry.y)) coordinates.push([geometry.x, geometry.y]);
	if (coordinates.length === 0) return;
	let xmin = Number.POSITIVE_INFINITY;
	let ymin = Number.POSITIVE_INFINITY;
	let xmax = Number.NEGATIVE_INFINITY;
	let ymax = Number.NEGATIVE_INFINITY;
	for (const [x, y] of coordinates) {
		xmin = Math.min(xmin, x);
		ymin = Math.min(ymin, y);
		xmax = Math.max(xmax, x);
		ymax = Math.max(ymax, y);
	}
	return {
		xmin,
		ymin,
		xmax,
		ymax,
		spatialReference: isObject$1(geometry.spatialReference) ? geometry.spatialReference : void 0
	};
}
function collectCoordinatePairs(value, coordinates) {
	if (!Array.isArray(value)) return;
	if (isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
		coordinates.push([value[0], value[1]]);
		return;
	}
	for (const child of value) collectCoordinatePairs(child, coordinates);
}
function mergeExtents(extents) {
	if (extents.length === 0) return;
	const [first, ...rest] = extents;
	return rest.reduce((merged, extent) => ({
		xmin: Math.min(merged.xmin, extent.xmin),
		ymin: Math.min(merged.ymin, extent.ymin),
		xmax: Math.max(merged.xmax, extent.xmax),
		ymax: Math.max(merged.ymax, extent.ymax),
		spatialReference: merged.spatialReference ?? extent.spatialReference
	}), first);
}
function finiteNumberOr(value, fallback) {
	return finiteNumberOrNull(value) ?? fallback;
}
function finiteNumberOrNull(value) {
	if (isFiniteNumber(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
function extractFeatureCountFromResponse(response) {
	if (isObject$1(response) && typeof response.count === "number" && Number.isFinite(response.count)) return response.count;
	if (isObject$1(response) && Array.isArray(response.features)) return response.features.length;
	return 0;
}
function extractFeaturesFromResponse(response) {
	if (!isObject$1(response) || !Array.isArray(response.features)) return [];
	return response.features;
}
function extractObjectIdsFromResponse(response) {
	if (!isObject$1(response) || !Array.isArray(response.objectIds)) return [];
	return response.objectIds.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}
function extractExtentFromResponse(response) {
	if (!isObject$1(response)) return { extent: null };
	const count = isFiniteNumber(response.count) ? response.count : void 0;
	return {
		extent: isObject$1(response.extent) ? response.extent : null,
		count
	};
}
function normalizeObjectIds(ids) {
	return Array.isArray(ids) ? ids.join(",") : String(ids);
}
function toFormBody(values) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) params.set(key, String(value));
	return params.toString();
}
function normalizeLayerPath(path) {
	return path.startsWith("/") ? path.slice(1) : path;
}
function normalizeServicePath(path) {
	return path.startsWith("/") ? path.slice(1) : path;
}
function normalizePageSize(pageSize, limit) {
	if (isFinitePositiveInteger(pageSize)) return pageSize;
	if (isFinitePositiveInteger(limit)) return limit;
	return 100;
}
function normalizeMaxPages(maxPages) {
	if (isFinitePositiveInteger(maxPages)) return maxPages;
	return 100;
}
function normalizeOffset(offset) {
	if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.trunc(offset));
}
/**
* Returns `extraParams` with `resultOffset` / `resultRecordCount` removed, so
* a caller-supplied `extraParams` cannot be applied after (and therefore
* override) the paging cursor `queryFeaturesAll` computes for each page. The
* REST wire mapper (`appendQueryExtraParams`) applies `extraParams` after the
* top-level query fields, so leaving these keys in place would let a stray
* `extraParams.resultOffset` silently win over the loop's own cursor.
*/
function withoutPagingExtraParams(extraParams) {
	if (!extraParams) return;
	const { resultOffset: _resultOffset, resultRecordCount: _resultRecordCount, ...rest } = extraParams;
	return rest;
}
/**
* Produces a cheap identity signature for a query page so
* `HonuaFeatureLayer.queryFeaturesAll` can detect a gRPC transport that
* returns the same page again after the `resultOffset` cursor advanced
* (REQ-002 of issue #663: fail closed rather than loop or silently repeat a
* page). Prefers the response's declared object-id field, present on every
* GeoServices-shaped feature response; falls back to serializing the raw
* attributes when the id field is unavailable.
*/
function grpcPageOffsetSignature(response, features) {
	const idField = response.objectIdFieldName;
	if (idField) {
		const objectIds = features.map((feature) => feature.attributes?.[idField]);
		if (objectIds.every((objectId) => objectId !== void 0 && objectId !== null)) return JSON.stringify(objectIds);
	}
	return JSON.stringify(features);
}
function normalizeTotalLimit(limit) {
	if (!isFinitePositiveInteger(limit)) return;
	return limit;
}
/**
* Query-string keys on an OGC API Features `rel="next"` link that must not be
* replayed on the follow-up request: the drain owns the page size (`limit`)
* and the caller owns the response format (`f`). Every other param on the
* link — `offset` / `startindex` on an offset server, an opaque
* `token` / `cursor` / `next` on a cursor server — is the server's own paging
* state and is echoed back verbatim, subject to the stale-offset rules in
* {@link ogcCursorFromHref}.
*/
var OGC_NEXT_LINK_RESERVED_PARAMS = new Set(["f", "limit"]);
/**
* Params that express a numeric start position. Compared case-insensitively:
* `offset` is Honua Server's spelling, `startindex` / `startIndex` the OGC API
* spelling servers vary the casing of.
*/
var OGC_OFFSET_PARAM_NAMES = new Set(["offset", "startindex"]);
/**
* Params that express an opaque paging cursor. Matched case-insensitively with
* `-` / `_` stripped, so `page_token` and `pageToken` both hit. When one of
* these drives the next link, the token owns the read position and any
* `offset` / `startindex` on the same link is a stale echo of the request the
* server just answered.
*/
var OGC_CURSOR_PARAM_NAMES = new Set([
	"token",
	"nexttoken",
	"pagetoken",
	"continuationtoken",
	"resumptiontoken",
	"cursor",
	"next",
	"page",
	"searchafter",
	"scroll",
	"scrollid"
]);
/** Base used only to parse relative `rel="next"` hrefs; never requested. */
var OGC_NEXT_LINK_PARSE_BASE = "https://placeholder.test";
/**
* Page `/items` the way OGC API Features Core specifies: follow the
* `rel="next"` link the server returns, and only fall back to `limit`/`offset`
* arithmetic when the response advertises no usable next link. Offset
* arithmetic alone silently mis-pages every server that pages by opaque token
* or cursor (pgstac-backed APIs, several pygeoapi deployments): the cursor is
* dropped, so pages repeat or skip with no error.
*
* Anti-corruption invariants, preserved on both paths:
* - an empty page ends the drain;
* - a page whose feature identity repeats an already-yielded page is dropped
*   and ends the drain, so a looping server can never duplicate features;
* - a `rel="next"` link that repeats a cursor already followed is treated as
*   a stalled pager and ends the drain;
* - a stale `offset` / `startindex` echoed on a cursor link never reaches the
*   wire beside the cursor (see {@link ogcCursorFromHref});
* - `maxPages` still caps the total number of requests.
*
* On the link-driven path a short page is deliberately *not* a stop signal:
* OGC API Features permits a server to return fewer than `limit` items on a
* non-final page while still advertising `rel="next"` (the same tolerance the
* Records drain applies). On the offset path a short page still ends the
* drain, as it always has.
*/
async function* drainOgcItemPages(fetchPage, options) {
	const { pageSize, maxPages, startOffset, totalLimit } = options;
	const seenCursorKeys = /* @__PURE__ */ new Set();
	const seenPageKeys = /* @__PURE__ */ new Set();
	let cursor;
	let emitted = 0;
	for (let page = 0; page < maxPages; page += 1) {
		const remaining = totalLimit === void 0 ? pageSize : Math.max(0, totalLimit - emitted);
		if (remaining < 1) break;
		const limit = Math.min(pageSize, remaining);
		const sentOffset = cursor === void 0 ? startOffset + page * pageSize : void 0;
		const response = await fetchPage({
			limit,
			offset: sentOffset,
			cursorParams: cursor?.params
		});
		const pageFeatures = extractOgcFeatures(response);
		if (pageFeatures.length === 0) break;
		const pageKey = ogcPageIdentityKey(pageFeatures);
		if (pageKey !== void 0) {
			if (seenPageKeys.has(pageKey)) break;
			seenPageKeys.add(pageKey);
		}
		yield pageFeatures;
		emitted += pageFeatures.length;
		const next = ogcNextItemsCursor(response.links, sentOffset);
		if (next !== void 0) {
			if (seenCursorKeys.has(next.key)) break;
			seenCursorKeys.add(next.key);
			cursor = next;
			continue;
		}
		if (cursor !== void 0) break;
		if (pageFeatures.length < limit) break;
	}
}
/**
* Merge one {@link drainOgcItemPages} page request onto the caller's request.
* Cursor params ride on `extraParams`, which the OGC wire layer serializes
* before the typed fields, so the caller's `filter` / `bbox` / `crs` still win
* and only the paging state comes from the server.
*/
function withOgcItemsPage(request, page) {
	return {
		...request,
		limit: page.limit,
		offset: page.offset,
		...page.cursorParams ? { extraParams: {
			...request.extraParams,
			...page.cursorParams
		} } : {}
	};
}
/**
* Resolve the server's next-page cursor from an `/items` response. Only the
* link's query params are replayed (not its host or path), so a next link
* rewritten by a proxy — or emitted with the server's internal hostname —
* still pages correctly. Returns `undefined` when no `rel="next"` link carries
* usable paging state, which is what selects the offset fallback.
*
* @param sentOffset the `offset` sent for the page that produced these links,
*   or `undefined` when a cursor already drove that request. Used to spot an
*   `offset` on the link that merely echoes the request just answered.
*/
function ogcNextItemsCursor(links, sentOffset) {
	if (!links) return;
	for (const link of links) {
		if (link.rel !== "next" || typeof link.href !== "string") continue;
		if (typeof link.type === "string" && link.type.includes("html")) continue;
		const cursor = ogcCursorFromHref(link.href, sentOffset);
		if (cursor !== void 0) return cursor;
	}
}
/** Fold a query-param name to its comparison form (case / `-` / `_` insensitive). */
function ogcParamKey(name) {
	let folded = "";
	for (const char of name) {
		if (char === "-" || char === "_") continue;
		folded += char.toLowerCase();
	}
	return folded;
}
/**
* Lift the paging state off one `rel="next"` href.
*
* Servers routinely build the next link by preserving the query string of the
* request they just answered and appending their cursor, so the link can carry
* both a stale `offset=0` and a live `token=…`. Replaying both is exactly the
* mis-paging this drain exists to prevent — a server that honors `offset`
* alongside its own token re-reads or skips a page. Two rules keep the two
* paging styles apart:
*
* 1. an opaque cursor on the link (`token`, `cursor`, `next`, `page`, …) owns
*    the read position, so every `offset` / `startindex` on that link is
*    dropped;
* 2. otherwise an `offset` / `startindex` that merely repeats the offset just
*    sent cannot advance the drain, so it is dropped too — and if that leaves
*    the link with nothing, the drain falls back to offset arithmetic.
*
* A genuine offset link (`offset=10` after requesting `offset=0`) is kept and
* drives the next page, which is what pygeoapi / ldproxy deployments emit.
*/
function ogcCursorFromHref(href, sentOffset) {
	let url;
	try {
		url = new URL(href, OGC_NEXT_LINK_PARSE_BASE);
	} catch {
		return;
	}
	const candidates = [];
	let hasOpaqueCursor = false;
	for (const [key, value] of url.searchParams) {
		if (OGC_NEXT_LINK_RESERVED_PARAMS.has(key)) continue;
		if (OGC_CURSOR_PARAM_NAMES.has(ogcParamKey(key))) hasOpaqueCursor = true;
		candidates.push([key, value]);
	}
	const params = {};
	let hasPagingState = false;
	for (const [key, value] of candidates) {
		const folded = ogcParamKey(key);
		if (OGC_OFFSET_PARAM_NAMES.has(folded)) {
			if (hasOpaqueCursor) continue;
			if (sentOffset !== void 0 && Number(value) === sentOffset) continue;
			hasPagingState = true;
		} else if (OGC_CURSOR_PARAM_NAMES.has(folded)) hasPagingState = true;
		params[key] = value;
	}
	if (!hasPagingState) return;
	return {
		key: Object.entries(params).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&"),
		params
	};
}
/**
* Cheap identity signature for one `/items` page, used to detect a server that
* replays a page it already returned. Returns `undefined` when any feature
* lacks a GeoJSON `id`, in which case the drain simply skips the check rather
* than serializing whole geometries.
*/
function ogcPageIdentityKey(features) {
	const ids = [];
	for (const feature of features) {
		const id = feature?.id;
		if (typeof id !== "string" && typeof id !== "number") return;
		ids.push(String(id));
	}
	return JSON.stringify(ids);
}
function isFinitePositiveInteger(value) {
	return typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0;
}
function buildAttachmentFormData$1(request) {
	const form = new FormData();
	if (request.attachment instanceof Blob) {
		const blob = ensureBlobType(request.attachment, request.contentType);
		const fileName = request.name ?? resolveBlobName(request.attachment);
		form.set("attachment", blob, fileName);
		return form;
	}
	const blob = new Blob([request.attachment], { type: request.contentType ?? "application/octet-stream" });
	form.set("attachment", blob, request.name ?? "attachment.txt");
	return form;
}
function resolveBlobName(blob) {
	if ("name" in blob && typeof blob.name === "string" && blob.name.length > 0) return blob.name;
	return "attachment.bin";
}
function ensureBlobType(blob, contentType) {
	if (!contentType || blob.type === contentType) return blob;
	return new Blob([blob], { type: contentType });
}
function extractLayerIds(metadata) {
	if (!isObject$1(metadata) || !Array.isArray(metadata.layers)) return [];
	const ids = [];
	for (const layer of metadata.layers) {
		if (!isObject$1(layer)) continue;
		const parsed = Number(layer.id);
		if (!Number.isFinite(parsed)) continue;
		ids.push(Math.trunc(parsed));
	}
	return ids;
}
function extractOgcFeatures(response) {
	if (!isObject$1(response) || !Array.isArray(response.features)) return [];
	return response.features;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wfs-capabilities.js
/**
* Hand-rolled XML walker for the two WFS surfaces that the canonical adapter
* actually has to read: `wfs:WFS_Capabilities` (operation list, output formats
* by operation, advertised feature types, filter capabilities, stored-query
* names) and `ows:ExceptionReport` (turned into `HonuaWfsExceptionError`).
*
* Scope is intentionally narrow — never touches feature payloads, only
* metadata XML — so a hand-rolled walker beats pulling in a generic XML
* parser as a runtime dependency. The walker:
*
* - Refuses any document with `<!DOCTYPE …>` or `<!ENTITY …>` declarations.
*   Stops XXE-class attacks before any property is read.
* - Is namespace-aware in the loose sense: it matches local element names
*   (the suffix after `:`) and ignores prefixes, since WFS 2.0 uses several
*   different prefix conventions in the wild.
* - Returns plain typed structs — no dependency on `xmldom`,
*   `fast-xml-parser`, or other third-party libraries.
*
* @module
*/
/** Fixed allocation ceilings for every WFS metadata XML document. */
var WFS_XML_LIMITS = Object.freeze({
	maxBytes: 2 * 1024 * 1024,
	maxElements: 12e3,
	maxDepth: 32,
	maxAttributesPerElement: 64,
	maxAttributeBytesPerElement: 64 * 1024,
	maxTextBytes: 512 * 1024
});
/**
* Parse a WFS `GetCapabilities` document. Throws when the document declares
* a DOCTYPE / ENTITY (XXE defense) or when the root element is not
* `WFS_Capabilities` / not parseable.
*/
function parseWfsCapabilities(xml) {
	const root = parseXml(xml);
	if (root.local !== "WFS_Capabilities") {
		if (root.local === "ExceptionReport") {
			const report = parseExceptionFromRoot(root);
			throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
		}
		throw new Error(`WFS GetCapabilities: expected <WFS_Capabilities>, got <${root.qname}>`);
	}
	const version = root.attributes.version;
	const operationsList = findChild(root, "OperationsMetadata") ? findChildren(findChildOrThrow(root, "OperationsMetadata"), "Operation") : [];
	const operations = /* @__PURE__ */ new Map();
	const outputFormatsByOp = /* @__PURE__ */ new Map();
	for (const op of operationsList) {
		const name = op.attributes.name;
		if (!name) continue;
		const methods = [];
		let getUrl;
		let postUrl;
		for (const dcp of findChildren(op, "DCP")) {
			const http = findChild(dcp, "HTTP");
			if (!http) continue;
			for (const method of http.children) {
				if (method.local === "Get") {
					methods.push("GET");
					if (getUrl === void 0 && method.attributes.href) getUrl = method.attributes.href;
				}
				if (method.local === "Post") {
					methods.push("POST");
					if (postUrl === void 0 && method.attributes.href) postUrl = method.attributes.href;
				}
			}
		}
		const outputFormats = [];
		for (const param of findChildren(op, "Parameter")) {
			if (param.attributes.name?.toLowerCase() !== "outputformat") continue;
			for (const allowed of findChildren(param, "AllowedValues")) for (const value of findChildren(allowed, "Value")) {
				const text = value.text.trim();
				if (text) outputFormats.push(text);
			}
			for (const value of findChildren(param, "Value")) {
				const text = value.text.trim();
				if (text) outputFormats.push(text);
			}
		}
		const immutableMethods = Object.freeze([...new Set(methods)]);
		const immutableOutputFormats = Object.freeze([...outputFormats]);
		operations.set(name, Object.freeze({
			name,
			methods: immutableMethods,
			outputFormats: immutableOutputFormats,
			...getUrl !== void 0 ? { getUrl } : {},
			...postUrl !== void 0 ? { postUrl } : {}
		}));
		outputFormatsByOp.set(name, immutableOutputFormats);
	}
	const featureTypeList = findChild(root, "FeatureTypeList");
	const featureTypes = [];
	if (featureTypeList) for (const ft of findChildren(featureTypeList, "FeatureType")) {
		const nameNode = findChild(ft, "Name");
		const titleNode = findChild(ft, "Title");
		const defaultCrsNode = findChild(ft, "DefaultCRS") ?? findChild(ft, "DefaultSRS");
		const otherCrs = [...findChildren(ft, "OtherCRS").map((node) => node.text.trim()), ...findChildren(ft, "OtherSRS").map((node) => node.text.trim())].filter((value) => value.length > 0);
		const bboxNode = findChild(ft, "WGS84BoundingBox");
		const lowerCorner = bboxNode ? findChild(bboxNode, "LowerCorner") : void 0;
		const upperCorner = bboxNode ? findChild(bboxNode, "UpperCorner") : void 0;
		const namespace = nameNode ? namespaceBindingForQName(nameNode, nameNode.text.trim()) : void 0;
		const entry = {
			name: nameNode?.text.trim() ?? "",
			otherCrs: Object.freeze([...otherCrs]),
			...namespace ? { namespace } : {}
		};
		if (titleNode?.text) entry.title = titleNode.text.trim();
		if (defaultCrsNode?.text) entry.defaultCrs = defaultCrsNode.text.trim();
		if (lowerCorner && upperCorner) {
			const [xmin, ymin] = lowerCorner.text.trim().split(/\s+/).map(Number);
			const [xmax, ymax] = upperCorner.text.trim().split(/\s+/).map(Number);
			if (Number.isFinite(xmin) && Number.isFinite(ymin) && Number.isFinite(xmax) && Number.isFinite(ymax)) entry.wgs84BoundingBox = Object.freeze({
				xmin,
				ymin,
				xmax,
				ymax
			});
		}
		if (entry.name) featureTypes.push(Object.freeze(entry));
	}
	const filterCapabilities = parseFilterCapabilities(findChild(root, "Filter_Capabilities"));
	const storedQueryNames = parseStoredQueryNames(root);
	const namespaces = /* @__PURE__ */ new Map();
	for (const [name, value] of Object.entries(root.attributes)) if (name.startsWith("xmlns:") && value) namespaces.set(name.slice(6), value);
	return Object.freeze({
		...version ? { version } : {},
		operations: immutableMap(operations),
		outputFormatsByOp: immutableMap(outputFormatsByOp),
		featureTypes: Object.freeze([...featureTypes]),
		namespaces: immutableMap(namespaces),
		filterCapabilities: immutableFilterCapabilities(filterCapabilities),
		storedQueryNames: Object.freeze([...storedQueryNames])
	});
}
function namespaceBindingForQName(node, qname) {
	const separator = qname.indexOf(":");
	if (separator <= 0 || separator === qname.length - 1 || qname.indexOf(":", separator + 1) !== -1) return;
	const prefix = qname.slice(0, separator);
	return Object.freeze({
		prefix,
		uri: node.namespaces[prefix] ?? ""
	});
}
function immutableMap(source) {
	const owned = new Map(source);
	const view = {
		get size() {
			return owned.size;
		},
		get(key) {
			return owned.get(key);
		},
		has(key) {
			return owned.has(key);
		},
		forEach(callbackfn, thisArg) {
			for (const [key, value] of owned) callbackfn.call(thisArg, value, key, view);
		},
		entries() {
			return owned.entries();
		},
		keys() {
			return owned.keys();
		},
		values() {
			return owned.values();
		},
		[Symbol.iterator]() {
			return owned[Symbol.iterator]();
		}
	};
	return Object.freeze(view);
}
function immutableFilterCapabilities(value) {
	return Object.freeze({
		spatial: Object.freeze([...value.spatial]),
		scalar: Object.freeze([...value.scalar]),
		temporal: Object.freeze([...value.temporal])
	});
}
/**
* Parse an `ows:ExceptionReport` document into structured fields. Used when
* the client sees a non-200 response carrying an XML body or when a
* GetCapabilities call returns an ExceptionReport.
*/
function parseWfsExceptionReport(xml) {
	const root = parseXml(xml);
	if (root.local !== "ExceptionReport") throw new Error(`WFS ExceptionReport: expected <ExceptionReport>, got <${root.qname}>`);
	return parseExceptionFromRoot(root);
}
function parseExceptionFromRoot(root) {
	const exception = findChild(root, "Exception");
	if (!exception) return {
		exceptionCode: "UnknownException",
		message: "ExceptionReport without <Exception>"
	};
	const code = exception.attributes.exceptionCode ?? "UnknownException";
	const locator = exception.attributes.locator;
	const text = findChild(exception, "ExceptionText");
	const out = {
		exceptionCode: code,
		message: (text ? text.text.trim() : "") || code
	};
	if (locator) out.locator = locator;
	return out;
}
function parseFilterCapabilities(node) {
	if (!node) return {
		spatial: [],
		scalar: [],
		temporal: []
	};
	const spatial = [];
	const scalar = [];
	const temporal = [];
	const spatialOps = findChild(findChild(node, "Spatial_Capabilities"), "SpatialOperators");
	if (spatialOps) {
		for (const op of findChildren(spatialOps, "SpatialOperator")) if (op.attributes.name) spatial.push(op.attributes.name);
	}
	const scalarOps = findChild(findChild(node, "Scalar_Capabilities"), "ComparisonOperators");
	if (scalarOps) for (const op of findChildren(scalarOps, "ComparisonOperator")) {
		const text = op.text.trim();
		if (text) scalar.push(text);
	}
	const temporalOps = findChild(findChild(node, "Temporal_Capabilities"), "TemporalOperators");
	if (temporalOps) {
		for (const op of findChildren(temporalOps, "TemporalOperator")) if (op.attributes.name) temporal.push(op.attributes.name);
	}
	return {
		spatial,
		scalar,
		temporal
	};
}
function parseStoredQueryNames(root) {
	const stored = findChild(root, "StoredQueries");
	if (!stored) return [];
	const ids = [];
	for (const sq of findChildren(stored, "StoredQuery")) if (sq.attributes.id) ids.push(sq.attributes.id);
	return ids;
}
/**
* Parse the `ListStoredQueriesResponse` body — a flat list of
* `<wfs:StoredQuery id="...">` elements. Returned by `HonuaWfs.storedQueries()`.
*/
function parseListStoredQueriesResponse(xml) {
	const root = parseXml(xml);
	if (root.local !== "ListStoredQueriesResponse") {
		if (root.local === "ExceptionReport") {
			const report = parseExceptionFromRoot(root);
			throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
		}
		throw new Error(`WFS ListStoredQueries: expected <ListStoredQueriesResponse>, got <${root.qname}>`);
	}
	const ids = [];
	for (const sq of findChildren(root, "StoredQuery")) if (sq.attributes.id) ids.push(sq.attributes.id);
	return ids;
}
/**
* GML property types that carry a geometry value. A `DescribeFeatureType`
* XSD names the feature type's geometry property through one of these, so the
* set is what lets the adapter resolve the real property name per server
* (`the_geom` on PostGIS-via-GeoServer, `msGeometry` on MapServer, arbitrary
* per-schema names elsewhere) instead of assuming one vendor default.
*/
var GML_GEOMETRY_PROPERTY_TYPES = new Set([
	"GeometryPropertyType",
	"GeometryAssociationType",
	"GeometryArrayPropertyType",
	"MultiGeometryPropertyType",
	"AbstractGeometryType",
	"PointPropertyType",
	"MultiPointPropertyType",
	"LineStringPropertyType",
	"MultiLineStringPropertyType",
	"CurvePropertyType",
	"MultiCurvePropertyType",
	"PolygonPropertyType",
	"MultiPolygonPropertyType",
	"SurfacePropertyType",
	"MultiSurfacePropertyType",
	"SolidPropertyType",
	"MultiSolidPropertyType"
]);
/** GML namespace prefixes bind to a URI under this root in every GML version. */
var GML_NAMESPACE_ROOT = "http://www.opengis.net/gml";
/**
* Parse a `DescribeFeatureType` XSD and return the geometry property names
* declared for `typeName`, in schema declaration order. Empty when the schema
* declares no GML geometry property (schema-less / non-spatial types) — the
* caller fails closed rather than guessing a vendor default.
*
* Only the requested feature type's own complex type is walked, so a schema
* carrying several types cannot leak another type's geometry property.
*/
function parseWfsDescribeFeatureTypeGeometry(xml, typeName) {
	const root = parseXml(xml);
	if (root.local !== "schema") {
		if (root.local === "ExceptionReport") {
			const report = parseExceptionFromRoot(root);
			throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
		}
		throw new Error(`WFS DescribeFeatureType: expected <schema>, got <${root.qname}>`);
	}
	const declaration = findFeatureTypeDeclaration(root, stripPrefix(typeName));
	if (!declaration) return Object.freeze([]);
	const names = [];
	collectGeometryPropertyNames(declaration, names);
	return Object.freeze(names);
}
/**
* Locate the complex type that declares one feature type's properties. Servers
* spell this three ways: a global `<element name="lot" type="ns:lotType"/>`
* pointing at a named `<complexType>`, an inline anonymous `<complexType>` on
* that element, or (single-type responses) just the one complex type in the
* document.
*/
function findFeatureTypeDeclaration(root, localTypeName) {
	const complexTypes = findChildren(root, "complexType");
	const element = findChildren(root, "element").find((node) => node.attributes.name === localTypeName);
	if (element) {
		const typeRef = element.attributes.type;
		const named = typeRef ? complexTypes.find((node) => node.attributes.name === stripPrefix(typeRef)) : findChild(element, "complexType");
		if (named) return named;
	}
	const conventional = complexTypes.find((node) => node.attributes.name === `${localTypeName}Type`);
	if (conventional) return conventional;
	return complexTypes.length === 1 ? complexTypes[0] : void 0;
}
function collectGeometryPropertyNames(node, out) {
	for (const child of node.children) {
		if (child.local === "element") {
			const name = child.attributes.name;
			const type = child.attributes.type;
			if (name && type && isGmlGeometryPropertyType(child, type)) {
				out.push(name);
				continue;
			}
		}
		collectGeometryPropertyNames(child, out);
	}
}
function isGmlGeometryPropertyType(node, type) {
	const colon = type.indexOf(":");
	const prefix = colon > 0 ? type.slice(0, colon) : void 0;
	if (!GML_GEOMETRY_PROPERTY_TYPES.has(stripPrefix(type))) return false;
	const uri = prefix === void 0 ? void 0 : node.namespaces[prefix];
	return uri === void 0 || uri.startsWith(GML_NAMESPACE_ROOT);
}
function parseWfsTransactionResponse(xml) {
	const root = parseXml(xml);
	if (root.local !== "TransactionResponse") {
		if (root.local === "ExceptionReport") {
			const report = parseExceptionFromRoot(root);
			throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
		}
		throw new Error(`WFS Transaction: expected <TransactionResponse>, got <${root.qname}>`);
	}
	const summary = findChild(root, "TransactionSummary");
	const totalInserted = summary ? parseIntOrZero(findChild(summary, "totalInserted")?.text) : 0;
	const totalUpdated = summary ? parseIntOrZero(findChild(summary, "totalUpdated")?.text) : 0;
	const totalDeleted = summary ? parseIntOrZero(findChild(summary, "totalDeleted")?.text) : 0;
	const insertResultsNode = findChild(root, "InsertResults");
	const insertResults = [];
	if (insertResultsNode) for (const feature of findChildren(insertResultsNode, "Feature")) {
		const handle = feature.attributes.handle;
		const ids = [];
		for (const ref of findChildren(feature, "ResourceId")) if (ref.attributes.rid) ids.push(ref.attributes.rid);
		for (const ref of findChildren(feature, "FeatureId")) if (ref.attributes.fid) ids.push(ref.attributes.fid);
		const entry = { ids };
		if (handle) entry.handle = handle;
		insertResults.push(entry);
	}
	return {
		totalInserted,
		totalUpdated,
		totalDeleted,
		insertResults
	};
}
function parseIntOrZero(value) {
	if (!value) return 0;
	const n = Number(value.trim());
	return Number.isFinite(n) ? Math.trunc(n) : 0;
}
/**
* Parse a small, well-formed XML document into an in-memory tree. The walker
* intentionally does not try to be a full XML 1.0 parser — it covers the
* subset that WFS / OWS ExceptionReport / ListStoredQueries / Transaction
* documents actually emit.
*
* Hard-fail on `<!DOCTYPE` / `<!ENTITY` / `<!--` declarations involving
* external IDs to defend against XXE.
*/
function parseXml(xml) {
	if (typeof xml !== "string" || xml.length === 0) throw new Error("WFS XML parser: empty document");
	if (utf8Length$1(xml) > WFS_XML_LIMITS.maxBytes) throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxBytes}-byte limit`);
	const lower = xml.toLowerCase();
	if (lower.includes("<!doctype") || lower.includes("<!entity")) throw new Error("WFS XML parser: DOCTYPE / ENTITY declarations are rejected");
	const stripped = stripPrologAndComments(xml);
	const len = stripped.length;
	let i = 0;
	const stack = [];
	let root;
	const budget = {
		elements: 0,
		textBytes: 0
	};
	while (i < len) {
		if (stripped[i] === "<") {
			if (stripped.startsWith("<?", i)) {
				const end = stripped.indexOf("?>", i + 2);
				if (end === -1) throw new Error("WFS XML parser: unterminated processing instruction");
				i = end + 2;
				continue;
			}
			if (stripped.startsWith("<!--", i)) {
				const end = stripped.indexOf("-->", i + 4);
				if (end === -1) throw new Error("WFS XML parser: unterminated comment");
				i = end + 3;
				continue;
			}
			if (stripped.startsWith("<![CDATA[", i)) {
				const end = stripped.indexOf("]]>", i + 9);
				if (end === -1) throw new Error("WFS XML parser: unterminated CDATA");
				const text = stripped.slice(i + 9, end);
				const top = stack[stack.length - 1];
				if (top) appendXmlText(top, text, budget);
				i = end + 3;
				continue;
			}
			if (stripped[i + 1] === "/") {
				const end = stripped.indexOf(">", i + 2);
				if (end === -1) throw new Error("WFS XML parser: unterminated closing tag");
				const closing = stripped.slice(i + 2, end).trim();
				const top = stack[stack.length - 1];
				if (!top) throw new Error(`WFS XML parser: stray closing tag </${closing}>`);
				if (top.qname !== closing) throw new Error(`WFS XML parser: mismatched closing tag </${closing}> (expected </${top.qname}>)`);
				stack.pop();
				i = end + 1;
				continue;
			}
			const end = findTagEnd$1(stripped, i);
			if (end === -1) throw new Error("WFS XML parser: unterminated opening tag");
			const inner = stripped.slice(i + 1, end);
			const selfClosing = inner.endsWith("/");
			const { name, attributes } = parseTagBody(selfClosing ? inner.slice(0, -1).trim() : inner.trim());
			budget.elements += 1;
			if (budget.elements > WFS_XML_LIMITS.maxElements) throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxElements}-element limit`);
			if (stack.length + 1 > WFS_XML_LIMITS.maxDepth) throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxDepth}-level depth limit`);
			const local = stripPrefix(name);
			const parent = stack[stack.length - 1];
			const namespaces = Object.assign(Object.create(null), parent?.namespaces);
			for (const [attributeName, value] of Object.entries(attributes)) if (attributeName === "xmlns") namespaces[""] = value;
			else if (attributeName.startsWith("xmlns:")) namespaces[attributeName.slice(6)] = value;
			const node = {
				local,
				qname: name,
				attributes,
				namespaces,
				children: [],
				text: ""
			};
			if (parent) parent.children.push(node);
			else if (root) throw new Error("WFS XML parser: multiple root elements");
			else root = node;
			if (!selfClosing) stack.push(node);
			i = end + 1;
			continue;
		}
		const next = stripped.indexOf("<", i);
		const text = stripped.slice(i, next === -1 ? len : next);
		const top = stack[stack.length - 1];
		if (top) appendXmlText(top, decodeXmlEntities(text), budget);
		i = next === -1 ? len : next;
	}
	if (stack.length > 0) throw new Error(`WFS XML parser: unclosed element <${stack[stack.length - 1].qname}>`);
	if (!root) throw new Error("WFS XML parser: no root element");
	return root;
}
function stripPrologAndComments(xml) {
	let out = xml;
	if (out.charCodeAt(0) === 65279) out = out.slice(1);
	return out.trim();
}
function findTagEnd$1(xml, start) {
	let i = start + 1;
	let quote;
	while (i < xml.length) {
		const ch = xml[i];
		if (quote) {
			if (ch === quote) quote = void 0;
		} else if (ch === "\"" || ch === "'") quote = ch;
		else if (ch === ">") return i;
		i += 1;
	}
	return -1;
}
function parseTagBody(body) {
	const trimmed = body.trim();
	if (!trimmed) throw new Error("WFS XML parser: empty tag");
	let i = 0;
	while (i < trimmed.length && !/\s/.test(trimmed[i])) i += 1;
	const name = trimmed.slice(0, i);
	if (!name) throw new Error("WFS XML parser: missing tag name");
	const attributes = Object.create(null);
	let attributeCount = 0;
	let attributeBytes = 0;
	let j = i;
	while (j < trimmed.length) {
		while (j < trimmed.length && /\s/.test(trimmed[j])) j += 1;
		if (j >= trimmed.length) break;
		const eq = trimmed.indexOf("=", j);
		if (eq === -1) throw new Error("WFS XML parser: attribute lacks '='");
		const attrName = trimmed.slice(j, eq).trim();
		if (attrName.length === 0 || /\s/.test(attrName)) throw new Error("WFS XML parser: invalid attribute name");
		attributeCount += 1;
		if (attributeCount > WFS_XML_LIMITS.maxAttributesPerElement) throw new Error("WFS XML parser: element exceeds the bounded attribute count");
		let k = eq + 1;
		while (k < trimmed.length && /\s/.test(trimmed[k])) k += 1;
		const quote = trimmed[k];
		if (quote !== "\"" && quote !== "'") throw new Error(`WFS XML parser: attribute "${attrName}" must be quoted`);
		const close = trimmed.indexOf(quote, k + 1);
		if (close === -1) throw new Error(`WFS XML parser: unterminated attribute value for "${attrName}"`);
		const rawValue = trimmed.slice(k + 1, close);
		const normalizedName = attrName.startsWith("xmlns:") ? attrName : stripPrefix(attrName);
		const value = decodeXmlEntities(rawValue);
		attributeBytes += utf8Length$1(attrName) + utf8Length$1(value);
		if (attributeBytes > WFS_XML_LIMITS.maxAttributeBytesPerElement) throw new Error("WFS XML parser: element exceeds the bounded attribute-byte limit");
		if (Object.hasOwn(attributes, normalizedName)) throw new Error(`WFS XML parser: repeated attribute "${normalizedName}"`);
		attributes[normalizedName] = value;
		j = close + 1;
	}
	return {
		name,
		attributes
	};
}
function appendXmlText(node, value, budget) {
	if (value.length === 0) return;
	budget.textBytes += utf8Length$1(value);
	if (budget.textBytes > WFS_XML_LIMITS.maxTextBytes) throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxTextBytes}-byte text limit`);
	node.text += value;
}
function utf8Length$1(value) {
	return new TextEncoder().encode(value).byteLength;
}
function stripPrefix(name) {
	const idx = name.indexOf(":");
	return idx === -1 ? name : name.slice(idx + 1);
}
function decodeXmlEntities(text) {
	if (!text.includes("&")) return text;
	return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}
function findChild(node, local) {
	if (!node) return void 0;
	for (const child of node.children) if (child.local === local) return child;
}
function findChildOrThrow(node, local) {
	const found = findChild(node, local);
	if (!found) throw new Error(`WFS XML parser: missing child <${local}> on <${node.qname}>`);
	return found;
}
function findChildren(node, local) {
	if (!node) return [];
	return node.children.filter((c) => c.local === local);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wfs-protocol-error.js
/** Typed, credential-safe fail-closed WFS protocol error. */
var HonuaWfsProtocolError = class extends HonuaSdkError {
	reason;
	constructor(reason, message, options = {}) {
		super("query.execution.wfs-protocol", message, {
			context: { reason },
			..."cause" in options ? { cause: options.cause } : {}
		});
		this.reason = reason;
		this.name = "HonuaWfsProtocolError";
	}
};
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wfs.js
/**
* Runtime classes for the WFS 2.0 adapter. Three layers:
*
*   - `HonuaWfs` — root handle bound to a WFS endpoint URL. Owns the
*     capabilities cache and exposes feature-type / stored-query factories.
*   - `HonuaWfsFeatureType` — bound to a single namespace-qualified type
*     name. Implements GetFeature / GetPropertyValue / Transaction; routed
*     from `Source.protocol("wfs")`.
*   - `HonuaWfsStoredQuery` — bound to a stored-query identifier. Used by
*     `Source.protocol("wfs").storedQuery(id)`.
*
* All wire calls go through `HonuaClient.requestText`, so the existing
* interceptor / retry / timeout pipeline applies.
*
* Canonical translation (KVP and FES emission, GeoJSON ↔ canonical
* envelope, etc.) lives in `src/contract/source.ts`'s `wfsSource` factory;
* this module only carries the wire-level surface.
*
* @module
*/
var DEFAULT_VERSION = "2.0.0";
var SERVICE_PARAM = "WFS";
var WFS_METADATA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var WFS_FEATURE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Output formats (lower-cased) the canonical adapter treats as JSON. */
var JSON_OUTPUT_FORMATS = new Set([
	"application/json",
	"application/geo+json",
	"application/vnd.geo+json",
	"json",
	"geojson"
]);
/** Output formats (lower-cased) the canonical adapter treats as GML. */
var GML_OUTPUT_FORMATS = new Set([
	"application/gml+xml; version=3.2",
	"application/gml+xml;version=3.2",
	"application/gml+xml",
	"gml3.2",
	"gml32",
	"text/xml; subtype=gml/3.2",
	"text/xml;subtype=gml/3.2",
	"text/xml; subtype=gml/3.2.1",
	"text/xml;subtype=gml/3.2.1"
]);
var CAPABILITIES_STATES = /* @__PURE__ */ new WeakMap();
/**
* Root WFS handle. Holds the capabilities cache and exposes feature-type /
* stored-query factories.
*/
var HonuaWfs = class {
	client;
	endpointUrl;
	version;
	/** Counter exposed for tests / diagnostics: how many times capabilities was fetched. */
	capabilitiesFetches = 0;
	rawCapabilitiesXml;
	resolvedSnapshot;
	/** Resolved geometry property per feature type; shares the metadata cache lifecycle. */
	geometryPropertyNames = /* @__PURE__ */ new Map();
	constructor(options) {
		this.client = options.client;
		this.endpointUrl = options.endpointUrl;
		this.version = options.version ?? DEFAULT_VERSION;
		CAPABILITIES_STATES.set(this, { generation: 0 });
	}
	/**
	* Fetch and cache the GetCapabilities document. Subsequent calls reuse the
	* parsed snapshot. Throws `HonuaWfsExceptionError` on `<ows:ExceptionReport>`.
	*/
	async capabilities(options) {
		if (options?.signal?.aborted) throw new HonuaAbortError();
		if (this.resolvedSnapshot) return this.resolvedSnapshot;
		const state = capabilitiesState(this);
		const generation = state.generation;
		let flight = state.flight;
		if (!flight || flight.generation !== generation) {
			const identity = {};
			const controller = new AbortController();
			const promise = this.fetchCapabilities({ signal: controller.signal }).then((fetched) => {
				if (state.generation === generation && state.flight?.identity === identity) {
					this.rawCapabilitiesXml = fetched.xml;
					this.resolvedSnapshot = fetched.snapshot;
				}
				return fetched.snapshot;
			});
			const nextFlight = {
				generation,
				identity,
				controller,
				promise,
				subscribers: 0,
				settled: false
			};
			flight = nextFlight;
			state.flight = nextFlight;
			promise.then(() => {
				nextFlight.settled = true;
				if (state.flight === nextFlight) state.flight = void 0;
			}, () => {
				nextFlight.settled = true;
				if (state.flight === nextFlight) state.flight = void 0;
			});
		}
		return subscribeCapabilitiesFlight(state, flight, options?.signal);
	}
	/** Discard the cached capabilities snapshot so the next call re-fetches. */
	refresh() {
		const state = capabilitiesState(this);
		state.generation += 1;
		const staleFlight = state.flight;
		state.flight = void 0;
		this.rawCapabilitiesXml = void 0;
		this.resolvedSnapshot = void 0;
		this.geometryPropertyNames.clear();
		if (staleFlight && !staleFlight.settled) staleFlight.controller.abort();
	}
	/**
	* Fetch the `DescribeFeatureType` XSD for one feature type. Returned raw so
	* `Source.protocol("wfs")` callers can read schema detail the canonical
	* surface does not model.
	*/
	async describeFeatureType(typeName, options) {
		const params = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.version,
			request: "DescribeFeatureType",
			typeNames: typeName
		});
		const requestOptions = {
			accept: "application/xml, text/xml",
			maxResponseBytes: WFS_METADATA_MAX_RESPONSE_BYTES
		};
		if (options?.signal) requestOptions.signal = options.signal;
		const { text, contentType } = await this.requestText("GET", appendQuery(this.operationUrl("DescribeFeatureType", "GET"), params), requestOptions);
		return {
			text,
			contentType
		};
	}
	/**
	* Resolve the geometry property name of one feature type from its
	* `DescribeFeatureType` schema, caching the result alongside the
	* capabilities snapshot. Fails closed with
	* `HonuaWfsProtocolError("unresolved-geometry-property")` rather than
	* assuming a vendor default: `the_geom` is only the PostGIS-via-GeoServer
	* convention, MapServer serves `msGeometry`, and other servers use
	* per-schema names, so guessing silently matches nothing.
	*
	* Feature types that declare several geometry properties resolve to the
	* first declared one (the server's default geometry); pin a different one
	* with `locator.geometryName`.
	*/
	async geometryPropertyName(typeName, options) {
		const cached = this.geometryPropertyNames.get(typeName);
		if (cached !== void 0) return cached;
		let candidates;
		try {
			const { text } = await this.describeFeatureType(typeName, options);
			candidates = parseWfsDescribeFeatureTypeGeometry(text, typeName);
		} catch (error) {
			if (error instanceof HonuaAbortError) throw error;
			throw new HonuaWfsProtocolError("unresolved-geometry-property", `WFS DescribeFeatureType could not resolve the geometry property of feature type "${typeName}"; set locator.geometryName to name it explicitly`, { cause: error });
		}
		const resolved = candidates[0];
		if (resolved === void 0) throw new HonuaWfsProtocolError("unresolved-geometry-property", `WFS DescribeFeatureType declares no geometry property for feature type "${typeName}"; set locator.geometryName to name it explicitly`);
		this.geometryPropertyNames.set(typeName, resolved);
		return resolved;
	}
	/**
	* Resolve the concrete request URL for a WFS operation, honouring the
	* DCP `xlink:href` a raw server advertises in GetCapabilities (e.g.
	* GeoServer mounted at `/geoserver/ows` that advertises its operation
	* URL at `/geoserver/wfs`). Falls back to the configured endpoint URL
	* when capabilities have not been resolved yet or the server omits the
	* DCP href. This peeks at the already-resolved snapshot synchronously,
	* so it never forces an extra GetCapabilities round-trip: the canonical
	* WFS query path resolves capabilities for output-format negotiation
	* before issuing GetFeature.
	*/
	operationUrl(operation, method) {
		const op = this.resolvedSnapshot?.operations.get(operation);
		return (method === "GET" ? op?.getUrl : op?.postUrl) ?? this.endpointUrl;
	}
	/** Last raw capabilities XML payload (populated after the first fetch). */
	rawCapabilities() {
		return this.rawCapabilitiesXml;
	}
	/** Bind a feature-type handle. Does not network. */
	featureType(typeName) {
		return new HonuaWfsFeatureType({
			root: this,
			typeName
		});
	}
	/**
	* Discover stored queries through the `ListStoredQueries` operation. Returns
	* the bare list of identifier strings; per-query metadata is exposed via
	* `storedQuery(id).describe()`.
	*/
	async storedQueries(options) {
		const params = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.version,
			request: "ListStoredQueries"
		});
		const requestOptions = {
			accept: "application/xml, text/xml",
			maxResponseBytes: WFS_METADATA_MAX_RESPONSE_BYTES
		};
		if (options?.signal) requestOptions.signal = options.signal;
		const { text } = await this.requestText("GET", appendQuery(this.endpointUrl, params), requestOptions);
		return parseListStoredQueriesResponse(text);
	}
	storedQuery(id) {
		return new HonuaWfsStoredQuery({
			root: this,
			id
		});
	}
	/** Internal helper used by feature-type / stored-query handles. */
	async requestText(method, path, options) {
		try {
			const requestOptions = {
				accept: options.accept,
				maxResponseBytes: options.maxResponseBytes ?? WFS_METADATA_MAX_RESPONSE_BYTES
			};
			if (options.contentType !== void 0) requestOptions.contentType = options.contentType;
			if (options.body !== void 0) requestOptions.body = options.body;
			if (options.signal !== void 0) requestOptions.signal = options.signal;
			return await this.client.requestText(method, path, requestOptions);
		} catch (err) {
			throw rethrowAsWfsExceptionIfPossible(err);
		}
	}
	/** Negotiate an output format for the GetFeature call. */
	negotiateOutputFormat(snapshot) {
		const formats = snapshot.outputFormatsByOp.get("GetFeature") ?? [];
		for (const format of formats) if (JSON_OUTPUT_FORMATS.has(format.toLowerCase())) return {
			kind: "json",
			format
		};
		for (const format of formats) if (GML_OUTPUT_FORMATS.has(format.toLowerCase())) return {
			kind: "gml",
			format
		};
		if (formats.length === 0) return {
			kind: "json",
			format: "application/geo+json"
		};
		return {
			kind: "gml",
			format: formats[0]
		};
	}
	async fetchCapabilities(options) {
		this.capabilitiesFetches += 1;
		const params = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.version,
			request: "GetCapabilities"
		});
		const requestOptions = {
			accept: "application/xml, text/xml",
			maxResponseBytes: WFS_METADATA_MAX_RESPONSE_BYTES
		};
		if (options?.signal) requestOptions.signal = options.signal;
		const { text } = await this.requestText("GET", appendQuery(this.endpointUrl, params), requestOptions);
		return {
			snapshot: canonicalizeOperationUrls(parseWfsCapabilities(text), this.endpointUrl, this.client.serverBaseUrl),
			xml: text
		};
	}
};
function capabilitiesState(root) {
	const state = CAPABILITIES_STATES.get(root);
	if (!state) throw new TypeError("WFS capabilities state is unavailable");
	return state;
}
function subscribeCapabilitiesFlight(state, flight, signal) {
	flight.subscribers += 1;
	return new Promise((resolve, reject) => {
		let finished = false;
		const finish = () => {
			if (finished) return false;
			finished = true;
			signal?.removeEventListener("abort", onCallerAbort);
			flight.controller.signal.removeEventListener("abort", onGenerationAbort);
			flight.subscribers -= 1;
			return true;
		};
		const abortOrphanedFlight = () => {
			if (flight.settled || flight.subscribers !== 0 || flight.controller.signal.aborted) return;
			if (state.flight === flight) state.flight = void 0;
			flight.controller.abort();
		};
		const onCallerAbort = () => {
			if (!finish()) return;
			reject(new HonuaAbortError());
			abortOrphanedFlight();
		};
		const onGenerationAbort = () => {
			if (!finish()) return;
			reject(new HonuaAbortError("WFS capabilities discovery was invalidated"));
		};
		signal?.addEventListener("abort", onCallerAbort, { once: true });
		flight.controller.signal.addEventListener("abort", onGenerationAbort, { once: true });
		if (signal?.aborted) onCallerAbort();
		else if (flight.controller.signal.aborted) onGenerationAbort();
		flight.promise.then((snapshot) => {
			if (!finish()) return;
			resolve(snapshot);
		}, (error) => {
			if (!finish()) return;
			reject(error);
		});
	});
}
function canonicalizeOperationUrls(snapshot, endpointUrl, clientBaseUrl) {
	const capabilitiesEndpoint = new URL(endpointUrl, clientBaseUrl);
	const operations = new Map([...snapshot.operations].map(([name, operation]) => [name, Object.freeze({
		...operation,
		...operation.getUrl ? { getUrl: new URL(operation.getUrl, capabilitiesEndpoint).toString() } : {},
		...operation.postUrl ? { postUrl: new URL(operation.postUrl, capabilitiesEndpoint).toString() } : {}
	})]));
	return Object.freeze({
		...snapshot,
		operations: immutableWfsMap(operations)
	});
}
function immutableWfsMap(source) {
	const owned = new Map(source);
	const view = {
		get size() {
			return owned.size;
		},
		get(key) {
			return owned.get(key);
		},
		has(key) {
			return owned.has(key);
		},
		forEach(callbackfn, thisArg) {
			for (const [key, value] of owned) callbackfn.call(thisArg, value, key, view);
		},
		entries() {
			return owned.entries();
		},
		keys() {
			return owned.keys();
		},
		values() {
			return owned.values();
		},
		[Symbol.iterator]() {
			return owned[Symbol.iterator]();
		}
	};
	return Object.freeze(view);
}
/**
* Per-feature-type WFS surface. Implements the wire methods that the
* canonical `wfsSource` translates onto, and the protocol escape-hatch
* methods that ship raw XML payloads back to callers.
*/
var HonuaWfsFeatureType = class {
	root;
	typeName;
	constructor(options) {
		this.root = options.root;
		this.typeName = options.typeName;
	}
	/** Convenience: capabilities snapshot from the bound root. */
	capabilities(options) {
		return this.root.capabilities(options);
	}
	/** Raw `DescribeFeatureType` XSD for the bound type name. */
	describeFeatureType(options) {
		return this.root.describeFeatureType(this.typeName, options);
	}
	/**
	* Geometry property name of the bound feature type, resolved from
	* `DescribeFeatureType` and cached on the root. Fails closed when the schema
	* does not name one — see {@link HonuaWfs.geometryPropertyName}.
	*/
	geometryPropertyName(options) {
		return this.root.geometryPropertyName(this.typeName, options);
	}
	/**
	* Issue a GetFeature request. Returns parsed JSON when the negotiated
	* output format is JSON; otherwise returns the raw body as a string for
	* downstream callers (the canonical surface throws in that case).
	*/
	async getFeature(params) {
		const method = params.method ?? "GET";
		const requestOptions = {
			accept: params.outputFormat ?? "application/geo+json, application/json;q=0.9, application/xml;q=0.5",
			maxResponseBytes: WFS_FEATURE_MAX_RESPONSE_BYTES
		};
		if (params.signal) requestOptions.signal = params.signal;
		let response;
		if (method === "POST" && params.body !== void 0) {
			requestOptions.contentType = "application/xml";
			requestOptions.body = params.body;
			response = await this.root.requestText("POST", this.root.operationUrl("GetFeature", "POST"), requestOptions);
		} else {
			const search = new URLSearchParams({
				service: SERVICE_PARAM,
				version: this.root.version,
				request: "GetFeature",
				typeNames: this.typeName
			});
			if (params.namespace !== void 0) search.set("NAMESPACES", `xmlns(${params.namespace.prefix},${params.namespace.uri})`);
			if (params.filter !== void 0) search.set("filter", params.filter);
			if (params.bbox !== void 0) search.set("bbox", params.bbox);
			if (params.propertyName && params.propertyName.length > 0) search.set("propertyName", params.propertyName.join(","));
			if (params.sortBy !== void 0) search.set("sortBy", params.sortBy);
			if (typeof params.count === "number") search.set("count", String(params.count));
			if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
			if (params.resultType !== void 0) search.set("resultType", params.resultType);
			if (params.srsName !== void 0) search.set("srsName", params.srsName);
			if (params.outputFormat !== void 0) search.set("outputFormat", params.outputFormat);
			response = await this.root.requestText("GET", appendQuery(this.root.operationUrl("GetFeature", "GET"), search), requestOptions);
		}
		if (looksLikeJson(response.contentType, response.text)) return {
			kind: "json",
			data: parseJsonOrThrow(response.text),
			contentType: response.contentType
		};
		if (looksLikeXml(response.contentType, response.text) && /ExceptionReport/i.test(response.text)) {
			const report = parseWfsExceptionReport(response.text);
			throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
		}
		return {
			kind: "raw",
			text: response.text,
			contentType: response.contentType
		};
	}
	/**
	* Issue a `GetPropertyValue` request. WFS-specific (returns raw XML), so
	* the canonical surface only reaches it via `protocol("wfs")`.
	*/
	async getPropertyValue(params) {
		const search = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.root.version,
			request: "GetPropertyValue",
			typeNames: this.typeName,
			valueReference: params.valueReference
		});
		if (params.filter !== void 0) search.set("filter", params.filter);
		if (typeof params.count === "number") search.set("count", String(params.count));
		if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
		const requestOptions = {
			accept: "application/xml, text/xml",
			maxResponseBytes: WFS_FEATURE_MAX_RESPONSE_BYTES
		};
		if (params.signal) requestOptions.signal = params.signal;
		const { text, contentType } = await this.root.requestText("GET", appendQuery(this.root.endpointUrl, search), requestOptions);
		return {
			text,
			contentType
		};
	}
	/**
	* Submit a `<wfs:Transaction>` POST body. Returns the parsed transaction
	* summary; throws `HonuaWfsExceptionError` on `<ows:ExceptionReport>`.
	*/
	async transaction(params) {
		const requestOptions = {
			accept: "application/xml, text/xml",
			contentType: "application/xml",
			body: params.body
		};
		if (params.signal) requestOptions.signal = params.signal;
		const { text } = await this.root.requestText("POST", this.root.operationUrl("Transaction", "POST"), requestOptions);
		return parseWfsTransactionResponse(text);
	}
	/** Build (but do not send) the URL the GET GetFeature request would use. */
	buildGetFeatureUrl(params) {
		const search = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.root.version,
			request: "GetFeature",
			typeNames: this.typeName
		});
		if (params.filter !== void 0) search.set("filter", params.filter);
		if (params.bbox !== void 0) search.set("bbox", params.bbox);
		if (typeof params.count === "number") search.set("count", String(params.count));
		if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
		if (params.outputFormat !== void 0) search.set("outputFormat", params.outputFormat);
		if (params.namespace !== void 0) search.set("NAMESPACES", `xmlns(${params.namespace.prefix},${params.namespace.uri})`);
		return appendQuery(this.root.endpointUrl, search);
	}
};
/**
* Bound stored-query handle. `execute(params)` runs `GetFeature?storedquery_id=…`.
*/
var HonuaWfsStoredQuery = class {
	root;
	id;
	constructor(options) {
		this.root = options.root;
		this.id = options.id;
	}
	/** Run `DescribeStoredQueries` for this stored query. Returns the raw XML. */
	async describe(options) {
		const search = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.root.version,
			request: "DescribeStoredQueries",
			storedQuery_Id: this.id
		});
		const requestOptions = { accept: "application/xml, text/xml" };
		if (options?.signal) requestOptions.signal = options.signal;
		const { text, contentType } = await this.root.requestText("GET", appendQuery(this.root.endpointUrl, search), requestOptions);
		return {
			text,
			contentType
		};
	}
	/**
	* Execute the stored query against `GetFeature`. Caller passes the
	* stored-query parameter map; values are coerced to strings via
	* `String(value)`. Returns parsed JSON when the server replies with a
	* JSON output format, raw text otherwise.
	*/
	async execute(params) {
		const search = new URLSearchParams({
			service: SERVICE_PARAM,
			version: this.root.version,
			request: "GetFeature",
			storedquery_id: this.id
		});
		if (typeof params.count === "number") search.set("count", String(params.count));
		if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
		if (params.outputFormat !== void 0) search.set("outputFormat", params.outputFormat);
		if (params.parameters) for (const [key, value] of Object.entries(params.parameters)) search.set(key, String(value));
		const requestOptions = {
			accept: params.outputFormat ?? "application/geo+json, application/json;q=0.9, application/xml;q=0.5",
			maxResponseBytes: WFS_FEATURE_MAX_RESPONSE_BYTES
		};
		if (params.signal) requestOptions.signal = params.signal;
		const { text, contentType } = await this.root.requestText("GET", appendQuery(this.root.operationUrl("GetFeature", "GET"), search), requestOptions);
		if (looksLikeJson(contentType, text)) return {
			kind: "json",
			data: parseJsonOrThrow(text),
			contentType
		};
		if (looksLikeXml(contentType, text) && /ExceptionReport/i.test(text)) {
			const report = parseWfsExceptionReport(text);
			throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
		}
		return {
			kind: "raw",
			text,
			contentType
		};
	}
};
function appendQuery(url, params) {
	return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}
function looksLikeJson(contentType, text) {
	if (contentType && /json/i.test(contentType)) return true;
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}
function looksLikeXml(contentType, text) {
	if (contentType && /xml/i.test(contentType)) return true;
	return text.trimStart().startsWith("<");
}
function parseJsonOrThrow(text) {
	try {
		return JSON.parse(text);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`WFS GetFeature returned non-JSON output despite Accept negotiation: ${message}`);
	}
}
/**
* If the underlying client failure carries a WFS ExceptionReport in its
* body, re-throw as `HonuaWfsExceptionError`; otherwise leave the original
* error in place. The body is wrapped by `parseResponseBody` as
* `{ raw: text, contentType? }` for non-JSON responses.
*/
function rethrowAsWfsExceptionIfPossible(err) {
	if (!(err instanceof HonuaHttpError)) return err;
	const body = err.body;
	if (!body || typeof body !== "object" || typeof body.raw !== "string") return err;
	const raw = body.raw;
	if (!/ExceptionReport/i.test(raw)) return err;
	try {
		const report = parseWfsExceptionReport(raw);
		return new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
	} catch {
		return err;
	}
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wms-axis.js
/**
* WMS 1.3.0 axis-order helpers, shared by the first-party WMS client path and
* the Esri-compat `WMSLayer` so both emit BBOX in the authority-defined axis
* order.
*
* Under WMS 1.3.0 the authority-defined axis order for geographic EPSG codes
* (EPSG:4326 and friends) is latitude,longitude, so the canonical
* `[minx, miny, maxx, maxy]` tuple must be transposed to
* `[miny, minx, maxy, maxx]` on the wire. WMS 1.1.1 (`SRS`) always uses
* lon,lat and must not be transposed.
*/
/**
* Geographic EPSG codes whose WMS 1.3.0 axis order is latitude,longitude.
*
* Matching only the exact string `"EPSG:4326"` would leave other authority
* lat/lon CRSes (notably ETRS89 / EPSG:4258 and NAD83 / EPSG:4269) — and even
* the URN / URL spellings of 4326 itself — transposed incorrectly. The axis
* order is derived from the CRS authority code instead.
*/
var WMS_LATLON_GEOGRAPHIC_EPSG = new Set([
	4326,
	4258,
	4269,
	4267,
	4203,
	4283,
	7844,
	4490,
	4214,
	4152,
	4759,
	4617,
	4674,
	4618,
	4612,
	4019
]);
/**
* Extract the trailing EPSG numeric code from any of the CRS spellings WMS
* clients use: `EPSG:4326`, `urn:ogc:def:crs:EPSG::4326`,
* `urn:ogc:def:crs:EPSG:8.9:4326`, and `http://www.opengis.net/def/crs/EPSG/0/4326`.
* Returns `undefined` for non-EPSG identifiers (e.g. `CRS:84`, OGC URNs).
*/
function parseEpsgCode(crs) {
	const idx = crs.toUpperCase().lastIndexOf("EPSG");
	if (idx < 0) return void 0;
	const digitGroups = crs.slice(idx).match(/\d+/g);
	if (!digitGroups || digitGroups.length === 0) return void 0;
	const code = Number(digitGroups[digitGroups.length - 1]);
	return Number.isInteger(code) ? code : void 0;
}
/** Whether a WMS 1.3.0 BBOX for `crs` must be transposed to lat,lon on the wire. */
function wmsBboxRequiresAxisSwap(crs) {
	const code = parseEpsgCode(crs);
	return code !== void 0 && WMS_LATLON_GEOGRAPHIC_EPSG.has(code);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/xml-text.js
/**
* Single-pass XML text decoding used by the WMS/WMTS capabilities parsers.
*
* Decoding XML entities with a chain of independent `String.prototype.replace`
* calls is unsafe: an earlier substitution (for example `&amp;` -> `&`) can
* synthesize characters that a later substitution then re-interprets, causing
* double-unescaping (CodeQL `js/double-escaping`). Walking the input exactly
* once and emitting each decoded character directly avoids that class of bug —
* a `&` produced by decoding `&amp;` is final and never re-scanned.
*/
var NAMED_ENTITIES = {
	lt: "<",
	gt: ">",
	amp: "&",
	apos: "'",
	quot: "\""
};
var CDATA_OPEN = "<![CDATA[";
var CDATA_CLOSE = "]]>";
/**
* Decode XML character data in a single forward pass.
*
* Handles `<![CDATA[…]]>` sections (emitted verbatim), the five predefined
* named entities (`&lt;`, `&gt;`, `&amp;`, `&apos;`, `&quot;`), and numeric
* character references (`&#1234;` / `&#x1F4A9;`). Any `&` that does not begin
* a recognized reference is emitted literally.
*/
function decodeXmlText(text) {
	let result = "";
	let i = 0;
	const length = text.length;
	while (i < length) {
		const char = text[i];
		if (char === "<" && text.startsWith(CDATA_OPEN, i)) {
			const end = text.indexOf(CDATA_CLOSE, i + 9);
			if (end < 0) {
				result += text.slice(i + 9);
				break;
			}
			result += text.slice(i + 9, end);
			i = end + 3;
			continue;
		}
		if (char === "&") {
			const semicolon = text.indexOf(";", i + 1);
			if (semicolon > i) {
				const decoded = decodeEntity(text.slice(i + 1, semicolon));
				if (decoded !== void 0) {
					result += decoded;
					i = semicolon + 1;
					continue;
				}
			}
		}
		result += char;
		i += 1;
	}
	return result;
}
function decodeEntity(entity) {
	const named = NAMED_ENTITIES[entity];
	if (named !== void 0) return named;
	if (entity.length >= 2 && entity.charCodeAt(0) === 35) {
		const isHex = entity.charCodeAt(1) === 120 || entity.charCodeAt(1) === 88;
		const digits = isHex ? entity.slice(2) : entity.slice(1);
		if (digits === "") return;
		const codePoint = isHex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
		if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 1114111) return;
		try {
			return String.fromCodePoint(codePoint);
		} catch {
			return;
		}
	}
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/capabilities-xml.js
/**
* Bounded XML tree used by the WMS/WMTS capabilities readers.
*
* This is deliberately not a general XML implementation. It accepts the XML
* 1.0 subset used by OGC service metadata, matches namespace-qualified names
* by their local suffix, and rejects declarations that could introduce
* external entities. Every allocation is covered by a small fixed budget so a
* capabilities response cannot turn metadata discovery into an unbounded
* parser workload.
*
* @internal
*/
var OGC_CAPABILITIES_XML_LIMITS = Object.freeze({
	maxBytes: 2 * 1024 * 1024,
	maxElements: 12e3,
	maxDepth: 32,
	maxAttributesPerElement: 64,
	maxAttributeBytes: 64 * 1024,
	maxTextBytes: 512 * 1024
});
function parseCapabilitiesXml(xml, family) {
	if (typeof xml !== "string" || xml.length === 0) throw new Error(`${family} Capabilities body is empty`);
	if (utf8Length(xml) > OGC_CAPABILITIES_XML_LIMITS.maxBytes) throw new Error(`${family} Capabilities exceeds the ${OGC_CAPABILITIES_XML_LIMITS.maxBytes}-byte XML limit`);
	const declarationProbe = xml.toLowerCase();
	if (declarationProbe.includes("<!doctype") || declarationProbe.includes("<!entity")) throw new Error(`${family} Capabilities rejects DOCTYPE and ENTITY declarations`);
	let cursor = xml.charCodeAt(0) === 65279 ? 1 : 0;
	let root;
	const stack = [];
	let elements = 0;
	while (cursor < xml.length) {
		const angle = xml.indexOf("<", cursor);
		if (angle < 0) {
			appendText(stack.at(-1), xml.slice(cursor), family);
			cursor = xml.length;
			break;
		}
		appendText(stack.at(-1), xml.slice(cursor, angle), family);
		if (xml.startsWith("<!--", angle)) {
			const end = xml.indexOf("-->", angle + 4);
			if (end < 0) throw new Error(`${family} Capabilities contains an unterminated comment`);
			cursor = end + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", angle)) {
			const end = xml.indexOf("]]>", angle + 9);
			if (end < 0) throw new Error(`${family} Capabilities contains unterminated CDATA`);
			const node = stack.at(-1);
			if (!node) throw new Error(`${family} Capabilities contains CDATA outside its root element`);
			appendDecodedText(node, xml.slice(angle + 9, end), family);
			cursor = end + 3;
			continue;
		}
		if (xml.startsWith("<?", angle)) {
			const end = xml.indexOf("?>", angle + 2);
			if (end < 0) throw new Error(`${family} Capabilities contains an unterminated processing instruction`);
			cursor = end + 2;
			continue;
		}
		if (xml.startsWith("<!", angle)) throw new Error(`${family} Capabilities contains an unsupported XML declaration`);
		const close = findTagEnd(xml, angle);
		if (close < 0) throw new Error(`${family} Capabilities contains an unterminated tag`);
		const closing = xml.charCodeAt(angle + 1) === 47;
		const rawTag = xml.slice(angle + (closing ? 2 : 1), close);
		if (rawTag.length === 0 || isWhitespace(rawTag.charCodeAt(0))) throw new Error(`${family} Capabilities contains an invalid tag`);
		const raw = trimXmlWhitespaceEnd(rawTag);
		if (closing) {
			const expected = stack.at(-1);
			if (!expected || raw !== expected.name) throw new Error(`${family} Capabilities has mismatched closing tag </${raw}>${expected ? `; expected </${expected.name}>` : ""}`);
			stack.pop();
			cursor = close + 1;
			continue;
		}
		const selfClosing = rawTag.endsWith("/");
		const { name, attributes } = parseOpeningTag(selfClosing ? trimXmlWhitespaceEnd(raw.slice(0, -1)) : raw, family);
		elements += 1;
		if (elements > OGC_CAPABILITIES_XML_LIMITS.maxElements) throw new Error(`${family} Capabilities exceeds the ${OGC_CAPABILITIES_XML_LIMITS.maxElements}-element limit`);
		if (stack.length + 1 > OGC_CAPABILITIES_XML_LIMITS.maxDepth) throw new Error(`${family} Capabilities exceeds the ${OGC_CAPABILITIES_XML_LIMITS.maxDepth}-level XML limit`);
		const node = {
			name,
			localName: localName(name),
			attributes,
			children: [],
			textChunks: [],
			textBytes: 0
		};
		const parent = stack.at(-1);
		if (parent) parent.children.push(node);
		else if (root) throw new Error(`${family} Capabilities contains multiple root elements`);
		else root = node;
		if (!selfClosing) stack.push(node);
		cursor = close + 1;
	}
	if (stack.length > 0) throw new Error(`${family} Capabilities contains an unclosed <${stack.at(-1).name}> element`);
	if (!root) throw new Error(`${family} Capabilities contains no root element`);
	return freezeElement(root);
}
function xmlChild(node, localName) {
	return node?.children.find((child) => child.localName === localName);
}
function xmlChildren(node, localName) {
	return node?.children.filter((child) => child.localName === localName) ?? [];
}
function xmlAttribute(node, name) {
	return node.attributes[name] ?? node.attributes[localName(name)];
}
function xmlText(node) {
	if (!node) return void 0;
	const value = node.text.trim();
	return value.length > 0 ? value : void 0;
}
function appendText(node, value, family) {
	if (value.length === 0) return;
	if (!node) {
		if (!isXmlWhitespaceText(value)) throw new Error(`${family} Capabilities contains text outside its root element`);
		return;
	}
	appendDecodedText(node, decodeCapabilitiesText(value, family), family);
}
function appendDecodedText(node, value, family) {
	if (value.length === 0) return;
	assertXmlCharacters(value, family);
	const valueBytes = utf8Length(value);
	if (valueBytes > OGC_CAPABILITIES_XML_LIMITS.maxTextBytes - node.textBytes) throw new Error(`${family} Capabilities element text exceeds the bounded text limit`);
	node.textBytes += valueBytes;
	node.textChunks.push(value);
}
function parseOpeningTag(body, family) {
	let cursor = 0;
	while (cursor < body.length && !isWhitespace(body.charCodeAt(cursor))) cursor += 1;
	const name = body.slice(0, cursor);
	if (!validXmlName(name)) throw new Error(`${family} Capabilities contains an invalid element name`);
	const attributes = Object.create(null);
	const attributeLocals = /* @__PURE__ */ new Set();
	let count = 0;
	while (cursor < body.length) {
		while (cursor < body.length && isWhitespace(body.charCodeAt(cursor))) cursor += 1;
		if (cursor >= body.length) break;
		const nameStart = cursor;
		while (cursor < body.length && !isWhitespace(body.charCodeAt(cursor)) && body[cursor] !== "=") cursor += 1;
		const attributeName = body.slice(nameStart, cursor);
		if (!validXmlName(attributeName)) throw new Error(`${family} Capabilities contains an invalid attribute name`);
		count += 1;
		if (count > OGC_CAPABILITIES_XML_LIMITS.maxAttributesPerElement) throw new Error(`${family} Capabilities element exceeds the bounded attribute count`);
		while (cursor < body.length && isWhitespace(body.charCodeAt(cursor))) cursor += 1;
		if (body[cursor] !== "=") throw new Error(`${family} Capabilities attribute "${attributeName}" lacks '='`);
		cursor += 1;
		while (cursor < body.length && isWhitespace(body.charCodeAt(cursor))) cursor += 1;
		const quote = body[cursor];
		if (quote !== "\"" && quote !== "'") throw new Error(`${family} Capabilities attribute "${attributeName}" must be quoted`);
		const end = body.indexOf(quote, cursor + 1);
		if (end < 0) throw new Error(`${family} Capabilities attribute "${attributeName}" is unterminated`);
		const rawValue = body.slice(cursor + 1, end);
		if (rawValue.includes("<")) throw new Error(`${family} Capabilities attribute "${attributeName}" contains an unescaped '<'`);
		const value = decodeCapabilitiesText(rawValue, family);
		if (utf8Length(value) > OGC_CAPABILITIES_XML_LIMITS.maxAttributeBytes) throw new Error(`${family} Capabilities attribute "${attributeName}" exceeds the bounded value limit`);
		if (Object.hasOwn(attributes, attributeName)) throw new Error(`${family} Capabilities repeats attribute "${attributeName}"`);
		const local = localName(attributeName);
		const namespaceDeclaration = attributeName === "xmlns" || attributeName.startsWith("xmlns:");
		if (!namespaceDeclaration && attributeLocals.has(local)) throw new Error(`${family} Capabilities repeats namespace-local attribute "${local}"`);
		attributes[attributeName] = value;
		if (!namespaceDeclaration) {
			attributeLocals.add(local);
			if (attributeName !== local) attributes[local] = value;
		}
		cursor = end + 1;
		if (cursor < body.length && !isWhitespace(body.charCodeAt(cursor))) throw new Error(`${family} Capabilities attributes must be separated by XML whitespace`);
	}
	return {
		name,
		attributes
	};
}
function decodeCapabilitiesText(value, family) {
	let cursor = 0;
	while (cursor < value.length) {
		const ampersand = value.indexOf("&", cursor);
		if (ampersand < 0) break;
		const semicolon = value.indexOf(";", ampersand + 1);
		const nestedAmpersand = value.indexOf("&", ampersand + 1);
		if (semicolon < 0 || nestedAmpersand >= 0 && nestedAmpersand < semicolon) throw new Error(`${family} Capabilities contains an unterminated XML entity reference`);
		const entity = value.slice(ampersand + 1, semicolon);
		if (!validEntityReference(entity)) throw new Error(`${family} Capabilities contains unsupported XML entity "&${entity};"`);
		cursor = semicolon + 1;
	}
	const decoded = decodeXmlText(value);
	assertXmlCharacters(decoded, family);
	return decoded;
}
function validEntityReference(entity) {
	if (entity === "lt" || entity === "gt" || entity === "amp" || entity === "apos" || entity === "quot") return true;
	const numeric = entity.startsWith("#x") || entity.startsWith("#X") ? /^[0-9A-Fa-f]+$/.test(entity.slice(2)) ? Number.parseInt(entity.slice(2), 16) : NaN : entity.startsWith("#") && /^\d+$/.test(entity.slice(1)) ? Number.parseInt(entity.slice(1), 10) : NaN;
	return Number.isSafeInteger(numeric) && validXmlCodePoint(numeric);
}
function assertXmlCharacters(value, family) {
	for (const character of value) if (!validXmlCodePoint(character.codePointAt(0))) throw new Error(`${family} Capabilities contains a character forbidden by XML 1.0`);
}
function validXmlCodePoint(value) {
	return value === 9 || value === 10 || value === 13 || value >= 32 && value <= 55295 || value >= 57344 && value <= 65533 || value >= 65536 && value <= 1114111;
}
function findTagEnd(xml, start) {
	let quote;
	for (let cursor = start + 1; cursor < xml.length; cursor += 1) {
		const value = xml[cursor];
		if (quote) {
			if (value === quote) quote = void 0;
		} else if (value === "\"" || value === "'") quote = value;
		else if (value === ">") return cursor;
	}
	return -1;
}
function validXmlName(value) {
	const parts = value.split(":");
	return parts.length <= 2 && parts.every((part) => /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(part));
}
function localName(value) {
	const separator = value.indexOf(":");
	return separator < 0 ? value : value.slice(separator + 1);
}
function isWhitespace(value) {
	return value === 32 || value === 9 || value === 10 || value === 13;
}
function isXmlWhitespaceText(value) {
	for (let index = 0; index < value.length; index += 1) if (!isWhitespace(value.charCodeAt(index))) return false;
	return true;
}
function trimXmlWhitespaceEnd(value) {
	let end = value.length;
	while (end > 0 && isWhitespace(value.charCodeAt(end - 1))) end -= 1;
	return value.slice(0, end);
}
function utf8Length(value) {
	return new TextEncoder().encode(value).byteLength;
}
function freezeElement(node) {
	const children = Object.freeze(node.children.map(freezeElement));
	return Object.freeze({
		name: node.name,
		localName: node.localName,
		attributes: Object.freeze({ ...node.attributes }),
		children,
		text: node.textChunks.join("")
	});
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wms-capabilities.js
/**
* Bounded WMS capabilities projection.
*
* The parser accepts the metadata subset needed by discovery and the WMS
* runtime, rejects malformed/active XML, and returns plain immutable-friendly
* records. Unknown vendor extensions are ignored; required structural drift is
* surfaced through {@link HonuaWmsCapabilitiesParseError}.
*
* @module
*/
var HonuaWmsCapabilitiesParseError = class extends HonuaSdkError {
	constructor(message, options = {}) {
		super("core.wms-capabilities-parse", message, options);
		this.name = "HonuaWmsCapabilitiesParseError";
	}
};
function parseWmsCapabilities(xml) {
	try {
		const root = parseCapabilitiesXml(xml, "WMS");
		if (root.localName !== "WMS_Capabilities" && root.localName !== "WMT_MS_Capabilities") throw new Error("missing <WMS_Capabilities> root element (received WMS Capabilities XML?)");
		const version = xmlAttribute(root, "version") ?? "";
		const warnings = [];
		const serviceNode = xmlChild(root, "Service");
		const service = compactObject$1({
			title: xmlText(xmlChild(serviceNode, "Title")),
			abstract: xmlText(xmlChild(serviceNode, "Abstract"))
		});
		const capability = xmlChild(root, "Capability");
		const operations = parseOperations$1(xmlChild(capability, "Request"));
		const operation = (name) => operations.find((candidate) => candidate.name === name);
		const formats = Object.freeze({
			map: operation("GetMap")?.formats ?? Object.freeze([]),
			featureInfo: operation("GetFeatureInfo")?.formats ?? Object.freeze([]),
			legend: operation("GetLegendGraphic")?.formats ?? Object.freeze([])
		});
		const request = Object.freeze({
			getMap: operation("GetMap") !== void 0,
			getFeatureInfo: operation("GetFeatureInfo") !== void 0,
			getLegendGraphic: operation("GetLegendGraphic") !== void 0,
			operations
		});
		const layers = Object.freeze(xmlChildren(capability, "Layer").map((layer) => parseLayer$1(layer, emptyInheritance(), 0, warnings)));
		return Object.freeze({
			version,
			service,
			layers,
			formats,
			request,
			warnings: Object.freeze(unique$1(warnings))
		});
	} catch (cause) {
		if (cause instanceof HonuaWmsCapabilitiesParseError) throw cause;
		throw new HonuaWmsCapabilitiesParseError(cause instanceof Error ? cause.message : "WMS Capabilities XML is malformed", { cause });
	}
}
function parseOperations$1(request) {
	return Object.freeze([
		"GetCapabilities",
		"GetMap",
		"GetFeatureInfo",
		"GetLegendGraphic"
	].flatMap((name) => {
		const nodes = xmlChildren(request, name);
		if (nodes.length > 1) throw new Error(`WMS Request repeats ${name} operation metadata.`);
		const node = nodes[0];
		if (!node) return [];
		const formats = unique$1(xmlChildren(node, "Format").flatMap((entry) => xmlText(entry) ?? []));
		const methods = [];
		const getUrls = [];
		const postUrls = [];
		for (const dcp of xmlChildren(node, "DCPType")) {
			const http = xmlChild(dcp, "HTTP");
			for (const method of http?.children ?? []) {
				if (method.localName !== "Get" && method.localName !== "Post") continue;
				const href = xmlAttribute(xmlChild(method, "OnlineResource") ?? method, "href");
				const normalizedMethod = method.localName === "Get" ? "GET" : "POST";
				if (!methods.includes(normalizedMethod)) methods.push(normalizedMethod);
				if (href) (normalizedMethod === "GET" ? getUrls : postUrls).push(href);
			}
		}
		return [Object.freeze({
			name,
			formats: Object.freeze(formats),
			methods: Object.freeze(methods),
			getUrls: Object.freeze(unique$1(getUrls)),
			postUrls: Object.freeze(unique$1(postUrls))
		})];
	}));
}
function emptyInheritance() {
	return Object.freeze({
		crs: Object.freeze([]),
		bbox: Object.freeze([]),
		styles: Object.freeze([]),
		dimensions: Object.freeze([]),
		queryable: false
	});
}
function parseLayer$1(node, inherited, depth, warnings) {
	if (depth >= 24) throw new Error("WMS Capabilities exceeds the 24-level layer hierarchy limit");
	const localCrs = xmlChildren(node, "CRS").concat(xmlChildren(node, "SRS")).flatMap((candidate) => xmlText(candidate)?.split(/\s+/).filter(Boolean) ?? []);
	const crs = Object.freeze(unique$1([...inherited.crs, ...localCrs]));
	const bbox = Object.freeze(mergeByKey(inherited.bbox, parseBoundingBoxes(node, warnings), (entry) => entry.crs));
	const styles = Object.freeze(mergeByKey(inherited.styles, parseStyles(node, warnings), (entry) => entry.name));
	const dimensions = Object.freeze(mergeByKey(inherited.dimensions, parseDimensions(node, warnings), (entry) => entry.name));
	const queryableValue = xmlAttribute(node, "queryable")?.toLowerCase();
	if (queryableValue !== void 0 && ![
		"0",
		"1",
		"false",
		"true"
	].includes(queryableValue)) warnings.push("WMS layer queryable metadata was malformed and inherited conservatively.");
	const queryable = queryableValue === "1" || queryableValue === "true" ? true : queryableValue === "0" || queryableValue === "false" ? false : inherited.queryable;
	const next = {
		crs,
		bbox,
		styles,
		dimensions,
		queryable
	};
	const children = Object.freeze(xmlChildren(node, "Layer").map((child) => parseLayer$1(child, next, depth + 1, warnings)));
	return Object.freeze({
		name: xmlText(xmlChild(node, "Name")) ?? "",
		...optional$1("title", xmlText(xmlChild(node, "Title"))),
		...optional$1("abstract", xmlText(xmlChild(node, "Abstract"))),
		crs,
		bbox,
		styles,
		dimensions,
		queryable,
		children
	});
}
function parseBoundingBoxes(node, warnings) {
	const out = [];
	for (const bbox of xmlChildren(node, "BoundingBox")) {
		const crs = xmlAttribute(bbox, "CRS") ?? xmlAttribute(bbox, "SRS");
		const minx = finiteNumber(xmlAttribute(bbox, "minx"));
		const miny = finiteNumber(xmlAttribute(bbox, "miny"));
		const maxx = finiteNumber(xmlAttribute(bbox, "maxx"));
		const maxy = finiteNumber(xmlAttribute(bbox, "maxy"));
		if (crs && minx !== void 0 && miny !== void 0 && maxx !== void 0 && maxy !== void 0 && minx <= maxx && miny <= maxy) out.push(Object.freeze({
			crs,
			minx,
			miny,
			maxx,
			maxy
		}));
		else warnings.push("WMS BoundingBox metadata was malformed and ignored.");
	}
	const geographic = xmlChild(node, "EX_GeographicBoundingBox");
	if (geographic && !out.some((entry) => entry.crs === "CRS:84")) {
		const minx = finiteNumber(xmlText(xmlChild(geographic, "westBoundLongitude")));
		const miny = finiteNumber(xmlText(xmlChild(geographic, "southBoundLatitude")));
		const maxx = finiteNumber(xmlText(xmlChild(geographic, "eastBoundLongitude")));
		const maxy = finiteNumber(xmlText(xmlChild(geographic, "northBoundLatitude")));
		if (minx !== void 0 && miny !== void 0 && maxx !== void 0 && maxy !== void 0 && minx <= maxx && miny <= maxy && minx >= -180 && maxx <= 180 && miny >= -90 && maxy <= 90) out.push(Object.freeze({
			crs: "CRS:84",
			minx,
			miny,
			maxx,
			maxy
		}));
		else warnings.push("WMS EX_GeographicBoundingBox metadata was malformed and ignored.");
	}
	return out;
}
function parseStyles(node, warnings) {
	return xmlChildren(node, "Style").flatMap((style) => {
		const name = xmlText(xmlChild(style, "Name"));
		if (!name) {
			warnings.push("WMS Style metadata without a name was ignored.");
			return [];
		}
		const legend = xmlChild(style, "LegendURL");
		const resource = xmlChild(legend, "OnlineResource");
		return [Object.freeze({
			name,
			...optional$1("title", xmlText(xmlChild(style, "Title"))),
			...optional$1("legendUrl", resource ? xmlAttribute(resource, "href") : void 0),
			...optional$1("legendFormat", xmlText(xmlChild(legend, "Format")))
		})];
	});
}
function parseDimensions(node, warnings) {
	return [...xmlChildren(node, "Dimension"), ...xmlChildren(node, "Extent")].flatMap((dimension) => {
		const name = xmlAttribute(dimension, "name");
		if (!name) {
			warnings.push("WMS Dimension metadata without a name was ignored.");
			return [];
		}
		const raw = xmlText(dimension);
		const values = raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
		return [Object.freeze({
			name,
			...optional$1("units", xmlAttribute(dimension, "units")),
			...optional$1("default", xmlAttribute(dimension, "default")),
			values: Object.freeze(unique$1(values))
		})];
	});
}
function finiteNumber(value) {
	if (value === void 0 || value.trim() === "") return void 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function unique$1(values) {
	return [...new Set(values)];
}
function mergeByKey(parent, local, key) {
	const localKeys = new Set(local.map(key));
	return [...local, ...parent.filter((entry) => !localKeys.has(key(entry)))];
}
function optional$1(key, value) {
	return value === void 0 ? {} : { [key]: value };
}
function compactObject$1(value) {
	return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0)));
}
function* iterateWmsLayers(capabilities) {
	const stack = [...capabilities.layers];
	while (stack.length > 0) {
		const next = stack.shift();
		if (next.name.length > 0) yield next;
		stack.unshift(...next.children);
	}
}
function findWmsLayer(capabilities, name) {
	for (const layer of iterateWmsLayers(capabilities)) if (layer.name === name) return layer;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wms.js
/**
* First-party WMS 1.3.0 adapter. `HonuaWms` is the service-level handle
* returned by `client.wms(serviceId)`; `HonuaWmsLayer` is the bound
* handle returned by `HonuaWms.layer(name)` that pre-fills the LAYER and
* default STYLE so per-call envelopes can drop the routing fields.
*
* Wire transport lives on `HonuaClient` (`getWmsCapabilities`,
* `getWmsMap`, `getWmsFeatureInfo`, `getWmsLegend`); this class is the
* typed surface consumers reach through `Source.protocol("wms")`.
*
* @module
*/
/**
* Service-level WMS handle. Use `layer(name)` to bind a single LAYER and
* style; for multi-layer composites (`LAYERS=a,b,c`) call `map()` /
* `featureInfo()` directly on this handle.
*/
var HonuaWms = class {
	client;
	serviceId;
	capabilitiesPromise;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
	}
	/** Bind a single named layer for layer-scoped requests. */
	layer(name, defaultStyleId) {
		const opts = {
			client: this.client,
			serviceId: this.serviceId,
			layerName: name
		};
		if (defaultStyleId !== void 0) opts.defaultStyleId = defaultStyleId;
		return new HonuaWmsLayer(opts);
	}
	/** Fetch and parse the service `GetCapabilities` document. */
	async capabilities(options) {
		return this.client.getWmsCapabilities({
			serviceId: this.serviceId,
			...options?.signal ? { signal: options.signal } : {}
		});
	}
	/** Render a `GetMap` request across one or more advertised layers. */
	async map(request) {
		return this.client.getWmsMap({
			serviceId: this.serviceId,
			...request
		});
	}
	/** Issue a `GetFeatureInfo` against one or more advertised layers. */
	async featureInfo(request) {
		return this.client.getWmsFeatureInfo({
			serviceId: this.serviceId,
			...request
		});
	}
	/**
	* Fetch a `GetLegendGraphic` image. Always gates on parsed Capabilities:
	* when the caller does not pre-supply `options.capabilities`, the handle
	* lazily loads them once via `getWmsCapabilities` and caches the
	* promise on the instance so repeat calls reuse the same fetch. Throws
	* `HonuaCapabilityNotSupportedError("legend", "wms", serviceId)` when
	* the service does not advertise `<GetLegendGraphic>`.
	*/
	async legend(request, options) {
		if (!(options?.capabilities ?? await this.loadCachedCapabilities()).request.getLegendGraphic) throw new HonuaCapabilityNotSupportedError("legend", "wms", this.serviceId);
		return this.client.getWmsLegend({
			serviceId: this.serviceId,
			...request
		});
	}
	async loadCachedCapabilities() {
		if (!this.capabilitiesPromise) this.capabilitiesPromise = this.capabilities().catch((error) => {
			this.capabilitiesPromise = void 0;
			throw error;
		});
		return this.capabilitiesPromise;
	}
};
/**
* Bound layer handle. Drops `layers` / `styles` from per-call requests
* and pre-fills the LAYER name. `featureInfo()` carries the same `i`,
* `j`, and `bbox` envelope as the service-level handle.
*/
var HonuaWmsLayer = class {
	client;
	serviceId;
	layerName;
	defaultStyleId;
	capabilitiesPromise;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.layerName = options.layerName;
		this.defaultStyleId = options.defaultStyleId;
	}
	/** Fetch the parent service's `GetCapabilities`. */
	async capabilities(options) {
		return this.client.getWmsCapabilities({
			serviceId: this.serviceId,
			...options?.signal ? { signal: options.signal } : {}
		});
	}
	/** Find this layer in a parsed Capabilities document. */
	describe(capabilities) {
		return findWmsLayer(capabilities, this.layerName);
	}
	/** Enumerate the styles advertised on this layer. */
	stylesIn(capabilities) {
		return this.describe(capabilities)?.styles ?? [];
	}
	async map(request) {
		const { style, ...rest } = request;
		const styleId = style ?? this.defaultStyleId;
		return this.client.getWmsMap({
			serviceId: this.serviceId,
			layers: [this.layerName],
			...styleId !== void 0 ? { styles: [styleId] } : {},
			...rest
		});
	}
	async featureInfo(request) {
		const { style, ...rest } = request;
		const styleId = style ?? this.defaultStyleId;
		return this.client.getWmsFeatureInfo({
			serviceId: this.serviceId,
			layers: [this.layerName],
			queryLayers: [this.layerName],
			...styleId !== void 0 ? { styles: [styleId] } : {},
			...rest
		});
	}
	/**
	* Fetch a `GetLegendGraphic` image scoped to the bound layer + style.
	* Mirrors `HonuaWms.legend`'s gating: when `options.capabilities` is
	* not supplied, the handle lazily loads them once via
	* `getWmsCapabilities` and caches the promise. Throws
	* `HonuaCapabilityNotSupportedError("legend", "wms", serviceId)` when
	* the service does not advertise `<GetLegendGraphic>`.
	*/
	async legend(request = {}, options) {
		if (!(options?.capabilities ?? await this.loadCachedCapabilities()).request.getLegendGraphic) throw new HonuaCapabilityNotSupportedError("legend", "wms", this.serviceId);
		const { style, ...rest } = request;
		const styleId = style ?? this.defaultStyleId;
		return this.client.getWmsLegend({
			serviceId: this.serviceId,
			layer: this.layerName,
			...styleId !== void 0 ? { style: styleId } : {},
			...rest
		});
	}
	async loadCachedCapabilities() {
		if (!this.capabilitiesPromise) this.capabilitiesPromise = this.capabilities().catch((error) => {
			this.capabilitiesPromise = void 0;
			throw error;
		});
		return this.capabilitiesPromise;
	}
};
/** Canonical WMS endpoint path. honua-server publishes both `/rest/services/{id}/MapServer/WMS` and `/ogc/services/{id}/wms`; the SDK targets the GeoServices-aliased path because every Honua deployment exposes it. */
function wmsBasePath(serviceId) {
	return `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/WMS`;
}
/**
* Fetch and parse a WMS `GetCapabilities` document for the addressed
* service. The XML body decodes through `requestText`; the parsed
* shape is the typed `WmsCapabilities` envelope (no XML node leaks
* through the public surface).
*/
async function getWmsCapabilities(transport, request) {
	const params = new URLSearchParams();
	params.set("SERVICE", "WMS");
	params.set("REQUEST", "GetCapabilities");
	params.set("VERSION", request.version ?? "1.3.0");
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
	const { text: xml } = await transport.requestText("GET", path, {
		accept: "text/xml,application/xml",
		signal: request.signal
	});
	return parseWmsCapabilities(xml);
}
/** Render a WMS `GetMap`. Returns the raw image bytes. */
async function getWmsMap(transport, request) {
	const params = serializeWmsMapParams(request);
	params.set("REQUEST", "GetMap");
	const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
	const accept = request.format ?? "image/png";
	const response = await transport.requestBytes("GET", path, accept, void 0, request.signal);
	return {
		bytes: response.bytes,
		contentType: response.contentType
	};
}
/**
* Issue a WMS `GetFeatureInfo`. When `INFO_FORMAT=application/json`
* the JSON body decodes into the canonical `HonuaTypedFeature[]`
* shape; non-JSON formats round-trip on `bytes` so callers retain the
* raw payload behind the protocol escape hatch.
*/
async function getWmsFeatureInfo(transport, request) {
	const params = serializeWmsFeatureInfoParams(request);
	const infoFormat = params.get("INFO_FORMAT");
	const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
	const response = await transport.requestBytes("GET", path, infoFormat, void 0, request.signal);
	return decodeWmsFeatureInfoResponse(response.bytes, response.contentType, infoFormat);
}
/**
* Serialize the WMS 1.3.0 KVP for a `GetFeatureInfo` request, including the
* authority-defined `BBOX` axis order for the requested CRS.
*
* Shared by the Honua service-id path above and the capabilities-driven
* third-party path (`wms-feature-info.ts`) so both emit byte-identical query
* state and only differ in which URL receives it.
*/
function serializeWmsFeatureInfoParams(request) {
	const params = serializeWmsMapParams(request);
	params.set("REQUEST", "GetFeatureInfo");
	params.set("QUERY_LAYERS", request.queryLayers.join(","));
	params.set("I", String(Math.trunc(request.i)));
	params.set("J", String(Math.trunc(request.j)));
	params.set("INFO_FORMAT", request.infoFormat ?? "application/json");
	if (request.featureCount !== void 0) params.set("FEATURE_COUNT", String(Math.trunc(request.featureCount)));
	return params;
}
/**
* Fetch a WMS `GetLegendGraphic`. honua-server does not implement
* GetLegendGraphic today; callers should branch on
* `WmsCapabilities.request.getLegendGraphic` before invoking. When
* the wire returns 5xx the underlying `HonuaHttpError` flows through.
*/
async function getWmsLegend(transport, request) {
	const params = new URLSearchParams();
	params.set("SERVICE", "WMS");
	params.set("VERSION", "1.3.0");
	params.set("REQUEST", "GetLegendGraphic");
	params.set("LAYER", request.layer);
	if (request.style) params.set("STYLE", request.style);
	const format = request.format ?? "image/png";
	params.set("FORMAT", format);
	if (request.width !== void 0) params.set("WIDTH", String(Math.trunc(request.width)));
	if (request.height !== void 0) params.set("HEIGHT", String(Math.trunc(request.height)));
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
	const response = await transport.requestBytes("GET", path, format, void 0, request.signal);
	return {
		bytes: response.bytes,
		contentType: response.contentType
	};
}
function serializeWmsMapParams(request) {
	const params = new URLSearchParams();
	params.set("SERVICE", "WMS");
	params.set("VERSION", "1.3.0");
	params.set("LAYERS", request.layers.join(","));
	params.set("STYLES", request.styles ? request.styles.join(",") : "");
	const crs = request.crs ?? "EPSG:3857";
	params.set("CRS", crs);
	const [minx, miny, maxx, maxy] = request.bbox;
	const wireBbox = wmsBboxRequiresAxisSwap(crs) ? [
		miny,
		minx,
		maxy,
		maxx
	] : [
		minx,
		miny,
		maxx,
		maxy
	];
	params.set("BBOX", wireBbox.join(","));
	params.set("WIDTH", String(Math.trunc(request.width)));
	params.set("HEIGHT", String(Math.trunc(request.height)));
	params.set("FORMAT", request.format ?? "image/png");
	params.set("TRANSPARENT", String(request.transparent ?? true).toUpperCase());
	if (request.bgcolor !== void 0) params.set("BGCOLOR", request.bgcolor);
	if (request.time !== void 0) params.set("TIME", request.time);
	if (request.elevation !== void 0) params.set("ELEVATION", request.elevation);
	if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
	return params;
}
function decodeWmsFeatureInfoResponse(bytes, contentType, requestedFormat) {
	if (!(contentType.toLowerCase().includes("application/json") || requestedFormat.toLowerCase().includes("application/json"))) return {
		contentType,
		bytes
	};
	const text = new TextDecoder("utf-8").decode(bytes);
	if (text.length === 0) return {
		contentType,
		features: []
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			contentType,
			bytes
		};
	}
	return {
		contentType,
		features: extractFeatureInfoFeatures(parsed)
	};
}
function extractFeatureInfoFeatures(parsed) {
	if (!parsed || typeof parsed !== "object") return [];
	const obj = parsed;
	const featuresRaw = Array.isArray(obj.features) ? obj.features : [];
	const out = [];
	for (const raw of featuresRaw) {
		if (!raw || typeof raw !== "object") continue;
		const feat = raw;
		const attributes = feat.attributes ?? feat.properties ?? {};
		const geometry = feat.geometry ?? null;
		out.push({
			attributes,
			geometry
		});
	}
	return out;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wms-types.js
/**
* Public request/response envelopes for the WMS / WMTS first-party
* adapter. Kept in their own module so the canonical SDK surface
* (`src/contract/index.ts`, `src/runtime/index.ts`, `src/index.ts`) can
* re-export them without dragging the runtime classes into trees that
* never reference WMS.
*
* @module
*/
/**
* Canonical mapping from WMTS `Format` MIME types to RESTful path
* extensions. Shared between the wire client (`getWmtsTile` /
* `featureInfo` URL builders in `src/core/client.ts`) and the MapLibre
* raster source helper (`buildWmtsRasterSourceSpec` in
* `src/runtime/source-bridge.ts`) so a caller-supplied `format` lands on
* the same extension regardless of which surface composes the URL.
*
* The map is intentionally narrow — formats not listed here fall back
* to `png` per the conservative WMTS default. Add a new entry only when
* honua-server adds first-party support for the encoding.
*/
var WMTS_TILE_FORMAT_TO_EXTENSION = new Map([
	["image/png", "png"],
	["image/jpeg", "jpeg"],
	["image/jpg", "jpeg"],
	["image/webp", "webp"]
]);
/** Resolve the RESTful path extension for a WMTS tile `Format` MIME type. */
function wmtsExtensionForFormat(format) {
	return WMTS_TILE_FORMAT_TO_EXTENSION.get(format.toLowerCase()) ?? "png";
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wmts-capabilities.js
/** Bounded WMTS 1.0 capabilities projection. @module */
var incompleteTileMatrixSets = /* @__PURE__ */ new WeakSet();
var HonuaWmtsCapabilitiesParseError = class extends HonuaSdkError {
	constructor(message, options = {}) {
		super("core.wmts-capabilities-parse", message, options);
		this.name = "HonuaWmtsCapabilitiesParseError";
	}
};
function parseWmtsCapabilities(xml) {
	try {
		const root = parseCapabilitiesXml(xml, "WMTS");
		if (root.localName !== "Capabilities") throw new Error("missing <Capabilities> root element");
		const warnings = [];
		const serviceNode = xmlChild(root, "ServiceIdentification");
		const contents = xmlChild(root, "Contents");
		const service = compactObject({
			title: xmlText(xmlChild(serviceNode, "Title")),
			abstract: xmlText(xmlChild(serviceNode, "Abstract"))
		});
		const layers = Object.freeze(xmlChildren(contents, "Layer").flatMap((layer) => parseLayer(layer, warnings)));
		const tileMatrixSets = Object.freeze(xmlChildren(contents, "TileMatrixSet").flatMap((matrixSet) => parseTileMatrixSet(matrixSet, warnings)));
		const operations = Object.freeze(parseOperations(xmlChild(root, "OperationsMetadata")));
		return Object.freeze({
			version: xmlAttribute(root, "version") ?? "",
			service,
			layers,
			tileMatrixSets,
			operations,
			warnings: Object.freeze(unique(warnings))
		});
	} catch (cause) {
		if (cause instanceof HonuaWmtsCapabilitiesParseError) throw cause;
		throw new HonuaWmtsCapabilitiesParseError(cause instanceof Error ? cause.message : "WMTS Capabilities XML is malformed", { cause });
	}
}
function parseOperations(node) {
	const seen = /* @__PURE__ */ new Set();
	return xmlChildren(node, "Operation").flatMap((operation) => {
		const name = xmlAttribute(operation, "name");
		if (!name) return [];
		if (seen.has(name)) throw new Error(`WMTS repeats ${name} operation metadata.`);
		seen.add(name);
		const methods = [];
		const getUrls = [];
		const postUrls = [];
		for (const dcp of xmlChildren(operation, "DCP")) {
			const http = xmlChild(dcp, "HTTP");
			for (const method of http?.children ?? []) {
				if (method.localName !== "Get" && method.localName !== "Post") continue;
				const normalized = method.localName === "Get" ? "GET" : "POST";
				if (!methods.includes(normalized)) methods.push(normalized);
				const href = xmlAttribute(method, "href");
				if (href) (normalized === "GET" ? getUrls : postUrls).push(href);
			}
		}
		return [Object.freeze({
			name,
			methods: Object.freeze(methods),
			getUrls: Object.freeze(unique(getUrls)),
			postUrls: Object.freeze(unique(postUrls))
		})];
	});
}
function parseLayer(node, warnings) {
	const identifier = xmlText(xmlChild(node, "Identifier"));
	if (!identifier) {
		warnings.push("WMTS Layer metadata without an identifier was ignored.");
		return [];
	}
	const bbox = parseWgs84BoundingBox(xmlChild(node, "WGS84BoundingBox"), warnings);
	return [Object.freeze({
		identifier,
		...optional("title", xmlText(xmlChild(node, "Title"))),
		...optional("abstract", xmlText(xmlChild(node, "Abstract"))),
		formats: Object.freeze(unique(xmlChildren(node, "Format").flatMap((entry) => xmlText(entry) ?? []))),
		infoFormats: Object.freeze(unique(xmlChildren(node, "InfoFormat").flatMap((entry) => xmlText(entry) ?? []))),
		styles: Object.freeze(xmlChildren(node, "Style").flatMap((style) => parseStyle(style, warnings))),
		dimensions: Object.freeze(xmlChildren(node, "Dimension").flatMap((dimension) => parseDimension(dimension, warnings))),
		tileMatrixSetIds: Object.freeze(unique(xmlChildren(node, "TileMatrixSetLink").flatMap((link) => xmlText(xmlChild(link, "TileMatrixSet")) ?? []))),
		resourceTemplates: Object.freeze(parseResources(node, "tile", warnings)),
		featureInfoTemplates: Object.freeze(parseResources(node, "FeatureInfo", warnings)),
		...bbox ? { bbox } : {}
	})];
}
function parseStyle(node, warnings) {
	const identifier = xmlText(xmlChild(node, "Identifier"));
	if (!identifier) {
		warnings.push("WMTS Style metadata without an identifier was ignored.");
		return [];
	}
	const legend = xmlChild(node, "LegendURL");
	const isDefault = xmlAttribute(node, "isDefault")?.toLowerCase();
	if (isDefault !== void 0 && ![
		"0",
		"1",
		"false",
		"true"
	].includes(isDefault)) warnings.push("WMTS Style isDefault metadata was malformed and treated as false.");
	return [Object.freeze({
		identifier,
		...optional("title", xmlText(xmlChild(node, "Title"))),
		isDefault: isDefault === "true" || isDefault === "1",
		...optional("legendUrl", legend ? xmlAttribute(legend, "href") : void 0),
		...optional("legendFormat", legend ? xmlAttribute(legend, "format") : void 0)
	})];
}
function parseDimension(node, warnings) {
	const identifier = xmlText(xmlChild(node, "Identifier"));
	if (!identifier) {
		warnings.push("WMTS Dimension metadata without an identifier was ignored.");
		return [];
	}
	const current = xmlText(xmlChild(node, "Current"))?.toLowerCase();
	if (current !== void 0 && ![
		"0",
		"1",
		"false",
		"true"
	].includes(current)) warnings.push("WMTS Dimension Current metadata was malformed and treated as false.");
	return [Object.freeze({
		identifier,
		...optional("default", xmlText(xmlChild(node, "Default"))),
		current: current === "true" || current === "1",
		values: Object.freeze(unique(xmlChildren(node, "Value").flatMap((entry) => xmlText(entry) ?? [])))
	})];
}
function parseResources(node, resourceType, warnings) {
	return xmlChildren(node, "ResourceURL").flatMap((resource) => {
		if (xmlAttribute(resource, "resourceType")?.toLowerCase() !== resourceType.toLowerCase()) return [];
		const template = xmlAttribute(resource, "template");
		const format = xmlAttribute(resource, "format");
		if (!template || !format) {
			warnings.push(`WMTS ${resourceType} ResourceURL metadata without a format or template was ignored.`);
			return [];
		}
		return [Object.freeze({
			format,
			template
		})];
	});
}
function parseWgs84BoundingBox(node, warnings) {
	if (!node) return void 0;
	const lower = coordinatePair(xmlText(xmlChild(node, "LowerCorner")));
	const upper = coordinatePair(xmlText(xmlChild(node, "UpperCorner")));
	if (!lower || !upper || lower[0] > upper[0] || lower[1] > upper[1] || lower[0] < -180 || upper[0] > 180 || lower[1] < -90 || upper[1] > 90) {
		warnings.push("WMTS WGS84BoundingBox metadata was malformed and ignored.");
		return;
	}
	return Object.freeze({
		west: lower[0],
		south: lower[1],
		east: upper[0],
		north: upper[1]
	});
}
function parseTileMatrixSet(node, warnings) {
	const identifier = xmlText(xmlChild(node, "Identifier"));
	const matrixNodes = xmlChildren(node, "TileMatrix");
	const matrices = Object.freeze(matrixNodes.flatMap((matrix) => parseTileMatrix(matrix, warnings)));
	if (!identifier || matrices.length === 0) {
		warnings.push("WMTS TileMatrixSet metadata without an identifier or valid matrices was ignored.");
		return [];
	}
	const matrixSet = Object.freeze({
		identifier,
		...optional("supportedCrs", xmlText(xmlChild(node, "SupportedCRS"))),
		...optional("wellKnownScaleSet", xmlText(xmlChild(node, "WellKnownScaleSet"))),
		matrices
	});
	if (matrices.length !== matrixNodes.length) incompleteTileMatrixSets.add(matrixSet);
	return [matrixSet];
}
function parseTileMatrix(node, warnings) {
	const identifier = xmlText(xmlChild(node, "Identifier"));
	const scaleDenominator = positiveNumber(xmlText(xmlChild(node, "ScaleDenominator")));
	const tileWidth = positiveSafeInteger(xmlText(xmlChild(node, "TileWidth")));
	const tileHeight = positiveSafeInteger(xmlText(xmlChild(node, "TileHeight")));
	const matrixWidth = positiveSafeInteger(xmlText(xmlChild(node, "MatrixWidth")));
	const matrixHeight = positiveSafeInteger(xmlText(xmlChild(node, "MatrixHeight")));
	const topLeftCorner = coordinatePair(xmlText(xmlChild(node, "TopLeftCorner")));
	if (!identifier || scaleDenominator === void 0 || tileWidth === void 0 || tileHeight === void 0 || matrixWidth === void 0 || matrixHeight === void 0 || !topLeftCorner) {
		warnings.push("WMTS TileMatrix metadata with invalid numeric fields was ignored.");
		return [];
	}
	return [Object.freeze({
		identifier,
		scaleDenominator,
		tileWidth,
		tileHeight,
		matrixWidth,
		matrixHeight,
		topLeftCorner: Object.freeze(topLeftCorner)
	})];
}
function coordinatePair(value) {
	if (!value) return void 0;
	const values = value.trim().split(/\s+/).map(Number);
	return values.length === 2 && values.every(Number.isFinite) ? [values[0], values[1]] : void 0;
}
function positiveNumber(value) {
	if (!value) return void 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
}
function positiveSafeInteger(value) {
	if (!value) return void 0;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
}
function unique(values) {
	return [...new Set(values)];
}
function optional(key, value) {
	return value === void 0 ? {} : { [key]: value };
}
function compactObject(value) {
	return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0)));
}
function findWmtsLayer(capabilities, identifier) {
	return capabilities.layers.find((layer) => layer.identifier === identifier);
}
function findWmtsTileMatrixSet(capabilities, identifier) {
	return capabilities.tileMatrixSets.find((tileMatrixSet) => tileMatrixSet.identifier === identifier);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/wmts.js
/**
* First-party WMTS 1.0.0 adapter. `HonuaWmts` is the service-level
* handle returned by `client.wmts(serviceId)`; `HonuaWmtsLayer` is a
* single-layer projection that pre-fills LAYER and (optionally) STYLE;
* `HonuaWmtsTileset` adds a TileMatrixSet binding so per-call requests
* shrink to `{tileMatrix, tileRow, tileCol}`.
*
* The wire path lives on `HonuaClient` (`getWmtsCapabilities`,
* `fetchWmtsTile`, `getWmtsFeatureInfo`).
*
* @module
*/
var HonuaWmts = class {
	client;
	serviceId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
	}
	/** Bind a single LAYER + optional STYLE / TileMatrixSet defaults. */
	layer(name, options) {
		const opts = {
			client: this.client,
			serviceId: this.serviceId,
			layerName: name
		};
		if (options?.styleId !== void 0) opts.defaultStyleId = options.styleId;
		if (options?.tileMatrixSetId !== void 0) opts.defaultTileMatrixSetId = options.tileMatrixSetId;
		return new HonuaWmtsLayer(opts);
	}
	tileset(layerName, styleId, tileMatrixSetId) {
		return new HonuaWmtsTileset({
			client: this.client,
			serviceId: this.serviceId,
			layerName,
			styleId,
			tileMatrixSetId
		});
	}
	async capabilities(options) {
		return this.client.getWmtsCapabilities({
			serviceId: this.serviceId,
			...options?.signal ? { signal: options.signal } : {}
		});
	}
	async tile(request) {
		return this.client.fetchWmtsTile({
			serviceId: this.serviceId,
			...request
		});
	}
	async featureInfo(request) {
		return this.client.getWmtsFeatureInfo({
			serviceId: this.serviceId,
			...request
		});
	}
};
var HonuaWmtsLayer = class {
	client;
	serviceId;
	layerName;
	defaultStyleId;
	defaultTileMatrixSetId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.layerName = options.layerName;
		this.defaultStyleId = options.defaultStyleId;
		this.defaultTileMatrixSetId = options.defaultTileMatrixSetId;
	}
	describe(capabilities) {
		return findWmtsLayer(capabilities, this.layerName);
	}
	tileset(styleId, tileMatrixSetId) {
		const style = styleId ?? this.defaultStyleId ?? "default";
		const tms = tileMatrixSetId ?? this.defaultTileMatrixSetId ?? "WebMercatorQuad";
		return new HonuaWmtsTileset({
			client: this.client,
			serviceId: this.serviceId,
			layerName: this.layerName,
			styleId: style,
			tileMatrixSetId: tms
		});
	}
	async tile(request) {
		return this.client.fetchWmtsTile({
			serviceId: this.serviceId,
			layer: this.layerName,
			style: request.style ?? this.defaultStyleId,
			tileMatrixSet: request.tileMatrixSet ?? this.defaultTileMatrixSetId,
			tileMatrix: request.tileMatrix,
			tileRow: request.tileRow,
			tileCol: request.tileCol,
			...request.format !== void 0 ? { format: request.format } : {},
			...request.mode !== void 0 ? { mode: request.mode } : {},
			...request.signal !== void 0 ? { signal: request.signal } : {},
			...request.extraParams !== void 0 ? { extraParams: request.extraParams } : {}
		});
	}
	async featureInfo(request) {
		return this.client.getWmtsFeatureInfo({
			serviceId: this.serviceId,
			layer: this.layerName,
			style: request.style ?? this.defaultStyleId,
			tileMatrixSet: request.tileMatrixSet ?? this.defaultTileMatrixSetId,
			tileMatrix: request.tileMatrix,
			tileRow: request.tileRow,
			tileCol: request.tileCol,
			i: request.i,
			j: request.j,
			...request.format !== void 0 ? { format: request.format } : {},
			...request.infoFormat !== void 0 ? { infoFormat: request.infoFormat } : {},
			...request.mode !== void 0 ? { mode: request.mode } : {},
			...request.signal !== void 0 ? { signal: request.signal } : {},
			...request.extraParams !== void 0 ? { extraParams: request.extraParams } : {}
		});
	}
};
/**
* Tileset handle bound to (layer × style × tileMatrixSet). The runtime
* binding for MapLibre's `raster` source spec is keyed off this shape.
*/
var HonuaWmtsTileset = class {
	client;
	serviceId;
	layerName;
	styleId;
	tileMatrixSetId;
	constructor(options) {
		this.client = options.client;
		this.serviceId = options.serviceId;
		this.layerName = options.layerName;
		this.styleId = options.styleId;
		this.tileMatrixSetId = options.tileMatrixSetId;
	}
	describe(capabilities) {
		return findWmtsTileMatrixSet(capabilities, this.tileMatrixSetId);
	}
	async tile(request) {
		return this.client.fetchWmtsTile({
			serviceId: this.serviceId,
			layer: this.layerName,
			style: this.styleId,
			tileMatrixSet: this.tileMatrixSetId,
			tileMatrix: request.tileMatrix,
			tileRow: request.tileRow,
			tileCol: request.tileCol,
			...request.format !== void 0 ? { format: request.format } : {},
			...request.mode !== void 0 ? { mode: request.mode } : {},
			...request.signal !== void 0 ? { signal: request.signal } : {},
			...request.extraParams !== void 0 ? { extraParams: request.extraParams } : {}
		});
	}
	async featureInfo(request) {
		return this.client.getWmtsFeatureInfo({
			serviceId: this.serviceId,
			layer: this.layerName,
			style: this.styleId,
			tileMatrixSet: this.tileMatrixSetId,
			tileMatrix: request.tileMatrix,
			tileRow: request.tileRow,
			tileCol: request.tileCol,
			i: request.i,
			j: request.j,
			...request.format !== void 0 ? { format: request.format } : {},
			...request.infoFormat !== void 0 ? { infoFormat: request.infoFormat } : {},
			...request.mode !== void 0 ? { mode: request.mode } : {},
			...request.signal !== void 0 ? { signal: request.signal } : {},
			...request.extraParams !== void 0 ? { extraParams: request.extraParams } : {}
		});
	}
};
/** Canonical WMTS endpoint path. */
function wmtsBasePath(serviceId) {
	return `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/WMTS`;
}
async function getWmtsCapabilities(transport, request) {
	const params = new URLSearchParams();
	params.set("SERVICE", "WMTS");
	params.set("REQUEST", "GetCapabilities");
	params.set("VERSION", "1.0.0");
	const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
	const { text: xml } = await transport.requestText("GET", path, {
		accept: "text/xml,application/xml",
		signal: request.signal
	});
	return parseWmtsCapabilities(xml);
}
/**
* Fetch a single WMTS tile. `mode` selects between KVP
* (`?REQUEST=GetTile&...`) and the RESTful path
* (`/{layer}/{style}/{tms}/{z}/{y}/{x}.{ext}`). honua-server
* advertises both; the SDK defaults to RESTful because the wire path
* is a single string substitution per tile and skips
* URLSearchParams serialisation on the hot path.
*/
async function fetchWmtsTile(transport, request) {
	const mode = request.mode ?? "rest";
	const format = request.format ?? "image/png";
	const style = request.style ?? "default";
	const tileMatrixSet = request.tileMatrixSet ?? "WebMercatorQuad";
	if (mode === "kvp") {
		const params = new URLSearchParams();
		params.set("SERVICE", "WMTS");
		params.set("VERSION", "1.0.0");
		params.set("REQUEST", "GetTile");
		params.set("LAYER", request.layer);
		params.set("STYLE", style);
		params.set("FORMAT", format);
		params.set("TILEMATRIXSET", tileMatrixSet);
		params.set("TILEMATRIX", String(request.tileMatrix));
		params.set("TILEROW", String(request.tileRow));
		params.set("TILECOL", String(request.tileCol));
		if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
		const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
		return transport.requestBytes("GET", path, format, void 0, request.signal);
	}
	const ext = wmtsExtensionForFormat(format);
	const path = `${wmtsBasePath(request.serviceId)}/${encodeURIComponent(request.layer)}/${encodeURIComponent(style)}/${encodeURIComponent(tileMatrixSet)}/${encodeURIComponent(String(request.tileMatrix))}/${encodeURIComponent(String(request.tileRow))}/${encodeURIComponent(String(request.tileCol))}.${ext}${wmtsRestExtraParamsSuffix(request.extraParams)}`;
	return transport.requestBytes("GET", path, format, void 0, request.signal);
}
/**
* WMTS GetFeatureInfo. honua-server accepts both KVP and RESTful
* routing; mode default mirrors `fetchWmtsTile`.
*/
async function getWmtsFeatureInfo(transport, request) {
	const mode = request.mode ?? "rest";
	const infoFormat = request.infoFormat ?? "application/json";
	const format = request.format ?? "image/png";
	const style = request.style ?? "default";
	const tileMatrixSet = request.tileMatrixSet ?? "WebMercatorQuad";
	if (mode === "kvp") {
		const params = new URLSearchParams();
		params.set("SERVICE", "WMTS");
		params.set("VERSION", "1.0.0");
		params.set("REQUEST", "GetFeatureInfo");
		params.set("LAYER", request.layer);
		params.set("STYLE", style);
		params.set("FORMAT", format);
		params.set("TILEMATRIXSET", tileMatrixSet);
		params.set("TILEMATRIX", String(request.tileMatrix));
		params.set("TILEROW", String(request.tileRow));
		params.set("TILECOL", String(request.tileCol));
		params.set("I", String(Math.trunc(request.i)));
		params.set("J", String(Math.trunc(request.j)));
		params.set("INFOFORMAT", infoFormat);
		if (request.extraParams) for (const [key, value] of Object.entries(request.extraParams)) params.set(key, String(value));
		const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
		const response = await transport.requestBytes("GET", path, infoFormat, void 0, request.signal);
		return decodeWmsFeatureInfoResponse(response.bytes, response.contentType, infoFormat);
	}
	const ext = wmtsFeatureInfoExtensionForFormat(infoFormat);
	const path = `${wmtsBasePath(request.serviceId)}/${encodeURIComponent(request.layer)}/${encodeURIComponent(style)}/${encodeURIComponent(tileMatrixSet)}/${encodeURIComponent(String(request.tileMatrix))}/${encodeURIComponent(String(request.tileRow))}/${encodeURIComponent(String(request.tileCol))}/${encodeURIComponent(String(Math.trunc(request.j)))}/${encodeURIComponent(String(Math.trunc(request.i)))}.${ext}${wmtsRestExtraParamsSuffix(request.extraParams)}`;
	const response = await transport.requestBytes("GET", path, infoFormat, void 0, request.signal);
	return decodeWmsFeatureInfoResponse(response.bytes, response.contentType, infoFormat);
}
var WMTS_FEATURE_INFO_FORMAT_TO_EXTENSION = new Map([
	["application/json", "json"],
	["text/plain", "txt"],
	["text/html", "html"],
	["application/geo+json", "geojson"]
]);
function wmtsFeatureInfoExtensionForFormat(format) {
	return WMTS_FEATURE_INFO_FORMAT_TO_EXTENSION.get(format.toLowerCase()) ?? "txt";
}
var WMTS_REST_RESERVED_KEYS = new Set([
	"service",
	"version",
	"request",
	"layer",
	"style",
	"format",
	"infoformat",
	"tilematrixset",
	"tilematrix",
	"tilerow",
	"tilecol",
	"i",
	"j"
]);
/**
* Serialize `extraParams` for the RESTful WMTS routes. Path-encoded WMTS
* keys take precedence — any extraParams whose key (case-insensitively)
* matches a path-derived value is dropped so the same URL never carries
* the value twice. Returns the query-string suffix to append (empty
* string when there is nothing left after filtering).
*/
function wmtsRestExtraParamsSuffix(extraParams) {
	if (!extraParams) return "";
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(extraParams)) {
		if (value === void 0 || value === null) continue;
		if (WMTS_REST_RESERVED_KEYS.has(key.toLowerCase())) continue;
		params.set(key, String(value));
	}
	const serialized = params.toString();
	return serialized.length > 0 ? `?${serialized}` : "";
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/core/client.js
function normalizeBaseUrl(baseUrl) {
	return trimTrailingSlashes(baseUrl);
}
function normalizePath(path) {
	if (path.startsWith("http://") || path.startsWith("https://")) return path;
	return path.startsWith("/") ? path : `/${path}`;
}
function isAbsoluteHttpUrl(value) {
	return value.startsWith("http://") || value.startsWith("https://");
}
function resolveRequestUrl(baseUrl, path) {
	if (isAbsoluteHttpUrl(path)) {
		if (!isAbsoluteHttpUrl(baseUrl)) throw new Error("Absolute request URLs are not allowed when baseUrl is relative.");
		const baseOrigin = new URL(baseUrl).origin;
		const requestUrl = new URL(path);
		if (requestUrl.origin !== baseOrigin) throw new Error(`Cross-origin request URL is not allowed: ${path}`);
		return requestUrl.toString();
	}
	return `${baseUrl}${path}`;
}
/**
* The maximum number of HTTP redirects {@link HonuaClient.fetchWithSafeRedirects}
* will follow before giving up. Mirrors the conventional browser/undici limit of 20.
*/
var MAX_SAFE_REDIRECTS = 20;
/**
* HTTP status codes that represent a redirect carrying a `Location` header.
*/
var REDIRECT_STATUSES = new Set([
	301,
	302,
	303,
	307,
	308
]);
/**
* Resolve a redirect `Location` (which may be relative) against the URL that
* produced the redirect and assert it stays on the configured base origin.
*
* The SDK attaches the API key as a custom `X-API-Key` header. The Fetch/undici
* runtime only strips `Authorization`/`Cookie`/`Host` on a cross-origin redirect,
* so custom auth headers like `X-API-Key` would otherwise be replayed to an
* attacker-controlled `Location` host. To prevent that credential disclosure we
* never auto-follow redirects; we re-run the same origin guard used at request
* construction and refuse to follow any redirect that leaves the base origin.
*
* @throws if the target origin differs from the base origin, or if the
*   `Location` header is missing/unparsable.
*/
function resolveRedirectUrl(baseUrl, fromUrl, location) {
	if (!location) throw new Error("Redirect response is missing a Location header.");
	let target;
	try {
		target = new URL(location, fromUrl);
	} catch {
		throw new Error(`Redirect response has an invalid Location header: ${location}`);
	}
	return resolveRequestUrl(baseUrl, target.toString());
}
function normalizeInterceptorRequestUrl(baseUrl, url) {
	if (isAbsoluteHttpUrl(url)) return resolveRequestUrl(baseUrl, url);
	if (!isAbsoluteHttpUrl(baseUrl)) return url;
	return resolveRequestUrl(baseUrl, normalizePath(url));
}
var DEFAULT_AUTH_REFRESH_SKEW_MS = 6e4;
var DEFAULT_METADATA_CACHE_MAX_ENTRIES = 256;
/**
* The main Honua HTTP/gRPC-Web client.
*
* `HonuaClient` is the protocol-aware entry point into the Honua server. It speaks
* GeoServices (FeatureServer, MapServer, ImageServer, GeometryServer, GPServer),
* OGC API Features / Tiles / Maps / Processes, STAC, WMS, WMTS, WFS 2.0, and OData v4,
* with one consistent request/response shape, capability negotiation, optional retries,
* pluggable auth, and a small in-process metadata cache.
*
* For cross-protocol code that does not need to know the underlying service shape,
* prefer the protocol-neutral {@link createDataset} contract from `@honua/sdk-js/contract`
* — it wraps this client and exposes a single `Source.query(...)` surface that throws
* {@link HonuaCapabilityNotSupportedError} when a protocol cannot satisfy the request.
*
* @example Basic usage
* ```ts
* import { HonuaClient } from "@honua/sdk-js/honua";
*
* const client = new HonuaClient({
*   baseUrl: "https://your-honua-server.example",
*   apiKey: process.env.HONUA_API_KEY,
* });
*
* const { supported, reasons } = await client.checkCompatibility();
* if (!supported) {
*   throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
* }
*
* const result = await client.queryFeatures({
*   serviceId: "natural-earth",
*   layerId: 0,
*   where: "1=1",
*   outFields: ["*"],
*   returnGeometry: true,
*   resultRecordCount: 25,
* });
*
* console.log(`Loaded ${result.features?.length ?? 0} features`);
* ```
*
* @example Per-service fluent wrappers
* ```ts
* const parcels = client.featureLayer<{ NAME: string }>("parcels", 0);
* const items = await client.ogcFeatures();
* const wms = client.wms("usgs-imagery");
* ```
*
* @public
*/
var HonuaClient = class HonuaClient {
	/** The minimum Honua server version this SDK is contractually tested against. */
	static minimumSupportedServerVersion = HONUA_MINIMUM_SUPPORTED_SERVER_VERSION;
	static minimumSupportedServerReleaseChannel = MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL;
	baseUrl;
	fetchFn;
	defaultHeaders;
	authProvider;
	authRefreshSkewMs;
	interceptors;
	timeoutMs;
	retryOptions;
	preferBinary;
	transport;
	/**
	* Low-level transport handed to the per-protocol wire modules. Binds the
	* client's private request primitives so each protocol family builds its own
	* URLs/params/parsing without reaching into the client.
	*/
	protocolTransport;
	serverCompatibilityCache;
	authCredentialsCache;
	authRefreshPromise;
	connectClient;
	connectClientPromise;
	metadataCache = /* @__PURE__ */ new Map();
	ogcLayoutCache = /* @__PURE__ */ new Map();
	wfsRootCache = /* @__PURE__ */ new Map();
	/**
	* Create a new `HonuaClient`.
	*
	* @param options - Connection, auth, transport, retry, and interceptor configuration.
	*   See {@link HonuaClientOptions} for every field and `@example` blocks for common shapes.
	*
	* @example Minimal
	* ```ts
	* const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
	* ```
	*
	* @example With API key + retries + timeout
	* ```ts
	* const client = new HonuaClient({
	*   baseUrl: "https://your-honua-server.example",
	*   apiKey: process.env.HONUA_API_KEY,
	*   retry: { maxRetries: 3 },
	*   timeoutMs: 30_000,
	* });
	* ```
	*/
	constructor(options) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.fetchFn = (options.fetchFn ?? fetch).bind(globalThis);
		const headers = {};
		if (options.apiKey) headers["X-API-Key"] = options.apiKey;
		if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;
		this.defaultHeaders = headers;
		this.authProvider = normalizeAuthProvider(options.auth);
		this.authRefreshSkewMs = normalizeAuthRefreshSkewMs(options.authRefreshSkewMs);
		this.interceptors = options.interceptors ?? [];
		this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
		this.retryOptions = normalizeRetryOptions(options.retry);
		this.preferBinary = options.preferBinary === true;
		this.transport = options.transport ?? "rest";
		this.protocolTransport = {
			baseUrl: this.baseUrl,
			requestJson: (method, path, init, signal) => this.requestJson(method, path, init, signal),
			requestText: (method, path, requestTextOptions) => this.requestText(method, path, requestTextOptions),
			requestBytes: (method, path, accept, init, signal) => this.requestBytes(method, path, accept, init, signal),
			requestCachedMetadataJson: (cacheKey, path, metadataOptions) => this.requestCachedMetadataJson(cacheKey, path, metadataOptions),
			pipelineFetch: (method, path, init, callerSignal, pipelineOptions) => this.pipelineFetch(method, path, init, callerSignal, pipelineOptions),
			requestBinaryWithJsonFallback: (method, path, params, signal) => this.requestBinaryWithJsonFallback(method, path, params, signal)
		};
	}
	/**
	* Connect interceptor that injects the same credentials the REST pipeline
	* uses (`apiKey`/`bearerToken` from {@link defaultHeaders} plus any provider
	* credentials resolved via {@link resolveAuthHeaders}) onto every gRPC-web
	* call. Without it the advertised `transport: "grpc-web"` path would send
	* every RPC unauthenticated.
	*/
	buildConnectAuthInterceptor() {
		return (next) => async (req) => {
			const headers = await this.composeHeaders();
			for (const [key, value] of Object.entries(headers)) req.header.set(key, value);
			return next(req);
		};
	}
	/**
	* Connect interceptor that applies the SDK's configured `retry` policy to
	* gRPC-web calls, mirroring the REST request pipeline. It retries only
	* replay-safe **unary** calls (server-streaming responses cannot be safely
	* replayed mid-iteration, the gRPC analog of the REST
	* {@link DEFAULT_RETRY_METHODS} idempotency gate) on the transient
	* {@link shouldRetryGrpcCall} status codes, backing off with the shared
	* exponential-with-jitter math (honoring any `retry-after` metadata) and
	* stopping immediately once the call's abort signal fires (caller abort or the
	* `timeoutMs` deadline). It wraps the auth interceptor so each attempt
	* re-resolves fresh credentials.
	*/
	buildConnectRetryInterceptor() {
		return (next) => async (req) => {
			if (req.stream || !this.retryOptions) return next(req);
			const retryOptions = this.retryOptions;
			for (let attempt = 0;; attempt += 1) try {
				return await next(req);
			} catch (error) {
				const aborted = req.signal?.aborted === true;
				if (!shouldRetryGrpcCall(retryOptions, attempt, error, aborted)) throw error;
				await sleep(resolveGrpcRetryDelayMs(retryOptions, attempt, error), req.signal);
			}
		};
	}
	/**
	* Shared gRPC-web transport options. The auth interceptor mirrors the REST
	* credential pipeline, the retry interceptor (when `retry` is configured)
	* applies the same retry/backoff policy as REST, and `defaultTimeoutMs`
	* honors the documented `timeoutMs` contract on every RPC (per-call abort
	* signals are threaded by the individual RPC methods).
	*/
	connectTransportOptions() {
		const interceptors = [this.buildConnectAuthInterceptor()];
		if (this.retryOptions) interceptors.unshift(this.buildConnectRetryInterceptor());
		return {
			baseUrl: this.baseUrl,
			fetch: this.fetchFn,
			interceptors,
			...this.timeoutMs !== void 0 ? { defaultTimeoutMs: this.timeoutMs } : {}
		};
	}
	async ensureConnectClient() {
		if (this.connectClient) return this.connectClient;
		let initPromise = this.connectClientPromise;
		if (!initPromise) {
			initPromise = Promise.all([
				__vitePreload(() => import("./esm-BvKGtSr1.js"), __vite__mapDeps([0,1,2]), import.meta.url),
				__vitePreload(() => import("./esm-D_dJovGL.js"), __vite__mapDeps([3,2,1]), import.meta.url),
				__vitePreload(() => import("./feature_service_pb-Cta0sbku.js"), __vite__mapDeps([4,5,2]), import.meta.url)
			]).then(([{ createClient }, { createGrpcWebTransport }, { FeatureService }]) => {
				const transport = createGrpcWebTransport(this.connectTransportOptions());
				this.connectClient = createClient(FeatureService, transport);
				return this.connectClient;
			});
			this.connectClientPromise = initPromise;
		}
		try {
			return await initPromise;
		} catch (error) {
			if (this.connectClientPromise === initPromise) this.connectClientPromise = void 0;
			throw error;
		}
	}
	/**
	* Perform a fetch that never auto-follows a cross-origin redirect.
	*
	* Browsers/undici forward custom request headers (such as the SDK's
	* `X-API-Key`) across redirects, stripping only `Authorization`/`Cookie`/`Host`
	* cross-origin. To avoid leaking the API key to an attacker-supplied
	* `Location` host, this issues every request with `redirect: "manual"` and
	* only follows a redirect when its target origin still matches the configured
	* base origin (re-running the {@link resolveRequestUrl} origin guard).
	* Cross-origin redirects throw before the credentialed request is replayed.
	*/
	async fetchWithSafeRedirects(url, init, redirectPolicy = "safe-follow") {
		let currentUrl = url;
		let currentInit = init;
		for (let redirects = 0;; redirects += 1) {
			const response = await this.fetchFn(currentUrl, {
				...currentInit,
				redirect: redirectPolicy === "error" ? "error" : "manual"
			});
			if (redirectPolicy === "error") {
				if (response.type === "opaqueredirect" || response.redirected || REDIRECT_STATUSES.has(response.status) || response.url !== "" && response.url !== currentUrl) {
					await response.body?.cancel().catch(() => void 0);
					throw new HonuaNetworkError("Redirects are not allowed for this bounded request.", void 0);
				}
				return response;
			}
			if (response.type === "opaqueredirect") throw new HonuaNetworkError("Refusing to follow an opaque cross-origin redirect; the request's API key would be leaked to the redirect target.", void 0);
			if (!REDIRECT_STATUSES.has(response.status)) return response;
			if (redirectPolicy === "manual") return response;
			if (redirects >= MAX_SAFE_REDIRECTS) throw new HonuaNetworkError(`Exceeded the maximum of ${MAX_SAFE_REDIRECTS} redirects.`, void 0);
			const location = response.headers.get("location");
			const nextUrl = resolveRedirectUrl(this.baseUrl, currentUrl, location);
			const method = (currentInit.method ?? "GET").toUpperCase();
			currentInit = response.status === 303 || (response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD" ? {
				...currentInit,
				method: "GET",
				body: null
			} : currentInit;
			currentUrl = nextUrl;
			await response.body?.cancel().catch(() => void 0);
		}
	}
	static async loadGrpcAdapter() {
		return __vitePreload(() => import("./grpc-adapter-A3vUPFLv.js"), __vite__mapDeps([6,7,5,2]), import.meta.url);
	}
	get isGrpcWeb() {
		return this.transport === "grpc-web";
	}
	/**
	* Normalized base URL the client was constructed with (trailing slashes
	* trimmed). Helpers that build absolute URLs without going through
	* `request()` (e.g. tile URL generators) read this so they produce the
	* same origin and base path the server actually serves from.
	*/
	get serverBaseUrl() {
		return this.baseUrl;
	}
	/**
	* Force-refresh credentials from the configured auth provider. The SDK
	* keeps the result in memory only; callers own durable and secure storage.
	*/
	async refreshAuthCredentials(reason = "manual") {
		return (await this.resolveAuthCredentials({
			forceRefresh: true,
			reason
		}))?.credentials;
	}
	/**
	* Resolve the auth headers the client would attach to an outgoing request
	* right now, refreshing provider credentials first if they are expiring.
	*
	* Transports that build their own connection outside the REST/gRPC pipeline —
	* notably realtime SSE streams, which must re-authenticate on every
	* (re)connect so a refreshed token is picked up after a drop — call this per
	* connect to obtain fresh credentials. Returns an empty object when no
	* credentials are configured.
	*/
	async getAuthHeaders() {
		return this.composeHeaders();
	}
	/**
	* Resolve just the current bearer/authorization token value (without the
	* `Bearer ` scheme prefix when a plain bearer token is configured), or
	* `undefined` if none. Convenience for realtime transports that must carry the
	* token as a query parameter (native `EventSource` cannot set headers).
	*/
	async getAuthToken() {
		const headers = await this.composeHeaders();
		const authorization = headers.Authorization ?? headers.authorization;
		if (authorization) return authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
		return headers["X-API-Key"] ?? headers["x-api-key"];
	}
	/** Drop cached provider credentials without calling a revocation endpoint. */
	clearAuthCredentials() {
		this.authCredentialsCache = void 0;
	}
	/**
	* Revoke the currently cached credentials through the provider, when it
	* exposes a revocation hook, then clear the SDK's in-memory cache.
	*/
	async revokeAuthCredentials(context = { reason: "manual" }) {
		const cached = this.authCredentialsCache;
		this.authCredentialsCache = void 0;
		if (cached && this.authProvider?.revokeCredentials) await this.authProvider.revokeCredentials(cached.credentials, context);
	}
	/**
	* Drive a paginated FeatureServer query as an async generator. Each yielded
	* chunk is a `HonuaFeature[]` slice; iteration stops when the server stops
	* advertising `exceededTransferLimit`. Lower-level than
	* `dataset.source(...).queryAll()` but suitable for streaming pipelines that
	* want backpressure between pages.
	*
	* @example
	* ```ts
	* for await (const page of client.queryFeaturesStream({ serviceId: "parcels", layerId: 0, where: "1=1" })) {
	*   process(page);
	* }
	* ```
	*/
	async *queryFeaturesStream(request) {
		const client = await this.ensureConnectClient();
		const grpcAdapter = await HonuaClient.loadGrpcAdapter();
		const protoRequest = grpcAdapter.toProtoQueryRequest(request);
		yield* grpcAdapter.streamProtoPages(client.queryFeaturesStream(protoRequest, request.signal ? { signal: request.signal } : void 0));
	}
	service(serviceId) {
		return new HonuaService({
			client: this,
			serviceId
		});
	}
	/**
	* Construct a typed wrapper for a single FeatureServer layer.
	*
	* The returned {@link HonuaFeatureLayer} carries the same `serviceId` / `layerId`
	* on every call so you can write `await layer.queryFeatures({ where: "..." })`
	* without restating the address.
	*
	* @typeParam T - The attribute shape of features in this layer.
	*
	* @example
	* ```ts
	* const parcels = client.featureLayer<{ NAME: string; STATUS: string }>("parcels", 0);
	* const { features } = await parcels.queryFeatures({ where: "STATUS = 'ACTIVE'" });
	* ```
	*/
	featureLayer(serviceId, layerId) {
		return new HonuaFeatureLayer({
			client: this,
			serviceId,
			layerId
		});
	}
	mapService(serviceId) {
		return new HonuaMapService({
			client: this,
			serviceId
		});
	}
	mapLayer(serviceId, layerId) {
		return new HonuaMapLayer({
			client: this,
			serviceId,
			layerId
		});
	}
	/**
	* Construct the OGC API Features client wrapper.
	*
	* Use this to walk collections (`landing()`, `conformance()`, `collections()`),
	* read items (`items()`, `item()`), and apply edits (`create*` / `replace*` /
	* `patch*` / `delete*`) against an OGC API Features endpoint exposed by the
	* Honua server.
	*
	* @example
	* ```ts
	* const features = client.ogcFeatures();
	* const collections = await features.collections();
	* const items = await features.items("parcels", { limit: 100 });
	* ```
	*/
	ogcFeatures() {
		return new HonuaOgcFeatures({ client: this });
	}
	ogcTiles() {
		return new HonuaOgcTiles({ client: this });
	}
	ogcMaps() {
		return new HonuaOgcMaps({ client: this });
	}
	ogcRecords() {
		return new HonuaOgcRecords({ client: this });
	}
	wms(serviceId) {
		return new HonuaWms({
			client: this,
			serviceId
		});
	}
	wmts(serviceId) {
		return new HonuaWmts({
			client: this,
			serviceId
		});
	}
	/**
	* Construct the OGC API Processes client wrapper.
	*
	* `basePath` pins every describe / execute / job route to a raw third-party
	* service root (as discovered by `discoverOgcProcesses()`); omitting it uses
	* the Honua facade prefix `/ogc/processes`. Pass the discovery result (or a
	* `/conformance` response) as `conformance` — and optionally
	* `capabilityPolicy: "strict"` — to gate execution and dismissal against what
	* the server actually declares.
	*/
	ogcProcesses(options = {}) {
		return new HonuaOgcProcesses({
			...options,
			client: this
		});
	}
	stac() {
		return new HonuaStacSearch({ client: this });
	}
	imageService(serviceId) {
		return new HonuaImageService({
			client: this,
			serviceId
		});
	}
	geometryService() {
		return new HonuaGeometryService({ client: this });
	}
	geoprocessing(serviceId, taskName) {
		return new HonuaGeoprocessingService({
			client: this,
			serviceId,
			taskName
		});
	}
	processRunner(adapter) {
		return createHonuaProcessRunner(adapter);
	}
	ogcProcessRunner(options = {}) {
		return createHonuaProcessRunner(createOgcProcessesAdapter(this.ogcProcesses(options)));
	}
	geoprocessingRunner(serviceId, taskName) {
		return createHonuaProcessRunner(createGeoServicesGpAdapter(this.geoprocessing(serviceId, taskName)));
	}
	geospatialGrpcProcessRunner(processClient) {
		return createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));
	}
	wfs(endpointUrl = "/wfs", options = {}) {
		const version = options.version ?? "2.0.0";
		const key = `${endpointUrl}\u0000${version}`;
		const cached = this.wfsRootCache.get(key);
		if (cached) return cached;
		const root = new HonuaWfs({
			client: this,
			endpointUrl,
			version
		});
		this.wfsRootCache.set(key, root);
		return root;
	}
	odata(entitySet, options = {}) {
		return new HonuaOdataEntitySet({
			client: this,
			entitySet,
			basePath: options.basePath
		});
	}
	clearMetadataCache(options = {}) {
		if (!options.keyPrefix) {
			this.metadataCache.clear();
			return;
		}
		const prefix = `metadata:${options.keyPrefix}`;
		for (const key of this.metadataCache.keys()) if (key.startsWith(prefix)) this.metadataCache.delete(key);
	}
	async listServices(formatOrOptions = "json", options = {}) {
		const format = typeof formatOrOptions === "string" ? formatOrOptions : "json";
		const metadataOptions = typeof formatOrOptions === "string" ? options : formatOrOptions;
		return listServices(this.protocolTransport, format, metadataOptions);
	}
	/**
	* Fetch and parse the server's compatibility contract from `GET /api/v1/admin/capabilities`.
	*
	* The first call populates an in-process cache; subsequent calls return the cached value
	* unless `options.refresh` is `true`. Use {@link HonuaClient.checkCompatibility} instead
	* when you want a non-throwing pass/fail signal with a list of reasons.
	*
	* @throws {@link HonuaError} when the server response cannot be parsed into a valid
	*   compatibility envelope (missing `serverVersion`, `controlPlaneApi`, etc.).
	*
	* @example
	* ```ts
	* const contract = await client.getCompatibility();
	* console.log(contract.serverVersion, contract.releaseChannel);
	* console.log(contract.metadataSchemas);
	* ```
	*/
	async getCompatibility(options = {}) {
		if (!options.refresh && this.serverCompatibilityCache) return this.serverCompatibilityCache;
		const compatibility = parseCompatibilityEnvelope(await this.requestJson("GET", "/api/v1/admin/capabilities", void 0, options.signal));
		this.serverCompatibilityCache = compatibility;
		return compatibility;
	}
	/**
	* Probe the server's compatibility contract and return a structured pass/fail status.
	*
	* Unlike {@link HonuaClient.getCompatibility}, this method does not throw on transport
	* or parse failures — those are reported as `supported: false` with a human-readable
	* `reasons` entry. Use this at app startup to fail loudly before exercising admin or
	* control-plane flows.
	*
	* @example
	* ```ts
	* const { supported, reasons } = await client.checkCompatibility();
	* if (!supported) {
	*   throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
	* }
	* ```
	*/
	async checkCompatibility(options = {}) {
		try {
			const compatibility = await this.getCompatibility(options);
			const reasons = evaluateCompatibility(compatibility);
			return {
				supported: reasons.length === 0,
				minimumSupportedServerVersion: HonuaClient.minimumSupportedServerVersion,
				compatibility,
				reasons
			};
		} catch (error) {
			return {
				supported: false,
				minimumSupportedServerVersion: HonuaClient.minimumSupportedServerVersion,
				reasons: [describeCompatibilityError(error)]
			};
		}
	}
	/**
	* Returns `true` if the server's `data.compatibility.features` map advertises the
	* given coarse capability. Use this to gate experimental or admin-only workflows.
	*
	* @example
	* ```ts
	* if (await client.supportsFeature("manifestApply")) {
	*   // safe to call the manifest apply admin endpoint
	* }
	* ```
	*/
	async supportsFeature(feature, options = {}) {
		return (await this.getCompatibility(options)).features[feature];
	}
	/**
	* Scan a supported migration source through the admin import scanner.
	*
	* A successful HTTP response means the server returned a deterministic
	* inventory artifact; callers still need to inspect
	* `scanCompleteness.status`, which can be `"failed"` on `200 OK`.
	*/
	async scanMigrationSource(request) {
		const { signal, exportJson, ...body } = request;
		const path = `/api/v1/admin/import/scan${exportJson ? "?export=json" : ""}`;
		return this.requestJson("POST", path, {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body)
		}, signal);
	}
	async request(request) {
		const method = request.method ?? "GET";
		const params = new URLSearchParams();
		params.set("f", request.responseFormat ?? "json");
		if (request.query) for (const [key, value] of Object.entries(request.query)) params.set(key, String(value));
		const pathWithQuery = mergePathWithQueryParams(normalizePath(request.path), params);
		return this.requestJson(method, pathWithQuery, {
			headers: request.headers,
			body: request.body
		}, request.signal);
	}
	/**
	* Pipeline-aware JSON request that bypasses the GeoServices `f=json`
	* convention used by {@link request}. Adapters whose protocols do not
	* model `f=` (OData, OGC API, …) call this directly so they keep the
	* shared auth / retry / timeout / interceptor pipeline without sending
	* a query parameter the server would reject as `InvalidQueryOption`.
	*
	* Caller-supplied query parameters belong on `path` itself; `init`
	* carries the body, headers, and abort signal. The default `Accept`
	* header is `application/json`; pass an explicit `Accept` in
	* `init.headers` to override.
	*/
	async pipelineRequestJson(method, path, init, signal) {
		return this.requestJson(method, path, init, signal);
	}
	async composeHeaders(...headersList) {
		const authHeaders = await this.resolveAuthHeaders();
		return mergeHeaders(this.defaultHeaders, authHeaders, ...headersList);
	}
	async resolveAuthHeaders() {
		const cached = await this.resolveAuthCredentials({ forceRefresh: false });
		if (!cached) return void 0;
		return authHeadersFromCredentials(cached.credentials);
	}
	async resolveAuthCredentials(options) {
		if (!this.authProvider) return;
		const cached = this.authCredentialsCache;
		if (!options.forceRefresh && cached && !isAuthCredentialsExpiring(cached, this.authRefreshSkewMs)) return cached;
		if (this.authRefreshPromise) return this.authRefreshPromise;
		const reason = options.reason ?? resolveAuthRefreshReason(cached);
		this.authRefreshPromise = this.loadAuthCredentials(reason, options.forceRefresh, cached?.credentials);
		try {
			return await this.authRefreshPromise;
		} finally {
			this.authRefreshPromise = void 0;
		}
	}
	async loadAuthCredentials(reason, forceRefresh, previousCredentials) {
		const credentials = normalizeAuthCredentials(await this.authProvider?.getCredentials({
			reason,
			forceRefresh,
			...previousCredentials ? { previousCredentials } : {}
		}));
		if (!credentials) {
			this.authCredentialsCache = void 0;
			return;
		}
		const cached = {
			credentials,
			expiresAtMs: normalizeAuthExpiresAtMs(credentials.expiresAt)
		};
		this.authCredentialsCache = cached;
		return cached;
	}
	/**
	* Pipeline-aware request that returns the raw `Response` after the
	* shared auth / retry / timeout / interceptor pipeline finishes
	* successfully. Used by adapters that need to consume non-JSON bodies
	* (OData `$metadata` XML, raw passthrough) without inheriting the
	* `Accept: application/json` default of {@link pipelineRequestJson}.
	*
	* The returned `Response` is unconsumed — the caller picks `.json()`,
	* `.text()`, or `.arrayBuffer()`. Non-2xx responses still throw the
	* normalized `HonuaHttpError` (and trigger retries) so error handling
	* matches every other client method.
	*/
	async pipelineFetch(method, path, init, callerSignal, options = {}) {
		const request = {
			url: resolveRequestUrl(this.baseUrl, path),
			path,
			method,
			init: {
				...init,
				method,
				headers: await this.composeHeaders(init?.headers),
				body: init?.body ?? null,
				...init?.signal ? { signal: init.signal } : {}
			}
		};
		return this.executeRequest(request, {
			callerSignal,
			...options.okStatuses ? { okStatuses: options.okStatuses } : {},
			...options.redirect ? { redirect: options.redirect } : {},
			...options.beforeAttempt ? { beforeAttempt: options.beforeAttempt } : {},
			...options.beforeReplay ? { beforeReplay: options.beforeReplay } : {},
			...options.prepareResponse || options.errorBody ? { deadlineThroughFinalize: true } : {},
			...options.errorBody ? { errorBody: options.errorBody } : options.discardErrorBody ? { errorBody: (response) => {
				response.body?.cancel().catch(() => void 0);
				return Promise.resolve({});
			} } : {},
			finalize: async (response, _durationMs, _request, runAfter, deadlineSignal) => {
				const candidate = options.prepareResponse ? await options.prepareResponse(response, deadlineSignal) : response;
				const prepared = candidate === response ? response : preserveResponseSemantics(candidate, response);
				await runAfter(prepared);
				return prepared;
			}
		});
	}
	async requestCachedMetadataJson(cacheKey, path, options = {}) {
		const metadataOptions = normalizeHonuaMetadataRequestOptions(options);
		const keyFingerprint = `metadata:${cacheKey}${metadataOptions.maxResponseBytes === void 0 ? "" : `:max-response-bytes:${metadataOptions.maxResponseBytes}`}`;
		const cached = this.metadataCache.get(keyFingerprint);
		const bypass = metadataOptions.cache === "bypass";
		const now = Date.now();
		const freshCachedEntry = cached ? isHonuaCacheEntryFresh(cached.cachedAtMs, now, metadataOptions.ttlMs) : false;
		if (!bypass && !metadataOptions.refresh && cached && freshCachedEntry) return withHonuaCacheState(cached.body, createMetadataCacheState(cached, "hit", {
			now,
			ttlMs: metadataOptions.ttlMs,
			staleIfErrorMs: metadataOptions.staleIfErrorMs
		}));
		const request = {
			url: resolveRequestUrl(this.baseUrl, path),
			path,
			method: "GET",
			init: {
				method: "GET",
				headers: await this.composeHeaders(honuaMetadataRequestHeaders({
					accept: "application/json",
					refresh: metadataOptions.refresh || Boolean(cached),
					bypass,
					validator: cached?.validator
				}))
			}
		};
		return this.executeRequest(request, {
			callerSignal: metadataOptions.signal,
			onTerminalError: (error) => this.staleMetadataFallback(cached, metadataOptions, error),
			shortCircuit: async (response, _durationMs, _currentRequest, runAfter) => {
				if (response.status !== 304 || !cached || bypass) return;
				await runAfter();
				const updatedEntry = {
					...cached,
					cachedAtMs: Date.now(),
					...honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator ? { validator: honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator } : {}
				};
				this.setMetadataCacheEntry(keyFingerprint, updatedEntry);
				return { value: withHonuaCacheState(updatedEntry.body, createMetadataCacheState(updatedEntry, "refreshed", {
					now: Date.now(),
					ttlMs: metadataOptions.ttlMs,
					staleIfErrorMs: metadataOptions.staleIfErrorMs,
					revalidatedAt: (/* @__PURE__ */ new Date()).toISOString()
				})) };
			},
			finalize: async (response, durationMs, currentRequest, runAfter) => {
				const body = await parseResponseBody(this.hasAfterInterceptors() ? response.clone() : response, metadataOptions.maxResponseBytes);
				const envelopeError = geoServicesEnvelopeError(response.status, body);
				if (envelopeError) {
					const stale = this.staleMetadataFallback(cached, metadataOptions, envelopeError);
					if (stale) return stale;
					await this.applyErrorInterceptors({
						request: cloneRequestContext(currentRequest),
						error: envelopeError,
						durationMs
					});
					throw envelopeError;
				}
				await runAfter();
				const cleanBody = withoutHonuaCacheState(body);
				const validator = honuaCacheValidatorFromHeaders(response.headers);
				const sourceUpdatedAt = response.headers.get("last-modified") ?? void 0;
				const entry = {
					body: cleanBody,
					cachedAtMs: Date.now(),
					keyFingerprint,
					...validator ? { validator } : {},
					...sourceUpdatedAt ? { sourceUpdatedAt } : {}
				};
				const status = bypass ? "bypass" : cached ? "refreshed" : "miss";
				if (!bypass) this.setMetadataCacheEntry(keyFingerprint, entry);
				return withHonuaCacheState(cleanBody, createMetadataCacheState(entry, status, {
					now: Date.now(),
					ttlMs: metadataOptions.ttlMs,
					staleIfErrorMs: metadataOptions.staleIfErrorMs,
					...status === "refreshed" ? { revalidatedAt: (/* @__PURE__ */ new Date()).toISOString() } : {}
				}));
			}
		});
	}
	staleMetadataFallback(cached, options, error) {
		if (!cached || options.cache === "bypass" || !options.staleIfError) return;
		const staleIfErrorMs = options.staleIfErrorMs ?? 36e5;
		if (Date.now() - cached.cachedAtMs > staleIfErrorMs) return;
		return withHonuaCacheState(cached.body, createMetadataCacheState(cached, "stale", {
			now: Date.now(),
			ttlMs: options.ttlMs,
			staleIfErrorMs: options.staleIfErrorMs,
			refreshErrorId: metadataRefreshErrorId(error)
		}));
	}
	setMetadataCacheEntry(key, entry) {
		this.metadataCache.set(key, entry);
		while (this.metadataCache.size > DEFAULT_METADATA_CACHE_MAX_ENTRIES) {
			const oldest = [...this.metadataCache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs)[0];
			if (!oldest) return;
			this.metadataCache.delete(oldest[0]);
		}
	}
	async getLayerMetadata(serviceId, layerId, options = {}) {
		return getLayerMetadata(this.protocolTransport, serviceId, layerId, options);
	}
	async getFeatureServiceMetadata(serviceId, options = {}) {
		return getFeatureServiceMetadata(this.protocolTransport, serviceId, options);
	}
	/**
	* Resolve (and memoize) the OGC API Features endpoint layout for the
	* given discovery `mode`. `honua-facade` (default) returns the fixed
	* `/ogc/features/...` fast path with no network access; `ogc-api` and
	* `auto` discover the layout from the server's landing page per OGC API
	* - Common so the same typed surface works against pygeoapi / ldproxy /
	* GeoServer. Discovery is cached per mode for the life of the client
	* (the layout is a function of the fixed `baseUrl`).
	*/
	resolveOgcFeaturesLayout(mode = "honua-facade") {
		if (mode === "honua-facade") return Promise.resolve(honuaFacadeFeaturesLayout());
		let cached = this.ogcLayoutCache.get(mode);
		if (!cached) {
			cached = resolveOgcEndpointLayout(this.protocolTransport, mode).catch((err) => {
				this.ogcLayoutCache.delete(mode);
				throw err;
			});
			this.ogcLayoutCache.set(mode, cached);
		}
		return cached;
	}
	async getOgcFeaturesLanding(request = {}) {
		return getOgcFeaturesLanding(this.protocolTransport, request);
	}
	async getOgcFeaturesConformance(request = {}) {
		return getOgcFeaturesConformance(this.protocolTransport, request);
	}
	async listOgcCollections(request = {}) {
		return listOgcCollections(this.protocolTransport, request);
	}
	async getOgcCollection(request) {
		return getOgcCollection(this.protocolTransport, request);
	}
	async getOgcQueryables(request) {
		return getOgcQueryables(this.protocolTransport, request);
	}
	async listOgcItems(request) {
		return listOgcItems(this.protocolTransport, request);
	}
	async getOgcItem(request) {
		return getOgcItem(this.protocolTransport, request);
	}
	async createOgcItem(request) {
		return createOgcItem(this.protocolTransport, request);
	}
	async replaceOgcItem(request) {
		return replaceOgcItem(this.protocolTransport, request);
	}
	async patchOgcItem(request) {
		return patchOgcItem(this.protocolTransport, request);
	}
	async deleteOgcItem(request) {
		await deleteOgcItem(this.protocolTransport, request);
	}
	async getOgcTilesLanding(request = {}) {
		return getOgcTilesLanding(this.protocolTransport, request);
	}
	async getOgcTilesConformance(request = {}) {
		return getOgcTilesConformance(this.protocolTransport, request);
	}
	async listOgcTileMatrixSets(request = {}) {
		return listOgcTileMatrixSets(this.protocolTransport, request);
	}
	async getOgcTileMatrixSet(request) {
		return getOgcTileMatrixSet(this.protocolTransport, request);
	}
	async listOgcCollectionTilesets(request) {
		return listOgcCollectionTilesets(this.protocolTransport, request);
	}
	async getOgcCollectionTileset(request) {
		return getOgcCollectionTileset(this.protocolTransport, request);
	}
	async fetchOgcTile(request) {
		return fetchOgcTile(this.protocolTransport, request);
	}
	async getOgcMapsLanding(request = {}) {
		return getOgcMapsLanding(this.protocolTransport, request);
	}
	async getOgcMapsConformance(request = {}) {
		return getOgcMapsConformance(this.protocolTransport, request);
	}
	async getOgcMapImage(request) {
		return getOgcMapImage(this.protocolTransport, request);
	}
	async getOgcRecordsLanding(request = {}) {
		return getOgcRecordsLanding(this.protocolTransport, request);
	}
	async getOgcRecordsConformance(request = {}) {
		return getOgcRecordsConformance(this.protocolTransport, request);
	}
	async listOgcRecordCollections(request = {}) {
		return listOgcRecordCollections(this.protocolTransport, request);
	}
	async getOgcRecordCollection(request) {
		return getOgcRecordCollection(this.protocolTransport, request);
	}
	async searchOgcRecords(request) {
		return searchOgcRecords(this.protocolTransport, request);
	}
	async getOgcRecord(request) {
		return getOgcRecord(this.protocolTransport, request);
	}
	async fetchOgcRecordsRaw(request) {
		return fetchOgcRecordsRaw(this.protocolTransport, request);
	}
	async fetchOgcRecordRaw(request) {
		return fetchOgcRecordRaw(this.protocolTransport, request);
	}
	/**
	* Fetch and parse a WMS `GetCapabilities` document for the addressed
	* service. The XML body decodes through `requestText`; the parsed
	* shape is the typed `WmsCapabilities` envelope (no XML node leaks
	* through the public surface).
	*/
	async getWmsCapabilities(request) {
		return getWmsCapabilities(this.protocolTransport, request);
	}
	/** Render a WMS `GetMap`. Returns the raw image bytes. */
	async getWmsMap(request) {
		return getWmsMap(this.protocolTransport, request);
	}
	/**
	* Issue a WMS `GetFeatureInfo`. When `INFO_FORMAT=application/json`
	* the JSON body decodes into the canonical `HonuaTypedFeature[]`
	* shape; non-JSON formats round-trip on `bytes` so callers retain the
	* raw payload behind the protocol escape hatch.
	*/
	async getWmsFeatureInfo(request) {
		return getWmsFeatureInfo(this.protocolTransport, request);
	}
	/**
	* Fetch a WMS `GetLegendGraphic`. honua-server does not implement
	* GetLegendGraphic today; callers should branch on
	* `WmsCapabilities.request.getLegendGraphic` before invoking. When
	* the wire returns 5xx the underlying `HonuaHttpError` flows through.
	*/
	async getWmsLegend(request) {
		return getWmsLegend(this.protocolTransport, request);
	}
	async getWmtsCapabilities(request) {
		return getWmtsCapabilities(this.protocolTransport, request);
	}
	/**
	* Fetch a single WMTS tile. `mode` selects between KVP
	* (`?REQUEST=GetTile&...`) and the RESTful path
	* (`/{layer}/{style}/{tms}/{z}/{y}/{x}.{ext}`). honua-server
	* advertises both; the SDK defaults to RESTful because the wire path
	* is a single string substitution per tile and skips
	* URLSearchParams serialisation on the hot path.
	*/
	async fetchWmtsTile(request) {
		return fetchWmtsTile(this.protocolTransport, request);
	}
	/**
	* WMTS GetFeatureInfo. honua-server accepts both KVP and RESTful
	* routing; mode default mirrors `fetchWmtsTile`.
	*/
	async getWmtsFeatureInfo(request) {
		return getWmtsFeatureInfo(this.protocolTransport, request);
	}
	async getOgcProcessesLanding(request = {}) {
		return getOgcProcessesLanding(this.protocolTransport, request);
	}
	async getOgcProcessesConformance(request = {}) {
		return getOgcProcessesConformance(this.protocolTransport, request);
	}
	async listOgcProcesses(request = {}) {
		return listOgcProcesses(this.protocolTransport, request);
	}
	async getOgcProcess(request) {
		return getOgcProcess(this.protocolTransport, request);
	}
	async executeOgcProcess(request) {
		return executeOgcProcess(this.protocolTransport, request);
	}
	async getOgcProcessJob(request) {
		return getOgcProcessJob(this.protocolTransport, request);
	}
	async getOgcProcessJobResults(request) {
		return getOgcProcessJobResults(this.protocolTransport, request);
	}
	async cancelOgcProcessJob(request) {
		return cancelOgcProcessJob(this.protocolTransport, request);
	}
	async getStacLanding(request = {}) {
		return getStacLanding(this.protocolTransport, request);
	}
	async listStacCollections(request = {}) {
		return listStacCollections(this.protocolTransport, request);
	}
	async getStacCollection(request) {
		return getStacCollection(this.protocolTransport, request);
	}
	async getStacItem(request) {
		return getStacItem(this.protocolTransport, request);
	}
	async searchStac(request = {}) {
		return searchStac(this.protocolTransport, request);
	}
	async getMapServiceMetadata(serviceId, options = {}) {
		return getMapServiceMetadata(this.protocolTransport, serviceId, options);
	}
	async getMapLayerMetadata(serviceId, layerId, options = {}) {
		return getMapLayerMetadata(this.protocolTransport, serviceId, layerId, options);
	}
	/**
	* Run a GeoServices `FeatureServer/query` request against a Honua-hosted layer.
	*
	* This is the canonical low-level read path. It maps directly to the FeatureServer
	* `query` endpoint and accepts the full ArcGIS query shape (`where`, `outFields`,
	* `geometry`, `spatialRel`, `orderByFields`, `resultRecordCount`, `outSr`, ...).
	*
	* For cross-protocol code (OGC, WFS, OData, STAC), prefer the protocol-neutral
	* {@link createDataset} contract — it normalizes capability differences and gives
	* you `Source.query(...)` plus paginated `Source.queryAll(...)` with explicit
	* `exceededTransferLimit` reporting.
	*
	* @example
	* ```ts
	* const { features, exceededTransferLimit } = await client.queryFeatures({
	*   serviceId: "parcels",
	*   layerId: 0,
	*   where: "STATUS = 'ACTIVE'",
	*   outFields: ["OBJECTID", "NAME"],
	*   returnGeometry: true,
	*   outSr: 4326,
	*   resultRecordCount: 500,
	* });
	*
	* if (exceededTransferLimit) {
	*   // re-issue with `resultOffset` or use queryFeaturesStream / dataset.source().queryAll()
	* }
	* ```
	*/
	async queryFeatures(request) {
		if (this.transport === "grpc-web") {
			const client = await this.ensureConnectClient();
			const grpcAdapter = await HonuaClient.loadGrpcAdapter();
			const protoRequest = grpcAdapter.toProtoQueryRequest(request);
			try {
				const response = await client.queryFeatures(protoRequest, request.signal ? { signal: request.signal } : void 0);
				return grpcAdapter.fromProtoQueryResponse(response);
			} catch (error) {
				throw grpcAdapter.wrapConnectError(error);
			}
		}
		return queryFeaturesRest(this.protocolTransport, request, this.preferBinary);
	}
	async queryMapLayer(request) {
		return queryMapLayer(this.protocolTransport, request);
	}
	async applyEdits(request) {
		return applyEdits(this.protocolTransport, request);
	}
	async queryRelatedRecords(request) {
		return queryRelatedRecords(this.protocolTransport, request);
	}
	async queryMapRelatedRecords(request) {
		return queryMapRelatedRecords(this.protocolTransport, request);
	}
	async exportMap(request) {
		return exportMap(this.protocolTransport, request);
	}
	async getMapLegend(request) {
		return getMapLegend(this.protocolTransport, request);
	}
	async identifyMap(request) {
		return identifyMap(this.protocolTransport, request);
	}
	async findMap(request) {
		return findMap(this.protocolTransport, request);
	}
	async requestJson(method, path, init, callerSignal) {
		const request = {
			url: resolveRequestUrl(this.baseUrl, path),
			path,
			method,
			init: {
				method,
				headers: await this.composeHeaders({ Accept: "application/json" }, init?.headers),
				body: init?.body
			}
		};
		return this.executeRequest(request, {
			callerSignal,
			finalize: async (response, durationMs, currentRequest, runAfter) => {
				const body = await parseResponseBody(this.hasAfterInterceptors() ? response.clone() : response);
				const envelopeError = geoServicesEnvelopeError(response.status, body);
				if (envelopeError) {
					await this.applyErrorInterceptors({
						request: cloneRequestContext(currentRequest),
						error: envelopeError,
						durationMs
					});
					throw envelopeError;
				}
				await runAfter();
				return body;
			}
		});
	}
	/**
	* Request a PBF binary response and decode it. Falls back to JSON on failure.
	*/
	async requestBinaryWithJsonFallback(method, path, params, callerSignal) {
		const request = {
			url: resolveRequestUrl(this.baseUrl, path),
			path,
			method,
			init: {
				method,
				headers: await this.composeHeaders({ Accept: "application/x-protobuf, application/json;q=0.9" })
			}
		};
		return this.executeRequest(request, {
			callerSignal,
			finalize: async (response, durationMs, currentRequest, runAfter) => {
				await runAfter();
				if (isPbfResponse(response)) try {
					return decodePbfQueryResponse(await response.arrayBuffer());
				} catch {
					params.set("f", "json");
					const jsonPath = `${stripQuery(path)}?${params.toString()}`;
					return this.requestJson("GET", jsonPath, void 0, callerSignal ?? currentRequest.init.signal ?? void 0);
				}
				const body = await parseResponseBody(response);
				const envelopeError = geoServicesEnvelopeError(response.status, body);
				if (envelopeError) {
					await this.applyErrorInterceptors({
						request: cloneRequestContext(currentRequest),
						error: envelopeError,
						durationMs
					});
					throw envelopeError;
				}
				return body;
			}
		});
	}
	/**
	* Fetch a text response (e.g. XML / JSON / plain) with an explicit Accept
	* negotiation. Used by the WFS adapter for `GetCapabilities`,
	* `Transaction` responses, and ExceptionReport bodies, and by the
	* WMS / WMTS Capabilities pipelines. Routes through the same
	* interceptor / retry / abort pipeline as `requestJson` /
	* `requestBytes`, so adapter callers do not need to bypass `HonuaClient`
	* to reach `fetch` directly.
	*/
	async requestText(method, path, options) {
		if (options?.maxResponseBytes !== void 0 && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)) throw new TypeError("maxResponseBytes must be a positive safe integer.");
		const acceptHeader = options?.accept ?? "*/*";
		const headers = { Accept: acceptHeader };
		if (options?.contentType) headers["Content-Type"] = options.contentType;
		const request = {
			url: resolveRequestUrl(this.baseUrl, path),
			path,
			method,
			init: {
				method,
				headers: await this.composeHeaders(headers),
				...options?.body !== void 0 ? { body: options.body } : {}
			}
		};
		return this.executeRequest(request, {
			callerSignal: options?.signal,
			deadlineThroughFinalize: options?.maxResponseBytes !== void 0,
			errorBody: async (response, deadlineSignal) => {
				const clone = response.clone();
				const text = options?.maxResponseBytes === void 0 ? await clone.text() : new TextDecoder().decode(await readBoundedResponseBytes(clone, options.maxResponseBytes, deadlineSignal));
				const contentType = response.headers.get("content-type") ?? acceptHeader;
				return text ? {
					raw: text,
					contentType
				} : {};
			},
			finalize: async (response, _durationMs, _request, runAfter, deadlineSignal) => {
				if (options?.maxResponseBytes === void 0) {
					await runAfter();
					return {
						text: await response.text(),
						contentType: response.headers.get("content-type") ?? acceptHeader,
						status: response.status
					};
				}
				const bytes = await readBoundedResponseBytes(response, options.maxResponseBytes, deadlineSignal);
				await runAfter(preserveResponseSemantics(bufferedResponse(response, bytes), response));
				return {
					text: new TextDecoder().decode(bytes),
					contentType: response.headers.get("content-type") ?? acceptHeader,
					status: response.status
				};
			}
		});
	}
	/**
	* Fetch a binary response (raw bytes plus content type). Used by the
	* OGC API Tiles and OGC API Maps wire methods, both of which negotiate
	* non-JSON output formats. The interceptor / retry / abort plumbing
	* mirrors `requestJson`.
	*/
	async requestBytes(method, path, accept, init, callerSignal) {
		const acceptHeader = accept ?? "application/octet-stream";
		const request = {
			url: resolveRequestUrl(this.baseUrl, path),
			path,
			method,
			init: {
				method,
				headers: await this.composeHeaders({ Accept: acceptHeader }, init?.headers),
				body: init?.body
			}
		};
		return this.executeRequest(request, {
			callerSignal,
			finalize: async (response, _durationMs, _request, runAfter) => {
				await runAfter();
				const buffer = await response.arrayBuffer();
				const bytes = new Uint8Array(buffer);
				return {
					bytes,
					contentType: response.headers.get("content-type") ?? acceptHeader,
					empty: response.status === 204 || bytes.byteLength === 0
				};
			}
		});
	}
	/**
	* Single owner of the HTTP attempt loop shared by every typed request
	* wrapper: before-interceptors, per-attempt timeout, network-error
	* normalization + retry, replay-safe auth refresh, HTTP-status retry, and the
	* after/error-interceptor calls. The previous implementation copy-pasted this
	* loop across six methods (pipelineFetch / requestCachedMetadataJson /
	* requestJson / requestBinaryWithJsonFallback / requestText / requestBytes),
	* and the copies had drifted in signal, okStatuses, and 304 handling — the
	* exact surface where an auth-replay / retry regression can appear in one
	* transport but not the others.
	*
	* Wrappers supply only what differs:
	* - `finalize` turns a successful `Response` into the wrapper's `T`. It is
	*   handed a `runAfter` thunk so it controls *when* after-interceptors fire
	*   (e.g. before vs. after a GeoServices error-envelope check) and can parse
	*   the original body without a defensive clone (see `hasAfterInterceptors`).
	* - `shortCircuit` (optional) inspects the response before the ok/!ok split,
	*   e.g. a metadata `304 Not Modified`.
	* - `okStatuses` (optional) treats specific non-2xx statuses as success.
	* - `errorBody` (optional) builds the body fed to `toHttpError` on failure.
	* - `onTerminalError` (optional) yields a fallback value instead of throwing
	*   on a terminal network/HTTP error, e.g. stale-if-error metadata.
	*/
	async executeRequest(initialRequest, options) {
		let request = await this.applyBeforeInterceptors(initialRequest);
		const retrySignal = options.callerSignal ?? request.init.signal ?? void 0;
		let refreshedAuth = false;
		for (let attempt = 0;; attempt += 1) {
			let response;
			await options.beforeAttempt?.(cloneRequestContext(request), attempt);
			const timeout = createTimeoutSignal(options.callerSignal ?? request.init.signal, this.timeoutMs);
			const startTime = performance.now();
			let fetchCompleted = false;
			try {
				response = await this.fetchWithSafeRedirects(request.url, {
					...request.init,
					method: request.method,
					signal: timeout.signal
				}, options.redirect);
				fetchCompleted = true;
			} catch (error) {
				const durationMs = performance.now() - startTime;
				const normalizedError = timeout.didTimeout ? new HonuaTimeoutError(this.timeoutMs ?? 0) : normalizeNetworkError(error);
				if (shouldRetryRequest(this.retryOptions, request.method, attempt, void 0, normalizedError)) {
					await options.beforeReplay?.(cloneRequestContext(request), void 0, "retry");
					await this.sleepBeforeRetry(attempt, void 0, retrySignal);
					continue;
				}
				const fallback = options.onTerminalError?.(normalizedError);
				if (fallback !== void 0) return fallback;
				await this.applyErrorInterceptors({
					request: cloneRequestContext(request),
					error: normalizedError,
					durationMs
				});
				throw normalizedError;
			} finally {
				if (!fetchCompleted || !options.deadlineThroughFinalize) timeout.dispose();
			}
			const durationMs = performance.now() - startTime;
			const currentRequest = request;
			let terminalErrorNotification;
			const beginTerminalErrorNotification = (error, errorDurationMs) => {
				if (terminalErrorNotification) return {
					claimed: false,
					completion: terminalErrorNotification.completion
				};
				const completion = this.applyErrorInterceptorsConcurrently({
					request: cloneRequestContext(currentRequest),
					error,
					durationMs: errorDurationMs
				});
				terminalErrorNotification = { completion };
				return {
					claimed: true,
					completion
				};
			};
			const awaitDeadlineOwned = async (operation) => {
				return await awaitAbortable(operation.catch(async (error) => {
					const notification = beginTerminalErrorNotification(error, performance.now() - startTime);
					if (notification.claimed) await notification.completion;
					throw error;
				}), timeout.signal);
			};
			const runAfter = async (preparedResponse = response) => {
				try {
					await this.applyAfterInterceptors(cloneRequestContext(currentRequest), preparedResponse, durationMs, options.deadlineThroughFinalize ? timeout.signal : void 0);
				} catch (error) {
					if (options.deadlineThroughFinalize) throw error;
					await this.applyErrorInterceptors({
						request: cloneRequestContext(currentRequest),
						error,
						durationMs
					});
					throw error;
				}
			};
			try {
				if (options.shortCircuit) {
					const shorted = await options.shortCircuit(response, durationMs, currentRequest, runAfter);
					if (shorted) return shorted.value;
				}
				if (!response.ok && !options.okStatuses?.includes(response.status)) {
					const body = options.errorBody ? await options.errorBody(response, options.deadlineThroughFinalize ? timeout.signal : void 0) : await parseResponseBody(response.clone());
					const httpError = toHttpError(response.status, body);
					if (!refreshedAuth && (response.status === 401 || response.status === 403) && this.authProvider && DEFAULT_RETRY_METHODS.has(request.method)) await options.beforeReplay?.(cloneRequestContext(request), response.status, "authentication");
					const authRefreshedRequest = refreshedAuth ? void 0 : await this.refreshReplaySafeRequestAuth(request, response.status);
					if (authRefreshedRequest) {
						request = authRefreshedRequest;
						refreshedAuth = true;
						continue;
					}
					if (shouldRetryRequest(this.retryOptions, request.method, attempt, response.status, httpError)) {
						await options.beforeReplay?.(cloneRequestContext(request), response.status, "retry");
						await this.sleepBeforeRetry(attempt, response, retrySignal);
						continue;
					}
					const fallback = options.onTerminalError?.(httpError);
					if (fallback !== void 0) return fallback;
					if (options.deadlineThroughFinalize) return await awaitDeadlineOwned(Promise.reject(httpError));
					await this.applyErrorInterceptors({
						request: cloneRequestContext(request),
						error: httpError,
						durationMs
					});
					throw httpError;
				}
				const finalized = options.finalize(response, durationMs, currentRequest, runAfter, timeout.signal);
				return await (options.deadlineThroughFinalize ? awaitDeadlineOwned(finalized) : finalized);
			} catch (error) {
				if (!options.deadlineThroughFinalize || !timeout.signal?.aborted) throw error;
				const terminalError = timeout.didTimeout ? new HonuaTimeoutError(this.timeoutMs ?? 0) : new HonuaAbortError();
				beginTerminalErrorNotification(terminalError, performance.now() - startTime);
				throw terminalError;
			} finally {
				if (options.deadlineThroughFinalize) timeout.dispose();
			}
		}
	}
	async applyBeforeInterceptors(request) {
		let next = cloneRequestContext(request);
		next = {
			...next,
			url: normalizeInterceptorRequestUrl(this.baseUrl, next.url)
		};
		for (const interceptor of this.interceptors) {
			const mutation = await interceptor.before?.(cloneRequestContext(next));
			if (!mutation) continue;
			next = applyRequestMutation(next, mutation);
			next = {
				...next,
				url: normalizeInterceptorRequestUrl(this.baseUrl, next.url)
			};
		}
		return next;
	}
	async applyAfterInterceptors(request, response, durationMs, deadlineSignal) {
		for (const interceptor of this.interceptors) {
			if (!interceptor.after) continue;
			if (deadlineSignal?.aborted) throw new HonuaAbortError();
			const context = {
				request: cloneRequestContext(request),
				response: response.clone(),
				durationMs
			};
			await interceptor.after(context);
			if (deadlineSignal?.aborted) throw new HonuaAbortError();
		}
	}
	/** Whether any registered interceptor inspects responses (`after` hook). */
	hasAfterInterceptors() {
		return this.interceptors.some((interceptor) => interceptor.after !== void 0);
	}
	async applyErrorInterceptors(context) {
		for (const interceptor of this.interceptors) try {
			await interceptor.error?.(context);
		} catch {}
	}
	/**
	* Start every terminal error hook independently so one nonsettling hook
	* cannot prevent later hooks from observing the same failure. Each hook is
	* contained so a detached deadline notification can never reject unhandled.
	*/
	async applyErrorInterceptorsConcurrently(context) {
		await Promise.all(this.interceptors.map(async (interceptor) => {
			try {
				await interceptor.error?.(context);
			} catch {}
		}));
	}
	async refreshReplaySafeRequestAuth(request, statusCode) {
		if (statusCode !== 401 && statusCode !== 403 || !this.authProvider || !DEFAULT_RETRY_METHODS.has(request.method)) return;
		const refreshed = await this.resolveAuthCredentials({
			forceRefresh: true,
			reason: "unauthorized"
		});
		if (!refreshed) return void 0;
		return {
			...request,
			init: {
				...request.init,
				headers: mergeHeaders(request.init.headers, authHeadersFromCredentials(refreshed.credentials))
			}
		};
	}
	async sleepBeforeRetry(attempt, response, signal) {
		await sleep(resolveRetryDelayMs(this.retryOptions, attempt, response), signal);
	}
};
/**
* Detect a GeoServices/Esri error envelope returned on an HTTP 2xx response.
*
* GeoServices services (FeatureServer/MapServer/GeocodeServer/…) report
* operation failures as HTTP 200 with a body of the shape
* `{ error: { code, message, ... } }`. Without this guard such failures are
* cast verbatim to the success response type and surface downstream as empty
* results or confusing `undefined` access. Returns a normalized
* {@link HonuaHttpError} when the envelope is present, otherwise `undefined`.
*/
function geoServicesEnvelopeError(httpStatus, body) {
	if (!isObject(body) || !isObject(body.error)) return;
	const error = body.error;
	const hasCode = typeof error.code === "number";
	const hasMessage = typeof error.message === "string";
	if (!hasCode && !hasMessage) return;
	return new HonuaHttpError(hasCode ? error.code : httpStatus, hasMessage ? error.message : "Request failed", body);
}
async function parseResponseBody(response, maxResponseBytes) {
	const text = maxResponseBytes === void 0 ? await response.text() : new TextDecoder().decode(await readBoundedResponseBytes(response, maxResponseBytes));
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}
async function readBoundedResponseBytes(response, maximum, signal) {
	if (signal?.aborted) {
		response.body?.cancel().catch(() => void 0);
		throw new HonuaAbortError();
	}
	const advertised = response.headers.get("content-length");
	if (advertised !== null) {
		const length = Number(advertised);
		if (Number.isFinite(length) && length > maximum) {
			response.body?.cancel().catch(() => void 0);
			throw new HonuaNetworkError(`Response body exceeds the configured ${maximum}-byte limit.`, void 0);
		}
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	const abort = () => void reader.cancel().catch(() => void 0);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			if (signal?.aborted) throw new HonuaAbortError();
			const { done, value } = await reader.read();
			if (signal?.aborted) throw new HonuaAbortError();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) {
				reader.cancel().catch(() => void 0);
				throw new HonuaNetworkError(`Response body exceeds the configured ${maximum}-byte limit.`, void 0);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (signal?.aborted) throw new HonuaAbortError();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
function bufferedResponse(source, bytes) {
	const body = source.status === 204 || source.status === 205 || source.status === 304 ? null : bytes.slice();
	return new Response(body, {
		status: source.status,
		statusText: source.statusText,
		headers: source.headers
	});
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function applyRequestMutation(request, mutation) {
	const nextInit = mutation.init === void 0 ? request.init : {
		...request.init,
		...mutation.init,
		headers: mergeHeaders(request.init.headers, mutation.init.headers)
	};
	return {
		url: mutation.url ?? request.url,
		path: request.path,
		method: mutation.method ?? request.method,
		init: {
			...nextInit,
			method: mutation.method ?? request.method
		}
	};
}
function cloneRequestContext(request) {
	return {
		...request,
		init: {
			...request.init,
			headers: cloneHeadersInit(request.init.headers)
		}
	};
}
function awaitAbortable(value, signal) {
	const pending = Promise.resolve(value);
	if (!signal) return pending;
	if (signal.aborted) {
		pending.catch(() => void 0);
		return Promise.reject(new HonuaAbortError());
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			callback();
		};
		const abort = () => finish(() => reject(new HonuaAbortError()));
		signal.addEventListener("abort", abort, { once: true });
		pending.then((result) => finish(() => resolve(result)), (error) => finish(() => reject(error)));
	});
}
/**
* A response prepared under a tighter body boundary still represents the same
* physical fetch. Preserve the fetch-owned semantic properties for public
* interceptors and for every defensive clone they receive.
*/
function preserveResponseSemantics(response, source) {
	return decorateResponseSemantics(response, Object.freeze({
		url: source.url,
		type: source.type,
		redirected: source.redirected
	}));
}
function decorateResponseSemantics(response, semantics) {
	const nativeClone = response.clone.bind(response);
	Object.defineProperties(response, {
		url: {
			configurable: true,
			value: semantics.url
		},
		type: {
			configurable: true,
			value: semantics.type
		},
		redirected: {
			configurable: true,
			value: semantics.redirected
		},
		clone: {
			configurable: true,
			value: () => decorateResponseSemantics(nativeClone(), semantics)
		}
	});
	return response;
}
function cloneHeadersInit(headers) {
	return mergeHeaders(headers);
}
function normalizeAuthProvider(auth) {
	if (!auth) return;
	if (typeof auth === "function") return { getCredentials: auth };
	return {
		getCredentials: (context) => auth.getCredentials(context),
		...auth.revokeCredentials ? { revokeCredentials: auth.revokeCredentials.bind(auth) } : {}
	};
}
function normalizeAuthRefreshSkewMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AUTH_REFRESH_SKEW_MS;
	return Math.max(0, Math.trunc(value));
}
function normalizeAuthCredentials(value) {
	if (typeof value === "string") return value.length > 0 ? { bearerToken: value } : void 0;
	if (!value) return;
	const credentials = {};
	if (typeof value.apiKey === "string" && value.apiKey.length > 0) credentials.apiKey = value.apiKey;
	if (typeof value.bearerToken === "string" && value.bearerToken.length > 0) credentials.bearerToken = value.bearerToken;
	if (typeof value.authorization === "string" && value.authorization.length > 0) credentials.authorization = value.authorization;
	if (value.expiresAt !== void 0) credentials.expiresAt = value.expiresAt;
	if (!credentials.apiKey && !credentials.bearerToken && !credentials.authorization) return;
	return credentials;
}
function normalizeAuthExpiresAtMs(expiresAt) {
	if (expiresAt === void 0) return;
	if (expiresAt instanceof Date) return Number.isFinite(expiresAt.getTime()) ? expiresAt.getTime() : void 0;
	if (typeof expiresAt === "number") return Number.isFinite(expiresAt) ? expiresAt : void 0;
	const parsed = Date.parse(expiresAt);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function isAuthCredentialsExpiring(cached, skewMs) {
	if (cached.expiresAtMs === void 0) return false;
	return cached.expiresAtMs - Date.now() <= skewMs;
}
function resolveAuthRefreshReason(cached) {
	return cached ? "expired" : "initial";
}
function authHeadersFromCredentials(credentials) {
	const headers = {};
	if (credentials.apiKey) headers["X-API-Key"] = credentials.apiKey;
	if (credentials.authorization) headers.Authorization = credentials.authorization;
	else if (credentials.bearerToken) headers.Authorization = `Bearer ${credentials.bearerToken}`;
	return Object.keys(headers).length > 0 ? headers : void 0;
}
function createMetadataCacheState(entry, status, options) {
	return createHonuaCacheState({
		scope: "metadata",
		status,
		keyFingerprint: entry.keyFingerprint,
		ageMs: Math.max(0, options.now - entry.cachedAtMs),
		...options.ttlMs !== void 0 ? { ttlMs: options.ttlMs } : {},
		...options.staleIfErrorMs !== void 0 ? { staleIfErrorMs: options.staleIfErrorMs } : {},
		...options.revalidatedAt ? { revalidatedAt: options.revalidatedAt } : {},
		...entry.sourceUpdatedAt ? { sourceUpdatedAt: entry.sourceUpdatedAt } : {},
		...entry.validator ? { validator: entry.validator } : {},
		...options.refreshErrorId ? { refreshErrorId: options.refreshErrorId } : {}
	});
}
function metadataRefreshErrorId(error) {
	if (error instanceof HonuaHttpError) return `http-${error.statusCode}`;
	if (error instanceof HonuaTimeoutError) return "timeout";
	if (error instanceof HonuaNetworkError) return "network";
	if (error instanceof Error && error.name) return error.name;
	return "unknown";
}
function mergePathWithQueryParams(path, additionalParams) {
	if (additionalParams.size === 0) return path;
	const hashIndex = path.indexOf("#");
	const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
	const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
	const queryIndex = withoutHash.indexOf("?");
	const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
	const existingQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
	const merged = new URLSearchParams(existingQuery);
	for (const [key, value] of additionalParams.entries()) merged.set(key, value);
	const nextQuery = merged.toString();
	return `${nextQuery.length > 0 ? `${basePath}?${nextQuery}` : basePath}${hash}`;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/event-bus.js
var CompatEventBus = class {
	listenersByType;
	anyListeners;
	constructor() {
		this.listenersByType = /* @__PURE__ */ new Map();
		this.anyListeners = /* @__PURE__ */ new Set();
	}
	on(type, listener) {
		let listeners = this.listenersByType.get(type);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.listenersByType.set(type, listeners);
		}
		const untypedListener = listener;
		listeners.add(untypedListener);
		return { remove: () => {
			listeners?.delete(untypedListener);
		} };
	}
	onAny(listener) {
		const untypedListener = listener;
		this.anyListeners.add(untypedListener);
		return { remove: () => {
			this.anyListeners.delete(untypedListener);
		} };
	}
	emit(type, payload, source = void 0) {
		const event = {
			type,
			payload,
			source,
			timestamp: Date.now()
		};
		this.dispatchToTypeListeners(type, event);
		this.dispatchToAnyListeners(event);
		return event;
	}
	clear() {
		this.listenersByType.clear();
		this.anyListeners.clear();
	}
	dispatchToTypeListeners(type, event) {
		const listeners = this.listenersByType.get(type);
		if (!listeners) return;
		for (const listener of listeners) this.safeInvoke(listener, event);
	}
	dispatchToAnyListeners(event) {
		for (const listener of this.anyListeners) this.safeInvoke(listener, event);
	}
	safeInvoke(listener, event) {
		try {
			listener(event);
		} catch {}
	}
};
function resolveCompatEventBus(...candidates) {
	for (const candidate of candidates) {
		if (!isRecord$5(candidate)) continue;
		if (candidate.eventBus instanceof CompatEventBus) return candidate.eventBus;
	}
}
function safeInvokeCompatListener(listener, value) {
	try {
		listener(value);
	} catch {}
}
function isRecord$5(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/url.js
var ABSOLUTE_URL_RE = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
var PROTOCOL_RELATIVE_URL_RE = /^\/\//;
var RELATIVE_URL_BASE = "https://honua.invalid";
var FEATURE_LAYER_PATH_RE = /^(?<prefix>.*)\/rest\/services\/(?<serviceId>[^/]+(?:\/[^/]+)*)\/FeatureServer\/(?<layerId>\d+)\/?$/;
function parseFeatureLayerUrl(url) {
	const { parsed, absolute } = parseServiceUrl(url);
	const match = parsed.pathname.match(FEATURE_LAYER_PATH_RE);
	if (!match || !match.groups) throw new Error("Invalid FeatureLayer URL. Expected .../rest/services/{serviceId}/FeatureServer/{layerId}");
	const serviceId = decodeURIComponent(match.groups.serviceId);
	const layerId = Number.parseInt(match.groups.layerId, 10);
	if (Number.isNaN(layerId)) throw new Error("FeatureLayer URL contains an invalid numeric layerId.");
	const prefix = match.groups.prefix || "";
	return {
		baseUrl: absolute ? `${parsed.protocol}//${parsed.host}${prefix}`.replace(/\/+$/, "") : prefix.replace(/\/+$/, ""),
		serviceId,
		layerId
	};
}
function parseServiceUrl(url) {
	if (ABSOLUTE_URL_RE.test(url)) return {
		parsed: new URL(url),
		absolute: true
	};
	if (PROTOCOL_RELATIVE_URL_RE.test(url)) return {
		parsed: new URL(`https:${url}`),
		absolute: true
	};
	const normalized = url.startsWith("/") ? url : `/${url}`;
	return {
		parsed: new URL(normalized, RELATIVE_URL_BASE),
		absolute: false
	};
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/feature-layer.js
var DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
var FeatureLayerCompat = class {
	url;
	id;
	title;
	serviceId;
	layerId;
	outFields;
	definitionExpression;
	renderer;
	popupTemplate;
	labelingInfo;
	labelsVisible;
	opacity;
	visible;
	minScale;
	maxScale;
	legendEnabled;
	listMode;
	loaded;
	loadStatus;
	metadata;
	timeExtent;
	eventBus;
	client;
	watchListeners;
	eventListeners;
	maxAttachmentBytes;
	constructor(options) {
		const parsed = parseFeatureLayerUrl(options.url);
		this.url = options.url;
		this.serviceId = parsed.serviceId;
		this.layerId = parsed.layerId;
		this.id = options.id ?? `${this.serviceId}-${this.layerId}`;
		this.title = options.title;
		this.outFields = options.outFields === void 0 ? void 0 : Array.isArray(options.outFields) ? [...options.outFields] : [options.outFields];
		this.definitionExpression = options.definitionExpression;
		this.renderer = options.renderer;
		this.popupTemplate = options.popupTemplate;
		this.labelingInfo = Array.isArray(options.labelingInfo) ? [...options.labelingInfo] : [];
		this.labelsVisible = options.labelsVisible ?? true;
		this.opacity = normalizeOpacity(options.opacity ?? 1);
		this.visible = options.visible ?? true;
		this.minScale = normalizeScale(options.minScale);
		this.maxScale = normalizeScale(options.maxScale);
		this.legendEnabled = options.legendEnabled ?? true;
		this.listMode = options.listMode ?? "show";
		this.loaded = false;
		this.loadStatus = "not-loaded";
		this.metadata = void 0;
		this.timeExtent = void 0;
		this.eventBus = options.eventBus ?? resolveCompatEventBus(options.client) ?? new CompatEventBus();
		this.client = options.client ?? new HonuaClient({ baseUrl: parsed.baseUrl });
		this.watchListeners = /* @__PURE__ */ new Map();
		this.eventListeners = /* @__PURE__ */ new Map();
		this.maxAttachmentBytes = normalizeAttachmentSizeLimit(options.maxAttachmentBytes);
	}
	async load() {
		if (!this.loaded) {
			this.loadStatus = "loading";
			this.notifyWatchers("loadStatus", this.loadStatus);
			this.eventBus.emit("feature-layer.loading", {
				serviceId: this.serviceId,
				layerId: this.layerId,
				id: this.id
			}, this);
			try {
				this.metadata = await this.client.getLayerMetadata(this.serviceId, this.layerId);
				this.notifyWatchers("metadata", this.metadata);
				this.loaded = true;
				this.notifyWatchers("loaded", this.loaded);
				this.loadStatus = "loaded";
				this.notifyWatchers("loadStatus", this.loadStatus);
				this.eventBus.emit("feature-layer.loaded", {
					serviceId: this.serviceId,
					layerId: this.layerId,
					id: this.id
				}, this);
			} catch (error) {
				this.metadata = void 0;
				this.notifyWatchers("metadata", this.metadata);
				this.loaded = false;
				this.notifyWatchers("loaded", this.loaded);
				this.loadStatus = "failed";
				this.notifyWatchers("loadStatus", this.loadStatus);
				this.eventBus.emit("feature-layer.failed", {
					serviceId: this.serviceId,
					layerId: this.layerId,
					id: this.id,
					error
				}, this);
				throw error;
			}
		}
		return this;
	}
	async when(callback) {
		const layer = await this.load();
		if (callback) callback(layer);
		return layer;
	}
	refresh() {
		this.loaded = false;
		this.notifyWatchers("loaded", this.loaded);
		this.loadStatus = "not-loaded";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.metadata = void 0;
		this.notifyWatchers("metadata", this.metadata);
		this.eventBus.emit("feature-layer.refreshed", {
			serviceId: this.serviceId,
			layerId: this.layerId,
			id: this.id
		}, this);
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	setVisibility(visible) {
		this.visible = visible;
		this.notifyWatchers("visible", this.visible);
		this.eventBus.emit("layer.visibility-changed", {
			layerId: this.id,
			serviceId: this.serviceId,
			sublayerId: this.layerId,
			visible
		}, this);
	}
	setOpacity(opacity) {
		this.opacity = normalizeOpacity(opacity);
		this.notifyWatchers("opacity", this.opacity);
		this.eventBus.emit("layer.opacity-changed", {
			layerId: this.id,
			serviceId: this.serviceId,
			sublayerId: this.layerId,
			opacity: this.opacity
		}, this);
	}
	setRenderer(renderer) {
		this.renderer = renderer;
		this.notifyWatchers("renderer", this.renderer);
		this.eventBus.emit("feature-layer.renderer-changed", { layerId: this.id }, this);
	}
	setPopupTemplate(popupTemplate) {
		this.popupTemplate = popupTemplate;
		this.notifyWatchers("popupTemplate", this.popupTemplate);
		this.eventBus.emit("feature-layer.popup-template-changed", { layerId: this.id }, this);
	}
	setLabelingInfo(labelingInfo) {
		this.labelingInfo = [...labelingInfo];
		this.notifyWatchers("labelingInfo", this.labelingInfo);
		this.eventBus.emit("feature-layer.labeling-changed", { layerId: this.id }, this);
	}
	setDefinitionExpression(definitionExpression) {
		this.definitionExpression = definitionExpression;
		this.notifyWatchers("definitionExpression", this.definitionExpression);
		this.eventBus.emit("feature-layer.definition-expression-changed", {
			layerId: this.id,
			definitionExpression
		}, this);
	}
	setOutFields(outFields) {
		this.outFields = outFields === void 0 ? void 0 : Array.isArray(outFields) ? [...outFields] : [outFields];
		this.notifyWatchers("outFields", this.outFields);
		this.eventBus.emit("feature-layer.out-fields-changed", {
			layerId: this.id,
			outFields: this.outFields
		}, this);
	}
	setLabelsVisible(labelsVisible) {
		this.labelsVisible = labelsVisible;
		this.notifyWatchers("labelsVisible", this.labelsVisible);
		this.eventBus.emit("feature-layer.labels-visible-changed", {
			layerId: this.id,
			labelsVisible
		}, this);
	}
	setScaleRange(minScale, maxScale) {
		this.minScale = normalizeScale(minScale);
		this.maxScale = normalizeScale(maxScale);
		this.notifyWatchers("minScale", this.minScale);
		this.notifyWatchers("maxScale", this.maxScale);
		this.eventBus.emit("feature-layer.scale-range-changed", {
			layerId: this.id,
			minScale: this.minScale,
			maxScale: this.maxScale
		}, this);
	}
	setLegendEnabled(legendEnabled) {
		this.legendEnabled = legendEnabled;
		this.notifyWatchers("legendEnabled", this.legendEnabled);
		this.eventBus.emit("feature-layer.legend-enabled-changed", {
			layerId: this.id,
			legendEnabled
		}, this);
	}
	setTimeExtent(extent) {
		this.timeExtent = extent ? {
			start: new Date(extent.start.getTime()),
			end: new Date(extent.end.getTime())
		} : void 0;
		this.notifyWatchers("timeExtent", this.timeExtent);
		this.eventBus.emit("feature-layer.time-extent-change", {
			layerId: this.id,
			timeExtent: this.timeExtent
		}, this);
	}
	destroy() {
		this.watchListeners.clear();
		this.eventListeners.clear();
		this.eventBus.emit("feature-layer.destroyed", { id: this.id }, this);
	}
	on(eventName, listener) {
		const namespacedEvent = `feature-layer.${eventName}`;
		let listeners = this.eventListeners.get(eventName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.eventListeners.set(eventName, listeners);
		}
		listeners.add(listener);
		const subscription = this.eventBus.on(namespacedEvent, (event) => {
			safeInvokeCompatListener(listener, event.payload);
		});
		return { remove: () => {
			listeners?.delete(listener);
			subscription.remove();
		} };
	}
	listFields() {
		return extractFieldDefinitions(this.metadata);
	}
	getField(fieldName) {
		const normalizedFieldName = fieldName.trim();
		if (normalizedFieldName.length === 0) return;
		return this.listFields().find((field) => {
			return field.name.trim() === normalizedFieldName;
		});
	}
	hasField(fieldName) {
		return this.getField(fieldName) !== void 0;
	}
	createQuery() {
		return {
			where: this.definitionExpression ?? "1=1",
			outFields: this.outFields ? [...this.outFields] : ["*"],
			returnGeometry: true
		};
	}
	queryFeatures(options = {}) {
		const timeParam = buildTimeParam(this.timeExtent, options.extraParams);
		return this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: options.where ?? this.definitionExpression,
			outFields: options.outFields ?? this.outFields,
			returnGeometry: options.returnGeometry,
			method: options.method,
			signal: options.signal,
			extraParams: timeParam ? {
				...options.extraParams ?? {},
				time: timeParam
			} : options.extraParams
		});
	}
	async queryFeaturesAll(options = {}) {
		const { pageSize: requestedPageSize, maxPages: requestedMaxPages, ...queryOptions } = options;
		const pageSize = typeof requestedPageSize === "number" && Number.isFinite(requestedPageSize) ? Math.max(1, Math.trunc(requestedPageSize)) : 2e3;
		const maxPages = typeof requestedMaxPages === "number" && Number.isFinite(requestedMaxPages) ? Math.max(1, Math.trunc(requestedMaxPages)) : 100;
		const features = [];
		let offset = 0;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryFeatures({
				...queryOptions,
				extraParams: {
					...queryOptions.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = response.features ?? [];
			if (pageFeatures.length === 0) break;
			features.push(...pageFeatures);
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
		return features;
	}
	async *queryFeaturesStream(options = {}) {
		const { pageSize: requestedPageSize, maxPages: requestedMaxPages, ...queryOptions } = options;
		const pageSize = typeof requestedPageSize === "number" && Number.isFinite(requestedPageSize) ? Math.max(1, Math.trunc(requestedPageSize)) : 2e3;
		const maxPages = typeof requestedMaxPages === "number" && Number.isFinite(requestedMaxPages) ? Math.max(1, Math.trunc(requestedMaxPages)) : 100;
		let offset = 0;
		for (let page = 0; page < maxPages; page += 1) {
			const response = await this.queryFeatures({
				...queryOptions,
				extraParams: {
					...queryOptions.extraParams ?? {},
					resultOffset: offset,
					resultRecordCount: pageSize
				}
			});
			const pageFeatures = response.features ?? [];
			if (pageFeatures.length === 0) break;
			yield pageFeatures;
			offset += pageFeatures.length;
			if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) break;
		}
	}
	async queryObjectIds(options = {}) {
		const response = await this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: options.where ?? this.definitionExpression,
			returnGeometry: false,
			method: options.method,
			extraParams: {
				...options.extraParams,
				returnIdsOnly: true
			}
		});
		if (Array.isArray(response.objectIds)) return response.objectIds.map((value) => Number(value)).filter((value) => Number.isFinite(value));
		const features = response.features;
		if (!features) return [];
		return features.map((feature) => extractObjectId$2(feature)).filter((value) => value !== void 0);
	}
	async queryFeatureCount(options = {}) {
		const response = await this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: options.where ?? this.definitionExpression,
			returnGeometry: false,
			method: options.method,
			extraParams: {
				...options.extraParams,
				returnCountOnly: true
			}
		});
		if (typeof response.count === "number" && Number.isFinite(response.count)) return response.count;
		return response.features?.length ?? 0;
	}
	async queryExtent(options = {}) {
		const response = await this.client.queryFeatures({
			serviceId: this.serviceId,
			layerId: this.layerId,
			where: options.where ?? this.definitionExpression,
			returnGeometry: false,
			method: options.method,
			extraParams: {
				...options.extraParams,
				returnExtentOnly: true
			}
		});
		const count = typeof response.count === "number" && Number.isFinite(response.count) ? response.count : void 0;
		return {
			extent: response.extent ?? null,
			count
		};
	}
	async applyEdits(options) {
		const result = await this.client.applyEdits({
			serviceId: this.serviceId,
			layerId: this.layerId,
			adds: options.adds,
			updates: options.updates,
			deletes: options.deletes,
			rollbackOnFailure: options.rollbackOnFailure
		});
		this.eventBus.emit("feature-layer.edits", {
			result,
			layerId: this.id
		}, this);
		return result;
	}
	queryRelatedFeatures(options) {
		return this.client.queryRelatedRecords({
			serviceId: this.serviceId,
			layerId: this.layerId,
			relationshipId: options.relationshipId,
			objectIds: options.objectIds,
			where: options.where ?? this.definitionExpression,
			outFields: options.outFields ?? this.outFields,
			returnGeometry: options.returnGeometry,
			method: options.method,
			extraParams: options.extraParams
		});
	}
	queryRelatedRecords(options) {
		return this.queryRelatedFeatures(options);
	}
	queryAttachments(options = {}) {
		return this.client.request({
			method: options.method ?? "GET",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/queryAttachments`,
			responseFormat: options.responseFormat ?? "json",
			query: {
				...options.objectIds === void 0 ? {} : { objectIds: Array.isArray(options.objectIds) ? options.objectIds.join(",") : options.objectIds },
				...options.where === void 0 ? {} : { where: options.where },
				...options.extraParams ?? {}
			}
		});
	}
	listAttachments(options) {
		return this.client.request({
			method: "GET",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${options.objectId}/attachments`,
			responseFormat: options.responseFormat ?? "json",
			query: options.extraParams
		});
	}
	deleteAttachments(options) {
		const params = new URLSearchParams();
		params.set("f", options.responseFormat ?? "json");
		params.set("attachmentIds", Array.isArray(options.attachmentIds) ? options.attachmentIds.join(",") : String(options.attachmentIds));
		if (options.extraParams) for (const [key, value] of Object.entries(options.extraParams)) params.set(key, String(value));
		return this.client.request({
			method: "POST",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${options.objectId}/deleteAttachments`,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString()
		});
	}
	addAttachment(options) {
		const maxAttachmentBytes = options.maxAttachmentBytes ?? this.maxAttachmentBytes;
		enforceAttachmentSizeLimit(options.attachment, maxAttachmentBytes);
		const formOrPromise = buildAttachmentFormData({
			...options,
			maxAttachmentBytes
		});
		const sendForm = (form) => this.client.request({
			method: "POST",
			path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${options.objectId}/addAttachment`,
			responseFormat: options.responseFormat ?? "json",
			query: options.extraParams,
			body: form
		});
		if (formOrPromise instanceof Promise) return formOrPromise.then(sendForm);
		return sendForm(formOrPromise);
	}
	updateAttachment(options) {
		const maxAttachmentBytes = options.maxAttachmentBytes ?? this.maxAttachmentBytes;
		enforceAttachmentSizeLimit(options.attachment, maxAttachmentBytes);
		const formOrPromise = buildAttachmentFormData({
			...options,
			maxAttachmentBytes
		});
		const sendForm = (form) => {
			form.set("attachmentId", String(options.attachmentId));
			return this.client.request({
				method: "POST",
				path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/${options.objectId}/updateAttachment`,
				responseFormat: options.responseFormat ?? "json",
				query: options.extraParams,
				body: form
			});
		};
		if (formOrPromise instanceof Promise) return formOrPromise.then(sendForm);
		return sendForm(formOrPromise);
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeCompatListener(listener, value);
	}
};
function isRecord$4(value) {
	return typeof value === "object" && value !== null;
}
function normalizeOpacity(opacity) {
	if (!Number.isFinite(opacity)) return 1;
	return Math.min(Math.max(opacity, 0), 1);
}
function normalizeScale(scale) {
	if (scale === void 0 || !Number.isFinite(scale)) return 0;
	return Math.max(0, Math.trunc(scale));
}
function extractObjectId$2(feature) {
	if (!isRecord$4(feature)) return;
	const attributes = feature.attributes;
	if (!isRecord$4(attributes)) return;
	for (const key of [
		"objectid",
		"OBJECTID",
		"id"
	]) {
		const raw = attributes[key];
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function extractFieldDefinitions(metadata) {
	if (!isRecord$4(metadata)) return [];
	const fields = metadata.fields;
	if (!Array.isArray(fields)) return [];
	const records = [];
	for (const field of fields) {
		if (!isRecord$4(field) || typeof field.name !== "string" || typeof field.type !== "string") continue;
		records.push(field);
	}
	return records;
}
function buildAttachmentFormData(options) {
	const attachmentName = resolveAttachmentName(options.attachment, options.name);
	const blobOrPromise = normalizeAttachmentData(options.attachment, options.contentType, options.maxAttachmentBytes);
	const buildForm = (blob) => {
		const form = new FormData();
		if (options.name) form.set("name", options.name);
		form.set("attachment", blob, attachmentName);
		return form;
	};
	if (blobOrPromise instanceof Promise) return blobOrPromise.then(buildForm);
	return buildForm(blobOrPromise);
}
function normalizeAttachmentSizeLimit(maxAttachmentBytes) {
	if (typeof maxAttachmentBytes !== "number" || !Number.isFinite(maxAttachmentBytes)) return DEFAULT_MAX_ATTACHMENT_BYTES;
	return Math.max(1, Math.trunc(maxAttachmentBytes));
}
function enforceAttachmentSizeLimit(attachment, maxAttachmentBytes) {
	const sizeBytes = estimateAttachmentSizeBytes(attachment);
	if (sizeBytes === void 0 || sizeBytes <= maxAttachmentBytes) return;
	throw new Error(`Attachment payload exceeds maxAttachmentBytes (${sizeBytes} > ${maxAttachmentBytes}).`);
}
function estimateAttachmentSizeBytes(attachment) {
	if (attachment instanceof Blob) return attachment.size;
	if (typeof attachment === "string") return new TextEncoder().encode(attachment).byteLength;
	if (attachment instanceof ArrayBuffer) return attachment.byteLength;
	if (isReadableStream(attachment)) return;
	return attachment.byteLength;
}
function resolveAttachmentName(attachment, explicitName) {
	if (explicitName && explicitName.trim().length > 0) return explicitName.trim();
	if (isRecord$4(attachment)) {
		const inferredName = attachment.name;
		if (typeof inferredName === "string" && inferredName.trim().length > 0) return inferredName.trim();
	}
	return "attachment.bin";
}
function buildTimeParam(timeExtent, extraParams) {
	if (!timeExtent) return;
	if (extraParams && "time" in extraParams) return;
	return `${timeExtent.start.getTime()},${timeExtent.end.getTime()}`;
}
function normalizeAttachmentData(attachment, contentType, maxAttachmentBytes) {
	if (attachment instanceof Blob) return attachment;
	if (typeof attachment === "string") return new Blob([attachment], { type: contentType ?? "text/plain" });
	if (attachment instanceof ArrayBuffer) return new Blob([attachment], { type: contentType ?? "application/octet-stream" });
	if (isReadableStream(attachment)) return collectStreamToBlob(attachment, contentType ?? "application/octet-stream", maxAttachmentBytes);
	if (ArrayBuffer.isView(attachment)) {
		const source = new Uint8Array(attachment.buffer, attachment.byteOffset, attachment.byteLength);
		const copy = Uint8Array.from(source);
		return new Blob([copy], { type: contentType ?? "application/octet-stream" });
	}
	throw new Error("Unsupported attachment payload type.");
}
function isReadableStream(value) {
	return typeof value === "object" && value !== null && "getReader" in value && typeof value.getReader === "function";
}
async function collectStreamToBlob(stream, contentType, maxAttachmentBytes) {
	const reader = stream.getReader();
	const chunks = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				totalBytes += value.byteLength;
				if (totalBytes > maxAttachmentBytes) {
					try {
						await reader.cancel();
					} catch {}
					throw new Error(`Attachment payload exceeds maxAttachmentBytes (${totalBytes} > ${maxAttachmentBytes}).`);
				}
				chunks.push(copyToArrayBuffer(value));
			}
		}
	} finally {
		reader.releaseLock();
	}
	return new Blob(chunks, { type: contentType });
}
function copyToArrayBuffer(chunk) {
	const copy = new Uint8Array(chunk.byteLength);
	copy.set(chunk);
	return copy.buffer;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/feature-table.js
var FeatureTableHighlightIdsCompat = class {
	values;
	listeners;
	constructor(initialIds = []) {
		this.values = [];
		this.listeners = /* @__PURE__ */ new Set();
		this.set(initialIds);
	}
	get length() {
		return this.values.length;
	}
	at(index) {
		return this.values.at(index);
	}
	toArray() {
		return [...this.values];
	}
	indexOf(objectId) {
		const normalized = normalizeObjectId(objectId);
		if (normalized === void 0) return -1;
		return this.values.indexOf(normalized);
	}
	add(...objectIds) {
		return this.push(...objectIds);
	}
	push(...objectIds) {
		const additions = normalizeUniqueObjectIds(objectIds).filter((objectId) => !this.values.includes(objectId));
		if (additions.length === 0) return this.values.length;
		this.values.push(...additions);
		this.emitChange({
			added: additions,
			removed: []
		});
		return this.values.length;
	}
	remove(objectId) {
		const index = this.indexOf(objectId);
		if (index < 0) return false;
		const removed = this.values.splice(index, 1);
		this.emitChange({
			added: [],
			removed
		});
		return true;
	}
	removeAll() {
		if (this.values.length === 0) return;
		const removed = [...this.values];
		this.values.length = 0;
		this.emitChange({
			added: [],
			removed
		});
	}
	set(objectIds) {
		const next = normalizeUniqueObjectIds(objectIds);
		const removed = this.values.filter((objectId) => !next.includes(objectId));
		const added = next.filter((objectId) => !this.values.includes(objectId));
		if (removed.length === 0 && added.length === 0 && this.values.length === next.length) return;
		this.values.length = 0;
		this.values.push(...next);
		this.emitChange({
			added,
			removed
		});
	}
	splice(start, deleteCount, ...items) {
		const currentLength = this.values.length;
		const normalizedStart = normalizeSpliceStart(start, currentLength);
		const normalizedDeleteCount = normalizeSpliceDeleteCount(deleteCount, normalizedStart, currentLength);
		const removed = this.values.splice(normalizedStart, normalizedDeleteCount);
		const additions = normalizeUniqueObjectIds(items).filter((objectId) => !this.values.includes(objectId));
		if (additions.length > 0) this.values.splice(normalizedStart, 0, ...additions);
		if (removed.length > 0 || additions.length > 0) this.emitChange({
			added: additions,
			removed
		});
		return removed;
	}
	on(type, listener) {
		if (type !== "change") return { remove: () => void 0 };
		this.listeners.add(listener);
		return { remove: () => {
			this.listeners.delete(listener);
		} };
	}
	[Symbol.iterator]() {
		return this.values[Symbol.iterator]();
	}
	emitChange(event) {
		for (const listener of this.listeners) try {
			listener({
				added: [...event.added],
				removed: [...event.removed]
			});
		} catch {}
	}
};
var FeatureTableCompat = class {
	view;
	container;
	eventBus;
	title;
	description;
	actionColumnConfig;
	attachmentsEnabled;
	paginationEnabled;
	editingEnabled;
	multiSortEnabled;
	relatedRecordsEnabled;
	objectIdField;
	state;
	loadStatus;
	filterGeometry;
	filterBySelectionEnabled;
	where;
	tableTemplate;
	visibleElements;
	fieldConfigs;
	selectionMode;
	rowSelectionEnabled;
	highlightEnabled;
	pageSize;
	autoRefreshEnabled;
	highlightIds;
	rows;
	watchListeners;
	refreshRevision;
	layerInternal;
	get size() {
		return this.rows.length;
	}
	get layer() {
		return this.layerInternal;
	}
	set layer(layer) {
		this.setLayer(layer);
	}
	get loaded() {
		return this.loadStatus === "loaded" || this.state === "loaded";
	}
	constructor(options = {}) {
		this.view = options.view;
		this.layerInternal = options.layer;
		this.container = options.container;
		this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view, options.layer) ?? new CompatEventBus();
		this.title = options.title ?? null;
		this.description = options.description;
		this.actionColumnConfig = options.actionColumnConfig ?? null;
		this.attachmentsEnabled = options.attachmentsEnabled ?? false;
		this.paginationEnabled = options.paginationEnabled ?? false;
		this.editingEnabled = options.editingEnabled ?? false;
		this.multiSortEnabled = options.multiSortEnabled ?? false;
		this.relatedRecordsEnabled = options.relatedRecordsEnabled ?? false;
		this.objectIdField = options.objectIdField ?? "OBJECTID";
		this.state = "loading";
		this.loadStatus = "not-loaded";
		this.where = options.where ?? "1=1";
		this.filterGeometry = options.filterGeometry ?? null;
		this.filterBySelectionEnabled = options.filterBySelectionEnabled ?? false;
		this.tableTemplate = options.tableTemplate ?? null;
		this.visibleElements = options.visibleElements ?? null;
		this.fieldConfigs = options.fieldConfigs ?? null;
		this.selectionMode = options.selectionMode ?? "multiple";
		this.rowSelectionEnabled = options.rowSelectionEnabled ?? true;
		this.highlightEnabled = options.highlightEnabled ?? true;
		this.pageSize = typeof options.pageSize === "number" && Number.isFinite(options.pageSize) ? Math.max(1, Math.trunc(options.pageSize)) : 25;
		this.autoRefreshEnabled = options.autoRefreshEnabled ?? true;
		this.highlightIds = new FeatureTableHighlightIdsCompat(options.highlightIds);
		this.rows = [];
		this.watchListeners = /* @__PURE__ */ new Map();
		this.refreshRevision = 0;
		this.highlightIds.on("change", (event) => {
			this.notifyWatchers("highlightIds", this.highlightIds.toArray());
			this.eventBus.emit("feature-table.selection-changed", {
				objectIds: this.highlightIds.toArray(),
				added: event.added,
				removed: event.removed
			}, this);
		});
	}
	async when(callback) {
		await this.load();
		if (callback) callback(this);
		return this;
	}
	async load() {
		if (this.loadStatus === "loaded") return this;
		await this.refresh();
		return this;
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	async refresh() {
		const refreshRevision = this.nextRefreshRevision();
		if (this.loadStatus !== "loading") {
			this.loadStatus = "loading";
			this.notifyWatchers("loadStatus", this.loadStatus);
			this.eventBus.emit("feature-table.loading", void 0, this);
		}
		this.state = "loading";
		this.notifyWatchers("state", this.state);
		this.eventBus.emit("feature-table.state-changed", { state: this.state }, this);
		if (!this.layer) {
			if (refreshRevision !== this.refreshRevision) return this.rows;
			this.rows = [];
			this.notifyWatchers("rows", this.rows);
			this.notifyWatchers("size", this.size);
			this.state = "loaded";
			this.notifyWatchers("state", this.state);
			this.eventBus.emit("feature-table.state-changed", { state: this.state }, this);
			this.loadStatus = "loaded";
			this.notifyWatchers("loadStatus", this.loadStatus);
			this.notifyWatchers("loaded", this.loaded);
			this.eventBus.emit("feature-table.loaded", { rowCount: 0 }, this);
			this.eventBus.emit("feature-table.refreshed", { rowCount: 0 }, this);
			return this.rows;
		}
		try {
			const response = await this.layer.queryFeatures({
				where: this.where,
				returnGeometry: true
			});
			if (refreshRevision !== this.refreshRevision) return this.rows;
			this.rows = extractRows(response, this.objectIdField);
			this.notifyWatchers("rows", this.rows);
			this.notifyWatchers("size", this.size);
			this.state = "loaded";
			this.notifyWatchers("state", this.state);
			this.eventBus.emit("feature-table.state-changed", { state: this.state }, this);
			this.loadStatus = "loaded";
			this.notifyWatchers("loadStatus", this.loadStatus);
			this.notifyWatchers("loaded", this.loaded);
			this.eventBus.emit("feature-table.loaded", { rowCount: this.rows.length }, this);
			this.eventBus.emit("feature-table.refreshed", { rowCount: this.rows.length }, this);
			return this.rows;
		} catch (error) {
			if (refreshRevision !== this.refreshRevision) return this.rows;
			this.state = "error";
			this.notifyWatchers("state", this.state);
			this.eventBus.emit("feature-table.state-changed", { state: this.state }, this);
			this.loadStatus = "failed";
			this.notifyWatchers("loadStatus", this.loadStatus);
			this.notifyWatchers("loaded", this.loaded);
			this.eventBus.emit("feature-table.failed", { error }, this);
			throw error;
		}
	}
	setLayer(layer) {
		if (Object.is(this.layerInternal, layer)) return;
		this.nextRefreshRevision();
		this.layerInternal = layer;
		this.notifyWatchers("layer", this.layerInternal);
		this.eventBus.emit("feature-table.layer-changed", { hasLayer: Boolean(layer) }, this);
	}
	setWhere(where) {
		this.where = where;
		this.notifyWatchers("where", this.where);
		this.eventBus.emit("feature-table.filter-changed", { where }, this);
	}
	setFilterGeometry(filterGeometry) {
		this.filterGeometry = filterGeometry;
		this.notifyWatchers("filterGeometry", this.filterGeometry);
		this.eventBus.emit("feature-table.filter-geometry-changed", { filterGeometry }, this);
	}
	selectRows(objectIds) {
		this.highlightIds.set(objectIds);
	}
	clearSelection() {
		this.highlightIds.removeAll();
	}
	getSelectedObjectIds() {
		return this.highlightIds.toArray();
	}
	getSelectedRows() {
		if (this.highlightIds.length === 0) return [];
		const selectedIds = new Set(this.highlightIds.toArray());
		return this.rows.filter((row) => selectedIds.has(row.objectId));
	}
	/**
	* Sorts current rows by the given field name and direction.
	* Returns a new sorted snapshot (does not re-fetch from the server).
	*/
	sortRows(fieldName, direction = "asc") {
		const sorted = [...this.rows].sort((a, b) => {
			const aVal = a.attributes[fieldName];
			const bVal = b.attributes[fieldName];
			const comparison = compareAttributeValues(aVal, bVal);
			return direction === "desc" ? -comparison : comparison;
		});
		this.rows = sorted;
		this.notifyWatchers("rows", this.rows);
		this.eventBus.emit("feature-table.sorted", {
			fieldName,
			direction,
			rowCount: this.rows.length
		}, this);
		return this.rows;
	}
	/**
	* Exports current rows as a JSON-serializable array of attribute records.
	* Optionally accepts a list of field names to include.
	*/
	exportRows(fieldNames) {
		return this.rows.map((row) => {
			if (!fieldNames || fieldNames.length === 0) return { ...row.attributes };
			const filtered = {};
			for (const field of fieldNames) if (field in row.attributes) filtered[field] = row.attributes[field];
			return filtered;
		});
	}
	/**
	* Finds a row by its object ID, or undefined if not found.
	*/
	findRowByObjectId(objectId) {
		return this.rows.find((row) => row.objectId === objectId);
	}
	destroy() {
		this.watchListeners.clear();
		this.eventBus.emit("feature-table.destroyed", void 0, this);
	}
	async queryRelatedRecords(options) {
		if (!this.layer) return { relatedRecordGroups: [] };
		const objectIds = options.objectIds === void 0 ? this.highlightIds.length > 0 ? this.highlightIds.toArray() : void 0 : Array.isArray(options.objectIds) ? [...options.objectIds] : options.objectIds;
		return this.layer.queryRelatedFeatures({
			relationshipId: options.relationshipId,
			objectIds,
			where: options.where ?? this.where,
			outFields: options.outFields,
			returnGeometry: options.returnGeometry,
			method: options.method,
			extraParams: options.extraParams
		});
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeCompatListener(listener, value);
	}
	nextRefreshRevision() {
		this.refreshRevision += 1;
		return this.refreshRevision;
	}
};
function extractRows(response, objectIdField) {
	if (!isRecord$3(response) || !Array.isArray(response.features)) return [];
	const rows = [];
	for (const feature of response.features) {
		if (!isRecord$3(feature) || !isRecord$3(feature.attributes)) continue;
		const objectId = extractObjectId$1(feature.attributes, objectIdField);
		if (objectId === void 0) continue;
		rows.push({
			objectId,
			attributes: { ...feature.attributes },
			geometry: feature.geometry
		});
	}
	return rows;
}
function extractObjectId$1(attributes, objectIdField) {
	const preferred = Number(attributes[objectIdField]);
	if (Number.isFinite(preferred)) return preferred;
	for (const key of [
		"OBJECTID",
		"objectid",
		"ObjectId",
		"id"
	]) {
		const parsed = Number(attributes[key]);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function isRecord$3(value) {
	return typeof value === "object" && value !== null;
}
function normalizeObjectId(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function normalizeUniqueObjectIds(values) {
	const normalized = [];
	for (const value of values) {
		const objectId = normalizeObjectId(value);
		if (objectId === void 0 || normalized.includes(objectId)) continue;
		normalized.push(objectId);
	}
	return normalized;
}
function normalizeSpliceStart(start, length) {
	if (!Number.isFinite(start)) return length;
	const integer = Math.trunc(start);
	if (integer < 0) return Math.max(length + integer, 0);
	return Math.min(integer, length);
}
function normalizeSpliceDeleteCount(deleteCount, start, length) {
	if (deleteCount === void 0) return Math.max(length - start, 0);
	if (!Number.isFinite(deleteCount)) return 0;
	return Math.min(Math.max(Math.trunc(deleteCount), 0), Math.max(length - start, 0));
}
function compareAttributeValues(a, b) {
	if (a === b) return 0;
	if (a === void 0 || a === null) return -1;
	if (b === void 0 || b === null) return 1;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
	return String(a).localeCompare(String(b));
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/map.js
var MapCompat = class {
	basemap;
	ground;
	tables;
	portalItem;
	spatialReference;
	loaded;
	loadStatus;
	eventBus;
	watchListeners;
	layersInternal;
	constructor(options = {}) {
		this.basemap = options.basemap;
		this.ground = options.ground;
		this.tables = Array.isArray(options.tables) ? [...options.tables] : [];
		this.portalItem = options.portalItem;
		this.spatialReference = options.spatialReference;
		this.loaded = false;
		this.loadStatus = "not-loaded";
		this.layersInternal = Array.isArray(options.layers) ? [...options.layers] : [];
		this.eventBus = options.eventBus ?? resolveCompatEventBus(options.layers) ?? new CompatEventBus();
		this.watchListeners = /* @__PURE__ */ new Map();
	}
	async load() {
		if (this.loaded) return this;
		this.loadStatus = "loading";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("map.loading", { layerCount: this.layersInternal.length }, this);
		this.loaded = true;
		this.notifyWatchers("loaded", this.loaded);
		this.loadStatus = "loaded";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("map.loaded", { layerCount: this.layersInternal.length }, this);
		return this;
	}
	async when(callback) {
		const map = await this.load();
		if (callback) callback(map);
		return map;
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	get layers() {
		return this.layersInternal;
	}
	get allLayers() {
		const flattened = [];
		for (const layer of this.layersInternal) {
			flattened.push(layer);
			flattened.push(...extractNestedLayers(layer));
		}
		return flattened;
	}
	add(layer, index) {
		if (index === void 0) {
			this.layersInternal.push(layer);
			this.notifyWatchers("layers", this.layers);
			this.notifyWatchers("allLayers", this.allLayers);
			this.eventBus.emit("map.layer-added", {
				layer,
				index: this.layersInternal.length - 1
			}, this);
			return;
		}
		const insertAt = normalizeInsertIndex(index, this.layersInternal.length);
		this.layersInternal.splice(insertAt, 0, layer);
		this.notifyWatchers("layers", this.layers);
		this.notifyWatchers("allLayers", this.allLayers);
		this.eventBus.emit("map.layer-added", {
			layer,
			index: insertAt
		}, this);
	}
	addMany(layers, index) {
		if (layers.length === 0) return;
		if (index === void 0) {
			const startIndex = this.layersInternal.length;
			this.layersInternal.push(...layers);
			this.notifyWatchers("layers", this.layers);
			this.notifyWatchers("allLayers", this.allLayers);
			this.eventBus.emit("map.layers-added", {
				layers: [...layers],
				index: startIndex
			}, this);
			return;
		}
		const insertAt = normalizeInsertIndex(index, this.layersInternal.length);
		this.layersInternal.splice(insertAt, 0, ...layers);
		this.notifyWatchers("layers", this.layers);
		this.notifyWatchers("allLayers", this.allLayers);
		this.eventBus.emit("map.layers-added", {
			layers: [...layers],
			index: insertAt
		}, this);
	}
	remove(layer) {
		const index = this.layersInternal.indexOf(layer);
		if (index < 0) return false;
		this.layersInternal.splice(index, 1);
		this.notifyWatchers("layers", this.layers);
		this.notifyWatchers("allLayers", this.allLayers);
		this.eventBus.emit("map.layer-removed", {
			layer,
			index
		}, this);
		return true;
	}
	removeMany(layers) {
		let removedCount = 0;
		for (const layer of layers) if (this.remove(layer)) removedCount += 1;
		return removedCount;
	}
	removeAll() {
		const removedLayers = [...this.layersInternal];
		this.layersInternal.length = 0;
		this.notifyWatchers("layers", this.layers);
		this.notifyWatchers("allLayers", this.allLayers);
		this.eventBus.emit("map.layers-cleared", { layers: removedLayers }, this);
	}
	reorder(layer, index) {
		const existingIndex = this.layersInternal.indexOf(layer);
		if (existingIndex < 0) return false;
		this.layersInternal.splice(existingIndex, 1);
		const insertAt = normalizeInsertIndex(index, this.layersInternal.length);
		this.layersInternal.splice(insertAt, 0, layer);
		this.notifyWatchers("layers", this.layers);
		this.notifyWatchers("allLayers", this.allLayers);
		this.eventBus.emit("map.layer-reordered", {
			layer,
			fromIndex: existingIndex,
			toIndex: insertAt
		}, this);
		return true;
	}
	findLayerById(id) {
		for (const layer of this.allLayers) if (isLayerWithId(layer) && layer.id === id) return layer;
	}
	setBasemap(basemap) {
		this.basemap = basemap;
		this.notifyWatchers("basemap", this.basemap);
		this.eventBus.emit("map.basemap-changed", { basemap }, this);
	}
	setGround(ground) {
		this.ground = ground;
		this.notifyWatchers("ground", this.ground);
		this.eventBus.emit("map.ground-changed", { ground }, this);
	}
	setTables(tables) {
		this.tables = [...tables];
		this.notifyWatchers("tables", this.tables);
		this.eventBus.emit("map.tables-changed", { tables: this.tables }, this);
	}
	setPortalItem(portalItem) {
		this.portalItem = portalItem;
		this.notifyWatchers("portalItem", this.portalItem);
		this.eventBus.emit("map.portal-item-changed", { portalItem }, this);
	}
	destroy() {
		this.watchListeners.clear();
		this.eventBus.emit("map.destroyed", { layerCount: this.layersInternal.length }, this);
	}
	setSpatialReference(spatialReference) {
		this.spatialReference = spatialReference;
		this.notifyWatchers("spatialReference", this.spatialReference);
		this.eventBus.emit("map.spatial-reference-changed", { spatialReference }, this);
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeCompatListener(listener, value);
	}
};
function isLayerWithId(value) {
	return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}
function extractNestedLayers(layer) {
	if (!isLayerWithChildren(layer)) return [];
	const nested = [];
	for (const child of layer.layers) {
		nested.push(child);
		nested.push(...extractNestedLayers(child));
	}
	return nested;
}
function isLayerWithChildren(value) {
	return typeof value === "object" && value !== null && "layers" in value && Array.isArray(value.layers);
}
function normalizeInsertIndex(index, length) {
	return Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : length, 0), length);
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/widget-host.js
/**
* `HonuaWidgetHost` — mounts the app-platform survival-tier web components
* (`@honua/sdk-js/web-components`, moving to `@honua/app-platform`) into the
* `container` an esri-compat widget shim was constructed with, so shim UI
* renders through the shared component set instead of shim-only markup
* (issue #493, REQ-004).
*
* Only three shims delegate through this host today — `LegendCompat`
* (`honua-legend`), `LayerListCompat` (`honua-layer-list`), and
* `TimeSliderCompat` (`honua-time-slider`, issue #959). The other ~22 shims
* that accept a `container` option are state-model-only regardless of
* registration: they never construct a host, never mount a component, and
* never emit the missing-kit diagnostic below. {@link expectedKitConstructor}
* additionally knows `honua-search` / `honua-measurement`, ready for the day
* `SearchCompat` / `MeasurementCompat` adopt the host; until then, do not
* describe the registration as something that makes "the widgets" render.
*
* The host **never imports the web-component kit** — not even dynamically:
* the `/esri-compat` entrypoint is bundle-budgeted, and any intra-package
* import (static or `import()`) would pull the whole kit plus its geometry
* closure into every compat bundle. Instead the application injects the kit
* once via {@link registerHonuaWidgetKit}:
*
* ```ts doc-test=skip reason="wiring snippet requires an application host"
* import { registerHonuaWidgetKit } from "@honua/sdk-esri-compat";
*
* // Eager (module object) or lazy (loader) — both work:
* registerHonuaWidgetKit(() => import("@honua/sdk-js/web-components"));
* ```
*
* The host is deliberately defensive:
*
* - It resolves the ArcGIS-style `container` option (an `HTMLElement` or an
*   element id) only when a DOM is present; headless (Node) shim usage keeps
*   working with no DOM side effects.
* - Without a registered kit — the default, and the only possibility in the
*   standalone `@honua/sdk-esri-compat` split package unless the app installs
*   the kit — mounting no-ops and the shims stay state-model-only, exactly
*   their pre-delegation behavior. That degradation is deliberate but silent
*   in a way that reads as a broken app, so the **first** mount in that state
*   emits a one-time diagnostic (issue #957): a `console.warn` naming
*   {@link registerHonuaWidgetKit} and linking the migration guide, plus a
*   `widget-kit.missing` event on the owning shim's `CompatEventBus`. The
*   diagnostic is per runtime, not per widget instance, and re-arms whenever
*   {@link registerHonuaWidgetKit} is called again.
* - The delegation tag must be owned by the kit's own element class; a
*   foreign registrant (e.g. an app that explicitly opted into the controls
*   kit's `honua-legend` via `defineHonuaLegend()`, which has a different
*   `entries` API) also falls back to the headless behavior.
*
* @module
*/
var globalDom = globalThis;
/**
* Where the required registration step is documented. Named verbatim in the
* missing-kit diagnostic so a developer staring at an empty container has the
* exact call and the exact page in one line of console output.
*/
var WIDGET_KIT_DOCS_URL = "https://github.com/honua-io/honua-sdk-js/blob/trunk/docs/migration-honua-maplibre.md#widget-kit-registration";
var widgetKitSource;
/**
* Latch for the one-time missing-kit diagnostic. Deliberately module-scoped
* rather than per-host: an app that forgot the registration usually builds
* several widgets, and one actionable line is a signal while one line per
* widget instance is noise.
*/
var missingWidgetKitReported = false;
/** Human-readable half of the missing-kit diagnostic. */
function missingWidgetKitMessage(tagName) {
	return [
		`[honua/esri-compat] <${tagName}> was not mounted because no Honua widget kit is registered,`,
		"so this widget stays state-model-only and its container renders nothing.",
		"Call registerHonuaWidgetKit(() => import(\"@honua/sdk-js/web-components\")) once during application",
		"startup, before constructing compat widgets. This affects the shims that delegate to the widget",
		`kit — LegendCompat, LayerListCompat, and TimeSliderCompat. See ${WIDGET_KIT_DOCS_URL}`
	].join(" ");
}
/**
* Emits the one-time missing-kit diagnostic: a `console.warn` plus a
* `widget-kit.missing` event on the shim's bus (issue #957). Both halves share
* one latch, so the event lands on the bus of the first widget that tried to
* mount — subscribe before constructing widgets.
*/
function reportMissingWidgetKit(tagName, eventBus, source) {
	if (missingWidgetKitReported) return;
	missingWidgetKitReported = true;
	const message = missingWidgetKitMessage(tagName);
	globalThis.console?.warn?.(message);
	eventBus?.emit("widget-kit.missing", {
		tagName,
		api: "registerHonuaWidgetKit",
		docs: WIDGET_KIT_DOCS_URL,
		message
	}, source);
}
var HonuaWidgetHost = class {
	#tagName;
	#container;
	#eventBus;
	#element;
	#kitLoad;
	#kitLoadSource;
	/**
	* @param eventBus Bus the owning shim publishes on. Optional so headless /
	*   standalone construction keeps working; when omitted the missing-kit
	*   diagnostic still reaches the console.
	*/
	constructor(tagName, container, eventBus) {
		this.#tagName = tagName;
		this.#container = resolveContainer(container);
		this.#eventBus = eventBus;
	}
	/** Whether a usable container was resolved (requires a DOM). */
	get available() {
		return this.#container !== void 0;
	}
	/** The mounted element, when {@link mount} has completed. */
	get element() {
		return this.#element;
	}
	/**
	* Ensures the injected web-component kit is registered and the element is
	* mounted into the container. Returns the element, or `undefined` when no
	* DOM / container / kit is available (headless shims, or an application
	* that never called {@link registerHonuaWidgetKit}).
	*
	* A container was supplied but no kit was registered — the "migrated app
	* comes up blank" case — is the one failure worth being loud about, so it
	* emits the one-time diagnostic. Headless usage (no DOM, no container) stays
	* silent: that is a legitimate state-model-only mode, not a mistake.
	*/
	async mount() {
		const container = this.#container;
		if (!container || !globalDom.document) return void 0;
		if (!widgetKitSource) {
			this.destroy();
			reportMissingWidgetKit(this.#tagName, this.#eventBus, this);
			return;
		}
		if (!await this.#loadKit()) return void 0;
		if (!this.#element || !this.#element.isConnected) {
			const element = globalDom.document.createElement(this.#tagName);
			container.replaceChildren(element);
			this.#element = element;
		}
		return this.#element;
	}
	/**
	* Mounts (when needed) and applies `assign` to the element. Fire-and-forget
	* friendly: shims call `void host.update(...)` from synchronous refresh
	* paths.
	*/
	async update(assign) {
		const element = await this.mount();
		if (element) assign(element);
	}
	/** Removes the mounted element from the container. */
	destroy() {
		this.#element?.remove();
		this.#element = void 0;
	}
	#loadKit() {
		const source = widgetKitSource;
		if (!source) return Promise.resolve(false);
		if (!this.#kitLoad || this.#kitLoadSource !== source) {
			this.#kitLoadSource = source;
			this.#kitLoad = (async () => {
				let kit;
				try {
					kit = typeof source === "function" ? await source() : source;
					kit.defineHonuaWebComponents?.();
				} catch {
					return false;
				}
				const expected = expectedKitConstructor(kit, this.#tagName);
				const registered = globalDom.customElements?.get(this.#tagName);
				return expected !== void 0 && registered === expected;
			})();
		}
		return this.#kitLoad;
	}
};
/** Resolves the web-components kit class that must own `tagName` for delegation. */
function expectedKitConstructor(kit, tagName) {
	switch (tagName) {
		case "honua-legend": return kit.HonuaLegendElement;
		case "honua-layer-list": return kit.HonuaLayerListElement;
		case "honua-search": return kit.HonuaSearchElement;
		case "honua-measurement": return kit.HonuaMeasurementElement;
		case "honua-time-slider": return kit.HonuaTimeSliderElement;
		default: return;
	}
}
function resolveContainer(container) {
	if (!globalDom.document) return void 0;
	if (typeof container === "string") return globalDom.document.getElementById(container) ?? void 0;
	if (typeof container === "object" && container !== null && typeof container.appendChild === "function") return container;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/layer-list.js
var LayerListCompat = class {
	view;
	map;
	container;
	eventBus;
	includeHidden;
	loaded;
	loadStatus;
	items;
	autoRefresh;
	listItemCreatedFunction;
	listenersByType;
	watchListeners;
	subscriptions;
	/**
	* When a `container` is supplied and a DOM is present, the shim delegates
	* its rendering to the app-platform `<honua-layer-list>` component through
	* {@link HonuaWidgetHost} (issue #493 REQ-004): rows come from the shim's
	* item model, and checkbox toggles route back through {@link toggle}.
	* Headless usage keeps the state-model-only behavior.
	*/
	widgetHost;
	/**
	* The element the toggle listener is currently bound to. Tracked per element
	* rather than as a "bound once" flag because the host legitimately mounts a
	* *new* element after a teardown — an unregister/re-register cycle, or a
	* container whose children were replaced — and a flag would leave that new
	* element without a listener, silently breaking visibility toggles.
	*/
	widgetHostBoundElement;
	constructor(options = {}) {
		this.view = options.view;
		this.map = options.map ?? extractMapFromView(options.view);
		this.container = options.container;
		this.eventBus = options.eventBus ?? resolveCompatEventBus(this.view, this.map) ?? new CompatEventBus();
		this.includeHidden = options.includeHidden ?? false;
		this.loaded = false;
		this.loadStatus = "not-loaded";
		this.autoRefresh = options.autoRefresh ?? true;
		this.listItemCreatedFunction = options.listItemCreatedFunction;
		this.items = [];
		this.listenersByType = /* @__PURE__ */ new Map();
		this.watchListeners = /* @__PURE__ */ new Map();
		this.subscriptions = [];
		const widgetHost = options.container != null ? new HonuaWidgetHost("honua-layer-list", options.container, this.eventBus) : void 0;
		this.widgetHost = widgetHost?.available ? widgetHost : void 0;
		if (this.autoRefresh) {
			this.subscriptions.push(this.eventBus.on("map.layer-added", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("map.layer-removed", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("map.layers-added", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("map.layers-cleared", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("map.layer-reordered", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("group-layer.layer-added", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("group-layer.layer-removed", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("group-layer.layers-added", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("group-layer.layers-cleared", () => this.refresh()));
			this.subscriptions.push(this.eventBus.on("layer.visibility-changed", () => this.refresh()));
		}
	}
	async load() {
		if (this.loaded) return this;
		this.loadStatus = "loading";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("layer-list.loading", void 0, this);
		this.refresh();
		this.loaded = true;
		this.notifyWatchers("loaded", this.loaded);
		this.loadStatus = "loaded";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("layer-list.loaded", { itemCount: this.items.length }, this);
		return this;
	}
	async when(callback) {
		const widget = await this.load();
		if (callback) callback(widget);
		return widget;
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	refresh() {
		const rootLayers = getRootLayers(this.map);
		this.items = rootLayers.map((layer, index) => toLayerListItem(layer, this.includeHidden, index)).filter((item) => item !== void 0);
		if (this.listItemCreatedFunction) for (const item of this.items) applyListItemCreated(item, this.listItemCreatedFunction);
		this.notifyWatchers("items", this.items);
		const updateEvent = { itemCount: this.items.length };
		this.eventBus.emit("layer-list.updated", updateEvent, this);
		this.emit("updated", updateEvent);
		this.renderWidgetHost();
		return this.items;
	}
	toggle(layerOrId, visible) {
		const layer = this.findLayer(layerOrId);
		if (!layer || !isLayerLike(layer)) return false;
		const nextVisible = visible ?? !toVisible(layer);
		if (hasSetVisibility(layer)) layer.setVisibility(nextVisible);
		else {
			layer.visible = nextVisible;
			this.eventBus.emit("layer.visibility-changed", {
				layerId: layer.id,
				visible: nextVisible
			}, this);
		}
		this.refresh();
		return true;
	}
	setItemActions(layerOrId, actionsSections) {
		const item = this.findItem(layerOrId);
		if (!item) return false;
		item.actionsSections = normalizeActionSections(actionsSections);
		this.notifyWatchers("items", this.items);
		const updateEvent = { itemCount: this.items.length };
		this.eventBus.emit("layer-list.updated", updateEvent, this);
		this.emit("updated", updateEvent);
		return true;
	}
	triggerAction(actionId, layerOrId) {
		const item = layerOrId === void 0 ? this.items[0] : this.findItem(layerOrId);
		if (!item) return false;
		const action = findActionById(item.actionsSections, actionId);
		if (!action) return false;
		const event = {
			action,
			actionId: action.id,
			item,
			layer: item.layer
		};
		this.eventBus.emit("layer-list.trigger-action", event, this);
		this.emit("trigger-action", event);
		return true;
	}
	on(type, listener) {
		let listeners = this.listenersByType.get(type);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.listenersByType.set(type, listeners);
		}
		const untypedListener = listener;
		listeners.add(untypedListener);
		return { remove: () => {
			listeners?.delete(untypedListener);
		} };
	}
	destroy() {
		for (const subscription of this.subscriptions.splice(0)) subscription.remove();
		this.listenersByType.clear();
		this.watchListeners.clear();
		this.widgetHost?.destroy();
	}
	/** Pushes the current items into the delegated `<honua-layer-list>` element. */
	async renderWidgetHost() {
		const host = this.widgetHost;
		if (!host) return;
		const rows = flattenLayerListItems(this.items);
		await host.update((element) => {
			if (this.widgetHostBoundElement !== element) {
				this.widgetHostBoundElement = element;
				element.addEventListener("honua-layer-visibility-change", (event) => {
					const detail = event.detail;
					if (detail?.layerId === void 0 || typeof detail.visible !== "boolean") return;
					this.toggle(detail.layerId, detail.visible);
				});
			}
			element.layers = rows;
		});
	}
	findLayer(layerOrId) {
		const rootLayers = getRootLayers(this.map);
		if (typeof layerOrId !== "string" && typeof layerOrId !== "number") return findLayerByReference(rootLayers, layerOrId);
		return findLayerById(rootLayers, layerOrId);
	}
	findItem(layerOrId) {
		if (typeof layerOrId !== "string" && typeof layerOrId !== "number") return findItemByLayer(this.items, layerOrId);
		return findItemById(this.items, layerOrId);
	}
	emit(type, event) {
		const listeners = this.listenersByType.get(type);
		if (!listeners) return;
		for (const listener of listeners) try {
			safeInvokeCompatListener(listener, event);
		} catch {}
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeCompatListener(listener, value);
	}
};
/**
* Flattens the compat item tree (depth-first) into the flat row model the
* `<honua-layer-list>` component renders; child rows are indented in their
* title. Layer ids are stringified so `toggle(detail.layerId, ...)` resolves
* them again via {@link findLayerById}.
*/
function flattenLayerListItems(items, depth = 0) {
	return items.flatMap((item, index) => [{
		id: item.id !== void 0 ? String(item.id) : `layer-${depth}-${index}`,
		title: `${" ".repeat(depth)}${item.title}`,
		visible: item.visible
	}, ...flattenLayerListItems(item.children, depth + 1)]);
}
function extractMapFromView(view) {
	if (!isRecord$2(view)) return;
	return view.map;
}
function getRootLayers(map) {
	if (!isRecord$2(map) || !Array.isArray(map.layers)) return [];
	return [...map.layers];
}
function toLayerListItem(layer, includeHidden, index) {
	if (!isLayerLike(layer)) return;
	if (!includeHidden && !toVisible(layer)) return;
	const children = getChildLayers(layer).map((child, childIndex) => toLayerListItem(child, includeHidden, childIndex)).filter((item) => item !== void 0);
	return {
		id: layer.id,
		title: toLayerTitle(layer, index),
		visible: toVisible(layer),
		layer,
		actionsSections: [],
		children
	};
}
function applyListItemCreated(item, callback) {
	callback({ item });
	for (const child of item.children) applyListItemCreated(child, callback);
}
function normalizeActionSections(actionsSections) {
	return actionsSections.map((section) => section.filter((action) => typeof action.id === "string" && action.id.trim().length > 0).map((action) => ({ ...action })));
}
function findActionById(actionsSections, actionId) {
	for (const section of actionsSections) for (const action of section) if (action.id === actionId) return action;
}
function findItemByLayer(items, layer) {
	for (const item of items) {
		if (item.layer === layer) return item;
		const nested = findItemByLayer(item.children, layer);
		if (nested) return nested;
	}
}
function findItemById(items, id) {
	const normalizedId = String(id);
	for (const item of items) {
		if (item.id !== void 0 && String(item.id) === normalizedId) return item;
		const nested = findItemById(item.children, id);
		if (nested) return nested;
	}
}
function findLayerByReference(layers, target) {
	for (const layer of layers) {
		if (layer === target) return layer;
		const nested = findLayerByReference(getChildLayers(layer), target);
		if (nested !== void 0) return nested;
	}
}
function findLayerById(layers, id) {
	const normalizedId = String(id);
	for (const layer of layers) {
		if (isLayerLike(layer) && layer.id !== void 0 && String(layer.id) === normalizedId) return layer;
		const nested = findLayerById(getChildLayers(layer), id);
		if (nested !== void 0) return nested;
	}
}
function isLayerLike(value) {
	return typeof value === "object" && value !== null;
}
function hasSetVisibility(value) {
	if (!isLayerLike(value)) return false;
	return typeof value.setVisibility === "function";
}
function getChildLayers(layer) {
	if (!isRecord$2(layer)) return [];
	if (Array.isArray(layer.layers)) return [...layer.layers];
	if (Array.isArray(layer.allSublayers)) return [...layer.allSublayers];
	if (Array.isArray(layer.sublayers)) return [...layer.sublayers];
	return [];
}
function toLayerTitle(layer, index) {
	if (typeof layer.title === "string" && layer.title.trim().length > 0) return layer.title;
	if (typeof layer.id === "string" && layer.id.trim().length > 0) return layer.id;
	if (typeof layer.id === "number" && Number.isFinite(layer.id)) return String(layer.id);
	return `Layer ${index + 1}`;
}
function toVisible(layer) {
	return layer.visible ?? true;
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null;
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/feature-filter.js
/**
* ArcGIS `FeatureFilter` shim.
*
* **Documented divergence — `objectIds` element type (#1013).** ArcGIS
* declares `objectIds: number[]`. This shim declares
* `Array<number | string>`: Honua's non-Esri sources (OGC API Features,
* GeoJSON, STAC) carry string feature ids, and narrowing the property to
* `number` would make the shim unable to hold ids it has to round-trip
* through `queryFeatures` / `queryObjectIds`. The array itself is mutable, as
* ArcGIS declares it — `filter.objectIds.push(id)` is honored, because the
* array the shim stores is the array it evaluates.
*
* Use {@link FeatureFilterCompat.toEsriProperties} to project the filter onto
* the exact ArcGIS shape; it fails loudly rather than silently dropping an id
* ArcGIS cannot represent. See `docs/migration-punch-list.md`.
*/
var FeatureFilterCompat = class FeatureFilterCompat {
	where;
	objectIds;
	geometry;
	spatialRelationship;
	distance;
	units;
	timeExtent;
	loaded;
	loadStatus;
	eventBus;
	watchListeners;
	constructor(options = {}) {
		this.where = options.where ?? null;
		this.objectIds = options.objectIds == null ? null : [...options.objectIds];
		this.geometry = options.geometry ?? null;
		this.spatialRelationship = options.spatialRelationship ?? "intersects";
		this.distance = options.distance;
		this.units = options.units;
		this.timeExtent = options.timeExtent ?? null;
		this.loaded = true;
		this.loadStatus = "loaded";
		this.eventBus = options.eventBus ?? new CompatEventBus();
		this.watchListeners = /* @__PURE__ */ new Map();
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	clone() {
		return new FeatureFilterCompat({
			where: this.where ?? void 0,
			objectIds: this.objectIds ?? void 0,
			geometry: this.geometry ?? void 0,
			spatialRelationship: this.spatialRelationship,
			distance: this.distance,
			units: this.units,
			timeExtent: this.timeExtent ?? void 0,
			eventBus: this.eventBus
		});
	}
	update(patch) {
		if (patch.where !== void 0) {
			this.where = patch.where ?? null;
			this.notifyWatchers("where", this.where);
		}
		if (patch.objectIds !== void 0) {
			this.objectIds = patch.objectIds == null ? null : [...patch.objectIds];
			this.notifyWatchers("objectIds", this.objectIds);
		}
		if (patch.geometry !== void 0) {
			this.geometry = patch.geometry ?? null;
			this.notifyWatchers("geometry", this.geometry);
		}
		if (patch.spatialRelationship !== void 0) {
			this.spatialRelationship = patch.spatialRelationship;
			this.notifyWatchers("spatialRelationship", this.spatialRelationship);
		}
		if (patch.distance !== void 0) {
			this.distance = patch.distance;
			this.notifyWatchers("distance", this.distance);
		}
		if (patch.units !== void 0) {
			this.units = patch.units;
			this.notifyWatchers("units", this.units);
		}
		if (patch.timeExtent !== void 0) {
			this.timeExtent = patch.timeExtent ?? null;
			this.notifyWatchers("timeExtent", this.timeExtent);
		}
		this.eventBus.emit("feature-filter.updated", { filter: this.toJSON() }, this);
		return this;
	}
	/**
	* Project this filter onto the ArcGIS `FeatureFilterProperties` shape so a
	* partially migrated app can hand it to an un-migrated `@arcgis/core`
	* construct (#1013 REQ-003).
	*
	* Throws when `objectIds` holds an id ArcGIS cannot represent: ArcGIS object
	* ids are numbers, and quietly dropping or coercing a string id would hand
	* back a filter that selects a different set of features than this one.
	*/
	toEsriProperties() {
		const properties = { spatialRelationship: this.spatialRelationship };
		if (this.where != null) properties.where = this.where;
		if (this.objectIds != null) {
			const unrepresentable = this.objectIds.filter((objectId) => typeof objectId !== "number" || !Number.isFinite(objectId));
			if (unrepresentable.length > 0) {
				const rendered = unrepresentable.map((objectId) => JSON.stringify(objectId)).join(", ");
				throw new Error(`FeatureFilterCompat.toEsriProperties cannot represent non-numeric object ids as ArcGIS number[]: ${rendered}.`);
			}
			properties.objectIds = this.objectIds;
		}
		if (this.geometry != null) properties.geometry = this.geometry;
		if (this.distance !== void 0) properties.distance = this.distance;
		if (this.units !== void 0) properties.units = this.units;
		if (this.timeExtent != null) properties.timeExtent = this.timeExtent;
		return properties;
	}
	toJSON() {
		const json = {};
		if (this.where != null) json.where = this.where;
		if (this.objectIds != null) json.objectIds = [...this.objectIds];
		if (this.geometry != null) json.geometry = this.geometry;
		json.spatialRelationship = this.spatialRelationship;
		if (this.distance !== void 0) json.distance = this.distance;
		if (this.units !== void 0) json.units = this.units;
		if (this.timeExtent != null) json.timeExtent = this.timeExtent;
		return json;
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeCompatListener(listener, value);
	}
};
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/map-view.js
var MapViewPopupCompat = class {
	visible;
	location;
	features;
	selectedFeature;
	selectedFeatureIndex;
	title;
	content;
	autoOpenEnabled;
	dockEnabled;
	dockOptions;
	viewModel;
	onChange;
	constructor(onChange, options = {}) {
		this.visible = false;
		this.location = void 0;
		this.features = [];
		this.selectedFeature = void 0;
		this.selectedFeatureIndex = -1;
		this.title = void 0;
		this.content = void 0;
		this.autoOpenEnabled = options.autoOpenEnabled ?? true;
		this.dockEnabled = options.dockEnabled ?? false;
		this.dockOptions = options.dockOptions;
		this.viewModel = { active: false };
		this.onChange = onChange;
	}
	open(options = {}) {
		this.visible = true;
		this.viewModel.active = true;
		this.location = options.location;
		this.features = options.features ? [...options.features] : [];
		this.selectedFeature = this.features[0];
		this.selectedFeatureIndex = this.features.length > 0 ? 0 : -1;
		this.title = options.title;
		this.content = options.content;
		this.onChange("open", options);
	}
	close() {
		if (!this.visible) return;
		this.visible = false;
		this.viewModel.active = false;
		this.location = void 0;
		this.features = [];
		this.selectedFeature = void 0;
		this.selectedFeatureIndex = -1;
		this.title = void 0;
		this.content = void 0;
		this.onChange("close");
	}
	selectFeature(featureOrIndex) {
		if (this.features.length === 0) return;
		const index = typeof featureOrIndex === "number" ? normalizeFeatureIndex$1(featureOrIndex, this.features.length) : this.features.findIndex((feature) => feature === featureOrIndex);
		if (index < 0) return;
		this.selectedFeatureIndex = index;
		this.selectedFeature = this.features[index];
		this.onChange("selection");
		return this.selectedFeature;
	}
	next() {
		if (this.features.length === 0) return;
		const current = this.selectedFeatureIndex >= 0 ? this.selectedFeatureIndex : 0;
		const next = Math.min(current + 1, this.features.length - 1);
		return this.selectFeature(next);
	}
	previous() {
		if (this.features.length === 0) return;
		const current = this.selectedFeatureIndex >= 0 ? this.selectedFeatureIndex : 0;
		const previous = Math.max(current - 1, 0);
		return this.selectFeature(previous);
	}
};
var MapViewLayerViewCompat = class {
	layer;
	updating;
	suspended;
	hasAllFeatures;
	hasAllFeaturesInView;
	visible;
	filter;
	effect;
	watchListeners;
	eventBus;
	highlightsInternal;
	nextHighlightId;
	constructor(layer, eventBus) {
		this.layer = layer;
		this.updating = false;
		this.suspended = false;
		this.hasAllFeatures = true;
		this.hasAllFeaturesInView = true;
		this.visible = true;
		this.filter = null;
		this.effect = void 0;
		this.watchListeners = /* @__PURE__ */ new Map();
		this.eventBus = eventBus;
		this.highlightsInternal = /* @__PURE__ */ new Map();
		this.nextHighlightId = 1;
	}
	setFilter(input) {
		if (input === null || input === void 0) this.filter = null;
		else if (input instanceof FeatureFilterCompat) this.filter = input;
		else this.filter = new FeatureFilterCompat({
			...input,
			eventBus: this.eventBus
		});
		this.notifyWatchers("filter", this.filter);
		this.eventBus?.emit("view.layer-view-filter-changed", {
			layer: this.layer,
			filter: this.filter?.toJSON() ?? null
		}, this);
	}
	setEffect(effect) {
		this.effect = effect;
		this.notifyWatchers("effect", effect);
		this.eventBus?.emit("view.layer-view-effect-changed", {
			layer: this.layer,
			effect
		}, this);
	}
	setVisibility(visible) {
		if (this.visible === visible) return;
		this.visible = visible;
		this.notifyWatchers("visible", visible);
		this.eventBus?.emit("view.layer-view-visibility-changed", {
			layer: this.layer,
			visible
		}, this);
	}
	get highlights() {
		return Array.from(this.highlightsInternal.values()).map((record) => ({
			targets: [...record.targets],
			options: { ...record.options }
		}));
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	setUpdating(value) {
		this.updating = value;
		this.notifyWatchers("updating", value);
		this.eventBus?.emit("view.layer-view-updating-changed", {
			layer: this.layer,
			updating: value
		}, this);
	}
	setSuspended(value) {
		this.suspended = value;
		this.notifyWatchers("suspended", value);
		this.eventBus?.emit("view.layer-view-suspended-changed", {
			layer: this.layer,
			suspended: value
		}, this);
	}
	setHasAllFeatures(value) {
		this.hasAllFeatures = value;
		this.notifyWatchers("hasAllFeatures", value);
		this.eventBus?.emit("view.layer-view-has-all-features-changed", {
			layer: this.layer,
			hasAllFeatures: value
		}, this);
	}
	setHasAllFeaturesInView(value) {
		this.hasAllFeaturesInView = value;
		this.notifyWatchers("hasAllFeaturesInView", value);
		this.eventBus?.emit("view.layer-view-has-all-features-in-view-changed", {
			layer: this.layer,
			hasAllFeaturesInView: value
		}, this);
	}
	async queryFeatures(options = {}) {
		const merged = this.mergeFilter(options);
		if (isQueryFeaturesProvider(this.layer)) return this.layer.queryFeatures(merged);
		return { features: [] };
	}
	mergeFilter(options) {
		const filter = this.filter;
		if (!filter) return options;
		const merged = { ...options };
		const filterWhere = filter.where;
		if (typeof filterWhere === "string" && filterWhere.length > 0) {
			const optionWhere = typeof merged.where === "string" && merged.where.length > 0 ? merged.where : void 0;
			merged.where = optionWhere ? `(${optionWhere}) AND (${filterWhere})` : filterWhere;
		}
		if (filter.objectIds) {
			if (merged.objectIds === void 0) merged.objectIds = [...filter.objectIds];
			else if (Array.isArray(merged.objectIds)) {
				const filterIds = new Set(filter.objectIds);
				merged.objectIds = merged.objectIds.filter((id) => filterIds.has(id));
			}
		}
		if (merged.geometry === void 0 && filter.geometry) merged.geometry = filter.geometry;
		if (merged.spatialRelationship === void 0) merged.spatialRelationship = filter.spatialRelationship;
		if (merged.timeExtent === void 0 && filter.timeExtent != null) merged.timeExtent = filter.timeExtent;
		return merged;
	}
	async queryFeatureCount(options = {}) {
		const merged = this.mergeFilter(options);
		if (isQueryFeatureCountProvider(this.layer)) return normalizeCount(await this.layer.queryFeatureCount(merged));
		const result = await this.queryFeatures(merged);
		if (isFeatureCollection(result)) return result.features.length;
		return 0;
	}
	async queryObjectIds(options = {}) {
		const merged = this.mergeFilter(options);
		if (isQueryObjectIdsProvider(this.layer)) {
			const ids = await this.layer.queryObjectIds(merged);
			return Array.isArray(ids) ? ids.filter((value) => typeof value === "number" && Number.isFinite(value)) : [];
		}
		const result = await this.queryFeatures(merged);
		if (!isFeatureCollection(result)) return [];
		const ids = [];
		for (const feature of result.features) {
			const objectId = extractObjectId(feature);
			if (typeof objectId === "number" && Number.isFinite(objectId)) ids.push(objectId);
		}
		return ids;
	}
	highlight(target, options = {}) {
		const id = this.nextHighlightId;
		this.nextHighlightId += 1;
		const record = {
			targets: normalizeHighlightTargets(target),
			options: { ...options }
		};
		this.highlightsInternal.set(id, record);
		this.notifyWatchers("highlights", this.highlights);
		this.eventBus?.emit("view.layer-view-highlight-added", {
			layer: this.layer,
			targets: [...record.targets],
			options: { ...record.options },
			count: this.highlightsInternal.size
		}, this);
		return { remove: () => {
			this.removeHighlight(id);
		} };
	}
	destroy() {
		if (this.highlightsInternal.size > 0) {
			this.highlightsInternal.clear();
			this.notifyWatchers("highlights", this.highlights);
			this.eventBus?.emit("view.layer-view-highlights-cleared", {
				layer: this.layer,
				count: 0
			}, this);
		}
		this.watchListeners.clear();
	}
	removeHighlight(id) {
		const record = this.highlightsInternal.get(id);
		if (!record) return false;
		this.highlightsInternal.delete(id);
		this.notifyWatchers("highlights", this.highlights);
		this.eventBus?.emit("view.layer-view-highlight-removed", {
			layer: this.layer,
			targets: [...record.targets],
			options: { ...record.options },
			count: this.highlightsInternal.size
		}, this);
		return true;
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeListener(() => listener(value));
	}
};
var MapViewUiCompat = class {
	eventBus;
	onChanged;
	componentsInternal;
	constructor(eventBus, onChanged) {
		this.eventBus = eventBus;
		this.onChanged = onChanged;
		this.componentsInternal = [];
	}
	get components() {
		return this.componentsInternal.map((record) => ({ ...record }));
	}
	add(componentOrComponents, positionOrOptions = "manual") {
		if (Array.isArray(componentOrComponents)) {
			for (const component of componentOrComponents) this.add(component, positionOrOptions);
			return;
		}
		const component = componentOrComponents;
		const options = normalizeUiOptions(positionOrOptions);
		const existingIndex = this.findComponentIndex(component);
		if (existingIndex >= 0) this.componentsInternal.splice(existingIndex, 1);
		const insertIndex = normalizeUiIndex(options.index, this.componentsInternal.length);
		const record = {
			component,
			position: options.position,
			index: insertIndex
		};
		this.componentsInternal.splice(insertIndex, 0, record);
		this.reindexComponents();
		this.eventBus.emit("view.ui.component-added", {
			component,
			position: record.position,
			index: record.index
		}, this);
		this.notifyChanged();
	}
	remove(componentOrId) {
		const index = this.findComponentIndex(componentOrId);
		if (index < 0) return false;
		const [removed] = this.componentsInternal.splice(index, 1);
		this.reindexComponents();
		this.eventBus.emit("view.ui.component-removed", {
			component: removed?.component,
			position: removed?.position
		}, this);
		this.notifyChanged();
		return true;
	}
	removeAll() {
		if (this.componentsInternal.length === 0) return;
		const removedComponents = this.componentsInternal.map((record) => record.component);
		this.componentsInternal.length = 0;
		this.eventBus.emit("view.ui.components-cleared", { count: removedComponents.length }, this);
		this.notifyChanged();
	}
	empty(position) {
		const previous = this.componentsInternal.length;
		const remaining = this.componentsInternal.filter((record) => record.position !== position);
		if (remaining.length === previous) return;
		this.componentsInternal.length = 0;
		this.componentsInternal.push(...remaining);
		this.reindexComponents();
		this.eventBus.emit("view.ui.position-cleared", {
			position,
			remainingCount: this.componentsInternal.length
		}, this);
		this.notifyChanged();
	}
	move(componentOrId, positionOrOptions) {
		const index = this.findComponentIndex(componentOrId);
		if (index < 0) return false;
		const [record] = this.componentsInternal.splice(index, 1);
		const options = normalizeUiOptions(positionOrOptions);
		const insertIndex = normalizeUiIndex(options.index, this.componentsInternal.length);
		const movedRecord = {
			component: record.component,
			position: options.position,
			index: insertIndex
		};
		this.componentsInternal.splice(insertIndex, 0, movedRecord);
		this.reindexComponents();
		this.eventBus.emit("view.ui.component-moved", {
			component: movedRecord.component,
			position: movedRecord.position,
			index: movedRecord.index
		}, this);
		this.notifyChanged();
		return true;
	}
	find(componentOrId) {
		const index = this.findComponentIndex(componentOrId);
		return index < 0 ? void 0 : this.componentsInternal[index]?.component;
	}
	getComponents(position) {
		if (position === void 0) return this.componentsInternal.map((record) => record.component);
		return this.componentsInternal.filter((record) => record.position === position).map((record) => record.component);
	}
	findComponentIndex(componentOrId) {
		if (typeof componentOrId === "string") {
			for (let i = 0; i < this.componentsInternal.length; i += 1) {
				const component = this.componentsInternal[i]?.component;
				if (isRecord$1(component) && component.id === componentOrId) return i;
			}
			return -1;
		}
		return this.componentsInternal.findIndex((record) => record.component === componentOrId);
	}
	reindexComponents() {
		for (let i = 0; i < this.componentsInternal.length; i += 1) {
			const existing = this.componentsInternal[i];
			if (!existing) continue;
			existing.index = i;
		}
	}
	notifyChanged() {
		this.onChanged?.(this.components);
	}
};
var MapViewCompat = class {
	map;
	container;
	loaded;
	loadStatus;
	center;
	zoom;
	scale;
	rotation;
	extent;
	constraints;
	padding;
	highlightOptions;
	spatialReference;
	eventBus;
	popup;
	ui;
	eventListeners;
	watchListeners;
	layerViews;
	readyPromise;
	constructor(options = {}) {
		this.map = options.map;
		this.container = options.container;
		this.loaded = false;
		this.loadStatus = "not-loaded";
		this.center = options.center;
		this.zoom = options.zoom;
		this.scale = options.scale;
		this.rotation = options.rotation;
		this.extent = options.extent;
		this.constraints = options.constraints;
		this.padding = options.padding;
		this.highlightOptions = options.highlightOptions;
		this.spatialReference = options.spatialReference;
		this.eventBus = options.eventBus ?? resolveCompatEventBus(options.map, options.container) ?? new CompatEventBus();
		this.popup = new MapViewPopupCompat((type, popupOptions) => {
			this.notifyWatchers("popup.visible", this.popup.visible);
			this.notifyWatchers("popup.features", this.popup.features);
			this.notifyWatchers("popup.selectedFeature", this.popup.selectedFeature);
			this.notifyWatchers("popup.selectedFeatureIndex", this.popup.selectedFeatureIndex);
			this.notifyWatchers("popup.location", this.popup.location);
			this.notifyWatchers("popup.title", this.popup.title);
			this.notifyWatchers("popup.content", this.popup.content);
			this.notifyWatchers("popup.viewModel.active", this.popup.viewModel.active);
			if (type === "open") {
				this.eventBus.emit("popup.open", popupOptions, this);
				this.emit("popup-open", popupOptions);
			} else if (type === "close") {
				this.eventBus.emit("popup.close", popupOptions, this);
				this.emit("popup-close", popupOptions);
			} else {
				const selection = {
					selectedFeature: this.popup.selectedFeature,
					selectedFeatureIndex: this.popup.selectedFeatureIndex
				};
				this.eventBus.emit("popup.selected-feature-changed", selection, this);
				this.emit("popup-selection-change", selection);
			}
		}, extractPopupOptions(options.popup));
		this.ui = new MapViewUiCompat(this.eventBus, (components) => {
			this.notifyWatchers("ui.components", components);
		});
		this.eventListeners = /* @__PURE__ */ new Map();
		this.watchListeners = /* @__PURE__ */ new Map();
		this.layerViews = /* @__PURE__ */ new Map();
		this.readyPromise = Promise.resolve(this);
	}
	async load() {
		if (this.loaded) return this;
		this.loadStatus = "loading";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("view.loading", void 0, this);
		await this.readyPromise;
		this.loaded = true;
		this.notifyWatchers("loaded", this.loaded);
		this.loadStatus = "loaded";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("view.loaded", void 0, this);
		return this;
	}
	async when(callback) {
		const view = await this.load();
		if (callback) callback(view);
		return view;
	}
	toMap(screenPoint) {
		const mapPoint = {
			x: screenPoint.x,
			y: screenPoint.y
		};
		if (this.spatialReference !== void 0) mapPoint.spatialReference = this.spatialReference;
		return mapPoint;
	}
	toScreen(mapPoint) {
		return {
			x: mapPoint.x,
			y: mapPoint.y
		};
	}
	async hitTest(event = {}) {
		const mapPoint = event.mapPoint ?? (typeof event.x === "number" && typeof event.y === "number" ? this.toMap({
			x: event.x,
			y: event.y
		}) : void 0);
		return { results: this.popup.features.map((feature) => ({
			type: "graphic",
			graphic: feature,
			layer: extractGraphicLayer(feature),
			mapPoint
		})) };
	}
	async goTo(target, options = {}) {
		const normalizedTarget = normalizeGoToTarget(target);
		if (normalizedTarget.center !== void 0) this.setCenter(normalizedTarget.center);
		if (normalizedTarget.zoom !== void 0) this.setZoom(normalizedTarget.zoom);
		if (normalizedTarget.scale !== void 0) this.setScale(normalizedTarget.scale);
		if (normalizedTarget.rotation !== void 0) this.setRotation(normalizedTarget.rotation);
		if (normalizedTarget.extent !== void 0) this.setExtent(normalizedTarget.extent);
		const payload = hasGoToOptions(options) ? {
			target,
			options
		} : target;
		this.eventBus.emit("view.go-to", payload, this);
		this.emit("go-to", payload);
		return this;
	}
	async takeScreenshot(options = {}) {
		const width = normalizeScreenshotDimension(options.width, 1024);
		const height = normalizeScreenshotDimension(options.height, 768);
		const format = normalizeScreenshotFormat(options.format);
		const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
		const result = {
			data: new Uint8ClampedArray(width * height * 4),
			dataUrl: `data:${mimeType};base64,`,
			width,
			height
		};
		const payload = {
			width,
			height,
			format,
			quality: options.quality,
			area: options.area,
			ignoreBackground: options.ignoreBackground
		};
		this.eventBus.emit("view.screenshot", payload, this);
		this.emit("take-screenshot", payload);
		return result;
	}
	openPopup(options = {}) {
		this.popup.open(options);
	}
	closePopup() {
		this.popup.close();
	}
	setCenter(center) {
		this.center = center;
		this.notifyWatchers("center", this.center);
		this.eventBus.emit("view.center-changed", { center }, this);
	}
	setZoom(zoom) {
		this.zoom = zoom;
		this.notifyWatchers("zoom", this.zoom);
		this.eventBus.emit("view.zoom-changed", { zoom }, this);
	}
	setScale(scale) {
		this.scale = scale;
		this.notifyWatchers("scale", this.scale);
		this.eventBus.emit("view.scale-changed", { scale }, this);
	}
	setRotation(rotation) {
		this.rotation = rotation;
		this.notifyWatchers("rotation", this.rotation);
		this.eventBus.emit("view.rotation-changed", { rotation }, this);
	}
	setExtent(extent) {
		this.extent = extent;
		this.notifyWatchers("extent", this.extent);
		this.eventBus.emit("view.extent-changed", { extent }, this);
	}
	setPadding(padding) {
		this.padding = padding;
		this.notifyWatchers("padding", this.padding);
		this.eventBus.emit("view.padding-changed", { padding }, this);
	}
	setConstraints(constraints) {
		this.constraints = constraints;
		this.notifyWatchers("constraints", this.constraints);
		this.eventBus.emit("view.constraints-changed", { constraints }, this);
	}
	setHighlightOptions(highlightOptions) {
		this.highlightOptions = highlightOptions;
		this.notifyWatchers("highlightOptions", this.highlightOptions);
		this.eventBus.emit("view.highlight-options-changed", { highlightOptions }, this);
	}
	setSpatialReference(spatialReference) {
		this.spatialReference = spatialReference;
		this.notifyWatchers("spatialReference", this.spatialReference);
		this.eventBus.emit("view.spatial-reference-changed", { spatialReference }, this);
	}
	/** Returns all currently created layer views as a read-only collection. */
	get allLayerViews() {
		return Array.from(this.layerViews.values());
	}
	/**
	* Returns an existing layer view for the given layer, or undefined if
	* whenLayerView has not yet been called for it.
	*/
	getLayerView(layer) {
		return this.layerViews.get(layer);
	}
	async whenLayerView(layer) {
		const existing = this.layerViews.get(layer);
		if (existing) return existing;
		const layerView = new MapViewLayerViewCompat(layer, this.eventBus);
		this.layerViews.set(layer, layerView);
		this.notifyWatchers("allLayerViews", this.allLayerViews);
		this.eventBus.emit("view.layer-view-created", {
			layer,
			layerView
		}, this);
		this.eventBus.emit("feature-layer.layerview-create", {
			view: this,
			layerView
		}, this);
		this.emit("layerview-create", {
			layer,
			layerView
		});
		return layerView;
	}
	on(eventName, listener) {
		let listeners = this.eventListeners.get(eventName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.eventListeners.set(eventName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	destroy() {
		this.eventBus.emit("view.destroy", void 0, this);
		this.emit("destroy", void 0);
		this.ui.removeAll();
		for (const layerView of this.layerViews.values()) layerView.destroy();
		this.layerViews.clear();
		this.notifyWatchers("allLayerViews", this.allLayerViews);
		this.closePopup();
		this.map = void 0;
		this.notifyWatchers("map", this.map);
		this.container = void 0;
		this.notifyWatchers("container", this.container);
		this.center = void 0;
		this.notifyWatchers("center", this.center);
		this.zoom = void 0;
		this.notifyWatchers("zoom", this.zoom);
		this.scale = void 0;
		this.notifyWatchers("scale", this.scale);
		this.rotation = void 0;
		this.notifyWatchers("rotation", this.rotation);
		this.extent = void 0;
		this.notifyWatchers("extent", this.extent);
		this.constraints = void 0;
		this.notifyWatchers("constraints", this.constraints);
		this.padding = void 0;
		this.notifyWatchers("padding", this.padding);
		this.highlightOptions = void 0;
		this.notifyWatchers("highlightOptions", this.highlightOptions);
		this.spatialReference = void 0;
		this.notifyWatchers("spatialReference", this.spatialReference);
		this.loaded = false;
		this.notifyWatchers("loaded", this.loaded);
		this.loadStatus = "not-loaded";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventListeners.clear();
		this.watchListeners.clear();
	}
	emit(eventName, payload) {
		const listeners = this.eventListeners.get(eventName);
		if (!listeners || listeners.size === 0) return false;
		for (const listener of listeners) safeInvokeListener(() => listener(payload));
		return true;
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeListener(() => listener(value));
	}
};
var GEOMETRY_SEQUENCE_KEYS = [
	"points",
	"path",
	"paths",
	"ring",
	"rings"
];
function normalizeGoToTarget(target) {
	const normalized = {};
	const targetRecord = asRecord(target);
	if (targetRecord !== void 0) {
		if ("target" in targetRecord && targetRecord.target !== void 0) mergeGoToTarget(normalized, normalizeGoToTarget(targetRecord.target));
		if (targetRecord.center !== void 0) normalized.center = targetRecord.center;
		const zoom = normalizeFiniteNumber(targetRecord.zoom);
		if (zoom !== void 0) normalized.zoom = zoom;
		const scale = normalizeFiniteNumber(targetRecord.scale);
		if (scale !== void 0) normalized.scale = scale;
		const rotation = normalizeFiniteNumber(targetRecord.rotation);
		if (rotation !== void 0) normalized.rotation = rotation;
		if (targetRecord.extent !== void 0) normalized.extent = targetRecord.extent;
	}
	if (normalized.center === void 0) {
		const derivedCenter = extractGoToCenter(target);
		if (derivedCenter !== void 0) normalized.center = derivedCenter;
	}
	if (normalized.extent === void 0) {
		const derivedExtent = extractGoToExtent(target);
		if (derivedExtent !== void 0) normalized.extent = derivedExtent;
	}
	if (normalized.center === void 0 && normalized.extent !== void 0) {
		const centerFromExtent = extractExtentCenter(normalized.extent);
		if (centerFromExtent !== void 0) normalized.center = centerFromExtent;
	}
	return normalized;
}
function mergeGoToTarget(target, source) {
	if (source.center !== void 0) target.center = source.center;
	if (source.zoom !== void 0) target.zoom = source.zoom;
	if (source.scale !== void 0) target.scale = source.scale;
	if (source.rotation !== void 0) target.rotation = source.rotation;
	if (source.extent !== void 0) target.extent = source.extent;
}
function hasGoToOptions(options) {
	return options.animate !== void 0 || options.duration !== void 0 || options.speedFactor !== void 0 || options.easing !== void 0;
}
function extractGoToCenter(value, visited = /* @__PURE__ */ new Set()) {
	if (isCoordinatePair(value)) return [value[0], value[1]];
	if (Array.isArray(value)) return;
	if (!isRecord$1(value)) return;
	if (visited.has(value)) return;
	visited.add(value);
	if ("target" in value && value.target !== void 0) {
		const nestedCenter = extractGoToCenter(value.target, visited);
		if (nestedCenter !== void 0) return nestedCenter;
	}
	if ("geometry" in value && value.geometry !== void 0) {
		const nestedCenter = extractGoToCenter(value.geometry, visited);
		if (nestedCenter !== void 0) return nestedCenter;
	}
	return extractPointCenterFromRecord(value);
}
function extractGoToExtent(value) {
	if (!shouldDeriveExtentFromTarget(value)) return;
	const bounds = collectBounds(value);
	return bounds ? toExtentLike(bounds) : void 0;
}
function shouldDeriveExtentFromTarget(value, visited = /* @__PURE__ */ new Set()) {
	if (isExtentLike(value)) return true;
	if (isCoordinatePair(value)) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (!isRecord$1(value)) return false;
	if (visited.has(value)) return false;
	visited.add(value);
	if ("target" in value && value.target !== void 0 && shouldDeriveExtentFromTarget(value.target, visited)) return true;
	if ("geometry" in value && value.geometry !== void 0 && shouldDeriveExtentFromTarget(value.geometry, visited)) return true;
	return hasCoordinateSequences(value);
}
function collectBounds(value, visited = /* @__PURE__ */ new Set()) {
	if (isExtentLike(value)) return {
		xmin: value.xmin,
		ymin: value.ymin,
		xmax: value.xmax,
		ymax: value.ymax,
		spatialReference: value.spatialReference
	};
	if (isCoordinatePair(value)) return createBoundsFromPoint(value[0], value[1]);
	if (Array.isArray(value)) {
		let bounds;
		for (const item of value) bounds = mergeBounds(bounds, collectBounds(item, visited));
		return bounds;
	}
	if (!isRecord$1(value)) return;
	if (visited.has(value)) return;
	visited.add(value);
	let bounds;
	if ("target" in value && value.target !== void 0) bounds = mergeBounds(bounds, collectBounds(value.target, visited));
	if ("geometry" in value && value.geometry !== void 0) bounds = mergeBounds(bounds, collectBounds(value.geometry, visited));
	const point = extractPointFromRecord(value);
	if (point !== void 0) bounds = mergeBounds(bounds, createBoundsFromPoint(point.x, point.y, point.spatialReference));
	for (const key of GEOMETRY_SEQUENCE_KEYS) if (key in value) bounds = mergeBounds(bounds, collectBounds(value[key], visited));
	return bounds;
}
function hasCoordinateSequences(value) {
	return GEOMETRY_SEQUENCE_KEYS.some((key) => key in value && Array.isArray(value[key]));
}
function extractPointCenterFromRecord(value) {
	const point = extractPointFromRecord(value);
	if (point === void 0) return;
	return {
		x: point.x,
		y: point.y,
		spatialReference: point.spatialReference
	};
}
function extractPointFromRecord(value) {
	const x = normalizeFiniteNumber(value.x);
	const y = normalizeFiniteNumber(value.y);
	if (x !== void 0 && y !== void 0) return {
		x,
		y,
		spatialReference: asSpatialReferenceLike(value.spatialReference)
	};
	const longitude = normalizeFiniteNumber(value.longitude);
	const latitude = normalizeFiniteNumber(value.latitude);
	if (longitude !== void 0 && latitude !== void 0) return {
		x: longitude,
		y: latitude,
		spatialReference: asSpatialReferenceLike(value.spatialReference)
	};
}
function asSpatialReferenceLike(value) {
	return isRecord$1(value) ? value : void 0;
}
function normalizeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeScreenshotDimension(value, fallback) {
	if (value === void 0 || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value));
}
function normalizeScreenshotFormat(format) {
	if (format === "jpg" || format === "jpeg") return "jpg";
	return "png";
}
function createBoundsFromPoint(x, y, spatialReference) {
	return {
		xmin: x,
		ymin: y,
		xmax: x,
		ymax: y,
		spatialReference
	};
}
function mergeBounds(current, next) {
	if (next === void 0) return current;
	if (current === void 0) return next;
	return {
		xmin: Math.min(current.xmin, next.xmin),
		ymin: Math.min(current.ymin, next.ymin),
		xmax: Math.max(current.xmax, next.xmax),
		ymax: Math.max(current.ymax, next.ymax),
		spatialReference: current.spatialReference ?? next.spatialReference
	};
}
function toExtentLike(bounds) {
	return {
		xmin: bounds.xmin,
		ymin: bounds.ymin,
		xmax: bounds.xmax,
		ymax: bounds.ymax,
		spatialReference: bounds.spatialReference
	};
}
function extractExtentCenter(extent) {
	if (!isExtentLike(extent)) return;
	return {
		x: (extent.xmin + extent.xmax) / 2,
		y: (extent.ymin + extent.ymax) / 2,
		spatialReference: extent.spatialReference
	};
}
function isCoordinatePair(value) {
	return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && Number.isFinite(value[0]) && typeof value[1] === "number" && Number.isFinite(value[1]);
}
function isExtentLike(value) {
	return isRecord$1(value) && typeof value.xmin === "number" && Number.isFinite(value.xmin) && typeof value.ymin === "number" && Number.isFinite(value.ymin) && typeof value.xmax === "number" && Number.isFinite(value.xmax) && typeof value.ymax === "number" && Number.isFinite(value.ymax);
}
function normalizeUiOptions(input) {
	if (typeof input === "string") return {
		position: input,
		index: NaN
	};
	return {
		position: typeof input.position === "string" && input.position.length > 0 ? input.position : "manual",
		index: typeof input.index === "number" && Number.isFinite(input.index) ? Math.trunc(input.index) : NaN
	};
}
function normalizeUiIndex(index, length) {
	if (!Number.isFinite(index)) return length;
	return Math.min(Math.max(index, 0), length);
}
function normalizeFeatureIndex$1(index, length) {
	if (!Number.isFinite(index)) return -1;
	const normalized = Math.trunc(index);
	if (normalized < 0 || normalized >= length) return -1;
	return normalized;
}
function normalizeHighlightTargets(target) {
	if (Array.isArray(target)) return [...target];
	return [target];
}
function isQueryFeaturesProvider(value) {
	return typeof value === "object" && value !== null && "queryFeatures" in value && typeof value.queryFeatures === "function";
}
function isQueryFeatureCountProvider(value) {
	return typeof value === "object" && value !== null && "queryFeatureCount" in value && typeof value.queryFeatureCount === "function";
}
function isQueryObjectIdsProvider(value) {
	return typeof value === "object" && value !== null && "queryObjectIds" in value && typeof value.queryObjectIds === "function";
}
function isFeatureCollection(value) {
	return typeof value === "object" && value !== null && "features" in value && Array.isArray(value.features);
}
function extractObjectId(feature) {
	if (typeof feature !== "object" || feature === null) return;
	if ("objectId" in feature && typeof feature.objectId === "number") return feature.objectId;
	if ("attributes" in feature && typeof feature.attributes === "object" && feature.attributes !== null) {
		if ("OBJECTID" in feature.attributes && typeof feature.attributes.OBJECTID === "number" && Number.isFinite(feature.attributes.OBJECTID)) return feature.attributes.OBJECTID;
		if ("objectid" in feature.attributes && typeof feature.attributes.objectid === "number" && Number.isFinite(feature.attributes.objectid)) return feature.attributes.objectid;
		if ("objectId" in feature.attributes && typeof feature.attributes.objectId === "number" && Number.isFinite(feature.attributes.objectId)) return feature.attributes.objectId;
	}
}
function normalizeCount(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function extractGraphicLayer(value) {
	if (!("layer" in value) || value.layer === void 0 || value.layer === null) return;
	if (typeof value.layer === "object") return value.layer;
}
function safeInvokeListener(invoke) {
	try {
		invoke();
	} catch {}
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null;
}
function asRecord(value) {
	if (!isRecord$1(value) || Array.isArray(value)) return;
	return value;
}
function extractPopupOptions(popup) {
	if (!isRecord$1(popup)) return {};
	return {
		autoOpenEnabled: typeof popup.autoOpenEnabled === "boolean" ? popup.autoOpenEnabled : void 0,
		dockEnabled: typeof popup.dockEnabled === "boolean" ? popup.dockEnabled : void 0,
		dockOptions: popup.dockOptions
	};
}
//#endregion
//#region .tmp/sample-runner/c250320d-9a9e-46f7-b0e2-47022d17892d/packed-sdk/extract/package/dist/src/esri-compat/popup.js
var PopupCompat = class {
	view;
	container;
	eventBus;
	loaded;
	loadStatus;
	visible;
	location;
	features;
	title;
	content;
	autoOpenEnabled;
	dockEnabled;
	dockOptions;
	selectedFeature;
	selectedFeatureIndex;
	subscriptions;
	watchListeners;
	constructor(options = {}) {
		this.view = options.view;
		this.container = options.container;
		this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view) ?? new CompatEventBus();
		this.loaded = false;
		this.loadStatus = "not-loaded";
		this.visible = false;
		this.location = void 0;
		this.features = [];
		this.title = void 0;
		this.content = void 0;
		this.autoOpenEnabled = options.autoOpenEnabled ?? true;
		this.dockEnabled = options.dockEnabled ?? false;
		this.dockOptions = options.dockOptions;
		this.selectedFeature = void 0;
		this.selectedFeatureIndex = -1;
		this.watchListeners = /* @__PURE__ */ new Map();
		this.subscriptions = [this.eventBus.on("popup.open", () => {
			this.syncFromViewPopup();
		}), this.eventBus.on("popup.close", () => {
			this.syncFromViewPopup();
		})];
		this.syncFromViewPopup();
	}
	async load() {
		if (this.loaded) return this;
		this.loadStatus = "loading";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("popup.loading", void 0, this);
		this.syncFromViewPopup();
		this.loaded = true;
		this.notifyWatchers("loaded", this.loaded);
		this.loadStatus = "loaded";
		this.notifyWatchers("loadStatus", this.loadStatus);
		this.eventBus.emit("popup.loaded", void 0, this);
		return this;
	}
	async when(callback) {
		const widget = await this.load();
		if (callback) callback(widget);
		return widget;
	}
	open(options = {}) {
		const viewPopup = resolveViewPopup(this.view);
		if (viewPopup) {
			viewPopup.open(options);
			if (!isSynchronizedWithViewPopup(this, viewPopup)) this.syncFromViewPopup();
			return;
		}
		this.applyOpenOptions(options);
		this.visible = true;
		this.selectedFeature = this.features[0];
		this.selectedFeatureIndex = this.features.length > 0 ? 0 : -1;
		this.notifyWatchers("visible", this.visible);
		this.notifyWatchers("location", this.location);
		this.notifyWatchers("features", this.features);
		this.notifyWatchers("title", this.title);
		this.notifyWatchers("content", this.content);
		this.notifyWatchers("selectedFeature", this.selectedFeature);
		this.notifyWatchers("selectedFeatureIndex", this.selectedFeatureIndex);
		this.eventBus.emit("popup.open", options, this);
	}
	close() {
		const viewPopup = resolveViewPopup(this.view);
		if (viewPopup) {
			viewPopup.close();
			if (!isSynchronizedWithViewPopup(this, viewPopup)) this.syncFromViewPopup();
			return;
		}
		if (!this.visible) return;
		this.visible = false;
		this.location = void 0;
		this.features = [];
		this.title = void 0;
		this.content = void 0;
		this.selectedFeature = void 0;
		this.selectedFeatureIndex = -1;
		this.notifyWatchers("visible", this.visible);
		this.notifyWatchers("location", this.location);
		this.notifyWatchers("features", this.features);
		this.notifyWatchers("title", this.title);
		this.notifyWatchers("content", this.content);
		this.notifyWatchers("selectedFeature", this.selectedFeature);
		this.notifyWatchers("selectedFeatureIndex", this.selectedFeatureIndex);
		this.eventBus.emit("popup.close", void 0, this);
	}
	clear() {
		this.close();
	}
	selectFeature(featureOrIndex) {
		const viewPopup = resolveViewPopup(this.view);
		if (viewPopup?.selectFeature) {
			viewPopup.selectFeature(featureOrIndex);
			this.syncFromViewPopup();
			return this.selectedFeature;
		}
		const index = typeof featureOrIndex === "number" ? normalizeFeatureIndex(featureOrIndex, this.features.length) : this.features.findIndex((feature) => feature === featureOrIndex);
		if (index < 0) return;
		this.applySelection(index);
		return this.selectedFeature;
	}
	next() {
		const viewPopup = resolveViewPopup(this.view);
		if (viewPopup?.next) {
			viewPopup.next();
			this.syncFromViewPopup();
			return this.selectedFeature;
		}
		if (this.features.length === 0) return;
		const current = this.selectedFeatureIndex >= 0 ? this.selectedFeatureIndex : 0;
		this.applySelection(Math.min(current + 1, this.features.length - 1));
		return this.selectedFeature;
	}
	previous() {
		const viewPopup = resolveViewPopup(this.view);
		if (viewPopup?.previous) {
			viewPopup.previous();
			this.syncFromViewPopup();
			return this.selectedFeature;
		}
		if (this.features.length === 0) return;
		const current = this.selectedFeatureIndex >= 0 ? this.selectedFeatureIndex : 0;
		this.applySelection(Math.max(current - 1, 0));
		return this.selectedFeature;
	}
	watch(propertyName, listener) {
		let listeners = this.watchListeners.get(propertyName);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.watchListeners.set(propertyName, listeners);
		}
		listeners.add(listener);
		return { remove: () => {
			listeners?.delete(listener);
		} };
	}
	destroy() {
		for (const subscription of this.subscriptions.splice(0)) subscription.remove();
		this.watchListeners.clear();
	}
	applyOpenOptions(options) {
		this.location = options.location;
		this.features = options.features ? [...options.features] : [];
		this.title = options.title;
		this.content = options.content;
	}
	syncFromViewPopup() {
		const viewPopup = resolveViewPopup(this.view);
		if (!viewPopup) return;
		const previousVisible = this.visible;
		const previousLocation = this.location;
		const previousFeatures = this.features;
		const previousTitle = this.title;
		const previousContent = this.content;
		const previousSelectedFeature = this.selectedFeature;
		const previousSelectedFeatureIndex = this.selectedFeatureIndex;
		this.visible = viewPopup.visible;
		this.location = viewPopup.location;
		this.features = [...viewPopup.features];
		this.title = viewPopup.title;
		this.content = viewPopup.content;
		this.selectedFeature = viewPopup.selectedFeature ?? this.features[0];
		this.selectedFeatureIndex = typeof viewPopup.selectedFeatureIndex === "number" ? normalizeFeatureIndex(viewPopup.selectedFeatureIndex, this.features.length) : this.features.findIndex((feature) => feature === this.selectedFeature);
		if (this.selectedFeatureIndex < 0) this.selectedFeatureIndex = this.features.length > 0 ? 0 : -1;
		if (!Object.is(previousVisible, this.visible)) this.notifyWatchers("visible", this.visible);
		if (!Object.is(previousLocation, this.location)) this.notifyWatchers("location", this.location);
		if (!arraysShallowEqual(previousFeatures, this.features)) this.notifyWatchers("features", this.features);
		if (!Object.is(previousTitle, this.title)) this.notifyWatchers("title", this.title);
		if (!Object.is(previousContent, this.content)) this.notifyWatchers("content", this.content);
		if (!Object.is(previousSelectedFeature, this.selectedFeature)) this.notifyWatchers("selectedFeature", this.selectedFeature);
		if (!Object.is(previousSelectedFeatureIndex, this.selectedFeatureIndex)) this.notifyWatchers("selectedFeatureIndex", this.selectedFeatureIndex);
	}
	applySelection(index) {
		const normalizedIndex = normalizeFeatureIndex(index, this.features.length);
		if (normalizedIndex < 0) return;
		this.selectedFeatureIndex = normalizedIndex;
		this.selectedFeature = this.features[normalizedIndex];
		this.notifyWatchers("selectedFeature", this.selectedFeature);
		this.notifyWatchers("selectedFeatureIndex", this.selectedFeatureIndex);
		this.eventBus.emit("popup.selected-feature-changed", {
			selectedFeature: this.selectedFeature,
			selectedFeatureIndex: this.selectedFeatureIndex
		}, this);
	}
	notifyWatchers(propertyName, value) {
		const listeners = this.watchListeners.get(propertyName);
		if (!listeners) return;
		for (const listener of listeners) safeInvokeCompatListener(listener, value);
	}
};
function resolveViewPopup(view) {
	if (!isRecord(view) || !isRecord(view.popup)) return;
	const popup = view.popup;
	if (typeof popup.open !== "function" || typeof popup.close !== "function") return;
	if (typeof popup.visible !== "boolean" || !Array.isArray(popup.features)) return;
	return popup;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function normalizeFeatureIndex(index, length) {
	if (!Number.isFinite(index)) return -1;
	const normalized = Math.trunc(index);
	if (normalized < 0 || normalized >= length) return -1;
	return normalized;
}
function arraysShallowEqual(left, right) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) if (!Object.is(left[index], right[index])) return false;
	return true;
}
function isSynchronizedWithViewPopup(widget, viewPopup) {
	const selectedFeature = viewPopup.selectedFeature ?? (viewPopup.features.length > 0 ? viewPopup.features[0] : void 0);
	const selectedFeatureIndex = typeof viewPopup.selectedFeatureIndex === "number" ? normalizeFeatureIndex(viewPopup.selectedFeatureIndex, viewPopup.features.length) : viewPopup.features.findIndex((feature) => Object.is(feature, selectedFeature));
	const normalizedSelectedFeatureIndex = selectedFeatureIndex < 0 ? viewPopup.features.length > 0 ? 0 : -1 : selectedFeatureIndex;
	return Object.is(widget.visible, viewPopup.visible) && Object.is(widget.location, viewPopup.location) && arraysShallowEqual(widget.features, viewPopup.features) && Object.is(widget.title, viewPopup.title) && Object.is(widget.content, viewPopup.content) && Object.is(widget.selectedFeature, selectedFeature) && Object.is(widget.selectedFeatureIndex, normalizedSelectedFeatureIndex);
}
//#endregion
//#region examples/migration-workbench/src/generated/migrated-main.js
var PARCELS = [
	{
		attributes: {
			OBJECTID: 41,
			PARCEL_ID: "TMK-041",
			ZONING: "residential"
		},
		geometry: {
			x: -157.812,
			y: 21.302
		}
	},
	{
		attributes: {
			OBJECTID: 42,
			PARCEL_ID: "TMK-042",
			ZONING: "commercial"
		},
		geometry: {
			x: -157.809,
			y: 21.304
		}
	},
	{
		attributes: {
			OBJECTID: 43,
			PARCEL_ID: "TMK-043",
			ZONING: "residential"
		},
		geometry: {
			x: -157.806,
			y: 21.307
		}
	}
];
var ASSESSMENTS = {
	41: [{ attributes: {
		OBJECTID: 4101,
		PARCEL_ID: "TMK-041",
		YEAR: 2024
	} }, { attributes: {
		OBJECTID: 4102,
		PARCEL_ID: "TMK-041",
		YEAR: 2025
	} }],
	42: [{ attributes: {
		OBJECTID: 4201,
		PARCEL_ID: "TMK-042",
		YEAR: 2025
	} }],
	43: []
};
async function runMigrationWorkbenchScenario() {
	const parcels = new FeatureLayerCompat({
		id: "parcels",
		title: "Honua-authored parcels",
		url: "https://example.test/rest/services/parcels/FeatureServer/0",
		outFields: [
			"OBJECTID",
			"PARCEL_ID",
			"ZONING"
		]
	});
	parcels.queryFeatures = async (query = {}) => {
		return { features: (typeof query.where === "string" ? query.where : "1=1").includes("ZONING = 'residential'") ? PARCELS.filter((feature) => feature.attributes.ZONING === "residential") : PARCELS };
	};
	parcels.queryRelatedFeatures = async (query = {}) => {
		return { relatedRecordGroups: (Array.isArray(query.objectIds) ? query.objectIds : typeof query.objectIds === "string" ? query.objectIds.split(",").map((value) => Number.parseInt(value, 10)) : []).map((objectId) => ({
			objectId,
			relatedRecords: ASSESSMENTS[objectId] ?? []
		})) };
	};
	const map = new MapCompat({
		basemap: "streets",
		layers: [parcels]
	});
	const view = new MapViewCompat({
		map,
		container: null,
		center: [-157.81, 21.304],
		zoom: 13
	});
	const popup = new PopupCompat({ view });
	const table = new FeatureTableCompat({
		view,
		layer: parcels,
		container: null,
		relatedRecordsEnabled: true,
		where: "1=1"
	});
	const layerList = new LayerListCompat({
		view,
		listItemCreatedFunction: ({ item }) => {
			item.actionsSections = [[{
				id: "inspect-selected",
				title: "Inspect selected parcel"
			}]];
		}
	});
	let selectionPopupSynchronized = false;
	table.highlightIds.on("change", () => {
		const selectedRows = table.getSelectedRows();
		if (selectedRows.length === 0) {
			popup.close();
			return;
		}
		popup.open({
			title: "Selected parcel",
			features: selectedRows.map((row) => ({
				id: `parcel-${row.objectId}`,
				attributes: row.attributes,
				geometry: row.geometry
			})),
			location: selectedRows[0].geometry
		});
		selectionPopupSynchronized = popup.visible;
	});
	let layerActionTriggered = false;
	layerList.on("trigger-action", ({ action }) => {
		if (action.id === "inspect-selected") layerActionTriggered = true;
	});
	await table.when();
	const tableCountBeforeFilter = table.size;
	table.setWhere("ZONING = 'residential'");
	await table.refresh();
	const tableCountAfterFilter = table.size;
	table.highlightIds.add(41);
	const selectedRows = table.getSelectedRows();
	const related = await table.queryRelatedRecords({ relationshipId: 0 });
	layerList.refresh();
	layerList.setItemActions(parcels, [[{
		id: "inspect-selected",
		title: "Inspect selected parcel"
	}]]);
	const layerActionDispatched = layerList.triggerAction("inspect-selected", parcels);
	return {
		constructors: {
			layer: parcels.constructor.name,
			map: map.constructor.name,
			view: view.constructor.name,
			table: table.constructor.name,
			popup: popup.constructor.name,
			layerList: layerList.constructor.name
		},
		map: {
			layerCount: map.layers.length,
			center: view.center,
			zoom: view.zoom
		},
		table: {
			countBeforeFilter: tableCountBeforeFilter,
			countAfterFilter: tableCountAfterFilter,
			where: table.where
		},
		selection: {
			objectIds: table.getSelectedObjectIds(),
			selectedRowCount: selectedRows.length,
			popupVisible: popup.visible,
			popupFeatureId: popup.selectedFeature?.id,
			synchronized: selectionPopupSynchronized
		},
		relatedRecords: {
			groupCount: related.relatedRecordGroups.length,
			recordCount: related.relatedRecordGroups.reduce((count, group) => count + (Array.isArray(group.relatedRecords) ? group.relatedRecords.length : 0), 0)
		},
		layerAction: {
			id: "inspect-selected",
			dispatched: layerActionDispatched,
			triggered: layerActionTriggered
		}
	};
}
var migrated_main_default = await runMigrationWorkbenchScenario();
//#endregion
export { migrated_main_default as default, runMigrationWorkbenchScenario };
