/**
 * OGC API Records surface. Records are catalog metadata documents about
 * resources (services, collections, maps, scenes, STAC collections, source
 * descriptors), not STAC imagery items and not protocol-native service
 * metadata. The wire calls live on `HonuaClient`; this class is the
 * request-shaping layer on top.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcRecordResponse,
  HonuaOgcRecordsResponse,
  OgcCollectionRequest,
  OgcMetadataRequest,
  OgcRecordItemRequest,
  OgcRecordRawItemRequest,
  OgcRecordsRawSearchRequest,
  OgcRecordsSearchRequest,
} from "./types.js";
import { createOgcMetadataParams, mergeHeaders, normalizeCsv, normalizeStringCsv } from "./wire-shared.js";

export interface HonuaOgcRecordsOptions {
  client: HonuaClient;
}

export interface HonuaOgcRecordCollectionOptions {
  client: HonuaClient;
  collectionId: string | number;
}

export interface HonuaOgcRecordsSearchAllRequest extends OgcRecordsSearchRequest {
  /** Maximum number of records to request per page. */
  pageSize?: number;
  /** Hard cap on the number of pages to fetch (defaults to 100). */
  maxPages?: number;
}

export type HonuaOgcRecordCollectionSearchRequest = Omit<OgcRecordsSearchRequest, "collectionId">;
export type HonuaOgcRecordCollectionSearchAllRequest = HonuaOgcRecordCollectionSearchRequest & {
  pageSize?: number;
  maxPages?: number;
};
export type HonuaOgcRecordCollectionItemRequest = Omit<OgcRecordItemRequest, "collectionId">;
export type HonuaOgcRecordCollectionRawSearchRequest = Omit<OgcRecordsRawSearchRequest, "collectionId">;
export type HonuaOgcRecordCollectionRawItemRequest = Omit<OgcRecordRawItemRequest, "collectionId">;

const DEFAULT_RECORDS_PAGE_SIZE = 100;
const DEFAULT_RECORDS_MAX_PAGES = 100;

/** Top-level OGC API Records handle. */
export class HonuaOgcRecords {
  public readonly client: HonuaClient;

  public constructor(options: HonuaOgcRecordsOptions) {
    this.client = options.client;
  }

  public collection(collectionId: string | number): HonuaOgcRecordCollection {
    return new HonuaOgcRecordCollection({ client: this.client, collectionId });
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcRecordsLanding(request);
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcRecordsConformance(request);
  }

  public async collections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return this.client.listOgcRecordCollections(request);
  }

  public async collectionMetadata(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return this.client.getOgcRecordCollection(request);
  }

  public async search(request: OgcRecordsSearchRequest): Promise<HonuaOgcRecordsResponse> {
    return this.client.searchOgcRecords(request);
  }

  public async record(request: OgcRecordItemRequest): Promise<HonuaOgcRecordResponse> {
    return this.client.getOgcRecord(request);
  }

  public async rawSearch(request: OgcRecordsRawSearchRequest): Promise<Response> {
    return this.client.fetchOgcRecordsRaw(request);
  }

  public async rawRecord(request: OgcRecordRawItemRequest): Promise<Response> {
    return this.client.fetchOgcRecordRaw(request);
  }

  public async searchAll(request: HonuaOgcRecordsSearchAllRequest): Promise<HonuaOgcRecordResponse[]> {
    const pageSize = request.pageSize ?? request.limit ?? DEFAULT_RECORDS_PAGE_SIZE;
    const maxPages = request.maxPages ?? DEFAULT_RECORDS_MAX_PAGES;
    const records: HonuaOgcRecordResponse[] = [];
    let cursor: RecordsPageCursor = { offset: request.offset };
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.client.searchOgcRecords({
        ...request,
        limit: pageSize,
        offset: cursor.offset,
      });
      const pageRecords = response.features ?? [];
      if (pageRecords.length === 0) break;
      records.push(...pageRecords);
      cursor = nextRecordsCursor(response.links);
      // Continuation is driven solely by the next-link cursor (and the
      // maxPages cap). OGC API Records/Features permits a server to return
      // fewer than `limit` records on a non-final page while still
      // advertising a `rel=next` link, so a short page must not stop paging.
      if (cursor.offset === undefined) break;
    }
    return records;
  }

  public async *searchStream(
    request: HonuaOgcRecordsSearchAllRequest,
  ): AsyncGenerator<HonuaOgcRecordResponse[], void, undefined> {
    const pageSize = request.pageSize ?? request.limit ?? DEFAULT_RECORDS_PAGE_SIZE;
    const maxPages = request.maxPages ?? DEFAULT_RECORDS_MAX_PAGES;
    let cursor: RecordsPageCursor = { offset: request.offset };
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.client.searchOgcRecords({
        ...request,
        limit: pageSize,
        offset: cursor.offset,
      });
      const pageRecords = response.features ?? [];
      if (pageRecords.length === 0) break;
      yield pageRecords;
      cursor = nextRecordsCursor(response.links);
      // See searchAll: a short page is not a termination signal; rely on the
      // next-link cursor and the maxPages cap.
      if (cursor.offset === undefined) break;
    }
  }
}

/**
 * Bound handle for one Records catalog (`/collections/{catalogId}`). Drops
 * the routing discriminator from per-call requests.
 */
export class HonuaOgcRecordCollection {
  public readonly client: HonuaClient;
  public readonly collectionId: string | number;

  public constructor(options: HonuaOgcRecordCollectionOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
  }

  public async metadata(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionMetadata> {
    return this.client.getOgcRecordCollection({ ...request, collectionId: this.collectionId });
  }

  public async search(request: HonuaOgcRecordCollectionSearchRequest = {}): Promise<HonuaOgcRecordsResponse> {
    return this.client.searchOgcRecords({ ...request, collectionId: this.collectionId });
  }

  public async record(request: HonuaOgcRecordCollectionItemRequest): Promise<HonuaOgcRecordResponse> {
    return this.client.getOgcRecord({ ...request, collectionId: this.collectionId });
  }

  public async rawSearch(request: HonuaOgcRecordCollectionRawSearchRequest = {}): Promise<Response> {
    return this.client.fetchOgcRecordsRaw({ ...request, collectionId: this.collectionId });
  }

  public async rawRecord(request: HonuaOgcRecordCollectionRawItemRequest): Promise<Response> {
    return this.client.fetchOgcRecordRaw({ ...request, collectionId: this.collectionId });
  }

  public async searchAll(request: HonuaOgcRecordCollectionSearchAllRequest = {}): Promise<HonuaOgcRecordResponse[]> {
    const root = new HonuaOgcRecords({ client: this.client });
    return root.searchAll({ ...request, collectionId: this.collectionId });
  }

  public searchStream(
    request: HonuaOgcRecordCollectionSearchAllRequest = {},
  ): AsyncGenerator<HonuaOgcRecordResponse[], void, undefined> {
    const root = new HonuaOgcRecords({ client: this.client });
    return root.searchStream({ ...request, collectionId: this.collectionId });
  }
}

interface RecordsPageCursor {
  offset?: number;
}

/**
 * Query-param names that may carry the next-page start offset on an OGC API
 * `rel:"next"` link. `offset` is Honua Server's spelling; `startindex` is the
 * OGC API – Features / Records standard name (servers also vary the casing).
 */
const RECORDS_OFFSET_PARAM_NAMES = ["offset", "startindex", "startIndex"] as const;

function nextRecordsCursor(links: HonuaOgcRecordsResponse["links"] | undefined): RecordsPageCursor {
  if (!links) return {};
  for (const link of links) {
    if (link.rel !== "next" || typeof link.href !== "string") continue;
    try {
      const url = new URL(link.href, "https://placeholder.test");
      // Standards-conformant servers commonly express the next page with
      // `startindex` rather than `offset`; honor whichever the server sent so
      // pagination doesn't silently stop after the first page.
      const offsetParam = readFirstParam(url.searchParams, RECORDS_OFFSET_PARAM_NAMES);
      if (offsetParam === null) continue;
      const offset = Number(offsetParam);
      if (Number.isFinite(offset)) return { offset };
    } catch {
      // Ignore unparsable hrefs; keep scanning for a usable next link.
    }
  }
  return {};
}

/** Return the first non-null value among `names` from the query string. */
function readFirstParam(params: URLSearchParams, names: readonly string[]): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return value;
  }
  return null;
}

export function createHonuaOgcRecords(client: HonuaClient): HonuaOgcRecords {
  return new HonuaOgcRecords({ client });
}

// ── OGC API Records wire methods ────────────────────────────────

export async function getOgcRecordsLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-records:landing:${params.toString()}`,
    `/ogc/records?${params.toString()}`,
    request,
  );
}

export async function getOgcRecordsConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-records:conformance:${params.toString()}`,
    `/ogc/records/conformance?${params.toString()}`,
    request,
  );
}

export async function listOgcRecordCollections(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcCollectionsResponse> {
  const params = createOgcMetadataParams(request);
  return transport.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
    `ogc-records:collections:${params.toString()}`,
    `/ogc/records/collections?${params.toString()}`,
    request,
  );
}

export async function getOgcRecordCollection(
  transport: HonuaProtocolTransport,
  request: OgcCollectionRequest,
): Promise<HonuaOgcCollectionMetadata> {
  const params = createOgcMetadataParams(request);
  const path = `/ogc/records/collections/${encodeURIComponent(String(request.collectionId))}`;
  return transport.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
    `ogc-records:collection:${request.collectionId}:${params.toString()}`,
    `${path}?${params.toString()}`,
    request,
  );
}

export async function searchOgcRecords(
  transport: HonuaProtocolTransport,
  request: OgcRecordsSearchRequest,
): Promise<HonuaOgcRecordsResponse> {
  return transport.requestJson<HonuaOgcRecordsResponse>(
    "GET",
    buildOgcRecordsSearchPath(request),
    undefined,
    request.signal,
  );
}

export async function getOgcRecord(
  transport: HonuaProtocolTransport,
  request: OgcRecordItemRequest,
): Promise<HonuaOgcRecordResponse> {
  return transport.requestJson<HonuaOgcRecordResponse>("GET", buildOgcRecordPath(request), undefined, request.signal);
}

export async function fetchOgcRecordsRaw(
  transport: HonuaProtocolTransport,
  request: OgcRecordsRawSearchRequest,
): Promise<Response> {
  return transport.pipelineFetch(
    "GET",
    buildOgcRecordsSearchPath(request),
    {
      headers: mergeHeaders(
        { Accept: request.accept ?? "application/geo+json, application/json;q=0.9" },
        request.headers,
      ),
    },
    request.signal,
  );
}

export async function fetchOgcRecordRaw(
  transport: HonuaProtocolTransport,
  request: OgcRecordRawItemRequest,
): Promise<Response> {
  return transport.pipelineFetch(
    "GET",
    buildOgcRecordPath(request),
    {
      headers: mergeHeaders(
        { Accept: request.accept ?? "application/geo+json, application/json;q=0.9" },
        request.headers,
      ),
    },
    request.signal,
  );
}

function normalizeRecordsBbox(value: OgcRecordsSearchRequest["bbox"]): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function buildOgcRecordsSearchPath(request: OgcRecordsSearchRequest): string {
  const collection = encodeURIComponent(String(request.collectionId));
  const params = serializeOgcRecordsSearchParams(request);
  return `/ogc/records/collections/${collection}/items?${params.toString()}`;
}

function buildOgcRecordPath(request: OgcRecordItemRequest): string {
  const collection = encodeURIComponent(String(request.collectionId));
  const record = encodeURIComponent(String(request.recordId));
  const params = createOgcMetadataParams(request);
  if (request.profile !== undefined) params.set("profile", normalizeStringCsv(request.profile));
  return `/ogc/records/collections/${collection}/items/${record}?${params.toString()}`;
}

function serializeOgcRecordsSearchParams(request: OgcRecordsSearchRequest): URLSearchParams {
  const params = createOgcMetadataParams(request);
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  if (request.offset !== undefined) params.set("offset", String(request.offset));
  if (request.bbox !== undefined) params.set("bbox", normalizeRecordsBbox(request.bbox));
  if (request.datetime !== undefined) params.set("datetime", request.datetime);
  if (request.q !== undefined) params.set("q", normalizeStringCsv(request.q));
  if (request.ids !== undefined) params.set("ids", normalizeCsv(request.ids));
  if (request.type !== undefined) params.set("type", normalizeStringCsv(request.type));
  if (request.externalIds !== undefined) params.set("externalIds", normalizeStringCsv(request.externalIds));
  if (request.filter !== undefined) params.set("filter", request.filter);
  if (request.filterLang !== undefined) params.set("filter-lang", request.filterLang);
  if (request.filterCrs !== undefined) params.set("filter-crs", request.filterCrs);
  if (request.properties !== undefined) params.set("properties", normalizeStringCsv(request.properties));
  if (request.sortby !== undefined) params.set("sortby", request.sortby);
  if (request.profile !== undefined) params.set("profile", normalizeStringCsv(request.profile));
  return params;
}
