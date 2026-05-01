/**
 * STAC API search surface. STAC builds on OGC API Features, so this
 * class wraps the STAC catalog landing, collections listing, items, and
 * cross-collection search endpoints. The wire calls live on
 * `HonuaClient`; this class is the request-shaping layer on top.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import type {
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionsResponse,
  HonuaStacItemCollectionResponse,
  HonuaStacItemResponse,
  HonuaStacLandingResponse,
  OgcCollectionRequest,
  OgcMetadataRequest,
  StacSearchRequest,
} from "./types.js";

export interface HonuaStacSearchOptions {
  client: HonuaClient;
}

export interface HonuaStacSearchAllRequest extends StacSearchRequest {
  /** Maximum number of items to materialize across pages. */
  pageSize?: number;
  /** Hard cap on the number of pages to fetch (defaults to 100). */
  maxPages?: number;
}

const DEFAULT_STAC_PAGE_SIZE = 100;
const DEFAULT_STAC_MAX_PAGES = 100;

/**
 * STAC API entry point. Discovery (`landing`, `collections`,
 * `collection`) plus search (`search`, `searchAll`, `searchStream`) and
 * item fetch.
 */
export class HonuaStacSearch {
  public readonly client: HonuaClient;

  public constructor(options: HonuaStacSearchOptions) {
    this.client = options.client;
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaStacLandingResponse> {
    return this.client.getStacLanding(request);
  }

  public async collections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return this.client.listStacCollections(request);
  }

  public async collection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return this.client.getStacCollection(request);
  }

  public async item(request: {
    collectionId: string | number;
    itemId: string | number;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<HonuaStacItemResponse> {
    return this.client.getStacItem(request);
  }

  public async search(request: StacSearchRequest = {}): Promise<HonuaStacItemCollectionResponse> {
    return this.client.searchStac(request);
  }

  public async searchAll(request: HonuaStacSearchAllRequest = {}): Promise<HonuaStacItemResponse[]> {
    const pageSize = request.pageSize ?? request.limit ?? DEFAULT_STAC_PAGE_SIZE;
    const maxPages = request.maxPages ?? DEFAULT_STAC_MAX_PAGES;
    const items: HonuaStacItemResponse[] = [];
    let cursor: StacPageCursor = { offset: request.offset, next: request.next };
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.client.searchStac({
        ...request,
        limit: pageSize,
        offset: cursor.offset,
        next: cursor.next,
      });
      const pageItems = response.features ?? [];
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      cursor = nextStacCursor(response.links);
      if (cursor.offset === undefined && cursor.next === undefined) break;
      if (pageItems.length < pageSize) break;
    }
    return items;
  }

  public async *searchStream(
    request: HonuaStacSearchAllRequest = {},
  ): AsyncGenerator<HonuaStacItemResponse[], void, undefined> {
    const pageSize = request.pageSize ?? request.limit ?? DEFAULT_STAC_PAGE_SIZE;
    const maxPages = request.maxPages ?? DEFAULT_STAC_MAX_PAGES;
    let cursor: StacPageCursor = { offset: request.offset, next: request.next };
    for (let page = 0; page < maxPages; page += 1) {
      const response: HonuaStacItemCollectionResponse = await this.client.searchStac({
        ...request,
        limit: pageSize,
        offset: cursor.offset,
        next: cursor.next,
      });
      const pageItems = response.features ?? [];
      if (pageItems.length === 0) break;
      yield pageItems;
      cursor = nextStacCursor(response.links);
      if (cursor.offset === undefined && cursor.next === undefined) break;
      if (pageItems.length < pageSize) break;
    }
  }
}

interface StacPageCursor {
  offset?: number;
  next?: string;
}

/**
 * Resolve the next-page cursor for STAC paging. honua-server emits a
 * `rel=next` link with `?offset=N` on the href; some non-Honua STAC
 * servers emit `?next=…` opaque tokens instead. Prefer `offset` when the
 * link carries it, otherwise fall back to `next`. When the server omits
 * a usable `rel=next` link, return an empty cursor so the caller stops.
 */
function nextStacCursor(links: HonuaStacItemCollectionResponse["links"] | undefined): StacPageCursor {
  if (!links) return {};
  for (const link of links) {
    if (link.rel !== "next" || typeof link.href !== "string") continue;
    try {
      const url = new URL(link.href, "https://placeholder.test");
      const offsetParam = url.searchParams.get("offset");
      if (offsetParam !== null) {
        const offset = Number(offsetParam);
        if (Number.isFinite(offset)) return { offset };
      }
      const nextParam = url.searchParams.get("next");
      if (nextParam !== null) return { next: nextParam };
    } catch {
      // ignore unparsable hrefs; keep scanning for a usable link
    }
  }
  return {};
}

export function createHonuaStacSearch(client: HonuaClient): HonuaStacSearch {
  return new HonuaStacSearch({ client });
}
