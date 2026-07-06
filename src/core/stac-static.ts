/**
 * Static STAC catalog reader.
 *
 * A large share of public STAC catalogs are not API servers — they are
 * static `catalog.json` / `collection.json` / item trees served from object
 * storage, with no `/search` endpoint. This reader walks such a tree the
 * spec-driven way: it follows `rel="child"` links to descend catalogs /
 * collections and `rel="item"` links to reach STAC Items, resolving every
 * href against the document it was found in (STAC best-practice relative
 * links). Filtering (`collections` / `bbox` / `datetime` / `limit`) is
 * applied client-side and the result is projected onto the same
 * {@link HonuaStacItemCollectionResponse} envelope the STAC API search path
 * returns, so the canonical `Source` surface is identical across both
 * layouts.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import { HonuaCapabilityNotSupportedError } from "./errors.js";
import type { HonuaStacItemCollectionResponse, HonuaStacItemResponse } from "./types.js";

/** Bounded search parameters for a static catalog traversal. */
export interface StacStaticSearchParams {
  collections?: readonly string[];
  bbox?: readonly [number, number, number, number];
  datetime?: string;
  limit?: number;
  signal?: AbortSignal;
}

/** Guardrails so a malformed / cyclic catalog cannot fan out unbounded. */
const MAX_DOCUMENTS = 500;
const DEFAULT_ITEM_CAP = 1000;

interface StacDoc {
  type?: string;
  id?: string;
  collection?: string;
  bbox?: number[];
  properties?: { datetime?: string; start_datetime?: string; end_datetime?: string };
  links?: Array<{ rel?: string; href?: string; type?: string }>;
}

/**
 * Reader bound to the URL of a static STAC catalog / collection root. The
 * URL is the client baseUrl (the transport resolves same-origin absolute
 * child/item hrefs directly), so `rootUrl` is normally `""` (the baseUrl
 * itself) but may be an absolute `catalog.json` URL.
 */
export class HonuaStacStaticCatalog {
  public readonly client: HonuaClient;
  private readonly rootUrl: string;

  public constructor(client: HonuaClient, rootUrl = "") {
    this.client = client;
    this.rootUrl = rootUrl;
  }

  /**
   * Traverse the catalog tree, collect matching items, and return them in
   * the STAC search envelope shape.
   */
  public async search(params: StacStaticSearchParams = {}): Promise<HonuaStacItemCollectionResponse> {
    const items = await this.collectItems(params);
    const filtered = items.filter((item) => matchesFilters(item, params));
    const cap = typeof params.limit === "number" && params.limit >= 0 ? params.limit : filtered.length;
    const sliced = filtered.slice(0, cap);
    return {
      type: "FeatureCollection",
      features: sliced,
      numberReturned: sliced.length,
      numberMatched: filtered.length,
      links: [],
    };
  }

  private async fetchDoc(url: string, signal?: AbortSignal): Promise<StacDoc> {
    // An empty seed root means "the client baseUrl is the catalog document".
    const path = url === "" ? this.client.serverBaseUrl : url;
    return this.client.pipelineRequestJson<StacDoc>("GET", path, undefined, signal);
  }

  /**
   * Breadth-first walk collecting item documents. Descends `rel="child"`
   * links; a `collections` filter prunes Collection subtrees whose `id`
   * is not requested. Bounded by {@link MAX_DOCUMENTS} and the item cap.
   */
  private async collectItems(params: StacStaticSearchParams): Promise<HonuaStacItemResponse[]> {
    const itemCap =
      typeof params.limit === "number" && params.limit >= 0 ? Math.max(params.limit, 1) : DEFAULT_ITEM_CAP;
    const wantedCollections = params.collections ? new Set(params.collections) : undefined;
    const visited = new Set<string>();
    const queue: string[] = [this.rootUrl];
    const itemUrls: string[] = [];
    let docCount = 0;

    while (queue.length > 0 && docCount < MAX_DOCUMENTS) {
      const url = queue.shift();
      if (url === undefined || visited.has(url)) continue;
      visited.add(url);
      docCount += 1;
      let doc: StacDoc;
      try {
        doc = await this.fetchDoc(url, params.signal);
      } catch (err) {
        if (url === this.rootUrl) {
          throw new HonuaCapabilityNotSupportedError(
            "query",
            "stac",
            `static catalog root ${url || "(baseUrl)"} could not be read: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      // A Collection subtree not in the requested set is pruned entirely.
      if (
        wantedCollections &&
        doc.type === "Collection" &&
        typeof doc.id === "string" &&
        !wantedCollections.has(doc.id)
      ) {
        continue;
      }
      const base = absoluteBaseFor(url, this.client.serverBaseUrl);
      for (const link of doc.links ?? []) {
        if (typeof link.href !== "string") continue;
        const rel = (link.rel ?? "").toLowerCase();
        const resolved = resolveHref(link.href, base);
        if (rel === "child") {
          if (!visited.has(resolved)) queue.push(resolved);
        } else if (rel === "item" || rel === "items") {
          itemUrls.push(resolved);
        }
      }
    }

    const items: HonuaStacItemResponse[] = [];
    for (const itemUrl of itemUrls) {
      if (items.length >= itemCap) break;
      try {
        const item = (await this.fetchDoc(itemUrl, params.signal)) as unknown as HonuaStacItemResponse;
        if (item && (item as StacDoc).type === "Feature") items.push(item);
      } catch {
        // Skip an unreadable item; the traversal is best-effort per item.
      }
    }
    return items;
  }
}

/**
 * The base URL a document's relative links resolve against. When the reader
 * was seeded with a bare `""` root (the client baseUrl IS the catalog), use
 * the client's server base URL so `./child.json` resolves correctly.
 */
function absoluteBaseFor(docUrl: string, serverBaseUrl: string): string {
  if (docUrl === "") return serverBaseUrl;
  if (/^https?:\/\//i.test(docUrl)) return docUrl;
  const root = serverBaseUrl.endsWith("/") ? serverBaseUrl : `${serverBaseUrl}/`;
  try {
    return new URL(docUrl, root).toString();
  } catch {
    return serverBaseUrl;
  }
}

function resolveHref(href: string, base: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function matchesFilters(item: HonuaStacItemResponse, params: StacStaticSearchParams): boolean {
  const doc = item as unknown as StacDoc;
  if (params.collections && params.collections.length > 0) {
    if (typeof doc.collection !== "string" || !params.collections.includes(doc.collection)) return false;
  }
  if (params.bbox && Array.isArray(doc.bbox) && doc.bbox.length >= 4) {
    if (!bboxIntersects(params.bbox, doc.bbox)) return false;
  }
  if (params.datetime) {
    if (!datetimeMatches(params.datetime, doc)) return false;
  }
  return true;
}

function bboxIntersects(a: readonly number[], b: readonly number[]): boolean {
  // 2D envelope intersection; ignores any z components.
  const [axmin, aymin, axmax, aymax] = a;
  const bxmin = b[0];
  const bymin = b[1];
  // A 4- or 6-tuple bbox: max x/y are the second half.
  const bxmax = b.length >= 6 ? b[3] : b[2];
  const bymax = b.length >= 6 ? b[4] : b[3];
  return axmin <= bxmax && axmax >= bxmin && aymin <= bymax && aymax >= bymin;
}

function datetimeMatches(query: string, doc: StacDoc): boolean {
  const dt = doc.properties?.datetime;
  // Closed / open interval query per STAC (`start/end`, `../end`, `start/..`).
  if (query.includes("/")) {
    const [rawStart, rawEnd] = query.split("/");
    const start = rawStart && rawStart !== ".." ? Date.parse(rawStart) : Number.NEGATIVE_INFINITY;
    const end = rawEnd && rawEnd !== ".." ? Date.parse(rawEnd) : Number.POSITIVE_INFINITY;
    const startProp = doc.properties?.start_datetime ?? dt;
    const endProp = doc.properties?.end_datetime ?? dt;
    if (!startProp && !endProp) return false;
    const itemStart = startProp ? Date.parse(startProp) : Number.NEGATIVE_INFINITY;
    const itemEnd = endProp ? Date.parse(endProp) : Number.POSITIVE_INFINITY;
    return itemStart <= end && itemEnd >= start;
  }
  if (!dt) return false;
  return Date.parse(dt) === Date.parse(query);
}
