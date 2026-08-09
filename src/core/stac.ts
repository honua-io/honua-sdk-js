/**
 * STAC API search surface. STAC builds on OGC API Features, so this
 * class wraps the STAC catalog landing, collections listing, items, and
 * cross-collection search endpoints. The wire calls live on
 * `HonuaClient`; this class is the request-shaping layer on top.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
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
import { createOgcMetadataParams, mergeHeaders } from "./wire-shared.js";

export interface HonuaStacSearchOptions {
  client: HonuaClient;
  /**
   * Path prefix the STAC endpoints are mounted under. Defaults to `/stac`
   * (Honua facade). Pass `""` for a raw STAC API root (e.g. Earth Search
   * served at `.../v1`), so the search / collection paths resolve directly
   * under the client baseUrl.
   */
  basePath?: string;
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
  private readonly basePath: string | undefined;
  private postSearchProbe: Promise<boolean> | undefined;
  private postSearchSupported: boolean | undefined;
  /**
   * Verified state of the POST search path: `undefined` until the first POST
   * attempt, `true` once one succeeded, `false` once one failed (a wrong
   * advertisement, a proxy that refuses non-GET, a blocked CORS preflight, or
   * a read-only fetch seam).
   */
  private postSearchUsable: boolean | undefined;

  public constructor(options: HonuaStacSearchOptions) {
    this.client = options.client;
    this.basePath = options.basePath;
  }

  /** Inject the configured STAC base path unless the caller already set one. */
  private withBase<R extends { stacBasePath?: string }>(request: R): R {
    if (this.basePath === undefined || request.stacBasePath !== undefined) return request;
    return { ...request, stacBasePath: this.basePath };
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaStacLandingResponse> {
    return this.client.getStacLanding(this.withBase(request));
  }

  public async collections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return this.client.listStacCollections(this.withBase(request));
  }

  public async collection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return this.client.getStacCollection(this.withBase(request));
  }

  public async item(request: {
    collectionId: string | number;
    itemId: string | number;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
    stacBasePath?: string;
  }): Promise<HonuaStacItemResponse> {
    return this.client.getStacItem(this.withBase(request));
  }

  public async search(request: StacSearchRequest = {}): Promise<HonuaStacItemCollectionResponse> {
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
  private async dispatchSearch(request: StacSearchRequest): Promise<HonuaStacItemCollectionResponse> {
    const wire = this.withBase(request);
    if (wire.usePost !== true) return this.client.searchStac(wire);
    if (this.postSearchUsable === false) return this.client.searchStac({ ...wire, usePost: false });
    try {
      const response = await this.client.searchStac(wire);
      this.postSearchUsable = true;
      return response;
    } catch (error) {
      if (this.postSearchUsable !== undefined || request.signal?.aborted === true) throw error;
      this.postSearchUsable = false;
      return this.client.searchStac({ ...wire, usePost: false });
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
  public async supportsPostSearch(signal?: AbortSignal): Promise<boolean> {
    if (this.postSearchSupported !== undefined) return this.postSearchSupported;
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

  private async probePostSearch(signal?: AbortSignal): Promise<boolean> {
    try {
      const landing = await this.landing({ signal });
      for (const link of landing.links ?? []) {
        if (link.rel !== "search") continue;
        if (typeof link.method === "string" && link.method.toUpperCase() === "POST") return true;
      }
      return false;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Landing page unreachable / not a STAC document: stay on GET rather
      // than failing the search the caller actually asked for.
      return false;
    }
  }

  public async searchAll(request: HonuaStacSearchAllRequest = {}): Promise<HonuaStacItemResponse[]> {
    const pageSize = request.pageSize ?? request.limit ?? DEFAULT_STAC_PAGE_SIZE;
    const maxPages = request.maxPages ?? DEFAULT_STAC_MAX_PAGES;
    const items: HonuaStacItemResponse[] = [];
    let cursor: StacPageCursor = { offset: request.offset, next: request.next };
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.dispatchSearch({
        ...request,
        limit: pageSize,
        ...cursorRequest(cursor),
      });
      const pageItems = response.features ?? [];
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      const advanced = nextStacCursor(response.links);
      // Continuation is driven solely by the next-link cursor (and the
      // maxPages cap). STAC permits a server to return fewer than `limit`
      // items on a non-final page while still advertising a `rel=next` link,
      // so a short page must not stop paging.
      if (!hasStacCursor(advanced) || stacCursorKey(advanced) === stacCursorKey(cursor)) break;
      cursor = advanced;
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
      const response: HonuaStacItemCollectionResponse = await this.dispatchSearch({
        ...request,
        limit: pageSize,
        ...cursorRequest(cursor),
      });
      const pageItems = response.features ?? [];
      if (pageItems.length === 0) break;
      yield pageItems;
      // See searchAll: a short page is not a termination signal; rely on the
      // next-link cursor and the maxPages cap.
      const advanced = nextStacCursor(response.links);
      if (!hasStacCursor(advanced) || stacCursorKey(advanced) === stacCursorKey(cursor)) break;
      cursor = advanced;
    }
  }
}

interface StacPageCursor {
  offset?: number;
  next?: string;
  /** Opaque query params captured verbatim from a GET `rel=next` href. */
  params?: Record<string, string>;
  /** Opaque body members captured from a POST `rel=next` link. */
  body?: Record<string, unknown>;
}

/** Project a page cursor onto the paging members of a search request. */
function cursorRequest(cursor: StacPageCursor): Partial<StacSearchRequest> {
  return {
    offset: cursor.offset,
    next: cursor.next,
    nextParams: cursor.params,
    nextBody: cursor.body,
  };
}

function hasStacCursor(cursor: StacPageCursor): boolean {
  return (
    cursor.offset !== undefined || cursor.next !== undefined || cursor.params !== undefined || cursor.body !== undefined
  );
}

/**
 * Stable identity for a page cursor. A server that keeps advertising the
 * same `rel=next` link (or one whose href carries no cursor at all) would
 * otherwise re-request the same page until `maxPages`, duplicating items.
 */
function stacCursorKey(cursor: StacPageCursor): string {
  return JSON.stringify([cursor.offset ?? null, cursor.next ?? null, cursor.params ?? null, cursor.body ?? null]);
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
function nextStacCursor(links: HonuaStacItemCollectionResponse["links"] | undefined): StacPageCursor {
  if (!links) return {};
  for (const link of links) {
    if (link.rel !== "next") continue;
    const body = link.body;
    if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0) {
      return { body: { ...body } };
    }
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
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) params[key] = value;
      if (Object.keys(params).length > 0) return { params };
    } catch {
      // ignore unparsable hrefs; keep scanning for a usable link
    }
  }
  return {};
}

export function createHonuaStacSearch(client: HonuaClient): HonuaStacSearch {
  return new HonuaStacSearch({ client });
}

// ── STAC API wire methods ───────────────────────────────────────

/**
 * Path prefix the STAC endpoints are mounted under. Defaults to `/stac`
 * (the Honua Server facade). Backend-agnostic callers pointing at a raw
 * STAC API root pass `""` so the paths resolve directly under the client
 * baseUrl (e.g. Earth Search served at `.../v1`).
 */
function stacBase(request: { stacBasePath?: string }): string {
  const base = request.stacBasePath;
  if (base === undefined) return "/stac";
  // Trim trailing slashes; an explicit "" means "the client baseUrl is the
  // STAC API root".
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  return base.slice(0, end);
}

export async function getStacLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaStacLandingResponse> {
  const params = createOgcMetadataParams(request);
  const base = stacBase(request);
  return transport.requestCachedMetadataJson<HonuaStacLandingResponse>(
    `stac:landing:${base}:${params.toString()}`,
    `${base}?${params.toString()}`,
    request,
  );
}

export async function listStacCollections(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcCollectionsResponse> {
  const params = createOgcMetadataParams(request);
  const base = stacBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
    `stac:collections:${base}:${params.toString()}`,
    `${base}/collections?${params.toString()}`,
    request,
  );
}

export async function getStacCollection(
  transport: HonuaProtocolTransport,
  request: OgcCollectionRequest,
): Promise<HonuaOgcCollectionMetadata> {
  const params = createOgcMetadataParams(request);
  const base = stacBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
    `stac:collection:${base}:${request.collectionId}:${params.toString()}`,
    `${base}/collections/${encodeURIComponent(String(request.collectionId))}?${params.toString()}`,
    request,
  );
}

export async function getStacItem(
  transport: HonuaProtocolTransport,
  request: {
    collectionId: string | number;
    itemId: string | number;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
    stacBasePath?: string;
  },
): Promise<HonuaStacItemResponse> {
  const params = createOgcMetadataParams(request);
  const base = stacBase(request);
  const path =
    `${base}/collections/${encodeURIComponent(String(request.collectionId))}` +
    `/items/${encodeURIComponent(String(request.itemId))}`;
  return transport.requestJson<HonuaStacItemResponse>("GET", `${path}?${params.toString()}`, undefined, request.signal);
}

export async function searchStac(
  transport: HonuaProtocolTransport,
  request: StacSearchRequest = {},
): Promise<HonuaStacItemCollectionResponse> {
  const base = stacBase(request);
  if (request.usePost) {
    // A GET-shaped continuation (href query string) still applies when the
    // server answered a POST search with a GET `rel=next` link.
    const query =
      request.nextParams === undefined ? "" : `?${new URLSearchParams({ ...request.nextParams }).toString()}`;
    return transport.requestJson<HonuaStacItemCollectionResponse>(
      "POST",
      `${base}/search${query}`,
      {
        headers: mergeHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify(stacSearchBody(request)),
      },
      request.signal,
    );
  }
  const params = serializeStacSearchParams(request);
  return transport.requestJson<HonuaStacItemCollectionResponse>(
    "GET",
    `${base}/search?${params.toString()}`,
    undefined,
    request.signal,
  );
}

function serializeStacSearchParams(request: StacSearchRequest): URLSearchParams {
  const params = new URLSearchParams();
  if (request.bbox !== undefined) params.set("bbox", request.bbox.join(","));
  if (request.datetime !== undefined) params.set("datetime", request.datetime);
  if (request.ids !== undefined && request.ids.length > 0) params.set("ids", request.ids.join(","));
  if (request.collections !== undefined && request.collections.length > 0) {
    params.set("collections", request.collections.join(","));
  }
  // honua-server accepts `intersects` on GET as a JSON-encoded geometry
  // and `fields` as a CSV with `-` prefix marking excludes (matches
  // STAC Item Search GET conventions and the server's parser).
  if (request.intersects !== undefined) params.set("intersects", JSON.stringify(request.intersects));
  const fields = stacFieldsCsv(request.fields);
  if (fields !== undefined) params.set("fields", fields);
  if (request.filter !== undefined) {
    params.set("filter", typeof request.filter === "string" ? request.filter : JSON.stringify(request.filter));
  }
  if (request.filterLang !== undefined) params.set("filter-lang", request.filterLang);
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  // honua-server uses numeric `offset` paging on GET. `next` is kept as
  // optional support for STAC servers that advertise an opaque token.
  if (request.offset !== undefined) params.set("offset", String(request.offset));
  if (request.next !== undefined) params.set("next", request.next);
  if (request.sortby !== undefined) {
    params.set(
      "sortby",
      typeof request.sortby === "string"
        ? request.sortby
        : request.sortby.map((sort) => `${sort.direction === "desc" ? "-" : "+"}${sort.field}`).join(","),
    );
  }
  // An opaque continuation captured from a `rel=next` href wins over the
  // locally derived paging params: the server stated exactly how to ask for
  // the next page (token cursors carry state the client cannot reconstruct).
  if (request.nextParams !== undefined) {
    for (const [key, value] of Object.entries(request.nextParams)) params.set(key, value);
  }
  return params;
}

function stacSearchBody(request: StacSearchRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (request.bbox !== undefined) out.bbox = request.bbox;
  if (request.datetime !== undefined) out.datetime = request.datetime;
  if (request.intersects !== undefined) out.intersects = request.intersects;
  if (request.ids !== undefined) out.ids = request.ids;
  if (request.collections !== undefined) out.collections = request.collections;
  if (request.filter !== undefined) out.filter = request.filter;
  if (request.filterLang !== undefined) out["filter-lang"] = request.filterLang;
  if (request.limit !== undefined) out.limit = request.limit;
  if (request.offset !== undefined) out.offset = request.offset;
  if (request.next !== undefined) out.next = request.next;
  if (request.sortby !== undefined) out.sortby = request.sortby;
  if (request.fields !== undefined) out.fields = request.fields;
  // `merge: true` semantics for a POST `rel=next` link: the advertised body
  // members override the ones this request derived locally.
  if (request.nextBody !== undefined) Object.assign(out, request.nextBody);
  return out;
}

function stacFieldsCsv(fields: StacSearchRequest["fields"] | undefined): string | undefined {
  if (!fields) return undefined;
  const parts: string[] = [];
  if (fields.include) {
    for (const f of fields.include) {
      if (typeof f === "string" && f.length > 0) parts.push(f);
    }
  }
  if (fields.exclude) {
    for (const f of fields.exclude) {
      if (typeof f === "string" && f.length > 0) parts.push(`-${f}`);
    }
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}
