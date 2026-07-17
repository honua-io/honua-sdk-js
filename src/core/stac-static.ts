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

import type { SourceLocator } from "../contract/types.js";
import type { HonuaClient } from "./client.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "./errors.js";
import type { HonuaStacItemCollectionResponse, HonuaStacItemResponse } from "./types.js";

/** Bounded search parameters for a static catalog traversal. */
export interface StacStaticSearchParams {
  collections?: readonly string[];
  bbox?: readonly [number, number, number, number];
  datetime?: string;
  limit?: number;
  signal?: AbortSignal;
}

/** Guardrails match `connect()` static-STAC admission defaults and hard caps. */
const DEFAULT_MAX_DOCUMENTS = 32;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_LINKS_PER_DOCUMENT = 64;
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const HARD_MAX_DOCUMENTS = 64;
const HARD_MAX_DEPTH = 8;
const HARD_MAX_LINKS_PER_DOCUMENT = 128;
const HARD_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const JSON_MEDIA_TYPES = new Set(["application/json", "application/geo+json"]);

interface RuntimeTraversalPolicy {
  readonly maxDocuments: number;
  readonly maxDepth: number;
  readonly maxLinksPerDocument: number;
  readonly maxDocumentBytes: number;
}

interface StacDoc {
  type?: string;
  id?: string;
  stac_version?: string;
  stac_extensions?: unknown;
  collection?: string;
  bbox?: number[];
  geometry?: unknown;
  properties?: Record<string, unknown>;
  links?: unknown[];
  assets?: unknown;
}

interface QueuedDoc {
  readonly url: string;
  readonly depth: number;
}

interface FetchedDoc {
  readonly value: StacDoc;
  readonly url: string;
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
  private readonly policy: RuntimeTraversalPolicy;

  public constructor(client: HonuaClient, rootUrl = "", policy?: SourceLocator["stacStatic"]) {
    this.client = client;
    this.rootUrl = canonicalRuntimeUrl(rootUrl || client.serverBaseUrl, client.serverBaseUrl);
    this.policy = normalizeRuntimePolicy(policy);
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

  private async fetchDoc(url: string, signal?: AbortSignal): Promise<FetchedDoc> {
    const response = await this.client.pipelineFetch(
      "GET",
      url,
      { headers: { Accept: "application/json, application/geo+json;q=0.9" } },
      signal,
      { redirect: "error" },
    );
    const contentType = mediaEssence(response.headers.get("content-type") ?? "");
    if (contentType && !JSON_MEDIA_TYPES.has(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("static STAC document did not return JSON");
    }
    const finalUrl = canonicalRuntimeUrl(response.url || url, url);
    if (new URL(finalUrl).origin !== new URL(this.rootUrl).origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("static STAC redirect left the admitted origin");
    }
    const value = await readBoundedJson(response, this.policy.maxDocumentBytes);
    if (!isPlainObject(value)) throw new Error("static STAC document must be a JSON object");
    if (value.links !== undefined && !Array.isArray(value.links)) {
      throw new Error("static STAC links must be an array");
    }
    return { value: value as StacDoc, url: finalUrl };
  }

  /**
   * Breadth-first walk collecting item documents. Descends `rel="child"`
   * links; a `collections` filter prunes Collection subtrees whose `id`
   * is not requested. Every attempted document, traversal depth, per-document
   * link list, response body, redirect, and origin is bounded by the locator's
   * admitted policy.
   */
  private async collectItems(params: StacStaticSearchParams): Promise<HonuaStacItemResponse[]> {
    const wantedCollections = params.collections ? new Set(params.collections) : undefined;
    const visitedRequests = new Set<string>();
    const completedUrls = new Set<string>();
    const queue: QueuedDoc[] = [{ url: this.rootUrl, depth: 0 }];
    const items: HonuaStacItemResponse[] = [];
    let attempts = 0;

    while (queue.length > 0 && attempts < this.policy.maxDocuments) {
      throwIfRuntimeAborted(params.signal);
      const next = queue.shift();
      if (!next || visitedRequests.has(next.url)) continue;
      visitedRequests.add(next.url);
      attempts += 1;
      let fetched: FetchedDoc;
      try {
        fetched = await this.fetchDoc(next.url, params.signal);
      } catch (err) {
        if (params.signal?.aborted || err instanceof HonuaAbortError) throw new HonuaAbortError();
        if (next.depth === 0) {
          throw new HonuaCapabilityNotSupportedError(
            "query",
            "stac",
            `static catalog root ${this.rootUrl} could not be read: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      if (completedUrls.has(fetched.url)) continue;
      completedUrls.add(fetched.url);
      visitedRequests.add(fetched.url);
      const doc = fetched.value;
      if (doc.type === "Feature") {
        if (isMinimallyValidStacItem(doc)) {
          items.push(doc);
        } else if (next.depth === 0) {
          throw new HonuaCapabilityNotSupportedError(
            "query",
            "stac",
            "static catalog root Feature is not a minimally valid STAC Item",
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
      if (next.depth >= this.policy.maxDepth) continue;
      for (const link of (doc.links ?? []).slice(0, this.policy.maxLinksPerDocument)) {
        if (!isPlainObject(link)) continue;
        if (typeof link.href !== "string") continue;
        const rel = typeof link.rel === "string" ? link.rel.toLowerCase() : "";
        if (rel !== "child" && rel !== "item") continue;
        if (typeof link.type === "string" && !JSON_MEDIA_TYPES.has(mediaEssence(link.type))) continue;
        const resolved = safeTraversalUrl(link.href, fetched.url, this.rootUrl);
        if (resolved && !visitedRequests.has(resolved)) queue.push({ url: resolved, depth: next.depth + 1 });
      }
    }
    return items;
  }
}

function safeTraversalUrl(href: string, base: string, root: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== new URL(root).origin
  ) {
    return undefined;
  }
  return url.toString();
}

function canonicalRuntimeUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "stac",
      "static STAC URLs must be credential-free HTTP(S) URLs without query parameters or fragments",
    );
  }
  return url.toString();
}

function normalizeRuntimePolicy(value: SourceLocator["stacStatic"]): RuntimeTraversalPolicy {
  if (value === undefined) {
    return Object.freeze({
      maxDocuments: DEFAULT_MAX_DOCUMENTS,
      maxDepth: DEFAULT_MAX_DEPTH,
      maxLinksPerDocument: DEFAULT_MAX_LINKS_PER_DOCUMENT,
      maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
    });
  }
  const maxDocuments = runtimeBound(value.maxDocuments, 1, HARD_MAX_DOCUMENTS, "maxDocuments");
  const maxDepth = runtimeBound(value.maxDepth, 1, HARD_MAX_DEPTH, "maxDepth");
  const maxLinksPerDocument = runtimeBound(
    value.maxLinksPerDocument,
    1,
    HARD_MAX_LINKS_PER_DOCUMENT,
    "maxLinksPerDocument",
  );
  const maxDocumentBytes = runtimeBound(value.maxDocumentBytes, 1, HARD_MAX_DOCUMENT_BYTES, "maxDocumentBytes");
  // Validate the complete admitted locator even though asset inspection and
  // HEAD-probe budgets are used only by connect-time discovery.
  runtimeBound(value.maxAssets, 1, 1024, "maxAssets");
  runtimeBound(value.maxAssetProbes, 0, 16, "maxAssetProbes");
  return Object.freeze({ maxDocuments, maxDepth, maxLinksPerDocument, maxDocumentBytes });
}

function runtimeBound(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "stac",
      `static STAC ${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && Number(advertised) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`static STAC response exceeds the ${maximum}-byte limit`);
  }
  if (!response.body) throw new Error("static STAC response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`static STAC response exceeds the ${maximum}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("static STAC response contained invalid JSON");
  }
}

function mediaEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfRuntimeAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}

function isMinimallyValidStacItem(value: StacDoc): value is StacDoc & HonuaStacItemResponse {
  if (
    value.type !== "Feature" ||
    typeof value.stac_version !== "string" ||
    !value.stac_version.trim() ||
    value.stac_version.length > 64 ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.length > 512 ||
    !isPlainObject(value.properties) ||
    !Array.isArray(value.links) ||
    !isPlainObject(value.assets)
  ) {
    return false;
  }
  if (
    value.stac_extensions !== undefined &&
    (!Array.isArray(value.stac_extensions) || value.stac_extensions.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }
  if (value.collection !== undefined && (typeof value.collection !== "string" || !value.collection.trim())) {
    return false;
  }
  if (!Object.hasOwn(value, "geometry") || !isRuntimeGeometry(value.geometry)) return false;
  if (value.bbox !== undefined && !isRuntimeBbox(value.bbox)) return false;
  if (
    value.links.some(
      (link) =>
        !isPlainObject(link) ||
        typeof link.rel !== "string" ||
        !link.rel.trim() ||
        typeof link.href !== "string" ||
        !link.href.trim(),
    )
  ) {
    return false;
  }
  if (
    Object.values(value.assets).some(
      (asset) => !isPlainObject(asset) || typeof asset.href !== "string" || !asset.href.trim(),
    )
  ) {
    return false;
  }
  const datetime = value.properties.datetime;
  if (datetime === null) {
    return validRuntimeDatetime(value.properties.start_datetime) && validRuntimeDatetime(value.properties.end_datetime);
  }
  return validRuntimeDatetime(datetime);
}

function isRuntimeGeometry(value: unknown): value is HonuaStacItemResponse["geometry"] {
  if (value === null) return true;
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  if (value.type === "GeometryCollection") return Array.isArray(value.geometries);
  return (
    (value.type === "Point" ||
      value.type === "MultiPoint" ||
      value.type === "LineString" ||
      value.type === "MultiLineString" ||
      value.type === "Polygon" ||
      value.type === "MultiPolygon") &&
    Array.isArray(value.coordinates)
  );
}

function isRuntimeBbox(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    (value.length === 4 || value.length === 6) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    value[0]! <= value[value.length / 2]! &&
    value[1]! <= value[value.length / 2 + 1]! &&
    (value.length === 4 || value[2]! <= value[5]!)
  );
}

function validRuntimeDatetime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && !Number.isNaN(Date.parse(value));
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
  const dt = typeof doc.properties?.datetime === "string" ? doc.properties.datetime : undefined;
  // Closed / open interval query per STAC (`start/end`, `../end`, `start/..`).
  if (query.includes("/")) {
    const [rawStart, rawEnd] = query.split("/");
    const start = rawStart && rawStart !== ".." ? Date.parse(rawStart) : Number.NEGATIVE_INFINITY;
    const end = rawEnd && rawEnd !== ".." ? Date.parse(rawEnd) : Number.POSITIVE_INFINITY;
    const startProp = typeof doc.properties?.start_datetime === "string" ? doc.properties.start_datetime : dt;
    const endProp = typeof doc.properties?.end_datetime === "string" ? doc.properties.end_datetime : dt;
    if (!startProp && !endProp) return false;
    const itemStart = startProp ? Date.parse(startProp) : Number.NEGATIVE_INFINITY;
    const itemEnd = endProp ? Date.parse(endProp) : Number.POSITIVE_INFINITY;
    return itemStart <= end && itemEnd >= start;
  }
  if (!dt) return false;
  return Date.parse(dt) === Date.parse(query);
}
