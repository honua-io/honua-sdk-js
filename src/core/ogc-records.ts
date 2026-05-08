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
      if (cursor.offset === undefined) break;
      if (pageRecords.length < pageSize) break;
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
      if (cursor.offset === undefined) break;
      if (pageRecords.length < pageSize) break;
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

function nextRecordsCursor(links: HonuaOgcRecordsResponse["links"] | undefined): RecordsPageCursor {
  if (!links) return {};
  for (const link of links) {
    if (link.rel !== "next" || typeof link.href !== "string") continue;
    try {
      const url = new URL(link.href, "https://placeholder.test");
      const offsetParam = url.searchParams.get("offset");
      if (offsetParam === null) continue;
      const offset = Number(offsetParam);
      if (Number.isFinite(offset)) return { offset };
    } catch {
      // Ignore unparsable hrefs; keep scanning for a usable next link.
    }
  }
  return {};
}

export function createHonuaOgcRecords(client: HonuaClient): HonuaOgcRecords {
  return new HonuaOgcRecords({ client });
}
