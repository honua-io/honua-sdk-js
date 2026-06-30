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

import type { HonuaMetadataRequestOptions } from "./cache-state.js";
import { encodeServiceIdPath } from "./path-utils.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  ApplyEditsRequest,
  ExportMapRequest,
  HonuaApplyEditsResponse,
  HonuaExportMapResponse,
  HonuaFindResponse,
  HonuaIdentifyResponse,
  HonuaLayerMetadata,
  HonuaLegendResponse,
  HonuaQueryResponse,
  HonuaRelatedRecordsResponse,
  HonuaServiceMetadata,
  HonuaServicesResponse,
  MapFindRequest,
  MapIdentifyRequest,
  MapLayerQueryRequest,
  MapLegendRequest,
  MapRelatedRecordsRequest,
  QueryFeaturesRequest,
  QueryMethod,
  QueryRelatedRecordsRequest,
} from "./types.js";

// ── Metadata ────────────────────────────────────────────────────

export async function listServices(
  transport: HonuaProtocolTransport,
  format: "json" | "pjson",
  options: HonuaMetadataRequestOptions = {},
): Promise<HonuaServicesResponse> {
  const query = new URLSearchParams({ f: format });
  const path = `/rest/services?${query.toString()}`;
  return transport.requestCachedMetadataJson<HonuaServicesResponse>(`geoservices:services:${format}`, path, options);
}

export async function getLayerMetadata(
  transport: HonuaProtocolTransport,
  serviceId: string,
  layerId: number,
  options: HonuaMetadataRequestOptions = {},
): Promise<HonuaLayerMetadata> {
  const query = new URLSearchParams({ f: "json" });
  const path = `/rest/services/${encodeServiceIdPath(serviceId)}/FeatureServer/${layerId}?${query.toString()}`;
  return transport.requestCachedMetadataJson<HonuaLayerMetadata>(
    `geoservices-feature:${serviceId}:${layerId}`,
    path,
    options,
  );
}

export async function getFeatureServiceMetadata(
  transport: HonuaProtocolTransport,
  serviceId: string,
  options: HonuaMetadataRequestOptions = {},
): Promise<HonuaServiceMetadata> {
  const query = new URLSearchParams({ f: "json" });
  const path = `/rest/services/${encodeServiceIdPath(serviceId)}/FeatureServer?${query.toString()}`;
  return transport.requestCachedMetadataJson<HonuaServiceMetadata>(
    `geoservices-feature:${serviceId}:service`,
    path,
    options,
  );
}

export async function getMapServiceMetadata(
  transport: HonuaProtocolTransport,
  serviceId: string,
  options: HonuaMetadataRequestOptions = {},
): Promise<HonuaServiceMetadata> {
  const query = new URLSearchParams({ f: "json" });
  const path = `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer?${query.toString()}`;
  return transport.requestCachedMetadataJson<HonuaServiceMetadata>(
    `geoservices-map:${serviceId}:service`,
    path,
    options,
  );
}

export async function getMapLayerMetadata(
  transport: HonuaProtocolTransport,
  serviceId: string,
  layerId: number,
  options: HonuaMetadataRequestOptions = {},
): Promise<HonuaLayerMetadata> {
  const query = new URLSearchParams({ f: "json" });
  const path = `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/${layerId}?${query.toString()}`;
  return transport.requestCachedMetadataJson<HonuaLayerMetadata>(
    `geoservices-map:${serviceId}:${layerId}`,
    path,
    options,
  );
}

// ── FeatureServer / MapServer operations ────────────────────────

/**
 * REST portion of `client.queryFeatures` (the gRPC-web fast path is
 * orchestrated by the client). Maps directly to the FeatureServer `query`
 * endpoint, optionally negotiating a PBF response on `GET` when
 * `preferBinary` is set.
 */
export async function queryFeaturesRest(
  transport: HonuaProtocolTransport,
  request: QueryFeaturesRequest,
  preferBinary: boolean,
): Promise<HonuaQueryResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const usePbf = preferBinary && method === "GET";
  const params = new URLSearchParams();
  params.set("f", usePbf ? "pbf" : "json");
  params.set("where", request.where ?? "1=1");
  params.set("outFields", normalizeOutFields(request.outFields));
  params.set("returnGeometry", String(request.returnGeometry ?? true));

  serializeQueryParams(params, request);
  appendQueryExtraParams(params, request);

  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/query`;

  if (usePbf) {
    return transport.requestBinaryWithJsonFallback<HonuaQueryResponse>(
      "GET",
      `${path}?${params.toString()}`,
      params,
      request.signal,
    );
  }

  if (method === "GET") {
    return transport.requestJson<HonuaQueryResponse>("GET", `${path}?${params.toString()}`, undefined, request.signal);
  }

  return transport.requestJson<HonuaQueryResponse>(
    "POST",
    path,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    request.signal,
  );
}

export async function queryMapLayer(
  transport: HonuaProtocolTransport,
  request: MapLayerQueryRequest,
): Promise<HonuaQueryResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const params = new URLSearchParams();
  params.set("f", "json");
  params.set("where", request.where ?? "1=1");
  params.set("outFields", normalizeOutFields(request.outFields));
  params.set("returnGeometry", String(request.returnGeometry ?? true));

  serializeQueryParams(params, request);
  appendQueryExtraParams(params, request);

  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/${request.layerId}/query`;
  if (method === "GET") {
    return transport.requestJson<HonuaQueryResponse>("GET", `${path}?${params.toString()}`, undefined, request.signal);
  }

  return transport.requestJson<HonuaQueryResponse>(
    "POST",
    path,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    request.signal,
  );
}

export async function applyEdits(
  transport: HonuaProtocolTransport,
  request: ApplyEditsRequest,
): Promise<HonuaApplyEditsResponse> {
  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/applyEdits`;
  const params = new URLSearchParams();
  params.set("f", "json");
  params.set("rollbackOnFailure", String(request.rollbackOnFailure ?? true));
  if (request.adds !== undefined) {
    params.set("adds", encodeFormValue(request.adds));
  }
  if (request.updates !== undefined) {
    params.set("updates", encodeFormValue(request.updates));
  }
  if (request.deletes !== undefined) {
    params.set("deletes", encodeDeletesValue(request.deletes));
  }

  return transport.requestJson<HonuaApplyEditsResponse>(
    "POST",
    path,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    request.signal,
  );
}

export async function queryRelatedRecords(
  transport: HonuaProtocolTransport,
  request: QueryRelatedRecordsRequest,
): Promise<HonuaRelatedRecordsResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const params = new URLSearchParams();
  params.set("f", "json");
  params.set("relationshipId", String(request.relationshipId));
  if (request.objectIds !== undefined) {
    params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
  }
  params.set("where", request.where ?? "1=1");
  params.set("outFields", normalizeOutFields(request.outFields));
  params.set("returnGeometry", String(request.returnGeometry ?? true));

  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }

  const path =
    `/rest/services/${encodeServiceIdPath(request.serviceId)}` +
    `/FeatureServer/${request.layerId}/queryRelatedRecords`;
  if (method === "GET") {
    return transport.requestJson<HonuaRelatedRecordsResponse>(
      "GET",
      `${path}?${params.toString()}`,
      undefined,
      request.signal,
    );
  }

  return transport.requestJson<HonuaRelatedRecordsResponse>(
    "POST",
    path,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    request.signal,
  );
}

export async function queryMapRelatedRecords(
  transport: HonuaProtocolTransport,
  request: MapRelatedRecordsRequest,
): Promise<HonuaRelatedRecordsResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const params = new URLSearchParams();
  params.set("f", "json");
  params.set("relationshipId", String(request.relationshipId));
  if (request.objectIds !== undefined) {
    params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
  }
  params.set("where", request.where ?? "1=1");
  params.set("outFields", normalizeOutFields(request.outFields));
  params.set("returnGeometry", String(request.returnGeometry ?? true));

  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }

  const path =
    `/rest/services/${encodeServiceIdPath(request.serviceId)}` + `/MapServer/${request.layerId}/queryRelatedRecords`;
  if (method === "GET") {
    return transport.requestJson<HonuaRelatedRecordsResponse>(
      "GET",
      `${path}?${params.toString()}`,
      undefined,
      request.signal,
    );
  }

  return transport.requestJson<HonuaRelatedRecordsResponse>(
    "POST",
    path,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    request.signal,
  );
}

export async function exportMap(
  transport: HonuaProtocolTransport,
  request: ExportMapRequest,
): Promise<HonuaExportMapResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const params = new URLSearchParams();
  params.set("f", request.responseFormat ?? "json");
  params.set("bbox", normalizeBBox(request.bbox));
  params.set("size", normalizeSize(request.size));
  if (request.format !== undefined) {
    params.set("format", request.format);
  }
  if (request.dpi !== undefined) {
    params.set("dpi", String(request.dpi));
  }
  if (request.transparent !== undefined) {
    params.set("transparent", String(request.transparent));
  }
  if (request.layers !== undefined) {
    params.set("layers", request.layers);
  }
  if (request.bboxSr !== undefined) {
    params.set("bboxSR", String(request.bboxSr));
  }
  if (request.imageSr !== undefined) {
    params.set("imageSR", String(request.imageSr));
  }
  if (request.backgroundColor !== undefined) {
    params.set("backgroundColor", request.backgroundColor);
  }

  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }

  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/export`;
  if (method === "GET") {
    return transport.requestJson<HonuaExportMapResponse>("GET", `${path}?${params.toString()}`);
  }

  return transport.requestJson<HonuaExportMapResponse>("POST", path, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}

export async function getMapLegend(
  transport: HonuaProtocolTransport,
  request: MapLegendRequest,
): Promise<HonuaLegendResponse> {
  const params = new URLSearchParams();
  params.set("f", request.responseFormat ?? "json");
  if (request.size !== undefined) {
    params.set("size", normalizeLegendSize(request.size));
  }
  if (request.dynamicLayers !== undefined) {
    params.set("dynamicLayers", request.dynamicLayers);
  }
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }

  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/legend`;
  return transport.requestJson<HonuaLegendResponse>("GET", `${path}?${params.toString()}`);
}

export async function identifyMap(
  transport: HonuaProtocolTransport,
  request: MapIdentifyRequest,
): Promise<HonuaIdentifyResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const params = new URLSearchParams();
  params.set("f", request.responseFormat ?? "json");
  params.set("geometry", normalizeIdentifyGeometry(request.geometry));
  params.set("geometryType", request.geometryType ?? "esriGeometryPoint");
  params.set("mapExtent", normalizeMapExtent(request.mapExtent));
  params.set("imageDisplay", normalizeImageDisplay(request.imageDisplay));
  params.set("returnGeometry", String(request.returnGeometry ?? true));
  params.set("tolerance", String(request.tolerance ?? 3));

  if (request.sr !== undefined) {
    params.set("sr", String(request.sr));
  }
  if (request.layers !== undefined) {
    params.set("layers", request.layers);
  }
  if (request.maxAllowableOffset !== undefined) {
    params.set("maxAllowableOffset", String(request.maxAllowableOffset));
  }
  if (request.layerDefs !== undefined) {
    params.set("layerDefs", request.layerDefs);
  }
  if (request.dynamicLayers !== undefined) {
    params.set("dynamicLayers", request.dynamicLayers);
  }
  if (request.time !== undefined) {
    params.set("time", request.time);
  }
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }

  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/identify`;
  if (method === "GET") {
    return transport.requestJson<HonuaIdentifyResponse>("GET", `${path}?${params.toString()}`);
  }

  return transport.requestJson<HonuaIdentifyResponse>("POST", path, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}

export async function findMap(transport: HonuaProtocolTransport, request: MapFindRequest): Promise<HonuaFindResponse> {
  const method: QueryMethod = request.method ?? "GET";
  const params = new URLSearchParams();
  params.set("f", request.responseFormat ?? "json");
  params.set("searchText", request.searchText);
  params.set("contains", String(request.contains ?? true));
  if (request.searchFields !== undefined) {
    params.set("searchFields", normalizeSearchFields(request.searchFields));
  }
  if (request.layers !== undefined) {
    params.set("layers", request.layers);
  }
  if (request.sr !== undefined) {
    params.set("sr", String(request.sr));
  }
  if (request.layerDefs !== undefined) {
    params.set("layerDefs", request.layerDefs);
  }
  if (request.returnGeometry !== undefined) {
    params.set("returnGeometry", String(request.returnGeometry));
  }
  if (request.maxAllowableOffset !== undefined) {
    params.set("maxAllowableOffset", String(request.maxAllowableOffset));
  }
  if (request.dynamicLayers !== undefined) {
    params.set("dynamicLayers", request.dynamicLayers);
  }
  if (request.returnZ !== undefined) {
    params.set("returnZ", String(request.returnZ));
  }
  if (request.returnM !== undefined) {
    params.set("returnM", String(request.returnM));
  }
  if (request.gdbVersion !== undefined) {
    params.set("gdbVersion", request.gdbVersion);
  }
  if (request.time !== undefined) {
    params.set("time", request.time);
  }
  if (request.relationParam !== undefined) {
    params.set("relationParam", request.relationParam);
  }
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }

  const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/find`;
  if (method === "GET") {
    return transport.requestJson<HonuaFindResponse>("GET", `${path}?${params.toString()}`);
  }

  return transport.requestJson<HonuaFindResponse>("POST", path, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}

// ── Param serialization helpers ─────────────────────────────────

function normalizeOutFields(outFields: string | string[] | undefined): string {
  if (outFields === undefined) {
    return "*";
  }
  if (Array.isArray(outFields)) {
    return outFields.length > 0 ? outFields.join(",") : "";
  }
  return outFields;
}

function encodeFormValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function encodeDeletesValue(value: ApplyEditsRequest["deletes"]): string {
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return String(value);
}

function normalizeBBox(bbox: ExportMapRequest["bbox"]): string {
  return Array.isArray(bbox) ? bbox.join(",") : bbox;
}

function normalizeSize(size: ExportMapRequest["size"]): string {
  return Array.isArray(size) ? size.join(",") : size;
}

function normalizeLegendSize(size: NonNullable<MapLegendRequest["size"]>): string {
  if (typeof size === "number") {
    return String(size);
  }
  if (Array.isArray(size)) {
    return size.join(",");
  }
  return size;
}

function normalizeIdentifyGeometry(geometry: MapIdentifyRequest["geometry"]): string {
  return typeof geometry === "string" ? geometry : JSON.stringify(geometry);
}

function normalizeMapExtent(mapExtent: MapIdentifyRequest["mapExtent"]): string {
  return Array.isArray(mapExtent) ? mapExtent.join(",") : mapExtent;
}

function normalizeImageDisplay(imageDisplay: MapIdentifyRequest["imageDisplay"]): string {
  return Array.isArray(imageDisplay) ? imageDisplay.join(",") : imageDisplay;
}

function normalizeSearchFields(searchFields: MapFindRequest["searchFields"]): string {
  if (!searchFields) {
    return "";
  }
  return Array.isArray(searchFields) ? searchFields.join(",") : searchFields;
}

function serializeQueryParams(params: URLSearchParams, request: QueryFeaturesRequest | MapLayerQueryRequest): void {
  if (request.outSr !== undefined) {
    params.set(
      "outSR",
      typeof request.outSr === "object" && request.outSr !== null
        ? JSON.stringify(request.outSr)
        : String(request.outSr),
    );
  }
  if (request.orderByFields !== undefined) {
    params.set("orderByFields", request.orderByFields);
  }
  if (request.objectIds !== undefined) {
    params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
  }
  if (request.geometry !== undefined) {
    params.set(
      "geometry",
      typeof request.geometry === "object" && request.geometry !== null
        ? JSON.stringify(request.geometry)
        : String(request.geometry),
    );
  }
  if (request.geometryType !== undefined) {
    params.set("geometryType", request.geometryType);
  }
  if (request.spatialRel !== undefined) {
    params.set("spatialRel", request.spatialRel);
  }
  if (request.returnDistinctValues !== undefined) {
    params.set("returnDistinctValues", String(request.returnDistinctValues));
  }
  if (request.returnCentroid !== undefined) {
    params.set("returnCentroid", String(request.returnCentroid));
  }
  if (request.groupByFieldsForStatistics !== undefined) {
    params.set("groupByFieldsForStatistics", request.groupByFieldsForStatistics);
  }
  if (request.outStatistics !== undefined) {
    params.set(
      "outStatistics",
      Array.isArray(request.outStatistics) ? JSON.stringify(request.outStatistics) : String(request.outStatistics),
    );
  }
  if (request.resultOffset !== undefined) {
    params.set("resultOffset", String(request.resultOffset));
  }
  if (request.resultRecordCount !== undefined) {
    params.set("resultRecordCount", String(request.resultRecordCount));
  }
}

function appendQueryExtraParams(
  params: URLSearchParams,
  request: Pick<QueryFeaturesRequest | MapLayerQueryRequest, "outSr" | "extraParams">,
): void {
  if (!request.extraParams) {
    return;
  }

  for (const [key, value] of Object.entries(request.extraParams)) {
    if (request.outSr !== undefined && (key === "outSr" || key === "outSR")) {
      continue;
    }
    params.set(key, String(value));
  }
}
