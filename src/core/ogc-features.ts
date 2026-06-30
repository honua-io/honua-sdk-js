/**
 * OGC API Features wire methods. Concrete URL-building, param
 * serialization, and request shaping for the OGC API Features endpoints,
 * invoked against an injected {@link HonuaProtocolTransport}. The typed
 * `HonuaOgcFeatures` surface (in `surfaces.ts`) and the `HonuaClient`
 * facade both delegate here.
 *
 * @module
 */

import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcFeatureCollectionResponse,
  HonuaOgcFeatureResponse,
  HonuaOgcLandingResponse,
  HonuaOgcQueryablesResponse,
  OgcCollectionRequest,
  OgcCreateItemRequest,
  OgcDeleteItemRequest,
  OgcItemRequest,
  OgcItemsRequest,
  OgcMetadataRequest,
  OgcPatchItemRequest,
  OgcReplaceItemRequest,
} from "./types.js";
import { createOgcMetadataParams, mergeHeaders, normalizeCsv } from "./wire-shared.js";

export async function getOgcFeaturesLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-features:landing:${params.toString()}`,
    `/ogc/features?${params.toString()}`,
    request,
  );
}

export async function getOgcFeaturesConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-features:conformance:${params.toString()}`,
    `/ogc/features/conformance?${params.toString()}`,
    request,
  );
}

export async function listOgcCollections(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcCollectionsResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
    `ogc-features:collections:${params.toString()}`,
    `/ogc/features/collections?${params.toString()}`,
    request,
  );
}

export async function getOgcCollection(
  transport: HonuaProtocolTransport,
  request: OgcCollectionRequest,
): Promise<HonuaOgcCollectionMetadata> {
  const params = createOgcMetadataParams(request);
  const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}`;
  return transport.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
    `ogc-features:collection:${request.collectionId}:${params.toString()}`,
    `${path}?${params.toString()}`,
    request,
  );
}

export async function getOgcQueryables(
  transport: HonuaProtocolTransport,
  request: OgcCollectionRequest,
): Promise<HonuaOgcQueryablesResponse> {
  const params = createOgcMetadataParams(request);
  const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}/queryables`;
  return transport.requestCachedMetadataJson<HonuaOgcQueryablesResponse>(
    `ogc-features:queryables:${request.collectionId}:${params.toString()}`,
    `${path}?${params.toString()}`,
    request,
  );
}

export async function listOgcItems(
  transport: HonuaProtocolTransport,
  request: OgcItemsRequest,
): Promise<HonuaOgcFeatureCollectionResponse> {
  const params = createOgcMetadataParams(request);
  if (request.limit !== undefined) {
    params.set("limit", String(request.limit));
  }
  if (request.offset !== undefined) {
    params.set("offset", String(request.offset));
  }
  if (request.bbox !== undefined) {
    params.set("bbox", request.bbox);
  }
  if (request.datetime !== undefined) {
    params.set("datetime", request.datetime);
  }
  if (request.filter !== undefined) {
    params.set("filter", request.filter);
  }
  if (request.ids !== undefined) {
    params.set("ids", normalizeCsv(request.ids));
  }
  if (request.properties !== undefined) {
    params.set("properties", normalizeCsv(request.properties));
  }
  if (request.sortby !== undefined) {
    params.set("sortby", request.sortby);
  }
  if (request.crs !== undefined) {
    params.set("crs", request.crs);
  }
  const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}/items`;
  return transport.requestJson<HonuaOgcFeatureCollectionResponse>(
    "GET",
    `${path}?${params.toString()}`,
    undefined,
    request.signal,
  );
}

export async function getOgcItem(
  transport: HonuaProtocolTransport,
  request: OgcItemRequest,
): Promise<HonuaOgcFeatureResponse> {
  const params = createOgcMetadataParams(request);
  if (request.crs !== undefined) {
    params.set("crs", request.crs);
  }
  const path =
    `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
    `/items/${encodeURIComponent(String(request.featureId))}`;
  return transport.requestJson<HonuaOgcFeatureResponse>(
    "GET",
    `${path}?${params.toString()}`,
    undefined,
    request.signal,
  );
}

export async function createOgcItem(
  transport: HonuaProtocolTransport,
  request: OgcCreateItemRequest,
): Promise<HonuaOgcFeatureResponse> {
  const params = createOgcMetadataParams(request);
  const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}/items`;
  return transport.requestJson<HonuaOgcFeatureResponse>(
    "POST",
    `${path}?${params.toString()}`,
    {
      headers: mergeHeaders({ "Content-Type": "application/geo+json" }, request.headers),
      body: JSON.stringify(request.feature),
    },
    request.signal,
  );
}

export async function replaceOgcItem(
  transport: HonuaProtocolTransport,
  request: OgcReplaceItemRequest,
): Promise<HonuaOgcFeatureResponse> {
  const params = createOgcMetadataParams(request);
  if (request.crs !== undefined) {
    params.set("crs", request.crs);
  }
  const path =
    `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
    `/items/${encodeURIComponent(String(request.featureId))}`;
  return transport.requestJson<HonuaOgcFeatureResponse>(
    "PUT",
    `${path}?${params.toString()}`,
    {
      headers: mergeHeaders({ "Content-Type": "application/geo+json" }, request.headers),
      body: JSON.stringify(request.feature),
    },
    request.signal,
  );
}

export async function patchOgcItem(
  transport: HonuaProtocolTransport,
  request: OgcPatchItemRequest,
): Promise<HonuaOgcFeatureResponse> {
  const params = createOgcMetadataParams(request);
  if (request.crs !== undefined) {
    params.set("crs", request.crs);
  }
  const path =
    `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
    `/items/${encodeURIComponent(String(request.featureId))}`;
  return transport.requestJson<HonuaOgcFeatureResponse>(
    "PATCH",
    `${path}?${params.toString()}`,
    {
      headers: mergeHeaders({ "Content-Type": "application/merge-patch+json" }, request.headers),
      body: JSON.stringify(request.patch),
    },
    request.signal,
  );
}

export async function deleteOgcItem(transport: HonuaProtocolTransport, request: OgcDeleteItemRequest): Promise<void> {
  const params = createOgcMetadataParams(request);
  if (request.crs !== undefined) {
    params.set("crs", request.crs);
  }
  const path =
    `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
    `/items/${encodeURIComponent(String(request.featureId))}`;
  await transport.requestJson("DELETE", `${path}?${params.toString()}`, undefined, request.signal);
}
