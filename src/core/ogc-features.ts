/**
 * OGC API Features wire methods. Concrete URL-building, param
 * serialization, and request shaping for the OGC API Features endpoints,
 * invoked against an injected {@link HonuaProtocolTransport}. The typed
 * `HonuaOgcFeatures` surface (in `surfaces.ts`) and the `HonuaClient`
 * facade both delegate here.
 *
 * @module
 */

import { honuaFacadeFeaturesLayout } from "./ogc-endpoint-layout.js";
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
  OgcEndpointLayout,
  OgcItemRequest,
  OgcItemsRequest,
  OgcMetadataRequest,
  OgcPatchItemRequest,
  OgcReplaceItemRequest,
} from "./types.js";
import { createOgcMetadataParams, mergeHeaders, normalizeCsv } from "./wire-shared.js";

/**
 * The endpoint layout to build paths against. Defaults to the Honua facade
 * fast path (`/ogc/features/...`); backend-agnostic callers thread a
 * spec-discovered layout onto `request.layout`.
 */
function layoutOf(request: { layout?: OgcEndpointLayout }): OgcEndpointLayout {
  return request.layout ?? honuaFacadeFeaturesLayout();
}

/**
 * A layout key fragment for cache keys so the facade and a discovered raw
 * layout never collide in the metadata cache.
 */
function layoutKey(layout: OgcEndpointLayout): string {
  return layout.mode === "honua-facade" ? "facade" : layout.collections();
}

export async function getOgcFeaturesLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  const layout = layoutOf(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-features:landing:${layoutKey(layout)}:${params.toString()}`,
    `${layout.landing()}?${params.toString()}`,
    request,
  );
}

export async function getOgcFeaturesConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  const layout = layoutOf(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-features:conformance:${layoutKey(layout)}:${params.toString()}`,
    `${layout.conformance()}?${params.toString()}`,
    request,
  );
}

export async function listOgcCollections(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcCollectionsResponse> {
  const params = createOgcMetadataParams(request);
  const layout = layoutOf(request);
  return transport.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
    `ogc-features:collections:${layoutKey(layout)}:${params.toString()}`,
    `${layout.collections()}?${params.toString()}`,
    request,
  );
}

export async function getOgcCollection(
  transport: HonuaProtocolTransport,
  request: OgcCollectionRequest,
): Promise<HonuaOgcCollectionMetadata> {
  const params = createOgcMetadataParams(request);
  const layout = layoutOf(request);
  return transport.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
    `ogc-features:collection:${layoutKey(layout)}:${request.collectionId}:${params.toString()}`,
    `${layout.collection(request.collectionId)}?${params.toString()}`,
    request,
  );
}

export async function getOgcQueryables(
  transport: HonuaProtocolTransport,
  request: OgcCollectionRequest,
): Promise<HonuaOgcQueryablesResponse> {
  const params = createOgcMetadataParams(request);
  const layout = layoutOf(request);
  return transport.requestCachedMetadataJson<HonuaOgcQueryablesResponse>(
    `ogc-features:queryables:${layoutKey(layout)}:${request.collectionId}:${params.toString()}`,
    `${layout.queryables(request.collectionId)}?${params.toString()}`,
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
  if (request.filterLang !== undefined) {
    params.set("filter-lang", request.filterLang);
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
  const path = layoutOf(request).items(request.collectionId);
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
  const path = layoutOf(request).item(request.collectionId, request.featureId);
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
  const path = layoutOf(request).items(request.collectionId);
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
  const path = layoutOf(request).item(request.collectionId, request.featureId);
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
  const path = layoutOf(request).item(request.collectionId, request.featureId);
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
  const path = layoutOf(request).item(request.collectionId, request.featureId);
  await transport.requestJson("DELETE", `${path}?${params.toString()}`, undefined, request.signal);
}
